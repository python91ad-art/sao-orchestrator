import { callLLM, callLLMJson, MODEL_CLASSIFIER, MODEL_BUSINESS_PLAN } from './services/llm';
import * as db from './db';
import { retryWithExponentialBackoff } from './retryEngine';

let auditInterval: NodeJS.Timeout | null = null;

// ==========================================
// AUDIT SCHEDULER INITIALIZATION
// ==========================================
export function scheduleAudits() {
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  console.log('Auditor scheduled to check active deployments every 3 days.');
  
  auditInterval = setInterval(async () => {
    console.log('Starting scheduled 3-day active deployments audit...');
    await auditAllActiveDeployments();
  }, threeDaysMs);
}

// ==========================================
// SEND SLACK ALERT HELPER
// ==========================================
async function sendSlackAlert(deploymentId: string, issue: string, health: string) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL || '#alerts';
  if (!slackToken) {
    console.warn('Slack alert skipped: SLACK_BOT_TOKEN not configured.');
    return;
  }

  const payload = {
    channel: slackChannel,
    text: `⚠️ *SAO Deployment Health Alert* ⚠️\n*Deployment:* ${deploymentId}\n*Status:* ${health.toUpperCase()}\n*Details:* ${issue}\n*Timestamp:* ${new Date().toISOString()}`
  };

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${slackToken}`
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Failed to send audit alert to Slack:', error);
  }
}

// ==========================================
// AUTO FIX MECHANISM
// ==========================================
export async function tryAutoFix(deploymentId: string, issue: string, health: 'warning' | 'critical', banRisk: 'low' | 'medium' | 'high') {
  console.log(`Auto-Fix Triggered for Deployment ${deploymentId}. Issue: ${issue}`);

  if (banRisk === 'high') {
    console.log(`High ban risk identified on ${deploymentId}. Pausing deployment to safeguard assets.`);
    await db.updateDeployment(deploymentId, {
      status: 'paused',
      health: 'warning',
    });
    await sendSlackAlert(deploymentId, 'AUTO-FIX: Deployment paused due to High Ban Risk.', 'warning');
    return 'Paused deployment due to High Ban Risk.';
  }

  if (health === 'critical') {
    console.log(`Critical health detected on ${deploymentId}. Synthesizing revised strategic business plan.`);
    const deployment = await db.getDeploymentById(deploymentId);
    if (deployment) {
      const prompt = `Formulate an optimized emergency pivot for this startup plan to resolve the following issue: "${issue}". Keep the core value proposition but mitigate operational overhead. Existing Plan: ${deployment.businessPlan}`;
      
      const updatedPlan = await callLLM(prompt, {
        model: MODEL_BUSINESS_PLAN,
        systemPrompt: 'You are an elite entrepreneurial strategist specializing in situational arbitrage.',
        maxTokens: 4096,
        temperature: 0.7,
      });

      await db.updateDeployment(deploymentId, {
        businessPlan: updatedPlan,
        health: 'warning',
      });
      await sendSlackAlert(deploymentId, 'AUTO-FIX: Pivoted business plan in response to Critical Health status.', 'warning');
      return 'Regenerated plan to pivot around critical bottlenecks.';
    }
  }

  return 'No immediate auto-fix actions matches current status criteria.';
}

// ==========================================
// AUDIT DEPLOYMENT ENGINE (Groq LLM)
// ==========================================
export async function auditDeployment(deploymentId: string) {
  const deployment = await db.getDeploymentById(deploymentId);
  if (!deployment) {
    throw new Error('Deployment not found');
  }

  const gap = await db.getGapById(deployment.gapId);
  const gapContext = gap ? `Gap Context - Knows: ${gap.knows}, Needs: ${gap.needs}` : 'Gap Context Unavailable';

  const systemPrompt = `You are a high-level Auditor for the Situational Arbitrage Orchestrator. 
Analyze the current performance and operational risk of this active deployment. 
Respond with valid raw JSON matching this schema:
{
  "health": "healthy" | "warning" | "critical",
  "banRisk": "low" | "medium" | "high",
  "reasoning": "Audit reasoning details",
  "explanation": "Human readable report summarizing status",
  "issue": "Specific primary issue identified, or null if none",
  "actionRequired": "Recommended operational changes"
}`;

  const userPrompt = `Deployment:
ID: ${deployment.id}
Business Plan: ${deployment.businessPlan}
Stripe Product: ${deployment.stripeProductId}
Revenue: $${deployment.revenue}
Cost Per Day: $${deployment.costPerDay}
Current Status: ${deployment.status}
${gapContext}`;

  const auditResult = await callLLMJson(userPrompt, {
    model: MODEL_CLASSIFIER,
    systemPrompt,
    maxTokens: 1000,
    temperature: 0.3,
  });

  // Record Audit Log
  await db.createAuditLog({
    deploymentId: deployment.id,
    gapId: deployment.gapId,
    decision: `Audit: ${auditResult.health}`,
    reasoning: auditResult.reasoning || 'No reasoning provided',
    explanation: auditResult.explanation || 'No explanation provided',
    banRisk: auditResult.banRisk || 'medium',
    businessHealth: auditResult.health || 'warning',
  });

  // Attempt Auto Fix if necessary
  let fixedActionDescription = null;
  if (auditResult.health !== 'healthy') {
    await sendSlackAlert(deployment.id, auditResult.explanation, auditResult.health);
    fixedActionDescription = await tryAutoFix(
      deployment.id, 
      auditResult.issue || auditResult.explanation, 
      auditResult.health, 
      auditResult.banRisk
    );
  }

  // Record Health Check Record
  await db.createHealthCheck({
    deploymentId: deployment.id,
    revenue: deployment.revenue,
    banRisk: auditResult.banRisk || 'medium',
    health: auditResult.health || 'warning',
    action: fixedActionDescription || auditResult.actionRequired || 'No action required',
    success: true,
  });

  // Update Deployment Record
  const updated = await db.updateDeployment(deployment.id, {
    health: auditResult.health,
    banRisk: auditResult.banRisk,
  });

  return updated;
}

// ==========================================
// AUDIT ALL ACTIVE DEPLOYMENTS
// ==========================================
export async function auditAllActiveDeployments() {
  const deployments = await db.listDeployments();
  const activeDeployments = deployments.filter(d => d.status === 'active');

  console.log(`Auditing ${activeDeployments.length} active deployments...`);
  
  for (const dep of activeDeployments) {
    try {
      await retryWithExponentialBackoff(
        () => auditDeployment(dep.id),
        3,
        1500
      );
    } catch (error) {
      console.error(`Audit failed for deployment ${dep.id}:`, error);
    }
  }
}

// ==========================================
// QUEUE HEALTH CHECK — Alert on high failure rate
// ==========================================
export async function checkQueueHealth() {
  try {
    const stats = await db.getQueueStats() as any;
    const total = stats.total || 0;
    const failed = stats.failed || 0;
    
    if (total === 0) return { healthy: true, message: 'Queue is empty' };
    
    const failureRate = (failed / total) * 100;
    
    if (failureRate > 50) {
      console.warn(`[Queue Health] Failure rate ${failureRate.toFixed(1)}% exceeds 50% threshold. Sending Slack alert.`);
      await sendSlackAlert('queue-health', `Queue failure rate at ${failureRate.toFixed(1)}% (${failed}/${total} items failed). Investigate immediately.`, 'critical');
      return { healthy: false, message: `Failure rate ${failureRate.toFixed(1)}% — alert sent` };
    }
    
    return { healthy: true, message: `Failure rate ${failureRate.toFixed(1)}% — within bounds` };
  } catch (error) {
    console.error('[Queue Health] Error:', error);
    return { healthy: true, message: 'Unable to check queue health' };
  }
}
