import 'dotenv/config';
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { configurationReadiness } from '../shared/policyReadiness';
import { decryptCredential } from '../server/services/credentialCrypto';
import { getModelRegistry } from '../server/services/llmModels';
import { execFileSync } from 'node:child_process';

const fingerprint = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const probes: Record<string, { url: string; env?: string; header?: string; authenticated: boolean; expected: (body: any) => boolean }> = {
  groq: { url: 'https://api.groq.com/openai/v1/models', env: 'GROQ_API_KEY', authenticated: true, expected: body => Array.isArray(body.data) },
  cerebras: { url: 'https://api.cerebras.ai/v1/models', env: 'CEREBRAS_API_KEY', authenticated: true, expected: body => Array.isArray(body.data) },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', env: 'GEMINI_API_KEY', authenticated: true, expected: body => Array.isArray(body.data) },
  openrouter: { url: 'https://openrouter.ai/api/v1/auth/key', env: 'OPENROUTER_API_KEY', authenticated: true, expected: body => body.data && typeof body.data === 'object' },
  tavily: { url: 'https://api.tavily.com/usage', env: 'TAVILY_API_KEY', authenticated: true, expected: body => body.key && body.account },
  vercel: { url: 'https://api.vercel.com/v2/user', env: 'VERCEL_TOKEN', authenticated: true, expected: body => typeof body.user?.id === 'string' },
  ons: { url: 'https://api.beta.ons.gov.uk/v1/datasets?limit=1', authenticated: false, expected: body => Array.isArray(body.items) },
  stripe: { url: 'https://api.stripe.com/v1/account', env: 'STRIPE_SECRET_KEY', authenticated: true, expected: body => body.object === 'account' },
  nowpayments: { url: 'https://api.nowpayments.io/v1/balance', env: 'NOWPAYMENTS_API_KEY', header: 'x-api-key', authenticated: true, expected: body => body && !Array.isArray(body) && !body.error && !body.statusCode && Object.values(body).every((value: any) => typeof value?.amount === 'number') },
};

async function main() {
  const [expectedDatabase, expectedServer, ...options] = process.argv.slice(2);
  if (!expectedDatabase || !expectedServer || options.some(option => !['--probe', '--deployed-runtime'].includes(option))) throw new Error('Supply exact inspected database/server and optional --probe/--deployed-runtime. All SQL and external probes are read-only.');
  let selectedEnvironment: Record<string, string | undefined> = process.env;
  if (options.includes('--deployed-runtime')) {
    const service = JSON.parse(execFileSync('/home/ademoo/.nvm/versions/node/v24.15.0/bin/northflank', ['get', 'service', '--project', 'sao', '--service', 'sao-app', '--quiet', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    if (service.id !== 'sao-app' || service.projectId !== 'sao' || service.runtimeEnvironment?.DB_NAME !== expectedDatabase) throw new Error('Deployed runtime identity did not match the verified application/database.');
    selectedEnvironment = service.runtimeEnvironment;
    for (const key of ['JWT_SECRET', 'CREDENTIAL_ENCRYPTION_KEY']) { if (selectedEnvironment[key]) process.env[key] = selectedEnvironment[key]; else delete process.env[key]; }
  }
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  const connection = await mysql.createConnection({ host: '127.24.1.1', port: 3306, user: url ? decodeURIComponent(url.username) : process.env.DB_USER, password: url ? decodeURIComponent(url.password) : process.env.DB_PASSWORD, database: url ? decodeURIComponent(url.pathname.slice(1)) : process.env.DB_NAME, ssl: { rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== 'false' }, connectTimeout: 5000, jsonStrings: true });
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const rows = async (query: string, values: unknown[] = []) => (await connection.query<any[]>(query, values))[0];
    const identity = (await rows('SELECT DATABASE() AS databaseName,@@hostname AS serverName,@@version AS version,@@version_comment AS engine,@@character_set_server AS characterSet,@@collation_server AS collation,(SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()) AS databaseCollation'))[0];
    if (identity.databaseName !== expectedDatabase || identity.serverName !== expectedServer) throw new Error('Exact production identity mismatch. No mutations or probes performed.');
    const tables = await rows('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION,TABLE_ROWS,DATA_LENGTH,INDEX_LENGTH,DATA_FREE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    const has = (name: string) => tables.some(table => table.TABLE_NAME === name);
    const columns = await rows('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,DATETIME_PRECISION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
    const indexes = await rows('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()');
    const foreignKeys = await rows('SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
    const triggers = await rows('SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
    const migrations = has('__drizzle_migrations') ? await rows('SELECT * FROM __drizzle_migrations') : [];
    let metadataLocks: unknown = 'NOT VERIFIED: database account cannot inspect metadata locks';
    try { metadataLocks = await rows('SELECT OBJECT_TYPE,OBJECT_NAME,LOCK_TYPE,LOCK_DURATION,LOCK_STATUS FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA=DATABASE()'); } catch {}
    const providers = await rows('SELECT * FROM integration_credentials ORDER BY id');
    const deployments = await rows('SELECT * FROM deployment_providers ORDER BY id');
    const beforeProviders = fingerprint([providers, deployments]);
    const owners = await rows('SELECT d.id AS businessId,d.user_id AS ownerId,u.role AS ownerRole,d.status AS businessStatus FROM deployments d LEFT JOIN users u ON u.id=d.user_id ORDER BY d.id');
    const assignments = has('policy_assignments') ? await rows('SELECT * FROM policy_assignments') : [];
    const approvals = has('action_approvals') ? await rows('SELECT deployment_id,action,authority,status,expires_at,revoked_at FROM action_approvals') : [];
    const configurations = has('policy_heads') ? Object.fromEntries((await rows('SELECT h.category,v.config_json FROM policy_heads h JOIN policy_versions v ON v.id=h.active_version_id')).map(row => [row.category, JSON.parse(row.config_json)])) : {};
    const providerResults = [];
    for (const providerId of new Set([...providers.map(row => row.provider_id), 'ons', ...Object.entries(probes).filter(([, probe]) => probe.env && selectedEnvironment[probe.env]).map(([id]) => id)])) {
      const probe = probes[providerId];
      const configured = providers.filter(row => row.provider_id === providerId && row.enabled).sort((first, second) => (first.priority === 'primary' ? 0 : 1) - (second.priority === 'primary' ? 0 : 1) || new Date(second.updated_at).getTime() - new Date(first.updated_at).getTime());
      let credential: string | undefined;
      let source = 'none';
      let storedCredentialReadable: boolean | null = null;
      if (configured[0]) { try { credential = decryptCredential(configured[0].encrypted_value); storedCredentialReadable = Boolean(credential); if (credential) source = 'dashboard'; } catch { storedCredentialReadable = false; } }
      if (!credential && probe?.env && selectedEnvironment[probe.env]) { credential = selectedEnvironment[probe.env]; source = 'environment'; }
      const result: Record<string, unknown> = { providerId, configured: configured.length > 0 || source === 'environment' || providerId === 'ons', storedCredentialReadable, credentialSource: source, adapterSupported: Boolean(probe), externalExecution: 'NOT VERIFIED', status: !probe ? 'UNSUPPORTED' : probe.authenticated && !credential ? 'UNAVAILABLE' : 'NOT VERIFIED' };
      if (options.includes('--probe') && probe && (!probe.authenticated || credential)) {
        try {
          const response = await fetch(probe.url, { method: 'GET', headers: credential ? { [probe.header || 'Authorization']: probe.header ? credential : `Bearer ${credential}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) });
          const body = await response.json().catch(() => null);
          const valid = response.ok && body && Boolean(probe.expected(body));
          Object.assign(result, { checkedAt: new Date().toISOString(), httpStatus: response.status, reachable: true, authenticated: valid && probe.authenticated, responseValidated: valid, status: valid ? 'LIMITED' : [401, 403].includes(response.status) ? 'AUTHENTICATION_FAILED' : 'UNAVAILABLE', scope: 'Read-only metadata only; no generation/search/charges/publication/transfers' });
          let catalogData = body?.data;
          if (valid && providerId === 'openrouter') {
            const catalogResponse = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${credential}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
            const catalogBody = await catalogResponse.json().catch(() => null);
            catalogData = catalogResponse.ok && Array.isArray(catalogBody?.data) ? catalogBody.data : null;
          }
          if (valid && ['groq', 'cerebras', 'gemini', 'openrouter'].includes(providerId) && Array.isArray(catalogData)) {
            const catalog = new Map<string, any>(catalogData.map((model: any) => [model.id, model]));
            result.models = getModelRegistry().filter(model => model.provider === providerId && model.enabled).map(model => {
              const match = catalog.has(model.model) ? model.model : providerId === 'gemini' && catalog.has(`models/${model.model}`) ? `models/${model.model}` : null;
              const advertised = match ? catalog.get(match) : null;
              return { id: model.model, presentInCatalog: Boolean(match), catalogMatch: match, reasoningExecution: 'NOT VERIFIED', configuredContextLimit: model.maxInputTokens, advertisedContextLimit: advertised?.context_window ?? advertised?.context_length ?? advertised?.inputTokenLimit ?? null, advertisedOutputLimit: advertised?.max_completion_tokens ?? advertised?.top_provider?.max_completion_tokens ?? advertised?.outputTokenLimit ?? null, advertisedParameters: advertised?.supported_parameters ?? null, capabilityScope: 'Provider-advertised metadata; not an executed context/tool/reasoning test' };
            });
          }
          if (valid && providerId === 'stripe') result.accountCapabilities = { chargesEnabled: body.charges_enabled === true, payoutsEnabled: body.payouts_enabled === true, transfers: body.capabilities?.transfers || 'NOT VERIFIED', payoutAdapter: 'unavailable', recipientOnboarding: 'NOT VERIFIED' };
        } catch (error: any) { Object.assign(result, { status: 'UNAVAILABLE', reachable: false, failureType: error.name === 'TimeoutError' ? 'timeout' : 'network_or_protocol_error' }); }
      }
      providerResults.push(result);
    }
    await connection.rollback();
    const afterProviders = fingerprint([await rows('SELECT * FROM integration_credentials ORDER BY id'), await rows('SELECT * FROM deployment_providers ORDER BY id')]);
    if (beforeProviders !== afterProviders) throw new Error('Provider fingerprint changed during the read-only snapshot.');
    const report = { mode: 'READ_ONLY_PRODUCTION_READINESS', checkedAt: new Date().toISOString(), identity, schema: { tables, columns, indexes, foreignKeys, migrations, triggers: triggers.map(trigger => ({ name: trigger.TRIGGER_NAME, definitionHash: fingerprint(trigger.ACTION_STATEMENT) })), metadataLocks, physicalDiskCapacity: 'NOT VERIFIED: requires Northflank platform metrics; DATA_FREE is not filesystem capacity' }, policyReadiness: configurationReadiness(configurations), assignments, approvals, businesses: owners.map(business => ({ ...business, policyAssignments: assignments.filter(assignment => assignment.deployment_id === business.businessId).length, recordedApprovals: approvals.filter(approval => approval.deployment_id === business.businessId), consentStatus: has('action_approvals') ? 'Review scope, expiry, revocation and agreement version before execution' : 'NOT RECORDED in new subsystem; legacy external agreements NOT VERIFIED' })), providerResults, providerPreservation: { before: beforeProviders, after: afterProviders, credentials: providers.length, deploymentProviders: deployments.length, remoteWrites: 0 }, environmentPresence: Object.fromEntries(['CREDENTIAL_ENCRYPTION_KEY', 'JWT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'META_ADS_ACCESS_TOKEN', 'META_ADS_ACCOUNT_ID', 'TIKTOK_ADS_ACCESS_TOKEN', 'TIKTOK_ADS_ADVERTISER_ID', 'PUBLIC_URL', 'SAO_BACKUP_DIR'].map(key => [key, Boolean(selectedEnvironment[key])])), configurationSource: options.includes('--deployed-runtime') ? 'Northflank sao/sao-app runtime; values used only in process memory' : 'Local process configuration', runtimeSecurity: { productionMode: selectedEnvironment.NODE_ENV === 'production', jwtSecretConfigured: Boolean(selectedEnvironment.JWT_SECRET), encryptionKeyConfigured: Boolean(selectedEnvironment.CREDENTIAL_ENCRYPTION_KEY), legacyDefaultEncryptionDetected: !selectedEnvironment.CREDENTIAL_ENCRYPTION_KEY && !selectedEnvironment.JWT_SECRET && providerResults.some(result => result.storedCredentialReadable === true) }, approvedPolicyValues: false, providerSnapshot: 'NOT PROVIDED', independentBackup: 'NOT PROVIDED' };
    const destination = `.sao-backups/production-readiness/readiness-${crypto.randomUUID()}.json`;
    await fs.mkdir('.sao-backups/production-readiness', { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ report: destination, identity, providerResults, providerPreservation: report.providerPreservation, policies: report.policyReadiness.map(policy => ({ category: policy.category, state: policy.state, missing: policy.validation.missing })), businesses: owners.length, remoteWrites: 0 }, null, 2));
    await connection.rollback();
  } finally { await connection.end(); }
}

main().catch(error => { console.error(error.code || 'Read-only readiness inspection failed; no remote mutation was requested.'); process.exitCode = 1; });
