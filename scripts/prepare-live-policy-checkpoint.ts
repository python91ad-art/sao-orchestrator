import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

function identifier(value: string) { if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('Invalid schema identifier.'); return `\`${value}\``; }
async function main() {
  const [expectedDatabase, expectedServer] = process.argv.slice(2);
  if (!expectedDatabase || !expectedServer) throw new Error('Supply the independently inspected database and server identity. This command never mutates the remote database.');
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  if (url) { url.hostname = '127.24.1.1'; url.port = '3306'; process.env.DATABASE_URL = url.toString(); }
  else { process.env.DB_HOST = '127.24.1.1'; process.env.DB_PORT = '3306'; }
  const connection = await mysql.createConnection({ host: '127.24.1.1', port: 3306, user: url ? decodeURIComponent(url.username) : process.env.DB_USER, password: url ? decodeURIComponent(url.password) : process.env.DB_PASSWORD, database: url ? decodeURIComponent(url.pathname.slice(1)) : process.env.DB_NAME, ssl: { rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== 'false' }, connectTimeout: 5000 });
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const [identities] = await connection.query<any[]>('SELECT DATABASE() AS databaseName,@@hostname AS serverName,@@version AS version');
    const identity = identities[0];
    if (identity.databaseName !== expectedDatabase || identity.serverName !== expectedServer) throw new Error('Remote identity changed; no checkpoint was created.');
    const [engines] = await connection.query<any[]>('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\'');
    if (engines.some(table => table.ENGINE !== 'InnoDB')) throw new Error('Nontransactional tables require a provider-supported consistent snapshot.');
    const [columns] = await connection.query<any[]>('SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
    const [gaps] = await connection.query<any[]>('SELECT id FROM gaps ORDER BY id');
    const reasons: Record<string, string[]> = {};
    const scoped: Record<string, any[]> = {};
    for (const table of [...new Set(columns.filter(column => column.COLUMN_NAME === 'gap_id').map(column => String(column.TABLE_NAME)))]) {
      const [rows] = await connection.query<any[]>(`SELECT * FROM ${identifier(table)} ORDER BY gap_id`);
      scoped[table] = rows;
      for (const row of rows) if (!['queue_items', 'evidence_records', 'evidence_events', 'gap_policy_reviews'].includes(table) || (table === 'queue_items' && row.queue_type !== 'synthesis') || (table === 'evidence_records' && (row.deployment_id || row.business_spec_id))) (reasons[row.gap_id] ||= []).push(`${table}:${row.id || row.gap_id}`);
    }
    const eligibleIds = gaps.filter(gap => !reasons[gap.id]?.length).map(gap => gap.id);
    const protectedIds = gaps.filter(gap => reasons[gap.id]?.length).map(gap => gap.id);
    const providers = [];
    for (const table of ['integration_credentials', 'deployment_providers']) {
      const [rows] = await connection.query<any[]>(`SELECT * FROM ${identifier(table)} ORDER BY id`);
      providers.push({ table, count: rows.length, fingerprint: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') });
    }
    const [relationships] = await connection.query('SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
    const [triggers] = await connection.query<any[]>('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
    const [routines] = await connection.query<any[]>('SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()');
    if (triggers.length || routines.length) throw new Error('Provider-supported backup is required to preserve database triggers/routines.');
    const { exportDatabaseBackup } = await import('../server/services/discoveryReset');
    const { mysqlPool } = await import('../server/db');
    try {
      const directory = path.resolve(process.env.SAO_BACKUP_DIR || '.sao-backups');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const id = `northflank-${crypto.randomUUID()}`;
      const backup = await exportDatabaseBackup(connection, directory, id);
      const [ownership] = await connection.query<any[]>('SELECT COUNT(*) AS businesses,SUM(user_id IS NULL) AS unowned FROM deployments');
      const counts = { gaps: { total: gaps.length, eligible: eligibleIds.length, protected: protectedIds.length }, ...Object.fromEntries(Object.entries(scoped).map(([table, rows]) => [table, { total: rows.length, eligible: rows.filter(row => eligibleIds.includes(row.gap_id)).length, protected: rows.filter(row => protectedIds.includes(row.gap_id)).length }])) };
      const report = { mode: 'READ_ONLY_PRE_MIGRATION_CHECKPOINT', identity, counts, ownership, protectedIds, protectedReasons: reasons, providers, relationships, backup, remoteWrites: 0, remoteDeleted: 0, remoteArchived: 0, readiness: 'Apply only separately authorized reviewed migrations; regenerate the executor preview and backup before any separately authorized reset.' };
      const reportPath = path.join(directory, `${id}-report.json`);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ ...report, reportPath, protectedIds: `${protectedIds.length} IDs retained in private report`, protectedReasons: 'Private report includes every protected reference; no credential values are printed.' }, null, 2));
    } finally { await mysqlPool.end(); }
    await connection.rollback();
  } finally { await connection.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
