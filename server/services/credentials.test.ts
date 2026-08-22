import assert from 'node:assert/strict';
import {
  decryptCredential,
  encryptCredential,
  validateCredentialEncryptionKeyForStartup,
} from './credentialEncryption';

const originalKey = process.env.SAO_CREDENTIAL_ENCRYPTION_KEY;
const originalNodeEnv = process.env.NODE_ENV;

function setKey(value: string | undefined) {
  if (value === undefined) {
    delete process.env.SAO_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.SAO_CREDENTIAL_ENCRYPTION_KEY = value;
  }
}

async function run() {
  const key = Buffer.alloc(32, 7).toString('base64');
  const wrongKey = Buffer.alloc(32, 8).toString('base64');
  const secret = 'test-secret-value';

  setKey(key);
  const encrypted = encryptCredential(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptCredential(encrypted), secret);

  setKey(wrongKey);
  assert.throws(() => decryptCredential(encrypted), /Stored credential could not be decrypted/);

  setKey(key);
  const tampered = JSON.parse(encrypted);
  tampered.ct = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptCredential(JSON.stringify(tampered)), /Stored credential could not be decrypted/);

  setKey(Buffer.alloc(16, 1).toString('base64'));
  assert.throws(() => validateCredentialEncryptionKeyForStartup(), /exactly 32 bytes/);

  process.env.NODE_ENV = 'production';
  setKey(undefined);
  assert.throws(() => validateCredentialEncryptionKeyForStartup(), /required in production/);
}

run()
  .finally(() => {
    process.env.NODE_ENV = originalNodeEnv;
    setKey(originalKey);
  })
  .then(() => {
    console.log('Credential encryption tests passed.');
  })
  .catch((error) => {
    console.error('Credential encryption tests failed.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
