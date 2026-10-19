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
import { testGroqConnection, testLLMRouterAsync } from './services/llm';
import { crawlAndExtract } from './services/crawler';
import { search as googleSearch, searchForGaps, trendingProblems } from './services/search';
import { users, gaps, queueItems, adExperiments } from '../drizzle/schema';
import { eq, asc, sql, inArray } from 'drizzle-orm';
import { createCryptoPayment, toSafePaymentView } from './services/crypto';
import { hasNowPaymentsApiKeyAsync, getNowPaymentsConfigAsync } from './services/nowpayments';
import * as providerRegistry from './services/providerRegistry';
import * as infrastructure from './services/infrastructure';
import { operationsRouter } from './operationsRouter';
import * as policyEngine from './services/policyEngine';
import { policyCategories } from '../shared/policyContracts';
import { discoveryResetPreview } from './services/discoveryReset';
import { gapReviewInput, recordGapReview, gapPolicyAssessment, discoveryBoard, reviewDiscoveryEvidence } from './services/discoveryPolicy';

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
      const dedupHash = infrastructure.computeGapDedupHash(input as any);

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

  list: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      skip: z.number().min(0).default(0),
      status: z.enum(['pending', 'processing', 'safe', 'unsafe', 'gray', 'false', 'deployed', 'failed']).optional(),
      search: z.string().trim().max(200).optional(),
    }))
    .query(async ({ input }) => {
      return db.listGaps(input.limit, input.skip, input);
    }),

  get: adminProcedure
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

  retry: adminProcedure
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
  list: adminProcedure
    .query(async () => {
      return db.listQueueItems();
    }),

  stats: adminProcedure
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
  list: adminProcedure
    .query(async ({ ctx }) => {
      // Admins see all deployments; regular users only their own.
      if (ctx.user.role === 'admin') {
        return db.listDeployments();
      }
      return db.listDeployments(ctx.user.id);
    }),

  get: adminProcedure
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
  list: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      skip: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      return db.listAuditLogs(input.limit, input.skip);
    }),

  get: adminProcedure
    .input(z.string())
    .query(async ({ input }) => {
      const log = await db.getAuditLogById(input);
      if (!log) throw new TRPCError({ code: 'NOT_FOUND', message: 'Audit log not found' });
      return log;
    }),
});

// ==========================================
// POLICIES ROUTER
// ==========================================
const policiesRouter = router({
  discoveryBoard: adminProcedure.input(z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), legalState: z.enum(['legal', 'illegal', 'pending_review']).optional() })).query(({ ctx, input }) => discoveryBoard(ctx.user, input.offset, input.limit, input.legalState)),
  reviewEvidence: adminProcedure.input(z.object({ id: z.string(), reliable: z.boolean(), rationale: z.string().min(1), publisher: z.string().min(1) })).mutation(({ ctx, input }) => reviewDiscoveryEvidence(ctx.user, input.id!, input.reliable!, input.rationale!, input.publisher!)),
  reviewGap: adminProcedure.input(gapReviewInput).mutation(({ ctx, input }) => recordGapReview(ctx.user, input)),
  gapAssessment: adminProcedure.input(z.string()).query(({ input }) => gapPolicyAssessment(input)),
  overview: adminProcedure.query(({ ctx }) => policyEngine.policyOverview(ctx.user)),
  history: adminProcedure.input(z.object({ category: z.enum(policyCategories as [typeof policyCategories[number], ...typeof policyCategories[number][]]), offset: z.number().int().min(0).default(0) })).query(({ ctx, input }) => policyEngine.policyHistory(ctx.user, input.category, input.offset)),
  saveDraft: adminProcedure.input(z.object({ category: z.enum(policyCategories as [typeof policyCategories[number], ...typeof policyCategories[number][]]), config: z.record(z.unknown()), reason: z.string().trim().min(1).max(2000), restoreId: z.string().optional() })).mutation(({ ctx, input }) => policyEngine.savePolicyDraft(ctx.user, { category: input.category!, config: input.config, reason: input.reason!, restoreId: input.restoreId })),
  validateDraft: adminProcedure.input(z.string()).mutation(({ ctx, input }) => policyEngine.validatePolicyDraft(ctx.user, input)),
  activate: adminProcedure.input(z.string()).mutation(({ ctx, input }) => policyEngine.activatePolicy(ctx.user, input)),
  impact: adminProcedure.input(z.enum(policyCategories as [typeof policyCategories[number], ...typeof policyCategories[number][]])).query(({ ctx, input }) => policyEngine.policyImpact(ctx.user, input)),
  activity: adminProcedure.input(z.object({ category: z.enum(policyCategories as [typeof policyCategories[number], ...typeof policyCategories[number][]]), offset: z.number().int().min(0).default(0) })).query(({ ctx, input }) => policyEngine.policyActivity(ctx.user, input.category, input.offset)),
  discoveryResetPreview: adminProcedure.query(({ ctx }) => discoveryResetPreview(ctx.user)),
  list: adminProcedure
    .query(async ({ ctx }) => {
      await policyEngine.requirePolicyPermission(ctx.user, 'policies.view');
      return db.listPolicies();
    }),

  create: adminProcedure
    .input(z.object({ ruleText: z.string().trim().min(1).max(10000) }))
    .mutation(async ({ ctx, input }) => {
      await policyEngine.requirePolicyPermission(ctx.user);
      return db.createPolicy(input.ruleText);
    }),

  acknowledge: adminProcedure
    .input(z.string())
    .mutation(async ({ ctx, input }) => {
      await policyEngine.requirePolicyPermission(ctx.user);
      await db.updatePolicyAcknowledged(input);
      return { success: true };
    }),

  delete: adminProcedure
    .input(z.string())
    .mutation(async ({ ctx, input }) => {
      await policyEngine.requirePolicyPermission(ctx.user);
      await db.deletePolicy(input);
      return { success: true };
    }),
});

// ==========================================
// CORE LOOP ROUTER
// ==========================================
const runtimeProcedure = adminProcedure.use(async ({ ctx, next, path }) => {
  await policyEngine.requirePolicyPermission(ctx.user, 'settings.manage');
  const result = await next();
  if (result.ok) {
    const { auditOperation } = await import('./services/execution');
    await auditOperation(ctx.user.id, 'runtime_control', path, { persistedState: await db.getCoreLoopState() });
  }
  return result;
});
const coreLoopRouter = router({
  resetOperationalData: adminProcedure
    .mutation(async () => {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Full operational reset is unavailable. Use the scoped discovery maintenance preview.' });
    }),

  start: runtimeProcedure
    .mutation(async () => {
      await startCoreLoop();
      return { success: true, message: 'Core loop started' };
    }),

  stop: runtimeProcedure
    .mutation(async () => {
      await stopCoreLoop();
      return { success: true, message: 'Core loop stopped' };
    }),

  runOnce: runtimeProcedure
    .mutation(async () => {
      const result = await processOneGap();
      return result || { success: false, message: 'No gaps in queue' };
    }),

  runAudit: runtimeProcedure
    .mutation(async () => {
      await auditAllActiveDeployments();
      return { success: true, message: 'Audit triggered for all active deployments' };
    }),

  updateInterval: runtimeProcedure
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
      await (await import('./services/webSearch')).webSearch.restoreStatus().catch(() => {});
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
      const gapsByStatus: Record<string, number> = ctx.user.role === 'admin' ? await db.getGapStatusCounts() : {};
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

      const deploymentsByStatus: Record<string, number> = {};

      for (const deployment of allDeployments) {
        const status = String((deployment as any).status || 'unknown');
        deploymentsByStatus[status] =
          (deploymentsByStatus[status] || 0) + 1;
      }

      return {
        totalGaps: Object.values(gapsByStatus).reduce((total, count) => total + count, 0),
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
        const dedupHash = infrastructure.computeGapDedupHash(g);
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
      const { queueDiscoveryGaps } = await import('./services/discoveryQueue');
      const queued = await queueDiscoveryGaps(gaps as import('./services/discoveryEvidence').QualifiedGap[]);
      return { success: true, gapsFound: gaps.length, queued, gaps };
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
      await (await import('./services/webSearch')).webSearch.restoreStatus().catch(() => {});
      const discoveryStatus = getDiscoveryStatus();
      const extractionMetrics = getExtractionMetrics();

      const coreLoopState = await db.getCoreLoopState();
      
      const [gapCount, queueCount] = await Promise.all([
        db.db.select({ count: sql<number>`count(*)` }).from(gaps).where(sql`NOT EXISTS(SELECT 1 FROM discovery_archives WHERE gap_id=${gaps.id})`).then(r => r[0]?.count || 0),
        db.db.select({ count: sql<number>`count(*)` }).from(queueItems).then(r => r[0]?.count || 0),
      ]);

      return {
        timestamp: new Date().toISOString(),
        multiSource: await (await import('./services/discovery')).restoreDiscoveryReport(),
        webSearch: discoveryStatus,
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
      const status = await testLLMRouterAsync();
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
      const hasKey = await hasNowPaymentsApiKeyAsync();
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
        await getNowPaymentsConfigAsync();
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
const settingsProcedure = adminProcedure.use(async ({ ctx, next, path, type }) => {
  await policyEngine.requirePolicyPermission(ctx.user, 'settings.manage');
  const result = await next();
  if (type === 'mutation' && result.ok) {
    const { auditOperation } = await import('./services/execution');
    await auditOperation(ctx.user.id, 'runtime_setting_changed', path, { savedState: await db.getCoreLoopState() });
  }
  return result;
});
const settingsRouter = router({
  save: settingsProcedure
    .input(z.object({
      intervalMs: z.number().int().min(60000).max(86400000).optional(),
      maxCostPerDay: z.number().finite().min(0).optional(),
      maxDeployments: z.number().int().min(0).optional(),
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

  testConnection: settingsProcedure
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
  retryConfig: settingsProcedure
    .input(z.object({
      maxAttempts: z.number().int().min(1).max(10),
      backoffMultiplier: z.number().min(1).max(3),
      baseDelayMs: z.number().int().min(1000).max(60000),
    }))
    .mutation(async ({ input }) => {
      await db.updateCoreLoopState({
        maxAttempts: input.maxAttempts,
        backoffMultiplier: input.backoffMultiplier.toString(),
        baseDelayMs: input.baseDelayMs,
      } as any);
      return { success: true };
    }),

  getRetryConfig: settingsProcedure
    .query(async () => {
      const state = await db.getCoreLoopState();
      return {
        maxAttempts: (state as any).maxAttempts || 3,
        backoffMultiplier: parseFloat((state as any).backoffMultiplier || '1.5'),
        baseDelayMs: (state as any).baseDelayMs || 5000,
      };
    }),

  // Queue Limits
  queueLimits: settingsProcedure
    .input(z.object({
      maxSize: z.number().int().min(100).max(10000),
      expirationHours: z.number().int().min(1).max(168),
    }))
    .mutation(async ({ input }) => {
      await db.updateCoreLoopState({
        queueMaxSize: input.maxSize,
        queueExpirationHours: input.expirationHours,
      } as any);
      return { success: true };
    }),

  getQueueLimits: settingsProcedure
    .query(async () => {
      const state = await db.getCoreLoopState();
      return {
        maxSize: (state as any).queueMaxSize || 1000,
        expirationHours: (state as any).queueExpirationHours || 72,
      };
    }),

  // Worker Pool Concurrency
  setConcurrency: settingsProcedure
    .input(z.object({
      level: z.number().int().min(1).max(10),
    }))
    .mutation(async ({ input }) => {
      await setConcurrency(input.level);
      return { success: true, concurrency: input.level };
    }),

  getConcurrency: settingsProcedure
    .query(async () => {
      const state = await db.getCoreLoopState();
      return { concurrency: state?.concurrency || 1 };
    }),

  // Notification Settings
  saveNotificationSettings: settingsProcedure
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
  saveOperationalLimits: settingsProcedure
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
  setInterval: settingsProcedure
    .input(z.object({
      intervalMs: z.number().min(60000).max(86400000),
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

      return {
        ...invite,
        token,
        registrationUrl,
      };
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
      const { getAdvertisingBalance, getCampaignMetrics } = await import('./services/advertising/growthEngine');
      const deploymentIds = Array.from(new Set(campaigns.map((c: any) => c.deploymentId)));
      const balances: Record<string, any> = {};
      for (const deploymentId of deploymentIds) {
        balances[deploymentId] = await getAdvertisingBalance(deploymentId);
      }
      const metrics: Record<string, any> = {};
      for (const campaign of campaigns) {
        metrics[campaign.id] = await getCampaignMetrics(campaign.id);
      }
      const campaignIds = campaigns.map((campaign: any) => campaign.id);
      const experiments = campaignIds.length
        ? await db.db.select().from(adExperiments).where(inArray(adExperiments.campaignId, campaignIds))
        : [];
      return { campaigns, totalBudget, totalSpent, activeCount, balances, metrics, experiments };
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
      const { buildAudienceResearch, storeAudienceResearch, getAdvertisingBalance, getAdvertisingAllocationPercentage } = await import('./services/advertising/growthEngine');
      const revenue = parseFloat(String(deployment.revenue || '0'));
      const { budget, percentageUsed } = calculateAdvertisingBudget(revenue);
      const analysis = await analyzeProject({
        deploymentId: deployment.id, knows: gap?.knows || '', needs: gap?.needs || '',
        controlsAccess: gap?.controlsAccess || '', underestimatesValue: gap?.underestimatesValue || '',
        businessPlan: deployment.businessPlan || '',
      });
      const audience = buildAudienceResearch(analysis);
      await storeAudienceResearch(deployment.id, audience);
      const balance = await getAdvertisingBalance(deployment.id);
      return {
        analysis,
        audience,
        balance,
        budget: {
          deploymentRevenue: revenue,
          advertisingRevenuePercentage: percentageUsed || getAdvertisingAllocationPercentage(),
          calculatedBudget: budget,
          availableAdvertisingFunds: balance.available,
        },
      };
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
      const { determineCampaignType } = await import('./services/advertising/budgetEngine');
      const {
        buildAudienceResearch,
        storeAudienceResearch,
        selectChannels,
        getAdvertisingBalance,
        hasApprovedPaidCampaign,
      } = await import('./services/advertising/growthEngine');
      const analysis = await analyzeProject({
        deploymentId: deployment.id, knows: gap?.knows || '', needs: gap?.needs || '',
        controlsAccess: gap?.controlsAccess || '', underestimatesValue: gap?.underestimatesValue || '',
        businessPlan: deployment.businessPlan || '',
      });
      const audience = buildAudienceResearch(analysis);
      await storeAudienceResearch(deployment.id, audience);
      const balance = await getAdvertisingBalance(deployment.id);
      const budget = balance.available;
      const percentageUsed = 20;
      const strategy = buildAdvertisingStrategy({ projectAnalysis: analysis, advertisingBudget: budget, percentageUsed });
      const campaignType = determineCampaignType(budget);
      const rankedChannels = selectChannels({ research: audience, strategy, availableBudget: balance.available });
      const channel = input.channel || rankedChannels[0]?.channel || (campaignType === 'PAID' ? 'google_ads' : 'organic_social');
      const isPaid = ['google_ads', 'meta_ads', 'tiktok_ads'].includes(channel);
      const finalType = isPaid ? 'PAID' : 'FREE_ORGANIC';
      const approvalStatus = finalType === 'PAID'
        ? (await hasApprovedPaidCampaign(deployment.id) ? 'APPROVED' : 'PENDING')
        : 'NOT_REQUIRED';
      const status = finalType === 'PAID' && approvalStatus !== 'APPROVED'
        ? 'READY_FOR_APPROVAL'
        : 'READY';
      const campaign = await db.createAdCampaign({
        deploymentId: deployment.id, name: `${analysis.appName.slice(0, 50)} - ${channel}`,
        channel,
        campaignType: finalType,
        status,
        objective: strategy.campaignObjectives[0],
        targetAudience: strategy.targetAudienceDescription,
        offer: strategy.valueProposition,
        callToAction: analysis.callsToAction[0] || 'Learn More',
        budget: budget.toFixed(2),
        dailyLimit: finalType === 'PAID' ? Math.max(0, Math.round((budget / 30) * 100) / 100).toFixed(2) : '0.00',
        approvalStatus,
        approvedSpendLimit: approvalStatus === 'APPROVED' ? budget.toFixed(2) : '0.00',
        strategy: JSON.stringify({ ...strategy, audience, rankedChannels }),
      });
      return { campaign, strategy, analysis, audience, rankedChannels, balance };
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
      const { canSpend, auditAdAction } = await import('./services/advertising/growthEngine');
      const channelBudget = parseFloat(String(campaign.budget || '0'));
      if (campaign.campaignType === 'PAID' && channelBudget <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot publish PAID campaign with zero budget.' });
      }
      if (campaign.campaignType === 'PAID') {
        const check = await canSpend({
          deploymentId: campaign.deploymentId,
          campaignId: campaign.id,
          requestedAmount: Math.min(channelBudget, Number(campaign.dailyLimit || channelBudget) || channelBudget),
        });
        if (!check.allowed) {
          await db.updateAdCampaign(campaign.id, {
            status: campaign.approvalStatus === 'PENDING' ? 'READY_FOR_APPROVAL' : 'WAITING_FOR_BUDGET',
            errorMessage: check.reason,
          } as any);
          await auditAdAction(campaign.deploymentId, campaign.id, 'Paid Campaign Activation Denied', check.reason);
          return { success: false, notConfigured: false, error: check.reason };
        }
      }
      const result = await publishCampaign({ name: campaign.name, deploymentId: campaign.deploymentId, budget: channelBudget, channel: campaign.channel as any });
      if (!result.success) {
        await db.updateAdCampaign(campaign.id, { status: result.notConfigured ? 'WAITING_FOR_CREDENTIALS' : 'FAILED', errorMessage: result.error } as any);
        return { success: false, notConfigured: result.notConfigured, error: result.error };
      }
      await db.updateAdCampaign(campaign.id, { status: 'ACTIVE', providerCampaignId: result.providerCampaignId || null, providerStatus: result.providerStatus || null, startedAt: new Date() } as any);
      return { success: true, notConfigured: false };
    }),

  balance: protectedProcedure
    .input(z.string())
    .query(async ({ input, ctx }) => {
      const deployment = await db.getDeploymentById(input);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this deployment.' });
      }
      const { getAdvertisingBalance } = await import('./services/advertising/growthEngine');
      return getAdvertisingBalance(input);
    }),

  recordEvent: adminProcedure
    .input(z.object({
      campaignId: z.string(),
      creativeId: z.string().nullable().optional(),
      eventType: z.enum(['impression', 'reach', 'click', 'conversion', 'spend', 'revenue']),
      quantity: z.number().min(1).default(1),
      amount: z.number().min(0).default(0),
      source: z.enum(['PROVIDER', 'INTERNAL', 'ESTIMATED']).default('INTERNAL'),
      attribution: z.enum(['DIRECT', 'ASSISTED', 'ESTIMATED', 'UNKNOWN']).default('UNKNOWN'),
      idempotencyKey: z.string().min(1),
      metadata: z.any().optional(),
    }))
    .mutation(async ({ input }) => {
      const campaign = await db.getAdCampaignById(input.campaignId);
      if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' });
      const { recordCampaignEvent } = await import('./services/advertising/growthEngine');
      return recordCampaignEvent(input as any);
    }),

  approve: adminProcedure
    .input(z.object({ campaignId: z.string(), approvedLimit: z.number().min(0), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const { approveCampaign } = await import('./services/advertising/growthEngine');
      await approveCampaign(input.campaignId, ctx.user.id, input.approvedLimit, input.reason);
      return { success: true };
    }),

  reject: adminProcedure
    .input(z.object({ campaignId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const { rejectCampaign } = await import('./services/advertising/growthEngine');
      await rejectCampaign(input.campaignId, ctx.user.id, input.reason);
      return { success: true };
    }),

  pause: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateAdCampaign(input, { status: 'PAUSED' } as any);
      return { success: true };
    }),

  resume: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateAdCampaign(input, { status: 'ACTIVE' } as any);
      return { success: true };
    }),

  stop: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      await db.updateAdCampaign(input, { status: 'STOPPED', endedAt: new Date() } as any);
      return { success: true };
    }),

  optimize: adminProcedure
    .input(z.string())
    .mutation(async ({ input }) => {
      const { optimizeCampaign } = await import('./services/advertising/growthEngine');
      return optimizeCampaign(input);
    }),

  createExperiment: adminProcedure
    .input(z.object({
      campaignId: z.string(),
      hypothesis: z.string().min(1),
      variable: z.string().min(1),
      controlCreativeId: z.string().nullable().optional(),
      variantACreativeId: z.string().nullable().optional(),
      variantBCreativeId: z.string().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const { createExperiment } = await import('./services/advertising/growthEngine');
      const id = await createExperiment(input as {
        campaignId: string;
        hypothesis: string;
        variable: string;
        controlCreativeId?: string | null;
        variantACreativeId?: string | null;
        variantBCreativeId?: string | null;
      });
      return { success: true, id };
    }),

  listExperiments: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .query(async ({ input, ctx }) => {
      const campaign = await db.getAdCampaignById(input.campaignId);
      if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' });
      const deployment = await db.getDeploymentById(campaign.deploymentId);
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found.' });
      if (ctx.user.role !== 'admin' && deployment.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this campaign.' });
      }
      return db.listExperimentsForCampaign(input.campaignId);
    }),

  startExperiment: adminProcedure
    .input(z.object({ experimentId: z.string() }))
    .mutation(async ({ input }) => {
      const { startExperiment } = await import('./services/advertising/growthEngine');
      const experiment = await startExperiment(input.experimentId);
      return { success: true, experiment };
    }),

  evaluateExperiment: adminProcedure
    .input(z.object({ experimentId: z.string(), minClicks: z.number().min(1).optional() }))
    .mutation(async ({ input }) => {
      const { evaluateExperiment } = await import('./services/advertising/growthEngine');
      return evaluateExperiment(input.experimentId, input.minClicks);
    }),

  stopExperiment: adminProcedure
    .input(z.object({ experimentId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { stopExperiment } = await import('./services/advertising/growthEngine');
      const experiment = await stopExperiment(input.experimentId, input.reason);
      return { success: true, experiment };
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
        credentialRequired: p.credentialRequired !== false,
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
      credential: z.string().optional(),
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
// LIFECYCLE INFRASTRUCTURE ROUTERS
// ==========================================
const evidenceRouter = router({
  list: protectedProcedure
    .input(z.object({
      gapId: z.string().optional(),
      deploymentId: z.string().optional(),
      provider: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().min(1).max(200).optional(),
      skip: z.number().min(0).optional(),
    }).optional())
    .query(({ input }) => infrastructure.listEvidence(input || {})),

  create: adminProcedure
    .input(z.object({
      gapId: z.string().nullable().optional(),
      deploymentId: z.string().nullable().optional(),
      businessSpecId: z.string().nullable().optional(),
      provider: z.string().min(1),
      sourceUrl: z.string().url().nullable().optional(),
      category: z.string().min(1),
      title: z.string().nullable().optional(),
      summary: z.string().min(1),
      content: z.string().nullable().optional(),
      geography: z.string().nullable().optional(),
      reportingPeriod: z.string().nullable().optional(),
      metadata: z.any().optional(),
      reliability: z.any().optional(),
      caveats: z.array(z.string()).optional(),
      status: z.string().optional(),
    }))
    .mutation(({ input }) => infrastructure.createEvidence(input as any)),

  recordProviderFailure: adminProcedure
    .input(z.object({
      gapId: z.string().nullable().optional(),
      provider: z.string().min(1),
      message: z.string().min(1),
      metadata: z.any().optional(),
    }))
    .mutation(({ input }) => infrastructure.recordEvidenceEvent({
      gapId: input.gapId || null,
      provider: input.provider,
      eventType: 'provider_unavailable',
      message: input.message,
      metadata: input.metadata,
    })),
});

const specificationsRouter = router({
  list: protectedProcedure
    .input(z.object({ gapId: z.string().optional(), deploymentId: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional())
    .query(({ input }) => infrastructure.listBusinessSpecifications(input || {})),

  get: protectedProcedure
    .input(z.string())
    .query(async ({ input }) => {
      const spec = await infrastructure.getBusinessSpecification(input);
      if (!spec) throw new TRPCError({ code: 'NOT_FOUND', message: 'Specification not found.' });
      return spec;
    }),

  createDraft: adminProcedure
    .input(z.object({
      gapId: z.string().nullable().optional(),
      deploymentId: z.string().nullable().optional(),
      title: z.string().min(1),
      legacyBusinessPlan: z.string().nullable().optional(),
      sections: z.record(z.any()).optional(),
    }))
    .mutation(({ input, ctx }) => infrastructure.createBusinessSpecification({ ...(input as any), createdBy: ctx.user.id })),

  createVersion: adminProcedure
    .input(z.object({
      specificationId: z.string(),
      sections: z.record(z.any()),
      changeSummary: z.string().optional(),
    }))
    .mutation(({ input, ctx }) => infrastructure.createBusinessSpecificationVersion({ ...(input as any), createdBy: ctx.user.id })),

  recordEvent: adminProcedure
    .input(z.object({
      specificationId: z.string(),
      versionId: z.string().nullable().optional(),
      eventType: z.enum(['change_request', 'conflict', 'clarification', 'decision']),
      title: z.string().min(1),
      detail: z.string().min(1),
      status: z.string().optional(),
      metadata: z.any().optional(),
    }))
    .mutation(({ input, ctx }) => infrastructure.recordSpecificationEvent({ ...(input as any), createdBy: ctx.user.id })),
});

const agentsRouter = router({
  list: protectedProcedure.query(() => infrastructure.listAgents()),
  ensureDefaults: adminProcedure.mutation(() => infrastructure.ensureDefaultAgents()),
  update: adminProcedure
    .input(z.object({
      id: z.string(),
      availability: z.string().optional(),
      capabilityJson: z.any().optional(),
      toolMetadataJson: z.any().optional(),
      healthStatus: z.string().optional(),
      implementationStatus: z.string().optional(),
    }))
    .mutation(({ input }) => infrastructure.updateAgent(input.id, input)),
  history: protectedProcedure
    .input(z.object({ agentId: z.string().optional(), taskId: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const rows = await db.db.select().from((await import('../drizzle/schema')).agentEvents)
        .where(input?.agentId ? eq((await import('../drizzle/schema')).agentEvents.agentId, input.agentId) : input?.taskId ? eq((await import('../drizzle/schema')).agentEvents.taskId, input.taskId) : undefined)
        .orderBy(sql`created_at desc`).limit(100);
      return rows;
    }),
});

const supervisorRouter = router({
  tasks: protectedProcedure
    .input(z.object({ state: z.string().optional(), agentId: z.string().optional(), deploymentId: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional())
    .query(({ input }) => infrastructure.listAgentTasks(input || {})),
  createTask: adminProcedure
    .input(z.object({
      agentId: z.string().nullable().optional(),
      parentTaskId: z.string().nullable().optional(),
      gapId: z.string().nullable().optional(),
      deploymentId: z.string().nullable().optional(),
      specificationId: z.string().nullable().optional(),
      buildProjectId: z.string().nullable().optional(),
      taskType: z.string().min(1),
      title: z.string().min(1),
      input: z.any().optional(),
      dependsOnTaskIds: z.array(z.string()).optional(),
    }))
    .mutation(({ input, ctx }) => infrastructure.createAgentTask({ ...(input as any), createdBy: ctx.user.id })),
  updateTaskState: adminProcedure
    .input(z.object({
      id: z.string(),
      state: z.enum(['pending', 'waiting_for_dependencies', 'ready', 'running', 'completed', 'failed', 'cancelled', 'blocked_by_policy']),
      output: z.any().optional(),
      errorMessage: z.string().nullable().optional(),
      recoveryCheckpoint: z.any().optional(),
    }))
    .mutation(({ input }) => infrastructure.updateAgentTaskState(input.id, input.state, input)),
});

const builderRouter = router({
  list: protectedProcedure.input(z.object({ deploymentId: z.string().optional(), status: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listBuildProjects(input || {})),
  get: protectedProcedure.input(z.string()).query(({ input }) => infrastructure.getBuildProject(input)),
  create: adminProcedure.input(z.object({ gapId: z.string().nullable().optional(), deploymentId: z.string().nullable().optional(), specificationId: z.string().nullable().optional(), projectType: z.string().optional(), architecture: z.any().optional() })).mutation(({ input }) => infrastructure.createBuildProject(input)),
  addArtifact: adminProcedure.input(z.object({ buildProjectId: z.string(), artifactType: z.string(), name: z.string(), uri: z.string().nullable().optional(), metadata: z.any().optional() })).mutation(({ input }) => infrastructure.addBuildArtifact(input as any)),
  addLog: adminProcedure.input(z.object({ buildProjectId: z.string(), level: z.string().optional(), message: z.string(), metadata: z.any().optional() })).mutation(({ input }) => infrastructure.addBuildLog(input as any)),
});

const qcRouter = router({
  list: protectedProcedure.input(z.object({ status: z.string().optional(), buildProjectId: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listQcJobs(input || {})),
  create: adminProcedure.input(z.object({ buildProjectId: z.string().nullable().optional(), artifactId: z.string().nullable().optional(), assignedAgentId: z.string().nullable().optional(), summary: z.string().nullable().optional() })).mutation(({ input }) => infrastructure.createQcJob(input)),
  recordTest: adminProcedure.input(z.object({ qcJobId: z.string(), suiteName: z.string(), testName: z.string(), status: z.string(), evidence: z.any().optional(), output: z.string().nullable().optional() })).mutation(({ input }) => infrastructure.recordQcTestRun(input as any)),
  createDefect: adminProcedure.input(z.object({ qcJobId: z.string().nullable().optional(), buildProjectId: z.string().nullable().optional(), severity: z.string().optional(), title: z.string(), detail: z.string() })).mutation(({ input }) => infrastructure.createDefectReport(input as any)),
});

const salesRouter = router({
  leads: protectedProcedure.input(z.object({ deploymentId: z.string().optional(), status: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listLeads(input || {})),
  createLead: adminProcedure.input(z.object({ deploymentId: z.string().nullable().optional(), source: z.string(), name: z.string().nullable().optional(), company: z.string().nullable().optional(), email: z.string().email().nullable().optional(), metadata: z.any().optional() })).mutation(({ input }) => infrastructure.createLead(input as any)),
  customers: protectedProcedure.input(z.object({ deploymentId: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listCustomers(input || {})),
  createCustomer: adminProcedure.input(z.object({ deploymentId: z.string().nullable().optional(), leadId: z.string().nullable().optional(), name: z.string().nullable().optional(), company: z.string().nullable().optional(), email: z.string().email().nullable().optional(), metadata: z.any().optional() })).mutation(({ input }) => infrastructure.createCustomer(input)),
  activities: protectedProcedure.input(z.object({ deploymentId: z.string().optional(), leadId: z.string().optional(), customerId: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listSalesActivities(input || {})),
  recordActivity: adminProcedure.input(z.object({ deploymentId: z.string().nullable().optional(), leadId: z.string().nullable().optional(), customerId: z.string().nullable().optional(), activityType: z.string(), status: z.string().optional(), notes: z.string().nullable().optional(), attribution: z.any().optional() })).mutation(({ input }) => infrastructure.recordSalesActivity(input as any)),
});

const financeRouter = router({
  transactions: protectedProcedure.input(z.object({ deploymentId: z.string().optional(), paymentId: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listRevenueTransactions(input || {})),
  recordTransaction: adminProcedure.input(z.object({ deploymentId: z.string().nullable().optional(), paymentId: z.string().nullable().optional(), customerId: z.string().nullable().optional(), accountId: z.string().nullable().optional(), transactionType: z.string(), amount: z.string(), currency: z.string().optional(), idempotencyKey: z.string(), metadata: z.any().optional() })).mutation(({ input }) => infrastructure.recordRevenueTransaction(input as any)),
  createAccount: adminProcedure.input(z.object({ deploymentId: z.string().nullable().optional(), accountType: z.string(), currency: z.string().optional() })).mutation(({ input }) => infrastructure.createRevenueAccount(input as any)),
  settlements: protectedProcedure.input(z.object({ deploymentId: z.string().optional(), status: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listSettlements(input || {})),
  createSettlement: adminProcedure.input(z.object({ deploymentId: z.string().nullable().optional(), revenueTransactionId: z.string().nullable().optional(), settlementType: z.string(), amount: z.string().optional(), currency: z.string().optional(), metadata: z.any().optional() })).mutation(({ input }) => infrastructure.createSettlementRecord(input as any)),
});

const lifecycleRouter = router({
  list: protectedProcedure.input(z.object({ deploymentId: z.string().optional(), state: z.string().optional(), limit: z.number().min(1).max(200).optional(), skip: z.number().min(0).optional() }).optional()).query(({ input }) => infrastructure.listLifecycleRecords(input || {})),
  create: adminProcedure.input(z.object({ deploymentId: z.string().nullable().optional(), gapId: z.string().nullable().optional(), state: z.string().optional() })).mutation(({ input }) => infrastructure.createLifecycleRecord(input)),
  recordEvent: adminProcedure.input(z.object({ lifecycleId: z.string(), eventType: z.string(), status: z.string().optional(), detail: z.string(), metadata: z.any().optional() })).mutation(({ input }) => infrastructure.recordLifecycleEvent(input as any)),
});

const infrastructureRouter = router({
  overview: protectedProcedure.query(() => infrastructure.getInfrastructureOverview()),
  businessTrace: protectedProcedure.input(z.object({ gapId: z.string().optional(), deploymentId: z.string().optional() })).query(({ input }) => infrastructure.getBusinessTrace(input)),
});

// ==========================================
// ROOT ROUTER
// ==========================================
export const appRouter = router({
  operations: operationsRouter,
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
  evidence: evidenceRouter,
  specifications: specificationsRouter,
  agents: agentsRouter,
  supervisor: supervisorRouter,
  builder: builderRouter,
  qc: qcRouter,
  sales: salesRouter,
  finance: financeRouter,
  lifecycle: lifecycleRouter,
  infrastructure: infrastructureRouter,
});

export type AppRouter = typeof appRouter;
