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
import { testGroqConnection, testLLMRouter } from './services/llm';
import { crawlAndExtract } from './services/crawler';
import { search as googleSearch, searchForGaps, trendingProblems } from './services/search';
import { users, gaps, queueItems } from '../drizzle/schema';
import { eq, asc, sql } from 'drizzle-orm';
import { createCryptoPayment, toSafePaymentView } from './services/crypto';
import { hasNowPaymentsApiKey, getNowPaymentsConfig } from './services/nowpayments';
import * as providerRegistry from './services/providerRegistry';

// ==========================================
// RESEND EMAIL CONFIGURATION
// ==========================================
const resendApiKey = process.env.RESEND_API_KEY || '';
const resendFromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@sao-system.com';
const resendFromName = process.env.RESEND_FROM_NAME || 'SAO';
const resendFrom = `${resendFromName} <${resendFromEmail}>`;
const resend = resendApiKey ? new Resend(resendApiKey) : null;

// In-memory rate limiting for password reset CODE VERIFICATION (per email)
const resetCodeRateLimit = new Map<string, { count: number; windowStart: number }>();
const RESET_CODE_RATE_LIMIT_MAX = 5;        // max failed code attempts per window
const RESET_CODE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes (same as code expiry)
const resetRateLimit = new Map<string, { count: number; windowStart: number }>();
const RESET_RATE_LIMIT_MAX = 3;       // max attempts per window
const RESET_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkResetRateLimit(email: string): void {
  const normalized = email.trim().toLowerCase();
  const now = Date.now();
  const entry = resetRateLimit.get(normalized);
  
  if (!entry || now - entry.windowStart > RESET_RATE_LIMIT_WINDOW_MS) {
    resetRateLimit.set(normalized, { count: 1, windowStart: now });
    return;
  }
  
  if (entry.count >= RESET_RATE_LIMIT_MAX) {
    const remainingMs = RESET_RATE_LIMIT_WINDOW_MS - (now - entry.windowStart);
    const remainingMin = Math.ceil(remainingMs / 60000);
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many password reset requests. Please try again in ${remainingMin} minute(s).`,
    });
  }
  
  entry.count++;
}

/**
 * Send an email via Resend. Returns true if sent, false if Resend is not configured.
 * Throws on actual send failures so callers can decide how to handle.
 */
async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  if (!resend) {
    console.warn('[Email] Resend not configured — RESEND_API_KEY is missing. Email NOT sent.');
    return false;
  }

  if (!resendFromEmail || resendFromEmail === 'noreply@sao-system.com') {
    console.warn(
      '[Email] Using default from address. For production, set RESEND_FROM_EMAIL to a domain verified in Resend.'
    );
  }

  try {
    const result = await resend.emails.send({
      from: resendFrom,
      to: [params.to],
      subject: params.subject,
      text: params.text,
      html: params.html,
    });

    if (result.error) {
      console.error('[Email] Resend returned an error:', result.error);
      throw new Error(String(result.error));
    }

    console.log(`[Email] Sent "${params.subject}" to ${params.to} (Resend ID: ${result.data?.id || 'unknown'})`);
    return true;
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error(`[Email] Failed to send "${params.subject}" to ${params.to}: ${msg}`);
    // Check for domain verification issues
    if (msg.includes('domain') || msg.includes('verify') || msg.includes('verified')) {
      console.error(
        '[Email] HINT: The from-address domain must be verified in Resend. ' +
        `Current from: ${resendFromEmail}. ` +
        'Set RESEND_FROM_EMAIL to a domain you own and verify it at https://resend.com/domains'
      );
    }
    throw error;
  }
}

// ==========================================
// AUTH ROUTER
// ==========================================
const authRouter = router({
  validateInvite: publicProcedure
    .input(z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/i),
    }))
    .query(async ({ input }) => {
      const tokenHash = crypto
        .createHash('sha256')
        .update(input.token)
        .digest('hex');

      const invite = await db.getRegistrationInviteByTokenHash(tokenHash);

      if (!invite) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Invalid or expired invitation.',
        });
      }

      if (invite.usedAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This invitation has already been used.',
        });
      }

      if (invite.expiresAt && new Date() > new Date(invite.expiresAt)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This invitation has expired.',
        });
      }

      return {
        valid: true,
        email: invite.email,
        role: invite.role,
      };
    }),

  register: publicProcedure
    .input(z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/i),
      password: z.string().min(6),
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. Hash the raw invitation token and look up the invitation.
      // The raw token is never stored in or compared directly against the database.
      const tokenHash = crypto
        .createHash('sha256')
        .update(input.token)
        .digest('hex');

      const invite = await db.getRegistrationInviteByTokenHash(tokenHash);

      if (!invite) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Invalid or expired invitation.',
        });
      }

      // 2. Enforce single-use and expiry at registration time.
      // Validation is repeated here because the invitation could become
      // invalid after the initial page validation.
      if (invite.usedAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This invitation has already been used.',
        });
      }

      if (invite.expiresAt && new Date() > new Date(invite.expiresAt)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This invitation has expired.',
        });
      }

      // 3. Check whether the invitation email already has an account.
      const existingUser = await db.getUserByEmail(invite.email);
      if (existingUser) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A user with this email already exists.',
        });
      }

      // 4. Create the account using the email and role stored in the invitation.
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(input.password, salt);
      const role = invite.role as 'admin' | 'user';

      const user = await db.createUser(invite.email, passwordHash, role);
      if (!user) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create user.',
        });
      }

      // 5. Mark the invitation as used after successful account creation.
      await db.markInviteUsed(invite.id);

      // 6. Create the authenticated session.
      const session = signSession(user.id);
      ctx.res.cookie(COOKIE_NAME, session, cookieOptions);

      return {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      };
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
      // Rate limit
      checkResetRateLimit(input.email);

      const user = await db.getUserByEmail(input.email);
      // Always return success to prevent email enumeration
      if (!user) return { success: true };

      const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiry = new Date(Date.now() + 15 * 60 * 1000);

      await db.updateUserResetCode(input.email, resetCode, expiry);

      try {
        await sendEmail({
          to: input.email,
          subject: 'Password Reset Code - SAO',
          text: `Your password reset code is: ${resetCode}\n\nThis code is valid for 15 minutes.\n\nIf you did not request this password reset, please ignore this email.`,
          html: `<p>Your password reset code is: <strong>${resetCode}</strong></p><p>This code is valid for 15 minutes.</p><p>If you did not request this password reset, please ignore this email.</p>`,
        });
      } catch (error) {
        console.error('Failed to send password reset email — Resend delivery issue:', error);
        // Clear the reset code since we couldn't deliver it
        await db.clearResetCode(input.email);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to send password reset email. Please try again later or contact support.',
        });
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
      // Rate-limit failed code verification attempts
      const normalizedEmail = input.email.trim().toLowerCase();
      const now = Date.now();
      const entry = resetCodeRateLimit.get(normalizedEmail);

      if (entry && (now - entry.windowStart) < RESET_CODE_RATE_LIMIT_WINDOW_MS && entry.count >= RESET_CODE_RATE_LIMIT_MAX) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many invalid reset code attempts. Please request a new code.',
        });
      }

      const user = await db.getUserByEmail(input.email);
      if (!user || !user.resetCode || !user.resetCodeExpiry) {
        // Track failed attempt
        if (!entry || (now - entry.windowStart) >= RESET_CODE_RATE_LIMIT_WINDOW_MS) {
          resetCodeRateLimit.set(normalizedEmail, { count: 1, windowStart: now });
        } else {
          entry.count++;
        }
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid request or reset code expired.' });
      }

      if (user.resetCode !== input.code || new Date() > user.resetCodeExpiry) {
        // Track failed attempt
        if (!entry || (now - entry.windowStart) >= RESET_CODE_RATE_LIMIT_WINDOW_MS) {
          resetCodeRateLimit.set(normalizedEmail, { count: 1, windowStart: now });
        } else {
          entry.count++;
        }
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid reset code or code has expired.' });
      }

      // Successful verification — clear rate limit
      resetCodeRateLimit.delete(normalizedEmail);

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
    .query(async ({ ctx }) => {
      // Admins see all deployments; regular users only their own.
      if (ctx.user.role === 'admin') {
        return db.listDeployments();
      }
      return db.listDeployments(ctx.user.id);
    }),

  get: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found' });
      // Ownership check — admins may access any deployment.
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
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
    .query(async ({ ctx }) => {
      const allDeployments = ctx.user.role === 'admin'
        ? await db.listDeployments()
        : await db.listDeployments(ctx.user.id);
      return {
        total: allDeployments.length,
        active: allDeployments.filter((d: any) => d.status === 'active').length,
        paused: allDeployments.filter((d: any) => d.status === 'paused').length,
        stopped: allDeployments.filter((d: any) => d.status === 'stopped').length,
      };
    }),

  listProviders: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      // Verify ownership before returning provider data
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      return db.getProvidersForDeployment(input);
    }),

  getDeploymentUrl: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      // Verify ownership before returning URL
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      const provider = await db.getActiveProvider(input, 'vercel');
      return { deploymentUrl: provider?.deploymentUrl || null };
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
      await stopCoreLoop();
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
      const state = await db.getCoreLoopState();
      const { getDiscoveryStatus, getExtractionMetrics } = await import('./services/search');
      const discoveryStatus = getDiscoveryStatus();
      const extractionMetrics = getExtractionMetrics();

      // Normalize DB snake_case fields to the camelCase contract the
      // dashboard consumes (historically mismatched, causing the UI to
      // always show the loop as stopped and settings to load defaults).
      return {
        // snake_case aliases (backward compatible)
        is_running: Boolean(state?.isRunning),
        interval_ms: Number(state?.intervalMs || 0),
        last_executed_at: state?.lastExecutedAt ? new Date(state.lastExecutedAt).toISOString() : null,
        next_execution_at: state?.nextExecutionAt ? new Date(state.nextExecutionAt).toISOString() : null,
        max_attempts: Number(state?.maxAttempts || 0),
        backoff_multiplier: state?.backoffMultiplier || '1.5',
        base_delay_ms: Number(state?.baseDelayMs || 0),
        queue_max_size: Number(state?.queueMaxSize || 0),
        queue_expiration_hours: Number(state?.queueExpirationHours || 0),
        concurrency: Number(state?.concurrency || 1),
        max_cost_per_day: state?.maxCostPerDay || '50.00',
        max_deployments: Number(state?.maxDeployments || 0),
        auto_pause_on_high_ban_risk: Boolean(state?.autoPauseOnHighBanRisk),
        email_notifications: Boolean(state?.emailNotifications),
        slack_notifications: Boolean(state?.slackNotifications),

        // camelCase contract (primary)
        isRunning: Boolean(state?.isRunning),
        intervalMs: Number(state?.intervalMs || 0),
        lastExecutedAt: state?.lastExecutedAt ? new Date(state.lastExecutedAt).toISOString() : null,
        nextExecutionAt: state?.nextExecutionAt ? new Date(state.nextExecutionAt).toISOString() : null,
        maxAttempts: Number(state?.maxAttempts || 0),
        backoffMultiplier: state?.backoffMultiplier || '1.5',
        baseDelayMs: Number(state?.baseDelayMs || 0),
        queueMaxSize: Number(state?.queueMaxSize || 0),
        queueExpirationHours: Number(state?.queueExpirationHours || 0),
        maxCostPerDay: state?.maxCostPerDay || '50.00',
        maxDeployments: Number(state?.maxDeployments || 0),
        autoPauseOnHighBanRisk: Boolean(state?.autoPauseOnHighBanRisk),
        emailNotifications: Boolean(state?.emailNotifications),
        slackNotifications: Boolean(state?.slackNotifications),

        discovery: discoveryStatus,
        extraction: {
          totalAttempts: extractionMetrics.totalAttempts,
          llmSuccesses: extractionMetrics.llmSuccesses,
          llmNoValidGaps: extractionMetrics.llmNoValidGaps,
          llmSchemaFailures: extractionMetrics.llmSchemaFailures,
          totalGapsExtracted: extractionMetrics.totalGapsExtracted,
          failures: extractionMetrics.failures,
          lastFailureReason: extractionMetrics.lastFailureReason,
          lastFailureTime: extractionMetrics.lastFailureTime
            ? new Date(extractionMetrics.lastFailureTime).toISOString()
            : null,
          lastSuccessTime: extractionMetrics.lastSuccessTime
            ? new Date(extractionMetrics.lastSuccessTime).toISOString()
            : null,
        },
      };
    }),
});

// ==========================================
// ANALYTICS ROUTER
// ==========================================
const analyticsRouter = router({
  overview: protectedProcedure
    .query(async ({ ctx }) => {
      const allGaps = await db.listGaps(1000, 0);
      const allDeployments = ctx.user.role === 'admin'
        ? await db.listDeployments()
        : await db.listDeployments(ctx.user.id);
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
    .query(async ({ ctx }) => {
      const allDeployments = ctx.user.role === 'admin'
        ? await db.listDeployments()
        : await db.listDeployments(ctx.user.id);
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

  // ==========================================
  // Live Discovery Pipeline Diagnostic
  // Traces the ENTIRE pipeline: Core Loop → Tavily → LLM → DB → Queue
  // ==========================================
  pipelineDiagnostic: adminProcedure
    .query(async () => {
      const { getDiscoveryStatus, getExtractionMetrics } = await import('./services/search');
      const discoveryStatus = getDiscoveryStatus();
      const extractionMetrics = getExtractionMetrics();

      const coreLoopState = await db.getCoreLoopState();
      
      const [gapCount, queueCount] = await Promise.all([
        db.db.select({ count: sql<number>`count(*)` }).from(gaps).then(r => r[0]?.count || 0),
        db.db.select({ count: sql<number>`count(*)` }).from(queueItems).then(r => r[0]?.count || 0),
      ]);

      return {
        timestamp: new Date().toISOString(),
        tavily: {
          configured: discoveryStatus.tavilyConfigured,
          lastSearchStatus: discoveryStatus.lastSearchStatus,
          lastSearchStatusTime: discoveryStatus.lastSearchStatusTime,
        },
        extraction: {
          totalAttempts: extractionMetrics.totalAttempts,
          llmSuccesses: extractionMetrics.llmSuccesses,
          llmNoValidGaps: extractionMetrics.llmNoValidGaps,
          llmSchemaFailures: extractionMetrics.llmSchemaFailures,
          totalGapsExtracted: extractionMetrics.totalGapsExtracted,
          failures: extractionMetrics.failures,
          lastFailureReason: extractionMetrics.lastFailureReason,
          lastFailureTime: extractionMetrics.lastFailureTime
            ? new Date(extractionMetrics.lastFailureTime).toISOString()
            : null,
          lastSuccessTime: extractionMetrics.lastSuccessTime
            ? new Date(extractionMetrics.lastSuccessTime).toISOString()
            : null,
        },
        coreLoop: {
          isRunning: coreLoopState?.isRunning ?? false,
          intervalMs: coreLoopState?.intervalMs ?? 10800000,
          lastExecutedAt: coreLoopState?.lastExecutedAt ? new Date(coreLoopState.lastExecutedAt).toISOString() : null,
          nextExecutionAt: coreLoopState?.nextExecutionAt ? new Date(coreLoopState.nextExecutionAt).toISOString() : null,
          totalGapsProcessed: coreLoopState?.totalGapsProcessed ?? 0,
          totalDeploymentsCreated: coreLoopState?.totalDeploymentsCreated ?? 0,
        },
        database: {
          gapsCount: Number(gapCount),
          queueItemsCount: Number(queueCount),
          gapStatuses: {} as Record<string, number>,
        },
        status: (() => {
          const issues: string[] = [];
          if (!discoveryStatus.tavilyConfigured) issues.push('TAVILY_API_KEY not configured');
          if (!coreLoopState?.isRunning) issues.push('Core Loop is not running');
          if (discoveryStatus.lastSearchStatus === 'api_error') issues.push('Last Tavily API call failed');
          if (discoveryStatus.lastSearchStatus === 'not_configured') issues.push('Tavily is not configured');
          if (Number(gapCount) === 0) issues.push('Zero gaps in database');
          if (extractionMetrics.lastFailureReason) {
            issues.push(`Last extraction failure: ${extractionMetrics.lastFailureReason}`);
          }
          if (extractionMetrics.totalAttempts > 0 && extractionMetrics.llmSuccesses === 0) {
            issues.push('All extraction attempts have failed — LLM pipeline is non-functional');
          }
          return {
            healthy: issues.length === 0,
            issues,
          };
        })(),
      };
    }),
});

// ==========================================
// INTEGRATIONS ROUTER — Test all service connections
// ==========================================
const integrationsRouter = router({
  testGroq: adminProcedure
    .query(async () => {
      return testGroqConnection();
    }),

  testLLMRouter: adminProcedure
    .query(async () => {
      const status = testLLMRouter();
      return {
        success: status.success,
        message: status.message,
        providers: status.providers.map((p) => ({
          provider: p.provider,
          model: p.model,
          credentials: p.credentials,
          state: p.state,
        })),
      };
    }),

  testGitHub: adminProcedure
    .query(async () => {
      const token = process.env.GITHUB_TOKEN;
      return {
        success: !!token,
        message: token ? 'GitHub token is configured' : 'GitHub token is missing',
      };
    }),

  testStripe: adminProcedure
    .query(async () => {
      const key = process.env.STRIPE_SECRET_KEY;
      return {
        success: !!key,
        message: key ? 'Stripe key is configured' : 'Stripe key is missing',
      };
    }),

  testResend: adminProcedure
    .query(async () => {
      const key = process.env.RESEND_API_KEY;
      return {
        success: !!key,
        message: key ? 'Resend key is configured' : 'Resend key is missing',
      };
    }),

  testSlack: adminProcedure
    .query(async () => {
      const token = process.env.SLACK_BOT_TOKEN;
      return {
        success: !!token,
        message: token ? 'Slack token is configured' : 'Slack token is missing',
      };
    }),

  testGoogleSearch: adminProcedure
    .query(async () => {
      // Tavily is the current search provider (replaced Google Custom Search).
      const { getDiscoveryStatus } = await import('./services/search');
      const status = getDiscoveryStatus();
      return {
        success: status.tavilyConfigured,
        message: status.tavilyConfigured
          ? `Tavily search is configured. Last status: ${status.lastSearchStatus || 'not yet called'}`
          : 'Tavily search is NOT configured (TAVILY_API_KEY missing). Set TAVILY_API_KEY in environment.',
      };
    }),

  testVercel: adminProcedure
    .query(async () => {
      const { testVercelConnection } = await import('./services/vercel');
      return testVercelConnection();
    }),

  testNowPayments: adminProcedure
    .query(async () => {
      // Report configuration presence only — never the secret values.
      const hasKey = hasNowPaymentsApiKey();
      const hasSecret = Boolean(process.env.NOWPAYMENTS_IPN_SECRET);
      if (!hasKey || !hasSecret) {
        return {
          success: false,
          message: hasKey
            ? 'NOWPayments IPN secret is missing'
            : 'NOWPayments API key is missing',
        };
      }
      try {
        getNowPaymentsConfig();
        return { success: true, message: 'NOWPayments API key and IPN secret are configured' };
      } catch (err: any) {
        return { success: false, message: err.message || 'NOWPayments configuration error' };
      }
    }),
});

// ==========================================
// PAYMENTS ROUTER — crypto-only payment ledger (NOWPayments).
// Ownership is always derived through payment → deployment → userId.
// ==========================================
const paymentsRouter = router({

  get: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      const payment = await db.getPaymentById(input);
      if (!payment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment not found.' });
      // Ownership check via associated deployment
      const deployment = await db.getDeploymentById(payment.deploymentId);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this payment.' });
      }
      return toSafePaymentView(payment);
    }),

  listForDeployment: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      // Verify ownership before returning payment history
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      const payments = await db.listPaymentsForDeployment(input);
      return payments.map(toSafePaymentView);
    }),

  list: protectedProcedure
    .query(async ({ ctx }) => {
      if (ctx.user.role === 'admin') {
        const payments = await db.listPayments();
        return payments.map(toSafePaymentView);
      }
      const payments = await db.listPaymentsForUser(ctx.user.id);
      return payments.map(toSafePaymentView);
    }),

  createCryptoPayment: protectedProcedure
    .input(z.object({
      deploymentId: z.string().min(1),
      payCurrency: z.string().min(1).max(20).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. Verify the deployment exists.
      const deployment = await db.getDeploymentById(input.deploymentId);
      if (!deployment) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      }

      // 2. Verify ownership — never trust a client-supplied userId.
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this deployment.',
        });
      }

      // 3. Create the crypto payment (server determines price, calls provider).
      return createCryptoPayment({
        deploymentId: input.deploymentId,
        payCurrency: input.payCurrency,
      });
    }),
});

// ==========================================
// SETTINGS ROUTER
// ==========================================
const settingsRouter = router({
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
        
        // If the interval changed, reschedule the running core loop
        if (input.intervalMs !== undefined) {
          await updateCoreLoopInterval(input.intervalMs);
        }
      }

      return { success: true };
    }),

  testConnection: adminProcedure
    .input(z.object({
      service: z.enum(['groq', 'google-search', 'github', 'slack', 'resend', 'stripe']),
    }))
    .mutation(async ({ input }) => {
      const envMap: Record<string, string[]> = {
        groq: ['GROQ_API_KEY'],
        'google-search': ['GOOGLE_SEARCH_API_KEY', 'GOOGLE_SEARCH_CX'],
        github: ['GITHUB_TOKEN'],
        slack: ['SLACK_BOT_TOKEN'],
        resend: ['RESEND_API_KEY'],
        stripe: ['STRIPE_SECRET_KEY'],
      };

      if (input.service === 'groq') {
        return testGroqConnection();
      }

      const envVars = envMap[input.service] || [];
      const allConfigured = envVars.every(v => process.env[v]);
      return {
        service: input.service,
        configured: allConfigured,
        message: allConfigured ? `${input.service} is configured` : `${input.service} key(s) missing`,
      };
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

  // Notification Settings
  saveNotificationSettings: adminProcedure
    .input(z.object({
      emailNotifications: z.boolean(),
      slackNotifications: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      await db.updateCoreLoopState({
        emailNotifications: input.emailNotifications,
        slackNotifications: input.slackNotifications,
      } as any);
      return { success: true };
    }),

  // Operational Limits
  saveOperationalLimits: adminProcedure
    .input(z.object({
      maxCostPerDay: z.number().min(0),
      maxDeployments: z.number().min(0),
      autoPauseOnHighBanRisk: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      await db.updateCoreLoopState({
        maxCostPerDay: input.maxCostPerDay.toString(),
        maxDeployments: input.maxDeployments,
        autoPauseOnHighBanRisk: input.autoPauseOnHighBanRisk,
      } as any);
      return { success: true };
    }),

  // Core Loop Interval
  setInterval: adminProcedure
    .input(z.object({
      intervalMs: z.number().min(5000).max(86400000),
    }))
    .mutation(async ({ input }) => {
      await updateCoreLoopInterval(input.intervalMs);
      return { success: true, intervalMs: input.intervalMs };
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
      expiresAt: z.string().datetime().optional(),
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

      const { invite, token } = await db.createRegistrationInvite(
        input.email,
        input.role,
        ctx.user.id, // createdBy from authenticated admin
        input.expiresAt ? new Date(input.expiresAt) : undefined
      );

      // Send invitation notification email with the unique registration URL.
      const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173';
      const registrationUrl = `${frontendUrl.replace(/\/$/, '')}/register?invite=${encodeURIComponent(token)}`;

      try {
        await sendEmail({
          to: input.email,
          subject: 'You are invited to SAO',
          text: `You have been invited to join SAO as a ${input.role}.\n\nComplete your registration here: ${registrationUrl}\n\nThis invitation is single-use.`,
          html: `<p>You have been invited to join SAO as a <strong>${input.role}</strong>.</p><p><a href="${registrationUrl}">Complete your SAO registration</a></p><p>This invitation is single-use.</p>`,
        });
      } catch (error) {
        console.error('Failed to send invitation email — Resend delivery issue:', error);
        // Don't fail the invite creation — the invite is still valid;
        // the admin can communicate the link directly.
      }

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
// ADVERTISING ROUTER (Phase 13)
// ==========================================
const advertisingRouter = router({
  overview: protectedProcedure
    .query(async ({ ctx }) => {
      const campaigns = ctx.user.role === 'admin'
        ? await db.listAllCampaigns()
        : (await Promise.all(
            (await db.listDeployments(ctx.user.id)).map(d => db.listCampaignsForDeployment(d.id))
          )).flat();
      const totalBudget = campaigns.reduce((s, c) => s + parseFloat(String(c.budget || '0')), 0);
      const totalSpent = campaigns.reduce((s, c) => s + parseFloat(String(c.spent || '0')), 0);
      const activeCount = campaigns.filter(c => c.status === 'ACTIVE').length;
      return { campaigns, totalBudget, totalSpent, activeCount };
    }),

  listForDeployment: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      return db.listCampaignsForDeployment(input);
    }),

  get: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      const campaign = await db.getAdCampaignById(input);
      if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' });
      const deployment = await db.getDeploymentById(campaign.deploymentId);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this campaign.' });
      }
      return campaign;
    }),

  getCreatives: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      const campaign = await db.getAdCampaignById(input);
      if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' });
      const deployment = await db.getDeploymentById(campaign.deploymentId);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this campaign.' });
      }
      return db.listCreativesForCampaign(input);
    }),

  getStats: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      return db.getAdvertisingStats(input);
    }),

  analyze: protectedProcedure
    .input(z.string())
    .mutation(async ({ input, ctx }) => {
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      const gap = await db.getGapById(deployment.gapId);
      const { analyzeProject } = await import('./services/advertising/projectAnalyzer');
      const { calculateAdvertisingBudget } = await import('./services/advertising/budgetEngine');
      const revenue = parseFloat(String(deployment.revenue || '0'));
      const { budget, percentageUsed } = calculateAdvertisingBudget(revenue);
      const analysis = await analyzeProject({
        deploymentId: deployment.id, knows: gap?.knows || '', needs: gap?.needs || '',
        controlsAccess: gap?.controlsAccess || '', underestimatesValue: gap?.underestimatesValue || '',
        businessPlan: deployment.businessPlan || '',
      });
      return { analysis, budget: { deploymentRevenue: revenue, advertisingRevenuePercentage: percentageUsed, calculatedBudget: budget } };
    }),

  generateStrategy: protectedProcedure
    .input(z.object({ deploymentId: z.string(), channel: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const deployment = await db.getDeploymentById(input.deploymentId);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      const gap = await db.getGapById(deployment.gapId);
      const { analyzeProject } = await import('./services/advertising/projectAnalyzer');
      const { buildAdvertisingStrategy } = await import('./services/advertising/strategyEngine');
      const { calculateAdvertisingBudget, determineCampaignType } = await import('./services/advertising/budgetEngine');
      const revenue = parseFloat(String(deployment.revenue || '0'));
      const { budget, percentageUsed } = calculateAdvertisingBudget(revenue);
      const analysis = await analyzeProject({
        deploymentId: deployment.id, knows: gap?.knows || '', needs: gap?.needs || '',
        controlsAccess: gap?.controlsAccess || '', underestimatesValue: gap?.underestimatesValue || '',
        businessPlan: deployment.businessPlan || '',
      });
      const strategy = buildAdvertisingStrategy({ projectAnalysis: analysis, advertisingBudget: budget, percentageUsed });
      const campaignType = determineCampaignType(budget);
      const channel = input.channel || (campaignType === 'PAID' ? 'google_ads' : 'organic_social');
      const campaign = await db.createAdCampaign({
        deploymentId: deployment.id, name: `${analysis.appName.slice(0, 50)} - ${channel}`,
        channel, campaignType, budget: budget.toFixed(2), strategy: JSON.stringify(strategy),
      });
      return { campaign, strategy, analysis };
    }),

  generateCreatives: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const campaign = await db.getAdCampaignById(input.campaignId);
      if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' });
      const deployment = await db.getDeploymentById(campaign.deploymentId);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this campaign.' });
      }
      const gap = await db.getGapById(deployment.gapId);
      const { analyzeProject } = await import('./services/advertising/projectAnalyzer');
      const { generateCreatives, generateBasicCreatives } = await import('./services/advertising/creativeGenerator');
      const { buildAdvertisingStrategy } = await import('./services/advertising/strategyEngine');
      const { calculateAdvertisingBudget } = await import('./services/advertising/budgetEngine');
      const revenue = parseFloat(String(deployment.revenue || '0'));
      const { budget, percentageUsed } = calculateAdvertisingBudget(revenue);
      const analysis = await analyzeProject({
        deploymentId: deployment.id, knows: gap?.knows || '', needs: gap?.needs || '',
        controlsAccess: gap?.controlsAccess || '', underestimatesValue: gap?.underestimatesValue || '',
        businessPlan: deployment.businessPlan || '',
      });
      const strategy = buildAdvertisingStrategy({ projectAnalysis: analysis, advertisingBudget: budget, percentageUsed });
      let result = await generateCreatives({ projectAnalysis: analysis, strategy, campaignId: campaign.id, deploymentId: deployment.id });
      if (!result.success) {
        const fallback = generateBasicCreatives({ projectAnalysis: analysis, strategy, campaignId: campaign.id, deploymentId: deployment.id });
        result = { success: true, creatives: fallback, error: 'Used basic generation fallback' };
      }
      for (const c of result.creatives) {
        await db.createAdCreative({ campaignId: campaign.id, format: c.format, content: c.content, headline: c.headline || undefined, callToAction: c.callToAction || undefined, targetAudience: c.targetAudience || undefined, variation: c.variation });
      }
      await db.updateAdCampaign(campaign.id, { status: 'READY' } as any);
      return { campaign, creatives: result.creatives, usedLLM: !result.error };
    }),

  channels: protectedProcedure
    .query(async () => {
      const { listChannels } = await import('./services/advertising/channelAdapter');
      return listChannels();
    }),

  publish: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const campaign = await db.getAdCampaignById(input.campaignId);
      if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' });
      const deployment = await db.getDeploymentById(campaign.deploymentId);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this campaign.' });
      }
      const { publishCampaign } = await import('./services/advertising/channelAdapter');
      const channelBudget = parseFloat(String(campaign.budget || '0'));
      if (campaign.campaignType === 'PAID' && channelBudget <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot publish PAID campaign with zero budget.' });
      }
      const result = await publishCampaign({ name: campaign.name, deploymentId: campaign.deploymentId, budget: channelBudget, channel: campaign.channel as any });
      if (!result.success) {
        await db.updateAdCampaign(campaign.id, { status: result.notConfigured ? 'WAITING_FOR_CREDENTIALS' : 'FAILED', errorMessage: result.error } as any);
        return { success: false, notConfigured: result.notConfigured, error: result.error };
      }
      await db.updateAdCampaign(campaign.id, { status: 'ACTIVE', providerCampaignId: result.providerCampaignId || null, providerStatus: result.providerStatus || null, startedAt: new Date() } as any);
      return { success: true, notConfigured: false };
    }),
});

// ==========================================
// PROVIDER REGISTRY ROUTER
// ==========================================
const providersRouter = router({
  serviceTypes: protectedProcedure
    .query(async () => {
      return providerRegistry.SERVICE_TYPES;
    }),

  knownProviders: protectedProcedure
    .query(async () => {
      return providerRegistry.getKnownProviders().map((p) => ({
        id: p.id,
        name: p.name,
        serviceType: p.serviceType,
        credentialType: p.credentialType,
        envConfigured: p.envConfigured(),
      }));
    }),

  list: protectedProcedure
    .input(z.object({ service: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const service = input?.service as providerRegistry.ServiceType | undefined;
      return providerRegistry.listProviders(service);
    }),

  create: adminProcedure
    .input(z.object({
      service: z.string().min(1),
      name: z.string().min(1),
      providerId: z.string().optional(),
      credentialType: z.string().optional(),
      credential: z.string().min(1),
      baseUrl: z.string().optional(),
      config: z.any().optional(),
      priority: z.enum(['primary', 'fallback']).nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      return providerRegistry.saveProvider({
        service: input.service as providerRegistry.ServiceType,
        name: input.name,
        providerId: input.providerId,
        credentialType: input.credentialType,
        credential: input.credential,
        baseUrl: input.baseUrl,
        config: input.config,
        priority: input.priority ?? null,
      });
    }),

  update: adminProcedure
    .input(z.object({
      id: z.string(),
      credential: z.string().optional(),
      baseUrl: z.string().nullable().optional(),
      config: z.any().optional(),
      name: z.string().optional(),
      enabled: z.boolean().optional(),
      priority: z.enum(['primary', 'fallback']).nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      return providerRegistry.updateProvider(input.id, {
        credential: input.credential,
        baseUrl: input.baseUrl ?? undefined,
        config: input.config,
        name: input.name,
        enabled: input.enabled,
        priority: input.priority,
      });
    }),

  remove: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      return providerRegistry.deleteProvider(input);
    }),

  test: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      return providerRegistry.testProvider(input);
    }),

  setPriority: adminProcedure
    .input(z.object({ id: z.string(), priority: z.enum(['primary', 'fallback']).nullable() }))
    .mutation(async ({ input }) => {
      return providerRegistry.setProviderPriority(input.id, input.priority);
    }),

  setEnabled: adminProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      return providerRegistry.toggleProviderEnabled(input.id, input.enabled);
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
  invites: invitesRouter,
  payments: paymentsRouter,
  advertising: advertisingRouter,
  providers: providersRouter,
});

export type AppRouter = typeof appRouter;
