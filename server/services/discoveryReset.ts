import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, generateId, mysqlPool } from '../db';
import * as schema from '../../drizzle/schema';
import { Principal, requirePolicyPermission } from './policyEngine';
import { DISCOVERY_LOCK } from './discoveryMaintenance';
import { clearDiscoveryEvidenceCache } from './businessData';

function identifier(value: string) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('Invalid database identifier.');
  return `\`${value}\``;
}
function digest(value: unknown) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function backupRows(connection: any, name: string) {
  const [columns] = await connection.query('SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name]);
  const select = columns.map((column: any) => ['datetime', 'timestamp', 'date', 'time', 'json'].includes(column.DATA_TYPE) ? `CAST(${identifier(column.COLUMN_NAME)} AS CHAR) AS ${identifier(column.COLUMN_NAME)}` : identifier(column.COLUMN_NAME)).join(',');
  const [rows] = await connection.query(`SELECT ${select} FROM ${identifier(name)}`);
  return rows;
}
const eligibleTables = new Set(['gaps', 'queue_items', 'evidence_records', 'evidence_events', 'gap_policy_reviews']);
async function inventory(connection: any, ids?: string[]) {
  const [identity] = await connection.query('SELECT DATABASE() AS databaseName, @@hostname AS serverName, @@version AS version, (SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()) AS databaseCollation');
  const [columns] = await connection.query('SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
  const [relationships] = await connection.query('SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
  const [gaps] = ids ? ids.length ? await connection.query('SELECT * FROM gaps WHERE id IN (?) ORDER BY id', [ids]) : [[]] : await connection.query('SELECT * FROM gaps WHERE id NOT IN (SELECT gap_id FROM discovery_archives) ORDER BY id');
  const gapIds = gaps.map((gap: any) => gap.id);
  const protectedReasons: Record<string, string[]> = {};
  const tables: Record<string, any[]> = { gaps };
  const scopedTables = [...new Set(columns.filter((column: any) => column.COLUMN_NAME === 'gap_id').map((column: any) => column.TABLE_NAME))] as string[];
  for (const table of scopedTables) {
    if (!gapIds.length || table === 'discovery_archives') continue;
    const [records] = await connection.query(`SELECT * FROM ${identifier(table)} WHERE gap_id IN (?) ORDER BY gap_id`, [gapIds]);
    tables[table] = records;
    for (const row of records as any[]) {
      const protect = !eligibleTables.has(table) || (table === 'queue_items' && row.queue_type !== 'synthesis') || (table === 'evidence_records' && (row.deployment_id || row.business_spec_id));
      if (protect) (protectedReasons[row.gap_id] ||= []).push(`${table}:${row.id || row.gap_id}`);
    }
  }
  for (const relation of relationships as any[]) {
    if (relation.REFERENCED_TABLE_NAME !== 'gaps' || relation.COLUMN_NAME === 'gap_id' || !gapIds.length) continue;
    const [rows] = await connection.query(`SELECT ${identifier(relation.COLUMN_NAME)} AS linked_gap FROM ${identifier(relation.TABLE_NAME)} WHERE ${identifier(relation.COLUMN_NAME)} IN (?)`, [gapIds]);
    for (const row of rows as any[]) (protectedReasons[row.linked_gap] ||= []).push(`foreign_key:${relation.TABLE_NAME}.${relation.COLUMN_NAME}`);
  }
  const queue = tables.queue_items || [];
  const processing = queue.filter((item: any) => item.queue_type === 'synthesis' && item.status === 'processing').map((item: any) => item.id);
  const protectedIds = gapIds.filter((id: string) => protectedReasons[id]?.length);
  const eligibleIds = gapIds.filter((id: string) => !protectedReasons[id]?.length);
  const providers = [];
  for (const table of ['integration_credentials', 'deployment_providers']) {
    if (columns.some((column: any) => column.TABLE_NAME === table)) {
      const [rows] = await connection.query(`SELECT * FROM ${identifier(table)} ORDER BY id`);
      providers.push({ table, count: rows.length, fingerprint: digest(rows) });
    }
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, { total: rows.length, eligible: table === 'gaps' ? eligibleIds.length : rows.filter((row: any) => eligibleIds.includes(row.gap_id)).length, retained: table === 'gaps' ? protectedIds.length : rows.filter((row: any) => protectedIds.includes(row.gap_id)).length }]));
  const snapshot = { identity: identity[0], gapIds, eligibleIds, protectedIds, protectedReasons, processing, providers, counts, relationships, tables };
  return { ...snapshot, fingerprint: digest(snapshot) };
}
export async function discoveryResetPreview(actor: Principal) {
  await requirePolicyPermission(actor, 'maintenance.discovery');
  const connection = await mysqlPool.getConnection();
  try {
    const preview = await inventory(connection);
    return { status: 'PREVIEW_ONLY', target: preview.identity, counts: preview.counts, eligibleIds: preview.eligibleIds, protectedIds: preview.protectedIds, protectedReasons: preview.protectedReasons, queue: preview.tables.queue_items?.map((item: any) => ({ id: item.id, type: item.queue_type, status: item.status })), processing: preview.processing, relationships: preview.relationships, fingerprint: preview.fingerprint, providers: preview.providers, examinedTables: Object.keys(preview.tables), preserved: ['providers', 'users', 'policies', 'businesses', 'payments', 'specifications', 'audit_history'] };
  } finally { connection.release(); }
}
export async function exportDatabaseBackup(connection: any, directory: string, resetId: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const backupPath = path.join(directory, `discovery-reset-${resetId}.json`);
  const [identity] = await connection.query('SELECT DATABASE() AS databaseName, @@hostname AS serverName');
  const [list] = await connection.query('SHOW TABLES');
  const tables: { name: string; createSql: string; rows: any[] }[] = [];
  for (const entry of list as any[]) {
    const name = String(Object.values(entry)[0]);
    const [create] = await connection.query(`SHOW CREATE TABLE ${identifier(name)}`);
    const rows = await backupRows(connection, name);
    tables.push({ name, createSql: create[0]['Create Table'], rows });
  }
  const contents = JSON.stringify({ format: 'sao-database-backup-v1', identity: identity[0], resetId, createdAt: new Date().toISOString(), tables });
  await fs.writeFile(backupPath, contents, { mode: 0o600, flag: 'wx' });
  const reread = await fs.readFile(backupPath, 'utf8');
  const verified = JSON.parse(reread);
  if (digest(contents) !== digest(reread) || verified.tables.length !== tables.length || verified.tables.some((table: any, position: number) => table.rows.length !== tables[position].rows.length)) throw new Error('Backup verification failed.');
  return { backupPath, backupHash: crypto.createHash('sha256').update(contents).digest('hex'), tables: tables.map(table => ({ name: table.name, rows: table.rows.length })), readable: true, format: verified.format };
}
export async function restoreBackupIntoIsolatedDatabase(connection: any, backupPath: string, expectedHash: string) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Automatic restore verification is restricted to disposable test databases.');
  const [identity] = await connection.query('SELECT DATABASE() AS databaseName');
  const [existing] = await connection.query('SHOW TABLES');
  if (!/^sao_restore_test_[a-z0-9_]+$/.test(identity[0].databaseName) || existing.length) throw new Error('An empty, explicitly named isolated restore database is required.');
  const contents = await fs.readFile(backupPath, 'utf8');
  if (crypto.createHash('sha256').update(contents).digest('hex') !== expectedHash) throw new Error('Backup integrity verification failed.');
  const backup = JSON.parse(contents);
  if (backup.format !== 'sao-database-backup-v1') throw new Error('Unsupported backup format.');
  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const table of backup.tables) await connection.query(table.createSql);
    for (const table of backup.tables) {
      for (const row of table.rows) {
        const keys = Object.keys(row);
        const values = keys.map(key => row[key]?.type === 'Buffer' && Array.isArray(row[key].data) ? Buffer.from(row[key].data) : row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]);
        await connection.query(`INSERT INTO ${identifier(table.name)} (${keys.map(identifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, values);
      }
      const [count] = await connection.query(`SELECT COUNT(*) AS total FROM ${identifier(table.name)}`);
      if (Number(count[0].total) !== table.rows.length) throw new Error(`Restore row count mismatch: ${table.name}`);
      const restored = await backupRows(connection, table.name);
      if (digest(restored.map((row: any) => JSON.stringify(row)).sort()) !== digest(table.rows.map((row: any) => JSON.stringify(row)).sort())) throw new Error(`Restore content verification failed: ${table.name}`);
    }
  } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); }
  const [relationships] = await connection.query('SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
  for (const relationship of relationships) {
    const [orphans] = await connection.query(`SELECT COUNT(*) AS total FROM ${identifier(relationship.TABLE_NAME)} child LEFT JOIN ${identifier(relationship.REFERENCED_TABLE_NAME)} parent ON child.${identifier(relationship.COLUMN_NAME)}=parent.${identifier(relationship.REFERENCED_COLUMN_NAME)} WHERE child.${identifier(relationship.COLUMN_NAME)} IS NOT NULL AND parent.${identifier(relationship.REFERENCED_COLUMN_NAME)} IS NULL`);
    if (Number(orphans[0].total)) throw new Error(`Restored foreign key integrity failed: ${relationship.TABLE_NAME}`);
  }
  return { restoredTables: backup.tables.length, verified: true };
}
export async function prepareDiscoveryReset(actor: Principal, expectedDatabase: string) {
  await requirePolicyPermission(actor, 'maintenance.discovery');
  const connection = await mysqlPool.getConnection();
  try {
    const [lock] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [DISCOVERY_LOCK]) as any;
    if (Number(lock[0]?.acquired) !== 1) throw new Error('Discovery writer or another maintenance operation is active.');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction();
    const preview = await inventory(connection);
    if (preview.identity.databaseName !== expectedDatabase) throw new Error('Database identity does not match the requested target.');
    if (preview.processing.length) throw new Error(`Finish or safely pause ${preview.processing.length} active discovery workers before preparing reset.`);
    const id = generateId();
    const backup = await exportDatabaseBackup(connection, process.env.SAO_BACKUP_DIR || path.resolve('.sao-backups'), id);
    await connection.commit();
    const report = { id, actorId: actor.id, status: 'prepared', target: preview.identity, fingerprint: preview.fingerprint, gapIds: preview.gapIds, eligibleIds: preview.eligibleIds, protectedIds: preview.protectedIds, protectedReasons: preview.protectedReasons, counts: preview.counts, providers: preview.providers, backup, confirmation: `RESET DISCOVERY ${preview.identity.databaseName} DELETE ${preview.eligibleIds.length} ARCHIVE ${preview.protectedIds.length} ${preview.fingerprint}` };
    await db.insert(schema.discoveryResetReports).values({ id, actorId: actor.id, reportJson: JSON.stringify(report) });
    return report;
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.query('SELECT RELEASE_LOCK(?)', [DISCOVERY_LOCK]); connection.release(); }
}
export async function executeDiscoveryReset(actor: Principal, id: string, confirmation: string) {
  await requirePolicyPermission(actor, 'maintenance.discovery');
  const stored = (await db.select().from(schema.discoveryResetReports).where(eq(schema.discoveryResetReports.id, id)).limit(1))[0];
  if (!stored) throw new Error('Prepared reset not found.');
  const report = JSON.parse(stored.reportJson);
  if (report.status === 'completed') return report;
  if (report.status !== 'prepared' || confirmation !== report.confirmation) throw new Error('Exact target, counts and preview fingerprint confirmation required.');
  const backupContents = await fs.readFile(report.backup.backupPath, 'utf8');
  if (crypto.createHash('sha256').update(backupContents).digest('hex') !== report.backup.backupHash) throw new Error('Backup checksum mismatch.');
  JSON.parse(backupContents);
  const connection = await mysqlPool.getConnection();
  try {
    const [lock] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [DISCOVERY_LOCK]) as any;
    if (Number(lock[0]?.acquired) !== 1) throw new Error('Another discovery writer or maintenance operation is active.');
    await connection.beginTransaction();
    if (report.gapIds.length) {
      await connection.query('SELECT id FROM gaps WHERE id IN (?) FOR UPDATE', [report.gapIds]);
      await connection.query('SELECT id FROM queue_items WHERE gap_id IN (?) FOR UPDATE', [report.gapIds]);
    }
    const current = await inventory(connection, report.gapIds);
    if (current.identity.databaseName !== report.target.databaseName || current.identity.serverName !== report.target.serverName || current.fingerprint !== report.fingerprint || current.processing.length) throw new Error('Reset scope, target or protected relationships changed. Prepare and confirm a new preview.');
    const deleted: Record<string, number> = {};
    const archived: string[] = [];
    for (const gapId of current.protectedIds) {
      const gap = current.tables.gaps.find((candidate: any) => candidate.id === gapId);
      await connection.query('INSERT INTO discovery_archives (gap_id,reset_id,reason) VALUES (?,?,?)', [gapId, id, JSON.stringify({ reasons: current.protectedReasons[gapId], originalDedupHash: gap.dedup_hash })]);
      await connection.query('UPDATE gaps SET dedup_hash=? WHERE id=?', [`archive:${id}:${gapId}`, gapId]);
      await connection.query("UPDATE queue_items SET status='paused',worker_id=NULL,next_retry_at=NULL,last_error='Discovery candidate archived by approved maintenance',updated_at=NOW() WHERE gap_id=? AND queue_type='synthesis'", [gapId]);
      archived.push(gapId);
    }
    if (current.eligibleIds.length) {
      const evidence = (current.tables.evidence_records || []).filter((row: any) => current.eligibleIds.includes(row.gap_id));
      if (evidence.length) {
        const [result] = await connection.query('DELETE FROM evidence_events WHERE evidence_id IN (?)', [evidence.map((row: any) => row.id)]);
        deleted.evidence_events = (result as any).affectedRows;
      }
      for (const table of ['gap_policy_reviews', 'evidence_events', 'evidence_records', 'queue_items', 'gaps']) {
        if (!current.tables[table] && table !== 'gaps') continue;
        const [result] = await connection.query(`DELETE FROM ${identifier(table)} WHERE ${table === 'gaps' ? 'id' : 'gap_id'} IN (?)${table === 'queue_items' ? " AND queue_type='synthesis'" : ''}`, [current.eligibleIds]);
        deleted[table] = (deleted[table] || 0) + (result as any).affectedRows;
      }
    }
    const after = await inventory(connection, current.protectedIds);
    if (digest(after.providers) !== digest(current.providers)) throw new Error('Provider preservation check failed; reset rolled back.');
    for (const relation of current.relationships as any[]) {
      const [orphans] = await connection.query(`SELECT COUNT(*) AS total FROM ${identifier(relation.TABLE_NAME)} child LEFT JOIN ${identifier(relation.REFERENCED_TABLE_NAME)} parent ON child.${identifier(relation.COLUMN_NAME)}=parent.${identifier(relation.REFERENCED_COLUMN_NAME)} WHERE child.${identifier(relation.COLUMN_NAME)} IS NOT NULL AND parent.${identifier(relation.REFERENCED_COLUMN_NAME)} IS NULL`);
      if (Number((orphans as any)[0].total)) throw new Error(`Foreign key integrity check failed for ${relation.TABLE_NAME}.`);
    }
    const complete = { ...report, status: 'completed', executedBy: actor.id, completedAt: new Date().toISOString(), deleted, archived, retained: archived.length, providersVerified: true, counters: 'Active discovery and queue counts derive from unarchived records; permanent metrics retained.', cachesInvalidated: ['discovery_evidence'], coreLoopState: 'unchanged' };
    await connection.query('UPDATE discovery_reset_reports SET report_json=? WHERE id=?', [JSON.stringify(complete), id]);
    await connection.commit();
    clearDiscoveryEvidenceCache();
    return complete;
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.query('SELECT RELEASE_LOCK(?)', [DISCOVERY_LOCK]); connection.release(); }
}
