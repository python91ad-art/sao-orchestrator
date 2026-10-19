# Provider assignments and ONS dataset eligibility

## User workflow

1. Open **Providers** and choose **Manage Assignments** beside a connection.
2. Check each compatible section. Leave existing assignments checked to keep using the connection in those sections.
3. Enable or disable individual assignments and set their priorities. Higher numbers run first.
4. Optionally expand Advanced settings to select an operation-specific model, set fallback order, request/token/spending caps, timeout or search retries. Copy applicable settings or restore defaults when useful.
5. Choose **Save Assignments**. Subsequent requests resolve the saved assignments immediately; no application redeployment is needed for assignment edits.

Unchecking a section removes only that assignment. Disabling an assignment retains its settings. Neither action changes the encrypted credential or other assignments. The separate Delete Provider action still removes a connection and all its assignments.

The dialog displays connection state, adapter capabilities, section compatibility and runtime success/failure diagnostics. Unsupported sections are disabled with an explanation. Available operations come from executable adapters; arbitrary custom keys cannot become executable adapters through configuration.

Environment connections appear in Providers when no stored connection exists for the adapter. Saving their assignments creates a connection containing an encrypted empty value and an environment reference, never a copy of the environment secret. Use Manage Assignments once before editing/testing such a virtual connection. Existing disabled connection records suppress creation of an enabled virtual environment connection.

### Groq example

Keep **LLM / AI Models** checked and also check **Search / Gap Finder**. The search assignment uses the browser-search operation and a supported GPT OSS model; the inference assignment continues using the existing model registry or its separately selected model. A new search assignment does **not** approve paid search. Explicit billing approval, a confirmed provider account cap and positive request/budget/cost limits must already be configured through the existing Edit Provider controls. Otherwise the search attempt reports `billing_blocked`.

Legacy Discovery settings in Edit Provider remain connection billing controls and defaults for installations whose assignments have never been edited. After saving Manage Assignments, use that dialog to control section membership and model selection. Connection billing controls still apply independently.

## Runtime behavior

`server/services/providerAssignments.ts` extends the existing registry. Stable section IDs reuse `llm`, `search`, `business_data`, `deployment`, `payments`, and `advertising`. Operations distinguish `inference`, `live_web_search`, `statistical_data`, `deploy`, and `payment`.

- Inference uses `llm` assignments and then retains existing task capabilities, JSON support, reasoning requirements, model availability, context/output/throughput checks, cooldowns and bounded model rotation. The exact selected connection's credential is scoped to the existing adapter using AsyncLocalStorage. Its credential cannot accidentally come from another connection for the same adapter.
- Web search uses only `search` assignments with `live_web_search`. Assignment priority sorts descending and fallback order ascending. Connection authorization, provider-wide credit/spend counters, durable circuits and strict source normalization remain authoritative. Failed and retried dispatches reserve usage. A real zero-result search ends fallback successfully; unavailable discovery stays unavailable.
- ONS discovery uses `search` with `statistical_data`; business-context collection independently uses `business_data` with `statistical_data`. Statistical retrieval does not imply live web search or inference capability.
- Vercel and NOWPayments resolve their native sections and record assignment health. Explicit authentication/rate rejections can fall back to another eligible connection. Ambiguous network or server failures in write operations are returned for the existing business reconciliation/retry mechanisms; the assignment layer does not replay a potentially completed write. Existing release, payment, policy and approval gates remain in place.
- Advertising currently has no executable external provider registered in this registry. Its AI work continues through existing LLM task capabilities. This change does not turn existing mock advertising channels into live integrations.

Assignment limits are additional restrictions. Durable per-connection/section reservations use the existing transactional operational settings store. Daily limits use UTC; minute limits use UTC minute windows. Removing/readding an assignment or changing priority does not reset counters. Inference token and cost reservations use bounded requested output and the existing model cost estimates; account-side hard spending caps remain necessary for actual billing. Connection search authorization cannot be increased through assignment settings. Native deployment/payment advanced caps are not offered because those adapters use their existing business controls.

The resolver is read on dispatch; no routing cache requires redeployment. In-flight requests may finish under the configuration they resolved before an edit. Atomic saves lock the connection, reject duplicate sections and use optimistic revisions to prevent overwriting another administrator's changes. Both a credential audit entry and a detailed operational event with actor and before/after assignment settings commit with the change. These records contain no credentials. Provider error response bodies are not exposed in provider diagnostics. Tavily connection tests use the same guarded search path, with fallback restricted to the tested connection; they cannot bypass assignment, quota or billing controls.

## Capability verification and limits

Search support is an explicit adapter operation, not inferred from LLM access. The Groq model allowlist and browser tool request match [Groq's browser search documentation](https://console.groq.com/docs/tool-use/built-in-tools/browser-search). Gemini grounding uses the separate [Google Search grounding operation](https://ai.google.dev/gemini-api/docs/google-search/). OpenRouter uses the explicit [Exa web plugin and citation annotations](https://openrouter.ai/docs/guides/features/plugins/web-search); existing syntactically valid plugin model configurations remain supported, with actual model availability checked by execution. These contracts were reviewed during implementation; no live account capability probe or paid search was performed.

Each search response still must contain usable provider-attributed source evidence: Tavily result content, Gemini grounding chunks/supports, Groq executed browser tools with source content, or OpenRouter extractive URL annotations. Plain completion text and unsupported/citation-only responses fail validation. Provider/model/account availability can change; a documented adapter contract is not a claim that a particular live account currently has access. Existing registered inference models remain the selectable inference models, with existing environment overrides retained. Additional provider adapters or newly supported model contracts still require adapter work.

## ONS eligibility and diagnostics

`server/services/datasetEligibility.ts` centrally excludes `house-prices-local-authority` from **new active discovery** because the identified release is September 2022. The catalogue is filtered before dataset-specific requests and selection, so this obsolete dataset cannot consume a discovery slot or an interpretation call. Direct adapter access, other datasets, historical references, existing opportunities and stored evidence are unchanged.

Additional eligibility checks reject outdated published releases, unpublished versions, missing/unsupported dimensions and geography, and insufficient recent periods before observation/inference work when possible. Supported national codes retain preference; recognized ONS local-authority codes are usable when national observations are absent. Both comparison observations must still use the exact same geography, dataset, edition, version, unit, cadence and other dimensions. Suppression/quality flags, missing/non-finite values and dimension mismatches remain rejected. Existing cadence-specific recency windows and all downstream evidence, source independence and legal gates remain intact.

The durable discovery report and dashboard now show structured `{datasetId,status,code,message}` diagnostics. `skipped` is an eligibility outcome, distinct from `failed` API/inference work. Codes include `dataset_outdated`, `unsupported_geography`, `missing_dimension_options`, `invalid_observation`, `insufficient_recent_observations`, `incompatible_observations`, `inference_provider_unavailable`, `inference_failed`, and stage-specific API failures. Eligibility skips do not open the ONS API circuit or falsely imply an API outage. A legitimate completed cycle can produce zero qualified opportunities.

## Persistence and compatibility

Migration **0016_provider_assignments.sql** adds:

- `provider_assignments`, with a composite primary key `(connection_id, section)` and an index on section/enabled.
- `integration_credentials.assignment_version`, initially zero, used both as the migration marker and an incrementing edit revision.

The migration is journaled and included in `run-migration.js`, the application's existing startup migration path. Table creation and conditional column addition are idempotent. No existing key/configuration is rewritten by schema migration. There is no foreign key across potentially differing legacy credential-table collations; connection deletion explicitly removes assignments under the same connection lock and transaction.

For version-zero connections the resolver projects legacy routes without rewriting production credentials/configuration. Existing search fallback order (Tavily, Gemini, Groq, OpenRouter), inference provider/model priorities and disabled discovery flags remain effective. ONS retains both its statistical discovery and business-data functions. The first assignment save atomically persists the replacement set and increments the marker. An intentionally empty replacement remains empty through startup and later migrations. Existing encrypted bytes and encryption version stay untouched. New native provider records also receive their prior implicit behavior until edited.

## Validation

Commands executed locally with mocked external provider boundaries and disposable MariaDB instances:

```sh
# Unit/regression tests: disable loading the workspace's production-related .env.
DOTENV_CONFIG_PATH=/dev/null DATABASE_URL='' DB_HOST=127.0.0.1 DB_PORT=1 \
  DB_USER=sao_test DB_PASSWORD='' DB_NAME=isolated_unavailable NODE_ENV=test npm test

node --import tsx tests/provider-assignments-db-isolated.test.ts
node --import tsx tests/discovery-db-isolated.test.ts
node --import tsx tests/policy-db-isolated.test.ts
node --import tsx tests/e2e-isolated.test.ts
node_modules/.bin/tsc --noEmit -p server/tsconfig.json
node_modules/.bin/tsc --noEmit -p client/tsconfig.json
npm run build
node_modules/.bin/playwright test tests/browser/provider-assignments.spec.ts tests/browser/discovery.spec.ts
git diff --check
```

`test:assignments` is also available in package.json for the focused assignment/ONS tests. The repository has no configured standalone lint command; both TypeScript projects and whitespace checks were run. Browser responses are mocked; persistence/authorization/routing/concurrency tests execute real application services against disposable databases. These checks do not certify live provider account access or real market opportunities.

See [provider-assignment-rollout.md](provider-assignment-rollout.md) for the separately authorized production rollout procedure.
