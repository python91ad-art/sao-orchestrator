import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, mysqlPool } from '../db';
import * as schema from '../../drizzle/schema';
import { policyOverview, Principal, requirePolicyPermission } from './policyEngine';
import { getModelRegistry } from './llmModels';

export const systemSettingSchemas = {
  general: z.object({ systemName: z.string().trim().min(1).max(100), timezone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Valid IANA timezone required'), region: z.string().min(1).max(100) }).strict(),
  emergencyStop: z.boolean(),
  retention: z.object({ discoveryDays: z.number().int().positive().nullable(), auditDays: z.number().int().positive().nullable(), financialDays: z.number().int().positive().nullable(), automatedDeletion: z.literal(false) }).strict(),
  notificationRouting: z.object({ agentFailures: z.boolean(), budgetAlerts: z.boolean(), qcAlerts: z.boolean(), deadlineWarnings: z.boolean(), settlementExceptions: z.boolean(), systemAlerts: z.boolean() }).strict(),
  reasoningAssignments: z.array(z.object({ role: z.string().min(1), model: z.string().min(1), level: z.enum(['standard', 'high', 'extended']) }).strict()).max(100),
} as const;
export async function saveSystemSetting(actor: Principal, key: keyof typeof systemSettingSchemas, value: unknown, expectedRevision: number) {
  await requirePolicyPermission(actor, 'settings.manage');
  const parsed = systemSettingSchemas[key].parse(value);
  if (key === 'reasoningAssignments') {
    const roles = new Set((await db.select({ role: schema.agents.role }).from(schema.agents)).map(agent => agent.role));
    const selected = new Set<string>();
    for (const assignment of parsed as { role: string; model: string; level: string }[]) {
      if (!roles.has(assignment.role) || selected.has(assignment.role)) throw new Error('Assignments must use distinct registered agent roles.');
      selected.add(assignment.role);
      const configured = getModelRegistry().find(model => model.model === assignment.model && model.enabled);
      if (!configured) throw new Error('Model assignment must reference an enabled configured model.');
      if (assignment.level !== 'standard' && (configured.provider !== 'groq' || !/^openai\/gpt-oss-(20b|120b)$/.test(configured.model))) throw new Error('This configured adapter does not support the requested reasoning control.');
      if (assignment.level === 'extended' && configured.model !== 'openai/gpt-oss-120b') throw new Error('Extended reasoning requires the configured highest supported reasoning model.');
    }
  }
  await db.transaction(async tx => {
    const saved = (await tx.select().from(schema.operationalSettings).where(eq(schema.operationalSettings.key, key)).for('update'))[0];
    if ((saved?.revision || 0) !== expectedRevision) throw new Error('Setting changed concurrently. Reload saved values.');
    const nextRevision = (saved?.revision || 0) + 1;
    await tx.insert(schema.operationalSettings).values({ key, valueJson: JSON.stringify(parsed), revision: nextRevision, updatedBy: actor.id }).onDuplicateKeyUpdate({ set: { valueJson: JSON.stringify(parsed), revision: nextRevision, updatedBy: actor.id, updatedAt: new Date() } });
    await tx.insert(schema.operationalEvents).values({ id: crypto.randomUUID(), actorId: actor.id, type: 'system_setting_changed', resourceId: key, detailJson: JSON.stringify({ previousValue: saved ? JSON.parse(saved.valueJson) : null, value: parsed, revision: nextRevision }) });
  });
  if (key === 'emergencyStop' && parsed === true) {
    const { stopCoreLoop } = await import('../orchestrator');
    await stopCoreLoop();
    const { runOperatingCycle } = await import('./operatingCycle');
    await runOperatingCycle();
  }
}
export async function systemDiagnostics(actor: Principal) {
  await requirePolicyPermission(actor, 'policies.view');
  const [ping] = await mysqlPool.query('SELECT 1 AS healthy, DATABASE() AS databaseName');
  const [queue] = await db.execute(sql`SELECT queue_type,status,COUNT(*) AS count FROM queue_items WHERE queue_type<>'synthesis' OR NOT EXISTS (SELECT 1 FROM discovery_archives a WHERE a.gap_id=queue_items.gap_id) GROUP BY queue_type,status`);
  const [tasks] = await db.execute(sql`SELECT state,COUNT(*) AS count FROM agent_tasks GROUP BY state`);
  const { getWorkerStatus, getCoreLoopRuntimeStatus } = await import('../orchestrator');
  const settings = await db.select().from(schema.operationalSettings).where(sql`${schema.operationalSettings.key} IN ('general','emergencyStop','retention','notificationRouting','reasoningAssignments')`);
  const providers = await db.select({ id: schema.integrationCredentials.id, name: schema.integrationCredentials.name, service: schema.integrationCredentials.service, enabled: schema.integrationCredentials.enabled, status: schema.integrationCredentials.connectionStatus }).from(schema.integrationCredentials);
  const [readiness] = await db.execute(sql`SELECT (SELECT COUNT(*) FROM action_approvals WHERE status='pending' AND expires_at>NOW()) AS pendingApprovals, (SELECT COUNT(*) FROM policy_evaluations WHERE decision<>'ALLOW') AS blockedEvaluations, (SELECT COUNT(*) FROM qc_jobs WHERE status='failed') AS failedQc, (SELECT COUNT(*) FROM accounting_periods WHERE status='disputed') AS disputedPeriods, (SELECT COUNT(*) FROM business_lifecycle_records WHERE state='suspended') AS suspendedBusinesses`);
  const retention = settings.find(setting => setting.key === 'retention');
  const requirements = retention ? JSON.parse(retention.valueJson) : null;
  const retentionReview: { domain: string; olderThanDays: number; count: number; action: string }[] = [];
  for (const [domain, days, table, createdAt] of [['discovery', requirements?.discoveryDays, schema.gaps, schema.gaps.createdAt], ['audit', requirements?.auditDays, schema.auditLogs, schema.auditLogs.timestamp], ['financial', requirements?.financialDays, schema.payments, schema.payments.createdAt]] as const) {
    if (Number.isInteger(days) && days > 0) { const records = await db.select({ count: sql<number>`COUNT(*)` }).from(table).where(sql`${createdAt}<${new Date(Date.now() - days * 86400000)}`); retentionReview.push({ domain, olderThanDays: days, count: Number(records[0].count), action: 'Review legal retention and protected obligations; no automatic deletion.' }); }
  }
  const reports = await db.select().from(schema.discoveryResetReports).orderBy(sql`${schema.discoveryResetReports.createdAt} DESC`).limit(10);
  const { stat } = await import('node:fs/promises');
  const backups = await Promise.all(reports.map(async report => { const backup = JSON.parse(report.reportJson).backup; return { reportId: report.id, createdAt: report.createdAt, verifiedAtCreation: backup?.readable === true, availableOnServer: backup ? await stat(backup.backupPath).then(() => true, () => false) : false, location: backup?.backupPath || null, recoveryFormat: backup?.format || null }; }));
  const policyReadiness = (await policyOverview(actor)).map(policy => ({ category: policy.category, status: policy.status, versionId: policy.active?.id || null, validation: policy.validation }));
  return { backend: 'responding', database: ping, queue, tasks, providers, readiness, policyReadiness, retentionReview, backups, workers: getWorkerStatus(), coreLoop: await getCoreLoopRuntimeStatus(), settings: settings.map(setting => ({ ...setting, value: JSON.parse(setting.valueJson) })), environment: process.env.NODE_ENV || 'development', version: '2.0.0', build: process.env.BUILD_SHA || null, credentialSecurity: 'Credential values are excluded from diagnostics.' };
}
