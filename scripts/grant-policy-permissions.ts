import 'dotenv/config';
import { users, adminPermissions, operationalEvents } from '../drizzle/schema';
import { eq, sql } from 'drizzle-orm';
import { ADMIN_PERMISSIONS } from '../shared/permissions';
import crypto from 'node:crypto';

async function main() {
  const args = process.argv.slice(2);
  const id = args[0];
  const argument = (name: string) => { const position = args.indexOf(name); const value = position >= 0 ? args[position + 1] : undefined; return value && !value.startsWith('--') ? value : undefined; };
  if (!id || id.startsWith('--')) throw new Error('Supply the verified existing administrator ID. Preview is read-only unless --apply and exact --confirm are supplied.');
  const seen = new Set<string>();
  for (let position = 1; position < args.length; position++) {
    const flag = args[position];
    if (!['--local-forward', '--apply', '--confirm', '--reason'].includes(flag) || seen.has(flag)) throw new Error('Unknown or duplicate provisioning argument; ambiguous requests are rejected.');
    seen.add(flag);
    if (['--confirm', '--reason'].includes(flag)) { if (!argument(flag)) throw new Error(`A value is required for ${flag}.`); position++; }
  }
  if (args.includes('--local-forward')) {
    if (process.env.DATABASE_URL) { const url = new URL(process.env.DATABASE_URL); url.hostname = '127.24.1.1'; url.port = '3306'; process.env.DATABASE_URL = url.toString(); }
    else { process.env.DB_HOST = '127.24.1.1'; process.env.DB_PORT = '3306'; }
  }
  const { db, mysqlPool } = await import('../server/db');
  try {
    const [rows] = await db.execute(sql`SELECT DATABASE() AS databaseName, @@hostname AS serverName`);
    const target = (rows as any[])[0];
    const user = (await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).limit(1))[0];
    if (!user || user.role !== 'admin') throw new Error('An existing administrator identity is required; no accounts were created.');
    const confirmation = `${target.databaseName}/${target.serverName}/${id}`;
    const [permissionTables] = await db.execute(sql`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_permissions'`);
    const existing = (permissionTables as any[]).length ? await db.select().from(adminPermissions).where(eq(adminPermissions.userId, id)) : [];
    const missing = ADMIN_PERMISSIONS.filter(permission => !existing.some(row => row.permission === permission));
    if (!args.includes('--apply')) { console.log(JSON.stringify({ mode: 'read_only_preview', target, administratorId: id, existingPermissions: existing.map(row => row.permission), permissions: missing, prerequisite: (permissionTables as any[]).length ? null : 'Approved policy migration required before applying grants', requiredConfirmation: confirmation })); return; }
    if (!args.includes('--confirm') || argument('--confirm') !== confirmation || !args.includes('--reason') || !argument('--reason')?.trim()) throw new Error('Exact database/server/administrator confirmation and a change reason are required.');
    await db.transaction(async tx => {
      const verified = (await tx.select({ role: users.role }).from(users).where(eq(users.id, id)).for('update'))[0];
      if (verified?.role !== 'admin') throw new Error('Administrator role changed; grants were not applied.');
      for (const permission of ADMIN_PERMISSIONS) await tx.insert(adminPermissions).values({ userId: id, permission }).onDuplicateKeyUpdate({ set: { permission } });
      await tx.insert(operationalEvents).values({ id: crypto.randomUUID(), actorId: 'maintenance:permission-provisioner', type: 'administrator_permissions_granted', resourceId: id, detailJson: JSON.stringify({ target, permissions: ADMIN_PERMISSIONS, reason: argument('--reason') }) });
    });
    console.log('Audited explicit permissions granted to the verified existing administrator:', id);
  } finally { await mysqlPool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
