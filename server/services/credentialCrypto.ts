// ============================================================
// CREDENTIAL ENCRYPTION
// ============================================================
// AES-256-GCM encryption for stored provider credentials. The key is
// derived from CREDENTIAL_ENCRYPTION_KEY, falling back to JWT_SECRET so
// existing deployments work without a new env var. Secrets are never
// logged or returned to clients.
// ============================================================

import crypto from 'crypto';

function getKey(): Buffer {
  const raw =
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'sao-insecure-default-key-change-me';
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptCredential(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // iv (12) + tag (16) + ciphertext, base64-encoded.
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptCredential(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Redact a secret for display/audit. Keeps only the last 4 characters.
 */
export function redactCredential(plaintext: string): string {
  if (!plaintext) return '';
  if (plaintext.length <= 4) return '••••';
  return '••••••••••••' + plaintext.slice(-4);
}
