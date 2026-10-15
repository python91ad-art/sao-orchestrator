// ==========================================
// VERCEL DEPLOYMENT PROVIDER
// ==========================================
// Authenticates via process.env.VERCEL_API_TOKEN.
// Never exposes the token in responses, logs, or the database.
// ==========================================

const VERCEL_API_BASE = 'https://api.vercel.com';
export class VercelRequestRejected extends Error {}

async function getVercelToken(): Promise<string> {
  let token = process.env.VERCEL_API_TOKEN;
  try {
    const { resolveCredential } = await import('./providerRegistry');
    const resolved = await resolveCredential('vercel', ['VERCEL_API_TOKEN']);
    if (resolved.value) {
      token = resolved.value;
    }
  } catch {
    /* fallback to env */
  }

  if (!token) {
    throw new Error(
      'VERCEL_API_TOKEN is not configured. Set VERCEL_API_TOKEN in your environment variables or configure Vercel in Providers & API Keys.'
    );
  }
  return token;
}

async function getVercelHeaders(): Promise<{ Authorization: string; 'Content-Type': string }> {
  const token = await getVercelToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function getTeamParam(): string {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${teamId}` : '';
}

// ==========================================
// TYPES
// ==========================================

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  link?: { type: string; repo?: string };
  createdAt: number;
  updatedAt: number;
}

export interface VercelDeployment {
  uid: string;
  projectId?: string;
  name: string;
  url: string;
  created: number;
  state: 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'QUEUED' | 'READY' | 'CANCELED';
  readyState?: 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'QUEUED' | 'READY' | 'CANCELED';
  alias?: string[];
  inspectorUrl?: string;
}

export interface VercelTestResult {
  success: boolean;
  message: string;
  user?: { username: string; email: string };
}

export interface VercelCreateProjectParams {
  name: string;
  framework?: string;
  environmentVariables?: { key: string; value: string; target: string[] }[];
}

export interface VercelDeployParams {
  projectId: string;
  releaseContext?: { deploymentId: string; releaseId: string; entryPoint: string };
  source?: 'import' | 'cli';
  files?: { file: string; data: string }[];
  name?: string;
  target?: 'production' | 'preview';
}

export interface VercelDeployResult {
  projectId: string;
  deploymentId: string;
  deploymentUrl: string;
  readyState: string;
}

type VercelTestAdapter = {
  getDeployment?: (deploymentId: string) => Promise<VercelDeployment | null>;
  readDeploymentFiles?: (deploymentId: string) => Promise<{ path: string; content: string }[]>;
  createProject?: (params: VercelCreateProjectParams) => Promise<{ projectId: string; name: string }>;
  deploy?: (params: VercelDeployParams) => Promise<VercelDeployResult>;
  waitReady?: (
    deploymentId: string,
    timeoutMs?: number,
    pollIntervalMs?: number
  ) => Promise<{ ready: boolean; state?: string; url?: string; alias?: string[] }>;
  verifyPublicUrl?: (
    url: string,
    timeoutMs?: number
  ) => Promise<{ reachable: boolean; status: number; gated: boolean }>;
};

let vercelTestAdapter: VercelTestAdapter | null = null;

export function setVercelTestAdapter(adapter: VercelTestAdapter | null) {
  vercelTestAdapter = adapter;
}
export async function readPublicDeploymentFiles(url: string, paths: string[], deploymentId: string) {
  if (vercelTestAdapter) {
    if (process.env.NODE_ENV !== 'test' || !vercelTestAdapter.readDeploymentFiles) throw new Error('Mock deployment artifact retrieval is unavailable.');
    return vercelTestAdapter.readDeploymentFiles(deploymentId);
  }
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) throw new Error('A verified public HTTPS deployment URL is required.');
  const files = [];
  for (const filePath of paths) {
    if (filePath.includes('..') || filePath.startsWith('/')) throw new Error('Invalid deployment artifact path.');
    const response = await fetch(new URL(filePath, `${origin.origin}/`), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) throw new Error(`Post-deployment asset verification failed: HTTP ${response.status}.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as any) { size += chunk.byteLength; if (size > 800000) throw new Error('Deployed asset exceeds safe retrieval limits.'); chunks.push(chunk); }
    files.push({ path: filePath, content: Buffer.concat(chunks).toString('utf8') });
  }
  return files;
}
// ==========================================
// API FUNCTIONS
// ==========================================

/**
 * Test Vercel connectivity by fetching the authenticated user.
 */
export async function testVercelConnection(): Promise<VercelTestResult> {
  try {
    const headers = await getVercelHeaders();
    const teamParam = getTeamParam();

    const response = await fetch(
      `${VERCEL_API_BASE}/v2/user${teamParam}`,
      { headers }
    );

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: 'Vercel authentication failed — verify VERCEL_API_TOKEN.',
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      console.error(
        `[Vercel] Auth test returned HTTP ${response.status}: ${text.slice(0, 200)}`
      );
      return {
        success: false,
        message: `Vercel API returned HTTP ${response.status}.`,
      };
    }

    const data = await response.json();
    const user = data?.user || data;

    return {
      success: true,
      message: `Connected as ${user?.username || user?.email || 'unknown user'}`,
      user: {
        username: user?.username || 'unknown',
        email: user?.email || 'unknown',
      },
    };
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error('[Vercel] testVercelConnection failed:', msg);
    if (
      msg.includes('VERCEL_API_TOKEN') &&
      !msg.includes('not configured')
    ) {
      return {
        success: false,
        message: 'Vercel authentication failed — verify VERCEL_API_TOKEN.',
      };
    }
    return { success: false, message: `Vercel connection failed: ${msg}` };
  }
}

/**
 * Create a Vercel project (idempotent — returns existing if name matches).
 */
export async function createVercelProject(
  params: VercelCreateProjectParams
): Promise<{ projectId: string; name: string }> {
  if (vercelTestAdapter?.createProject) {
    return vercelTestAdapter.createProject(params);
  }

  const headers = await getVercelHeaders();
  const teamParam = getTeamParam();

  // Check if a project with this name already exists
  try {
    const listRes = await fetch(
      `${VERCEL_API_BASE}/v9/projects${teamParam ? `${teamParam}&` : '?'}search=${encodeURIComponent(params.name)}`,
      { headers }
    );

    if (listRes.ok) {
      const listData = await listRes.json();
      const projects: any[] = listData?.projects || [];
      const existing = projects.find(
        (p: any) => p.name === params.name
      );
      if (existing) {
        console.log(
          `[Vercel] Project "${params.name}" already exists — reusing (${existing.id}).`
        );
        return { projectId: existing.id, name: existing.name };
      }
    }
  } catch (err) {
    console.warn(
      '[Vercel] Could not check existing projects — will attempt creation:',
      (err as Error)?.message
    );
  }

  // Create a new project: only include framework if Vercel recognises it.
  const body: Record<string, unknown> = { name: params.name };
  const mappedFramework = params.framework
    ? mapFrameworkForVercel(params.framework)
    : null;
  if (mappedFramework) {
    body.framework = mappedFramework;
  }
  if (params.environmentVariables?.length) {
    body.environmentVariables = params.environmentVariables;
  }

  const response = await fetch(
    `${VERCEL_API_BASE}/v9/projects${teamParam}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    console.error(
      `[Vercel] createVercelProject returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
    throw new Error(
      `Vercel project creation failed (HTTP ${response.status}).`
    );
  }

  const data = await response.json();
  console.log(`[Vercel] Created project "${params.name}" (${data.id}).`);
  return { projectId: data.id, name: data.name };
}

/**
 * Deploy to a Vercel project.
 *
 * NOTE: This function currently performs the Vercel project lifecycle
 * (project creation / identity) but SAO does NOT yet generate deployable
 * application source code.
 */
export async function deployToVercel(
  params: VercelDeployParams
): Promise<VercelDeployResult> {
  if (!params.releaseContext || !params.files?.length) throw new Error('Verified artifact-bound release context is required at provider execution.');
  const { verifyReleaseForDeployment } = await import('./releasePipeline');
  await verifyReleaseForDeployment(params.releaseContext.deploymentId, params.releaseContext.releaseId, { description: '', framework: 'static', entryPoint: params.releaseContext.entryPoint, files: params.files.map(file => ({ path: file.file, content: file.data })) });
  const { db } = await import('../db');
  const { releaseAuthorizations } = await import('../../drizzle/schema');
  const { and, eq } = await import('drizzle-orm');
  const releaseId = params.releaseContext.releaseId;
  const beforePublication = (await db.select().from(releaseAuthorizations).where(eq(releaseAuthorizations.id, releaseId)).limit(1))[0];
  const claimed = await db.update(releaseAuthorizations).set({ status: 'deploying', evidenceJson: JSON.stringify({ ...JSON.parse(beforePublication.evidenceJson), publicationProjectId: params.projectId }) }).where(and(eq(releaseAuthorizations.id, releaseId), eq(releaseAuthorizations.status, 'eligible')));
  if (!(claimed[0] as any).affectedRows) throw new Error('Release publication is already in progress or requires provider reconciliation.');
  try {
    const result = await executeVercelDeployment(params);
    const release = (await db.select().from(releaseAuthorizations).where(eq(releaseAuthorizations.id, releaseId)).limit(1))[0];
    await db.update(releaseAuthorizations).set({ status: 'deployment_submitted', evidenceJson: JSON.stringify({ ...JSON.parse(release.evidenceJson), externalDeploymentId: result.deploymentId, projectId: result.projectId, submittedDeployment: result, submittedAt: new Date().toISOString() }) }).where(eq(releaseAuthorizations.id, releaseId));
    return result;
  } catch (error) {
    await db.update(releaseAuthorizations).set({ status: error instanceof VercelRequestRejected ? 'eligible' : 'deployment_unknown' }).where(eq(releaseAuthorizations.id, releaseId));
    throw error;
  }
}
async function executeVercelDeployment(params: VercelDeployParams): Promise<VercelDeployResult> {
  if (vercelTestAdapter?.deploy) {
    return vercelTestAdapter.deploy(params);
  }

  const headers = await getVercelHeaders();
  const teamParam = getTeamParam();

  // Build query: skip auto-detection for new projects (static sites)
  const skipConfirmation = teamParam
    ? `${teamParam}&skipAutoDetectionConfirmation=1`
    : '?skipAutoDetectionConfirmation=1';

  const body: Record<string, unknown> = {
    name: params.name || 'sao-deployment',
    target: params.target || 'production',
    // Link this deployment to the project we created/reused.
    // Without this, Vercel creates an anonymous project and the
    // production alias (https://<project>.vercel.app) is never assigned.
    project: params.projectId,
    // Provide explicit project settings to prevent framework auto-detection errors.
    projectSettings: {
      framework: null,
    },
  };
  if (params.files?.length) {
    // Vercel's inline-file deployment requires base64-encoded file
    // contents with an explicit `encoding` field. Raw UTF-8 is not
    // decoded correctly and yields broken/empty deployments.
    body.files = params.files.map((f) => ({
      file: f.file,
      data: Buffer.from(f.data, 'utf8').toString('base64'),
      encoding: 'base64',
    }));
  }
  if (params.source) { body.source = params.source; }

  const response = await fetch(
    `${VERCEL_API_BASE}/v13/deployments${skipConfirmation}`,
    { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    console.error(
      `[Vercel] deployToVercel returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
    const Rejection = response.status >= 400 && response.status < 500 ? VercelRequestRejected : Error;
    throw new Rejection(
      `Vercel deployment failed (HTTP ${response.status}).`
    );
  }

  const data = await response.json();
  const deploymentUrl = data.alias?.[0]
    ? `https://${data.alias[0]}`
    : data.url ? `https://${data.url}` : '';

  console.log(
    `[Vercel] Deployment ${data.uid || data.id} created for project ${params.projectId}.`
  );
  return {
    projectId: params.projectId,
    deploymentId: data.uid || data.id,
    deploymentUrl,
    readyState: data.readyState || data.state || 'QUEUED',
  };
}

/**
 * Get a Vercel deployment by ID.
 */
export async function getVercelDeployment(
  deploymentId: string
): Promise<VercelDeployment | null> {
  if (vercelTestAdapter?.getDeployment && process.env.NODE_ENV === 'test') return vercelTestAdapter.getDeployment(deploymentId);
  const headers = await getVercelHeaders();
  const teamParam = getTeamParam();

  const response = await fetch(
    `${VERCEL_API_BASE}/v13/deployments/${deploymentId}${teamParam}`,
    { headers }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    console.error(
      `[Vercel] getVercelDeployment returned HTTP ${response.status}: ${text.slice(0, 200)}`
    );
    return null;
  }
  return response.json();
}

/**
 * Create a safe Vercel project name from an SAO deployment ID.
 */
export function makeVercelProjectName(deploymentId: string): string {
  const prefix = 'sao';
  const suffix = deploymentId.replace(/[^a-zA-Z0-9-]/g, '-').slice(-40);
  const name = `${prefix}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return name.slice(0, 100);
}

/**
 * Map SAO framework names to Vercel-recognised framework identifiers.
 * SAO generates static HTML/JS/CSS apps — "static" is not a valid
 * Vercel framework, so we map it to null (no framework) which tells
 * Vercel to serve the files as-is via their static hosting.
 */
export function mapFrameworkForVercel(framework: string): string | null {
  const map: Record<string, string | null> = {
    static: null,
    react: 'nextjs',
    other: null,
  };
  return map[framework] ?? null;
}

/**
 * Resolve the publicly-accessible production URL for a freshly-created
 * Vercel deployment.
 *
 * Vercel auto-assigns a clean production alias (served WITHOUT Vercel
 * Authentication / Deployment Protection) plus a username-suffixed
 * automatic alias and a per-deployment URL — the latter two are
 * login-gated on the Hobby plan. The production alias is NOT always
 * `${projectName}.vercel.app` because Vercel truncates long project
 * names in the domain, so we cannot compute it from the project name.
 * Instead we read the deployment's aliases and verify which one is
 * actually reachable without the login gate.
 */
export async function resolveVercelPublicUrl(
  aliases: string[] = [],
  deploymentUrl?: string
): Promise<string | null> {
  const candidates: string[] = [];
  for (const a of aliases) {
    if (!a) continue;
    const u = a.startsWith('http') ? a : `https://${a}`;
    if (!candidates.includes(u)) candidates.push(u);
  }
  if (deploymentUrl) {
    const u = deploymentUrl.startsWith('http')
      ? deploymentUrl
      : `https://${deploymentUrl}`;
    if (!candidates.includes(u)) candidates.push(u);
  }

  for (const candidate of candidates) {
    // DNS/alias propagation can lag a moment behind READY, so retry.
    for (let attempt = 0; attempt < 4; attempt++) {
      const check = await verifyPublicUrl(candidate);
      if (check.reachable) {
        return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  return null;
}

/**
 * Poll a Vercel deployment until it reaches READY (or a terminal
 * ERROR / CANCELED state). Returns the final state and, when ready,
 * the deployment's URL and aliases.
 */
export async function waitForVercelDeploymentReady(
  deploymentId: string,
  timeoutMs = 180_000,
  pollIntervalMs = 3_000
): Promise<{ ready: boolean; state?: string; url?: string; alias?: string[] }> {
  if (vercelTestAdapter?.waitReady) {
    return vercelTestAdapter.waitReady(deploymentId, timeoutMs, pollIntervalMs);
  }

  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    let dep: VercelDeployment | null = null;
    try {
      dep = await getVercelDeployment(deploymentId);
    } catch (err) {
      console.warn(
        `[Vercel] Could not fetch deployment state (retrying): ${(err as Error)?.message}`
      );
    }

    if (dep) {
      const state = dep.readyState || dep.state;
      if (state === 'READY') {
        return { ready: true, state, url: dep.url, alias: dep.alias };
      }
      if (state === 'ERROR' || state === 'CANCELED') {
        return { ready: false, state, url: dep.url, alias: dep.alias };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { ready: false, state: 'TIMEOUT' };
}

/**
 * Verify a public URL is actually reachable and NOT sitting behind
 * Vercel's Deployment Protection login gate.
 */
export async function verifyPublicUrl(
  url: string,
  timeoutMs = 20_000
): Promise<{ reachable: boolean; status: number; gated: boolean }> {
  if (vercelTestAdapter?.verifyPublicUrl) {
    return vercelTestAdapter.verifyPublicUrl(url, timeoutMs);
  }

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'sao-orchestrator/2.0' },
    });
    const text = await res.text();
    // Deployment Protection injects a login shell with data-dpl-id.
    const gated = text.includes('data-dpl-id');
    return { reachable: res.ok && !gated, status: res.status, gated };
  } catch (err) {
    console.warn(`[Vercel] Public URL verification failed for ${url}: ${(err as Error)?.message}`);
    return { reachable: false, status: 0, gated: false };
  }
}
