# Provider assignment implementation results

## Delivered behavior

Providers now has a Manage Assignments dialog for each connection, including connections referenced from the environment. A user can assign Groq to inference and a compatible browser-search operation simultaneously, enable/disable or remove either assignment, select models, adjust priority/fallback, copy settings, restore defaults and save. Subsequent routing reads the saved configuration without redeployment. The existing credential connection is reused.

Section routing covers LLM, live search, ONS statistical discovery, ONS business context, Vercel and NOWPayments. Advertising retains its existing inference and mock-channel behavior; no new business workflow or live advertising adapter was invented. Compatibility and capability validation occur on the server. Search responses must supply real source evidence in the supported adapter response fields, and paid search remains subject to its separate existing authorization and account controls.

The obsolete ONS dataset is excluded before dataset-specific calls. Other ONS datasets and direct adapter access remain available. Release/observation recency, exact geography/dimension/unit comparisons and suppression validation remain strict. Structured dataset skip, API failure and inference failure diagnostics appear on the discovery dashboard. Historical evidence and business records are preserved.

## Persistence and security

Migration 0016 adds one assignments table and an assignment revision column to the existing credentials table. Composite keys prevent duplicate section assignments. Legacy routes are projected until first edited; an empty saved assignment set is durable. The startup runner and migration journal include the change.

Real disposable-database tests verify repeated migrations, upgrading a credential table without the new column, byte-for-byte preservation of encrypted credentials, unchanged connection configuration, real tRPC administrator authorization, transactional audit records, concurrent edit conflict detection, exact connection credential selection, shared cap reservations and preserved limits after edits. Assignment input cannot contain billing approval or credential fields. Neither assignment saves nor migration duplicate API keys. Guarded Tavily connectivity tests also respect search assignment, credit, circuit and billing controls. Native write operations avoid blind replay after ambiguous failure.

No production database was contacted or modified, and no production credentials were changed. No billable provider call, push or deployment was performed. External operations were mocked in tests. No local commit was created, so there is no new commit SHA.

## Verification results

| Check | Result |
| --- | --- |
| Full `npm test` regression suite, including new assignment and ONS unit tests | Passed |
| Assignment integration suite on disposable MariaDB | Passed |
| Existing discovery/runtime integration suite on disposable MariaDB | 16 scenarios passed |
| Existing lifecycle end-to-end suite | 48/48 stages passed |
| Existing policy database suite | Passed |
| Policy contracts unit suite | Passed |
| Frontend delivery/routing suite | Passed |
| Firefox discovery/provider/assignment browser suite | 9/9 tests passed |
| Server TypeScript check | Passed |
| Client TypeScript check | Passed |
| Production frontend build | Passed |
| `git diff --check` | Passed |
| Standalone linter | No lint script/configuration is defined in this repository |

Browser tests cover opening assignment controls, incompatible sections, multiple assignments, models, priorities, fallback order, request settings, copy/default actions, save, disable, removal and refresh persistence. The connection remains present throughout. Browser API responses are mocked; separate database tests exercise the real API and persistence implementation.

The existing build emits its Vite CommonJS deprecation notice. Node tests also emit the existing punycode deprecation notice. Neither is a failed check.

## Files changed

Frontend:

- `client/src/pages/dashboard/Providers.tsx`
- `client/src/pages/dashboard/ProviderAssignments.tsx` (new)
- `client/src/pages/dashboard/DiscoveryHealth.tsx`

API, routing and adapters:

- `shared/providerAssignments.ts` (new shared validation)
- `server/services/providerAssignments.ts` (new registry assignment/resolution layer)
- `server/services/providerRegistry.ts`
- `server/routers.ts`
- `server/services/llmRouter.ts`
- `server/services/llmProviders.ts`
- `server/services/llmTypes.ts`
- `server/services/webSearch.ts`
- `server/services/vercel.ts`
- `server/services/nowpayments.ts`
- `server/services/businessData.ts`
- `server/services/datasetEligibility.ts` (new)
- `server/services/onsDiscovery.ts`
- `server/services/discovery.ts`

Persistence and test commands:

- `drizzle/schema.ts`
- `drizzle/migrations/0016_provider_assignments.sql` (new)
- `drizzle/migrations/meta/_journal.json`
- `run-migration.js`
- `package.json`

Tests:

- `tests/provider-assignments.test.ts` (new)
- `tests/provider-assignments-db-isolated.test.ts` (new)
- `tests/ons-eligibility.test.ts` (new)
- `tests/browser/provider-assignments.spec.ts` (new)
- `tests/browser/discovery.spec.ts`
- `tests/business-data.test.ts` (injects the assignment boundary in its existing isolated adapter test)

Documentation:

- `docs/provider-assignments.md` (new workflow, routing, persistence and capability references)
- `docs/provider-assignment-rollout.md` (new exact build/migration/rollout and rollback procedure)
- `docs/provider-assignment-results.md` (this report)

## Remaining operational limits

Live provider credentials/account access were not tested; mocked successes do not prove live search access. Documented adapter operations and model contracts are checked again during dispatch and response validation. Providers/models outside implemented adapter contracts still require adapter support. Inference token/cost reservations retain the existing estimates; actual account-side billing limits remain necessary. Advanced caps/retries are exposed only where implemented, and ambiguous native write failures stay with existing reconciliation mechanisms.

The migration was tested on disposable MariaDB, not a restore of production or a certified exact production MySQL image. Rehearse on an authorized production-shaped backup and exact server/collation before rollout. Keep the additive schema on application rollback and review assignment-only restrictions before running an older application image.

See [provider-assignments.md](provider-assignments.md) for the user workflow and [provider-assignment-rollout.md](provider-assignment-rollout.md) for deployment steps. Deployment requires separate explicit authorization and has not been executed.
