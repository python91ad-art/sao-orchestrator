import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from '../drizzle/schema';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import crypto from 'crypto';

// ==========================================
// Database Configuration
//
// Priority:
// 1. DATABASE_URL
// 2. DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
// 3. Local development defaults
//
// Northflank can provide either DATABASE_URL or
// individual DB_* variables.
//

// ==========================================

let dbHost: string;
let dbPort: number;
let dbUser: string;
let dbPassword: string;
let dbName: string;

const databaseUrl = process.env.DATABASE_URL;

// ==========================================
// Parse DATABASE_URL when provided
// ==========================================
if (databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);

    dbHost = parsed.hostname;
    dbPort = parseInt(parsed.port || '3306', 10);
    dbUser = decodeURIComponent(parsed.username);
    dbPassword = decodeURIComponent(parsed.password);
    dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));

    console.log('Using DATABASE_URL for MySQL connection.');
  } catch (error) {
    console.error('❌ Invalid DATABASE_URL:', error);
    throw new Error('DATABASE_URL is invalid or could not be parsed.');
  }
} else {
  // ==========================================
  // Individual database variables
  // ==========================================
  dbHost = process.env.DB_HOST || 'localhost';
  dbPort = parseInt(process.env.DB_PORT || '3306', 10);
  dbUser = process.env.DB_USER || 'root';
  dbPassword = process.env.DB_PASSWORD || '';
  dbName = process.env.DB_NAME || 'sao';

  console.log('Using individual DB_* variables for MySQL connection.');
}

// ==========================================
// Determine if we have a valid database config
// ==========================================
const hasDbConfig = !!(
  databaseUrl ||
  process.env.DB_HOST ||
  process.env.DB_USER ||
  process.env.DB_PASSWORD ||
  process.env.DB_NAME
);

const databaseUrlResolved = hasDbConfig
  ? databaseUrl || `mysql://${dbUser}:***@${dbHost}:${dbPort}/${dbName}`
  : null;

console.log(`DB Host: ${dbHost}:${dbPort}`);
console.log(`DB User: ${dbUser}`);
console.log(`DB Name: ${dbName}`);

// ==========================================
// Connection Pool — with TLS (required for Northflank)
// ==========================================
const poolConfig: mysql.PoolOptions = {
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPassword,
  database: dbName,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  maxIdle: 10,
  idleTimeout: 60000,

  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,

  connectTimeout: 20000,

  // Northflank MySQL requires TLS.
  ssl: {
    rejectUnauthorized: false,
  },
};


// ==========================================
// Create MySQL connection pool
// ==========================================
const poolConnection = mysql.createPool(poolConfig);

// ==========================================
// DIAGNOSTIC: Test connection at startup
// ==========================================
(async () => {
  const configForLog = {
    host: poolConfig.host,
    port: poolConfig.port,
    user: poolConfig.user,
    database: poolConfig.database,
    connectTimeout: poolConfig.connectTimeout,
    enableKeepAlive: poolConfig.enableKeepAlive,
    tlsEnabled: !!poolConfig.ssl,
    rejectUnauthorized: poolConfig.ssl?.rejectUnauthorized,
  };

  console.log('Attempting DB connection with config:', configForLog);

  try {
    const connection = await poolConnection.getConnection();

    console.log('DB connection successful');

    connection.release();
  } catch (err: any) {
    console.error('DB connection failed:', {
      host: poolConfig.host,
      port: poolConfig.port,
      database: poolConfig.database,
      code: err.code,
      errno: err.errno,
      fatal: err.fatal,
      message: err.message,
    });
  }
})();

// ==========================================
// Drizzle database
// ==========================================
export const db = drizzle(poolConnection, {
  schema,
  mode: 'default',
});

export { databaseUrlResolved };

// ==========================================
// Retry Logic
//
// Handles transient connection failures.
//
// Drizzle can wrap MySQL errors inside .cause,
// therefore both err and err.cause are checked.
// ==========================================
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  delayMs = 2000
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;

      // Drizzle may wrap MySQL errors in .cause.
      const code = err.code || err.cause?.code;
      const message = err.message || err.cause?.message || '';

      const isConnectionError =
        code === 'PROTOCOL_CONNECTION_LOST' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ER_CON_COUNT_ERROR' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EPIPE' ||
        code === 'ECONNABORTED' ||
        code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
        message.includes('Connection lost') ||
        message.includes('server closed the connection') ||
        message.includes('Connection closed') ||
        message.includes('Cannot enqueue Query after fatal error');

      if (!isConnectionError || attempt === maxRetries) {
        throw err;
      }

      console.warn(
        `[DB Retry] Attempt ${attempt}/${maxRetries} failed ` +
        `(${code || message}). Retrying in ${delayMs}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));

      // Exponential backoff.
      delayMs *= 2;
    }
  }

  throw lastErr;
}

// ==========================================
// ID Generator
// ==========================================
export function generateId(): string {
  return crypto.randomUUID();
}

// ==========================================
// User Helpers
// ==========================================
export async function createUser(
  email: string,
  passwordHash: string,
  role: 'admin' | 'user' = 'user'
) {
  const id = generateId();

  await db.insert(schema.users).values({
    id,
    email,
    passwordHash,
    role,
  });

  return getUserById(id);
}

export async function getUserByEmail(email: string) {
  const results = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  return results[0] || null;
}

export async function getUserById(id: string) {
  const results = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);

  return results[0] || null;
}

export async function updateUserResetCode(
  email: string,
  resetCode: string,
  expiry: Date
) {
  await db
    .update(schema.users)
    .set({
      resetCode,
      resetCodeExpiry: expiry,
    })
    .where(eq(schema.users.email, email));
}

export async function clearResetCode(email: string) {
  await db
    .update(schema.users)
    .set({
      resetCode: null,
      resetCodeExpiry: null,
    })
    .where(eq(schema.users.email, email));
}

export async function updateLastSignedIn(id: string) {
  await db
    .update(schema.users)
    .set({
      lastSignedIn: new Date(),
    })
    .where(eq(schema.users.id, id));
}

// ==========================================
// Gap Helpers
// ==========================================
export async function createGap(gapData: {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
  status?:
    | 'pending'
    | 'processing'
    | 'safe'
    | 'unsafe'
    | 'gray'
    | 'false'
    | 'deployed'
    | 'failed';
  priority?: number;
  dedupHash: string;
}) {
  const id = generateId();

  await db.insert(schema.gaps).values({
    id,
    ...gapData,
    status: gapData.status || 'pending',
    priority:
      gapData.priority !== undefined
        ? gapData.priority
        : 5,
  });

  return getGapById(id);
}

export async function getGapById(id: string) {
  const results = await db
    .select()
    .from(schema.gaps)
    .where(eq(schema.gaps.id, id))
    .limit(1);

  return results[0] || null;
}

export async function getGapByHash(dedupHash: string) {
  const results = await db
    .select()
    .from(schema.gaps)
    .where(eq(schema.gaps.dedupHash, dedupHash))
    .limit(1);

  return results[0] || null;
}

export async function listGaps(limit = 50, skip = 0) {
  return db
    .select()
    .from(schema.gaps)
    .orderBy(desc(schema.gaps.createdAt))
    .limit(limit)
    .offset(skip);
}

export async function updateGapStatus(
  id: string,
  status:
    | 'pending'
    | 'processing'
    | 'safe'
    | 'unsafe'
    | 'gray'
    | 'false'
    | 'deployed'
    | 'failed'
) {
  await db
    .update(schema.gaps)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(schema.gaps.id, id));

  return getGapById(id);
}

// ==========================================
// Queue Helpers
// ==========================================
export async function createQueueItem(itemData: {
  gapId: string;
  dedupHash: string;
  priority?: number;
  sortOrder?: number;
}) {
  const id = generateId();

  await db.insert(schema.queueItems).values({
    id,
    gapId: itemData.gapId,
    dedupHash: itemData.dedupHash,
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    priority:
      itemData.priority !== undefined
        ? itemData.priority
        : 5,
    sortOrder:
      itemData.sortOrder !== undefined
        ? itemData.sortOrder
        : 0,
  });

  return getQueueItem(id);
}

export async function getQueueItem(id: string) {
  const results = await db
    .select()
    .from(schema.queueItems)
    .where(eq(schema.queueItems.id, id))
    .limit(1);

  return results[0] || null;
}

export async function listQueueItems() {
  return db
    .select({
      queueItem: schema.queueItems,
      gap: schema.gaps,
    })
    .from(schema.queueItems)
    .leftJoin(
      schema.gaps,
      eq(schema.queueItems.gapId, schema.gaps.id)
    )
    .orderBy(
      asc(schema.queueItems.sortOrder),
      desc(schema.queueItems.priority),
      desc(schema.queueItems.createdAt)
    );
}

export async function updateQueueItem(
  id: string,
  updates: Partial<typeof schema.queueItems.$inferSelect>
) {
  await db
    .update(schema.queueItems)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(schema.queueItems.id, id));

  return getQueueItem(id);
}

export async function deleteQueueItem(id: string) {
  await db
    .delete(schema.queueItems)
    .where(eq(schema.queueItems.id, id));
}

export async function getNextPendingQueueItem() {
  const results = await db
    .select()
    .from(schema.queueItems)
    .where(eq(schema.queueItems.status, 'pending'))
    .orderBy(
      asc(schema.queueItems.sortOrder),
      desc(schema.queueItems.priority),
      asc(schema.queueItems.createdAt)
    )
    .limit(1);

  return results[0] || null;
}

export async function getQueueStats() {
  const allItems = await db
    .select({
      status: schema.queueItems.status,
      count: sql<number>`count(*)`,
    })
    .from(schema.queueItems)
    .groupBy(schema.queueItems.status);

  const stats = {
    total: 0,
    pending: 0,
    processing: 0,
    paused: 0,
    completed: 0,
    failed: 0,
  };

  for (const item of allItems) {
    const status = item.status as keyof typeof stats;

    stats[status] = Number(item.count);
    stats.total += Number(item.count);
  }

  return stats;
}

// ==========================================
// Deployment Helpers
// ==========================================
export async function createDeployment(deploymentData: {
  gapId: string;
  businessPlan?: string;
  revenue?: string;
  costPerDay?: string;
  banRisk?: 'low' | 'medium' | 'high';
  health?: 'healthy' | 'warning' | 'critical';
  stripeProductId?: string;
  stripePriceId?: string;
}) {
  const id = generateId();

  await db.insert(schema.deployments).values({
    id,
    gapId: deploymentData.gapId,
    businessPlan: deploymentData.businessPlan || '',
    revenue: deploymentData.revenue || '0.00',
    costPerDay: deploymentData.costPerDay || '0.00',
    banRisk: deploymentData.banRisk || 'low',
    health: deploymentData.health || 'healthy',
    stripeProductId:
      deploymentData.stripeProductId || null,
    stripePriceId:
      deploymentData.stripePriceId || null,
  });

  return getDeploymentById(id);
}

export async function getDeploymentById(id: string) {
  const results = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.id, id))
    .limit(1);

  return results[0] || null;
}

export async function getDeploymentByGapId(gapId: string) {
  const results = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.gapId, gapId))
    .limit(1);

  return results[0] || null;
}

export async function listDeployments() {
  return db
    .select()
    .from(schema.deployments)
    .orderBy(desc(schema.deployments.createdAt));
}

export async function updateDeployment(
  id: string,
  updates: Partial<typeof schema.deployments.$inferSelect>
) {
  await db
    .update(schema.deployments)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(schema.deployments.id, id));

  return getDeploymentById(id);
}

// ==========================================
// Audit Helpers
// ==========================================
export async function createAuditLog(logData: {
  deploymentId?: string;
  gapId?: string;
  decision: string;
  reasoning: string;
  explanation: string;
  banRisk: 'low' | 'medium' | 'high';
  businessHealth?: 'healthy' | 'warning' | 'critical';
}) {
  const id = generateId();

  await db.insert(schema.auditLogs).values({
    id,
    ...logData,
  });

  const results = await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.id, id))
    .limit(1);

  return results[0];
}

export async function listAuditLogs(
  limit = 50,
  offset = 0
) {
  return db
    .select()
    .from(schema.auditLogs)
    .orderBy(desc(schema.auditLogs.timestamp))
    .limit(limit)
    .offset(offset);
}

// ==========================================
// Policy Helpers
// ==========================================
export async function createPolicy(ruleText: string) {
  const id = generateId();

  await db.insert(schema.policies).values({
    id,
    ruleText,
  });

  const results = await db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.id, id))
    .limit(1);

  return results[0];
}

export async function listPolicies() {
  return db
    .select()
    .from(schema.policies)
    .orderBy(desc(schema.policies.createdAt));
}

export async function updatePolicyAcknowledged(id: string) {
  await db
    .update(schema.policies)
    .set({
      acknowledgedAt: new Date(),
    })
    .where(eq(schema.policies.id, id));

  const results = await db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.id, id))
    .limit(1);

  return results[0] || null;
}

export async function deletePolicy(id: string) {
  await db
    .delete(schema.policies)
    .where(eq(schema.policies.id, id));
}

// ==========================================
// Recurring Actor Helpers
// ==========================================
export async function upsertRecurringActor(
  actorHash: string,
  anonymizedId: string,
  pattern?: string
) {
  const existing = await db
    .select()
    .from(schema.recurringActors)
    .where(eq(schema.recurringActors.actorHash, actorHash))
    .limit(1);

  if (existing[0]) {
    await db
      .update(schema.recurringActors)
      .set({
        frequency: existing[0].frequency + 1,
        lastSeen: new Date(),
        pattern:
          pattern || existing[0].pattern,
      })
      .where(
        eq(
          schema.recurringActors.actorHash,
          actorHash
        )
      );
  } else {
    const id = generateId();

    await db.insert(schema.recurringActors).values({
      id,
      actorHash,
      anonymizedId,
      pattern: pattern || null,
      frequency: 1,
      lastSeen: new Date(),
    });
  }
}

// ==========================================
// Core Loop State
// ==========================================
export async function getCoreLoopState() {
  const results = await db
    .select()
    .from(schema.coreLoopState)
    .where(
      eq(
        schema.coreLoopState.id,
        'singleton'
      )
    )
    .limit(1);

  return results[0] || null;
}

export async function initCoreLoopState() {
  const existing = await getCoreLoopState();

  if (!existing) {
    await db.insert(schema.coreLoopState).values({
      id: 'singleton',
      isRunning: false,
      intervalMs: 10800000,
      totalGapsProcessed: 0,
      totalDeploymentsCreated: 0,
    });

    console.log(
      'Core loop state initialized with defaults.'
    );

    return getCoreLoopState();
  }

  return existing;
}

export async function updateCoreLoopState(
  updates: Partial<typeof schema.coreLoopState.$inferSelect>
) {
  await db
    .update(schema.coreLoopState)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(
      eq(
        schema.coreLoopState.id,
        'singleton'
      )
    );

  return getCoreLoopState();
}

// ==========================================
// Health Check Helpers
// ==========================================
export async function createHealthCheck(checkData: {
  deploymentId: string;
  revenue: string;
  banRisk: 'low' | 'medium' | 'high';
  health: 'healthy' | 'warning' | 'critical';
  action?: string;
  success?: boolean;
}) {
  const id = generateId();

  await db
    .insert(schema.deploymentHealthChecks)
    .values({
      id,
      ...checkData,
    });

  const results = await db
    .select()
    .from(schema.deploymentHealthChecks)
    .where(
      eq(
        schema.deploymentHealthChecks.id,
        id
      )
    )
    .limit(1);

  return results[0];
}

export async function listHealthChecks(
  deploymentId: string
) {
  return db
    .select()
    .from(schema.deploymentHealthChecks)
    .where(
      eq(
        schema.deploymentHealthChecks.deploymentId,
        deploymentId
      )
    )
    .orderBy(
      desc(
        schema.deploymentHealthChecks.checkedAt
      )
    );
}
