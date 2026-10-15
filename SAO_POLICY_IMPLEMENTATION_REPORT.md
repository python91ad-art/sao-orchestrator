# SAO Policy Implementation Report

Date: 2026-10-15
Scope: continuation of the existing implementation; no rewrite and no separate Situational Arbitrage methodology audit.

Production-readiness follow-up: `SAO_PRODUCTION_READINESS_REPORT.md` is the current source of truth for live observations and approvals. Exact MySQL 9.6.0 staging/native backup restoration and real provider metadata checks now pass. The deployed runtime lacks production authentication/encryption secrets and uses legacy default encryption; live activation remains BLOCKED pending a separately approved secure cutover. No live schema/grant/reset/deployment was executed.

## 1. Executive completion summary

**Overall deployment status: PARTIAL.** The supported software lifecycle is integrated and passes isolated verification, including the formerly failing full lifecycle test (48/48). Production rollout is BLOCKED pending explicit migration/provisioning authorization, approved policy values and business-owner consents. Unsupported advertising/payout providers remain unavailable; they are not simulated as successful external operations.

The previous report's identity, approval, release-evidence, persisted accounting, lifecycle and reset-executor omissions have been implemented. This report supersedes that earlier foundation-only assessment. It does not claim generic full-stack QC, foreign-exchange reconciliation, accrual accounting, live payouts, real paid advertising or production readiness without the prerequisites below.

Preserved the substantial pre-existing dirty workspace. No Git commit/push, production deployment, live spending, remote migration, privileged grant or remote deletion was performed. Test-created data is confined to disposable databases. Northflank access was read-only.

Source checkpoint: `.sao-backups/source-checkpoint-2026-10-15.tgz`, verified archive, mode 600 in the private backup directory, excluding environment/tool credential directories, dependencies, build outputs, Git and database backups. This is not a database backup. Earlier `/tmp` checkpoints and logs were lost on environment restart; fresh verification logs now live under `.sao-backups/verification-2026-10-15/` and remain excluded from Git/container context.

### Evidence key

- U: `node --import tsx tests/policy-engine.test.ts` — contracts, deterministic decisions and minor-unit arithmetic.
- D: `node --import tsx tests/policy-db-isolated.test.ts` — real disposable MariaDB, migrations twice, Drizzle/services/tRPC, operational fixtures, real Firefox artifact tests; controlled external providers.
- L: `node --import tsx tests/e2e-isolated.test.ts` — 48/48 stages, disposable database, real application orchestration and browser QC; controlled LLM/Vercel boundaries.
- B: `./node_modules/.bin/playwright test` — five browser scenarios: two existing mocked navigation tests and three real HTTP backend/database tests, including owner-history pagination.
- M: `node --import tsx tests/live-backup-migration-isolated.test.ts .sao-backups/discovery-reset-northflank-e9d30095-4697-4617-a79e-760dd64e4bba.json` — actual backed-up Northflank rows restored locally, migrations applied twice, all original fields compared.
- C: local Docker build plus `tests/container-runtime.test.ts` — actual non-root Firefox execution and compiled client inside the network-isolated production image; no application startup or database credentials.

## 2. Nine policy categories

| Category | Previous status | New status | Actual integration / persistence / management | Evidence and prerequisite |
| --- | --- | --- | --- | --- |
| Discovery & qualification | PARTIAL | COMPLETE | discoveryPolicy.ts, discoveryMaintenance.ts, search.ts, db.ts and orchestrator.ts; independent evidence/reliability, legal review history, configured ranking, archive-aware counts, priority admission, supported reasoning allocation; Operations Discovery inspection/review | U/D/L; production evidence, jurisdiction review and scoring parameters required |
| Master specification | PARTIAL | COMPLETE | specificationGovernance.ts, specialistReviews.ts, execution.ts and orchestrator.ts; Architect creates/reviews immutable approved versions, required expertise, collaborative conflicts, Supervisor escalation, future-only safe improvements, current-version dependencies and specialist outputs in build input; Operations Specifications | D/L; approved required sections and actual model availability |
| Agent permissions & coordination | PARTIAL | COMPLETE | execution.ts, agentRouting.ts and operationsRouter.ts; verified server contexts, hashed sessions, workspace/tool scopes, durable assignments, Supervisor coordination, expiry/revocation, retries/backup/escalation/cancellation/emergency stop; Operations Agents/Approvals | U/D/L/B; explicit tool/retry policy and administrator permissions |
| Business model & pricing | PARTIAL | COMPLETE | pricingLifecycle.ts, specificationGovernance.ts, operatingCycle.ts and Checkout.tsx; actual Pricing/Marketing/Finance execution, recommendations, risk/cadence checks, Supervisor approval, history/rollback as proposal, authoritative quotes and existing-transaction preservation | D/L; configured change boundaries/currency/commitments; checkout requires supported payment configuration |
| Independent QC & release | BLOCKED | COMPLETE | releasePipeline.ts, orchestrator.ts and vercel.ts; artifact hashes, independent browser suites, separate Architect acceptance verification, repair/retest, durable release and real provider reconciliation, publication claim/idempotency, post-deployment artifact verification; Operations Releases | D/L; supported self-contained static artifacts only; broader QC limits in section 9 |
| Advertising & reinvestment | PARTIAL | PARTIAL | advertisingPolicy.ts, growthEngine.ts and execution.ts; organic preparation, Marketing/Finance budget analysis, scoped owner consent, reservation/consumption, expiry/revocation, performance-based pause/reinvestment and audit; Operations Advertising/Approvals | U/D/L; external execution remains blocked without a genuinely supported adapter; no campaign is claimed published |
| Net-profit finance & settlement | PARTIAL | PARTIAL | financialLifecycle.ts, profitAccounting.ts, revenue.ts, crypto.ts and signed webhook routes; persisted weekly cash periods, verified ledger/deductions, taxes/fees review, loss chain, correction/reconciliation/disputes, original consent, idempotent eligibility and history; Operations Finance | U/D/L; payout adapter unavailable; accrual/FX unsupported and fail closed |
| Deadlines, success & extensions | PARTIAL | COMPLETE | businessLifecycle.ts, operatingCycle.ts and payment handling; Finance/Strategy activation proposal, persisted start after verified launch, Analytics success review, warnings, finite fixed-price offers, owner acceptance and verified purpose-bound payment; Operations Lifecycle and Authorizations | D/L; explicit industry/complexity/days/success/price/count values |
| Shutdown, restart & learning | PARTIAL | COMPLETE | businessLifecycle.ts, execution.ts and operatingCycle.ts; emergency suspension, genuine Supervisor resumption/closure, owner irreversible-action consent, obligation checks, final reports, retained resources, fresh-gap/new-spec/new-build restart, executed Finance/Strategy/Analytics lessons | D/L; production retention/loss limits; physical irreversible resource deletion is deliberately unavailable |

COMPLETE here means the specified supported software path is connected, persisted and tested, not that live providers or production configurations were exercised. Each category uses the typed shared contracts and pinned policy versions. Missing configuration blocks the dependent action, not unrelated platform processing.

## 3. Seven resolved conflicts

| Resolution | Status | Enforcement |
| --- | --- | --- |
| Automatic safe building versus approval | COMPLETE | Server-owned reversible agent work proceeds; high-risk Supervisor and owner spending/irreversibility consent checked at execution |
| Automatic pricing versus Supervisor | COMPLETE | Collaboration/risk/cadence rules; low-risk configured auto-change, high-risk persisted Supervisor approval |
| Weekly settlement versus owner approval | COMPLETE | Recorded 20% weekly consent reused only in scope; exceptions pause eligibility, unsupported transfers unavailable |
| Automatic shutdown versus owner approval | COMPLETE | Risk suspension immediate; permanent closure/irreversible actions governed; obligations/resources preserved |
| Ranking versus complexity | COMPLETE | Demand/severity/evidence/solution weights only; complexity controls actual reasoning and specialists |
| Independent QC versus Architect | COMPLETE | Separate identities and persisted results; neither Architect nor Supervisor can override failed mandatory QC |
| Net profit definition | COMPLETE | Verified revenue minus legitimate deductions and prior losses; positive eligible amount only, 20%/80% |

## 4. Central policy engine

Files: `shared/policyContracts.ts`, `server/services/policyEngine.ts`, policy tables in `drizzle/schema.ts`, management procedures in `server/routers.ts`.

Database-backed nine schemas, readiness/missing-field validation, immutable safeguards, draft editing with expected hash, validated activation under policy-head transaction locks, superseded historical versions, safe optional pricing disable, unknown-action denial, historical restore as a new draft and explicit business assignments are operational. Mandatory safety policy disable cannot turn restrictions off.

Policy evaluations persist action, actor, gap/business, version, decision, reasons and facts/evidence. Execution services assemble identity/approval/QC facts from persisted records; UI claims are not proofs. The pure deterministic evaluator is an internal primitive, not an endpoint accepting arbitrary authorization evidence.

Global changes do not silently replace existing business assignments. Finance, pricing, advertising and deadline reassignment checks preserve applicable owner agreement boundaries. Impact inspection is paginated, with aggregate business/task/queue/agent/approval/agreement/deployment/assignment counts and conservative pinned-business effects. No policy read cache is used, avoiding stale activation cache state.

Enforcement scope is explicit through global heads and per-business assignments. Custom arbitrary scope-expression languages are not implemented. In-flight tool evaluations and dependent discovery scoring use explicit version IDs; specification changes invalidate stale task dependencies.

## 5. Administrator permissions

`shared/permissions.ts`, `server/_core/trpc.ts`, policy/execution/settings service boundaries and `operationsRouter.ts` enforce real database administrator identity plus explicit permission rows.

Permissions include policy view/edit/validate/activate/history/restore/impact/assign, discovery maintenance, agent management, approval request/Supervisor decision, specification, finance, lifecycle and settings management. Agents have read-only applicable-policy access. Non-admin and agent mutation denial is tested via API and browser.

`scripts/grant-policy-permissions.ts` defaults to read-only preview, verifies an existing administrator, and requires exact database/server/admin confirmation and reason for an audited transaction. No administrator was created or guessed; no live grant was executed. Existing observed administrator must be reverified before provisioning. See migration plan.

## 6. Agent identity and real execution

`execution.ts` supplies trusted immutable server contexts, hashes externally presented session tokens, verifies current agent role/tool/workspace at use, checks expiry/revocation and emergency state, persists execution attempts and outputs, and enforces dependencies against actual completed executions/current specification.

Supervisor assignment is a real execution, not a metadata claim. Configured bounded primary retries precede backup takeover; both failures escalate. Stale/cancelled tasks do not silently resume side effects. Credential resolution remains server-owned, not exposed in model prompts or agent tokens.

`agentRouting.ts`, `llm.ts`, `llmRouter.ts` and `llmProviders.ts` apply actual model/reasoning assignments. Stronger mandatory reasoning wins over a weaker assignment. Unsupported provider/model reasoning is an explicit failure. Groq GPT-OSS supported reasoning is mapped rather than merely recorded; extended requires the suitable model.

`specialistReviews.ts` executes the Architect's required specialist roles before developer work, passes durable task dependencies and advisory outputs into generation and preserves immediate approved requirements. Unavailable required executor blocks the build. Registry roles are not treated as proof of external actions.

Required agents are implemented as server-owned execution callbacks and model workflows, not a generic remote arbitrary-code executor. Specialist reviews are advisory; external sales/outreach/support publication is not invented.

## 7. Master Business Specification

Architect creation includes existing business plan and collaborative business model recommendations. Required sections, supported role expertise and executable acceptance manifest are validated. Approved sections are immutable historical versions. Proposals receive actual Architect review; affected work is invalidated/re-evaluated. Conflicts collect affected agent positions and resolve technically or escalate to genuine Supervisor review.

Automatic improvement adoption is limited to configured safe future-backlog additions. Immediate requirements continue through governed proposals and release QC, not autonomous silent overwrites. Version/conflict/task history is available in Operations with pagination.

## 8. Pricing

Recommendations include competitor/customer/cost/margin evidence and Finance/Marketing collaboration. Applied price versions are durable; current checkout quotes and payments use server-side amounts and currency. Completed payments retain their original price; zero-to-positive changes are high risk. Rollback creates a governed proposal, not history deletion.

`client/src/pages/Checkout.tsx` supports authenticated authoritative purchases and genuine free enrollment. Generated static artifacts receive a governed checkout link only when configured HTTPS application origin exists. Free enrollment creates no fake paid receipt. Production payment creation remains subject to provider credentials, business status and emergency controls.

## 9. Independent QC and deployment

Actual generated artifact bytes are hashed and stored. Independent QC uses Firefox on an isolated local origin with external network blocked; functional/integration/security/performance suites execute against the artifact. Architect separately executes the approved acceptance manifest. Builder and QC identities must differ.

Failed tests create defects/repair/retest evidence and block eligibility. Release checks require current specification, legal clearance, owner activation/financial arrangement, deadline readiness and genuine Supervisor release authorization. All publication paths converge on the verified provider gate, including restore/recovery.

A durable pre-call publication claim prevents duplicate external side effects. Ambiguous provider response becomes deployment_unknown, not an automatic retry. Reconciliation retrieves actual provider identity/state/files and verifies hash. Post-publication verification retrieves deployed bytes and reruns independent checks; failure is recorded and alerts repair without deleting previous resources.

**Limitations:** the harness verifies supported self-contained static artifacts. It is not a comprehensive security audit, arbitrary backend integration runner, mobile test system or generic full-stack acceptance environment. Unsupported mandatory suites/framework needs must remain blocked pending a real runner. The production image builds successfully and executes genuine Firefox functional checks as its non-root application user with network disabled. Full deployed-container application/database/provider operation was not exercised. No live Vercel deployment was executed.

## 10. Advertising and consent

Organic-first preparation remains an internal campaign plan until an authorized supported publisher exists. Marketing/Finance budget review and owner-scoped campaign authorization are persisted. Consent tracks amount/currency/scope/expiry/revocation/consumption; budget reservations and spend cannot substitute administrator consent for owner permission.

Campaign performance evidence, review intervals, pause/stop recommendations and reinvestment approval use existing growth infrastructure. Unsupported publishing/spending adapters are visibly unavailable and cannot report success. No paid campaign, external organic post or advertising spend was executed.

## 11. Finance and settlement

| Capability | Status / evidence |
| --- | --- |
| Minor-unit calculation helper | COMPLETE; BigInt, deterministic configured rounding, agreed 20% |
| Persisted source ledger | COMPLETE; original payment references, unique economic source protection, verified expenses/refunds/fees/taxes |
| Weekly cash scheduling | COMPLETE; configured timezone/week boundary, explicit opening loss/start, real operating cycle |
| Loss carryforward | COMPLETE; chained periods without double counting; negative profit yields no platform share |
| Reconciliation and correction | COMPLETE; disputes/unverified items pause, immutable history plus reviewed recalculation chain |
| Consent and settlement eligibility | COMPLETE; exact agreement, scoped authorization, durable idempotent records |
| External payout | BLOCKED; no supported transfer adapter; calculated eligible records remain transfer_unavailable, never paid |
| Accrual and foreign exchange | BLOCKED; unsupported conventions/conversions fail closed |
| Actual transfer executed | No |

Signed Stripe webhook verification is preserved. Only genuine paid events book revenue; refunds/disputes freeze affected settlements without guessing deductions. Signed crypto payments require correct amount/currency. Crypto nominal fiat invoice value is not treated as reconciled fiat cash: conversion/reconciliation remains required and unsupported. Platform/extension receipts are separate from business sales.

Tax and processor-fee treatment must be explicitly reviewed, including documented zero where appropriate. Late items pause affected/downstream periods; corrections preserve original agreements and require renewed reconciliation. Duplicate fees cannot be disguised as another expense kind. No automatic live transfer or refund execution exists.

## 12. Deadlines and extensions

Finance and Strategy assess configured industry/complexity deadlines; concerns require Supervisor review. The business clock starts after verified launch, not at draft creation. Warnings, success criteria and performance assessments are persisted; already-successful businesses are not closed solely for an old deadline.

Extensions have finite configured counts, bounded fixed offers, Supervisor review, actual owner acceptance and purpose-bound verified payment. Existing accepted offers retain their original policy snapshot. Late/invalid payments become visible exceptions rather than fictitious fulfillment. Extension does not automatically undo legal/security suspension.

## 13. Shutdown, restart and learning

Risk suspension stops new queue work/campaigns/agent assignments while preserving deployments, customers and finances. Direct status mutation cannot bypass governed resumption. Supervisor resumption rechecks legal/specification/QC/provider/owner/deadline/financial facts.

Closure checks owner and Supervisor approvals, notifications, outstanding customer/financial/extension obligations and final report. Irreversible resource deletion is unavailable; resources are preserved. Missing owner consent leaves suspension in place. Restart requires fresh post-closure evidence, new opportunity validation, new business and specification/build; old closed status cannot simply be changed back.

Finance/Strategy/Analytics actually analyze closure outcomes and persist lessons/execution references. Learning failure is a retryable visible state, not a rollback of closure. Historical lessons are not fresh market evidence. Final report includes bounded recent outcomes plus total count; full lifecycle history remains paginated.

## 14. Policies and operational dashboard

Policies: nine typed editors, readiness warnings, draft save/edit, validation, impact preview, reason/confirmation, activation, history, version comparison, restore-as-draft, safe optional disable, explicit assignment and blocked-operation activity. Server permissions independently enforce all mutations.

Operations reuses authoritative records: Discovery, Approvals, Agents, Specifications, Releases, Pricing, Advertising, Finance, Lifecycle, Activity and Maintenance. Views provide legal evidence/review, owner consent status, release history, pricing changes, reconciliation/correction, extensions, suspension/resumption/restart, task/agent management and reset history. Sensitive token values display once and are not logged.

Cross-dashboard unsaved-change protection is provided by `client/src/hooks/useUnsavedChanges.ts`. Histories and impact are paginated. Owner-facing approvals, extensions and notifications now have bounded stable-order pagination with Previous/Next controls, business-change page reset and server-side owner verification before any query. Supervisor-only approvals are filtered in the database rather than exposed to the owner view.

## 15. Professional Settings

Ten searchable categories: General/System, Core Loop, Queue/Workers, AI/Reasoning, Budgets/Finance, Security/Approvals, Notifications, Monitoring, Data Management and Policies navigation.

Existing operational controls are preserved. New `SettingsPanels.tsx` and `systemControl.ts` connect persisted optimistic-revision settings, actual agent routing, emergency stop, notification routing, real diagnostics, export/reset maintenance and retention review. General identity/timezone/region affect the dashboard. Settings mutations require settings.manage and audit events.

Core-loop interval updates reschedule the running timer. Worker resizing applies immediately, preserves busy workers, reserves bounded claims and uses monotonic worker IDs. Group-specific dirty state/save/restore avoids clearing unrelated unsaved changes. Loading errors do not overwrite saved settings with defaults. Restore form values is separate from service operations and discovery reset.

Notifications produce persisted in-app events; Resend/Slack delivery requires existing valid configuration. Destructive retention deletion is deliberately not automated: the control previews eligible records/obligations instead. Real external email/Slack delivery is NOT VERIFIED.

## 16. Providers preservation

Providers remains its own functioning workspace. No provider credentials, definitions, enablement states or functionality were reset. These files are byte-identical to the verified resume source checkpoint:

| File | SHA-256 |
| --- | --- |
| client/src/pages/dashboard/Providers.tsx | f10116249be1d02c1b6120aacb07eaa701c37ed89a51add6557e6c6c81c06d53 |
| server/services/providerRegistry.ts | 42f1668e7892499ac1c007f3b1ae5804302aa142d82e76a6398682cf8af42d01 |
| server/services/credentialCrypto.ts | 621d4049515d9e9c4af07b817f7a236c2f0e01bd90d62b4d8c6253f6067be461 |

Seven live credential rows and 24 deployment-provider rows were backed up read-only; full private fingerprints are in the protected checkpoint report. Restored-data migration tests compare every original field, including encrypted credentials. Scoped reset tests verify exact provider preservation.

Stored provider connection states are not fresh connectivity tests. The subsequent production-readiness task performed actual read-only authenticated metadata checks for deployed Vercel/Groq/Cerebras/Gemini/OpenRouter/Tavily and a public ONS dataset GET. This does not verify billable inference, live publication, payments, advertising or payouts. See the production report for local-versus-deployed configuration and the confirmed legacy encryption blocker.

## 17. Discovery cleanup

### Implemented executor

`discoveryReset.ts` inventories actual foreign keys and gap references, classifies protected relationships, prepares private full schema/data backup with SHA-256/readability verification, fingerprints exact preview scope, isolates discovery writers with database named locks, rejects active affected workers, executes narrow transactional delete/archive, verifies protected provider rows/references, invalidates discovery caches and returns audit/counter results.

`discoveryMaintenance.ts` guards candidate/evidence/review/queue/spec/business creation against concurrent cleanup. Archived candidates and stale removed IDs cannot be requeued or resurrected. Only eligible discovery synthesis work is deleted; protected synthesis is archived/hidden and non-discovery work remains.

Local D execution deleted one eligible gap and one discovery-only synthesis queue item; archived four protected gaps, retained protected histories, verified backup restoration/provider equality, and created fresh discovery afterward. This is isolated fixture data, NOT Northflank deletion.

### Live read-only inventory and backup

- Connection: existing administrator TCP forward 127.24.1.1:3306; process-local overrides, credentials unchanged.
- Target: database eb2bfb559429, server sao-sql-primary-0, MySQL 9.6.0.
- Inspected all 24 existing application tables, engines, schema/relationships, every gap_id reference, discovery queue categories, protected business/payment/provider records; no existing FK definitions.
- Observed 1,335 gaps, 21 owned businesses, 1,336 queue items, seven credential rows, 24 deployment-provider rows, 639 audit logs, one user, zero payment rows; lifecycle/policy/operations migrations not applied.
- Read-only candidate classification: 775 eligible gaps, 560 protected gaps; 763 eligible synthesis queue rows. 571 queue rows reference protected gaps. All 18 non-synthesis queue rows are retained, including two orphan failed deployment jobs. Protected synthesis archival/hiding is separate from deletion; exact executor preview must be refreshed after migrations.
- Backup: `.sao-backups/discovery-reset-northflank-e9d30095-4697-4617-a79e-760dd64e4bba.json`.
- SHA-256: e3b4fcbdd8157d79d0ed5b6329a56616354595eef7cc3e6a221aef709fa234ab.
- Private report: `.sao-backups/northflank-e9d30095-4697-4617-a79e-760dd64e4bba-report.json`.
- Backup directory mode 700, files 600, excluded from Git/container; schema and data readability/hash verified; restored into disposable MariaDB and original fields verified after two migration applications.
- The earlier MariaDB compatibility test had a collation-normalization path. Fresh inspection confirms the actual source schema/table defaults are utf8mb4_general_ci. Subsequent exact MySQL 9.6.0 tests preserve that inspected collation without substitution and verify complete row preservation, native restoration and application startup. Original backups remain unchanged.

### Actual remote reset result

| Item | Result |
| --- | --- |
| Deleted / archived | 0 / 0 |
| Retained | All remote records |
| Protected records destroyed | 0 |
| Queue modifications / cache invalidations | 0 / 0 |
| Discovery counter updates | None remotely |
| Provider configuration changes | None |
| Fresh discovery after remote reset | NOT VERIFIED; reset not executed |
| Execution status | BLOCKED pending migrations/provisioning and new exact-preview administrator confirmation |

This observation is not a deletion authorization and not the post-migration prepared reset fingerprint. Copy the private backup to durable protected storage; application-local backup is not independent disaster recovery. See `SAO_POLICY_MIGRATION_PLAN.md`.

## 18. Northflank inspection

Initial attempts received ECONNREFUSED; later the existing forward became reachable. Successful read-only commands:

- `node --import tsx scripts/inspect-forward.ts`
- `node --import tsx scripts/prepare-live-policy-checkpoint.ts eb2bfb559429 sao-sql-primary-0`

No permanent environment connection setting was changed. No second forward was started; the user's terminal was untouched. No password or credential-bearing URL appears in this report.

## 19. Database migrations and compatibility

Existing 0013 lifecycle infrastructure and 0014 policy tables are reused. New `drizzle/migrations/0015_operational_policies.sql` and `drizzle/operations.ts` add:

action_approvals, agent_sessions, task_executions, release_authorizations, accounting_items, accounting_periods, price_proposals, extension_offers, operational_settings, operational_events and discovery_archives.

Foreign keys, indexed business/state/time lookups, unique task execution/accounting-period/source keys and audit timestamps protect references/idempotency. Additive storage widening uses LONGTEXT for artifact metadata, task input/output/checkpoints, specification sections and lifecycle final reports; legal-review time is millisecond precision. DDL can acquire locks and is not a whole-migration rollback transaction.

Removed the old migration runner's guessed first-admin ownership backfill. Existing NULL ownership remains NULL; no business is silently assigned to an administrator. Representative restored rows/ownership remain identical. Migrations reapply twice in isolated tests.

Remote application is BLOCKED awaiting exact target/change approval, secure runtime cutover and recovery prerequisites. `npm start` runs migrations: do not use it as a remote dry run. Exact MySQL 9.6.0 staging now passes, including the real production entrypoint against the migrated disposable database; no live deployment or migration occurred.

## 20. Full lifecycle E2E

Former missing-policy/legal fixture failure is fixed by explicit isolated policy configurations, legal/evidence review, real scoped owner approvals, verified agents/specifications, actual browser test artifacts and release authorization.

L passes **48/48**, including discovery/queue/build/release/post-QC, failure recovery, campaign safety, metrics, activity, governed suspension and verified resumption. D supplements finance/extension/closure/restart/repair/tamper/backup/revocation/dispute cases not all contained in L's original stage count. External model/publishing boundaries are controlled mocks, never production actions.

## 21. Exact verification commands and results

| Command | Result | Scope |
| --- | --- | --- |
| ./node_modules/.bin/tsc -p server/tsconfig.json --noEmit | COMPLETE | PASS |
| ./node_modules/.bin/tsc -p client/tsconfig.json --noEmit | COMPLETE | PASS |
| npm test | COMPLETE | PASS existing unit/regression suites |
| node --import tsx tests/policy-engine.test.ts | COMPLETE | PASS typed decisions/configuration/arithmetic |
| node --import tsx tests/policy-db-isolated.test.ts | COMPLETE | PASS real disposable DB, operational workflow/authorization/QC/reset |
| node --import tsx tests/e2e-isolated.test.ts | COMPLETE | PASS 48/48 |
| ./node_modules/.bin/playwright test | COMPLETE | PASS 5/5, including real backend/database/restart and owner-history pagination scenarios |
| node --import tsx tests/live-backup-migration-isolated.test.ts .sao-backups/discovery-reset-northflank-e9d30095-4697-4617-a79e-760dd64e4bba.json | COMPLETE | PASS final storage widening; every original field preserved through two migration applications; MariaDB collation caveat |
| npm run build | COMPLETE | PASS; Vite CJS and >500 kB chunk warnings |
| docker build -t sao-policy-verification:local . | COMPLETE | PASS optimized image build; local image sha256:4af884dac30a89686a05bccc74d17405888b35445fb3dc14970b32ecf2afa125 |
| docker run --rm --network none --entrypoint node sao-policy-verification:local --import tsx tests/container-runtime.test.ts | COMPLETE | PASS actual non-root Firefox click/assertion, compiled client and private context exclusions; no application startup or DB/provider access |
| corepack pnpm@9.15.9 install --lockfile-only --offline --frozen-lockfile --modules-dir /tmp/sao-policy-completion/pnpm-validation --ignore-scripts | COMPLETE | PASS lockfile validation, no dependency-directory replacement |
| git diff --check | COMPLETE | PASS |

Latest durable private logs: `.sao-backups/verification-2026-10-15/`. Earlier `/tmp/sao-policy-completion/*-latest.log` evidence was lost on environment restart; compilation, regression, policy, restored-data migration, operational and full lifecycle checks were rerun. Baseline regression/type/build checks passed; the old baseline lifecycle failed and later passed without weakening gates.

The resumed local container build exhausted host disk space and interrupted a browser/lifecycle rerun with ENOSPC. The build was stopped. Targeted cache-prune attempts reclaimed nothing on the installed older Docker version; separately approved removal of unused build cache recovered 6.941 GB. Existing images, containers, volumes, source, application records and backups were not removed. Dockerfile now avoids recursive ownership changes copying the entire browser/dependency layer; source is already copied with node ownership, and only /app needs ownership for new writable workspaces. Browser/container/lifecycle retries are recorded separately, not confused with truncated attempts. Docker filter behavior was checked against the [official Docker prune documentation](https://docs.docker.com/reference/cli/docker/buildx/prune/); installed Buildx 0.13.1 differs from current documented filtering capabilities.

Final successful retry logs: `browser-retry.log` (5/5), `lifecycle-retry.log` (48/48), `operations-final.log` (including 167/169-hour London DST accounting boundaries, cached stale-output denial and owner pagination), `representative-migration.log`, `regression.log`, `policy-unit.log`, `build.log`, `docker-build-retry.log` and `container-runtime.log` in the private verification directory. Intermediate fixture import-name collision and denial-message assertion mismatch were corrected and the full operational suite rerun successfully. No final test failure remains among the commands reported as COMPLETE.

B's real-backend scenarios verify authenticated admin draft validation/activation/restore, Settings persistence through actual backend restart, unauthorized agent/user edits, exact prepared reset, provider preservation and owner history moving between 50-record and one-record pages. The mocked preview can emit unavailable WebSocket/font messages; those are not proof of real runtime health. Browser tests are not exhaustive coverage of every policy field or provider.

## 22. Security and reliability

Scoped authorization is checked when actions execute, not just assigned. Owner consent cannot be supplied by an administrator impersonation field. Real Supervisor requests/decisions are scoped, cannot self-approve restricted requests, expire/revoke and are consumed/idempotent. Financial approvals preserve currency/amount/agreement boundaries.

Policy-head locks, durable external publication claims, unique payment/source/period keys, bounded retries, dependency/current-spec checks, emergency stop, worker concurrency enforcement and maintenance locks guard repeated side effects and races. Cached completed task outputs are revalidated against current identity, policy, task state, dependencies and specification before reuse; idempotency is not an authorization bypass. Diagnostics report actual persisted state, not fabricated health. Provider secrets are server-only; backups/session tokens are protected and never model input.

## 23. Unconfigured production parameters

No numeric fixture values were seeded into Northflank. Administrator must approve:

- Discovery independent-source count, evidence age, four weights and qualification threshold; legal jurisdiction/reviewer evidence.
- Agent allowed tools, primary/backup retries and model/reasoning routing; supported actual credentials.
- Specification required sections and safe future-improvement permission.
- Pricing automatic-change permission, percentage boundaries and cadence.
- QC mandatory supported suites, repair retries and performance acceptance.
- Advertising limits/performance interval and genuine owner budget/reinvestment consent.
- Finance supported two-decimal currency, IANA timezone/week boundary, supported cash/verified-received convention, explicit tax/fees treatment, rounding, opening date/loss, owner 20%-weekly consent.
- Deadline industry/complexity/duration, success metrics/periods, warning window, finite extension count/days/price boundaries.
- Shutdown retention and loss-suspension limit.
- Durable backup directory/off-instance copy, public HTTPS application origin, email/Slack destinations and existing configured credentials.

Missing parameters remain visible and block dependent operations. Unsupported accrual/FX/provider capabilities cannot be enabled by assigning arbitrary values.

## 24. Requirement traceability matrix

Each row groups the original report's explicit incomplete items; category sections above identify enforcement, UI, agents and remaining parameters. D and L use persisted database records, not just interfaces.

| Original incomplete requirement | Previous | New | Implementation / persistence / dashboard | Test evidence / dependency |
| --- | --- | --- | --- | --- |
| Fine-grained policy permissions | PARTIAL | COMPLETE | permissions.ts, trpc.ts, policyEngine.ts; admin_permissions; Policies | D/B; live bootstrap separately authorized |
| All states, safe disable, enforcement scope | PARTIAL | COMPLETE | policyEngine.ts; policy heads/versions/assignments; typed editor | U/D; global/business scope only |
| Full impact analysis and assignments | PARTIAL | COMPLETE | policyImpact/assignBusinessPolicy, paginated relationship queries; Policies | D/B; original agreements preserved |
| Actor identity and real execution | PARTIAL | COMPLETE | execution.ts/agentRouting.ts, agent_sessions/task_executions; Agents | D/L; supported server-owned workflows |
| Durable Supervisor/user approval subsystem | PARTIAL | COMPLETE | execution.ts action_approvals; Approvals/Authorizations | D/B; real owner consent required |
| Legal review and classification UI | PARTIAL | COMPLETE | discoveryPolicy.ts, reviews/evidence; Discovery | D/L |
| Ranking, priority, reasoning integration | PARTIAL | COMPLETE | discoveryPolicy/orchestrator/llmProviders; queue and reviews | D/L; actual supported model |
| Governed specifications/conflicts | PARTIAL | COMPLETE | specificationGovernance.ts, immutable versions/conflicts/tasks; Specifications | D/L |
| Required specialist expertise execution | PARTIAL | COMPLETE | specialistReviews/execution/orchestrator, durable review dependencies | D; actual CTO fixture and stronger reasoning |
| Pricing Agent registry-only limitation | PARTIAL | COMPLETE | pricingLifecycle.ts, proposals/history; Pricing/Checkout | D/L |
| Release evidence supplied at deployment | BLOCKED | COMPLETE | releasePipeline/vercel/orchestrator; actual QC and authorizations | D/L; supported static runner |
| Repair/retest/backup/escalation | PARTIAL | COMPLETE | execution/releasePipeline; attempts/defects/tasks | D |
| Post-deployment verification | PARTIAL | COMPLETE | provider artifact retrieval/hash/browser retest; Releases | D/L mock external provider |
| Generic full-stack/mobile/security audit | NOT VERIFIED | NOT VERIFIED | No claim beyond implemented static checks | Real supported runner required |
| Advertising budget/reinvestment consent | PARTIAL | COMPLETE | advertisingPolicy/growthEngine; approvals/accounting; Advertising | D/L |
| Real external advertising publication | BLOCKED | BLOCKED | Supported adapter unavailable; fails closed | Provider/consent required |
| Persisted weekly financial lifecycle | PARTIAL | COMPLETE | financialLifecycle/profitAccounting; periods/items/losses; Finance | U/D |
| Taxes/fees/refunds/disputes/corrections | PARTIAL | COMPLETE | signed payment handling and reviewed reconciliation | D; explicit production treatment |
| External payout | BLOCKED | BLOCKED | transfer_unavailable, no false paid state | Supported transfer/reconciliation mechanism |
| Accrual/cross-currency accounting | NOT VERIFIED | BLOCKED | Explicitly rejected, no implicit conversion | Validated accounting/provider implementation |
| Deadlines/success/finite paid extensions | PARTIAL | COMPLETE | businessLifecycle/operatingCycle, lifecycle/offer/payment records | D/L; approved values |
| Safe suspension/closure/restart | PARTIAL | COMPLETE | businessLifecycle, approvals/obligations/reports; Lifecycle | D/L; irreversible deletion unavailable |
| Lessons and final reports | PARTIAL | COMPLETE | actual Finance/Strategy/Analytics reviews and paginated history | D |
| Settings general/security/agents/monitoring | PARTIAL | COMPLETE | systemControl/SettingsPanels, persisted settings/events | D/B; stored status not external ping |
| Runtime timer/concurrency/save/restore | PARTIAL | COMPLETE | orchestrator/settings validation and runtime application | D/B |
| Backup/export/retention/emergency stop | PARTIAL | COMPLETE | reset backup/executor + systemControl; Settings/Maintenance | D/B; retention is review, not auto deletion |
| External notification delivery | NOT VERIFIED | NOT VERIFIED | Real adapters/configuration, no test paid/external delivery | Live configuration/authorized delivery test |
| Owner authorization history pagination | PARTIAL | COMPLETE | Stable bounded pages, owner check, user-authority filtering and Previous/Next controls | D; distinct non-overlapping pages |
| Scoped reset executor and worker isolation | BLOCKED | COMPLETE | discoveryReset/discoveryMaintenance, archives/reports | D/B; remote execution separately gated |
| Live database inventory/backup | BLOCKED | COMPLETE | Read-only scripts, private verified backup | M with MariaDB collation caveat |
| Live discovery reset | BLOCKED | BLOCKED | No records changed; exact post-migration preview required | Specific administrator confirmation |
| Provider source and data preservation | NOT VERIFIED | COMPLETE | Checkpoint hashes, full-row restored comparison, reset tests | D/M; no remote writes |
| Full database-backed browser tests | NOT VERIFIED | COMPLETE | PASS 5/5; three real-backend tests plus two mock navigation tests | B; not exhaustive field/provider coverage |
| Full lifecycle failure | PARTIAL | COMPLETE | Legitimate active-policy/legal/agent/QC fixtures | L 48/48 |
| Exact MySQL9 compatibility | NOT VERIFIED | COMPLETE | Native MySQL 9.6.0/source collation, row preservation, repeated checksum-audited migrations, native dump restoration and real production startup | See production-readiness report |
| Live MySQL9 rollout | BLOCKED | BLOCKED | Reviewed plan; no live mutation | Secure cutover, snapshot/independent copy, maintenance window and exact approval |
| Production image and non-root browser runtime | NOT VERIFIED | COMPLETE | Optimized Dockerfile and container-runtime.test.ts; no secrets/backup context | C; deployed app/database connectivity not exercised |
| Preserve project/no unspecified defaults | COMPLETE | COMPLETE | No rewrite, dirty workspace retained, production unset values | Diff/source/checkpoints |
| No unauthorized spending/deletion/push/deploy | COMPLETE | COMPLETE | No remote mutation/external action performed | Read-only inspection records |
| Separate methodology audit deferred | COMPLETE | COMPLETE | No separate SA methodology investigation | Scope preserved |

## 25. Remaining blockers and handoff

1. Approve the exact Northflank migration/recovery plan only after reviewing the exact-version staging results, verified backups, independent storage and secure runtime/credential-rotation prerequisites. No migration is implied by this report.
2. Reverify/provision the existing authorized administrator with the audited exact-confirmation script.
3. Approve required production parameters, model/provider capabilities, business-specific assignments and genuine owner agreements.
4. Prepare a NEW executor reset preview after rollout, verify durable backup/fingerprints/counts and obtain separate exact-target deletion/archive consent.
5. Unsupported external advertising/payout, accrual/FX and generic generated backend/mobile QC remain explicit limitations. Exact MySQL 9 staging and genuine provider metadata checks now pass, but paid provider execution and secure production activation are not implied. See the production-readiness report.

The supported software lifecycle is materially beyond the previous foundation-only implementation and passes actual isolated workflows. Production operation and remote reset are not represented as completed.
