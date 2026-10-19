import assert from 'node:assert/strict';
import { assignmentSchema, assignmentListSchema } from '../shared/providerAssignments';
import { validateAssignments, legacyAssignments, orderRoutes, reserveAssignment, recordAssignmentOutcome, getOfferings, type AssignmentRoute } from '../server/services/providerAssignments';
import { classifyError } from '../server/services/llmProviders';
import { memoryRuntime } from '../server/services/discoveryRuntime';
import { assertDatasetEligible, supportedOnsGeography } from '../server/services/datasetEligibility';

async function main() {
  assert.ok(!classifyError('groq', 'fixture-model', { status: 401, message: 'secret-must-never-escape' }).message.includes('secret-must-never-escape'));
  const inference = assignmentSchema.parse({ section: 'llm', operation: 'inference' });
  const search = assignmentSchema.parse({ section: 'search', operation: 'live_web_search', model: 'openai/gpt-oss-20b' });
  assert.equal(validateAssignments('groq', [inference, search]).length, 2);
  assert.throws(() => assignmentListSchema.parse([inference, inference]), /only one/);
  assert.throws(() => assignmentSchema.parse({ ...inference, section: 'LLM / AI Models' }));
  assert.throws(() => validateAssignments('cerebras', [search]), /Missing capability/);
  assert.throws(() => validateAssignments('groq', [{ ...search, model: 'ordinary-llm' }]), /not verified/);
  assert.throws(() => validateAssignments('groq', [{ ...search, settings: { billingApproved: true } }]));
  assert.throws(() => validateAssignments('groq', [{ ...search, settings: { retries: 2 } }]));
  assert.ok(getOfferings('ons').some(o => o.section === 'search' && o.operation === 'statistical_data'));
  assert.ok(!getOfferings('ons').some(o => o.operation === 'live_web_search'));
  assert.equal(legacyAssignments({ providerId: 'groq', service: 'llm', config: '{}' }).length, 1);
  assert.equal(legacyAssignments({ providerId: 'groq', service: 'llm', config: '{"discovery":{"enabled":true,"model":"openai/gpt-oss-20b"}}' }).length, 2);
  assert.ok(legacyAssignments({ providerId: 'groq', service: 'search' }).some(a => a.section === 'llm'));
  assert.ok(!legacyAssignments({ providerId: 'groq', service: 'search' }).some(a => a.section === 'search' && a.enabled));
  assert.ok(legacyAssignments({ providerId: 'tavily', service: 'llm' }).some(a => a.section === 'search' && a.enabled));
  const legacyOrder = ['groq', 'openrouter', 'tavily', 'gemini'].map(providerId => ({ providerId, assignment: legacyAssignments({ providerId, service: providerId === 'tavily' ? 'search' : 'llm', config: '{\"discovery\":{\"enabled\":true}}' }).find(a => a.section === 'search')! }));
  assert.deepEqual(legacyOrder.sort((a, b) => b.assignment.priority - a.assignment.priority).map(r => r.providerId), ['tavily', 'gemini', 'groq', 'openrouter']);
  assert.doesNotThrow(() => validateAssignments('openrouter', [{ ...search, model: 'existing-vendor/existing-model' }]));
  const route = (id: string, priority: number, fallbackOrder: number, settings = {}): AssignmentRoute => ({ connectionId: id, providerId: 'groq', assignment: { ...inference, priority, fallbackOrder, settings }, config: {}, revision: '1', connectionStatus: 'untested' });
  assert.deepEqual(orderRoutes([route('last', 1, 0), route('second', 10, 2), route('first', 10, 1)]).map(r => r.connectionId), ['first', 'second', 'last']);
  for (const [settings, cost, tokens, expected] of [
    [{ maxRequestsPerDay: 1 }, 0, 0, 'daily_request_limit'], [{ maxRequestsPerMinute: 1 }, 0, 0, 'minute_request_limit'],
    [{ maxTokensPerDay: 15 }, 0, 10, 'daily_token_limit'], [{ dailyBudgetUsd: 0.15 }, 0.1, 0, 'daily_spending_limit'],
  ] as const) {
    const r = route('limited', 1, 0, settings), mutate = memoryRuntime();
    assert.equal(await reserveAssignment(r, cost, tokens, mutate), null);
    assert.equal(await reserveAssignment(r, cost, tokens, mutate), expected);
  }
  const mutate = memoryRuntime(), r = route('circuit', 1, 0);
  await recordAssignmentOutcome(r, 'auth_failure', mutate);
  assert.match((await reserveAssignment(r, 0, 0, mutate))!, /circuit_open/);
  await recordAssignmentOutcome(r, undefined, mutate);
  assert.equal(await reserveAssignment(r, 0, 0, mutate), null);
  assert.equal(await reserveAssignment(route('zero', 1, 0, { maxRequestsPerDay: 0 }), 0, 0, memoryRuntime()), 'daily_request_limit');
  assert.equal(await reserveAssignment(route('cost', 1, 0, { maxRequestCostUsd: 0.1 }), 0.2, 0, memoryRuntime()), 'request_spending_limit');
  assert.throws(() => assertDatasetEligible('house-prices-local-authority', null, Date.now()), /September 2022/);
  assert.throws(() => assertDatasetEligible('retail', '2022-09-01', Date.now()), /age limit/);
  assert.doesNotThrow(() => assertDatasetEligible('retail', new Date().toISOString(), Date.now()));
  assert.equal(supportedOnsGeography('E06000001'), true); assert.equal(supportedOnsGeography('W06000001'), true);
  assert.equal(supportedOnsGeography('invented-area'), false);
  console.log('PASS assignment validation, multi-section compatibility, legacy defaults, ordering, durable caps, circuits and dataset eligibility (mocked, no network).');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
