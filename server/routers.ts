import { router, publicProcedure, protectedProcedure, adminProcedure } from './_core/trpc';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Resend } from 'resend';
import { TRPCError } from '@trpc/server';
import { COOKIE_NAME, signSession, cookieOptions } from './_core/cookies';
import * as db from './db';
import {
  setConcurrency,
  processOneGap,
  startCoreLoop,
  stopCoreLoop,
  updateCoreLoopInterval,
} from './orchestrator';
import { auditAllActiveDeployments, auditDeployment } from './auditScheduler';
import { testCredential } from './services/credentialTests';
import {
  PublicCredentialService,
  listCredentialStatus,
  recordCredentialAudit,
  removePublicCredential,
  setPublicCredential,
  setPublicCredentialEnabled,
  getCredential,
} from './services/credentials';
import { crawlAndExtract } from './services/crawler';
import { search as googleSearch, searchForGaps, trendingProblems } from './services/search';
import { users, gaps, queueItems } from '../drizzle/schema';
import { eq, asc } from 'drizzle-orm';

const credentialServiceSchema = z.enum([
  'groq',
  'google-search',
  'github',
  'stripe',
  'resend',
  'slack',
  'tavily',
]);

const credentialValueSchema = z.string().trim().min(1).max(8192);

// ==========================================
// AUTH ROUTER
// ==========================================
const authRouter = router({
  register: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string().min(6),
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. Check if user already exists
      const existingUser = await db.getUserByEmail(input.email);
      if (existingUser) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A user with this email already exists.' });
      }

      // 2. Validate invitation
      const invite = await db.getValidRegistrationInvite(input.email);
      if (!invite) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'No valid invitation found for this email.',
        });
      }

      // 3. Create user with the role from the invitation
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(input.password, salt);
      const role = invite.role as 'admin' | 'user';

      const user = await db.createUser(input.email, passwordHash, role);
      if (!user) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create user.' });
      }

      // 4. Mark invitation as used
      await db.markInviteUsed(invite.id);

      // 5. Create session and set cookie
      const session = signSession(user.id);
      ctx.res.cookie(COOKIE_NAME, session, cookieOptions);

      return { success: true, user: { id: user.id, email: user.email, role: user.role } };
    }),

  login: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const user = await db.getUserByEmail(input.email);
      if (!user) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid email or password.' });
      }

      const isValid = await bcrypt.compare(input.password, user.passwordHash);
      if (!isValid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid email or password.' });
      }

      await db.updateLastSignedIn(user.id);
      const session = signSession(user.id);
      ctx.res.cookie(COOKIE_NAME, session, cookieOptions);

      return { success: true, user: { id: user.id, email: user.email, role: user.role } };
    }),

  logout: publicProcedure
    .mutation(({ ctx }) => {
      ctx.res.clearCookie(COOKIE_NAME, cookieOptions);
      return { success: true };
    }),

  me: protectedProcedure
    .query(({ ctx }) => {
      return { id: ctx.user.id, email: ctx.user.email, role: ctx.user.role };
    }),

  forgotPassword: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const user = await db.getUserByEmail(input.email);
      if (!user) return { success: true };

      const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiry = new Date(Date.now() + 15 * 60 * 1000);

      await db.updateUserResetCode(input.email, resetCode, expiry);

      try {
        const resendApiKey = await getCredential('resend');
        if (!resendApiKey) {
          console.warn('Password reset email skipped: Resend API key is not configured.');
          return { success: true };
        }

        const resend = new Resend(resendApiKey);
        await resend.emails.send({
          from: 'SAO Password Reset <noreply@situationalarbitrage.com>',
          to: [input.email],
          subject: 'Password Reset Code - SAO',
          text: `Your password reset code is ${resetCode}. It is valid for 15 minutes.`,
        });
      } catch {
        console.error('Failed to send password reset email.');
      }

      return { success: true };
    }),

  resetPassword: publicProcedure
    .input(z.object({
      email: z.string().email(),
      code: z.string(),
      newPassword: z.string().min(6),
    }))
    .mutation(async ({ input }) => {
      const user = await db.getUserByEmail(input.email);
      if (!user || !user.resetCode || !user.resetCodeExpiry) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid request or reset code expired.' });
      }

      if (user.resetCode !== input.code || new Date() > user.resetCodeExpiry) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid reset code or code has expired.' });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(input.newPassword, salt);

      await db.db.update(users)
        .set({ passwordHash, resetCode: null, resetCodeExpiry: null })
        .where(eq(users.id, user.id));

      return { success: true };
    }),
});

// ==========================================
// GAPS ROUTER
// ==========================================
const gapsRouter = router({
  create: protectedProcedure
    .input(z.object({
      knows: z.string(),
      needs: z.string(),
      controlsAccess: z.string(),
      underestimatesValue: z.string(),
      source: z.string(),
      priority: z.number().min(1).max(10).default(5),
    }))
    .mutation(async ({ input }) => {
      const concatenated = input.knows + input.needs + input.controlsAccess + input.underestimatesValue + input.source;
      const dedupHash = crypto.createHash('sha256').update(concatenated).digest('hex');

      const existing = await db.getGapByHash(dedupHash);
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'An identical gap already exists.' });
      }

      const gap = await db.createGap({
        knows: input.knows,
        needs: input.needs,
        controlsAccess: input.controlsAccess,
        underestimatesValue: input.underestimatesValue,
        source: input.source,
        priority: input.priority,
        dedupHash,
        status: 'pending',
      });

      if (!gap) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create gap' });
      }

      await db.createQueueItem({
        gapId: gap.id,
        dedupHash,
        priority: input.priority,
        sortOrder: 0,
      });

      return gap;
    }),

  list: protectedProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      skip: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      return db.listGaps(input.limit, input.skip);
    }),

  get: protectedProcedure
    .input(z.string())
    .query(async ({ input }) => {
      const gap = await db.getGapById(input);
      if (!gap) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gap not found' });
      return gap;
    }),

  updateStatus: adminProcedure
    .input(z.object({
      id: z.string(),
      status: z.enum(['pending', 'processing', 'safe', 'unsafe', 'gray', 'false', 'deployed', 'failed']),
    }))
    .mutation(async ({ input }) => {
      return db.updateGapStatus(input.id, input.status);
    }),

  retry: protectedProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      const gap = await db.getGapById(input);
      if (!gap) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gap not found' });

      await db.updateGapStatus(gap.id, 'pending');
      const queueResults = await db.db.select().from(queueItems).where(eq(queueItems.gapId, gap.id)).limit(1);
      
      if (queueResults[0]) {
        await db.updateQueueItem(queueResults[0].id, {
          status: 'pending',
          attempts: 0,
        });
      } else {
        await db.createQueueItem({
          gapId: gap.id,
          dedupHash: gap.dedupHash,
          priority: gap.priority,
        });
      }

      return { success: true };
    }),

  delete: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.db.delete(queueItems).where(eq(queueItems.gapId, input));
      await db.db.delete(gaps).where(eq(gaps.id, input));
      return { success: true };
    }),
});

// ==========================================
// QUEUE ROUTER
// ==========================================
const queueRouter = router({
  list: protectedProcedure
    .query(async () => {
      return db.listQueueItems();
    }),

  stats: protectedProcedure
    .query(async () => {
      return db.getQueueStats();
    }),

  moveUp: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      const item = await db.getQueueItem(input);
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });

      const allItems = await db.db.select().from(queueItems).orderBy(asc(queueItems.sortOrder));
      const idx = allItems.findIndex(o => o.id === item.id);
      if (idx > 0) {
        const swapItem = allItems[idx - 1];
        await db.updateQueueItem(item.id, { sortOrder: swapItem.sortOrder });
        await db.updateQueueItem(swapItem.id, { sortOrder: item.sortOrder });
      }
      return { success: true };
    }),

  moveDown: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      const item = await db.getQueueItem(input);
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });

      const allItems = await db.db.select().from(queueItems).orderBy(asc(queueItems.sortOrder));
      const idx = allItems.findIndex(o => o.id === item.id);
      if (idx < allItems.length - 1 && idx >= 0) {
        const swapItem = allItems[idx + 1];
        await db.updateQueueItem(item.id, { sortOrder: swapItem.sortOrder });
        await db.updateQueueItem(swapItem.id, { sortOrder: item.sortOrder });
      }
      return { success: true };
    }),

  pause: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateQueueItem(input, { status: 'paused' });
      return { success: true };
    }),

  resume: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateQueueItem(input, { status: 'pending' });
      return { success: true };
    }),

  delete: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.db.delete(queueItems).where(eq(queueItems.id, input));
      return { success: true };
    }),

  retry: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateQueueItem(input, { status: 'pending', attempts: 0, lastError: null });
      return { success: true };
    }),

  updatePriority: adminProcedure
    .input(z.object({
      id: z.string(),
      priority: z.number().min(1).max(10),
    }))
    .mutation(async ({ input }) => {
      await db.updateQueueItem(input.id, { priority: input.priority });
      return { success: true };
    }),
});

// ==========================================
// DEPLOYMENTS ROUTER
// ==========================================
const deploymentsRouter = router({
  list: protectedProcedure
    .query(async () => {
      return db.listDeployments();
    }),

  get: protectedProcedure
    .input(z.string())
    .query(async ({ input }) => {
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found' });
      return deployment;
    }),

  pause: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateDeployment(input, { status: 'paused' });
      return { success: true };
    }),

  resume: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateDeployment(input, { status: 'active' });
      return { success: true };
    }),

  stop: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateDeployment(input, { status: 'stopped' });
      return { success: true };
    }),

  stopAll: adminProcedure
    .mutation(async () => {
      const allDeployments = await db.listDeployments();
      for (const dep of allDeployments) {
        if ((dep as any).status === 'active') {
          await db.updateDeployment(dep.id, { status: 'stopped' });
        }
      }
      return { success: true };
    }),

  resumeAll: adminProcedure
    .mutation(async () => {
      const allDeployments = await db.listDeployments();
      for (const dep of allDeployments) {
        if ((dep as any).status === 'paused') {
          await db.updateDeployment(dep.id, { status: 'active' });
        }
      }
      return { success: true };
    }),

  audit: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await auditDeployment(input);
      return { success: true };
    }),

  stats: protectedProcedure
    .query(async () => {
      const allDeployments = await db.listDeployments();
      return {
        total: allDeployments.length,
        active: allDeployments.filter((d: any) => d.status === 'active').length,
        paused: allDeployments.filter((d: any) => d.status === 'paused').length,
        stopped: allDeployments.filter((d: any) => d.status === 'stopped').length,
      };
    }),
});

// ==========================================
// AUDIT ROUTER
// ==========================================
const auditRouter = router({
  list: protectedProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      skip: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      return db.listAuditLogs(input.limit, input.skip);
    }),

  get: protectedProcedure
    .input(z.string())
    .query(async () => {
      const logs = await db.listAuditLogs(1, 0);
      return logs[0] || null;
    }),
});

// ==========================================
// POLICIES ROUTER
// ==========================================
const policiesRouter = router({
  list: protectedProcedure
    .query(async () => {
      return db.listPolicies();
    }),

  create: adminProcedure
    .input(z.object({ ruleText: z.string() }))
    .mutation(async ({ input }) => {
      return db.createPolicy(input.ruleText);
    }),

  acknowledge: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updatePolicyAcknowledged(input);
      return { success: true };
    }),

  delete: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.deletePolicy(input);
      return { success: true };
    }),
});

// ==========================================
// CORE LOOP ROUTER
// ==========================================
const coreLoopRouter = router({
  resetOperationalData: adminProcedure
    .mutation(async () => {
      stopCoreLoop();
      await db.resetOperationalData();

      return {
        success: true,
        message: 'Operational data reset successfully',
      };
    }),

  start: adminProcedure
    .mutation(async () => {
      await startCoreLoop();
      return { success: true, message: 'Core loop started' };
    }),

  stop: adminProcedure
    .mutation(async () => {
      await stopCoreLoop();
      return { success: true, message: 'Core loop stopped' };
    }),

  runOnce: adminProcedure
    .mutation(async () => {
      const result = await processOneGap();
      return result || { success: false, message: 'No gaps in queue' };
    }),

  runAudit: adminProcedure
    .mutation(async () => {
      await auditAllActiveDeployments();
      return { success: true, message: 'Audit triggered for all active deployments' };
    }),

  updateInterval: adminProcedure
    .input(z.object({
      intervalMs: z.number().min(60000),
    }))
    .mutation(async ({ input }) => {
      await updateCoreLoopInterval(input.intervalMs);
      return { success: true, intervalMs: input.intervalMs };
    }),

  status: protectedProcedure
    .query(async () => {
      return db.getCoreLoopState();
    }),
});

// ==========================================
// ANALYTICS ROUTER
// ==========================================
const analyticsRouter = router({
  overview: protectedProcedure
    .query(async () => {
      const allGaps = await db.listGaps(1000, 0);
      const allDeployments = await db.listDeployments();
      const queueStats = await db.getQueueStats();
      const auditStats = await db.getAuditStats();

      const totalRevenue = allDeployments.reduce(
        (sum: number, deployment: any) =>
          sum + parseFloat(deployment.revenue || '0'),
        0
      );

      const gapsByStatus: Record<string, number> = {};

      for (const gap of allGaps) {
        const status = String((gap as any).status || 'unknown');
        gapsByStatus[status] = (gapsByStatus[status] || 0) + 1;
      }

      const deploymentsByStatus: Record<string, number> = {};

      for (const deployment of allDeployments) {
        const status = String((deployment as any).status || 'unknown');
        deploymentsByStatus[status] =
          (deploymentsByStatus[status] || 0) + 1;
      }

      return {
        totalGaps: allGaps.length,
        activeDeployments: deploymentsByStatus.active || 0,

        queue: {
          total: queueStats.total,
          pending: queueStats.pending,
          processing: queueStats.processing,
          paused: queueStats.paused,
          completed: queueStats.completed,
          failed: queueStats.failed,
        },

        audits: {
          total: auditStats.total,
          safe: auditStats.safe,
          unsafe: auditStats.unsafe,
          gray: auditStats.gray,
          false: auditStats.false,
          allow: auditStats.allow,
          review: auditStats.review,
          block: auditStats.block,
        },

        totalRevenue: totalRevenue.toFixed(2),
        gapsByStatus,
        deploymentsByStatus,
      };
    }),

  revenueHistory: protectedProcedure
    .query(async () => {
      const allDeployments = await db.listDeployments();
      return allDeployments
        .filter((d: any) => parseFloat(d.revenue || '0') > 0)
        .map((d: any) => ({
          id: d.id,
          gapId: d.gapId,
          revenue: d.revenue,
          status: d.status,
        }));
    }),
});

// ==========================================
// DISCOVERY ROUTER — Crawl & Search
// ==========================================
const discoveryRouter = router({
  crawl: adminProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ input }) => {
      const gaps = await crawlAndExtract(input.url);
      // Auto-create gaps and queue items
      for (const g of gaps) {
        const concatenated = g.knows + g.needs + g.controlsAccess + g.underestimatesValue + g.source;
        const dedupHash = crypto.createHash('sha256').update(concatenated).digest('hex');
        const existing = await db.getGapByHash(dedupHash);
        if (!existing) {
          const gap = await db.createGap({
            knows: g.knows,
            needs: g.needs,
            controlsAccess: g.controlsAccess,
            underestimatesValue: g.underestimatesValue,
            source: g.source,
            priority: 5,
            dedupHash,
            status: 'pending',
          });
          if (gap) {
            await db.createQueueItem({ gapId: gap.id, dedupHash, priority: 5, sortOrder: 0 });
          }
        }
      }
      return { success: true, gapsFound: gaps.length, gaps };
    }),

  search: adminProcedure
    .input(z.object({ query: z.string() }))
    .mutation(async ({ input }) => {
      const gaps = await searchForGaps(input.query);
      // Auto-create gaps and queue items
      for (const g of gaps) {
        const concatenated = g.knows + g.needs + g.controlsAccess + g.underestimatesValue + g.source;
        const dedupHash = crypto.createHash('sha256').update(concatenated).digest('hex');
        const existing = await db.getGapByHash(dedupHash);
        if (!existing) {
          const gap = await db.createGap({
            knows: g.knows,
            needs: g.needs,
            controlsAccess: g.controlsAccess,
            underestimatesValue: g.underestimatesValue,
            source: g.source,
            priority: 5,
            dedupHash,
            status: 'pending',
          });
          if (gap) {
            await db.createQueueItem({ gapId: gap.id, dedupHash, priority: 5, sortOrder: 0 });
          }
        }
      }
      return { success: true, gapsFound: gaps.length, gaps };
    }),

  searchRaw: adminProcedure
    .input(z.object({ query: z.string(), maxResults: z.number().min(1).max(10).default(10) }))
    .query(async ({ input }) => {
      return googleSearch(input.query, { maxResults: input.maxResults });
    }),

  trending: adminProcedure
    .query(async () => {
      return trendingProblems();
    }),
});

// ==========================================
// INTEGRATIONS ROUTER — Test all service connections
// ==========================================
const integrationsRouter = router({
  testGroq: adminProcedure
    .query(async () => {
      return testCredential('groq');
    }),

  testGitHub: adminProcedure
    .query(async () => {
      return testCredential('github');
    }),

  testStripe: adminProcedure
    .query(async () => {
      return testCredential('stripe');
    }),

  testResend: adminProcedure
    .query(async () => {
      return testCredential('resend');
    }),

  testSlack: adminProcedure
    .query(async () => {
      return testCredential('slack');
    }),

  testGoogleSearch: adminProcedure
    .query(async () => {
      return testCredential('google-search');
    }),

  testTavily: adminProcedure
    .query(async () => {
      return testCredential('tavily');
    }),
});

const credentialsRouter = router({
  list: adminProcedure
    .query(async () => {
      return listCredentialStatus();
    }),

  set: adminProcedure
    .input(z.object({
      service: credentialServiceSchema,
      value: credentialValueSchema,
      secondaryValue: credentialValueSchema.optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const service = input.service as PublicCredentialService;
      try {
        const operation = await setPublicCredential(service, input.value, input.secondaryValue);
        await recordCredentialAudit({
          userId: ctx.user.id,
          service,
          operation: operation === 'created' ? 'credential.created' : 'credential.updated',
          success: true,
        });
        return { success: true };
      } catch (error) {
        await recordCredentialAudit({
          userId: ctx.user.id,
          service,
          operation: 'credential.updated',
          success: false,
          message: error instanceof Error ? error.message : 'Credential update failed.',
        }).catch(() => undefined);
        throw error;
      }
    }),

  remove: adminProcedure
    .input(z.object({ service: credentialServiceSchema }))
    .mutation(async ({ input, ctx }) => {
      const service = input.service as PublicCredentialService;
      try {
        await removePublicCredential(service);
        await recordCredentialAudit({
          userId: ctx.user.id,
          service,
          operation: 'credential.removed',
          success: true,
        });
        return { success: true };
      } catch (error) {
        await recordCredentialAudit({
          userId: ctx.user.id,
          service,
          operation: 'credential.removed',
          success: false,
          message: 'Credential removal failed.',
        }).catch(() => undefined);
        throw error;
      }
    }),

  enable: adminProcedure
    .input(z.object({ service: credentialServiceSchema }))
    .mutation(async ({ input, ctx }) => {
      const service = input.service as PublicCredentialService;
      await setPublicCredentialEnabled(service, true);
      await recordCredentialAudit({
        userId: ctx.user.id,
        service,
        operation: 'credential.enabled',
        success: true,
      });
      return { success: true };
    }),

  disable: adminProcedure
    .input(z.object({ service: credentialServiceSchema }))
    .mutation(async ({ input, ctx }) => {
      const service = input.service as PublicCredentialService;
      await setPublicCredentialEnabled(service, false);
      await recordCredentialAudit({
        userId: ctx.user.id,
        service,
        operation: 'credential.disabled',
        success: true,
      });
      return { success: true };
    }),

  test: adminProcedure
    .input(z.object({ service: credentialServiceSchema }))
    .mutation(async ({ input, ctx }) => {
      const service = input.service as PublicCredentialService;
      const result = await testCredential(service);
      await recordCredentialAudit({
        userId: ctx.user.id,
        service,
        operation: 'credential.tested',
        success: result.success,
        message: result.message,
      });
      return result;
    }),
});

// ==========================================
// SETTINGS ROUTER
// ==========================================
const settingsRouter = router({
  credentials: credentialsRouter,

  save: adminProcedure
    .input(z.object({
      intervalMs: z.number().min(60000).optional(),
      maxCostPerDay: z.number().optional(),
      maxDeployments: z.number().optional(),
      autoPauseOnHighBanRisk: z.boolean().optional(),
      emailNotifications: z.boolean().optional(),
      slackNotifications: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const updates: Record<string, unknown> = {};

      if (input.intervalMs !== undefined) {
        updates.intervalMs = input.intervalMs;
      }

      if (input.maxCostPerDay !== undefined) {
        updates.maxCostPerDay = input.maxCostPerDay.toFixed(2);
      }

      if (input.maxDeployments !== undefined) {
        updates.maxDeployments = input.maxDeployments;
      }

      if (input.autoPauseOnHighBanRisk !== undefined) {
        updates.autoPauseOnHighBanRisk = input.autoPauseOnHighBanRisk;
      }

      if (input.emailNotifications !== undefined) {
        updates.emailNotifications = input.emailNotifications;
      }

      if (input.slackNotifications !== undefined) {
        updates.slackNotifications = input.slackNotifications;
      }

      if (Object.keys(updates).length > 0) {
        await db.updateCoreLoopState(updates as any);
      }

      return { success: true };
    }),

  testConnection: adminProcedure
    .input(z.object({
      service: credentialServiceSchema,
    }))
    .mutation(async ({ input }) => {
      return testCredential(input.service as PublicCredentialService);
    }),

  // Retry Configuration
  retryConfig: adminProcedure
    .input(z.object({
      maxAttempts: z.number().min(1).max(10),
      backoffMultiplier: z.number().min(1).max(3),
      baseDelayMs: z.number().min(1000).max(60000),
    }))
    .mutation(async ({ input }) => {
      await db.updateCoreLoopState({
        maxAttempts: input.maxAttempts,
        backoffMultiplier: input.backoffMultiplier.toString(),
        baseDelayMs: input.baseDelayMs,
      } as any);
      return { success: true };
    }),

  getRetryConfig: adminProcedure
    .query(async () => {
      const state = await db.getCoreLoopState();
      return {
        maxAttempts: (state as any).maxAttempts || 3,
        backoffMultiplier: parseFloat((state as any).backoffMultiplier || '1.5'),
        baseDelayMs: (state as any).baseDelayMs || 5000,
      };
    }),

  // Queue Limits
  queueLimits: adminProcedure
    .input(z.object({
      maxSize: z.number().min(100).max(10000),
      expirationHours: z.number().min(1).max(168),
    }))
    .mutation(async ({ input }) => {
      await db.updateCoreLoopState({
        queueMaxSize: input.maxSize,
        queueExpirationHours: input.expirationHours,
      } as any);
      return { success: true };
    }),

  getQueueLimits: adminProcedure
    .query(async () => {
      const state = await db.getCoreLoopState();
      return {
        maxSize: (state as any).queueMaxSize || 1000,
        expirationHours: (state as any).queueExpirationHours || 72,
      };
    }),

  // Worker Pool Concurrency
  setConcurrency: adminProcedure
    .input(z.object({
      level: z.number().min(1).max(10),
    }))
    .mutation(async ({ input }) => {
      await setConcurrency(input.level);
      return { success: true, concurrency: input.level };
    }),

  getConcurrency: adminProcedure
    .query(async () => {
      const state = await db.getCoreLoopState();
      return { concurrency: state?.concurrency || 1 };
    }),
});

// ==========================================
// INVITES ROUTER — Admin-only invitation management
// ==========================================
const invitesRouter = router({
  create: adminProcedure
    .input(z.object({
      email: z.string().email(),
      role: z.enum(['admin', 'user']).default('user'),
      expiresAt: z.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Ensure the email is not already invited (optional check)
      const existingInvite = await db.getRegistrationInviteByEmail(input.email);
      if (existingInvite && !existingInvite.usedAt) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An active invitation already exists for this email.',
        });
      }

      const invite = await db.createRegistrationInvite(
        input.email,
        input.role,
        ctx.user.id, // createdBy from authenticated admin
        input.expiresAt
      );
      return invite;
    }),

  list: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      return db.listRegistrationInvites(input.limit, input.offset);
    }),

  delete: adminProcedure
    .input(z.object({
      id: z.string(),
    }))
    .mutation(async ({ input }) => {
      await db.deleteRegistrationInvite(input.id);
      return { success: true };
    }),
});

// ==========================================
// ROOT ROUTER
// ==========================================
export const appRouter = router({
  auth: authRouter,
  gaps: gapsRouter,
  queue: queueRouter,
  deployments: deploymentsRouter,
  audit: auditRouter,
  policies: policiesRouter,
  coreLoop: coreLoopRouter,
  analytics: analyticsRouter,
  discovery: discoveryRouter,
  integrations: integrationsRouter,
  settings: settingsRouter,
  invites: invitesRouter, // <-- new admin invites router
});

export type AppRouter = typeof appRouter;
