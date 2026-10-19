import { createHash } from 'node:crypto';
import { OnsAdapter } from './businessData';
import { extractQualifiedGaps, type CandidateBatch, type DiscoveryEvidence, type StatisticalObservation } from './discoveryEvidence';
import { mutateDiscoveryRuntime, type MutateRuntime } from './discoveryRuntime';
import { resolveDiscoveryProvider } from './providerRegistry';

export interface OnsOutcome extends CandidateBatch {
  status: 'ok' | 'insufficient_evidence' | 'unavailable' | 'not_configured';
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
type Deps = { adapter: OnsAdapter; mutate: MutateRuntime; resolve: typeof resolveDiscoveryProvider; extract: typeof extractQualifiedGaps; now: () => number };
export async function discoverOns(deps: Partial<Deps> = {}): Promise<OnsOutcome> {
  const d: Deps = { adapter: new OnsAdapter(50), mutate: mutateDiscoveryRuntime, resolve: resolveDiscoveryProvider, extract: extractQualifiedGaps, now: Date.now, ...deps };
  const empty = (status: OnsOutcome['status'], errors: string[] = []): OnsOutcome => ({ status, gaps: [], candidates: 0, rejected: 0, signals: 0, errors });
  const errors: string[] = [];
  try {
    const cfg = await d.resolve('ons');
    if (!cfg.enabled) return empty('not_configured');
    const guard = await d.mutate('ons-health', state => state.openUntil > d.now() ? true : false);
    if (guard) return empty('unavailable', ['ONS circuit open']);
    // Search is an additional selector, never evidence that an opportunity exists.
    const [catalogue, searched] = await Promise.allSettled([
      d.adapter.listDatasets(), d.adapter.searchDatasets('business industry prices economy', 5),
    ]);
    if (catalogue.status === 'rejected' && searched.status === 'rejected') throw new Error('ONS catalogue unavailable');
    const discovered = searched.status === 'fulfilled' ? searched.value.flatMap(e => {
      const raw = e.raw as any;
      const id = raw?.id || /\/datasets\/([\w-]+)(?:\/|$)/.exec(raw?.links?.self?.href || '')?.[1];
      return id ? [{ id, title: e.title }] : [];
    }) : [];
    const items = catalogue.status === 'fulfilled' && Array.isArray(catalogue.value?.items) ? catalogue.value.items : [];
    const relevant = [...discovered, ...items.filter((x: any) => /business|industry|price|earning|employment|productivity|trade|output/i.test(`${x.title} ${x.description}`))];
    const all = Array.from(new Map(relevant.filter((x: any) => /^[\w-]+$/.test(x.id)).map((x: any) => [x.id, x])).values());
    // Rotate across the catalogue on scheduled cycles instead of repeatedly using the first datasets.
    const offset = await d.mutate('ons-cursor', state => { const n = (state.offset || 0) % Math.max(1, all.length); state.offset = n + 2; return n; });
    const selected = [...all.slice(offset), ...all.slice(0, offset)].slice(0, 2);
    let signals = 0, candidates = 0, rejected = 0, usable = 0;
    const gaps: CandidateBatch['gaps'] = [];
    for (const item of selected) {
      try {
        const dataset = await d.adapter.getDataset(item.id);
        const link = dataset.links?.latest_version?.href;
        const match = typeof link === 'string' && /\/datasets\/([\w-]+)\/editions\/([^/]+)\/versions\/(\d+)$/.exec(link);
        if (!match || match[1] !== item.id || dataset.state !== 'published') { continue; }
        const [, , edition, version] = match;
        const metadata = await d.adapter.getVersion(item.id, edition, version);
        if (!Array.isArray(metadata.dimensions) || !metadata.dimensions.length || metadata.dimensions.length > 8) continue;
        const dimensions: Record<string, string> = {};
        let times: string[] = [];
        for (const dim of metadata.dimensions) {
          if (typeof dim.name !== 'string') throw new Error('Missing dimension name');
          const response = await d.adapter.getDimensionOptions(item.id, edition, version, dim.name);
          let options = response.items;
          if (!Array.isArray(options)) throw new Error('Missing dimension options');
          if (dim.name === 'time') {
            // Refuse incomplete time lists: picking the last page without ordering would be unsafe.
            if (response.total_count > options.length && response.total_count <= 2000) {
              const page = await d.adapter.getDimensionOptions(item.id, edition, version, dim.name, options.length);
              options = [...options, ...(page.items || [])];
            }
            if (response.total_count > options.length) throw new Error('Time option list exceeds bounded pagination');
            times = Array.from(new Set<string>(options.map((o: any) => o.label).filter((s: any) => typeof s === 'string' && periodEnd(s) !== null)))
              .filter(t => periodEnd(t)! <= d.now() + 86400000).sort((a, b) => periodEnd(b)! - periodEnd(a)!);
          } else {
            const option = dim.name === 'geography' ? options.find((o: any) => ['K02000001','K03000001','E92000001'].includes(o.option)) : options[0];
            if (!option || typeof option.option !== 'string') throw new Error('No supported dimension option');
            dimensions[dim.name] = option.option;
          }
        }
        if (!dimensions.geography || times.length < 2) continue;
        const evidence: DiscoveryEvidence[] = [];
        for (const period of times.slice(0, 2).reverse()) {
          const filters = { ...dimensions, time: period };
          const e = await d.adapter.getObservation({ datasetId: item.id, edition, version, dimensions: filters });
          const raw = e.raw as any;
          if (!Array.isArray(raw?.observations) || raw.observations.length !== 1) continue;
          const val = raw.observations[0].observation;
          if ((typeof val !== 'number' && typeof val !== 'string') || !/^-?\d+(\.\d+)?$/.test(String(val))) continue;
          if (raw.observations[0].metadata && Object.keys(raw.observations[0].metadata).length) continue; // Suppression/quality flags need dataset-specific handling.
          if (!raw.dimensions || Object.entries(filters).some(([name, value]) => raw.dimensions[name]?.option?.id !== value)) continue;
          const unit = raw.unit_of_measure;
          if (typeof unit !== 'string' || !unit.trim()) continue;
          const observation: StatisticalObservation = { datasetId: item.id, edition, version, dimensions: filters, period, periodEnd: new Date(periodEnd(period)!).toISOString(), geography: dimensions.geography, unit, value: Number(val) };
          evidence.push({ id: `${item.id}:${period}`, provider: 'ons', url: e.url, title: dataset.title || item.id,
            text: `Observed ${val} ${unit}; period ${period}; geography ${dimensions.geography}.`, retrievedAt: e.retrievedAt,
            geography: dimensions.geography, reportingPeriod: period, observation });
        }
        if (evidence.length !== 2 || !compatibleSignal(evidence[0].observation!, evidence[1].observation!, d.now(), Math.min(550, cfg.config.maxAgeDays || 550))) continue;
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
          batch = await d.extract(evidence, `ons_statistics:${item.id}`);
          await d.mutate(`ons-dataset:${createHash('sha256').update(item.id).digest('hex')}`, state => Object.assign(state, { fingerprint, batch }));
        } else {
          // Refresh retrieval provenance only from an actual new/cached API retrieval; no repeated inference.
          batch = { ...batch, gaps: batch.gaps.map(g => ({ ...g, evidence: g.evidence.map(old => evidence.find(e => e.id === old.id) || old) })) };
        }
        gaps.push(...batch.gaps); candidates += batch.candidates; rejected += batch.rejected;
      } catch { errors.push(`${item.id}: metadata, observations or interpretation unavailable`); }
    }
    if (errors.length && !usable && errors.length >= selected.length) throw new Error('ONS selected data unavailable');
    await d.mutate('ons-health', state => { state.openUntil = 0; state.failures = 0; });
    return { status: usable ? 'ok' : 'insufficient_evidence', gaps, candidates, rejected, signals, errors };
  } catch {
    await d.mutate('ons-health', state => { state.failures = (state.failures || 0) + 1; state.openUntil = d.now() + Math.min(3600000, 60000 * 2 ** Math.min(6, state.failures)); }).catch(() => {});
    return empty('unavailable', errors.length ? errors : ['ONS configuration, catalogue or request guard unavailable']);
  }
}
