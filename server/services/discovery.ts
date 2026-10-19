import { scoreGap, QUALIFICATION_THRESHOLD } from './gapAnalysis';
import { discoverOns, type OnsOutcome } from './onsDiscovery';
import { detectEcommerceGaps, detectOperationalGaps, newWebMetrics, type WebDiscoveryMetrics } from './search';
import { validateDiscoveryProposal, type QualifiedGap } from './discoveryEvidence';
import { mutateDiscoveryRuntime, acquireDiscoveryLease } from './discoveryRuntime';

export interface DiscoveryReport {
  status: 'idle' | 'running' | 'ok' | 'partial' | 'unavailable' | 'stopped' | 'interrupted';
  ons: { status: string; signals: number; errors: string[] };
  web: WebDiscoveryMetrics & { status: string };
  candidatesBySource: Record<string, number>; validated: number; rejected: number; queued: number;
  cycleId?: string; startedAt?: string; persisted?: number; duplicates?: number; errors?: string[]; outcome?: string;
  lastSuccess: string | null; lastFailure: string | null; completedAt?: string;
}
let report: DiscoveryReport = { status: 'idle', ons: { status: 'idle', signals: 0, errors: [] }, web: { status: 'idle', ...newWebMetrics() }, candidatesBySource: {}, validated: 0, rejected: 0, queued: 0, lastSuccess: null, lastFailure: null };
export function getMultiSourceDiscoveryStatus() { return structuredClone(report); }
export async function restoreDiscoveryReport() {
  const saved = await mutateDiscoveryRuntime('report', state => state.report as DiscoveryReport | undefined).catch(() => undefined);
  if (saved && !running) {
    report = saved;
    if (report.status === 'running') {
      const active = await mutateDiscoveryRuntime('cycle-lease', state => state.expires > Date.now());
      if (!active) {
        report = { ...report, status: 'interrupted', outcome: 'interrupted', lastFailure: new Date().toISOString(), errors: ['Discovery was interrupted by a process exit; no completed result was recorded.'] };
        // Derive interruption from the durable report/lease without overwriting a newer replica's report.
      }
    }
  }
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
export function runDiscoveryCycle(queue: (gaps: QualifiedGap[]) => Promise<number | { queued: number; persisted: number }>, deps: {
  acquireLease: typeof acquireDiscoveryLease; ons: typeof discoverOns; ecommerce: typeof detectEcommerceGaps; operational: typeof detectOperationalGaps;
  persist: (r: DiscoveryReport) => Promise<void>; load?: () => Promise<DiscoveryReport | undefined>;
} = {
  load: () => mutateDiscoveryRuntime('report', state => state.report as DiscoveryReport | undefined),
  acquireLease: acquireDiscoveryLease, ons: discoverOns, ecommerce: detectEcommerceGaps, operational: detectOperationalGaps, persist: async (r: DiscoveryReport) => { await mutateDiscoveryRuntime('report', state => { state.report = r; }); },
}, shouldContinue: () => Promise<boolean> = async () => true): Promise<DiscoveryReport> {
  if (running) return running;
  running = (async () => {
    const release = await deps.acquireLease();
    if (!release) throw new Error('Discovery is already executing in another session.');
    try {
      const previous = await deps.load?.();
      if (previous) report = { ...report, lastSuccess: previous.lastSuccess, lastFailure: previous.lastFailure };
      report = { status: 'running', cycleId: crypto.randomUUID(), startedAt: new Date().toISOString(), outcome: 'running',
        ons: { status: 'running', signals: 0, errors: [] }, web: { status: 'running', ...newWebMetrics() }, candidatesBySource: {},
        validated: 0, rejected: 0, queued: 0, persisted: 0, duplicates: 0, errors: [], lastSuccess: report.lastSuccess, lastFailure: report.lastFailure };
      await deps.persist(report);
      const metrics = newWebMetrics();
      const engines = await Promise.allSettled([deps.ons({ shouldContinue }), deps.ecommerce(metrics, shouldContinue), deps.operational(metrics, shouldContinue)]);
      const ons: OnsOutcome = engines[0].status === 'fulfilled' ? engines[0].value : { status: 'unavailable', errors: ['ONS discovery failed'], gaps: [], signals: 0, candidates: 0, rejected: 0 };
      const web = engines.slice(1).flatMap(result => result.status === 'fulfilled' ? result.value as QualifiedGap[] : []);
      const extractionFailures = metrics.extractionFailures + engines.slice(1).filter(r => r.status === 'rejected').length;
      const onsOk = ons.status === 'ok' || ons.status === 'partial' || ons.status === 'insufficient_evidence';
      const webOk = metrics.successes - extractionFailures > 0;
      const batch = [...ons.gaps, ...web];
      const valid = batch.filter(g => !!validateDiscoveryProposal(g.validation, g.evidence, g.source));
      const scored = valid.filter(g => scoreGap(g).score >= QUALIFICATION_THRESHOLD).map(g => ({ ...g, priority: Math.max(1, Math.ceil(scoreGap(g).score / 10)) }));
      const gaps = deduplicateCandidates(scored).sort((a, b) => (b.priority || 0) - (a.priority || 0));
      const candidatesBySource: Record<string, number> = { ons: ons.candidates, ...metrics.candidatesByProvider };
      let queued = 0, persisted = 0, queueFailed = false;
      let persistenceErrors: string[] = [];
      let stopped = !await shouldContinue();
      try {
        if (!stopped) {
          const result = await queue(gaps);
          queued = typeof result === 'number' ? result : result.queued;
          persisted = typeof result === 'number' ? result : result.persisted;
        }
      } catch (error: any) { queueFailed = true; persistenceErrors = Array.isArray(error?.errors) ? error.errors : []; queued = Number.isInteger(error?.queued) ? error.queued : 0; persisted = Number.isInteger(error?.persisted) ? error.persisted : 0; }
      stopped = stopped || !await shouldContinue();
      const errors = [...ons.errors, ...(metrics.failures ? [`${metrics.failures} web searches unavailable; inspect provider attempts.`] : []),
        ...(extractionFailures ? [`${extractionFailures} web evidence interpretations failed.`] : []),
        ...(queueFailed ? ['Candidate persistence or queue insertion failed; existing records preserved.', ...persistenceErrors] : []),
        ...(ons.status === 'not_configured' ? ['ONS discovery disabled by provider configuration.'] : [])];
      const now = new Date().toISOString();
      const failed = ons.status === 'partial' || ons.errors.length > 0 || !onsOk || !webOk || metrics.failures > 0 || extractionFailures > 0 || queueFailed;
      report = { cycleId: report.cycleId, startedAt: report.startedAt, persisted, duplicates: scored.length - gaps.length, errors,
        outcome: stopped ? 'stopped' : !onsOk && !webOk ? 'failed' : failed ? 'partially_successful' : gaps.length ? 'completed_with_results' : 'completed_with_zero_results',
        status: stopped ? 'stopped' : !onsOk && !webOk ? 'unavailable' : failed ? 'partial' : 'ok',
        ons: { status: ons.status, signals: ons.signals, errors: ons.errors },
        web: { status: !webOk ? 'unavailable' : metrics.failures || extractionFailures ? 'partial' : 'ok', ...metrics, extractionFailures },
        candidatesBySource, validated: gaps.length, rejected: ons.rejected + metrics.rejected + batch.length - scored.length, queued,
        lastSuccess: !stopped && !queueFailed && (onsOk || webOk) ? now : report.lastSuccess, lastFailure: failed ? now : report.lastFailure, completedAt: now };
      await deps.persist(report);
      return getMultiSourceDiscoveryStatus();
    } finally { await release(); }
  })().catch(async () => {
    report = { ...report, status: 'unavailable', outcome: 'failed', completedAt: new Date().toISOString(), errors: ['Discovery runtime or persistence unavailable.'], lastFailure: new Date().toISOString() };
    await deps.persist(report).catch(() => {});
    throw new Error('Discovery runtime or persistence unavailable; existing queue processing may continue.');
  }).finally(() => { running = null; });
  return running;
}
