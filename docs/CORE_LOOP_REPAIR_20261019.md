# SAO Core Loop, discovery and dashboard verification — 19 October 2026

Baseline: `6fa2ab06e1448c184dd07ced66ef1d63cf88d22d` on `sao-policy-update-20261015`.
Work was performed locally in the existing project. No push, deployment, production environment change, credential rotation, or production database mutation was performed.

## Confirmed causes and repairs

The supplied idle diagnostics alone did **not** establish an ONS or web-provider failure. A stopped scheduler with no discovery execution naturally produces idle sources, zero extraction attempts and no gaps. The miswired manual button and lifecycle defects below explain why clicking the old Run Once did not establish a discovery attempt. Production execution has not been claimed from these local tests.

| Confirmed defect | Cause and repair |
| --- | --- |
| Run Once did not discover anything | `coreLoop.runOnce` called `processOneGap`, which returned immediately for an empty queue. It now runs discovery, validation, persistence and eligible queue processing. A separate `processNext` procedure processes one eligible queued operation. |
| Stop could be followed by discovery | Start used an untracked zero-delay timeout, and ticks did not check stopped state before discovery. One tracked timer, serialized controls and durable control epochs now invalidate stale callbacks and dispatch. |
| Repeated starts and interval changes could race active ticks | Timer management was spread across Start, updateInterval and tick completion. One scheduler owns timer creation and cancellation; interval changes apply while waiting or after the active cycle drains. There is no catch-up overlap. |
| A normal process restart lost the running preference | SIGTERM/SIGINT called the same function as Pause, persisting `isRunning=false`. Process shutdown now cancels local scheduling and drains without changing the persisted preference. Startup restores the saved schedule. |
| Failure recovery could lose scheduling | Tick scheduling depended on reaching its success path; recovery needed to remain cancellable through repeated storage failures. All completion paths reconcile the schedule, and a repeated database outage keeps a guarded recovery timer. |
| Manual and autonomous queue paths behaved differently | The legacy single-item function duplicated classification/build handling, lacked the pool heartbeat, and treated non-synthesis jobs as synthesis. Manual and scheduled work now share the existing queue-type dispatch, retries, policy handling and ownership checks. The duplicate implementation was consolidated without removing its supported operations. |
| Claims and worker state could become stale | Claims selected before their conditional update; contention could terminate a worker despite other eligible work, retry eligibility was not enforced, and manual ownership was process-wide. Claims now serialize briefly with control changes, reject stale epochs, prevent simultaneous jobs for one gap, apply retry limits, and use unique worker identities. Heartbeats run every 30 seconds; stale owners cannot finalize a newer claim. |
| Exhausted/interrupted jobs could remain pending indefinitely | Runtime and queue-record retry limits diverged. Claims record the current configured limit, exhausted pending work becomes failed with a reason, and recovery distinguishes retryable and exhausted work. |
| Worker-batch errors could release control before other workers finished | `Promise.all` rejected before sibling workers drained. Settled batches now wait for every dispatched worker before propagating a batch failure. |
| Concurrent business creation could insert another business for one gap | The helper locked the gap but always inserted. It now checks for an existing business while holding that lock. The existing lifecycle failure fixture now uses its own synthetic opportunity. |
| Expiration silently deleted opportunities' queue records | Maintenance deleted old pending items. Expiration now pauses them with a review reason and retains both gap and queue history. |
| Counters could lose concurrent updates | Read/increment/write sequences raced workers and counted deployment execution as another business creation. Database increments are atomic and business creation counts reflect creation. |
| Discovery history disappeared or misrepresented interrupted cycles | Only completed reports were persisted, and a new process could replace historical timestamps with empty in-memory values. Starts and completions are durable; new cycles reload history; an expired lease with an unfinished report is shown as interrupted without overwriting another replica's newer report. |
| ONS interpretation failures could appear fully successful | A usable-statistics counter was incremented before interpretation; caught interpretation errors did not affect source status. Statistical signals remain visible while interpretation failures produce partial status and errors. |
| ONS catalogue coverage stopped at the first page | Live ONS returned 338 catalogue entries but only the first 100 were considered. Bounded rotating extra pages and the existing dataset cursor now cover later pages without unbounded requests. Invalid catalogues, observations and calendar dates remain rejected. |
| Persistence errors and provider attempts were hard to trace | Candidate persistence caught errors without actionable diagnostics; only the last web query's attempts were visible. Reports now contain persisted/queued/duplicate counts, safe persistence reasons and cycle-wide provider attempts. Partial writes remain recoverable and are never presented as a complete success. |
| Health diagnostics assumed Tavily and nonzero gaps were mandatory for health | A successful empty discovery or an independent ONS result could be misdiagnosed. Health now follows actual cycle outcomes. Idle, running, completed-empty, partial, failed, stopped and interrupted are distinct. |
| Dashboard controls could display stale or misleading outcomes | Run Once did not refresh its affected data; Settings had inconsistent labels, independent pending flags and an uncaught Stop error. Both surfaces now use shared synchronous double-click guards, await backend confirmation, invalidate affected dashboard queries, poll authoritative status, allow Stop while work executes and display backend/queue errors. |
| Tavily's free-credit reserve could be increased without paid approval | Fallback providers had billing gates, but a larger Tavily allowance bypassed them. Above 900 locally reserved monthly credits, Tavily requires explicit approval, a confirmed account cap and configured daily/request limits. Paid Tavily requests also reserve budget. Existing credentials are preserved. |
| Zero deployment capacity and concurrent admission were unreliable | `parseInt(value) || 10` and `Number(value) || 10` replaced zero with ten; capacity was checked before a separate creation transaction. Zero is preserved and worker creation rechecks limits under a shared state-row lock. |
| Monitoring had another untracked startup timeout | The autonomous manager's delayed first run could survive its stop function. It now tracks and cancels that callback. Monitoring remains a separate existing service. |

## Runtime and stop policy

Start schedules an immediate full cycle. Repeated Start is idempotent. Stop cancels the waiting timer, persists stopped intent and advances a durable epoch. Repeated Stop is safe. Stop followed by Start drains old work before starting a new epoch. Manual Run Once does not enable scheduling; while a continuous loop is idle, it replaces the waiting execution and reschedules once after completion. Concurrent manual operations are rejected rather than silently executing twice.

Intervals are **completion-relative**, with one next execution after the configured delay. There are no overlapping catch-up ticks. Changes while a cycle runs apply to its next scheduling decision. During execution the old next-execution timestamp is cleared.

Stop is cooperative. Already dispatched HTTP/inference work and already claimed workers may finish; source loops check permission before subsequent searches, ONS requests/datasets and interpretation, persistence checks before new candidates/queue insertion, and claims check the durable epoch transactionally. A worker already inside a business operation retains the existing policy and emergency checks. The dashboard reports Stopping while the invalidated operation drains. Stop is not a rollback of completed writes or external work.

A renewable database lease serializes full/manual Core Loop work across processes. Discovery has its own renewable lease. Both have a 30-minute expiry and 60-second renewal. Abrupt process death can therefore defer replacement discovery for up to that lease period; stale queue claims recover after their inactivity threshold. The existing server shutdown deadline is 10 seconds: work exceeding it may be interrupted and recovered rather than forcibly treated as completed. Pool heartbeats are 30 seconds and ownership protects final writes.

Pause affects Core Loop discovery/queue dispatch. Existing business monitoring/audits remain separate. Emergency Stop uses the existing persisted system control and governed suspension policy; clearing it does not implicitly restart automation or bypass owner/Supervisor approvals.

## Button audit

| Surface / button | Verified backend action |
| --- | --- |
| Overview Start Loop; Settings Start Loop | `coreLoop.start` → serialized scheduler → immediate discovery and queue cycle; administrator + `settings.manage`. |
| Overview Pause Loop; Settings Stop Loop | `coreLoop.stop` → cancel timer, advance control epoch, persist stop, return actual Executing/Stopping/Stopped status. |
| Both Run Once Now buttons | `coreLoop.runOnce` → complete discovery/evidence/validation/persistence/queue cycle; no implicit restart. |
| Both Process Next Gap buttons | `coreLoop.processNext` → at most one eligible queue claim through the shared queue-type worker; returns its recorded outcome/error or no eligible work. |
| Overview Refresh; Settings Refresh live diagnostics | Fresh status plus invalidation/refetch of discovery, queue, gap, operational and related active dashboard data. |
| Overview Force Safety Audit | Existing `coreLoop.runAudit` → active-business safety audits; authorization preserved. |
| Settings Activate/Clear emergency stop | Existing `operations.saveSetting` for `emergencyStop`, optimistic revision and permission checks; existing stop/suspension behavior retained. Browser confirms persisted state after reload. |

## Discovery and provider audit

- The production source chain remains ONS and enabled web engines independently, followed by extraction with exact field/source support, recency/numerical checks, deterministic scoring, cross-source deduplication, gap and evidence persistence, capacity-controlled queue insertion, policy classification, governed business creation and existing monitoring.
- No validation thresholds or evidence requirements were weakened. Unsupported quotations, dates, observations, numerical claims and macro-only demand inferences are rejected. Genuine zero-result cycles remain valid completed outcomes.
- **ONS:** public catalogue, dataset metadata, dimension options and an actual statistical observation were retrieved in a separate read-only smoke test. The observed dataset was `cpih01`, edition `time-series`, version `67`: `Jan-26`, UK geography, aggregate `CP00`, observation `139.4`, unit `Index: 2015=100`. That is statistical evidence, not a discovered business opportunity. Statistical retrieval/signal detection needs no Tavily key and no LLM; opportunity interpretation uses the existing configured inference provider. Mocked integration covers qualified candidates and persistence; no live ONS-derived opportunity or business is claimed.
- **Web order:** Tavily → Gemini grounded Google Search → supported Groq browser search → OpenRouter extractive web citations. Unconfigured/disabled/unsupported providers skip requests. Auth, quota, rate limit, timeout, malformed response and network/service failure remain distinct. Fallback attempts, cooldowns and conservative reservations persist in the existing settings store. Ordinary uncited completion text is not accepted as evidence.
- **Capabilities:** provider request/response formats were checked against official documentation. Gemini grounding may itself execute multiple billable queries; Groq requires a browser-search-capable model; OpenRouter citations need source content for this extractive validator. Models without the required tool or attribution are unavailable rather than substituted with invented search results.
- **Billing:** paid fallback searches remain opt-in with explicit budgets and a confirmed provider-account spending cap. Local reservations are conservative ceilings supplied by the administrator, not proof of actual invoice cost. The default Tavily allowance assumes a free-only account; usage by other applications sharing that account is not tracked. Confirm the account's own billing/overage settings before relying on a free allowance. No live paid search or inference provider was called during verification. Public ONS was explicitly tested by the separate smoke script and may also be queried for context by the existing lifecycle research path.
- **Persistence:** the existing schema, maintenance lock, evidence history, archive protections, policy gates and queue-capacity controls are retained. A partial insertion is reported, and a later eligible discovery can recover a pending insertion without requeueing historical businesses. Expiration pauses records. New businesses are idempotent per gap.

Official sources checked: [ONS observations](https://developer.ons.gov.uk/observations/), [Google grounding](https://ai.google.dev/gemini-api/docs/google-search), [Groq browser search](https://console.groq.com/docs/tool-use/built-in-tools/browser-search), [OpenRouter web search](https://openrouter.ai/docs/guides/features/plugins/web-search), [Tavily pricing](https://www.tavily.com/pricing).

## Settings synchronization

A saved zero active-deployment limit previously fell back to ten in both the UI and runtime check. Zero now means zero, and autonomous business admission rechecks capacity under a transaction lock so simultaneous workers cannot both consume the same available slot. The existing frontend procedure names and camelCase responses for interval, concurrency, retry attempts/backoff/base delay, queue capacity/expiration, cost/deployment limits, auto-pause and notifications were traced. These existing names already agree; no speculative renaming was performed. Interval applies through the scheduler; concurrency is read at dispatch and resizes the pool; retries read current configuration and persist claim limits; insertion reads live capacity; expiration reads the configured hours. Budget/auto-pause and notification settings continue through the existing authorization/policy/monitoring services. Existing policy fixtures verify persisted operational settings and emergency stop; the new real-router test additionally verifies interval, concurrency and retries affect execution.

## Verification commands and results

The discovery/unit/router tests mock all external responses. The complete lifecycle suite mocks inference, deployment, payment and advertising boundaries; its existing business-research path can also retrieve public ONS context. Database suites create disposable local databases, apply the real migrations, and remove only their own temporary fixtures. Initial sandbox failures to bind sockets, access Docker or resolve npm were rerun with approved access; those blocked attempts were not represented as passes.

| Exact command | Result |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit -p server/tsconfig.json` | PASS |
| `./node_modules/.bin/tsc --noEmit -p client/tsconfig.json` | PASS |
| `corepack pnpm test` | PASS; existing backend/auth/settings/migration/security suites plus discovery and lifecycle regressions |
| `node --import tsx tests/core-loop-lifecycle.test.ts` | PASS — 13 deterministic lifecycle scenarios, including repeated database outages |
| `node --import tsx tests/discovery.test.ts` | PASS — 38 mocked discovery/provider/evidence scenarios |
| `node --import tsx tests/discovery-db-isolated.test.ts` | PASS — 16 isolated persistence/router/worker/restart/control scenarios |
| `node --import tsx tests/e2e-isolated.test.ts` | PASS — 48/48 complete business lifecycle stages |
| `node --import tsx tests/policy-engine.test.ts` | PASS — nine policy contracts, deterministic gates, authorization denial and accounting fixtures |
| `node --import tsx tests/policy-db-isolated.test.ts` | PASS — real migrations, authorization, policy history, artifact QC, approvals, accounting, reset/backup preservation and operational settings |
| `node --import tsx tests/frontend-delivery.test.ts` | PASS — routes, access classification, cache/build identity and API fallback |
| `node --import tsx tests/design-system.test.ts` | PASS — existing contrast/focus/motion/dialog checks |
| `corepack pnpm build` | PASS — production client bundle |
| `./node_modules/.bin/playwright test` | PASS — 25/25 Firefox tests, including actual authenticated backend workflows and controlled runtime/provider fixtures |
| `corepack pnpm audit --prod --json` | PASS — zero info/low/moderate/high/critical vulnerabilities; 230 production dependencies |
| `docker build -t sao-core-loop-verification:local .` | PASS — local production image only |
| `docker run --rm --network none --shm-size=1g sao-core-loop-verification:local node --import tsx tests/container-runtime.test.ts` | PASS — non-root production configuration, no private build context, built client, genuine Firefox artifact execution, no network/credentials |
| `node --import tsx scripts/ons-discovery-smoke.ts` | PASS — public ONS catalogue → metadata → dimensions → usable observation; no inference/database writes |
| `git diff --check` | PASS |

Verification output is retained locally under `/tmp/sao-core-*.log`, `/tmp/sao-discovery-unit.log`, `/tmp/sao-ons-smoke.log` and `/tmp/sao-core-audit.json`. These logs are not committed. The existing browser suite also writes ignored screenshots and reports.

## Deployment readiness and limits

The local changes are suitable for a controlled deployment after review; this is **not** a claim of production execution or external provider account readiness. No new schema or migration is required: control epochs, leases, reports, counters and circuits use existing tables. No environment-variable or credential change is required for existing functionality. Paid fallback activation still requires explicit configuration/approval and an actual provider-account cap. Unknown/retired model IDs, insufficient source content and missing inference credentials will be reported rather than silently treated as functioning discovery.

Real Northflank process restarts, rolling-replica behavior, production database latency and paid-provider calls were not exercised. Distributed exclusion is covered using real database locks/leases and deterministic scheduler tests, not a production multi-replica load test. Abrupt crash recovery retains the conservative lease-expiry delay described above. Source coverage is bounded; ONS catalogue rotation is not proof that every ONS dataset's dimensions, suppression flags or units are supported. Strict discovery may legitimately find zero qualified opportunities. A successful mocked business lifecycle does not demonstrate real market demand, legal clearance, profitability or a live business deployment.

No production data was reset, truncated, deleted or rewritten. Existing credentials and production configuration were preserved. The only Docker activity was a local image build/runtime verification; nothing was pushed or deployed.

## Changed files

| File | Purpose |
| --- | --- |
| `client/src/hooks/useRuntimeControls.ts` | Shared mutation guards, confirmed outcomes/errors, stop availability and cache refresh. |
| `client/src/pages/dashboard/DiscoveryHealth.tsx` | Display durable cycle outcomes, timing, source attempts and persistence/validation counts. |
| `client/src/pages/dashboard/Overview.tsx` | Wire separate cycle/single-gap controls; show actual runtime state and refresh all relevant data. |
| `client/src/pages/dashboard/Providers.tsx` | Expose explicit paid controls for higher Tavily allowances as well as fallbacks. |
| `client/src/pages/dashboard/Settings.tsx` | Preserve a zero active-deployment limit in the settings input. |
| `client/src/pages/dashboard/SettingsPanels.tsx` | Use shared runtime controls, accurate state, error handling and synchronized diagnostics. |
| `docs/CORE_LOOP_REPAIR_20261019.md` | Root-cause, control, discovery, file, verification and deployment-readiness report. |
| `package.json` | Include deterministic scheduler regression tests in the default suite. |
| `scripts/ons-discovery-smoke.ts` | Reproducible public, read-only ONS observation smoke with no inference or database. |
| `server/_core/index.ts` | Restore persisted scheduling and separate graceful process shutdown from user Pause. |
| `server/autonomousManager.ts` | Track and cancel the delayed monitoring startup callback. |
| `server/db.ts` | Transactional stop-aware claims, ownership checks, retry recovery, atomic counters, idempotent business creation and durable control epochs. |
| `server/orchestrator.ts` | Integrate scheduler, complete manual cycle and shared single-worker dispatch; preserve expired records and drain worker batches. |
| `server/routers.ts` | Expose full Run Once and separate Process Next actions; return authoritative runtime/discovery diagnostics. |
| `server/services/businessData.ts` | Paginate catalogue reads and apply cooperative stop/request-budget checks to ONS calls. |
| `server/services/coreLoopScheduler.ts` | Single timer, serialized lifecycle controls, guarded dispatch, operation lease and repeatable outage recovery. |
| `server/services/discovery.ts` | Durable started/completed/interrupted reports and history; source independence, stop-aware persistence and detailed outcomes. |
| `server/services/discoveryQueue.ts` | Count persisted gaps, retain safe persistence errors and stop before subsequent writes/queue insertion. |
| `server/services/discoveryRuntime.ts` | Renewable token-owned leases, validity tracking and operation epoch metadata. |
| `server/services/onsDiscovery.ts` | Bounded rotating catalogue pages, partial interpretation status, cooperative stop and strict calendar validation. |
| `server/services/search.ts` | Cycle-wide provider metrics and cooperative checks between searches and extraction. |
| `server/services/systemControl.ts` | Return authoritative Core Loop activity in existing operational diagnostics. |
| `server/services/webSearch.ts` | Cooperative provider dispatch, precise safe failure reasons and paid Tavily approval/reservations. |
| `tests/browser/core-loop.spec.ts` | Behavioral Start/Stop/manual/single-gap/error/double-click/reload/two-session/emergency-control tests. |
| `tests/browser/discovery.spec.ts` | Verify all seven discovery states and existing provider configuration controls. |
| `tests/core-loop-lifecycle.test.ts` | Deterministic timers, lifecycle races, restart, manual exclusion, repeated outages and emergency enforcement. |
| `tests/dashboard-controls.test.ts` | Follow the shared runtime hook in the dashboard control inventory. |
| `tests/discovery-db-isolated.test.ts` | Real router/database discovery, validation, queue/worker outcomes, stop races, claims, ownership, expiration and separate-process restoration. |
| `tests/discovery.test.ts` | Extend ONS malformed/failure/interpretation cases, billing gates, durable history and stopped/partial/empty outcomes. |
| `tests/e2e-isolated.test.ts` | Give the independent advertising-failure scenario its own synthetic gap, preserving its assertion under per-gap business idempotency. |
| `tests/internal-remediation.test.ts` | Require behavioral scheduler regression coverage instead of obsolete timer-source-string assertions. |
