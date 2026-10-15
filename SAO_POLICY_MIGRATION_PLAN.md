# SAO Production Migration and Recovery Plan

Updated: 2026-10-15. **No live execution is authorized by this document.** Current evidence and six-area status are in SAO_PRODUCTION_READINESS_REPORT.md.

**Later read-only inspection:** the database now contains 65 tables, including policy/lifecycle/operational tables. The earlier absent-schema inventory below is historical. See `SAO_FRONTEND_BACKEND_INVESTIGATION_REPORT.md`; reconcile current DDL/checksum history before any approved startup/migration. This investigation did not apply these remote changes. Do not rerun the original rollout merely to fix stale frontend assets.

## 1. Exact target and critical prerequisites

- Project/addon: sao / sao-sql.
- Existing TCP forward: 127.24.1.1:3306; never stop the user's terminal or start a duplicate.
- Fresh read-only identity: database eb2bfb559429, server sao-sql-primary-0, MySQL 9.6.0.
- Source schema/table default collation: utf8mb4_general_ci, not an assumed MySQL default.
- Four original Drizzle journal records and 24 application tables; lifecycle/policy/operational migrations still absent.
- Existing service: sao/sao-app. Public health/readiness GETs returned HTTP 200, but this does not prove secure authorization or policy readiness.
- Critical blocker: deployed NODE_ENV production mode, JWT_SECRET and CREDENTIAL_ENCRYPTION_KEY are absent; stored credentials decrypt with legacy default derivation. No secrets/ciphertexts were changed.

Do not provision broad new permissions or activate autonomous operations against the insecure legacy runtime. Secure session and credential-key cutover must be separately authorized, preserve every provider plaintext/configuration, and coordinate DB ciphertext version with secret-manager version. Simply replacing JWT_SECRET would break existing stored-provider decryption. Notify the owner that legitimate sessions require re-login after session-secret rotation.

## 2. Technical verification — COMPLETE in staging

The official mysql:9.6.0 image was used with the exact inspected source collation and unmodified representative data. All original rows/fields survive repeated migration, including provider ciphertext and ownership. A NULL-owner fixture remains NULL.

A deliberately mismatched schema collation is rejected before DDL. The migration runner's new preflight never silently converts business identifiers. Native full SQL backup restoration and protected counts pass. The production entrypoint starts against the migrated copy; actual DB readiness/client/auth denial is checked. Containers have no network or production credentials and enforce resource limits.

Representative migration applications take approximately 0.7–1.6 seconds on the isolated 2-vCPU/2-GiB fixture. This is not a production SLA or a lock-duration guarantee. Current source data/index size is about 44 MB; 6,144 MiB storage is allocated on Northflank, but physical free space and metadata-lock visibility are NOT VERIFIED.

## 3. Reviewed SQL/code manifest

| File | SHA-256 |
| --- | --- |
| run-migration.js | be40cb8a55778fd6fae8bf70b98a51f8534a7c527900a559212ebe126d124b8f |
| drizzle/migrations/0013_lifecycle_infrastructure.sql | 0de965d3b450b0b86347dfe3c8d719264d40da82f1cd85603d8abae6e79601e7 |
| drizzle/migrations/0014_policy_engine.sql | 539b247105368981172892b32bb4a01cbe99e284aa56fbb6eaeccd93325e9d80 |
| drizzle/migrations/0015_operational_policies.sql | fc12a4b401da6d5770ae27acf5c17d0a7f679011f7a213e3b3cbd1ede6bba935 |

Recompute these before approval. Any changed hash requires renewed review.

The actual runner creates/reuses legacy tables and embedded 0013 lifecycle infrastructure, applies 0014 then 0015, and performs its existing additive columns/index/compatibility checks. Do not pretend it directly invokes standalone 0013. It also records one checksum-linked schema_migration_verified event in existing operational_events for identical repeated applications; original Drizzle journal entries remain intact.

0015 adds action_approvals, agent_sessions, task_executions, release_authorizations, accounting_items, accounting_periods, price_proposals, extension_offers, operational_settings, operational_events and discovery_archives. LONGTEXT widening covers artifact/task/specification/final-report data; legal-review timestamps gain millisecond precision. No DROP/TRUNCATE, provider reset or ownership backfill is permitted.

## 4. Verified backups and independent recovery

Fresh application JSON:
.sao-backups/discovery-reset-northflank-fb9d8cb4-87c5-4fd5-8c90-864dcc023f86.json
SHA-256: 0b635f5d90a1e79d084249a555859625b176de31a76b3bb5bead849c1512548e.

Native full database logical dump:
.sao-backups/production-readiness/mysql9-2801bad9-b0c6-4052-b4de-f0017f0a79ab.sql
SHA-256: 717f063eb985c531ec43a9fef51925947e69ef2b52510ff9458d358f23b5b369.
Size: 28,674,459 bytes. Schema/data/routines/triggers/events included; consistent InnoDB snapshot and verified exact-version SQL restoration. It does not back up server-level users/grants or Northflank configuration.

Directories/files are private 700/600; credentials were passed only through temporary private option files removed afterward. Existing backups were preserved. An incomplete zero-byte dump is not valid recovery evidence.

Still required:
- Northflank-supported full-addon snapshot ID and restoration/recovery evidence.
- Encrypted independent storage destination, verified copied checksum/readability and approved retention/budget.
- Backup of matching runtime-secret versions in existing protected secret management; no secrets in chat or Git.
- Platform free-space/lock/resource review.

No custom backup destination exists in the inspected account. Historical internally managed backups were not inferred absent from that result. The user supplied no snapshot ID, destination or approved policy values. The verified Kali copies are outside Northflank, but a second encrypted destination and durable recovery/retention arrangement have not been approved; do not describe that additional prerequisite as completed.

## 5. Writer isolation and maintenance authorization

Before remote DDL:
1. Refresh identity, schema/default collation, migration state and manifest.
2. Obtain explicit approval for this target, manifest and maintenance window, separately from grants/deletion/deployment.
3. Snapshot/export again if the data has changed since reviewed evidence.
4. Inventory and pause all application/worker/audit/autonomous writers via a separately approved Northflank maintenance operation. Keep the SQL addon and user's forward running.
5. Confirm no old worker, webhook processor, job or operator writes into the schema. A cooperative application named lock is not a substitute for pausing legacy/unaware writers.
6. Verify provider/business/customer/payment/audit counts and private full-row fingerprints.
7. Verify independent backup and provider restore procedure.

Do not assume that stopping only the core loop stops other schedulers. Do not claim a maintenance pause occurred here: none was executed.

## 6. Approved migration execution only

Do not use npm start as a live dry run: it migrates and can start automation.

After exact approval, invoke only the reviewed runner with process-local connection overrides preserving the existing credentials/database/TLS options. One explicit operator pattern is:

```sh
node -r dotenv/config -e '
const {spawnSync}=require("node:child_process");
const env={...process.env};
if(env.DATABASE_URL){const url=new URL(env.DATABASE_URL);url.hostname="127.24.1.1";url.port="3306";env.DATABASE_URL=url.toString();}
else{env.DB_HOST="127.24.1.1";env.DB_PORT="3306";}
env.SAO_MIGRATION_APPROVAL_REFERENCE="REPLACE_WITH_VERIFIED_APPROVAL_REFERENCE";
const result=spawnSync(process.execPath,["run-migration.js"],{env,stdio:"inherit"});
process.exit(result.status ?? 1);
'
```

This is an execution example, not authorization. The placeholder must reference the actual approved operation. Inspect identity and review checksums immediately beforehand; do not silently fall back to a different DB if the forward fails.

After migration:
- Verify schema, constraints/indexes, LONGTEXT/precision and migration audit hashes.
- Compare every protected original record/field and provider fingerprint; preserve NULL owners.
- Check database health and original journal history.
- Keep automation paused while secure runtime/deployment, permissions, policies and genuine owner consent are completed.
- Obtain separate authorization before deployment/restart; none is implied by schema approval.

## 7. Recovery

MySQL DDL is not one rollback transaction. On failure, keep traffic/writers paused and use the verified provider snapshot or reviewed logical restoration with matching source/application/secret versions. Restore to an isolated target and validate before any separately authorized production recovery. Never blindly drop new populated tables to imitate rollback.

Preserve/reconcile any post-backup payments, customer obligations, webhook retries and financial events before resuming. Secure credential rotation requires matching ciphertext/key versions; do not restore one without the other. Existing provider IDs/configurations/enablement must remain identical.

## 8. Separate administrator provisioning

Confirmed existing administrator:
9f64c09d-6d13-4fa9-9616-d294bddc890b.
The user explicitly confirmed this identity; no account was created. Current role and 21 business-owner references were read from the live DB.

Read-only preview:

```sh
node --import tsx scripts/grant-policy-permissions.ts 9f64c09d-6d13-4fa9-9616-d294bddc890b --local-forward
```

Only after approved migrations, secure runtime readiness and separate exact grant approval:

```sh
node --import tsx scripts/grant-policy-permissions.ts 9f64c09d-6d13-4fa9-9616-d294bddc890b --local-forward --apply --confirm 'eb2bfb559429/sao-sql-primary-0/9f64c09d-6d13-4fa9-9616-d294bddc890b' --reason 'REPLACE_WITH_APPROVED_GRANT_REASON'
```

Scope: the 16 explicit permissions listed in the production report, not unrestricted wildcard administration. Existing permissions are preserved, the role is locked/reverified, duplicate/ambiguous arguments are rejected and actual grants are audited. No live grant has occurred.

## 9. Policy and owner activation

Review SAO_PRODUCTION_POLICY_PLAN.json. Offline validation:
node --import tsx scripts/validate-production-policy-plan.ts SAO_PRODUCTION_POLICY_PLAN.json.

Current expected exit 3 means approved numerical/configuration values are missing. Do not seed fixtures. The shared readiness dashboard shows all nine categories, accepted field types and affected workflows. Accrual and unsupported QC runners are rejected.

Validate/activate only reviewed configurations. Existing businesses require explicit version assignment and applicable original-owner consent; do not silently replace legacy agreements. Confirm real account login, tools/models, exact 20% positive-net-profit weekly agreement, pricing/financial boundaries, deadlines and provider capabilities. Paid generation/advertising/transfers need independent appropriate authorization.

## 10. Separate discovery cleanup approval

Fresh pre-migration inventory: 1,335 gaps, 775 eligible/560 protected; 763 eligible synthesis rows, 555 protected synthesis rows and 18 retained non-synthesis rows, including two orphan failed deployment jobs. These numbers are not an executor confirmation.

After rollout/provisioning:
1. Open Operations → Maintenance and regenerate exact database/server identity and all dependencies.
2. Prepare a NEW private backup/report and off-instance copy.
3. Verify active affected workers are absent, named-lock writer isolation, provider fingerprints, exact delete/archive/retained counts and backup restoration.
4. Present the prepared executor fingerprint and exact confirmation to the administrator.
5. Execute only after that separate confirmation. Any changed data/fingerprint invalidates it.
6. Verify referential integrity, protected providers/businesses/finances, discovery counters/cache invalidation and fresh discovery; restore appropriate operating state only when safe.

Do not delete non-discovery jobs, permanent health history, audit history or protected business references. No live reset has been executed; migration/grant approval never authorizes it.
