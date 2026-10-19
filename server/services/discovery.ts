import { scoreGap, QUALIFICATION_THRESHOLD } from './gapAnalysis';
import { discoverOns, type OnsOutcome } from './onsDiscovery';
import { detectEcommerceGaps, detectOperationalGaps, newWebMetrics } from './search';
import { validateDiscoveryProposal, type QualifiedGap } from './discoveryEvidence';
import { mutateDiscoveryRuntime, acquireDiscoveryLease } from './discoveryRuntime';

export interface DiscoveryReport {
  status: 'idle' | 'running' | 'ok' | 'partial' | 'unavailable';
  ons: { status: string; signals: number; errors: string[] };
  web: { status: string; searches: number; successes: number; failures: number; extractionFailures: number };
  candidatesBySource: Record<string, number>; validated: number; rejected: number; queued: number;
  lastSuccess: string | null; lastFailure: string | null; completedAt?: string;
}
let report: DiscoveryReport = { status: 'idle', ons: { status: 'idle', signals: 0, errors: [] }, web: { status: 'idle', ...newWebMetrics() }, candidatesBySource: {}, validated: 0, rejected: 0, queued: 0, lastSuccess: null, lastFailure: null };
export function getMultiSourceDiscoveryStatus() { return structuredClone(report); }
export async function restoreDiscoveryReport() {
  const saved = await mutateDiscoveryRuntime('report', state => state.report as DiscoveryReport | undefined).catch(() => undefined);
  if (saved && report.status !== 'running') report = saved;
  return getMultiSourceDiscoveryStatus();
}
export function deduplicateCandidates(gaps: QualifiedGap[]): QualifiedGap[] {
  // Reuse the existing normalization; source is deliberately excluded from identity.
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const byIdentity = new Map<string, QualifiedGap>();
  for (const gap of gaps) {
    const identity = [gap.knows, gap.needs, gap.controlsAccess, gap.underestimatesValue].map(normalize).join('|');
    const existing = byIdentity.get(identity);
    if (existing) existing.evidence = Array.from(new Map([...existing.evidence, ...gap.evidence].map(e => [`${e.provider}:${e.url}:${e.reportingPeriod || ''}`, e])).values());
    else byIdentity.set(identity, { ...gap, evidence: [...gap.evidence] });
  }
  return [...byIdentity.values()];
}
let running: Promise<DiscoveryReport> | null = null;
export function runDiscoveryCycle(queue: (gaps: QualifiedGap[]) => Promise<number>, deps = {
  acquireLease: acquireDiscoveryLease, ons: discoverOns, ecommerce: detectEcommerceGaps, operational: detectOperationalGaps, persist: async (r: DiscoveryReport) => { await mutateDiscoveryRuntime('report', state => { state.report = r; }); },
}): Promise<DiscoveryReport> {
  if (running) return running;
  running = (async () => {
    const release = await deps.acquireLease();
    if (!release) return getMultiSourceDiscoveryStatus();
    try {
      report = { ...report, status: 'running' };
      const metrics = newWebMetrics();
      const engines = await Promise.allSettled([deps.ons(), deps.ecommerce(metrics), deps.operational(metrics)]);
      const ons: OnsOutcome = engines[0].status === 'fulfilled' ? engines[0].value : { status: 'unavailable', errors: ['ONS discovery failed'], gaps: [], signals: 0, candidates: 0, rejected: 0 };
      const web = engines.slice(1).flatMap(result => result.status === 'fulfilled' ? result.value as QualifiedGap[] : []);
      const extractionFailures = metrics.extractionFailures + engines.slice(1).filter(r => r.status === 'rejected').length;
      const onsOk = ons.status === 'ok' || ons.status === 'insufficient_evidence';
      const webOk = metrics.successes - extractionFailures > 0;
      const batch = [...ons.gaps, ...web];
      const valid = batch.filter(g => !!validateDiscoveryProposal(g.validation, g.evidence, g.source));
      const scored = valid.filter(g => scoreGap(g).score >= QUALIFICATION_THRESHOLD).map(g => ({ ...g, priority: Math.max(1, Math.ceil(scoreGap(g).score / 10)) }));
      const gaps = deduplicateCandidates(scored).sort((a, b) => (b.priority || 0) - (a.priority || 0));
      const candidatesBySource: Record<string, number> = { ons: ons.candidates, ...metrics.candidatesByProvider };
      let queued = 0, queueFailed = false;
      try { queued = await queue(gaps); } catch (error: any) { queueFailed = true; queued = Number.isInteger(error?.queued) ? error.queued : 0; }
      const now = new Date().toISOString();
      const failed = !onsOk || !webOk || metrics.failures > 0 || extractionFailures > 0 || queueFailed;
      report = { status: !onsOk && !webOk ? 'unavailable' : failed ? 'partial' : 'ok',
        ons: { status: ons.status, signals: ons.signals, errors: ons.errors },
        web: { status: !webOk ? 'unavailable' : metrics.failures || extractionFailures ? 'partial' : 'ok', ...metrics, extractionFailures },
        candidatesBySource, validated: gaps.length, rejected: ons.rejected + metrics.rejected + batch.length - scored.length, queued,
        lastSuccess: onsOk || webOk ? now : report.lastSuccess, lastFailure: failed ? now : report.lastFailure, completedAt: now };
      await deps.persist(report);
      return getMultiSourceDiscoveryStatus();
    } finally { await release(); }
  })().catch(async () => {
    report = { ...report, status: 'unavailable', lastFailure: new Date().toISOString() };
    await deps.persist(report).catch(() => {});
    throw new Error('Discovery runtime or persistence unavailable; existing queue processing may continue.');
  }).finally(() => { running = null; });
  return running;
}
