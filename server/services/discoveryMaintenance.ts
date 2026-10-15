import { mysqlPool } from '../db';
import { AsyncLocalStorage } from 'node:async_hooks';

export const DISCOVERY_LOCK = 'sao:discovery-maintenance';
const discoveryScope = new AsyncLocalStorage<boolean>();
export async function withDiscoveryWrite<T>(operation: () => Promise<T>): Promise<T> {
  if (discoveryScope.getStore()) return operation();
  const connection = await mysqlPool.getConnection();
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [DISCOVERY_LOCK]) as any;
    if (Number(rows[0]?.acquired) !== 1) throw new Error('Discovery maintenance is active. Candidate writes are temporarily unavailable.');
    return await discoveryScope.run(true, operation);
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [DISCOVERY_LOCK]);
    connection.release();
  }
}
