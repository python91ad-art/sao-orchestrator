# SAO Frontend / Backend Investigation and Repair

Date: 2026-10-15. Existing target: `sao/sao-app`, build service `sao-build`, branch `sao-policy-update-20261015`, existing URL `https://http--sao-app--pnzzhg9j6qvv.code.run/`.

## Findings and root causes

1. **Confirmed primary cause: outdated runtime source/image.** Read-only Northflank runtime metadata reports branch `main`, deployed SHA `babf1f432f7562f5085b642c8175b5002c347b8b` and last deployment transition 2026-09-29. GitHub `main` still points to that SHA; the requested branch points to `5ce84b05ad19d7522052f6e6b8c6b2d33064b656`. `5ce84b0` is an empty redeployment-trigger commit on the newer branch; it does not change the tree from `abe2542`. The build service reports SUCCESS on 2026-10-15, but that is not evidence the runtime switched to the new branch/image. No Northflank setting was changed.
2. **The live backend is old too, not just a cached browser.** Unauthenticated GETs to `policies.overview`, `operations.preferences`, and `infrastructure.overview` return HTTP 404 / `NOT_FOUND` / “No procedure found”. `auth.me` returns the expected HTTP 401. The new procedures exist in the local root router; isolated authenticated API tests verify them. A new frontend alone cannot repair an old API server.
3. **Asset evidence independently confirms missing features.** Live `/assets/index-BJZnu_lH.js` is 444,945 bytes, SHA-256 `6213d3b31856bd5acb60efff670e5ebd1263ae37471b22734a533caa58d25cdd`. It contains the old Policies label, but not My Authorizations, Operations, Lifecycle Infrastructure or the new profit-sharing UI identifiers. Live CSS is `/assets/index-4grOv6PP.css`, SHA-256 `0a91578c13cedb7bcf565e3de7f054877d19140f73b2e28ea5edde5145a550c3`. Local production output includes the new components. Hard-refreshing cannot introduce code absent from the served image.
4. **Local deep links/history were incomplete.** Dashboard selection previously used only local component state/localStorage. A `/dashboard/policies` or `/dashboard/operations` URL silently opened the remembered page/Overview. Navigation now updates URLs, restores supported deep links/query links and responds to browser history. Existing localStorage selection and unsaved-change guards remain in place.
5. **Frontend role guard inconsistency.** Registration Access was hidden from non-admin navigation but a saved selection could still mount its component. A centralized admin-page guard now covers Registration Access, Operations and Policies. Backend authorization is unchanged and remains mandatory.
6. **Cross-account cache reuse.** Authentication switched identities without canceling/clearing React Query's shared cache. Successful login, registration and logout now discard prior identity data and in-flight queries. No permissions are granted by this change.
7. **Infrastructure errors appeared as indefinite loading.** Failed read queries were not surfaced in the Infrastructure workspace. A visible alert now reports actual failures, including access/schema/runtime errors, without inventing records or health status.
8. **Static delivery diagnostics were insufficient.** No build identity was shipped; SPA fallback also left unknown `/api` GETs unanswered. The shared delivery helper now returns normal 404s for unmatched API/missing asset paths, delivers fresh HTML/build identity and caches only content-addressed assets as immutable. The build manifest hashes final emitted bytes, including post-processed CSS.

## Current production state (fresh read-only inspection)

- Database `eb2bfb559429`, server `sao-sql-primary-0`, MySQL 9.6.0, `utf8mb4_general_ci`.
- **65 tables now exist**, including lifecycle, policy and operational tables. This supersedes the previous report's historical observation of 24 tables. No migration was run by this investigation.
- 1,335 gaps, 21 businesses, 1,336 queue items and seven integration credential records remain. All 21 businesses have owners; none was reassigned.
- `admin_permissions` exists but has **zero grants**. Role admin alone must not bypass the explicit permission requirement. Provisioning the confirmed administrator requires separate approval; no grant was made.
- All nine categories remain `POLICY_NOT_CONFIGURED`. Visible schema/readiness is not authorization to invent or activate policy values. The finance model remains 20% of verified positive net profit weekly, not 20% of gross revenue.
- Fresh deployed configuration presence checks still show production mode unset and no configured JWT/encryption secret. Read-only readiness detects legacy-default credential encryption. A safe coordinated security cutover remains a deployment blocker; no secrets/ciphertexts were changed.
- Provider preservation fingerprint before and after read-only inspection: `b2c2dd06596cc7267509ec8a9d923b0bc0b5bbe6a53d4b5b24190f7d0a30e3dd` for seven credentials and 24 deployment-provider rows. Provider source files, IDs, configuration, encryption and enabled states are untouched.
- No real administrator login was attempted without supplied credentials. Authorized live user-specific behavior remains NOT VERIFIED until a controlled rollout/login; isolated authenticated tests are not described as live verification.

## Feature traceability

| Feature | Existing implementation and frontend entry | Live / operational limitation |
| --- | --- | --- |
| My Authorizations | `operations.ownedBusinesses`, owner workspace/decision APIs; `Authorizations.tsx`, `/dashboard/authorizations` | Missing from old live image; genuine owner identity/consent required |
| Policies/versioning | `policyEngine.ts`, `policies` and `operations` routers; `Policies.tsx`, `/dashboard/policies` | Old live API lacks route; explicit grants absent; nine production versions unconfigured |
| Operations/workflow controls | `operationsRouter.ts`, `Operations.tsx`, `WorkflowControls.tsx`, `/dashboard/operations` | Admin-only; policy/approval/provider prerequisites remain enforced |
| Infrastructure | `infrastructure.ts`, infrastructure/specialist routers; `Infrastructure.tsx`, `/dashboard/infrastructure` | Missing from old live image; authenticated read access and admin-only mutations retain backend restrictions |
| Checkout/payments | `operations.publicPrice`/`checkout`, payment router and signed webhooks; `Checkout.tsx`, `/checkout?business=ID`, deployment checkout links/CryptoPayments | No fake quote/payment; authenticated purchasing and approved price/active business/provider required |
| Settings/dashboard | Existing Settings panels, diagnostics and setting APIs; `/dashboard/settings`, Overview/Analytics | New controls absent from old image; privileged mutations remain protected |
| Deployment management | `Deployments.tsx`, deployment services and verified release pipeline | Existing live legacy page exists; governed release requires actual independent artifact evidence and authorization |
| Providers | Existing Providers page, registry and credential crypto | Existing infrastructure preserved; a saved provider is not proof of external execution |
| Authentication | Existing login/registration/auth router/cookies; repaired cache isolation | Live `auth.me` unauthorized response verified; secure production session configuration still unresolved |
| Profit accounting | `financialLifecycle.ts`, `profitAccounting.ts`, finance APIs; Operations Finance / Infrastructure Finance | Verified-positive-net-profit 20% rule preserved; production accounting policy/owner consent absent; payouts unavailable |
| Administrator permissions | Existing `adminProcedure`, explicit policy permissions and provisioning script | Zero live grants; no automatic bootstrap or privilege changes |
| Release authorization/QC | `releasePipeline.ts`, release APIs; Operations Releases / Infrastructure QC | Actual supported static artifact tests; unsupported output runners cannot pass; no fabricated release |
| Business lifecycle | `businessLifecycle.ts`, lifecycle APIs; Operations Lifecycle / Infrastructure Lifecycle / owner authorizations | Missing policies/consent block dependent actions; no closure/deletion/restart bypass |

Required imports, root router exports and frontend dependencies exist. No missing component package was verified; no dependency replacement was necessary. Financial, advertising and unsupported QC limitations were not disguised by new menu items. There is no feature flag explaining the old assets/API: runtime revision mismatch is directly evidenced.

## Exact repair files

- `client/src/lib/dashboardRoutes.ts`: supported route resolution and admin-page classification.
- `client/src/pages/Dashboard.tsx`: deep links, URL navigation/history, saved-page compatibility and consistent admin guard.
- `client/src/hooks/useAuth.tsx`: identity-bound query cancellation/cache clearing.
- `client/src/pages/dashboard/Infrastructure.tsx`: visible actual query failures.
- `client/src/pages/dashboard/SettingsPanels.tsx`: Settings workspace links use actual dashboard URLs rather than reloading a now-explicit Settings URL with a conflicting localStorage value.
- `client/vite.config.ts`: final-byte SHA-256 asset/build manifest; explicit optional revision, never guessed.
- `Dockerfile`: non-secret `SAO_BUILD_SHA` build argument; existing production protections unchanged.
- `server/_core/frontend.ts`, `server/_core/index.ts`: shared real production delivery, cache headers and non-hanging API/asset 404 handling.
- `tests/frontend-delivery.test.ts`: route/access/cache/404 regression checks.
- `tests/browser/real-policy.spec.ts`: direct-link/history/identity-switch/role/checkout, real read-API and served manifest verification.
- `tests/fixtures/browserBackend.ts`: reuse actual production frontend middleware rather than a divergent static server.
- `docs/northflank-deployment.md`: existing-service-only, approval-gated exact-image remediation and validation procedure.
- This report: evidence, limitations and handoff. No migration, provider, encryption, authorization grant or financial policy source was changed.

## Preservation and checkpoint

The workspace was clean at the starting commit. Created local Git checkpoint branch `checkpoint/frontend-investigation-20261015-5ce84b0` at `5ce84b0` before editing. Stayed on `sao-policy-update-20261015`; no commit, push, remote branch modification, production restart, migration, deletion, policy activation, secret update, transfer or external publication occurred. Existing backups were not overwritten.

## Verification

Baseline `npm test`, server/client TypeScript and production build passed before edits. Final commands and outcomes are recorded below after execution. Tests use disposable databases and controlled external providers; no live paid/deployment operation was tested.

| Command | Final result |
| --- | --- |
| `npm test` | PASS existing backend/unit/control regression suite |
| `node --import tsx tests/policy-engine.test.ts` | PASS nine contracts, deterministic gates, authorization and safe financial arithmetic |
| `node --import tsx tests/policy-db-isolated.test.ts` | PASS disposable migration, explicit permissions, real artifact QC, owner consent, persisted accounting, release/pricing/lifecycle/reset preservation |
| `node --import tsx tests/e2e-isolated.test.ts` | PASS **48/48** lifecycle stages, controlled external providers |
| `./node_modules/.bin/tsc -p server/tsconfig.json --noEmit` | PASS |
| `./node_modules/.bin/tsc -p client/tsconfig.json --noEmit` | PASS |
| `npm run build` | PASS; existing CJS/bundle-size warnings, no missing imports/assets |
| `node --import tsx tests/frontend-delivery.test.ts` | PASS supported deep links/access classification, cache headers, API and missing-asset 404 |
| `./node_modules/.bin/playwright test` | PASS **7/7** Firefox tests: two mocked navigation fixtures plus five real isolated backend/database tests; includes Settings-to-Policies link, direct links/history, user/admin/agent denials, checkout visibility, persistence, 15 authenticated read APIs and actual served asset hashes |
| `docker build -t sao-frontend-investigation:local .` | PASS local image `073a66e66141080b77d0b89cb66a37711f4f5bb0fd4ef3f6b90ca33a06da41ae`; never pushed/deployed |
| `docker run --rm --network none --memory 1g --cpus 2 --pids-limit 512 --entrypoint sh sao-frontend-investigation:local -c 'node --import tsx tests/container-runtime.test.ts && node --import tsx tests/frontend-delivery.test.ts'` | PASS non-root Firefox/actual artifact helper, production missing-JWT refusal, private-file exclusions and actual frontend middleware; no application/database startup in this smoke test |
| `node --import tsx scripts/inspect-forward.ts` | PASS read-only actual MySQL 9.6 identity/schema/count inspection |
| `node --import tsx scripts/production-readiness.ts eb2bfb559429 sao-sql-primary-0 --deployed-runtime` | PASS read-only inspection/provider fingerprint preservation; production activation remains BLOCKED |
| `git diff --check` | PASS |

Final compiled assets include all inspected feature labels and are independently checksum-verified: JS `assets/index-BZUAtc95.js`, SHA-256 `fcfe0de1fcb2efe17d5ba5f0b23fdcc1a1b91838d3a7b0dc494524a7065bc5be`; CSS `assets/index-DTTcPowx.css`, SHA-256 `b0d7391374b19b7e62241430c1af720b8acbb21983b87f1658af781fdf1740a5`. Local revision is correctly null because repairs are not committed; production must supply the actual approved resulting commit, not falsely stamp the parent SHA.

Investigated intermediate failures: sandbox blocked a local HTTP bind (rerun with approval passed); a new browser fixture used the wrong existing authorization heading (corrected to the real heading without weakening access checks); initial manifest CSS hashing occurred before Vite's final CSS transformation (moved hashing to emitted filesystem bytes and verified through HTTP). All final tests pass. Mocked Vite-preview browser tests emit expected WebSocket connection warnings because those fixtures have no WebSocket server; no live WebSocket failure is inferred from those warnings. Full-stack authenticated production verification remains NOT VERIFIED, rather than conflated with isolated tests.

Private evidence logs are retained under `.sao-backups/frontend-investigation-20261015/`. New readonly readiness evidence: `.sao-backups/production-readiness/readiness-ed36324b-35f8-4b7f-9a89-ba9c3a40008f.json`.

## Deployment readiness

**Local repair verification and production activation are separate.** A reviewable repair is prepared for the existing service, but live rollout remains BLOCKED pending explicit approval and the security/prerequisite plan. Updating a runtime to the correct branch/image must not implicitly authorize `pnpm start` migrations, grant privileges, activate policies or rewrite encrypted credentials. Readiness must be rechecked against the exact reviewed resulting commit, not the currently uncommitted repair tree or an ambiguous `latest` image.

Remaining actions: approve a credential-preserving security migration/recovery plan; separately authorize required admin grants; approve production policy values/owner agreements; review the repair diff and authorize the exact existing-service build/source selection and rollout after staging. Do not trigger a rollout merely to make menus appear while production authentication is unsafe. No new service, database or URL is required.

Status: local repairs and verification **COMPLETE**; live feature rollout **BLOCKED** pending the separate prerequisites/approvals above; live authenticated operational verification **NOT VERIFIED**. The previously documented external advertising/payout and unsupported-output QC limitations remain unchanged, not falsely marked operational.
