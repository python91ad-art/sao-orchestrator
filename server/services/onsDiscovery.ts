import { DATASET_EXCLUSIONS, DatasetSkipped, assertDatasetEligible, supportedOnsGeography, type DatasetDiagnostic, type DatasetReason } from './datasetEligibility';
import { recordAssignmentOutcome, type AssignmentRoute } from './providerAssignments';
import { LLMRouterExhaustedError } from './llmTypes';
import { createHash } from 'node:crypto';
import { OnsAdapter } from './businessData';
import { extractQualifiedGaps, type CandidateBatch, type DiscoveryEvidence, type StatisticalObservation } from './discoveryEvidence';
import { mutateDiscoveryRuntime, type MutateRuntime } from './discoveryRuntime';
import { resolveDiscoveryProvider } from './providerRegistry';

export interface OnsOutcome extends CandidateBatch {
  status: 'ok' | 'partial' | 'insufficient_evidence' | 'unavailable' | 'not_configured';
  interpretationDependency?: string;
  diagnostics?: DatasetDiagnostic[];
  signals: number; errors: string[]; cached?: boolean;
}
/** Explicit supported periods only. Never guess ambiguous dates. End dates allow annual data a full reporting year. */
export function periodEnd(label: string): number | null {
  if (/^\d{4}$/.test(label)) return Date.UTC(Number(label), 11, 31);
  const quarter = /^(\d{4}) Q([1-4])$/.exec(label);
  if (quarter) return Date.UTC(+quarter[1], +quarter[2] * 3, 0);
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(label)) {
    const [y, m, d] = label.split('-').map(Number);
    if (m < 1 || m > 12 || (d !== undefined && (d < 1 || d > 31))) return null;
    if (d !== undefined && new Date(Date.UTC(y, m - 1, d)).getUTCMonth() !== m - 1) return null;
    return d ? Date.UTC(y, m - 1, d) : Date.UTC(y, m, 0);
  }
  if (/^[A-Za-z]{3}-\d{2,4}$/.test(label)) {
    const [month, year] = label.split('-');
    const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(month);
    const y = year.length === 2 ? 2000 + Number(year) : Number(year);
    return m < 0 ? null : Date.UTC(y, m + 1, 0);
  }
  return null;
}
export function compatibleSignal(a: StatisticalObservation, b: StatisticalObservation, now: number, maxAgeDays = 550): boolean {
  const dimensions = (o: StatisticalObservation) => JSON.stringify(Object.entries(o.dimensions).filter(([key]) => key !== 'time').sort());
  const cadence = (p: string) => /^\d{4}$/.test(p) ? 'year' : / Q[1-4]$/.test(p) ? 'quarter' : /^\d{4}-\d{2}-\d{2}$/.test(p) ? 'day' : 'month';
  return cadence(a.period) === cadence(b.period) && a.datasetId === b.datasetId && a.edition === b.edition && a.version === b.version &&
    a.unit === b.unit && !!a.unit && a.geography === b.geography && dimensions(a) === dimensions(b) &&
    Number.isFinite(a.value) && Number.isFinite(b.value) && a.value !== b.value &&
    Date.parse(b.periodEnd) > Date.parse(a.periodEnd) && Date.parse(b.periodEnd) <= now + 86400000 &&
    now - Date.parse(a.periodEnd) <= Math.min(maxAgeDays, cadence(a.period) === 'month' ? 120 : cadence(a.period) === 'quarter' ? 270 : cadence(a.period) === 'day' ? 30 : 550) * 86400000;
}
type Deps = { adapter: OnsAdapter; mutate: MutateRuntime; resolve: typeof resolveDiscoveryProvider; extract: typeof extractQualifiedGaps; now: () => number; shouldContinue: () => Promise<boolean> };
export async function discoverOns(deps: Partial<Deps> = {}): Promise<OnsOutcome> {
  const d: Deps = { adapter: new OnsAdapter(50, deps.shouldContinue), mutate: mutateDiscoveryRuntime, resolve: resolveDiscoveryProvider, extract: extractQualifiedGaps, now: Date.now, shouldContinue: async () => true, ...deps };
  const empty = (status: OnsOutcome['status'], errors: string[] = []): OnsOutcome => ({ status, gaps: [], candidates: 0, rejected: 0, signals: 0, errors });
  const errors: string[] = [];
  const diagnostics: DatasetDiagnostic[] = [];
  let assignmentRoute: AssignmentRoute | undefined;
  try {
    if (!await d.shouldContinue()) return empty('not_configured', ['Cycle stopped before ONS dispatch']);
    const cfg = await d.resolve('ons');
    if (!cfg.enabled) return empty('not_configured');
    assignmentRoute = cfg.route;
    const guard = await d.mutate('ons-health', state => state.openUntil > d.now() ? true : false);
    if (guard) return empty('unavailable', ['ONS circuit open']);
    // Search is an additional selector, never evidence that an opportunity exists.
    const [catalogue, searched] = await Promise.allSettled([
      d.adapter.listDatasets(), d.adapter.searchDatasets('business industry prices economy', 5),
    ]);
    if (catalogue.status === 'rejected' && searched.status === 'rejected') throw new Error('ONS catalogue unavailable');
    if (catalogue.status === 'fulfilled' && !Array.isArray(catalogue.value?.items) && searched.status === 'rejected') throw new Error('Malformed ONS catalogue');
    const discovered = searched.status === 'fulfilled' ? searched.value.flatMap(e => {
      const raw = e.raw as any;
      const id = raw?.id || /\/datasets\/([\w-]+)(?:\/|$)/.exec(raw?.links?.self?.href || '')?.[1];
      return id ? [{ id, title: e.title }] : [];
    }) : [];
    if (catalogue.status === 'fulfilled' && !Array.isArray(catalogue.value?.items) && !discovered.length) throw new Error('Malformed ONS catalogue');
    let items = catalogue.status === 'fulfilled' && Array.isArray(catalogue.value?.items) ? catalogue.value.items : [];
    // The live catalogue exceeds one page. Rotate bounded extra pages without exceeding the request budget.
    const total = catalogue.status === 'fulfilled' ? Number(catalogue.value?.total_count || items.length) : 0;
    if (total > items.length && items.length) {
      const pageSize = items.length;
      const pages = Math.ceil(total / pageSize);
      const start = await d.mutate('ons-catalogue-cursor', state => { const cursor = state.page || 1; state.page = 1 + ((cursor - 1 + 3) % (pages - 1)); return cursor; });
      for (let i = 0; i < Math.min(3, pages - 1); i++) {
        try {
          const page = await d.adapter.listDatasets(pageSize, (1 + ((start - 1 + i) % (pages - 1))) * pageSize);
          if (!Array.isArray(page.items)) throw new Error('Malformed catalogue page');
          items = [...items, ...page.items];
        } catch { errors.push('ONS catalogue page unavailable; continuing with retrieved datasets'); }
      }
    }
    const relevant = [...discovered, ...items.filter((x: any) => /business|industry|price|earning|employment|productivity|trade|output/i.test(`${x.title} ${x.description}`))];
    const catalogueCandidates = Array.from(new Map(relevant.filter((x: any) => /^[\w-]+$/.test(x.id)).map((x: any) => [x.id, x])).values());
    const all = catalogueCandidates.filter((item: any) => {
      const exclusion = DATASET_EXCLUSIONS[item.id];
      if (exclusion) { diagnostics.push({ datasetId: item.id, status: 'skipped', ...exclusion }); return false; }
      return true;
    });
    // Rotate across the catalogue on scheduled cycles instead of repeatedly using the first datasets.
    const offset = await d.mutate('ons-cursor', state => { const n = (state.offset || 0) % Math.max(1, all.length); state.offset = n + 2; return n; });
    const selected = [...all.slice(offset), ...all.slice(0, offset)].slice(0, 2);
    let signals = 0, candidates = 0, rejected = 0, usable = 0;
    const gaps: CandidateBatch['gaps'] = [];
    for (const item of selected) {
      if (!await d.shouldContinue()) break;
      let stage: DatasetReason = 'metadata_api_failed';
      try {
        assertDatasetEligible(item.id, null, d.now());
        const dataset = await d.adapter.getDataset(item.id);
        const link = dataset.links?.latest_version?.href;
        const match = typeof link === 'string' && /\/datasets\/([\w-]+)\/editions\/([^/]+)\/versions\/(\d+)$/.exec(link);
        if (!match || match[1] !== item.id || dataset.state !== 'published') throw new DatasetSkipped('dataset_unpublished', 'Published version metadata is unavailable.');
        const [, , edition, version] = match;
        const metadata = await d.adapter.getVersion(item.id, edition, version);
        assertDatasetEligible(item.id, metadata.release_date || dataset.last_updated, d.now(), cfg.config.maxAgeDays);
        if (!Array.isArray(metadata.dimensions) || !metadata.dimensions.length || metadata.dimensions.length > 8) throw new DatasetSkipped('missing_dimension_options', 'A bounded supported dimension list is required.');
        const dimensions: Record<string, string> = {};
        let times: string[] = [];
        stage = 'dimension_api_failed';
        for (const dim of metadata.dimensions) {
          if (typeof dim.name !== 'string') throw new DatasetSkipped('missing_dimension_options', 'Dimension name is missing.');
          const response = await d.adapter.getDimensionOptions(item.id, edition, version, dim.name);
          let options = response.items;
          if (!Array.isArray(options)) throw new DatasetSkipped('missing_dimension_options', 'Dimension options are missing.');
          if (dim.name === 'time') {
            // Refuse incomplete time lists: picking the last page without ordering would be unsafe.
            if (response.total_count > options.length && response.total_count <= 2000) {
              const page = await d.adapter.getDimensionOptions(item.id, edition, version, dim.name, options.length);
              options = [...options, ...(page.items || [])];
            }
            if (response.total_count > options.length) throw new DatasetSkipped('missing_dimension_options', 'Time option list exceeds bounded pagination.');
            times = Array.from(new Set<string>(options.map((o: any) => o.label).filter((s: any) => typeof s === 'string' && periodEnd(s) !== null)))
              .filter(t => periodEnd(t)! <= d.now() + 86400000).sort((a, b) => periodEnd(b)! - periodEnd(a)!);
          } else {
            const option = dim.name === 'geography' ? options.find((o: any) => ['K02000001','K03000001','E92000001'].includes(o.option)) || options.find((o: any) => supportedOnsGeography(o.option)) : options[0];
            if (!option || typeof option.option !== 'string') throw new DatasetSkipped(dim.name === 'geography' ? 'unsupported_geography' : 'missing_dimension_options', 'No supported option for dimension ' + dim.name + '.');
            dimensions[dim.name] = option.option;
          }
        }
        if (!dimensions.geography) throw new DatasetSkipped('unsupported_geography', 'A supported, consistent geography is required.');
        if (times.length < 2 || d.now() - periodEnd(times[1])! > Math.min(550, cfg.config.maxAgeDays || 550) * 86400000) throw new DatasetSkipped('insufficient_recent_observations', 'Two recent comparable observation periods are required.');
        stage = 'observation_api_failed';
        const evidence: DiscoveryEvidence[] = [];
        for (const period of times.slice(0, 2).reverse()) {
          const filters = { ...dimensions, time: period };
          const e = await d.adapter.getObservation({ datasetId: item.id, edition, version, dimensions: filters });
          const raw = e.raw as any;
          if (!Array.isArray(raw?.observations) || raw.observations.length !== 1) continue;
          const val = raw.observations[0].observation;
          if ((typeof val !== 'number' && typeof val !== 'string') || !Number.isFinite(Number(val)) || !/^-?\d+(\.\d+)?$/.test(String(val))) continue;
          if (raw.observations[0].metadata && Object.keys(raw.observations[0].metadata).length) continue; // Suppression/quality flags need dataset-specific handling.
          if (!raw.dimensions || Object.entries(filters).some(([name, value]) => raw.dimensions[name]?.option?.id !== value)) continue;
          const unit = raw.unit_of_measure;
          if (typeof unit !== 'string' || !unit.trim()) continue;
          const observation: StatisticalObservation = { datasetId: item.id, edition, version, dimensions: filters, period, periodEnd: new Date(periodEnd(period)!).toISOString(), geography: dimensions.geography, unit, value: Number(val) };
          evidence.push({ id: `${item.id}:${period}`, provider: 'ons', url: e.url, title: dataset.title || item.id,
            text: `Observed ${val} ${unit}; period ${period}; geography ${dimensions.geography}.`, retrievedAt: e.retrievedAt,
            geography: dimensions.geography, reportingPeriod: period, observation });
        }
        if (evidence.length !== 2) throw new DatasetSkipped('invalid_observation', 'Two unsuppressed finite observations with matching dimensions and units are required.');
        if (!compatibleSignal(evidence[0].observation!, evidence[1].observation!, d.now(), Math.min(550, cfg.config.maxAgeDays || 550))) {
          const recent = d.now() - Date.parse(evidence[0].observation!.periodEnd) <= 120 * 86400000;
          throw new DatasetSkipped(recent ? 'incompatible_observations' : 'insufficient_recent_observations', 'Observations do not satisfy cadence, recency, geography, unit and comparison requirements.');
        }
        usable++; signals++;
        // Descriptive context can support explicit operational facts, never a numerical claim.
        const text = [dataset.description, metadata.description].filter(x => typeof x === 'string').join('\n').slice(0, 8000);
        evidence.push({ id: `${item.id}:context`, provider: 'ons', url: `${d.adapter.baseUrl}/datasets/${item.id}`, title: dataset.title || item.id,
          text, retrievedAt: evidence[1].retrievedAt, publishedAt: metadata.release_date || dataset.last_updated,
          geography: dimensions.geography });
        const fingerprint = createHash('sha256').update(JSON.stringify({ observations: evidence.filter(e => e.observation).map(e => e.observation), text })).digest('hex');
        const previous = await d.mutate(`ons-dataset:${createHash('sha256').update(item.id).digest('hex')}`, state => state.fingerprint === fingerprint ? state.batch as CandidateBatch : null);
        let batch = previous;
        if (!batch) {
          if (!await d.shouldContinue()) break;
          stage = 'inference_failed';
          batch = await d.extract(evidence, `ons_statistics:${item.id}`);
          await d.mutate(`ons-dataset:${createHash('sha256').update(item.id).digest('hex')}`, state => Object.assign(state, { fingerprint, batch }));
        } else {
          // Refresh retrieval provenance only from an actual new/cached API retrieval; no repeated inference.
          batch = { ...batch, gaps: batch.gaps.map(g => ({ ...g, evidence: g.evidence.map(old => evidence.find(e => e.id === old.id) || old) })) };
        }
        gaps.push(...batch.gaps); candidates += batch.candidates; rejected += batch.rejected;
      } catch (error) {
        const skipped = error instanceof DatasetSkipped;
        const code = skipped ? error.code : stage === 'inference_failed' && error instanceof LLMRouterExhaustedError ? 'inference_provider_unavailable' : stage;
        const message = skipped ? error.message : stage === 'inference_failed' ? 'Statistical retrieval succeeded; the assigned inference provider could not interpret this evidence.' : 'ONS API request failed during ' + stage.replace('_api_failed', '') + '.';
        diagnostics.push({ datasetId: item.id, status: skipped ? 'skipped' : 'failed', code, message });
        if (!skipped) errors.push(`${item.id}: ${code} — ${message}`);
      }
    }
    if (errors.length && !usable && selected.length && diagnostics.filter(x => x.status === 'failed').length >= selected.length) {
      await d.mutate('ons-health', state => { state.openUntil = d.now() + 60000; });
      if (assignmentRoute) await recordAssignmentOutcome(assignmentRoute, 'metadata_api_failed');
      return { ...empty('unavailable', errors), diagnostics };
    }
    await d.mutate('ons-health', state => { state.openUntil = 0; state.failures = 0; });
    if (assignmentRoute) await recordAssignmentOutcome(assignmentRoute);
    return { status: errors.length ? 'partial' : usable ? 'ok' : 'insufficient_evidence', interpretationDependency: 'Statistical retrieval and signal detection require no LLM. Candidate interpretation requires an enabled inference provider and exact source support.', gaps, candidates, rejected, signals, errors, diagnostics };
  } catch {
    if (assignmentRoute) await recordAssignmentOutcome(assignmentRoute, 'metadata_api_failed').catch(() => {});
    await d.mutate('ons-health', state => { state.failures = (state.failures || 0) + 1; state.openUntil = d.now() + Math.min(3600000, 60000 * 2 ** Math.min(6, state.failures)); }).catch(() => {});
    return { ...empty('unavailable', errors.length ? errors : ['ONS configuration, catalogue or request guard unavailable']), diagnostics };
  }
}
