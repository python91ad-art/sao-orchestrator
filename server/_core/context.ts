import { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { verifySession, COOKIE_NAME } from './cookies';
import { getUserById } from '../db';
import { Context } from './trpc';

export async function createContext({ req, res }: CreateExpressContextOptions): Promise<Context> {
  let user = null;
  const authorization = req.headers.authorization;
  const bearerToken =
    authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;

  const sessionCookie =
    req.cookies?.[COOKIE_NAME] || bearerToken;

  if (sessionCookie) {
    const verified = verifySession(sessionCookie);
    if (verified) {
      try {
        user = await getUserById(verified.userId);
      } catch (err) {
        console.error('Error fetching user in context:', err);
      }
    }
  }

  return {
    user,
    req,
    res,
  };
}
