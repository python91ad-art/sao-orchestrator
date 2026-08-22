import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { db, generateId } from '../db';
import { credentialAuditLogs, integrationCredentials } from '../../drizzle/schema';
import { decryptCredential, encryptCredential } from './credentialEncryption';

export const credentialServices = [
  'groq',
  'google-search',
  'google-search-cx',
  'github',
  'stripe',
  'resend',
  'slack',
  'tavily',
] as const;

export type CredentialService = typeof credentialServices[number];

export type PublicCredentialService =
  | 'groq'
  | 'google-search'
  | 'github'
  | 'stripe'
  | 'resend'
  | 'slack'
  | 'tavily';

export interface CredentialStatus {
  service: PublicCredentialService;
  configured: boolean;
  enabled: boolean;
  updatedAt: string | null;
}

export interface CredentialAuditInput {
  userId?: string | null;
  service: PublicCredentialService;
  operation:
    | 'credential.created'
    | 'credential.updated'
    | 'credential.removed'
    | 'credential.enabled'
    | 'credential.disabled'
    | 'credential.tested';
  success: boolean;
  message?: string;
}

const MAX_CREDENTIAL_LENGTH = 8192;
const ENCRYPTION_VERSION = 1;

const envFallbacks: Record<CredentialService, string> = {
  groq: 'GROQ_API_KEY',
  'google-search': 'GOOGLE_SEARCH_API_KEY',
  'google-search-cx': 'GOOGLE_SEARCH_CX',
  github: 'GITHUB_TOKEN',
  stripe: 'STRIPE_SECRET_KEY',
  resend: 'RESEND_API_KEY',
  slack: 'SLACK_BOT_TOKEN',
  tavily: 'TAVILY_API_KEY',
};

const publicServices: PublicCredentialService[] = [
  'groq',
  'google-search',
  'github',
  'stripe',
  'resend',
  'slack',
  'tavily',
];

function isCredentialService(service: string): service is CredentialService {
  return (credentialServices as readonly string[]).includes(service);
}

function isPublicCredentialService(service: string): service is PublicCredentialService {
  return (publicServices as readonly string[]).includes(service);
}

async function getCredentialRow(service: CredentialService) {
  const rows = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.service, service))
    .limit(1);

  return rows[0] || null;
}

async function getEnabledDatabaseCredential(service: CredentialService): Promise<string | null> {
  const row = await getCredentialRow(service);

  if (!row || !row.enabled) {
    return null;
  }

  return decryptCredential(row.encryptedValue);
}

export async function getCredential(service: CredentialService): Promise<string | null> {
  if (!isCredentialService(service)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported credential service.' });
  }

  const databaseCredential = await getEnabledDatabaseCredential(service);
  if (databaseCredential) {
    return databaseCredential;
  }

  const fallback = process.env[envFallbacks[service]];
  return fallback && fallback.trim() ? fallback : null;
}

export async function hasCredential(service: CredentialService): Promise<boolean> {
  return !!(await getCredential(service));
}

export async function setCredential(service: CredentialService, value: string): Promise<void> {
  if (!isCredentialService(service)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported credential service.' });
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CREDENTIAL_LENGTH) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Credential value is invalid.' });
  }

  const encryptedValue = encryptCredential(trimmed);
  const existing = await getCredentialRow(service);
  const now = new Date();

  if (existing) {
    await db
      .update(integrationCredentials)
      .set({
        encryptedValue,
        encryptionVersion: ENCRYPTION_VERSION,
        enabled: true,
        updatedAt: now,
      })
      .where(eq(integrationCredentials.service, service));
    return;
  }

  await db.insert(integrationCredentials).values({
    id: generateId(),
    service,
    encryptedValue,
    encryptionVersion: ENCRYPTION_VERSION,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

export async function removeCredential(service: CredentialService): Promise<void> {
  await db
    .delete(integrationCredentials)
    .where(eq(integrationCredentials.service, service));
}

export async function enableCredential(service: CredentialService): Promise<void> {
  await db
    .update(integrationCredentials)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(integrationCredentials.service, service));
}

export async function disableCredential(service: CredentialService): Promise<void> {
  await db
    .update(integrationCredentials)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(integrationCredentials.service, service));
}

export async function listCredentialStatus(): Promise<CredentialStatus[]> {
  const rows = await db.select().from(integrationCredentials);
  const byService = new Map(rows.map(row => [row.service, row]));

  return publicServices.map((service) => {
    const services = service === 'google-search'
      ? ['google-search', 'google-search-cx'] as CredentialService[]
      : [service] as CredentialService[];
    const dbRows = services.map(s => byService.get(s));
    const allConfigured = services.every(s => {
      const fallback = process.env[envFallbacks[s]];
      return !!byService.get(s) || !!fallback?.trim();
    });
    const allEnabled = services.every(s => {
      const row = byService.get(s);
      const fallback = process.env[envFallbacks[s]];
      return row ? row.enabled : !!fallback?.trim();
    });
    const latestUpdatedAt = dbRows
      .map(row => row?.updatedAt?.getTime() || 0)
      .reduce((latest, value) => Math.max(latest, value), 0);

    return {
      service,
      configured: allConfigured,
      enabled: allConfigured ? allEnabled : false,
      updatedAt: latestUpdatedAt ? new Date(latestUpdatedAt).toISOString() : null,
    };
  });
}

export async function setPublicCredential(
  service: PublicCredentialService,
  value: string,
  secondaryValue?: string
): Promise<'created' | 'updated'> {
  if (!isPublicCredentialService(service)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported credential service.' });
  }

  const before = service === 'google-search'
    ? await getCredentialRow('google-search')
    : await getCredentialRow(service);

  if (service === 'google-search') {
    if (!secondaryValue?.trim()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Google Search CX is required.' });
    }
    await setCredential('google-search', value);
    await setCredential('google-search-cx', secondaryValue);
  } else {
    await setCredential(service, value);
  }

  return before ? 'updated' : 'created';
}

export async function removePublicCredential(service: PublicCredentialService): Promise<void> {
  if (service === 'google-search') {
    await db
      .delete(integrationCredentials)
      .where(eq(integrationCredentials.service, 'google-search'));
    await db
      .delete(integrationCredentials)
      .where(eq(integrationCredentials.service, 'google-search-cx'));
    return;
  }

  await removeCredential(service);
}

export async function setPublicCredentialEnabled(service: PublicCredentialService, enabled: boolean): Promise<void> {
  const services = service === 'google-search'
    ? ['google-search', 'google-search-cx'] as CredentialService[]
    : [service] as CredentialService[];

  for (const item of services) {
    if (enabled) {
      await enableCredential(item);
    } else {
      await disableCredential(item);
    }
  }
}

export async function recordCredentialAudit(input: CredentialAuditInput): Promise<void> {
  await db.insert(credentialAuditLogs).values({
    id: generateId(),
    userId: input.userId || null,
    service: input.service,
    operation: input.operation,
    success: input.success,
    message: input.message ? input.message.slice(0, 255) : null,
  });
}

export async function resolveGoogleSearchCredentials(): Promise<{ apiKey: string | null; cx: string | null }> {
  const [apiKey, cx] = await Promise.all([
    getCredential('google-search'),
    getCredential('google-search-cx'),
  ]);

  return { apiKey, cx };
}
