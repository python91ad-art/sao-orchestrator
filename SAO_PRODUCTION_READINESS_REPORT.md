# SAO Production Readiness Report

Date: 2026-10-15. Scope: the existing application, six production-readiness areas; no separate Situational Arbitrage methodology audit.

## 1. Executive status

**Production activation: BLOCKED.** Exact-version staging, backup restoration, real provider metadata verification and supported workflow regression testing are implemented. No live migration, privilege grant, policy activation, consent grant, discovery deletion/archive, charge, payout, advertising publication, production deployment or Git push was executed.

**Critical discovery:** the deployed `sao/sao-app` runtime does not configure `NODE_ENV=production`, `JWT_SECRET` or `CREDENTIAL_ENCRYPTION_KEY`. All seven stored provider ciphertexts decrypt using the existing legacy default derivation. This is a confirmed security blocker, not merely a local missing-key error. No key values were printed or changed. The new Docker image explicitly sets production mode, uses the existing fail-closed session-secret requirement and removes development-only runtime dependencies. Do not deploy it without a secure secret/credential-rotation plan: setting a new secret alone would make existing ciphertexts unreadable.

## 2. Six-area task matrix

| Area | Already implemented / completed technical work | Remaining configuration / external verification | Approval or consent | Status |
| --- | --- | --- | --- | --- |
| MySQL 9 compatibility | Exact MySQL 9.6.0 restoration, repeated migration, original-field checks, native SQL restoration, collation negative test, durable migration checksums, real production-container startup | Platform free-disk/metadata-lock visibility, provider snapshot and independent backup | Separate live migration and maintenance-window approval | COMPLETE for staging; live rollout BLOCKED |
| Existing administrator | Existing role/owner links re-read; user explicitly confirmed account; precise read-only 16-permission preview; CLI duplicate-argument/role-race protections tested | Actual authenticated login/access after rollout | Exact-target privilege grant, after schema migration | BLOCKED for live provisioning |
| Nine policies | Shared readiness descriptors, all-category dashboard, typed review plan/offline validation, unsupported accounting/QC configurations rejected | Approved numerical/business-specific values; active versions and assignments | Administrator validation/activation; owner consent where applicable | BLOCKED for production activation |
| Providers/models/owners | Genuine authenticated GET metadata for configured providers using deployed secret configuration in memory; preserved full-row fingerprints; 21 owner links inspected | Paid inference/reasoning execution, invalid catalog IDs, payment/deployment execution; secure secrets | Owner financial/operational consent, explicit budget for any billable test | PARTIAL |
| Discovery maintenance | Fresh backup/inventory; native restoration; existing isolated scoped-reset tests and protected provider/business checks | Post-migration executor preview/fingerprint, independent copy, writer isolation in the live maintenance window | Separate exact-reset confirmation | BLOCKED for live execution |
| Advertising/payout/broader QC | Real capability inspection; dependency security fixes; supported static QC and unsupported-framework denial; real SAO backend/database startup/auth checks | Advertising credentials/adapters, payout recipient/onboarding/currency reconciliation; generated backend/mobile runners do not exist | Owner spending/transfer authorization and provider onboarding | PARTIAL; unsupported actions remain unavailable |

No registered role, model catalog, saved provider status or calculated settlement is presented as successful external execution.

## 3. Repository preservation and checkpoint

Preserved the existing substantial uncommitted workspace. New source checkpoint: `.sao-backups/source-production-readiness-20261015T101309Z.tgz`, archive readability verified, mode 600 under private mode-700 storage. Excludes environment/tool credential directories, Git, dependencies/build output, database backups and local database data. Existing backups were not overwritten or deleted.

Fresh private evidence is under `.sao-backups/production-readiness/`, excluded from Git and image context. Inspection does not permanently rewrite connection settings. Runtime secrets retrieved from Northflank are used only in process memory and are not included in reports or subprocess arguments.

## 4. Actual database and platform inspection

- Existing forward reused: `127.24.1.1:3306`; no second forward started and the user's forwarding terminal was untouched.
- Database `eb2bfb559429`; server `sao-sql-primary-0`; engine `9.6.0`, source distribution.
- Source database and all 24 existing application table defaults: `utf8mb4_general_ci`. MySQL version alone does not imply `utf8mb4_0900_ai_ci` for this database.
- Four existing `__drizzle_migrations` entries preserved. Lifecycle, policy and operational tables remain absent on the live target; 0013–0015 have not been applied remotely.
- Existing tables are InnoDB; original foreign-key inventory is empty. Column types/defaults/precision, indexes, triggers and migration rows were inspected read-only. No source triggers/routines were present during backup preparation.
- Information-schema data-plus-index size observed: 44,335,104 bytes; this is not filesystem usage or free capacity.
- Northflank metadata: addon `sao/sao-sql`, MySQL 9.6.0, one replica, 6,144 MiB allocated storage, `nf-compute-20`, running. Actual free disk and a production lock-duration estimate are NOT VERIFIED. SQL access cannot inspect `performance_schema.metadata_locks` with the current account.
- Existing `sao-build` and `sao-app` services were identified read-only. No service was paused, restarted, redeployed or reconfigured.
- Fresh public GET checks at 2026-10-15T11:08:15Z returned HTTP 200 for both /api/health (healthy) and /api/ready (ready/database connected). This does not negate the authentication/encryption blocker or prove new policy readiness.

## 5. Exact MySQL 9 staging and migration compatibility

Official `mysql:9.6.0` image pulled, distribution digest `sha256:c5df04bee1a42b74a5841c6409e669cf62126cd0416f00c1cea8ab933b9361b9`. [Official image tags](https://hub.docker.com/_/mysql/tags?name=9.6.0) provide the selected exact-version image.

Disposable MySQL containers have no network, no published ports, bounded CPU/memory/processes, temporary data storage and disposable-only database credentials. The original JSON backup is unchanged; no collation substitution is made in this test. Exact source collation is explicitly supplied and verified instead of assumed.

Verified:

- Full source schema/data restoration with checksums and row-content verification.
- Reviewed runner applies lifecycle infrastructure, 0014 and 0015 plus its existing additive compatibility/index steps. 0013 infrastructure is embedded in the runner; the plan does not pretend the runner invokes the standalone 0013 file directly.
- Repeated migration applications succeed, preserving every original row and protected field, including encrypted provider values and original ownership.
- A deliberately wrong staging schema collation is rejected **before any DDL** by the new preflight; the original table inventory remains unchanged. This addresses the initial harness error that assumed the MySQL default rather than the source database default.
- Synthetic ownerless business remains NULL after migration; no administrator ownership is guessed.
- Native MySQL dump checksum/import and protected provider/business/user/payment counts verified in a separate disposable schema.
- One checksum-linked `schema_migration_verified` event is persisted in existing `operational_events` for identical repeated migrations. No second migration-ledger system is added; the original Drizzle history is preserved.
- Actual production entrypoint starts against the restored migrated MySQL schema; health, database readiness, compiled client and unauthorized policy API denial are checked inside the container. Test-only emergency stop and stopped automation are applied to the clone **after** original-record preservation checks.

Representative runs measured approximately 0.7–1.7 seconds per migration application on the disposable 2-vCPU/2-GiB fixture. These are not promised production durations: production load, storage, replica availability and metadata locking differ. MySQL DDL is not transactionally reversible as one unit.

Initial failures were investigated: temporary initialization-server connections caused EPIPE, socket cleanup masked the first error, and a guessed staging collation caused a foreign-key incompatibility. Final tests wait for the final server, isolate private socket paths, preserve the inspected source collation and stop incompatible migrations before writes.

## 6. Production migration plan and authorization

Live execution is BLOCKED until a provider-supported snapshot, independently stored verified backup, reviewed maintenance window and explicit exact-target approval are available. The user supplied no snapshot ID or independent destination. Read-only Northflank inspection found no configured custom backup destinations; this does not prove there are no internally managed historical backups.

Reviewed set: 0013 lifecycle infrastructure via the existing runner, 0014 policy engine, 0015 operational policies, additive compatibility columns/indexes and checksum audit. No application/provider table is dropped or truncated. Existing identifiers/collations/ownership must remain unchanged. See `SAO_POLICY_MIGRATION_PLAN.md` for command scope, checksums, writer pause and recovery.

Do not invoke `npm start` as a live dry run. Its migration and automation behavior is explicitly exercised only in disposable staging. A live migration approval must not authorize privilege grants, policy activation, discovery deletion or deployment by implication.

## 7. Administrator verification and permission preview

User explicitly confirmed existing administrator `9f64c09d-6d13-4fa9-9616-d294bddc890b`. Current DB role is admin; last recorded sign-in is 2026-09-24. All 21 existing businesses reference this same existing account. This is not a new login test or consent grant.

Preview target: `eb2bfb559429/sao-sql-primary-0/9f64c09d-6d13-4fa9-9616-d294bddc890b`.

Planned explicit permissions: `policies.view`, `policies.edit`, `policies.validate`, `policies.activate`, `policies.history`, `policies.restore`, `policies.impact`, `policies.assign`, `maintenance.discovery`, `agents.manage`, `approvals.request`, `approvals.supervisor`, `specifications.manage`, `finance.manage`, `lifecycle.manage`, `settings.manage`.

Live `admin_permissions` is absent, so no permission rows were granted. The CLI previews existing/missing grants, rejects ambiguous flags, rechecks and locks the role in the grant transaction, avoids duplicate grants and audits actual application. Isolated preview/ambiguous-input/no-mutation and API/user/agent denial tests pass. Actual live dashboard access after provisioning remains NOT VERIFIED.

## 8. All nine production policy statuses

All nine live categories are **POLICY_NOT_CONFIGURED**, because the new policy tables do not exist on the target. No numeric fixture values were seeded and no category was activated.

`SAO_PRODUCTION_POLICY_PLAN.json` is a review-only proposal, explicitly NOT_APPROVED. `scripts/validate-production-policy-plan.ts` reads it without DB access or activation and correctly exits 3 for missing approved values. Policies now has one expandable all-nine readiness view with missing names, accepted types/choices, numerical validation rules and affected workflows.

| Category | Required production decisions / safe review options |
| --- | --- |
| Discovery | Approve independent-source count, freshness, four weights and qualification threshold. Consider demand-led versus evidence-led ranking according to the business; no numeric weights proposed as approved. Legal reviewer/jurisdiction/evidence are recorded per opportunity. Complexity affects actual reasoning, not ranking. |
| Specification | Review required sections/expertise/acceptance manifest and whether future-only automatic improvements are allowed. Keep immediate requirement changes governed. |
| Agents | Approve actual tool allowlist, primary/backup attempts, model routing and escalation. Prefer least privilege and verified fallback models; no retry values invented. |
| Pricing | Review evidence/cost/customer commitments, currency, change boundary/cadence and auto-change permission. Manual-only until approved low-risk boundaries is the conservative existing proposal. |
| QC | Only the implemented functional/integration/security/performance static suites may be selected. Approve latency and repair limits; unsupported runners fail validation rather than masquerading as active. |
| Advertising | Organic preparation first; approve budget/performance intervals, actual campaign scope and owner spending/reinvestment authorization. No publisher is available. |
| Finance | Agreed 20%/80% positive net profit, weekly. Choose supported two-decimal currency, reporting timezone/cutoff, verified-received cash convention, reviewed taxes/fees/refunds, rounding, opening date/loss and original owner agreement. Accrual/implicit FX rejected. |
| Deadlines | Assess each business's actual industry/complexity and approve duration, success periods/metrics, warnings, finite extension count/duration and fixed price bounds. Do not assume all 21 businesses share one industry. |
| Shutdown | Approve loss/retention parameters with legitimate obligation requirements. Suspension, Supervisor closure, owner irreversible consent and fresh-evidence/new-spec restart are mandatory; no automatic resource/customer deletion. |

These are review options, not administrator-approved business values. Required owner authorization expiry/scope and business-specific financial assignments must be chosen explicitly after real policy versions exist.

## 9. Business assignments and owner consent

All 21 owner references resolve to the confirmed existing administrator account; none are NULL in the inspected live dataset. No new policy assignments, approvals or weekly accounting records exist because the relevant tables are absent.

New-subsystem consent is NOT RECORDED. Existing off-system or legacy contractual arrangements are NOT VERIFIED, not assumed absent. Do not silently migrate those agreements. Prepare actual owner-facing requests only after approved versions, currency, scope/amount/expiry and purpose are known. No invalid placeholder requests or fabricated owner decisions were inserted. Isolated owner authentication, scope, expiry/revocation, pricing, extension and financial-consent tests remain passing.

`activePolicy` now returns POLICY_NOT_CONFIGURED for a business without an explicit assignment rather than falling back to a newly activated global head. New businesses still snapshot active versions during creation. Isolated tests verify legacy non-inheritance, denied unconsented financial assignment, successful exact-version owner consent/assignment and absence of any automatically granted profit-sharing consent.

## 10. Genuine provider/model verification

Read-only `scripts/production-readiness.ts` uses fixed allowlisted GET metadata endpoints, bounded timeouts, no redirects, response-shape validation and no persistence of response secrets/balances. It distinguishes local configuration from the deployed runtime. Full provider row fingerprints before/after remain identical.

| Deployed provider | Fresh result | What is not proved |
| --- | --- | --- |
| Vercel | HTTP 200, authenticated user metadata using existing stored key | No new deployment, permissions for publication, artifact retrieval or reconciliation exercised live |
| Groq | HTTP 200, authenticated model catalog; both GPT-OSS 120b/20b IDs present | No billable generation/tool/reasoning execution or measured context limit |
| Cerebras | HTTP 200, authenticated catalog; GPT-OSS 120b present; configured llama-3.1-8b fallback not listed | Invalid fallback must be reviewed; no generation |
| Gemini | HTTP 200, authenticated catalog; gemini-3.1-flash-lite matches catalog alias models/gemini-3.1-flash-lite | Catalog-prefix normalization only; no generation or reasoning execution claim |
| OpenRouter | HTTP 200 authenticated `/auth/key`, followed by model metadata; GPT-OSS 120b catalog match | Provider advertises reasoning/tools; actual execution remains NOT VERIFIED |
| Tavily | HTTP 200 authenticated usage metadata | No credit-consuming search or fabricated discovery evidence |
| ONS | HTTP 200 validated public dataset response | Public endpoint has no credential authentication; end-to-end real discovery intake not executed |
| Stored custom payment record | Preserved/decryptable, but registry adapter remains unsupported | Not silently renamed or converted into a Stripe provider |

Classification is LIMITED for authenticated metadata success, not fully OPERATIONAL. Groq reasoning mapping remains deterministic in code and preserves stronger requirements; [official reasoning documentation](https://console.groq.com/docs/reasoning) is not a substitute for an authorized execution test. Request a specific inference budget before any billable reasoning test.

Final metadata evidence: `.sao-backups/production-readiness/model-capabilities-final.json` (2026-10-15, zero remote writes). Groq GPT-OSS 120b/20b and OpenRouter GPT-OSS 120b advertise 131,072 context tokens and 65,536 output tokens. These are provider-advertised limits, not measured acceptance tests; absent catalog capability fields remain null rather than assumed supported. The administrator identity confirmation does not authorize grants. No backup destination, snapshot ID or approved policy-values file was supplied in the subsequent reply.

Separate local-config checks: Stripe account GET authenticates but reports charges and payouts disabled; NOWPayments balance metadata returns HTTP 403. Balance values are not logged. These local keys are not configured in the inspected deployed runtime and must not be presented as live production payment readiness.

## 11. Security prerequisite and secret preservation

Deployed service configuration was read into memory only; DB target/service/project identity was checked before selecting its key derivation. An additional read-only diagnostic inside the actual existing container, using dotenv preload and printing booleans only, returned nodeEnv=unset, jwtConfigured=false, encryptionKeyConfigured=false and localEnvFile=false. Successful legacy-default decryption of all seven ciphertexts confirms the encryption risk independently. This is distinct from the earlier local-secret mismatch and explains why local fallback API keys worked while direct stored-key reads failed. No auth-forgery/exploitation test was attempted.

Provider definitions, ciphertexts, names, priorities, enabled states and statuses were not changed. Before/after full-row fingerprint for seven credentials plus 24 deployment-provider rows:

`b2c2dd06596cc7267509ec8a9d923b0bc0b5bbe6a53d4b5b24190f7d0a30e3dd`.

The new image enforces NODE_ENV=production; existing cookie code rejects a missing JWT secret. A new negative container test verifies that refusal. Secure activation needs a separately approved, backed-up coordinated encryption-key rotation preserving every provider ID/plaintext/configuration, plus secure session-secret provisioning and re-login notice. Do not just change JWT_SECRET: legacy provider decryption would break. This task did not overwrite ciphertexts or set new live keys.

## 12. Advertising, payout and QC integrations

- Advertising: no Google/Meta/TikTok credential set exists in inspected local or deployed configuration. Existing channel adapters do not genuinely publish. OAuth/account access, a selected implemented adapter, budget/scope and owner consent are required. Internal plans are not campaigns. External execution remains BLOCKED.
- Payouts: no verified live payout recipient/onboarding mechanism or supported currency/reconciliation arrangement exists. Local Stripe account capabilities are disabled; local NOWPayments authentication fails and deployed payment environment keys are absent. Crypto payout APIs additionally require authentication/verification and explicit conversion rules; do not manufacture fiat cash from nominal crypto invoice values. Keep transfer_unavailable; no funds sent. [NOWPayments' API documentation](https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description) distinguishes read-only balance access from JWT-authorized payout creation.
- Broader QC: actual generator prompt produces static HTML/CSS/JS, not a backend. Independent static artifact browser/security/performance checks remain genuine and hash-bound. Unsupported framework/suite requirements now fail explicitly, including cached-release admission. Browser subprocesses receive only allowlisted system/locale paths, not JWT/database/provider credentials; WebRTC and speculative/prefetch network paths are disabled in addition to request interception/CSP. Real container tests execute the actual artifact helper with network disabled and CPU/memory/process limits. The runtime's ordinary browser checks still share the application's container resource envelope; this is not a generic per-job VM isolation guarantee, generated backend/mobile runner or comprehensive security audit.
- Dependency audit found 1 critical, 7 high, 12 moderate and 3 low production advisories. Targeted overrides patch proxy-addr to 2.0.8, qs to 6.16.0, brace-expansion 2.x to 2.1.7 and undici 7.x to 7.29.1. Frozen lockfile installation and fresh audit now report **zero production advisories**. All existing regression tests are rerun. Build/test-only tooling is pruned from the runtime image.

## 13. Fresh discovery inventory and live cleanup status

Fresh read-only observations reproduce, rather than assume, the earlier counts:

- 1,335 gaps: 775 eligible for scoped deletion and 560 protected for archive/retention.
- 1,336 queue rows: 763 eligible synthesis rows; 555 protected synthesis rows; all 18 non-synthesis rows retained, including two orphan failed deployment jobs. 571 rows reference protected gaps.
- 21 established businesses; 24 deployment-provider rows; seven credential rows; zero payment rows; 639 business/security audit logs and 178,339 permanent deployment health records remain protected.

No live records deleted or archived; no live queue changes, cache invalidation or counter reset. Existing reset executor and isolated tests remain operational. A valid **post-migration** prepared executor fingerprint is not available because required tables/admin grants are absent. The fresh pre-migration inventory is not deletion authorization. After separately approved migration/provisioning, regenerate the exact executor preview, backup, provider fingerprints, processing-worker check and administrator confirmation before any reset.

## 14. Backups and recovery

Fresh JSON backup:

- `.sao-backups/discovery-reset-northflank-fb9d8cb4-87c5-4fd5-8c90-864dcc023f86.json`
- SHA-256 `0b635f5d90a1e79d084249a555859625b176de31a76b3bb5bead849c1512548e`.
- Full application table schema/data, verified readability/hash; restored in exact MySQL staging and compared field-by-field after migration.

Full native MySQL logical backup:

- `.sao-backups/production-readiness/mysql9-2801bad9-b0c6-4052-b4de-f0017f0a79ab.sql`
- SHA-256 `717f063eb985c531ec43a9fef51925947e69ef2b52510ff9458d358f23b5b369`; 28,674,459 bytes.
- Consistent InnoDB transaction, schema/data/routines/triggers/events, no requested table locks; matching client version and CA verification, credentials only in temporary private option files removed afterward.
- Complete SQL import and protected record counts verified in separate disposable MySQL schema.
- Private directories/files use 700/600 permissions. An initial failed zero-byte .incomplete dump is retained and is NOT a verified backup.

These are protected Kali filesystem copies outside the Northflank application/database instance. No second encrypted independent destination, approved durable retention or Northflank-managed full-addon snapshot has been supplied or verified. Database-server users/grants/platform configuration are not claimed backed up by a per-database dump. [Northflank documents native backups and disk snapshots separately](https://northflank.com/docs/v1/application/production-workloads/persistent-storage-in-production). Obtain the provider snapshot and approve the independent recovery-storage arrangement before live DDL/reset. Restore to an isolated target first; never blindly drop live tables to simulate rollback or lose post-backup financial events.

## 15. Exact verification commands

Private final logs are in `.sao-backups/production-readiness/`; commands use disposable data unless explicitly marked read-only live.

| Command | Status / evidence |
| --- | --- |
| ./node_modules/.bin/tsc -p server/tsconfig.json --noEmit | COMPLETE — PASS |
| ./node_modules/.bin/tsc -p client/tsconfig.json --noEmit | COMPLETE — PASS |
| npm test | COMPLETE — PASS, patched production dependencies |
| node --import tsx tests/policy-engine.test.ts | COMPLETE — PASS readiness, immutable rules, unsupported configuration denial, deterministic decisions/arithmetic |
| node --import tsx tests/policy-db-isolated.test.ts | COMPLETE — PASS migrations, read-only provisioning/duplicate rejection, authorization, real QC, finance, reset/provider preservation |
| node --import tsx tests/e2e-isolated.test.ts | COMPLETE — PASS 48/48; controlled external providers, not live deployments |
| ./node_modules/.bin/playwright test | COMPLETE — PASS 5/5; three real local-backend scenarios, two mocked navigation scenarios |
| corepack pnpm audit --prod --json | COMPLETE — 0 production advisories after targeted patches |
| npm run build | COMPLETE — PASS; existing bundle-size/CJS warnings |
| docker build -t sao-policy-verification:local . | COMPLETE — PASS, production mode and dev-only dependencies pruned |
| docker run --rm --network none --memory 1g --cpus 2 --pids-limit 512 --entrypoint node sao-policy-verification:local --import tsx tests/container-runtime.test.ts | COMPLETE — PASS non-root Firefox, actual artifact helper, private-context exclusions, no dev-only tooling and missing-JWT startup denial |
| node --import tsx tests/live-backup-migration-isolated.test.ts .sao-backups/discovery-reset-northflank-fb9d8cb4-87c5-4fd5-8c90-864dcc023f86.json --mysql9 --database-collation=utf8mb4_general_ci --native-dump=.sao-backups/production-readiness/mysql9-2801bad9-b0c6-4052-b4de-f0017f0a79ab.sql --native-sha256=717f063eb985c531ec43a9fef51925947e69ef2b52510ff9458d358f23b5b369 | COMPLETE — exact MySQL, negative preflight, repeated checksum-audited migrations, native restore and actual production startup |
| node --import tsx scripts/production-readiness.ts eb2bfb559429 sao-sql-primary-0 --probe --deployed-runtime | COMPLETE — read-only live SQL and real GET-only provider verification; no secrets printed |
| node --import tsx scripts/grant-policy-permissions.ts 9f64c09d-6d13-4fa9-9616-d294bddc890b --local-forward | COMPLETE — read-only preview only; no grant |
| node --import tsx scripts/validate-production-policy-plan.ts SAO_PRODUCTION_POLICY_PLAN.json | BLOCKED — expected exit 3 for missing approved production parameters; no mutation |
| git diff --check | COMPLETE — PASS |

Initial dependency installation stopped at a module-directory prompt; a lockfile-only resolution and explicit CI frozen install completed. Transient package-download retry recovered. Existing Resend/React peer warnings and bundle-size warnings are documented, not disguised as introduced application failures.

## Implementation files

- `scripts/production-readiness.ts`: exact-identity SQL/schema/owner inventory, controlled local/deployed-runtime metadata probes and private evidence; no DB mutations.
- `scripts/native-production-backup.ts`: native version-matched logical backup, protected ephemeral options/CA files, bounded execution and checksum receipt.
- `scripts/grant-policy-permissions.ts`: existing/missing preview, strict CLI parsing, locked role verification and existing audited grants; live preview only.
- `shared/policyReadiness.ts`, `shared/policyContracts.ts`, `client/src/pages/dashboard/Policies.tsx`, `SAO_PRODUCTION_POLICY_PLAN.json`, `scripts/validate-production-policy-plan.ts`: unified field readiness/review process and supported-configuration validation.
- `server/services/policyEngine.ts`: explicit assignment requirement for legacy businesses; no silent global inheritance.
- `run-migration.js`, `server/services/discoveryReset.ts`: pre-DDL collation safety, existing-event checksum audit and source database metadata in future backups; no new duplicate schema system.
- `server/services/releasePipeline.ts`: unsupported framework/cached-release refusal and credential-free, network-hardened browser subprocesses.
- `Dockerfile`, `package.json`, `pnpm-lock.yaml`: production auth mode, pruned runtime graph and targeted security patches.
- `tests/live-backup-migration-isolated.test.ts`, `tests/container-runtime.test.ts`, `tests/policy-db-isolated.test.ts`, `tests/policy-engine.test.ts`, `tests/fixtures/operationalAssertions.ts`: real exact-version/restoration/startup, failure/permission/consent/framework/browser isolation checks.
- This report and both existing implementation/migration reports: current evidence, limitations and separate approval scopes.

## 16. Remaining approvals and inputs

1. **Urgent security plan:** authorize coordinated secret provisioning/credential re-encryption in a maintenance window, preserving all provider contents and recording rollback evidence. No secret should be pasted into chat; use protected existing secret management. Existing production auth/default encryption cannot be considered ready.
2. Provide a provider snapshot ID and an encrypted independent backup destination/retention/budget. None was supplied; no cloud backup resource or charge was created by this work.
3. Review/fill `SAO_PRODUCTION_POLICY_PLAN.json`, including business-specific variants, real opening accounting state and authorization scopes/expiries. Mandatory 20%-weekly safeguards are fixed; unknown numerical values remain unset.
4. Separately approve reviewed live migration target/window/checksums; then separately approve the 16 explicit grants for the confirmed administrator. Neither action has happened.
5. After activation/assignments, authenticated owners must consent where required. Then regenerate and separately approve the exact discovery reset fingerprint/counts/backup. Migration approval never authorizes deletion.
6. Supply a supported advertising account/adapter and a genuine payout/onboarding/reconciliation mechanism, or retain those features unavailable. Billable reasoning, live checkout/deployment and notification-delivery tests need their own appropriate authorization/configuration.

The safely executable technical readiness work is implemented and verified. Production activation, secure live secret migration and exact live cleanup remain deliberately BLOCKED, not falsely marked COMPLETE.
