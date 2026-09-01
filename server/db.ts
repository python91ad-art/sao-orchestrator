import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from '../drizzle/schema';
import { eq, and, or, isNull, desc, asc, sql, inArray } from 'drizzle-orm';
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
  // production defaults to secure certificate verification.
  // Set TLS_REJECT_UNAUTHORIZED=false only if your provider uses self-signed certs.
  ssl: {
    rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== 'false',
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
    rejectUnauthorized: typeof poolConfig.ssl === 'object' ? poolConfig.ssl.rejectUnauthorized : undefined,
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
// User Helpers (email normalized to lowercase)
// ==========================================
export async function createUser(
  email: string,
  passwordHash: string,
  role: 'admin' | 'user' = 'user'
) {
  const normalizedEmail = email.trim().toLowerCase();
  const id = generateId();

  await db.insert(schema.users).values({
    id,
    email: normalizedEmail,
    passwordHash,
    role,
  });

  return getUserById(id);
}

export async function getUserByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const results = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, normalizedEmail))
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

/**
 * Returns the first admin user ID — used by internal orchestrator
 * to assign ownership of autonomously-created deployments.
 */
export async function getAdminUserId(): Promise<string | null> {
  const results = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, 'admin'))
    .orderBy(asc(schema.users.createdAt))
    .limit(1);
  return results[0]?.id || null;
}

export async function updateUserResetCode(
  email: string,
  resetCode: string,
  expiry: Date
) {
  const normalizedEmail = email.trim().toLowerCase();
  await db
    .update(schema.users)
    .set({
      resetCode,
      resetCodeExpiry: expiry,
    })
    .where(eq(schema.users.email, normalizedEmail));
}

export async function clearResetCode(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  await db
    .update(schema.users)
    .set({
      resetCode: null,
      resetCodeExpiry: null,
    })
    .where(eq(schema.users.email, normalizedEmail));
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

  const coreLoopState = await getCoreLoopState();
  const configuredMaxAttempts = Math.max(
    1,
    Number(coreLoopState?.maxAttempts) || 3
  );

  await db.insert(schema.queueItems).values({
    id,
    gapId: itemData.gapId,
    dedupHash: itemData.dedupHash,
    status: 'pending',
    attempts: 0,
    maxAttempts: configuredMaxAttempts,
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

// REPLACED: claimNextPendingQueueItem instead of getNextPendingQueueItem
export async function claimNextPendingQueueItem(workerId: string) {
  const results = await db
    .select()
    .from(schema.queueItems)
    .where(
      and(
        eq(schema.queueItems.status, 'pending'),
        or(
          isNull(schema.queueItems.nextRetryAt),
          sql`${schema.queueItems.nextRetryAt} <= NOW()`
        )
      )
    )
    .orderBy(
      asc(schema.queueItems.sortOrder),
      desc(schema.queueItems.priority),
      asc(schema.queueItems.createdAt)
    )
    .limit(1);

  const item = results[0];

  if (!item) {
    return null;
  }

  const claimed = await db
    .update(schema.queueItems)
    .set({
      status: 'processing',
      workerId,
      attempts: item.attempts + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.queueItems.id, item.id),
        eq(schema.queueItems.status, 'pending')
      )
    );

  // Check if the update affected exactly one row (optimistic locking)
  if (claimed[0]?.affectedRows !== 1) {
    return null;
  }

  return getQueueItem(item.id);
}

// Recover queue items left in `processing` after a worker/process restart.
// Only recover items that have been inactive long enough to avoid stealing
// work from a still-running worker.
export async function touchProcessingQueueItem(id: string, workerId: string) {
  const result = await db
    .update(schema.queueItems)
    .set({
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.queueItems.id, id),
        eq(schema.queueItems.status, 'processing'),
        eq(schema.queueItems.workerId, workerId)
      )
    );

  return Number(result[0]?.affectedRows || 0) === 1;
}

export async function recoverStaleProcessingQueueItems(
  staleAfterMinutes: number = 30
) {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000);

  const result = await db
    .update(schema.queueItems)
    .set({
      status: 'pending',
      workerId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.queueItems.status, 'processing'),
        sql`${schema.queueItems.updatedAt} < ${cutoff}`
      )
    );

  return Number(result[0]?.affectedRows || 0);
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
  userId?: string | null;
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
    userId: deploymentData.userId || null,
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

export async function listDeployments(userId?: string) {
  if (userId) {
    return db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.userId, userId))
      .orderBy(desc(schema.deployments.createdAt));
  }
  return db
    .select()
    .from(schema.deployments)
    .orderBy(desc(schema.deployments.createdAt));
}

export async function getDeploymentForUser(
  id: string,
  userId: string
) {
  const results = await db
    .select()
    .from(schema.deployments)
    .where(
      and(
        eq(schema.deployments.id, id),
        eq(schema.deployments.userId, userId)
      )
    )
    .limit(1);
  return results[0] || null;
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
// Deployment Providers (infrastructure providers, e.g. Vercel)
// ==========================================
export async function createDeploymentProvider(
  deploymentId: string,
  providerType: 'vercel' | 'mollie',
  providerConfig: Record<string, unknown>,
  deploymentUrl?: string
) {
  const id = generateId();
  await db.insert(schema.deploymentProviders).values({
    id,
    deploymentId,
    providerType,
    providerConfig,
    deploymentUrl: deploymentUrl || null,
    status: 'pending',
  });
  const results = await db
    .select()
    .from(schema.deploymentProviders)
    .where(eq(schema.deploymentProviders.id, id))
    .limit(1);
  return results[0] || null;
}

export async function getProvidersForDeployment(deploymentId: string) {
  return db
    .select()
    .from(schema.deploymentProviders)
    .where(eq(schema.deploymentProviders.deploymentId, deploymentId))
    .orderBy(desc(schema.deploymentProviders.createdAt));
}

export async function getActiveProvider(
  deploymentId: string,
  providerType: 'vercel' | 'mollie'
) {
  const results = await db
    .select()
    .from(schema.deploymentProviders)
    .where(
      and(
        eq(schema.deploymentProviders.deploymentId, deploymentId),
        eq(schema.deploymentProviders.providerType, providerType),
        eq(schema.deploymentProviders.status, 'active')
      )
    )
    .limit(1);
  return results[0] || null;
}

export async function updateProviderStatus(
  id: string,
  status: 'pending' | 'active' | 'failed' | 'superseded',
  updates?: { deploymentUrl?: string; providerConfig?: Record<string, unknown> }
) {
  const setData: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };
  if (updates?.deploymentUrl !== undefined) {
    setData.deploymentUrl = updates.deploymentUrl;
  }
  if (updates?.providerConfig !== undefined) {
    setData.providerConfig = updates.providerConfig;
  }
  await db
    .update(schema.deploymentProviders)
    .set(setData as any)
    .where(eq(schema.deploymentProviders.id, id));
}

export async function supersedeActiveProviders(
  deploymentId: string,
  providerType: 'vercel' | 'mollie'
) {
  const active = await db
    .select()
    .from(schema.deploymentProviders)
    .where(
      and(
        eq(schema.deploymentProviders.deploymentId, deploymentId),
        eq(schema.deploymentProviders.providerType, providerType),
        eq(schema.deploymentProviders.status, 'active')
      )
    );
  for (const row of active) {
    await db
      .update(schema.deploymentProviders)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(eq(schema.deploymentProviders.id, row.id));
  }
}

// ==========================================
// Payments (provider-agnostic payment ledger)
// ==========================================
export async function createPayment(paymentData: {
  deploymentId: string;
  providerType: string;
  providerPaymentId?: string | null;
  amount: string;
  currency: string;
  checkoutUrl?: string | null;
  cryptoAmount?: string | null;
  cryptoCurrency?: string | null;
  cryptoNetwork?: string | null;
  paymentAddress?: string | null;
  transactionHash?: string | null;
  providerStatus?: string | null;
  expiresAt?: Date | null;
}) {
  const id = generateId();
  await db.insert(schema.payments).values({
    id,
    deploymentId: paymentData.deploymentId,
    providerType: paymentData.providerType,
    providerPaymentId: paymentData.providerPaymentId || null,
    amount: paymentData.amount,
    currency: paymentData.currency,
    checkoutUrl: paymentData.checkoutUrl || null,
    cryptoAmount: paymentData.cryptoAmount || null,
    cryptoCurrency: paymentData.cryptoCurrency || null,
    cryptoNetwork: paymentData.cryptoNetwork || null,
    paymentAddress: paymentData.paymentAddress || null,
    transactionHash: paymentData.transactionHash || null,
    providerStatus: paymentData.providerStatus || null,
    expiresAt: paymentData.expiresAt || null,
    status: 'pending',
  });
  const results = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.id, id))
    .limit(1);
  return results[0] || null;
}

export async function getPaymentById(id: string) {
  const results = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.id, id))
    .limit(1);
  return results[0] || null;
}

export async function getPaymentByProviderPaymentId(
  providerType: string,
  providerPaymentId: string
) {
  const results = await db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.providerType, providerType),
        eq(schema.payments.providerPaymentId, providerPaymentId)
      )
    )
    .limit(1);
  return results[0] || null;
}

export async function listPaymentsForDeployment(deploymentId: string) {
  return db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.deploymentId, deploymentId))
    .orderBy(desc(schema.payments.createdAt));
}

export async function updatePayment(
  id: string,
  updates: {
    status?: string;
    paidAt?: Date | null;
    checkoutUrl?: string | null;
    providerPaymentId?: string | null;
    providerStatus?: string | null;
    cryptoAmount?: string | null;
    cryptoCurrency?: string | null;
    cryptoNetwork?: string | null;
    paymentAddress?: string | null;
    transactionHash?: string | null;
    expiresAt?: Date | null;
  }
) {
  const setData: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  const keys: Array<keyof typeof updates> = [
    'status',
    'paidAt',
    'checkoutUrl',
    'providerPaymentId',
    'providerStatus',
    'cryptoAmount',
    'cryptoCurrency',
    'cryptoNetwork',
    'paymentAddress',
    'transactionHash',
    'expiresAt',
  ];
  for (const key of keys) {
    if (updates[key] !== undefined) {
      setData[key as string] = updates[key];
    }
  }
  await db
    .update(schema.payments)
    .set(setData as any)
    .where(eq(schema.payments.id, id));
  return getPaymentById(id);
}

/**
 * List payments for a specific user, derived through the
 * payment → deployment → userId relationship. Never trusts a
 * client-supplied userId.
 */
export async function listPaymentsForUser(userId: string) {
  const deployments = await db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(eq(schema.deployments.userId, userId));

  const deploymentIds = deployments.map((d) => d.id);

  if (deploymentIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(schema.payments)
    .where(inArray(schema.payments.deploymentId, deploymentIds))
    .orderBy(desc(schema.payments.createdAt));
}

/** List all payments (admin visibility). */
export async function listPayments() {
  return db
    .select()
    .from(schema.payments)
    .orderBy(desc(schema.payments.createdAt));
}

export interface PaymentProviderSnapshot {
  providerStatus?: string | null;
  transactionHash?: string | null;
  cryptoAmount?: string | null;
  cryptoCurrency?: string | null;
  cryptoNetwork?: string | null;
  paymentAddress?: string | null;
}

/**
 * Atomically transition a payment to `paid` and record revenue exactly
 * once. Uses a transaction with row-level locks so concurrent or
 * repeated webhook deliveries cannot double-count revenue.
 *
 * Returns:
 *   - { outcome: 'not_found' }            payment does not exist
 *   - { outcome: 'already_paid', payment }  was already paid (no revenue)
 *   - { outcome: 'recorded', payment, deployment }  first successful paid transition
 */
export async function recordPaymentPaid(
  id: string,
  provider: PaymentProviderSnapshot
): Promise<
  | { outcome: 'not_found' }
  | { outcome: 'already_paid'; payment: any }
  | { outcome: 'recorded'; payment: any; deployment: any }
> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, id))
      .for('update');

    const payment = rows[0];
    if (!payment) {
      return { outcome: 'not_found' as const };
    }

    if (payment.status === 'paid') {
      return { outcome: 'already_paid' as const, payment };
    }

    const now = new Date();
    await tx
      .update(schema.payments)
      .set({
        status: 'paid',
        paidAt: now,
        updatedAt: now,
        providerStatus: provider.providerStatus ?? payment.providerStatus,
        transactionHash: provider.transactionHash ?? payment.transactionHash,
        cryptoAmount: provider.cryptoAmount ?? payment.cryptoAmount,
        cryptoCurrency: provider.cryptoCurrency ?? payment.cryptoCurrency,
        cryptoNetwork: provider.cryptoNetwork ?? payment.cryptoNetwork,
        paymentAddress: provider.paymentAddress ?? payment.paymentAddress,
      } as any)
      .where(eq(schema.payments.id, id));

    // Lock the deployment row before incrementing revenue to avoid a
    // race between two different payments crediting the same deployment.
    const depRows = await tx
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, payment.deploymentId))
      .for('update');

    const deployment = depRows[0];

    if (deployment) {
      const current = parseFloat(deployment.revenue || '0.00');
      const amount = parseFloat(payment.amount || '0.00');
      const newRevenue = (current + amount).toFixed(2);
      await tx
        .update(schema.deployments)
        .set({ revenue: newRevenue, updatedAt: now })
        .where(eq(schema.deployments.id, payment.deploymentId));
    }

    const paidPayment = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, id))
      .limit(1);

    return {
      outcome: 'recorded' as const,
      payment: paidPayment[0],
      deployment,
    };
  });
}

/**
 * Enqueue an existing deployment for processing through the existing
 * queue/orchestrator pipeline. Idempotent: does not create a duplicate
 * pending/processing deployment queue item for the same gap.
 */
export async function enqueueDeploymentQueueItem(gapId: string) {
  const existing = await db
    .select()
    .from(schema.queueItems)
    .where(
      and(
        eq(schema.queueItems.gapId, gapId),
        eq(schema.queueItems.queueType, 'deployment'),
        inArray(schema.queueItems.status, ['pending', 'processing'])
      )
    )
    .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  const id = generateId();
  await db.insert(schema.queueItems).values({
    id,
    gapId,
    status: 'pending',
    queueType: 'deployment',
    workerId: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    nextRetryAt: null,
    dedupHash: `deployment:${gapId}`,
    priority: 5,
    sortOrder: 0,
  });

  const rows = await db
    .select()
    .from(schema.queueItems)
    .where(eq(schema.queueItems.id, id))
    .limit(1);
  return rows[0] || null;
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

export async function getAuditStats() {
  const allLogs = await db
    .select({
      decision: schema.auditLogs.decision,
      count: sql<number>`count(*)`,
    })
    .from(schema.auditLogs)
    .groupBy(schema.auditLogs.decision);

  const stats: Record<string, number> = {
    total: 0,
    safe: 0,
    unsafe: 0,
    gray: 0,
    false: 0,
    allow: 0,
    review: 0,
    block: 0,
  };

  for (const log of allLogs) {
    const decision = String(log.decision || 'unknown');
    const count = Number(log.count);

    stats[decision] = (stats[decision] || 0) + count;
    stats.total += count;
  }

  return stats;
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

// ==========================================
// SAO OPERATIONAL RESET
// Clears runtime/generated data while preserving
// users, policies, invites, and application configuration.
// ==========================================
export async function resetOperationalData(): Promise<void> {
  // Delete dependent/runtime data first.
  await db.delete(schema.deploymentHealthChecks);
  await db.delete(schema.auditLogs);
  await db.delete(schema.deployments);
  await db.delete(schema.queueItems);
  await db.delete(schema.gaps);
  await db.delete(schema.recurringActors);

  // Reset the Core Loop to a clean initial state.
  await db
    .update(schema.coreLoopState)
    .set({
      isRunning: false,
      intervalMs: 10800000,
      lastExecutedAt: null,
      nextExecutionAt: null,
      totalGapsProcessed: 0,
      totalDeploymentsCreated: 0,
      maxAttempts: 3,
      backoffMultiplier: '1.5',
      baseDelayMs: 5000,
      queueMaxSize: 1000,
      queueExpirationHours: 72,
      concurrency: 1,
      maxCostPerDay: '50.00',
      maxDeployments: 10,
      autoPauseOnHighBanRisk: true,
      emailNotifications: true,
      slackNotifications: false,
      updatedAt: new Date(),
    })
    .where(eq(schema.coreLoopState.id, 'singleton'));
}


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

// ==========================================
// Registration Invitation Helpers (email normalized)
// ==========================================

/**
 * Create a new registration invite.
 * @param email - email address authorized to register
 * @param role - role to assign upon registration ('admin' or 'user')
 * @param createdBy - id of admin creating the invite
 * @param expiresAt - optional expiration date
 * @returns the created invite record
 */
export async function createRegistrationInvite(
  email: string,
  role: 'admin' | 'user',
  createdBy: string,
  expiresAt?: Date
) {
  const normalizedEmail = email.trim().toLowerCase();
  const id = generateId();
  await db.insert(schema.registrationInvites).values({
    id,
    email: normalizedEmail,
    role,
    createdBy,
    expiresAt: expiresAt || null,
  });
  return getRegistrationInviteById(id);
}

/**
 * Get an invite by its ID.
 */
export async function getRegistrationInviteById(id: string) {
  const results = await db
    .select()
    .from(schema.registrationInvites)
    .where(eq(schema.registrationInvites.id, id))
    .limit(1);
  return results[0] || null;
}

/**
 * Get the latest (most recent) invite for a given email.
 * Useful to check if an email is authorized.
 */
export async function getRegistrationInviteByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const results = await db
    .select()
    .from(schema.registrationInvites)
    .where(eq(schema.registrationInvites.email, normalizedEmail))
    .orderBy(desc(schema.registrationInvites.createdAt))
    .limit(1);
  return results[0] || null;
}

/**
 * Mark an invite as used (sets usedAt to now).
 * Returns the updated invite or null if not found.
 */
export async function markInviteUsed(id: string) {
  await db
    .update(schema.registrationInvites)
    .set({ usedAt: new Date() })
    .where(eq(schema.registrationInvites.id, id));
  return getRegistrationInviteById(id);
}

/**
 * List all invites (optionally filter by email).
 * Admin use only.
 */
export async function listRegistrationInvites(limit = 100, offset = 0) {
  return db
    .select()
    .from(schema.registrationInvites)
    .orderBy(desc(schema.registrationInvites.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Delete an invite by ID (soft-delete or hard-delete? We'll just delete it).
 */
// ==========================================
// Advertising Campaign Helpers (Phase 13)
// ==========================================

export async function createAdCampaign(data: {
  deploymentId: string;
  name: string;
  channel: string;
  campaignType: 'PAID' | 'FREE_ORGANIC';
  budget?: string;
  strategy?: string;
}) {
  const id = generateId();
  await db.insert(schema.adCampaigns).values({
    id,
    deploymentId: data.deploymentId,
    name: data.name,
    channel: data.channel,
    campaignType: data.campaignType,
    budget: data.budget || '0.00',
    strategy: data.strategy || null,
  });
  return getAdCampaignById(id);
}

export async function getAdCampaignById(id: string) {
  const results = await db.select().from(schema.adCampaigns).where(eq(schema.adCampaigns.id, id)).limit(1);
  return results[0] || null;
}

export async function listCampaignsForDeployment(deploymentId: string) {
  return db.select().from(schema.adCampaigns)
    .where(eq(schema.adCampaigns.deploymentId, deploymentId))
    .orderBy(desc(schema.adCampaigns.createdAt));
}

export async function listAllCampaigns() {
  return db.select().from(schema.adCampaigns).orderBy(desc(schema.adCampaigns.createdAt));
}

export async function updateAdCampaign(id: string, updates: Partial<typeof schema.adCampaigns.$inferInsert>) {
  await db.update(schema.adCampaigns).set({ ...updates, updatedAt: new Date() } as any)
    .where(eq(schema.adCampaigns.id, id));
  return getAdCampaignById(id);
}

export async function createAdCreative(data: {
  campaignId: string;
  format: string;
  content: string;
  headline?: string;
  callToAction?: string;
  targetAudience?: string;
  variation?: number;
}) {
  const id = generateId();
  await db.insert(schema.adCreatives).values({
    id,
    campaignId: data.campaignId,
    format: data.format,
    content: data.content,
    headline: data.headline || null,
    callToAction: data.callToAction || null,
    targetAudience: data.targetAudience || null,
    variation: data.variation || 1,
  });
  return id;
}

export async function listCreativesForCampaign(campaignId: string) {
  return db.select().from(schema.adCreatives)
    .where(eq(schema.adCreatives.campaignId, campaignId))
    .orderBy(asc(schema.adCreatives.createdAt));
}

export async function getAdvertisingStats(deploymentId: string) {
  const campaigns = await listCampaignsForDeployment(deploymentId);
  const totalBudget = campaigns.reduce((s, c) => s + parseFloat(String(c.budget || '0')), 0);
  const totalSpent = campaigns.reduce((s, c) => s + parseFloat(String(c.spent || '0')), 0);
  const activeCount = campaigns.filter(c => c.status === 'ACTIVE').length;
  return { campaignCount: campaigns.length, activeCount, totalBudget, totalSpent };
}

/**
 * Delete an invite by ID (soft-delete or hard-delete? We'll just delete it).
 */
export async function deleteRegistrationInvite(id: string) {
  await db
    .delete(schema.registrationInvites)
    .where(eq(schema.registrationInvites.id, id));
}

/**
 * Check if an invite is valid (exists, not used, not expired).
 * Returns the invite if valid, null otherwise.
 */
export async function getValidRegistrationInvite(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const invite = await getRegistrationInviteByEmail(normalizedEmail);
  if (!invite) return null;
  if (invite.usedAt) return null;
  if (invite.expiresAt && new Date() > invite.expiresAt) return null;
  return invite;
}
