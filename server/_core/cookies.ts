import crypto from 'crypto';

export const COOKIE_NAME = 'sao_session';
// JWT_SECRET is required in production — session cookies are HMAC-signed with it.
// A hardcoded fallback is only acceptable for local development, never production,
// because the fallback value would be publicly known.
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? (() => {
        throw new Error(
          'JWT_SECRET is required in production. Set JWT_SECRET to a cryptographically random secret (e.g. openssl rand -hex 32).'
        );
      })()
    : 'sao_default_super_secret_key_1234567890_orchestrator');

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export function signSession(userId: string): string {
  const payloadStr = JSON.stringify({
    userId,
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  });
  
  const hmac = crypto.createHmac('sha256', JWT_SECRET).update(payloadStr).digest('hex');
  const combined = `${payloadStr}.${hmac}`;
  return Buffer.from(combined).toString('base64');
}

export function verifySession(cookie: string): { userId: string } | null {
  try {
    const decoded = Buffer.from(cookie, 'base64').toString('utf-8');
    const parts = decoded.split('.');
    if (parts.length < 2) return null;
    
    // In case the JSON payload contains '.' we need to rejoin all parts except the last one
    const hmac = parts.pop();
    const payloadStr = parts.join('.');
    
    if (!payloadStr || !hmac) return null;
    
    const computedHmac = crypto.createHmac('sha256', JWT_SECRET).update(payloadStr).digest('hex');
    if (computedHmac !== hmac) return null;
    
    const payload = JSON.parse(payloadStr);
    if (!payload.userId || !payload.expires) return null;
    if (Date.now() > payload.expires) return null;
    
    return { userId: payload.userId };
  } catch (error) {
    console.error('Session verification error:', error);
    return null;
  }
}
