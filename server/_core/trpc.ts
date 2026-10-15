import { initTRPC, TRPCError } from '@trpc/server';
import { Request, Response } from 'express';
import { users } from '../../drizzle/schema';

export type UserType = typeof users.$inferSelect;

export interface Context {
  user: UserType | null;
  req: Request;
  res: Response;
  agent?: import('../services/execution').ExecutionContext;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const agentProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.agent) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Verified scoped agent identity required.' });
  return next({ ctx: { ...ctx, agent: ctx.agent } });
});

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to perform this action.',
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to perform this action.',
    });
  }
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must be an admin to perform this action.',
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});
