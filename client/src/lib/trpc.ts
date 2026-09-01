import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter as ServerAppRouter } from "../../../server/routers";

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface Gap {
  id: string;
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
  status: 'pending' | 'processing' | 'safe' | 'unsafe' | 'gray' | 'false' | 'deployed' | 'failed';
  priority: number;
  createdAt: string;
}

export interface QueueItem {
  id: string;
  gapId: string;
  status: 'pending' | 'processing' | 'paused' | 'completed' | 'failed';
  queueType: 'synthesis' | 'deployment' | 'audit' | 'maintenance';
  workerId?: string | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  sortOrder: number;
  dedupHash: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  gap?: Gap;
}

export interface Deployment {
  id: string;
  gapId: string;
  status: 'active' | 'paused' | 'stopped';
  businessPlan: string;
  revenue: number;
  costPerDay: number;
  banRisk: 'low' | 'medium' | 'high';
  health: 'healthy' | 'warning' | 'critical';
  createdAt: string;
}

export interface DeploymentProvider {
  id: string;
  deploymentId: string;
  providerType: 'vercel' | 'mollie';
  providerConfig: Record<string, unknown>;
  deploymentUrl: string | null;
  status: 'pending' | 'active' | 'failed' | 'superseded';
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  deploymentId: string;
  providerType: string;
  amount: string;
  currency: string;
  status: 'pending' | 'confirming' | 'confirmed' | 'paid' | 'failed' | 'canceled' | 'expired' | 'authorized' | 'unknown';
  checkoutUrl: string | null;
  cryptoAmount: string | null;
  cryptoCurrency: string | null;
  cryptoNetwork: string | null;
  paymentAddress: string | null;
  transactionHash: string | null;
  providerStatus: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}


export interface AdCampaign {
  id: string;
  deploymentId: string;
  name: string;
  channel: string;
  status: string;
  campaignType: 'PAID' | 'FREE_ORGANIC';
  budget: string;
  spent: string;
  strategy: string | null;
  providerCampaignId: string | null;
  providerStatus: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  createdAt: string;
}

export interface AdCreative {
  id: string;
  campaignId: string;
  format: string;
  content: string;
  headline: string | null;
  callToAction: string | null;
  targetAudience: string | null;
  variation: number;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  decision: 'allow' | 'block' | 'review';
  gapId?: string;
  deploymentId?: string;
  banRisk: 'low' | 'medium' | 'high';
  businessHealth: 'healthy' | 'warning' | 'critical' | null;
  explanation: string;
  reasoning: string;
}

export interface Policy {
  id: string;
  ruleText: string;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface CoreLoopStatus {
  running: boolean;
  intervalMs: number;
  lastRun?: string;
}

export interface Stats {
  totalGaps: number;
  activeDeployments: number;
  queueItems: number;
  totalRevenue: number;
}

export interface IntegrationTestResult {
  success: boolean;
  message: string;
  storeName?: string;
  url?: string;
  user?: { username: string; email: string };
}

// ==========================================
// APP ROUTER TYPE
// ==========================================

export type AppRouter = {
  auth: {
    me: { query: () => Promise<{ email: string; name: string } | null> };
    login: { mutate: (input: any) => Promise<{ token: string; user: { email: string; name: string } }> };
    register: { mutate: (input: any) => Promise<{ token: string; user: { email: string; name: string } }> };
    logout: { mutate: () => Promise<void> };
    requestReset: { mutate: (input: { email: string }) => Promise<{ success: boolean }> };
    resetPassword: { mutate: (input: any) => Promise<{ success: boolean }> };
  };
  gaps: {
    list: { query: (input?: { limit?: number; skip?: number }) => Promise<Gap[]> };
    create: { mutate: (input: { knows: string; needs: string; controlsAccess: string; underestimatesValue: string; source: string; priority: number }) => Promise<Gap> };
    retry: { mutate: (input: { id: string }) => Promise<void> };
  };
  queue: {
    list: { query: () => Promise<QueueItem[]> };
    moveUp: { mutate: (input: string) => Promise<{ success: boolean }> };
    moveDown: { mutate: (input: string) => Promise<{ success: boolean }> };
    pause: { mutate: (input: string) => Promise<{ success: boolean }> };
    resume: { mutate: (input: string) => Promise<{ success: boolean }> };
    delete: { mutate: (input: string) => Promise<{ success: boolean }> };
    retry: { mutate: (input: string) => Promise<{ success: boolean }> };
    updatePriority: { mutate: (input: { id: string; priority: number }) => Promise<{ success: boolean }> };
    stats: { query: () => Promise<any> };
  };
  deployments: {
    list: { query: () => Promise<Deployment[]> };
    get: { query: (input: string) => Promise<Deployment> };
    pause: { mutate: (input: string) => Promise<{ success: boolean }> };
    resume: { mutate: (input: string) => Promise<{ success: boolean }> };
    stop: { mutate: (input: string) => Promise<{ success: boolean }> };
    stopAll: { mutate: () => Promise<{ success: boolean }> };
    resumeAll: { mutate: () => Promise<{ success: boolean }> };
    audit: { mutate: (input: string) => Promise<{ success: boolean }> };
    stats: { query: () => Promise<any> };
    listProviders: { query: (input: string) => Promise<DeploymentProvider[]> };
    getDeploymentUrl: { query: (input: string) => Promise<{ deploymentUrl: string | null }> };
  };
  audit: {
    list: { query: (input?: { limit?: number; skip?: number }) => Promise<AuditLog[]> };
  };
  policies: {
    list: { query: () => Promise<Policy[]> };
    create: { mutate: (input: { ruleText: string }) => Promise<Policy> };
    acknowledge: { mutate: (input: { id: string }) => Promise<void> };
    delete: { mutate: (input: { id: string }) => Promise<void> };
  };
  coreLoop: {
    status: { query: () => Promise<CoreLoopStatus> };
    start: { mutate: () => Promise<void> };
    stop: { mutate: () => Promise<void> };
    runOnce: { mutate: () => Promise<void> };
    runAudit: { mutate: () => Promise<void> };
    updateInterval: { mutate: (input: { intervalMs: number }) => Promise<void> };
  };
  stats: {
    get: { query: () => Promise<Stats> };
  };
  analytics: {
    overview: { query: () => Promise<any> };
    revenueHistory: { query: () => Promise<any> };
  };
  settings: {
    save: { mutate: (input: any) => Promise<void> };
    testConnection: { mutate: (input: { service: string }) => Promise<any> };
    retryConfig: { mutate: (input: { maxAttempts: number; backoffMultiplier: number; baseDelayMs: number }) => Promise<{ success: boolean }> };
    getRetryConfig: { query: () => Promise<{ maxAttempts: number; backoffMultiplier: number; baseDelayMs: number }> };
    queueLimits: { mutate: (input: { maxSize: number; expirationHours: number }) => Promise<{ success: boolean }> };
    getQueueLimits: { query: () => Promise<{ maxSize: number; expirationHours: number }> };
    setConcurrency: { mutate: (input: { level: number }) => Promise<{ success: boolean; concurrency: number }> };
    getConcurrency: { query: () => Promise<{ concurrency: number }> };
  };
  discovery: {
    crawl: { mutate: (input: { url: string }) => Promise<{ success: boolean; gapsFound: number; gaps: any[] }> };
    search: { mutate: (input: { query: string }) => Promise<{ success: boolean; gapsFound: number; gaps: any[] }> };
    searchRaw: { query: (input: { query: string; maxResults?: number }) => Promise<any[]> };
    trending: { query: () => Promise<any[]> };
  };
  integrations: {
    testGroq: { query: () => Promise<IntegrationTestResult> };
    testGitHub: { query: () => Promise<IntegrationTestResult> };
    testStripe: { query: () => Promise<IntegrationTestResult> };
    testResend: { query: () => Promise<IntegrationTestResult> };
    testSlack: { query: () => Promise<IntegrationTestResult> };
    testGoogleSearch: { query: () => Promise<IntegrationTestResult> };
    testVercel: { query: () => Promise<IntegrationTestResult> };
    testNowPayments: { query: () => Promise<IntegrationTestResult> };
    testLLMRouter: { query: () => Promise<IntegrationTestResult> };
  };
  payments: {
    get: { query: (input: string) => Promise<Payment> };
    listForDeployment: { query: (input: string) => Promise<Payment[]> };
    list: { query: () => Promise<Payment[]> };
    createCryptoPayment: { mutate: (input: { deploymentId: string; payCurrency?: string }) => Promise<Payment> };
  };
};

export const trpc = createTRPCReact<ServerAppRouter>();

// ==========================================
// tRPC HTTP CLIENT HELPER
// ==========================================

/**
 * Call a tRPC query procedure via HTTP GET.
 * tRPC wraps responses in { result: { data: ... } }.
 */
export async function trpcQuery<T = any>(procedure: string): Promise<T> {
  const response = await fetch(`/api/trpc/${procedure}`, {
    method: 'GET',
    credentials: 'include',
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      json?.error?.json?.message ||
      json?.error?.message ||
      json?.message ||
      `tRPC request failed (${response.status})`;

    throw new Error(message);
  }

  if (json?.result?.data?.json !== undefined) {
    return json.result.data.json as T;
  }

  if (json?.result?.data !== undefined) {
    return json.result.data as T;
  }

  return json as T;
}

/**
 * Call a tRPC mutation procedure via HTTP POST.
 */
export async function trpcMutation<T = any>(procedure: string, input: any): Promise<T> {
  const response = await fetch(`/api/trpc/${procedure}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      json: input,
    }),
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      json?.error?.json?.message ||
      json?.error?.message ||
      json?.message ||
      `tRPC request failed (${response.status})`;

    throw new Error(message);
  }

  if (json?.result?.data?.json !== undefined) {
    return json.result.data.json as T;
  }

  if (json?.result?.data !== undefined) {
    return json.result.data as T;
  }

  return json as T;
}
