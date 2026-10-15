import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { rootCertificates } from 'node:tls';

async function main() {
  const [database, server] = process.argv.slice(2);
  if (!database || !server || !/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Supply exact independently inspected database/server identity.');
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  const user = url ? decodeURIComponent(url.username) : process.env.DB_USER;
  const password = url ? decodeURIComponent(url.password) : process.env.DB_PASSWORD;
  const configuredDatabase = url ? decodeURIComponent(url.pathname.slice(1)) : process.env.DB_NAME;
  if (configuredDatabase !== database) throw new Error('Configured database differs from approved backup target.');
  const connection = await mysql.createConnection({ host: '127.24.1.1', port: 3306, user, password, database, ssl: { rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== 'false' }, connectTimeout: 5000 });
  try {
    const [rows] = await connection.query<any[]>('SELECT DATABASE() AS databaseName,@@hostname AS serverName,@@version AS version');
    if (rows[0].databaseName !== database || rows[0].serverName !== server || rows[0].version !== '9.6.0') throw new Error('Backup target identity/version mismatch.');
  } finally { await connection.end(); }
  const directory = path.resolve('.sao-backups/production-readiness');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  const options = path.join(directory, `client-${id}.cnf`);
  const certificates = path.join(directory, `client-${id}-ca.pem`);
  const incomplete = path.join(directory, `mysql9-${id}.sql.incomplete`);
  const backupPath = incomplete.replace(/\.incomplete$/, '');
  await fs.writeFile(certificates, rootCertificates.join('\n'), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(options, `[client]\nhost=127.24.1.1\nport=3306\nuser=${JSON.stringify(user || '')}\npassword=${JSON.stringify(password || '')}\nssl-mode=${process.env.TLS_REJECT_UNAUTHORIZED === 'false' ? 'REQUIRED' : 'VERIFY_CA'}\nssl-ca=/client-ca.pem\n`, { flag: 'wx', mode: 0o600 });
  const destination = await fs.open(incomplete, 'wx', 0o600);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('docker', ['run', '--rm', '--network', 'host', '--mount', `type=bind,source=${options},target=/client.cnf,readonly`, '--mount', `type=bind,source=${certificates},target=/client-ca.pem,readonly`, '--entrypoint', 'mysqldump', 'mysql:9.6.0', '--defaults-extra-file=/client.cnf', '--single-transaction', '--skip-lock-tables', '--routines', '--events', '--triggers', '--no-tablespaces', '--set-gtid-purged=OFF', database], { stdio: ['ignore', destination.fd, 'pipe'], timeout: 300000, killSignal: 'SIGTERM' });
      child.stderr?.on('data', chunk => { const text = String(chunk); console.error(text.replaceAll(password || 'NEVER_MATCH_EMPTY_PASSWORD', '[redacted]').replaceAll(user || 'NEVER_MATCH_EMPTY_USER', '[database-user]')); });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (status !== 0) throw new Error('Native MySQL backup did not complete; partial output retained as .incomplete. Check provider backup privileges/TLS without weakening validation.');
  } finally { await destination.close(); await fs.unlink(options); await fs.unlink(certificates); }
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(incomplete)) hash.update(chunk);
  const contents = await fs.readFile(incomplete, 'utf8');
  if (!contents.slice(-1024).includes('Dump completed on')) throw new Error('Native backup completion marker missing; partial output retained.');
  await fs.rename(incomplete, backupPath);
  console.log(JSON.stringify({ database, server, engine: '9.6.0', backupPath, sha256: hash.digest('hex'), bytes: Buffer.byteLength(contents), consistentInnoDbSnapshot: true, routinesTriggersEvents: true, remoteWrites: 0, independentCopy: 'NOT PROVIDED', providerSnapshot: 'NOT PROVIDED', restoreVerification: 'Required in exact-version isolated staging' }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
