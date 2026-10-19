# SAO multi-source discovery implementation

Implemented locally, 19 October 2026. No push, deployment, production database mutation, credential change, billing enablement or historical-record rewrite was performed.

## Audit and design

The previous `search.ts` converted provider failures into empty successes. Both automatic detectors relied on Tavily; ONS supplied only catalogue descriptions during web extraction and later research. Existing LLM adapters implement inference rather than search. The credential registry already encrypts secrets, the evidence store already supports observation/citation metadata, the discovery maintenance lock already serializes writes, and queue/worker policy enforcement already exists.

The changes retain those components. Independent ONS and web tasks settle concurrently. E-commerce and operational query categories remain. Validated discoveries use the existing `scoreGap` qualification threshold, source-independent deduplication, existing queue insertion and the existing workers. Legal review, independent source review, QC, approval and deployment policies remain authoritative. Discovery cannot mark its own evidence independently reviewed or legal.

## Implemented behavior

- ONS selects relevant catalogue/search entries, resolves each dataset's published latest edition/version, enumerates available dimension options and requests two actual numerical observations. It compares matching units, geography and non-time dimensions, rejects missing/suppressed/incomparable/stale values, then interprets the statistical signal through the existing LLM facade. Descriptions alone cannot create a candidate.
- ONS retains dataset ID, edition, version, dimensions, period, geography, units, values, API URL and actual retrieval timestamp. Cached responses retain their original retrieval time. Unchanged observations and context reuse durable interpretations without repeated LLM calls.
- Search tries Tavily, Gemini grounding, Groq browser search and OpenRouter search in that order. It stops on an actual success, including a provable empty tool result. Missing, disabled, unsupported and unapproved providers are skipped. Ordinary completions and citation-only content without attributable evidence are rejected.
- Search outcomes distinguish results, zero results, missing configuration, quota exhaustion, throttling, authentication failure, timeout, unavailability, malformed/ungrounded response, unsupported capability and billing restrictions.
- Search uses bounded retries, timeouts, serialized requests, duplicate-query coalescing, a bounded waiting queue, persistent request/spend reservations and persistent circuit breakers. Tavily 432 and 433 stop repeated calls; quota cooldown is 24 hours or an explicit credential/configuration change. Daily and monthly local limits remain in force across configuration changes.
- Discovery has an in-process overlap guard and a durable cross-process lease. One engine's failure does not cancel the other or existing queue processing. Runtime/persistence errors are explicit failures.
- All four situational-arbitrage fields require literal supporting quotations. Problem, affected audience and geography require source references. Numerical AI claims must match observations. Proposed solutions remain labeled hypotheses. Required fields are never filled with invented gatekeepers or demand.
- Evidence and validation metadata persist before queue insertion, using the existing `evidence_records` table. The classifier and plan generator receive stored discovery evidence alongside the existing ONS research bundle. Evidence stays `collected`, pending the existing reliability/legal review.
- New identity hashes exclude source, and normalized field matching also recognizes legacy source-specific hashes. Identical problems can accumulate evidence without a second gap or queue entry. Existing histories, statuses, archived candidates and completed work are preserved. Interrupted new insertions can resume safely.
- Overview reports engine states, active web provider, fallback reasons, candidate/validation/rejection/queue counts, provider errors, restrictions and last successful/failed cycle. Providers exposes independent discovery configuration and paid-search opt-in.

No schema migration is needed: observations/citations use existing evidence metadata, and counters/circuits/leases use namespaced rows in the existing operational settings table. Their real persistence and locking were tested on a disposable database before use.

## Verified API contracts and configuration

Verification here means official API documentation plus mocked contract tests, not successful paid live searches.

| Provider | Implemented search contract | Evidence accepted | Configuration and billing |
| --- | --- | --- | --- |
| ONS | Existing public Dataset API: catalogue/search, dataset, version, dimension options and observations | Actual numerical observations and dated, explicit context; never catalogue descriptions alone | No API key. Existing Providers enable flag respected. Two datasets per cycle, bounded request budget, one-hour response cache. |
| Tavily | `POST https://api.tavily.com/search`, bearer authentication, explicit Basic depth, no automatic parameter upgrade | `results` URL/title/content and estimated publication/update date | Existing credential registry or environment key. Default 50 attempts per UTC day and 900 reserved Basic credits per UTC month; configurable. Basic depth consumes one credit per attempted request reservation. Existing account billing settings still govern the account. |
| Gemini | Native `v1beta/models/{model}:generateContent` with `google_search`; separate from its OpenAI-compatible inference adapter | `groundingMetadata`, web search queries, chunks and supported text segments, including search-suggestion attribution | Model allowlist: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.8-flash`. Requires explicit enablement, approved costs, daily request cap, daily USD reservation budget, conservative per-request USD ceiling and confirmation of a provider-account hard spend cap. |
| Groq | `POST https://api.groq.com/openai/v1/chat/completions`, `tools:[{type:"browser_search"}]`, required tool use, bounded completion tokens | Official SDK `executed_tools` browser/search results with URL and actual content; ordinary answer text is ignored | Allowlisted GPT-OSS 20B, 120B and Safeguard 20B browser-search models only. Same paid-search controls as Gemini. Regional/sovereign unsupported endpoints are not used. |
| OpenRouter | `POST https://openrouter.ai/api/v1/chat/completions`, explicit web plugin with Exa and bounded result count | `url_citation` annotations with extractive source content; uncited answer text is ignored | Explicit provider/model configuration and the same paid-search controls. Uses OpenRouter credits, including search and inference charges. No separate Exa account is added. |

Official sources checked:

- [ONS observation API and time labels](https://developer.ons.gov.uk/cmdobservations/) and [dimension options](https://developer.ons.gov.uk/dataset/datasets-id-editions-edition-versions-version-dimensions-dimension-options/).
- [Tavily request/authentication/date/error contract](https://docs.tavily.com/documentation/api-reference/endpoint/search), [credit costs](https://docs.tavily.com/documentation/api-credits), [rate limits](https://docs.tavily.com/documentation/rate-limits).
- [Gemini Generate Content grounding and citations](https://ai.google.dev/gemini-api/docs/generate-content/google-search), [pricing](https://ai.google.dev/gemini-api/docs/pricing).
- [Groq supported browser-search models and request](https://console.groq.com/docs/tool-use/built-in-tools/browser-search), [official SDK response types](https://github.com/groq/groq-typescript/blob/main/src/resources/chat/completions.ts), [rate limits](https://console.groq.com/docs/rate-limits). Groq's linked pricing page redirected to its homepage during verification, so no fixed browser-search price is asserted; confirm account/tool pricing before approval.
- [OpenRouter search plugin, citation content and pricing](https://openrouter.ai/docs/guides/features/plugins/web-search).

Rate limits, model access and billing eligibility depend on the provider account. The implementation handles 429 and Retry-After without assuming a universal account quota. Paid fallbacks default to disabled even when inference credentials already exist. No fallback billing approval was enabled during implementation.

Configure an existing provider's **Discovery settings** in Providers. LLM priority/routing remains separate. Example nested configuration, for review only:

```json
{
  "discovery": {
    "enabled": false,
    "model": "gemini-2.5-flash",
    "billingApproved": false,
    "accountSpendLimitConfirmed": false,
    "maxRequestsPerDay": 20,
    "dailyBudgetUsd": 0,
    "maxRequestCostUsd": 0
  }
}
```

The application reserves the configured conservative maximum before every potentially billable attempt, including retries; failed requests do not refund that reservation. These are local reservation ceilings, not authoritative provider invoices. Tool-using models can execute multiple internal operations. A real provider-account cap and an adequately conservative reservation are required before enabling paid fallbacks. SAO does not purchase credits or enable pay-as-you-go.

## Validation performed

All new external-provider tests use mocked responses. Database tests use disposable local MariaDB instances.

| Check | Result |
| --- | --- |
| Server and new tests TypeScript check (`tsc --noEmit`, ES2022/CommonJS/node resolution, esModuleInterop, skipLibCheck) | Passed |
| Existing strict client TypeScript project | Passed |
| Production client build | Passed |
| Existing `pnpm test` regression chain, including new discovery tests | Passed |
| New mocked discovery scenarios | 30 passed |
| New real database discovery scenarios | 7 passed |
| Existing isolated lifecycle suite | 48/48 stages passed |
| Existing isolated policy/database suite | Passed |
| Full Firefox suite, including three discovery status cases | 14 passed |
| Final targeted Firefox discovery and provider-editor suite | 4 passed (includes explicit paid-search opt-in and preservation of existing inference configuration) |
| Whitespace/diff check | Passed |

Coverage includes numerical ONS discovery, metadata-only/missing/old/incompatible observations, unsupported AI claims, source preservation, every fallback transition, 432 exhaustion, genuine empty results, ungrounded responses, bounded retries/timeouts/circuits, billing/request/credit limits, concurrent query sharing, engine failure isolation, cross-source identity, legacy histories, actual evidence/queue persistence, disabled credential fallback and durable concurrent counters.

Sandbox restrictions initially prevented local database sockets and the browser preview server. Those suites were rerun with permission and passed. No production deployment was exercised: lifecycle/provider deployment boundaries in tests are mocked.

## Remaining limits and deployment readiness

- Live ONS reads from this environment returned **HTTP 403**, including after the sandbox DNS restriction was removed. Official documentation and mocked numerical responses verify the implemented contract, but live ONS discovery is not verified. Confirm ONS access from the intended server before relying on it.
- No paid live Tavily/Gemini/Groq/OpenRouter discovery requests were made. Real credentials, model access, tool response availability, pricing and account caps require an owner-approved live check. Existing inference connectivity is not a search capability check.
- This bounded ONS implementation covers a relevant slice of the first catalogue page, two datasets per cycle, one available industry/geography selection per dataset and time comparisons. It rotates datasets. Census bulk endpoints, full-catalogue traversal, broad regional/industry sweeps, unusual period formats, suppressed observations and quality-flag interpretation are deliberately not implemented; unsupported data is rejected.
- Missing required business facts produce no opportunity. Most macro series will produce statistical signals without qualified arbitrage candidates. Demand, access control and value inefficiency still require explicit dated evidence. Web evidence without a usable date is rejected. Tavily publication/update dates are provider estimates and still require source review.
- Deduplication merges identical normalized problem fields. It does not attempt speculative semantic merging of differently worded problems. Legacy lookup performs a normalized field scan; large histories may warrant an additive indexed identity table in a separate reviewed change.
- ONS cache/interpretation timestamps and source assertions do not independently establish source reliability. Existing review and lifecycle policies still apply.
- A crashed discovery process releases its lease through expiry (30 minutes). Cross-process API budgets/circuits are durable; each process also serializes web requests.

The implementation is locally testable and reviewable. **Do not treat production discovery as verified or deploy automatically.** Resolve live ONS access, review the provider/cost configuration and obtain explicit deployment approval. No GitHub push or Northflank deployment has been performed.

## Files changed

Existing files:

- `server/orchestrator.ts`: independent discovery stage, existing queue/worker continuation, downstream stored evidence.
- `server/services/search.ts`: preserved public detectors/search interface and metrics; routed search and shared validation.
- `server/services/businessData.ts`: bounded ONS metadata/dimension access, caching timestamps and rate/circuit behavior.
- `server/services/providerRegistry.ts`: independent secure discovery resolution and validated configuration.
- `server/services/infrastructure.ts`: original retrieval timestamp support and stored evidence prompt formatting.
- `server/routers.ts`: unified manual search persistence and extended diagnostics.
- `client/src/pages/dashboard/Overview.tsx`: existing dashboard health card integration.
- `client/src/pages/dashboard/Providers.tsx`: independent discovery enablement, models and cost/request controls.
- `package.json`: discovery unit/isolated-DB scripts and regression-chain integration.

Added files:

- `server/services/onsDiscovery.ts`
- `server/services/webSearch.ts`
- `server/services/discoveryEvidence.ts`
- `server/services/discoveryRuntime.ts`
- `server/services/discovery.ts`
- `server/services/discoveryQueue.ts`
- `client/src/pages/dashboard/DiscoveryHealth.tsx`
- `tests/discovery.test.ts`
- `tests/discovery-db-isolated.test.ts`
- `tests/browser/discovery.spec.ts`
- `docs/SAO_MULTI_SOURCE_DISCOVERY_REPORT.md`
