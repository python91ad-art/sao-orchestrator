import { and, eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { db, generateId, getCoreLoopState } from '../db';
import * as schema from '../../drizzle/schema';

export async function deliverOperationalNotification(type: string, resourceId: string, detail: unknown, deploymentId?: string) {
  const category = type === 'deadline_warning' ? 'deadlineWarnings' : type === 'agent_failure' || type === 'supervisor_escalation' ? 'agentFailures' : type === 'repair_required' ? 'qcAlerts' : type === 'settlement_exception' ? 'settlementExceptions' : type === 'budget_warning' ? 'budgetAlerts' : 'systemAlerts';
  const routing = (await db.select().from(schema.operationalSettings).where(eq(schema.operationalSettings.key, 'notificationRouting')).limit(1))[0];
  if (!routing || JSON.parse(routing.valueJson)[category] !== true) return;
  const existing = await db.select().from(schema.operationalEvents).where(and(eq(schema.operationalEvents.type, 'notification_delivery'), eq(schema.operationalEvents.resourceId, `${type}:${resourceId}`))).limit(1);
  if (existing.length) return;
  const business = deploymentId ? (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0] : null;
  const owner = business?.userId ? (await db.select().from(schema.users).where(eq(schema.users.id, business.userId)).limit(1))[0] : null;
  const settings = await getCoreLoopState();
  const results: { channel: string; status: string; providerReference?: string }[] = [{ channel: 'in_app', status: 'available' }];
  if (process.env.NODE_ENV === 'test') results.push({ channel: 'external', status: 'suppressed_in_test' });
  else {
    if (settings?.emailNotifications && owner && process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) {
      try {
        const response = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: process.env.RESEND_FROM_EMAIL, to: owner.email, subject: `SAO ${type.replace(/_/g, ' ')}`, text: `Business ${deploymentId || 'system'}\n${JSON.stringify(detail)}` });
        results.push({ channel: 'email', status: response.error ? 'failed' : 'accepted_by_provider', providerReference: response.data?.id });
      } catch { results.push({ channel: 'email', status: 'failed' }); }
    }
    if (settings?.slackNotifications && process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL) {
      try {
        const response = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: process.env.SLACK_CHANNEL, text: `SAO ${type}: business ${deploymentId || 'system'}, reference ${resourceId}. Inspect the dashboard for details.` }), signal: AbortSignal.timeout(10000) });
        const result = await response.json() as any;
        results.push({ channel: 'slack', status: result.ok === true ? 'accepted_by_provider' : 'failed', providerReference: result.ts });
      } catch { results.push({ channel: 'slack', status: 'failed' }); }
    }
  }
  await db.insert(schema.operationalEvents).values({ id: generateId(), actorId: 'system:notifications', deploymentId: deploymentId || null, type: 'notification_delivery', resourceId: `${type}:${resourceId}`, detailJson: JSON.stringify({ category, ownerId: owner?.id, results, message: detail }) });
}
