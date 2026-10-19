# Provider assignment rollout — instructions only

No push, deployment, production migration, environment change or paid provider request was executed for this implementation. No local commit was created.

## Production rollout after explicit deployment authorization

1. Select the reviewed source revision and build the normal SAO image. Do not change existing environment values or credential encryption material. The existing Dockerfile builds the frontend and includes the startup migration runner. For a non-container build, use the repository's pinned package manager:

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec tsc --noEmit -p server/tsconfig.json
   pnpm exec tsc --noEmit -p client/tsconfig.json
   pnpm build:client
   ```

2. Through the existing Core Loop controls, stop scheduling and wait for active work to drain. Record the prior running preference. Avoid concurrent credential/assignment edits during migration. Preserve all historical business/evidence records.
3. Create and verify a database backup using the installation's established backup procedure. Keep encrypted credentials and the existing encryption key together in secured, separately protected recovery material. Inspect the target database identity and identifier/schema collations using the existing migration preflight; do not print secrets.
4. With the reviewed application files and the **existing authorized production runtime configuration**, run one migration instance:

   ```sh
   node run-migration.js
   ```

   This is the existing complete startup runner, including migration 0016; review the runner's full pending migration set before authorizing it on an older installation. Check its success and migration audit event. Do not run database reset, seed replacement, `drizzle-kit push`, credential rotation, or historical discovery cleanup commands. On this release, both a new database and repeated startup migration applications were tested on disposable MariaDB. A production restore rehearsal should use a private, authorized backup and the exact production MySQL version/collation; this task did not access a live backup or certify a specific production server version.

5. Roll out the reviewed application image through the existing Northflank deployment mechanism. Its normal `pnpm start` runs `node run-migration.js` again before starting the server; this repeat is intentional and idempotent. Keep one migration initializer at a time. This document does not supply or execute a deployment API call.
6. Open Providers and verify retained connections and configuration. Confirm Groq still has its LLM assignment. Open Manage Assignments, add a compatible search assignment, save and refresh. Confirm both assignments remain. Do not approve billing as part of this check. A paid search without prior billing authorization must remain blocked. Test enabled/disabled and removal behavior on an authorized non-production/test connection if production routing must remain unchanged.
7. Check discovery diagnostics for the ONS exclusion and for assignment eligibility/billing reasons. Use synthetic/mocked tests for billable adapters unless separate authorization explicitly permits live requests. A live ONS/discovery cycle can invoke paid inference under pre-existing settings, so do not start one merely as a no-cost smoke test. Restore the prior scheduler preference only after normal operational authorization is confirmed.

Subsequent assignment changes use the dashboard and take effect without another deployment.

## Rollback

Stop and drain scheduling first. Retain the additive schema and encrypted credentials. Roll back the application image through the normal deployment mechanism; do not drop new tables/columns or restore the entire database over new business transactions. An older application will use its legacy routing configuration and will not enforce new assignment-only restrictions. Before rollback, inspect assignment changes and disable affected provider connections through the existing controls where necessary to prevent an older image resuming a deliberately removed route. Do not modify credentials to achieve rollback.

The new implementation never rewrites the pre-existing legacy config during assignment saves, so those original settings remain available for rollback review. Capture the new assignment records and audit events before any separately approved reconciliation.
