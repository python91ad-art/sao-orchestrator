import { z } from 'zod';
import { AGENT_ROLES } from './infrastructure';
import { agentRoleTools, runAgent } from './execution';
import { approvedSpecification } from './specificationGovernance';
import { gapPolicyAssessment } from './discoveryPolicy';
import { callLLMJson } from './llm';
import { db } from '../db';
import { deployments } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';

export async function runRequiredSpecialistReviews(deploymentId: string) {
  const approved = await approvedSpecification(deploymentId);
  if (!approved) throw new Error('Approved shared requirements are required before specialist assignment.');
  const expertise = [...new Set(z.array(z.enum(AGENT_ROLES)).min(1).parse(approved.sections.expertise))];
  const business = (await db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1))[0];
  if (!business) throw new Error('Specialist workspace is unavailable.');
  const assessment = await gapPolicyAssessment(business.gapId);
  const reasoningLevel = assessment.reasoningLevel as 'standard' | 'high' | 'extended';
  const reviews = [];
  for (const role of expertise) {
    if (['developer', 'independent_qc', 'system_architect', 'supervisor'].includes(role)) continue;
    const tool = agentRoleTools(role).find(tool => tool !== 'discuss_conflict');
    if (!tool) throw new Error(`Required specialist ${role} has no available executor. The dependent build remains blocked.`);
    const review = await runAgent(role, deploymentId, tool, `specialist:${approved.version.id}:${role}`, async () => z.object({ observations: z.array(z.string().min(1)).min(1), immediateRecommendations: z.array(z.string()), futureRecommendations: z.array(z.string()), uncertainties: z.array(z.string()) }).parse(await callLLMJson(`Provide an independent specialist review as ${role} against the shared approved specification. Return {observations:string[],immediateRecommendations:string[],futureRecommendations:string[],uncertainties:string[]}. This is advisory work only: do not change requirements, publish content, charge customers, grant approvals, claim QC passed or execute external actions. Shared requirements: ${JSON.stringify(approved.sections)}. Business plan: ${business.businessPlan}`, { task: 'JSON_GENERATION', reasoningLevel })), { specificationId: approved.spec.id, specificationVersionId: approved.version.id, reasoningLevel });
    reviews.push({ role, agentId: review.agentId, taskId: review.taskId, executionId: review.executionId, assessment: review.value });
  }
  return { reviews, reasoningLevel };
}
