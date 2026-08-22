import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import * as trpcExpress from '@trpc/server/adapters/express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import Stripe from 'stripe';
import { sql } from 'drizzle-orm';
import { getCredential } from '../services/credentials';
import { validateCredentialEncryptionKeyForStartup } from '../services/credentialEncryption';
import { createContext } from './context';
import { appRouter } from '../routers';
import * as db from '../db';
import { withRetry, databaseUrlResolved } from '../db';
import { scheduleAudits } from '../auditScheduler';
import { startCoreLoop } from '../orchestrator';
import { initWebSocketServer } from '../websocket';
import { createServer } from 'http';

// Load .env (for local dev)
const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
];

let envLoaded = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`Loaded .env from: ${envPath}`);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  dotenv.config();
  console.log('No .env file found — using environment variables from host.');
}

validateCredentialEncryptionKeyForStartup();

const app = express();

// ==========================================
// 1. STRIPE WEBHOOK (BEFORE JSON MIDDLEWARE)
// ==========================================
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    console.warn('Stripe signature or webhook secret is missing. Skipping signature verification.');
    res.status(400).send('Webhook configuration error');
    return;
  }

  let event: Stripe.Event;

  try {
    const stripeSecretKey = await getCredential('stripe');
    const stripe = new Stripe(stripeSecretKey || 'sk_test_dummy', {
      apiVersion: '2023-10-16' as any,
    });
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error(`Stripe Webhook signature verification failed: ${err.message}`);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const deploymentId = session.client_reference_id;
    const amountTotal = session.amount_total ? session.amount_total / 100 : 0;

    if (deploymentId && amountTotal > 0) {
      try {
        const deployment = await db.getDeploymentById(deploymentId);
        if (deployment) {
          const currentRevenue = parseFloat(deployment.revenue || '0.00');
          const newRevenue = (currentRevenue + amountTotal).toFixed(2);
          await db.updateDeployment(deployment.id, {
            revenue: newRevenue,
          });
          console.log(`Stripe Webhook: Successfully attributed $${amountTotal} to Deployment ${deployment.id}`);
        } else {
          console.warn(`Stripe Webhook: Deployment with ID ${deploymentId} was not found.`);
        }
      } catch (err) {
        console.error(`Stripe Webhook: Failed to update deployment revenue.`, err);
      }
    }
  }

  res.json({ received: true });
});

// ==========================================
// 2. STANDARD EXPRESS MIDDLEWARES
// ==========================================
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: process.env.FRONTEND_URL || process.env.CORS_ORIGIN || true,
  credentials: true,
}));

// ==========================================
// 3. MOUNT tRPC ROUTER
// ==========================================
app.use(
  '/api/trpc',
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  })
);

// ==========================================
// 4. API HEALTH & READINESS ENDPOINTS
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/api/ready', async (req, res) => {
  try {
    await db.db.execute(sql`SELECT 1`);
    res.json({
      status: 'ready',
      database: 'connected',
    });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      database: 'error',
    });
  }
});

// ==========================================
// 5. SERVE BUILT CLIENT (production)
// ==========================================
const clientDistPath = path.resolve(process.cwd(), 'dist', 'client');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(clientDistPath, 'index.html'));
    }
  });
  console.log(`Serving client from: ${clientDistPath}`);
} else {
  console.warn('No built client found at dist/client — running in API-only mode.');
}

// ==========================================
// 6. SERVER START & INITIALIZATION
// ==========================================
const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    if (!databaseUrlResolved) {
      console.error('❌ No database URL found!');
      console.error('   Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME or DATABASE_URL in your environment');
      process.exit(1);
    }
    console.log('✅ Database URL resolved');

    console.log('Connecting to database (with retry)...');
    await withRetry(
      () => db.initCoreLoopState(),
      5,
      3000
    );
    console.log('Database and Core Loop State successfully initialized.');

    const coreLoopState = await db.getCoreLoopState();

    if (coreLoopState?.isRunning) {
      await startCoreLoop();
      console.log('Core Loop was previously running — startup/recovery completed.');
    } else {
      console.log('Core Loop was previously stopped — leaving it stopped.');
    }

    scheduleAudits();

    const httpServer = createServer(app);
    initWebSocketServer(httpServer);
    console.log('WebSocket server initialized on /ws');

    let isShuttingDown = false;
    const shutdown = (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`Received ${signal}. Starting graceful shutdown...`);

      httpServer.close((err) => {
        if (err) {
          console.error('Error closing HTTP server:', err);
          process.exit(1);
        }
        console.log('HTTP server closed successfully.');
        process.exit(0);
      });

      const timer = setTimeout(() => {
        console.error('Forced shutdown after 10s timeout.');
        process.exit(1);
      }, 10000);
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        (timer as any).unref();
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    httpServer.listen(PORT, () => {
      console.log(`SAO running on port ${PORT}`);
      console.log(`Health: http://localhost:${PORT}/api/health`);
      console.log(`Ready: http://localhost:${PORT}/api/ready`);
      console.log(`WebSocket: ws://localhost:${PORT}/ws`);
    });
  } catch (error) {
    console.error('Failed to bootstrap SAO Server Application:', error);
    process.exit(1);
  }
}

bootstrap();

export default app;
