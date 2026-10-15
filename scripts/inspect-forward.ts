import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  const connection = await mysql.createConnection({
    host: '127.24.1.1', port: 3306,
    user: url ? decodeURIComponent(url.username) : process.env.DB_USER,
    password: url ? decodeURIComponent(url.password) : process.env.DB_PASSWORD,
    database: url ? decodeURIComponent(url.pathname.slice(1)) : process.env.DB_NAME,
    ssl: { rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== 'false' },
    connectTimeout: 5000,
  });
  try {
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [identity] = await connection.query('SELECT DATABASE() AS databaseName, @@hostname AS serverName, @@version AS version');
    const [tables] = await connection.query('SHOW TABLES');
    const [counts] = await connection.query('SELECT (SELECT COUNT(*) FROM gaps) AS gaps, (SELECT COUNT(*) FROM deployments) AS businesses, (SELECT COUNT(*) FROM queue_items) AS queueItems, (SELECT COUNT(*) FROM integration_credentials) AS credentials');
    const [relationships] = await connection.query('SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
    const [candidateScope] = await connection.query("SELECT COUNT(*) AS total, SUM(EXISTS(SELECT 1 FROM deployments d WHERE d.gap_id=g.id) OR EXISTS(SELECT 1 FROM audit_logs a WHERE a.gap_id=g.id) OR EXISTS(SELECT 1 FROM queue_items q WHERE q.gap_id=g.id AND q.queue_type<>'synthesis')) AS protected FROM gaps g");
    const [queue] = await connection.query('SELECT queue_type,status,COUNT(*) AS count FROM queue_items GROUP BY queue_type,status');
    const [admins] = await connection.query("SELECT id,role,last_signed_in FROM users WHERE role='admin'");
    const [providerSummary] = await connection.query('SELECT id,service,name,enabled,provider_id,connection_status FROM integration_credentials ORDER BY id');
    console.log(JSON.stringify({ identity, tables, counts, candidateScope, queue, admins, providerSummary, relationships, appliedInfrastructure: { lifecycleTables: (tables as any[]).some(table => Object.values(table).includes('agents')), policyTables: (tables as any[]).some(table => Object.values(table).includes('policy_versions')) } }, null, 2));
    await connection.rollback();
  } finally { await connection.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
