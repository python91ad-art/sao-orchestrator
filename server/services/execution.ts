import crypto from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, generateId } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy, enforcePolicy, PolicyEnforcementError, Principal, requirePolicyPermission } from './policyEngine';
import { createAgentTask, ensureDefaultAgents, recordAgentEvent } from './infrastructure';
import { minorUnits, money } from './profitAccounting';
import { withAgentRouting } from './agentRouting';

export async function auditOperation(actorId: string, type: string, resourceId: string, detail: unknown, deploymentId?: string) {
  const id = generateId();
  await db.insert(schema.operationalEvents).values({ id, actorId, type, resourceId, detailJson: JSON.stringify(detail), deploymentId: deploymentId || null });
  if (['deadline_warning', 'agent_failure', 'supervisor_escalation', 'repair_required', 'settlement_exception', 'budget_warning'].includes(type)) {
    const { deliverOperationalNotification } = await import('./operationalNotifications');
    await deliverOperationalNotification(type, resourceId, detail, deploymentId);
  }
  return id;
}
export async function emergencyStopped() {
  const value = (await db.select().from(schema.operationalSettings).where(eq(schema.operationalSettings.key, 'emergencyStop')).limit(1))[0];
  return value ? JSON.parse(value.valueJson) === true : false;
}
export async function recoverExpiredAssignments() {
  const settings = (await db.select().from(schema.coreLoopState).where(eq(schema.coreLoopState.id, 'singleton')).limit(1))[0];
  if (!settings || !Number.isInteger(settings.queueExpirationHours) || settings.queueExpirationHours < 1) return 0;
  const cutoff = new Date(Date.now() - settings.queueExpirationHours * 3600000);
  const tasks = await db.select({ id: schema.agentTasks.id, agentId: schema.agentTasks.agentId, deploymentId: schema.agentTasks.deploymentId }).from(schema.agentTasks).where(and(eq(schema.agentTasks.state, 'running'), lt(schema.agentTasks.updatedAt, cutoff))).limit(100);
  for (const task of tasks) {
    await db.transaction(async tx => {
      await tx.update(schema.agentTasks).set({ state: 'blocked_by_policy', errorMessage: 'Assignment exceeded the configured work expiration window; Supervisor review and workflow replay are required.', updatedAt: new Date() }).where(and(eq(schema.agentTasks.id, task.id), eq(schema.agentTasks.state, 'running'), lt(schema.agentTasks.updatedAt, cutoff)));
      await tx.update(schema.taskExecutions).set({ status: 'failed', errorMessage: 'Expired interrupted assignment; output invalidated.', finishedAt: new Date() }).where(and(eq(schema.taskExecutions.taskId, task.id), eq(schema.taskExecutions.status, 'running')));
    });
    await auditOperation('system:recovery', 'supervisor_escalation', task.id, { reason: 'Expired interrupted assignment', replayRequiresScopeAndIdempotency: true }, task.deploymentId || undefined);
  }
  return tasks.length;
}
export async function requireBusinessOwner(actor: Principal, deploymentId: string) {
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  if (!business || business.userId !== actor.id) throw new Error('Only the authenticated business owner may authorize this action.');
  return business;
}
export async function requestApproval(actor: Principal, input: { deploymentId: string; action: string; resourceId: string; authority: 'user' | 'supervisor'; risk: 'low' | 'high'; expiresAt: Date; amount?: string; currency?: string; scope: Record<string, unknown> }) {
  if (actor.role === 'admin') await requirePolicyPermission(actor, 'approvals.request');
  else await requireBusinessOwner(actor, input.deploymentId);
  if (input.expiresAt.getTime() <= Date.now()) throw new Error('Approval expiry must be in the future.');
  if (input.amount && minorUnits(input.amount) <= 0n) throw new Error('Approval amount must be positive.');
  if (input.amount && !input.currency) throw new Error('Financial approvals require an explicit currency.');
  if (input.action === 'profit_share' && (!input.currency || input.scope.platformPercent !== 20 || input.scope.frequency !== 'weekly' || input.scope.reusable !== true)) throw new Error('Profit-sharing requests must explicitly specify currency and the agreed reusable weekly 20% net-profit arrangement.');
  const id = generateId();
  let requestedBy = actor.id;
  if (input.authority === 'supervisor' && input.action === 'deadline') {
    const source = (await db.select({ agentId: schema.taskExecutions.agentId }).from(schema.taskExecutions).innerJoin(schema.agentTasks, eq(schema.agentTasks.id, schema.taskExecutions.taskId)).where(and(eq(schema.taskExecutions.deploymentId, input.deploymentId), eq(schema.taskExecutions.tool, 'deadline_review'), eq(schema.taskExecutions.status, 'completed'), eq(schema.agentTasks.title, `deadline:${input.resourceId}:finance`))).limit(1))[0];
    if (source) requestedBy = source.agentId;
  }
  if (input.authority === 'supervisor' && input.action === 'closure') {
    const executionId = input.scope.operationsExecutionId;
    const source = typeof executionId === 'string' ? (await db.select().from(schema.taskExecutions).where(and(eq(schema.taskExecutions.id, executionId), eq(schema.taskExecutions.deploymentId, input.deploymentId), eq(schema.taskExecutions.tool, 'lifecycle'), eq(schema.taskExecutions.status, 'completed'))).limit(1))[0] : null;
    if (source) requestedBy = source.agentId;
  }
  if (input.authority === 'supervisor' && input.action === 'price_change') {
    const proposal = (await db.select().from(schema.priceProposals).where(and(eq(schema.priceProposals.id, input.resourceId), eq(schema.priceProposals.deploymentId, input.deploymentId))).limit(1))[0];
    const executionId = proposal ? JSON.parse(proposal.recommendationJson).pricingExecutionId : null;
    const source = executionId ? (await db.select().from(schema.taskExecutions).where(and(eq(schema.taskExecutions.id, executionId), eq(schema.taskExecutions.status, 'completed'))).limit(1))[0] : null;
    if (source) requestedBy = source.agentId;
  }
  if (input.authority === 'supervisor' && input.action === 'extension') {
    const offer = (await db.select().from(schema.extensionOffers).where(and(eq(schema.extensionOffers.id, input.resourceId), eq(schema.extensionOffers.deploymentId, input.deploymentId))).limit(1))[0];
    const executionId = offer ? JSON.parse(offer.assessmentJson).evaluations?.[0]?.executionId : null;
    const source = executionId ? (await db.select().from(schema.taskExecutions).where(and(eq(schema.taskExecutions.id, executionId), eq(schema.taskExecutions.status, 'completed'))).limit(1))[0] : null;
    if (source) requestedBy = source.agentId;
  }
  await db.insert(schema.approvals).values({ id, ...input, amount: input.amount || null, currency: input.currency || null, scopeJson: JSON.stringify(input.scope), requestedBy });
  await auditOperation(actor.id, 'approval_requested', id, { action: input.action, authority: input.authority, resourceId: input.resourceId }, input.deploymentId);
  return id;
}
export async function decideApproval(actor: Principal, id: string, decision: 'approved' | 'rejected' | 'revoked') {
  const request = (await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).limit(1))[0];
  if (!request) throw new Error('Approval request not found.');
  if (request.authority === 'user') await requireBusinessOwner(actor, request.deploymentId);
  else {
    await requirePolicyPermission(actor, 'approvals.supervisor');
    if (request.requestedBy === actor.id) throw new Error('The requesting actor cannot approve its own restricted action.');
  }
  await db.transaction(async tx => {
    const current = (await tx.select().from(schema.approvals).where(eq(schema.approvals.id, id)).for('update'))[0];
    if (current.expiresAt.getTime() <= Date.now()) throw new Error('Approval has expired.');
    if (decision === 'revoked' ? current.status !== 'approved' : current.status !== 'pending') throw new Error('Invalid approval state transition.');
    await tx.update(schema.approvals).set({ status: decision, decidedBy: actor.id, decidedAt: new Date(), revokedAt: decision === 'revoked' ? new Date() : null }).where(eq(schema.approvals.id, id));
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: actor.id, type: `approval_${decision}`, resourceId: id, deploymentId: current.deploymentId, detailJson: JSON.stringify({ previousStatus: current.status }) });
  });
}
export async function validApproval(input: { deploymentId: string; action: string; resourceId: string; authority: 'user' | 'supervisor'; id?: string; amount?: string; currency?: string }) {
  const rows = await db.select().from(schema.approvals).where(and(eq(schema.approvals.deploymentId, input.deploymentId), eq(schema.approvals.action, input.action), eq(schema.approvals.resourceId, input.resourceId), eq(schema.approvals.authority, input.authority), eq(schema.approvals.status, 'approved'), input.id ? eq(schema.approvals.id, input.id) : undefined));
  for (const approval of rows) {
    if (approval.revokedAt || approval.expiresAt.getTime() <= Date.now() || !approval.decidedBy) continue;
    if (approval.authority === 'user') {
      const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, input.deploymentId)).limit(1))[0];
      if (business?.userId !== approval.decidedBy) continue;
    }
    if (input.currency && approval.currency !== input.currency) continue;
    if (input.amount && (!approval.amount || minorUnits(input.amount) > minorUnits(approval.amount))) continue;
    return approval;
  }
  return null;
}
export async function consumeApproval(id: string, executionRef: string, amount?: string) {
  return db.transaction(async tx => {
    const approval = (await tx.select().from(schema.approvals).where(eq(schema.approvals.id, id)).for('update'))[0];
    if (!approval || approval.status !== 'approved' || approval.revokedAt || approval.expiresAt.getTime() <= Date.now()) throw new Error('Authorization is unavailable, expired or revoked.');
    const scope = JSON.parse(approval.scopeJson);
    const executions: string[] = scope.executions || [];
    if (executions.includes(executionRef)) return approval;
    if (amount) {
      const spent = minorUnits(scope.spent || '0.00') + minorUnits(amount);
      if (minorUnits(amount) < 0n || !approval.amount || spent > minorUnits(approval.amount)) throw new Error('Authorization spending limit exceeded.');
      scope.spent = money(spent);
    } else if (scope.reusable !== true && executions.length) throw new Error('Authorization already consumed.');
    scope.executions = [...executions, executionRef];
    await tx.update(schema.approvals).set({ scopeJson: JSON.stringify(scope), executionRef, status: scope.reusable === true || amount ? 'approved' : 'consumed' }).where(eq(schema.approvals.id, id));
    return approval;
  });
}

const roleTools: Record<string, string[]> = {
  supervisor: ['coordinate', 'review_conflict'], system_architect: ['specification', 'compliance'],
  developer: ['build', 'repair'], independent_qc: ['qc'], business_model_pricing: ['pricing'],
  marketing: ['marketing', 'pricing_review'], finance: ['finance', 'pricing_review', 'deadline_review'],
  ceo_strategy: ['strategy', 'deadline_review'], analytics: ['analytics', 'deadline_review'],
  market_research: ['research'], operations: ['lifecycle'],
  cto: ['architecture'], designer: ['design'], advertising: ['marketing'], sales: ['sales'], customer_support: ['support'],
};
for (const role of Object.keys(roleTools)) roleTools[role].push('discuss_conflict');
export function agentRoleTools(role: string) { return [...(roleTools[role] || [])]; }
export async function configureBackupAgent(actor: Principal, primaryId: string) {
  await requirePolicyPermission(actor, 'agents.manage');
  const primary = (await db.select().from(schema.agents).where(eq(schema.agents.id, primaryId)).limit(1))[0];
  if (!primary || primary.isBackup || !roleTools[primary.role]) throw new Error('A supported primary execution role is required.');
  const id = generateId();
  await db.insert(schema.agents).values({ id, role: primary.role, name: `${primary.name} Backup`, capabilityJson: JSON.stringify(roleTools[primary.role]), toolMetadataJson: JSON.stringify({ unrestrictedToolExecution: false }), availability: 'available', implementationStatus: 'configured', healthStatus: 'unknown', isBackup: true, backupForAgentId: primary.id });
  await auditOperation(actor.id, 'backup_agent_configured', id, { primaryId, role: primary.role });
  return id;
}
export type ExecutionContext = Readonly<{ agentId: string; role: string; deploymentId: string; tools: readonly string[] }>;
const verifiedContexts = new WeakSet<object>();
const contextSessions = new WeakMap<object, string>();
function context(agentId: string, role: string, deploymentId: string, tools: string[]): ExecutionContext {
  const value = Object.freeze({ agentId, role, deploymentId, tools: Object.freeze([...tools]) });
  verifiedContexts.add(value);
  return value;
}
export async function issueAgentSession(actor: Principal, input: { agentId: string; deploymentId: string; tools: string[]; expiresAt: Date }) {
  await requirePolicyPermission(actor, 'agents.manage');
  const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, input.agentId)).limit(1))[0];
  if (!agent || input.expiresAt.getTime() <= Date.now() || !input.tools.every(tool => roleTools[agent.role]?.includes(tool))) throw new Error('Invalid scoped agent identity request.');
  const token = crypto.randomBytes(32).toString('hex');
  const id = generateId();
  await db.insert(schema.agentSessions).values({ id, ...input, toolsJson: JSON.stringify(input.tools), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdBy: actor.id });
  await auditOperation(actor.id, 'agent_identity_issued', id, { agentId: agent.id, tools: input.tools }, input.deploymentId);
  return { id, token };
}
export async function authenticateAgent(token: string): Promise<ExecutionContext> {
  const session = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.tokenHash, crypto.createHash('sha256').update(token).digest('hex'))).limit(1))[0];
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) throw new Error('Invalid or expired agent identity.');
  const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, session.agentId)).limit(1))[0];
  if (!agent || ['disabled', 'offline'].includes(agent.availability)) throw new Error('Agent is unavailable.');
  const identity = context(agent.id, agent.role, session.deploymentId, JSON.parse(session.toolsJson));
  contextSessions.set(identity, session.id);
  return identity;
}
export async function requireAgentContext(identity: ExecutionContext, deploymentId: string, tool: string) {
  if (!verifiedContexts.has(identity) || identity.deploymentId !== deploymentId || !identity.tools.includes(tool) || !roleTools[identity.role]?.includes(tool)) throw new Error('Verified scoped agent identity required.');
  const sessionId = contextSessions.get(identity);
  if (sessionId) {
    const session = (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).limit(1))[0];
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) throw new Error('Agent identity has expired or been revoked.');
  }
  if (await emergencyStopped()) throw new Error('Emergency stop is active.');
  const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, identity.agentId)).limit(1))[0];
  if (!agent || agent.role !== identity.role || ['disabled', 'offline'].includes(agent.availability)) throw new Error('Assigned agent is unavailable or its verified role changed.');
}
export async function runAgent<T>(role: string, deploymentId: string, tool: string, key: string, operation: (identity: ExecutionContext) => Promise<T>, options: { specificationId?: string; specificationVersionId?: string; dependsOnTaskIds?: string[]; reasoningLevel?: 'standard' | 'high' | 'extended' } = {}): Promise<{ value: T; executionId: string; agentId: string; taskId: string }> {
  await ensureDefaultAgents();
  const registered = await db.select().from(schema.agents).where(eq(schema.agents.role, role));
  const primary = registered.find(agent => !agent.isBackup && !['disabled', 'offline'].includes(agent.availability));
  if (!primary || !roleTools[role]?.includes(tool)) throw new Error(`No operational ${role} executor for ${tool}.`);
  const policy = await activePolicy('agents', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: agent execution.');
  const config = JSON.parse(policy.configJson);
  const assignment = role !== 'supervisor' ? await runAgent('supervisor', deploymentId, 'coordinate', `assign:${role}:${tool}:${key}`, async () => ({ agentId: primary.id, role, tool, deploymentId, dependencyIds: options.dependsOnTaskIds || [], specificationVersionId: options.specificationVersionId || null })) : null;
  const dependencies = [...(options.dependsOnTaskIds || []), ...(assignment ? [assignment.taskId] : [])];
  const task = await createAgentTask({ agentId: primary.id, deploymentId, specificationId: options.specificationId, taskType: tool, title: key, input: { key, specificationVersionId: options.specificationVersionId, requiredReasoningLevel: options.reasoningLevel }, dependsOnTaskIds: dependencies, createdBy: assignment?.agentId });
  const old = (await db.select().from(schema.taskExecutions).where(and(eq(schema.taskExecutions.taskId, task.id), eq(schema.taskExecutions.status, 'completed'))).limit(1))[0];
  const deps = await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, task.id));
  if (deps.length) {
    const completed = await db.select().from(schema.agentTasks).where(and(inArray(schema.agentTasks.id, deps.map(dep => dep.dependsOnTaskId)), eq(schema.agentTasks.state, 'completed')));
    if (completed.length !== deps.length) throw new Error('Task dependencies are not complete.');
    const verifiedOutputs = await db.select().from(schema.taskExecutions).where(and(inArray(schema.taskExecutions.taskId, completed.map(dependency => dependency.id)), eq(schema.taskExecutions.deploymentId, deploymentId), eq(schema.taskExecutions.status, 'completed')));
    if (completed.some(dependency => !verifiedOutputs.some(execution => execution.taskId === dependency.id && execution.agentId === dependency.agentId && execution.outputJson === dependency.outputJson))) throw new PolicyEnforcementError('INSUFFICIENT_EVIDENCE', 'Dependencies require genuine persisted agent execution, not a caller-assigned completed status.');
    const stale = completed.some(dependency => dependency.deploymentId !== deploymentId || (options.specificationVersionId && dependency.inputJson && JSON.parse(dependency.inputJson).specificationVersionId && JSON.parse(dependency.inputJson).specificationVersionId !== options.specificationVersionId));
    if (stale) {
      await db.update(schema.agentTasks).set({ state: 'blocked_by_policy', errorMessage: 'Dependency belongs to another workspace or superseded specification.', updatedAt: new Date() }).where(eq(schema.agentTasks.id, task.id));
      await auditOperation(primary.id, 'dependency_blocked', task.id, { dependencies: deps.map(dependency => dependency.dependsOnTaskId), specificationVersionId: options.specificationVersionId }, deploymentId);
      throw new PolicyEnforcementError('DENY', 'Task dependencies must use the same business workspace and current specification.');
    }
    await db.update(schema.agentTasks).set({ state: 'ready', updatedAt: new Date() }).where(and(eq(schema.agentTasks.id, task.id), eq(schema.agentTasks.state, 'waiting_for_dependencies')));
  }
  if (old) {
    if (task.state !== 'completed') throw new PolicyEnforcementError('DENY', 'Cached task output was cancelled or invalidated and cannot be reused.');
    const identity = context(old.agentId, role, deploymentId, roleTools[role]);
    await requireAgentContext(identity, deploymentId, tool);
    if (options.specificationId && options.specificationVersionId) {
      const { enforceSpecification } = await import('./specificationGovernance');
      await enforceSpecification(deploymentId, options.specificationVersionId, identity.agentId);
    }
    await enforcePolicy({ category: 'agents', action: 'tool_execution', versionId: policy.id, deploymentId, actorId: identity.agentId, facts: { verifiedIdentity: true, workspaceMatch: true, tool, roleAllowsTool: true, emergencyStop: await emergencyStopped() } });
    return { value: JSON.parse(old.outputJson!) as T, executionId: old.id, agentId: old.agentId, taskId: task.id };
  }
  const claim = await db.update(schema.agentTasks).set({ state: 'running', updatedAt: new Date() }).where(and(eq(schema.agentTasks.id, task.id), inArray(schema.agentTasks.state, ['ready', 'pending', 'failed', 'blocked_by_policy'])));
  if (!(claim[0] as any).affectedRows) throw new Error('Task is already running or waiting for dependencies.');
  const backup = registered.find(agent => agent.isBackup && (!agent.backupForAgentId || agent.backupForAgentId === primary.id) && !['disabled', 'offline'].includes(agent.availability));
  const priorExecutions = await db.select().from(schema.taskExecutions).where(eq(schema.taskExecutions.taskId, task.id));
  let lastError: unknown;
  for (const agent of [primary, backup].filter(Boolean)) {
    if (agent!.id !== primary.id) await runAgent('supervisor', deploymentId, 'coordinate', `backup:${task.id}:${agent!.id}`, async () => ({ taskId: task.id, originalAgentId: primary.id, backupAgentId: agent!.id, contextPreserved: true }));
    const retries = agent!.id === primary.id ? config.originalAgentRetries : config.backupAgentRetries;
    if (!Number.isInteger(retries) || retries < 1) throw new Error('POLICY_NOT_CONFIGURED: bounded agent retry limits.');
    const priorFailures = priorExecutions.filter(execution => execution.agentId === agent!.id && execution.status === 'failed').length;
    for (let attempt = priorFailures + 1; attempt <= retries; attempt++) {
      const executionId = generateId();
      const identity = context(agent!.id, role, deploymentId, roleTools[role]);
      try {
        await requireAgentContext(identity, deploymentId, tool);
        if (options.specificationId && options.specificationVersionId) {
          const spec = (await db.select().from(schema.businessSpecifications).where(eq(schema.businessSpecifications.id, options.specificationId)).limit(1))[0];
          if (spec?.currentVersionId !== options.specificationVersionId || spec.status !== 'approved') throw new Error('Task specification is stale or unapproved.');
          const { enforceSpecification } = await import('./specificationGovernance');
          await enforceSpecification(deploymentId, options.specificationVersionId, identity.agentId);
        }
        await enforcePolicy({ category: 'agents', action: 'tool_execution', versionId: policy.id, deploymentId, actorId: identity.agentId, facts: { verifiedIdentity: true, workspaceMatch: true, tool, roleAllowsTool: true, emergencyStop: await emergencyStopped() } });
        await db.insert(schema.taskExecutions).values({ id: executionId, taskId: task.id, agentId: identity.agentId, deploymentId, specificationVersionId: options.specificationVersionId || null, tool, status: 'running', attempt });
        const setting = (await db.select().from(schema.operationalSettings).where(eq(schema.operationalSettings.key, 'reasoningAssignments')).limit(1))[0];
        const assignment = setting ? JSON.parse(setting.valueJson).find((item: any) => item.role === role) : undefined;
        const levels = ['standard', 'high', 'extended'] as const;
        const level = levels[Math.max(levels.indexOf(assignment?.level || 'standard'), levels.indexOf(options.reasoningLevel || 'standard'))];
        const routing = assignment || options.reasoningLevel ? { ...assignment, level } : undefined;
        const value = await withAgentRouting(routing, () => operation(identity));
        await requireAgentContext(identity, deploymentId, tool);
        const currentTask = (await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, task.id)).limit(1))[0];
        if (currentTask?.state !== 'running') throw new Error('Task was cancelled or invalidated while executing.');
        if (options.specificationId && options.specificationVersionId) {
          const currentSpec = (await db.select().from(schema.businessSpecifications).where(eq(schema.businessSpecifications.id, options.specificationId)).limit(1))[0];
          if (currentSpec?.currentVersionId !== options.specificationVersionId) throw new Error('Specification changed while executing. Output requires reassignment and re-verification.');
          const { enforceSpecification } = await import('./specificationGovernance');
          await enforceSpecification(deploymentId, options.specificationVersionId, identity.agentId);
        }
        await db.update(schema.taskExecutions).set({ status: 'completed', outputJson: JSON.stringify(value), finishedAt: new Date() }).where(eq(schema.taskExecutions.id, executionId));
        await db.update(schema.agentTasks).set({ state: 'completed', agentId: identity.agentId, outputJson: JSON.stringify(value), updatedAt: new Date() }).where(eq(schema.agentTasks.id, task.id));
        await recordAgentEvent({ agentId: identity.agentId, taskId: task.id, eventType: 'execution_completed', message: `${tool} completed with verified workspace identity.`, metadata: { executionId } });
        await db.update(schema.agents).set({ implementationStatus: 'operational', healthStatus: 'healthy', updatedAt: new Date() }).where(eq(schema.agents.id, identity.agentId));
        return { value, executionId, agentId: identity.agentId, taskId: task.id };
      } catch (error: any) {
        lastError = error;
        await auditOperation(agent!.id, 'agent_failure', executionId, { taskId: task.id, tool, reason: error.message }, deploymentId);
        await db.update(schema.taskExecutions).set({ status: 'failed', errorMessage: error.message, finishedAt: new Date() }).where(eq(schema.taskExecutions.id, executionId));
        await recordAgentEvent({ agentId: agent!.id, taskId: task.id, eventType: 'execution_failed', message: error.message, metadata: { executionId, attempt } });
        const current = (await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, task.id)).limit(1))[0];
        if (current?.state !== 'running') throw error;
        if (error instanceof PolicyEnforcementError || await emergencyStopped() || /specification is stale|Specification changed/.test(error.message)) {
          await db.update(schema.agentTasks).set({ state: 'blocked_by_policy', errorMessage: error.message, updatedAt: new Date() }).where(and(eq(schema.agentTasks.id, task.id), eq(schema.agentTasks.state, 'running')));
          throw error;
        }
        await db.update(schema.agentTasks).set({ retryCount: sql`${schema.agentTasks.retryCount}+1`, errorMessage: error.message, updatedAt: new Date() }).where(eq(schema.agentTasks.id, task.id));
      }
    }
  }
  await db.update(schema.agentTasks).set({ state: 'failed', updatedAt: new Date() }).where(and(eq(schema.agentTasks.id, task.id), eq(schema.agentTasks.state, 'running')));
  await auditOperation(primary.id, 'supervisor_escalation', task.id, { reason: String(lastError), backupAvailable: Boolean(backup) }, deploymentId);
  throw lastError || new Error('Agent execution failed.');
}
