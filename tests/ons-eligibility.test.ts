import assert from 'node:assert/strict';
import { discoverOns } from '../server/services/onsDiscovery';
import { memoryRuntime } from '../server/services/discoveryRuntime';
import { LLMRouterExhaustedError } from '../server/services/llmTypes';

async function main() {
  const now = Date.UTC(2026, 9, 19), dates = ['2026-08', '2026-09'];
  let mode = 'valid', requests: string[] = [], inference = 0;
  const adapter: any = {
    baseUrl: 'https://api.beta.ons.gov.uk/v1',
    listDatasets: async () => ({ items: mode === 'excluded-only' ? [{ id: 'house-prices-local-authority', title: 'House prices' }] : [{ id: 'house-prices-local-authority', title: 'House prices' }, { id: 'retail', title: 'Business industry' }] }),
    searchDatasets: async () => [],
    getDataset: async (id: string) => { requests.push(`dataset:${id}`); if (mode === 'api') throw new Error('secret-must-not-escape'); return { state: 'published', links: { latest_version: { href: `https://api.beta.ons.gov.uk/v1/datasets/${id}/editions/series/versions/1` } } }; },
    getVersion: async () => ({ release_date: mode === 'outdated' ? '2022-09-01' : '2026-10-01', dimensions: [{ name: 'time' }, { name: 'geography' }] }),
    getDimensionOptions: async (_id: string, _e: string, _v: string, dim: string) => {
      requests.push(`dimension:${dim}`);
      return dim === 'time' ? { items: (mode === 'old-observations' ? ['2022-08', '2022-09'] : dates).map(label => ({ label, option: label })) } : { items: mode === 'missing' ? null : [{ option: mode === 'geography' ? 'unverified-geography' : 'E06000001' }] };
    },
    getObservation: async ({ dimensions }: any) => {
      requests.push('observation');
      return { url: 'https://api.beta.ons.gov.uk/v1/datasets/retail', retrievedAt: new Date(now).toISOString(), raw: {
        unit_of_measure: 'GBP', dimensions: Object.fromEntries(Object.entries(dimensions).map(([k, id]) => [k, { option: { id } }])),
        observations: [{ observation: mode === 'invalid' ? '..' : dimensions.time === dates[0] ? '100' : '120', ...(mode === 'suppressed' ? { metadata: { quality: 'suppressed' } } : {}) }],
      } };
    },
  };
  const run = () => { requests = []; return discoverOns({ adapter, mutate: memoryRuntime(), now: () => now,
    resolve: async () => ({ enabled: true, key: null, config: {}, revision: '1' }),
    extract: async evidence => { inference++; if (mode === 'inference-unavailable') throw new LLMRouterExhaustedError('ANALYSIS', []); if (mode === 'inference-failed') throw new Error('secret-must-not-escape'); assert.ok(evidence.filter(e => e.observation).every(e => e.geography === 'E06000001')); return { gaps: [], candidates: 0, rejected: 0 }; },
  }); };
  const initial = await run();
  assert.equal(initial.status, 'ok'); assert.equal(initial.signals, 1); assert.equal(initial.gaps.length, 0);
  assert.ok(initial.diagnostics?.some(d => d.datasetId === 'house-prices-local-authority' && d.status === 'skipped' && d.code === 'dataset_outdated'));
  assert.ok(!requests.includes('dataset:house-prices-local-authority')); assert.ok(requests.includes('dataset:retail'));
  mode = 'excluded-only'; const beforeExcluded = inference; const excluded = await run();
  assert.equal(excluded.status, 'insufficient_evidence'); assert.equal(excluded.gaps.length, 0); assert.equal(inference, beforeExcluded); assert.deepEqual(requests, []);
  for (const [scenario, code] of [['outdated', 'dataset_outdated'], ['old-observations', 'insufficient_recent_observations'], ['geography', 'unsupported_geography'], ['missing', 'missing_dimension_options'], ['invalid', 'invalid_observation'], ['suppressed', 'invalid_observation']]) {
    mode = scenario; const before = inference; const result = await run();
    assert.equal(result.status, 'insufficient_evidence'); assert.equal(result.signals, 0); assert.equal(inference, before);
    assert.ok(result.diagnostics?.some(d => d.datasetId === 'retail' && d.code === code && d.status === 'skipped'), scenario);
    assert.deepEqual(result.errors, []);
    if (['outdated', 'old-observations', 'geography', 'missing'].includes(mode)) assert.ok(!requests.includes('observation'));
  }
  for (const [scenario, code] of [['inference-unavailable', 'inference_provider_unavailable'], ['inference-failed', 'inference_failed'], ['api', 'metadata_api_failed']]) {
    mode = scenario; const result = await run();
    assert.equal(result.status, scenario === 'api' ? 'unavailable' : 'partial');
    assert.ok(result.diagnostics?.some(d => d.datasetId === 'retail' && d.code === code && d.status === 'failed'));
    assert.ok(!JSON.stringify(result).includes('secret-must-not-escape'));
  }
  console.log('PASS obsolete dataset excluded before dispatch; other datasets and local authorities supported; release and observation recency, suppression, geography, empty results and precise safe API/inference diagnostics.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
