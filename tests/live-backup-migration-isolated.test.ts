import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) throw new Error('Supply the private read-only Northflank application backup path. No connection to Northflank is made by this test.');
  const original = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  assert.equal(original.format, 'sao-database-backup-v1');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sao-live-migration-'));
  const socketDirectory = path.join(directory, 'socket');
  await fs.mkdir(socketDirectory, { mode: 0o1777 });
  const socketPath = path.join(socketDirectory, 'mysql.sock');
  const mysql9 = process.argv.includes('--mysql9');
  const containerName = `sao-mysql9-${crypto.randomUUID()}`;
  const applicationName = `sao-staging-${crypto.randomUUID()}`;
  let server: ReturnType<typeof spawn> | undefined;
  if (mysql9) {
    const started = spawnSync('docker', ['run', '-d', '--name', containerName, '--network', 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '256', '--tmpfs', '/var/lib/mysql:rw,size=1g', '--mount', `type=bind,source=${socketDirectory},target=/var/run/mysqld`, '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', 'mysql:9.6.0', '--socket=/var/run/mysqld/mysql.sock', '--innodb-buffer-pool-size=64M', '--innodb-redo-log-capacity=64M', '--max-connections=20'], { encoding: 'utf8' });
    if (started.status !== 0) throw new Error(`Disposable MySQL 9 startup failed: ${started.stderr}`);
  } else {
    const installed = spawnSync('mariadb-install-db', [`--datadir=${directory}/data`, '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
    if (installed.status !== 0) throw new Error('Disposable MariaDB initialization failed.');
    server = spawn('mysqld', [`--datadir=${directory}/data`, `--socket=${socketPath}`, `--pid-file=${directory}/pid`, '--skip-networking', '--skip-grant-tables'], { stdio: 'ignore' });
  }
  let connection: mysql.Connection | undefined;
  let pool: { end: () => Promise<void> } | undefined;
  try {
    for (let attempt = 0; attempt < 240; attempt++) {
      try {
        const candidate = await mysql.createConnection({ socketPath, user: 'root', jsonStrings: true });
        if (mysql9) {
          const [state] = await candidate.query<any[]>('SELECT @@skip_networking AS initializing');
          if (state[0].initializing) { await candidate.end(); await new Promise(resolve => setTimeout(resolve, 250)); continue; }
        }
        connection = candidate;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!connection) throw new Error('Disposable MariaDB did not start.');
    const [engine] = await connection.query<any[]>('SELECT VERSION() AS version');
    if (mysql9) assert.equal(engine[0].version, '9.6.0');
    const verifiedCollation = process.argv.find(argument => argument.startsWith('--database-collation='))?.split('=')[1] || original.identity.databaseCollation;
    if (mysql9 && (!verifiedCollation || !/^utf8mb4_[a-z0-9_]+$/.test(verifiedCollation))) throw new Error('Supply the independently inspected source database collation; MySQL 9 defaults must not be guessed.');
    await connection.query(`CREATE DATABASE sao_restore_test_northflank CHARACTER SET utf8mb4 COLLATE ${mysql9 ? verifiedCollation : 'utf8mb4_general_ci'}`);
    await connection.query('USE sao_restore_test_northflank');
    const compatible = mysql9 ? original : { ...original, tables: original.tables.map((table: any) => ({ ...table, createSql: table.createSql.replace(/utf8mb4_0900_ai_ci/g, 'utf8mb4_general_ci') })) };
    const contents = JSON.stringify(compatible);
    const compatiblePath = path.join(directory, 'compatible-backup.json');
    await fs.writeFile(compatiblePath, contents, { mode: 0o600 });
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: '', DB_HOST: 'localhost', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'sao_restore_test_northflank', DB_SOCKET: socketPath });
    const { restoreBackupIntoIsolatedDatabase } = await import('../server/services/discoveryReset');
    pool = (await import('../server/db')).mysqlPool;
    await restoreBackupIntoIsolatedDatabase(connection, compatiblePath, crypto.createHash('sha256').update(contents).digest('hex'));
    if (mysql9 && verifiedCollation !== 'utf8mb4_0900_ai_ci') {
      await connection.query('ALTER DATABASE sao_restore_test_northflank COLLATE utf8mb4_0900_ai_ci');
      const mismatched = spawnSync('node', ['run-migration.js'], { env: process.env, encoding: 'utf8' });
      assert.notEqual(mismatched.status, 0);
      assert.match(mismatched.stderr, /Migration preflight blocked/);
      const [unchangedTables] = await connection.query<any[]>('SHOW TABLES');
      assert.equal(unchangedTables.length, original.tables.length, 'Wrong-collation migration must stop before any DDL.');
      await connection.query(`ALTER DATABASE sao_restore_test_northflank COLLATE ${verifiedCollation}`);
      console.log('PASS incompatible identifier/schema collation rejected before DDL; original table inventory unchanged.');
    }
    for (let repetition = 0; repetition < 2; repetition++) {
      const started = performance.now();
      const migrated = spawnSync('node', ['run-migration.js'], { env: process.env, encoding: 'utf8', timeout: 120000 });
      if (migrated.status !== 0) throw new Error(`Isolated migration failed: ${migrated.stderr.slice(-2000)} ${migrated.stdout.slice(-2000)}`);
      console.log(`Migration application ${repetition + 1}: ${Math.round(performance.now() - started)}ms on ${engine[0].version}`);
    }
    for (const table of compatible.tables) {
      const keys = Object.keys(table.rows[0] || {});
      const [count] = await connection.query<any[]>(`SELECT COUNT(*) AS total FROM \`${table.name}\``);
      assert.equal(Number(count[0].total), table.rows.length, `Existing row preservation: ${table.name}`);
      if (!keys.length) continue;
      const [columns] = await connection.query<any[]>('SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table.name]);
      const dateColumns = columns.filter(column => ['datetime', 'timestamp', 'date', 'time', 'json'].includes(column.DATA_TYPE)).map(column => column.COLUMN_NAME);
      const select = keys.map(key => dateColumns.includes(key) ? `CAST(\`${key}\` AS CHAR) AS \`${key}\`` : `\`${key}\``).join(',');
      const [rows] = await connection.query<any[]>(`SELECT ${select} FROM \`${table.name}\``);
      const fingerprint = (values: any[]) => crypto.createHash('sha256').update(JSON.stringify(values.map(row => JSON.stringify(row)).sort())).digest('hex');
      assert.equal(fingerprint(rows), fingerprint(table.rows), `Existing field preservation: ${table.name}`);
    }
    const [migrationAudit] = await connection.query<any[]>("SELECT detail_json FROM operational_events WHERE event_type='schema_migration_verified'");
    assert.equal(migrationAudit.length, 1, 'Repeated identical migrations must have one durable checksum-linked audit record.');
    assert.ok(JSON.parse(migrationAudit[0].detail_json).hashes['run-migration.js']);
    console.log('PASS restored actual Northflank application data and reapplied migrations twice without changing any original rows or fields, including provider credentials and business ownership.');
    if (!mysql9) console.log('DIALECT_LIMITATION: isolated MariaDB uses utf8mb4_general_ci in place of MySQL 9 utf8mb4_0900_ai_ci. Original backup is unchanged.');
    if (mysql9) {
      const nativeDump = process.argv.find(argument => argument.startsWith('--native-dump='))?.slice('--native-dump='.length);
      const nativeHash = process.argv.find(argument => argument.startsWith('--native-sha256='))?.slice('--native-sha256='.length);
      if (nativeDump) {
        const contents = await fs.readFile(nativeDump);
        assert.equal(crypto.createHash('sha256').update(contents).digest('hex'), nativeHash, 'Native dump integrity must match its independent backup receipt.');
        await connection.query(`CREATE DATABASE sao_restore_test_native CHARACTER SET utf8mb4 COLLATE ${verifiedCollation}`);
        const restored = spawnSync('docker', ['run', '--rm', '--network', 'none', '--memory', '256m', '--mount', `type=bind,source=${socketDirectory},target=/var/run/mysqld`, '--mount', `type=bind,source=${path.resolve(nativeDump)},target=/backup.sql,readonly`, '--entrypoint', 'sh', 'mysql:9.6.0', '-c', 'mysql --socket=/var/run/mysqld/mysql.sock -uroot sao_restore_test_native < /backup.sql'], { encoding: 'utf8', timeout: 120000 });
        assert.equal(restored.status, 0, 'The full native SQL backup must restore successfully.');
        const [nativeTables] = await connection.query<any[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='sao_restore_test_native'");
        assert.equal(nativeTables.length, original.tables.length);
        for (const name of ['integration_credentials', 'deployment_providers', 'deployments', 'users', 'payments']) {
          const expected = original.tables.find((table: any) => table.name === name);
          const [nativeRows] = await connection.query<any[]>(`SELECT COUNT(*) AS count FROM sao_restore_test_native.\`${name}\``);
          assert.equal(Number(nativeRows[0].count), expected.rows.length, `Native restore protected record count: ${name}`);
        }
        console.log('PASS full native MySQL logical backup checksum, SQL restoration and protected provider/business/user/payment counts on exact MySQL 9.6.0.');
      }
      const deployment = original.tables.find((table: any) => table.name === 'deployments')?.rows[0];
      if (deployment) {
        const fixture = { ...deployment, id: 'isolated-null-owner', user_id: null };
        await connection.query(`INSERT INTO deployments (${Object.keys(fixture).map(key => `\`${key}\``).join(',')}) VALUES (${Object.keys(fixture).map(() => '?').join(',')})`, Object.values(fixture));
        const repeated = spawnSync('node', ['run-migration.js'], { env: process.env, encoding: 'utf8' });
        assert.equal(repeated.status, 0);
        const [owner] = await connection.query<any[]>("SELECT user_id FROM deployments WHERE id='isolated-null-owner'");
        assert.equal(owner[0].user_id, null);
      }
      await connection.query('UPDATE core_loop_state SET is_running=0');
      await connection.query("INSERT INTO operational_settings(setting_key,value_json,updated_by) VALUES('emergencyStop','true','isolated-staging') ON DUPLICATE KEY UPDATE value_json='true'");
      const started = spawnSync('docker', ['run', '-d', '--name', applicationName, '--network', 'none', '--memory', '1g', '--cpus', '2', '--pids-limit', '256', '--mount', `type=bind,source=${socketDirectory},target=/test-db`, '-e', 'NODE_ENV=production', '-e', 'DATABASE_URL=', '-e', 'DB_SOCKET=/test-db/mysql.sock', '-e', 'DB_USER=root', '-e', 'DB_PASSWORD=', '-e', 'DB_NAME=sao_restore_test_northflank', '-e', 'JWT_SECRET=isolated-staging-not-a-production-secret', 'sao-policy-verification:local'], { encoding: 'utf8' });
      assert.equal(started.status, 0, started.stderr);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const probe = spawnSync('docker', ['exec', applicationName, 'node', '-e', "(async()=>{for(const path of ['/api/health','/api/ready','/']){const r=await fetch('http://127.0.0.1:3000'+path);if(r.status!==200)throw Error(path+' not ready')}const denied=await fetch('http://127.0.0.1:3000/api/trpc/policies.overview');if(![401,403].includes(denied.status))throw Error('Protected API is exposed')})().catch(()=>process.exit(1))"], { encoding: 'utf8', timeout: 10000 });
        if (probe.status === 0) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) { const logs = spawnSync('docker', ['logs', applicationName], { encoding: 'utf8' }); throw new Error(`Staging application did not become ready: ${logs.stdout.slice(-2500)} ${logs.stderr.slice(-2500)}`); }
      console.log(`PASS exact MySQL 9.6.0 source collation ${verifiedCollation}/JSON migration, unchanged original fields, NULL ownership, real production entrypoint, DB readiness, compiled client and unauthorized policy API denial. Containers have no network and disposable-only credentials.`);
    }
  } catch (error) {
    if (mysql9) {
      console.error(spawnSync('docker', ['inspect', containerName, '--format', '{{json .State}}'], { encoding: 'utf8' }).stdout);
      console.error(spawnSync('docker', ['logs', '--tail', '20', containerName], { encoding: 'utf8' }).stderr);
    }
    throw error;
  } finally {
    await connection?.end();
    await pool?.end();
    if (mysql9) {
      spawnSync('docker', ['rm', '-f', applicationName], { stdio: 'ignore' });
      spawnSync('docker', ['exec', '--user', 'root', containerName, 'sh', '-c', `chown ${process.getuid?.() || 1000}:${process.getgid?.() || 1000} /var/run/mysqld && chmod 0700 /var/run/mysqld`], { stdio: 'ignore' });
      spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    } else if (server) await new Promise<void>(resolve => { if (server!.exitCode !== null || server!.signalCode) return resolve(); server!.once('exit', () => resolve()); server!.kill('SIGTERM'); });
    try { await fs.rm(directory, { recursive: true, force: true }); } catch { console.error('Disposable directory cleanup needs attention:', directory); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
