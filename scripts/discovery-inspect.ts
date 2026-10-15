import { mysqlPool } from '../server/db';

async function main() {
  const connection = await mysqlPool.getConnection();
  try {
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [target] = await connection.query('SELECT DATABASE() AS databaseName, @@hostname AS serverName');
    const [counts] = await connection.query(`SELECT COUNT(*) AS candidates, SUM(EXISTS(SELECT 1 FROM deployments d WHERE d.gap_id = g.id) OR EXISTS(SELECT 1 FROM business_specifications s WHERE s.gap_id = g.id) OR EXISTS(SELECT 1 FROM build_projects b WHERE b.gap_id = g.id)) AS protected FROM gaps g`);
    const [queue] = await connection.query('SELECT queue_type, status, COUNT(*) AS count FROM queue_items GROUP BY queue_type, status');
    const [relationships] = await connection.query('SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
    console.log(JSON.stringify({ target, counts, queue, relationships, mode: 'READ_ONLY_PREVIEW', deleted: 0 }, null, 2));
    await connection.rollback();
  } finally { connection.release(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; }).finally(() => mysqlPool.end());
