import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, generateId } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy, evaluatePolicy, Principal, requirePolicyPermission } from './policyEngine';
import { callLLMJson } from './llm';
import { withDiscoveryWrite } from './discoveryMaintenance';

export const gapReviewInput = z.object({
  gapId: z.string(), legalState: z.enum(['legal', 'illegal', 'pending_review']), complexity: z.enum(['normal', 'complex', 'very_complex']),
  demandScore: z.number().finite().nonnegative(), severityScore: z.number().finite().nonnegative(), evidenceScore: z.number().finite().nonnegative(), solutionScore: z.number().finite().nonnegative(),
  evidenceIds: z.array(z.string()).min(2), rationale: z.string().trim().min(1).max(10000),
  confidence: z.enum(['clear', 'uncertain']).optional(), jurisdiction: z.string().min(1).max(200).optional(), uncertainty: z.array(z.string()).default([]),
});
export async function recordGapReview(actor: Principal, raw: unknown) {
  return withDiscoveryWrite(() => recordGapReviewUnlocked(actor, raw));
}
async function recordGapReviewUnlocked(actor: Principal, raw: unknown) {
  await requirePolicyPermission(actor);
  const input = gapReviewInput.parse(raw);
  if (!(await db.select({ id: schema.gaps.id }).from(schema.gaps).where(eq(schema.gaps.id, input.gapId)).limit(1))[0]) throw new Error('Review target no longer exists.');
  if (input.legalState === 'legal' && (input.confidence !== 'clear' || input.uncertainty.length)) throw new Error('Uncertain legality cannot be cleared as legal. Record pending review instead.');
  const evidence = await db.select().from(schema.evidenceRecords).where(and(eq(schema.evidenceRecords.gapId, input.gapId), inArray(schema.evidenceRecords.id, input.evidenceIds)));
  if (evidence.length !== new Set(input.evidenceIds).size) throw new Error('Every evidence reference must belong to the reviewed gap.');
  const id = generateId();
  await db.insert(schema.gapPolicyReviews).values({ id, gapId: input.gapId, legalState: input.legalState, complexity: input.complexity, demandScore: String(input.demandScore), severityScore: String(input.severityScore), evidenceScore: String(input.evidenceScore), solutionScore: String(input.solutionScore), evidenceIdsJson: JSON.stringify(input.evidenceIds), rationale: input.rationale, actorId: actor.id, createdAt: new Date() });
  const { auditOperation } = await import('./execution');
  await auditOperation(actor.id, 'legal_review', id, { gapId: input.gapId, jurisdiction: input.jurisdiction, confidence: input.confidence, uncertainty: input.uncertainty });
  const decision = await evaluateGapPromotion(input.gapId);
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.gapId, input.gapId)).limit(1))[0];
  const archived = (await db.select().from(schema.discoveryArchives).where(eq(schema.discoveryArchives.gapId, input.gapId)).limit(1))[0];
  if (business && input.legalState !== 'legal') {
    const { suspendBusiness } = await import('./businessLifecycle');
    await suspendBusiness(actor.id, business.id, `Verified legal review ${id} requires safe suspension: ${input.legalState}. ${input.rationale}`);
  }
  if (!business && !archived) {
    const items = await db.select().from(schema.queueItems).where(and(eq(schema.queueItems.gapId, input.gapId), eq(schema.queueItems.queueType, 'synthesis')));
    const { createQueueItem, getGapById, updateQueueItem } = await import('../db');
    if (!items.length && decision.decision === 'ALLOW') { const gap = await getGapById(input.gapId); if (gap) await createQueueItem({ gapId: gap.id, dedupHash: gap.dedupHash, priority: gap.priority }); }
    for (const item of items) {
      if (['pending', 'paused', 'failed'].includes(item.status)) await updateQueueItem(item.id, { status: decision.decision === 'ALLOW' ? 'pending' : 'paused', lastError: decision.decision === 'ALLOW' ? null : `${decision.decision}: ${decision.reason}`, workerId: null, nextRetryAt: null });
    }
  }
  await rankDiscoveryQueue();
  return { id };
}
export async function gapPolicyAssessment(gapId: string) {
  const policy = await activePolicy('discovery');
  const config = policy ? JSON.parse(policy.configJson) : null;
  const reviews = await db.select().from(schema.gapPolicyReviews).where(eq(schema.gapPolicyReviews.gapId, gapId)).orderBy(desc(schema.gapPolicyReviews.createdAt), desc(schema.gapPolicyReviews.id)).limit(2);
  const review = reviews[0];
  if (!review) return { legalState: 'pending_review', reasoningLevel: 'standard', score: null, independentSources: [], legalReviewId: null, review: null, policyVersionId: policy?.id || null };
  const evidenceIds = JSON.parse(review.evidenceIdsJson) as string[];
  const evidence = evidenceIds.length ? await db.select().from(schema.evidenceRecords).where(and(eq(schema.evidenceRecords.gapId, gapId), inArray(schema.evidenceRecords.id, evidenceIds))) : [];
  const independentSources = evidence.filter(record => record.status === 'verified' && record.sourceUrl && config?.evidenceMaxAgeDays && Date.now() - record.retrievedAt.getTime() <= config.evidenceMaxAgeDays * 86400000).flatMap(record => {
    try { const url = new URL(record.sourceUrl!); const reliability = record.reliabilityJson ? JSON.parse(record.reliabilityJson) : null; return reliability?.reliable === true && reliability.reviewedBy && (url.protocol === 'https:' || url.protocol === 'http:') ? [String(reliability.publisher || url.hostname).toLowerCase().replace(/^www\./, '').trim()] : []; } catch { return []; }
  });
  const score = config && ['demandWeight', 'severityWeight', 'evidenceWeight', 'solutionWeight'].every(key => Number.isFinite(config[key])) ? Number(review.demandScore) * config.demandWeight + Number(review.severityScore) * config.severityWeight + Number(review.evidenceScore) * config.evidenceWeight + Number(review.solutionScore) * config.solutionWeight : null;
  const conflicting = reviews[1] && reviews[1].createdAt.getTime() === review.createdAt.getTime() && reviews[1].legalState !== review.legalState;
  return { legalState: conflicting ? 'pending_review' : review.legalState, reasoningLevel: review.complexity === 'very_complex' ? 'extended' : review.complexity === 'complex' ? config?.complexReasoning || 'high' : 'standard', score, independentSources: [...new Set(independentSources)], legalReviewId: review.id, review, evidence, policyVersionId: policy?.id || null, ranking: { demand: { score: review.demandScore, weight: config?.demandWeight }, severity: { score: review.severityScore, weight: config?.severityWeight }, evidence: { score: review.evidenceScore, weight: config?.evidenceWeight }, solution: { score: review.solutionScore, weight: config?.solutionWeight }, complexityAffectsPriority: false } };
}
export async function reviewDiscoveryEvidence(actor: Principal, id: string, reliable: boolean, rationale: string, publisher: string) {
  await requirePolicyPermission(actor, 'policies.edit');
  const evidence = (await db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.id, id)).limit(1))[0];
  if (!evidence?.gapId || !evidence.sourceUrl || !rationale.trim() || !publisher.trim()) throw new Error('Candidate source attribution and review rationale required.');
  const aiAssessment = z.object({ reliability: z.enum(['high', 'medium', 'low', 'unknown']), rationale: z.string().min(1), limitations: z.array(z.string()) }).parse(await callLLMJson(`Assess source reliability using only the stored attribution and evidence. Return {reliability:high|medium|low|unknown,rationale:string,limitations:string[]}. Do not claim independent retrieval, demand verification or legal clearance. ${JSON.stringify({ url: evidence.sourceUrl, summary: evidence.summary, provider: evidence.provider, publisher })}`, { task: 'JSON_GENERATION' }));
  await db.update(schema.evidenceRecords).set({ status: reliable ? 'verified' : 'rejected', reliabilityJson: JSON.stringify({ reliable, rationale, publisher, aiAssessment, reviewedBy: actor.id, reviewedAt: new Date().toISOString() }) }).where(eq(schema.evidenceRecords.id, id));
  const { auditOperation } = await import('./execution');
  await auditOperation(actor.id, 'evidence_reviewed', id, { reliable, publisher, rationale, gapId: evidence.gapId });
}
export async function discoveryBoard(actor: Principal, offset = 0, limit = 50, legalState?: 'legal' | 'illegal' | 'pending_review') {
  await requirePolicyPermission(actor, 'policies.view');
  const classification = sql`COALESCE((SELECT IF(COUNT(DISTINCT r.legal_state)>1,'pending_review',MAX(r.legal_state)) FROM gap_policy_reviews r WHERE r.gap_id=${schema.gaps.id} AND r.created_at=(SELECT MAX(latest.created_at) FROM gap_policy_reviews latest WHERE latest.gap_id=${schema.gaps.id})),'pending_review')`;
  const gaps = await db.select().from(schema.gaps).where(and(sql`NOT EXISTS(SELECT 1 FROM discovery_archives WHERE gap_id=${schema.gaps.id})`, legalState ? sql`${classification}=${legalState}` : undefined)).orderBy(sql`COALESCE((SELECT MIN(sort_order) FROM queue_items WHERE gap_id=${schema.gaps.id} AND queue_type='synthesis'),2147483647)`, desc(schema.gaps.createdAt)).limit(limit).offset(offset);
  return Promise.all(gaps.map(async gap => ({ ...gap, assessment: await gapPolicyAssessment(gap.id) })));
}
export async function discoveryCounts(actor: Principal) {
  await requirePolicyPermission(actor, 'policies.view');
  const classification = sql`COALESCE((SELECT IF(COUNT(DISTINCT r.legal_state)>1,'pending_review',MAX(r.legal_state)) FROM gap_policy_reviews r WHERE r.gap_id=${schema.gaps.id} AND r.created_at=(SELECT MAX(latest.created_at) FROM gap_policy_reviews latest WHERE latest.gap_id=${schema.gaps.id})),'pending_review')`;
  const [rows] = await db.execute(sql`SELECT ${classification} AS legalState,COUNT(*) AS count FROM gaps WHERE NOT EXISTS(SELECT 1 FROM discovery_archives WHERE gap_id=gaps.id) GROUP BY legalState`);
  return (rows as unknown as any[]).map(row => ({ legalState: row.legalState as 'legal' | 'illegal' | 'pending_review', count: Number(row.count) }));
}
export async function rankDiscoveryQueue() {
  const { listGaps } = await import('../db');
  const ranked: { id: string; score: number; legal: string }[] = [];
  for (let offset = 0; ; offset += 100) {
    const candidates = await listGaps(100, offset);
    if (!candidates.length) break;
    for (const gap of candidates) {
      const assessment = await gapPolicyAssessment(gap.id);
      if (assessment.score !== null) ranked.push({ id: gap.id, score: assessment.score, legal: assessment.legalState });
    }
  }
  ranked.sort((first, second) => second.score - first.score || first.id.localeCompare(second.id));
  for (let position = 0; position < ranked.length; position++) {
    const candidate = ranked[position];
    await db.update(schema.queueItems).set({ sortOrder: position, updatedAt: new Date() }).where(and(eq(schema.queueItems.gapId, candidate.id), eq(schema.queueItems.queueType, 'synthesis'), eq(schema.queueItems.status, 'pending')));
  }
  return ranked;
}
export async function evaluateGapPromotion(gapId: string) {
  const assessment = await gapPolicyAssessment(gapId);
  return evaluatePolicy({ category: 'discovery', action: 'business_creation', versionId: assessment.policyVersionId || undefined, gapId, actorId: 'system:discovery', facts: { legalState: assessment.legalState, legalReviewId: assessment.legalReviewId, independentSources: assessment.independentSources, score: assessment.score, reasoningLevel: assessment.reasoningLevel } });
}
