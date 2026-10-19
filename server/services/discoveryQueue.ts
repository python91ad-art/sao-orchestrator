import { scoreGap, QUALIFICATION_THRESHOLD } from './gapAnalysis';
import * as database from '../db';
import * as schema from '../../drizzle/schema';
import { and, eq, sql } from 'drizzle-orm';
import { computeGapDedupHash, createEvidence } from './infrastructure';
import { withDiscoveryWrite } from './discoveryMaintenance';
import { validateDiscoveryProposal, type QualifiedGap } from './discoveryEvidence';
import { deduplicateCandidates } from './discovery';

/** Existing maintenance lock serializes automatic and manual discovery writes across replicas. */
export async function queueDiscoveryGaps(candidates: QualifiedGap[]): Promise<number> {
  return withDiscoveryWrite(async () => {
    let queued = 0, failed = 0;
    for (const candidate of deduplicateCandidates(candidates)) {
      try {
        const validated = validateDiscoveryProposal(candidate.validation, candidate.evidence, candidate.source);
        if (!validated || scoreGap(candidate).score < QUALIFICATION_THRESHOLD) continue;
        const priority = Math.max(1, Math.ceil(scoreGap(candidate).score / 10));
        const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
        const dedupHash = computeGapDedupHash({ ...candidate, source: 'discovery' });
        // Include legacy source-specific hashes, archived records and all statuses without rewriting history.
        const [existing] = await database.db.select().from(schema.gaps).where(and(
          sql`LOWER(TRIM(REGEXP_REPLACE(${schema.gaps.knows}, '[[:space:]]+', ' ')))=${normalize(candidate.knows)}`,
          sql`LOWER(TRIM(REGEXP_REPLACE(${schema.gaps.needs}, '[[:space:]]+', ' ')))=${normalize(candidate.needs)}`,
          sql`LOWER(TRIM(REGEXP_REPLACE(${schema.gaps.controlsAccess}, '[[:space:]]+', ' ')))=${normalize(candidate.controlsAccess)}`,
          sql`LOWER(TRIM(REGEXP_REPLACE(${schema.gaps.underestimatesValue}, '[[:space:]]+', ' ')))=${normalize(candidate.underestimatesValue)}`,
        )).limit(1);
        const gap = existing || await database.createGap({ knows: candidate.knows, needs: candidate.needs,
          controlsAccess: candidate.controlsAccess, underestimatesValue: candidate.underestimatesValue,
          source: candidate.source, dedupHash, priority, status: 'pending' });
        if (!gap) throw new Error('Could not persist discovered gap');
        for (const evidence of candidate.evidence) {
          await createEvidence({ gapId: gap.id, provider: evidence.provider, sourceUrl: evidence.url,
            category: evidence.observation ? 'statistical_observation' : 'discovery_problem', title: evidence.title.slice(0, 500),
            summary: evidence.text.slice(0, 8000), content: evidence.text.slice(0, 8000), retrievedAt: new Date(evidence.retrievedAt),
            publishedAt: evidence.publishedAt ? new Date(evidence.publishedAt) : null,
            geography: evidence.geography, reportingPeriod: evidence.reportingPeriod,
            metadata: { id: evidence.id, observation: evidence.observation, citation: evidence.citation,
              retrievedAt: evidence.retrievedAt, deterministicScore: scoreGap(candidate), validation: validated.validation, discoverySource: candidate.source },
            caveats: ['Discovery support checked; independent reliability and legal review still required.', 'Proposed solution is an unverified hypothesis.', 'Search publication/update dates may be provider estimates; recency requires source review.'], status: 'collected' });
        }
        // Reuse queued history. Recover an interrupted new insertion only, never requeue historical gaps.
        const [item] = await database.db.select().from(schema.queueItems).where(eq(schema.queueItems.gapId, gap.id)).limit(1);
        const [archived] = await database.db.select().from(schema.discoveryArchives).where(eq(schema.discoveryArchives.gapId, gap.id)).limit(1);
        if (!item && !archived && (!existing || (gap.dedupHash === dedupHash && gap.status === 'pending'))) {
          await database.createQueueItem({ gapId: gap.id, dedupHash: gap.dedupHash, priority: gap.priority, sortOrder: 0 });
          queued++;
        }
      } catch { failed++; }
    }
    if (failed) throw Object.assign(new Error('Some discovery candidates could not be persisted; existing work is preserved.'), { queued, failed });
    return queued;
  });
}
