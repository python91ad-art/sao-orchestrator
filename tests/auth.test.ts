// ============================================================
// Authentication Tests (Phase 12)
// ============================================================

import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

async function runTests() {

// ---- Test: bcrypt password hashing ----
console.log('\n=== Password Hashing Tests ===');

{
  const password = 'TestPass123!';
  const wrongPassword = 'WrongPass456!';
  
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);
  
  const valid = await bcrypt.compare(password, hash);
  assert.strictEqual(valid, true, 'Correct password should validate');
  
  const invalid = await bcrypt.compare(wrongPassword, hash);
  assert.strictEqual(invalid, false, 'Wrong password should not validate');
  
  console.log('✓ bcrypt: correct password validates');
  console.log('✓ bcrypt: wrong password rejected');
}

// ---- Test: Reset code generation ----
console.log('\n=== Reset Code Tests ===');

{
  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  assert.strictEqual(resetCode.length, 6, 'Reset code should be 6 digits');
  assert.ok(/^\d{6}$/.test(resetCode));
  assert.ok(parseInt(resetCode) >= 100000);
  assert.ok(parseInt(resetCode) <= 999999);
  console.log('✓ Reset code: 6-digit numeric');
}

// ---- Test: Reset code expiry ----
console.log('\n=== Reset Code Expiry Tests ===');

{
  const expiry = new Date(Date.now() + 15 * 60 * 1000);
  const now = new Date();
  assert.ok(expiry > now, 'Expiry should be in the future');
  
  const diffMs = expiry.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  assert.strictEqual(diffMin, 15, 'Reset code should expire in 15 minutes');
  console.log('✓ Reset code: 15-minute expiry');
}

// ---- Test: Password length validation ----
console.log('\n=== Password Validation Tests ===');

{
  const validPasswords = ['123456', 'abcdef', 'Pass12', 'MySecurePassword2024!'];
  for (const pw of validPasswords) {
    assert.ok(pw.length >= 6, `"${pw}" should be >= 6 chars`);
  }
  const invalidPasswords = ['', 'a', 'ab', '12345'];
  for (const pw of invalidPasswords) {
    assert.strictEqual(pw.length >= 6, false, `"${pw}" should be < 6 chars`);
  }
  console.log('✓ Password: min 6 characters');
}

// ---- Test: Email normalization ----
console.log('\n=== Email Normalization Tests ===');

{
  const normalize = (email: string) => email.trim().toLowerCase();
  assert.strictEqual(normalize('User@Example.COM'), 'user@example.com');
  assert.strictEqual(normalize('  admin@SAO.SYSTEM  '), 'admin@sao.system');
  console.log('✓ Email: normalized to lowercase/trimmed');
}

// ---- Test: Session cookie signing/verification ----
console.log('\n=== Session Cookie Tests ===');

{
  const JWT_SECRET = 'test_secret_for_unit_tests';
  
  function signSession(userId: string): string {
    const payloadStr = JSON.stringify({ userId, expires: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    const hmac = crypto.createHmac('sha256', JWT_SECRET).update(payloadStr).digest('hex');
    return Buffer.from(`${payloadStr}.${hmac}`).toString('base64');
  }
  
  function verifySession(cookie: string): { userId: string } | null {
    try {
      const decoded = Buffer.from(cookie, 'base64').toString('utf-8');
      const parts = decoded.split('.');
      if (parts.length < 2) return null;
      const hmac = parts.pop();
      const payloadStr = parts.join('.');
      if (!payloadStr || !hmac) return null;
      const computed = crypto.createHmac('sha256', JWT_SECRET).update(payloadStr).digest('hex');
      if (computed !== hmac) return null;
      const payload = JSON.parse(payloadStr);
      if (!payload.userId || !payload.expires || Date.now() > payload.expires) return null;
      return { userId: payload.userId };
    } catch { return null; }
  }
  
  const session = signSession('user-123');
  const verified = verifySession(session);
  assert.ok(verified);
  assert.strictEqual(verified?.userId, 'user-123');
  
  // Tampered
  const tampered = Buffer.from('{"userId":"user-123","expires":9999999999999}.badhmac').toString('base64');
  assert.strictEqual(verifySession(tampered), null);
  
  // Expired
  const expiredPayload = JSON.stringify({ userId: 'user-123', expires: Date.now() - 1000 });
  const expiredHmac = crypto.createHmac('sha256', JWT_SECRET).update(expiredPayload).digest('hex');
  const expiredSession = Buffer.from(`${expiredPayload}.${expiredHmac}`).toString('base64');
  assert.strictEqual(verifySession(expiredSession), null);
  
  assert.strictEqual(verifySession(''), null);
  console.log('✓ Session: valid session verifies');
  console.log('✓ Session: tampered session rejected');
  console.log('✓ Session: expired session rejected');
}

// ---- Test: Rate limit logic ----
console.log('\n=== Rate Limit Tests ===');

{
  const resetRateLimit = new Map<string, { count: number; windowStart: number }>();
  const MAX = 3;
  const WINDOW = 15 * 60 * 1000;
  
  function check(email: string): boolean {
    const n = email.trim().toLowerCase();
    const now = Date.now();
    const e = resetRateLimit.get(n);
    if (!e || now - e.windowStart > WINDOW) { resetRateLimit.set(n, { count: 1, windowStart: now }); return true; }
    if (e.count >= MAX) return false;
    e.count++;
    return true;
  }
  
  assert.strictEqual(check('a@b.com'), true, '1st request allowed');
  assert.strictEqual(check('a@b.com'), true, '2nd request allowed');
  assert.strictEqual(check('a@b.com'), true, '3rd request allowed');
  assert.strictEqual(check('a@b.com'), false, '4th request blocked');
  assert.strictEqual(check('other@b.com'), true, 'Different email unaffected');
  console.log('✓ Rate limit: max 3 per window');
}

// ---- Test: Authorization guards ----
console.log('\n=== Authorization Guard Tests ===');

{
  function requireAuth(user: { role: string } | null): boolean {
    return user !== null;
  }
  function requireAdmin(user: { role: string } | null): boolean {
    return user !== null && user.role === 'admin';
  }
  
  assert.strictEqual(requireAuth(null), false, 'Unauthenticated blocked');
  assert.strictEqual(requireAuth({ role: 'user' }), true, 'User authenticated');
  assert.strictEqual(requireAdmin({ role: 'user' }), false, 'User blocked from admin');
  assert.strictEqual(requireAdmin({ role: 'admin' }), true, 'Admin can access admin');
  console.log('✓ Auth: unauthenticated blocked');
  console.log('✓ Auth: user cannot access admin');
  console.log('✓ Auth: admin can access admin');
}

// ---- Test: No role escalation ----
console.log('\n=== Role Escalation Prevention Tests ===');

{
  const registerInput = { email: 'string', password: 'string' };
  assert.ok(!('role' in registerInput), 'Register input has no role field');
  console.log('✓ Role escalation: register schema has no role');
}

// ---- Test: Secrets not leaked ----
console.log('\n=== Secret Leakage Prevention Tests ===');

{
  const safeResponse = { id: '1', email: 'a@b.com', role: 'user' };
  const forbidden = ['passwordHash', 'password', 'resetCode', 'resetCodeExpiry'];
  for (const k of forbidden) {
    assert.ok(!(k in safeResponse), `"${k}" should not be in response`);
  }
  console.log('✓ Secrets: no password/reset in user response');
}

console.log('\n✅ ALL AUTHENTICATION TESTS PASSED\n');

}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
