import { callLLM, MODEL_CLASSIFIER } from './services/llm';
import * as db from './db';

export interface HealthResult {
  health: 'healthy' | 'warning' | 'critical';
  banRisk: 'low' | 'medium' | 'high';
  report: string;
}

export async function checkDeploymentHealth(deploymentId: string): Promise<HealthResult> {
  const deployment = await db.getDeploymentById(deploymentId);
  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} does not exist.`);
  }

  const report = await generateHealthReport(deployment);
  const banRisk = await assessBanRisk(deployment);

  let health: 'healthy' | 'warning' | 'critical' = 'healthy';
  
  if (banRisk === 'high' || deployment.status === 'stopped') {
    health = 'critical';
  } else if (banRisk === 'medium' || parseFloat(deployment.revenue || '0') < parseFloat(deployment.costPerDay || '0')) {
    health = 'warning';
  }

  return {
    health,
    banRisk,
    report,
  };
}

export async function assessBanRisk(deployment: any): Promise<'low' | 'medium' | 'high'> {
  if (deployment.status === 'stopped') return 'low';

  const prompt = `Assess the current ban risk or operational interference risk for this micro-startup arbitrage deployment.
Deployment context:
Business Plan summary: ${deployment.businessPlan?.substring(0, 800)}...
Revenue: $${deployment.revenue}
Cost Per Day: $${deployment.costPerDay}

Assess if the platform limits, automated scrapers, or third-party TOS are close to throttling or banning this deployment's operation.
Respond with exactly one word: low, medium, or high.`;

  try {
    const responseText = (await callLLM(prompt, { model: MODEL_CLASSIFIER, maxTokens: 10, temperature: 0.1 })).trim().toLowerCase();
    if (responseText.includes('high')) return 'high';
    if (responseText.includes('medium')) return 'medium';
    return 'low';
  } catch (error) {
    console.error('Failed to assess ban risk with AI. Falling back to default "low".', error);
    return 'low';
  }
}

export async function generateHealthReport(deployment: any): Promise<string> {
  const prompt = `Generate a short executive health report (max 150 words) for this active situational arbitrage deployment:
ID: ${deployment.id}
Revenue: $${deployment.revenue}
Cost Per Day: $${deployment.costPerDay}
Status: ${deployment.status}

Include insights on margin health, conversion stability, and immediate operational recommendations.`;

  try {
    return await callLLM(prompt, { model: MODEL_CLASSIFIER, maxTokens: 500, temperature: 0.5 });
  } catch (error) {
    console.error('Failed to generate health report with AI:', error);
    return 'Unable to generate dynamic health report due to an external model communication error.';
  }
}
