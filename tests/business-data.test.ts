import assert from 'assert';
import {
  OnsAdapter,
  collectBusinessEvidenceForGap,
  formatEvidenceForPrompt,
} from '../server/services/businessData';

const originalFetch = global.fetch;
let fetchCount = 0;

function makeResponse(body: any, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] || headers[name] || null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function main() {
  fetchCount = 0;

  global.fetch = (async (input: any) => {
    const url = String(input);
    fetchCount++;

    if (url.includes('api.beta.ons.gov.uk/v1/search')) {
      return makeResponse({
        items: [{
          title: 'Business insights and impact on the UK economy',
          uri: '/businessindustryandtrade/business/businessinnovation/datasets/businessinsightsandimpactontheukeconomy',
          summary: 'Business conditions dataset.',
        }],
      }) as any;
    }

    if (url.includes('/datasets/cpih01/editions/time-series/versions/6/observations')) {
      return makeResponse({
        unit_of_measure: 'Index: 2015=100',
        observations: [{ observation: '105.1' }],
      }) as any;
    }

    return makeResponse({ error: 'unexpected url', url }, 404) as any;
  }) as any;

  const adapter = new OnsAdapter();
  const datasets = await adapter.searchDatasets('business economy');
  assert.strictEqual(datasets.length, 1);
  assert.strictEqual(datasets[0].provider, 'ons');
  assert.strictEqual(datasets[0].source, 'Office for National Statistics API');
  assert.ok(datasets[0].url.includes('ons.gov.uk'));
  assert.ok(datasets[0].retrievedAt);
  assert.ok(datasets[0].caveats.some((c) => /supporting macro evidence/i.test(c)));

  const cached = await adapter.searchDatasets('business economy');
  assert.strictEqual(cached.length, 1);
  assert.strictEqual(fetchCount, 1, 'ONS search results are cached for repeated identical requests');

  const observation = await adapter.getObservation({
    datasetId: 'cpih01',
    edition: 'time-series',
    version: 6,
    dimensions: {
      time: 'Mar-18',
      geography: 'K02000001',
      aggregate: 'cpih1dim1A0',
    },
  });
  assert.strictEqual(observation.provider, 'ons');
  assert.strictEqual(observation.reportingPeriod, 'Mar-18');
  assert.strictEqual(observation.geography, 'K02000001');
  assert.ok(observation.summary.includes('1 observation'));

  const bundle = await collectBusinessEvidenceForGap({
    knows: 'software consultants',
    needs: 'small business automation',
    controlsAccess: 'industry data',
    underestimatesValue: 'manual processes',
  });
  assert.strictEqual(bundle.unavailable.length, 0);
  assert.ok(bundle.evidence.length >= 1);
  assert.ok(bundle.evidence.every((item) => item.provider === 'ons'));

  const promptEvidence = formatEvidenceForPrompt(bundle);
  assert.ok(promptEvidence.includes('Office for National Statistics API'));
  assert.ok(promptEvidence.includes('Caveats:'));
  assert.ok(promptEvidence.includes('Retrieved:'));

  console.log('ONS business-data mocked adapter tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
  });
