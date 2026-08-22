import crypto from 'crypto';
import { TRPCError } from '@trpc/server';

const ENCRYPTION_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_CREDENTIAL_LENGTH = 8192;

function getMasterKey(): Buffer {
  const raw = process.env.SAO_CREDENTIAL_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error('SAO_CREDENTIAL_ENCRYPTION_KEY is required to manage database credentials.');
  }

  const trimmed = raw.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (decoded.length !== 32) {
    throw new Error('SAO_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }

  return decoded;
}

export function validateCredentialEncryptionKeyForStartup(): void {
  if (!process.env.SAO_CREDENTIAL_ENCRYPTION_KEY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SAO_CREDENTIAL_ENCRYPTION_KEY is required in production.');
    }
    return;
  }

  getMasterKey();
}

export function encryptCredential(plaintext: string): string {
  if (!plaintext || plaintext.length > MAX_CREDENTIAL_LENGTH) {
    throw new Error('Credential value is invalid.');
  }

  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: ENCRYPTION_VERSION,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64'),
  });
}

export function decryptCredential(encryptedValue: string): string {
  try {
    const payload = JSON.parse(encryptedValue) as {
      v?: number;
      alg?: string;
      iv?: string;
      tag?: string;
      ct?: string;
    };

    if (
      payload.v !== ENCRYPTION_VERSION ||
      payload.alg !== ALGORITHM ||
      !payload.iv ||
      !payload.tag ||
      !payload.ct
    ) {
      throw new Error('Unsupported credential payload.');
    }

    const key = getMasterKey();
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, 'base64'),
      { authTagLength: AUTH_TAG_BYTES }
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(payload.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Stored credential could not be decrypted.',
    });
  }
}
