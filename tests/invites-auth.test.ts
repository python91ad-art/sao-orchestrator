// ============================================================
// INVITATIONS & AUTHENTICATION TESTS
// Tests token generation, SHA-256 hashing, invitation validation,
// expiration, single-use enforcement, and registration contracts.
// ============================================================

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const results: { name: string; pass: boolean; detail?: string }[] = [];

function record(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Schemas mirrored from authRouter and invitesRouter
const validateInviteInputSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i),
});

const registerInputSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i),
  password: z.string().min(6),
});

const createInviteInputSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'user']).default('user'),
  expiresAt: z.string().datetime().optional(),
});

async function main() {
  console.log('\n=== Invitations & Registration Authentication Tests ===\n');

  // --- 1. Token Generation & Hash Derivation ---
  console.log('--- 1. Token Cryptographic Integrity ---');
  {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    record('Raw token is 64 hex characters (256 bits)', rawToken.length === 64 && /^[a-f0-9]{64}$/i.test(rawToken));
    record('Token hash is 64 hex characters SHA-256', tokenHash.length === 64 && /^[a-f0-9]{64}$/i.test(tokenHash));
    record('Token hash does not reveal raw token bytes', tokenHash !== rawToken);

    // Validation input passes schema
    record('Valid raw token matches validateInvite schema', validateInviteInputSchema.safeParse({ token: rawToken }).success);
    record('Malformed token rejected by validateInvite schema', !validateInviteInputSchema.safeParse({ token: 'short-token' }).success);
    record('Non-hex token rejected by validateInvite schema', !validateInviteInputSchema.safeParse({ token: 'z'.repeat(64) }).success);
  }

  // --- 2. Invitation State Machine & Validation Logic ---
  console.log('\n--- 2. Invitation Lifecycle Validation ---');
  {
    interface MockInvite {
      id: string;
      email: string;
      role: 'admin' | 'user';
      tokenHash: string;
      expiresAt: Date | null;
      usedAt: Date | null;
    }

    const testToken = crypto.randomBytes(32).toString('hex');
    const testHash = crypto.createHash('sha256').update(testToken).digest('hex');

    const validInvite: MockInvite = {
      id: 'inv_1',
      email: 'user@example.com',
      role: 'user',
      tokenHash: testHash,
      expiresAt: new Date(Date.now() + 86400000), // +24h
      usedAt: null,
    };

    function validateInvite(invite: MockInvite | null, token: string) {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      if (!invite || invite.tokenHash !== hash) {
        return { valid: false, error: 'Invalid or expired invitation.' };
      }
      if (invite.usedAt) {
        return { valid: false, error: 'This invitation has already been used.' };
      }
      if (invite.expiresAt && new Date() > invite.expiresAt) {
        return { valid: false, error: 'This invitation has expired.' };
      }
      return { valid: true, email: invite.email, role: invite.role };
    }

    record('Valid invite returns valid: true with email and role', validateInvite(validInvite, testToken).valid === true);

    // Invalid token
    record('Wrong token hash returns invalid', validateInvite(validInvite, crypto.randomBytes(32).toString('hex')).valid === false);

    // Already used invite
    const usedInvite: MockInvite = { ...validInvite, usedAt: new Date() };
    const usedResult = validateInvite(usedInvite, testToken);
    record('Used invite is rejected with specific message', usedResult.valid === false && usedResult.error === 'This invitation has already been used.');

    // Expired invite
    const expiredInvite: MockInvite = { ...validInvite, expiresAt: new Date(Date.now() - 1000) };
    const expiredResult = validateInvite(expiredInvite, testToken);
    record('Expired invite is rejected with specific message', expiredResult.valid === false && expiredResult.error === 'This invitation has expired.');
  }

  // --- 3. Registration Contracts & Password Security ---
  console.log('\n--- 3. Registration Payload & Hashing ---');
  {
    const validReg = {
      token: crypto.randomBytes(32).toString('hex'),
      password: 'StrongPassword123!',
    };
    record('Valid registration payload accepted', registerInputSchema.safeParse(validReg).success);

    // Short password
    record('Password < 6 characters rejected', !registerInputSchema.safeParse({ ...validReg, password: '123' }).success);

    // Bcrypt hashing roundtrip
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(validReg.password, salt);
    record('Bcrypt hash verifies valid password', await bcrypt.compare(validReg.password, hash));
    record('Bcrypt hash rejects incorrect password', !(await bcrypt.compare('WrongPassword', hash)));
  }

  // --- 4. Admin Invite Creation Schema ---
  console.log('\n--- 4. Admin Invite Creation Schema ---');
  {
    record('Valid invite input passes', createInviteInputSchema.safeParse({ email: 'newadmin@sao.local', role: 'admin' }).success);
    record('Invalid email rejected', !createInviteInputSchema.safeParse({ email: 'invalid-email', role: 'user' }).success);
    record('Invalid role rejected', !createInviteInputSchema.safeParse({ email: 'user@sao.local', role: 'superadmin' }).success);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
