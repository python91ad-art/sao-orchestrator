import crypto from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as database from '../db';
import * as schema from '../../drizzle/schema';
import { withDiscoveryWrite } from './discoveryMaintenance';

export const POLICY_NOT_CONFIGURED = 'POLICY_NOT_CONFIGURED';

export const AGENT_ROLES = [
  'supervisor',
  'system_architect',
  'business_model_pricing',
  'ceo_strategy',
  'market_research',
  'cto',
  'developer',
  'designer',
  'marketing',
  'advertising',
  'sales',
  'finance',
  'customer_support',
  'analytics',
  'operations',
  'independent_qc',
] as const;

export type AgentRole = typeof AGENT_ROLES[number];
export type AgentTaskState = 'pending' | 'waiting_for_dependencies' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked_by_policy';

function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function hashParts(parts: unknown[]): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).join('|'))
    .digest('hex');
}

function page(input?: { limit?: number; skip?: number }) {
  return {
    limit: Math.min(Math.max(input?.limit ?? 50, 1), 200),
    offset: Math.max(input?.skip ?? 0, 0),
  };
}

export function normalizeGapDedupInput(input: {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
}) {
  return [
    input.knows,
    input.needs,
    input.controlsAccess,
    input.underestimatesValue,
    input.source,
  ].map((part) => String(part || '').toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
}

export function computeGapDedupHash(input: {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
}) {
  return crypto.createHash('sha256').update(normalizeGapDedupInput(input)).digest('hex');
}

export async function listEvidence(input: { gapId?: string; deploymentId?: string; provider?: string; status?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.gapId ? eq(schema.evidenceRecords.gapId, input.gapId) : undefined,
    input.deploymentId ? eq(schema.evidenceRecords.deploymentId, input.deploymentId) : undefined,
    input.provider ? eq(schema.evidenceRecords.provider, input.provider) : undefined,
    input.status ? eq(schema.evidenceRecords.status, input.status) : undefined,
  ].filter(Boolean) as any[];
  return database.db
    .select()
    .from(schema.evidenceRecords)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(schema.evidenceRecords.retrievedAt))
    .limit(limit)
    .offset(offset);
}

export async function createEvidence(input: Parameters<typeof createEvidenceUnlocked>[0]) {
  return withDiscoveryWrite(async () => {
    if (input.gapId && !await database.getGapById(input.gapId)) throw new Error('Evidence target was removed; stale research cannot recreate a candidate.');
    return createEvidenceUnlocked(input);
  });
}
async function createEvidenceUnlocked(input: {
  gapId?: string | null;
  deploymentId?: string | null;
  businessSpecId?: string | null;
  provider: string;
  sourceUrl?: string | null;
  category: string;
  title?: string | null;
  summary: string;
  content?: string | null;
  retrievedAt?: Date;
  publishedAt?: Date | null;
  geography?: string | null;
  reportingPeriod?: string | null;
  metadata?: unknown;
  reliability?: unknown;
  caveats?: string[];
  status?: string;
}) {
  const dedupHash = hashParts([
    input.gapId,
    input.deploymentId,
    input.businessSpecId,
    input.provider,
    input.sourceUrl,
    input.category,
    input.title,
    input.summary,
  ]);
  const existing = await database.db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.dedupHash, dedupHash)).limit(1);
  if (existing[0]) return existing[0];
  const id = database.generateId();
  await database.db.insert(schema.evidenceRecords).values({
    id,
    gapId: input.gapId || null,
    deploymentId: input.deploymentId || null,
    businessSpecId: input.businessSpecId || null,
    provider: input.provider,
    sourceUrl: input.sourceUrl || null,
    category: input.category,
    title: input.title || null,
    summary: input.summary,
    content: input.content || null,
    retrievedAt: input.retrievedAt || new Date(),
    publishedAt: input.publishedAt || null,
    geography: input.geography || null,
    reportingPeriod: input.reportingPeriod || null,
    metadataJson: json(input.metadata),
    reliabilityJson: json(input.reliability),
    caveatsJson: json(input.caveats || []),
    status: input.status || 'collected',
    dedupHash,
  });
  await recordEvidenceEvent({ evidenceId: id, gapId: input.gapId || null, provider: input.provider, eventType: 'created', message: 'Evidence record created.' });
  return (await database.db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.id, id)).limit(1))[0];
}

export async function recordEvidenceEvent(input: Parameters<typeof recordEvidenceEventUnlocked>[0]) {
  return withDiscoveryWrite(async () => {
    if (input.gapId && !await database.getGapById(input.gapId)) throw new Error('Research target no longer exists.');
    return recordEvidenceEventUnlocked(input);
  });
}
async function recordEvidenceEventUnlocked(input: { evidenceId?: string | null; gapId?: string | null; provider: string; eventType: string; message: string; metadata?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.evidenceEvents).values({
    id,
    evidenceId: input.evidenceId || null,
    gapId: input.gapId || null,
    provider: input.provider,
    eventType: input.eventType,
    message: input.message,
    metadataJson: json(input.metadata),
  });
  return id;
}

export async function formatStoredDiscoveryEvidence(gapId: string): Promise<string> {
  const records = await listEvidence({ gapId, limit: 30 });
  return records.filter(e => ['statistical_observation', 'discovery_problem'].includes(e.category)).map(e =>
    `Source: ${e.sourceUrl} (provider: ${e.provider}; status: ${e.status})\nRetrieved: ${e.retrievedAt.toISOString()}\nPeriod: ${e.reportingPeriod || 'unknown'}; geography: ${e.geography || 'unknown'}\nEvidence: ${e.summary}\nProvenance and hypothesis: ${e.metadataJson || '{}'}\nCaveats: ${e.caveatsJson || '[]'}`
  ).join('\n\n').slice(0, 40000);
}

export async function syncEvidenceBundleForGap(gapId: string, bundle: { evidence: any[]; unavailable?: { provider: string; reason: string }[] }) {
  const created = [];
  for (const item of bundle.evidence || []) {
    created.push(await createEvidence({
      gapId,
      provider: item.provider || item.source || 'unknown',
      sourceUrl: item.url || null,
      category: 'market_context',
      title: item.title || null,
      summary: item.summary || '',
      geography: item.geography || null,
      reportingPeriod: item.reportingPeriod || null,
      metadata: item.raw,
      caveats: item.caveats || [],
      status: 'collected',
    }));
  }
  for (const unavailable of bundle.unavailable || []) {
    await recordEvidenceEvent({
      gapId,
      provider: unavailable.provider,
      eventType: 'provider_unavailable',
      message: unavailable.reason,
    });
  }
  return created;
}

export async function createBusinessSpecification(input: Parameters<typeof createBusinessSpecificationUnlocked>[0]) {
  return withDiscoveryWrite(async () => {
    if (input.gapId && !await database.getGapById(input.gapId)) throw new Error('Specification target no longer exists.');
    return createBusinessSpecificationUnlocked(input);
  });
}
async function createBusinessSpecificationUnlocked(input: {
  gapId?: string | null;
  deploymentId?: string | null;
  title: string;
  legacyBusinessPlan?: string | null;
  sections?: Record<string, unknown>;
  createdBy?: string | null;
}) {
  const specId = database.generateId();
  const versionId = database.generateId();
  const sections = input.sections || {
    objectives: [],
    targetCustomer: {},
    productRequirements: [],
    technicalRequirements: [],
    operationalRequirements: [],
    financialAssumptions: [],
    marketingRequirements: [],
    dependencies: [],
  };
  await database.db.transaction(async (tx) => {
    await tx.insert(schema.businessSpecifications).values({
      id: specId,
      gapId: input.gapId || null,
      deploymentId: input.deploymentId || null,
      currentVersionId: versionId,
      status: 'draft',
      approvalState: POLICY_NOT_CONFIGURED,
      title: input.title,
      legacyBusinessPlan: input.legacyBusinessPlan || null,
      createdBy: input.createdBy || null,
    });
    await tx.insert(schema.businessSpecificationVersions).values({
      id: versionId,
      specificationId: specId,
      versionNumber: 1,
      status: 'draft',
      sectionsJson: JSON.stringify(sections),
      changeSummary: 'Initial draft created.',
      createdBy: input.createdBy || null,
    });
  });
  return getBusinessSpecification(specId);
}

export async function getBusinessSpecification(id: string) {
  const specs = await database.db.select().from(schema.businessSpecifications).where(eq(schema.businessSpecifications.id, id)).limit(1);
  const spec = specs[0];
  if (!spec) return null;
  const versions = await database.db.select().from(schema.businessSpecificationVersions).where(eq(schema.businessSpecificationVersions.specificationId, id)).orderBy(desc(schema.businessSpecificationVersions.versionNumber));
  const events = await database.db.select().from(schema.businessSpecificationEvents).where(eq(schema.businessSpecificationEvents.specificationId, id)).orderBy(desc(schema.businessSpecificationEvents.createdAt)).limit(50);
  return { ...spec, versions: versions.map((v) => ({ ...v, sections: parseJson(v.sectionsJson, {}) })), events };
}

export async function listBusinessSpecifications(input: { gapId?: string; deploymentId?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.gapId ? eq(schema.businessSpecifications.gapId, input.gapId) : undefined,
    input.deploymentId ? eq(schema.businessSpecifications.deploymentId, input.deploymentId) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.businessSpecifications).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.businessSpecifications.updatedAt)).limit(limit).offset(offset);
}

export async function createBusinessSpecificationVersion(input: { specificationId: string; sections: Record<string, unknown>; changeSummary?: string; createdBy?: string | null }) {
  const existing = await database.db.select().from(schema.businessSpecificationVersions).where(eq(schema.businessSpecificationVersions.specificationId, input.specificationId));
  const versionId = database.generateId();
  const versionNumber = existing.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
  await database.db.transaction(async (tx) => {
    await tx.insert(schema.businessSpecificationVersions).values({
      id: versionId,
      specificationId: input.specificationId,
      versionNumber,
      status: 'draft',
      sectionsJson: JSON.stringify(input.sections),
      changeSummary: input.changeSummary || null,
      createdBy: input.createdBy || null,
    });
    await tx.update(schema.businessSpecifications).set({ updatedAt: new Date() }).where(eq(schema.businessSpecifications.id, input.specificationId));
  });
  return getBusinessSpecification(input.specificationId);
}

export async function recordSpecificationEvent(input: { specificationId: string; versionId?: string | null; eventType: string; title: string; detail: string; status?: string; metadata?: unknown; createdBy?: string | null }) {
  const id = database.generateId();
  await database.db.insert(schema.businessSpecificationEvents).values({
    id,
    specificationId: input.specificationId,
    versionId: input.versionId || null,
    eventType: input.eventType,
    status: input.status || 'open',
    title: input.title,
    detail: input.detail,
    metadataJson: json(input.metadata),
    createdBy: input.createdBy || null,
  });
  return id;
}

export async function ensureDefaultAgents() {
  const existing = await database.db.select().from(schema.agents);
  const existingRoles = new Set(existing.map((agent) => agent.role));
  const created: string[] = [];
  for (const role of AGENT_ROLES) {
    if (existingRoles.has(role)) continue;
    const id = database.generateId();
    await database.db.insert(schema.agents).values({
      id,
      role,
      name: role.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '),
      capabilityJson: JSON.stringify([]),
      toolMetadataJson: JSON.stringify({ unrestrictedToolExecution: false }),
      availability: 'registered',
      implementationStatus: role === 'supervisor' ? 'configured' : 'registered',
      healthStatus: 'unknown',
    });
    created.push(role);
  }
  return { created };
}

export async function listAgents() {
  await ensureDefaultAgents();
  return database.db.select().from(schema.agents).orderBy(schema.agents.role);
}

export async function updateAgent(id: string, input: { availability?: string; capabilityJson?: unknown; toolMetadataJson?: unknown; healthStatus?: string; implementationStatus?: string }) {
  await database.db.update(schema.agents).set({
    availability: input.availability,
    capabilityJson: input.capabilityJson === undefined ? undefined : JSON.stringify(input.capabilityJson),
    toolMetadataJson: input.toolMetadataJson === undefined ? undefined : JSON.stringify(input.toolMetadataJson),
    healthStatus: input.healthStatus,
    implementationStatus: input.implementationStatus,
    updatedAt: new Date(),
  } as any).where(eq(schema.agents.id, id));
  return (await database.db.select().from(schema.agents).where(eq(schema.agents.id, id)).limit(1))[0] || null;
}

export async function listAgentTasks(input: { state?: string; agentId?: string; deploymentId?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.state ? eq(schema.agentTasks.state, input.state) : undefined,
    input.agentId ? eq(schema.agentTasks.agentId, input.agentId) : undefined,
    input.deploymentId ? eq(schema.agentTasks.deploymentId, input.deploymentId) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.agentTasks).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.agentTasks.createdAt)).limit(limit).offset(offset);
}

export async function createAgentTask(input: {
  agentId?: string | null;
  parentTaskId?: string | null;
  gapId?: string | null;
  deploymentId?: string | null;
  specificationId?: string | null;
  buildProjectId?: string | null;
  taskType: string;
  title: string;
  input?: unknown;
  dependsOnTaskIds?: string[];
  createdBy?: string | null;
}) {
  const idempotencyKey = hashParts([input.agentId, input.gapId, input.deploymentId, input.specificationId, input.taskType, input.title, json(input.input)]);
  const existing = await database.db.select().from(schema.agentTasks).where(eq(schema.agentTasks.idempotencyKey, idempotencyKey)).limit(1);
  if (existing[0]) return existing[0];
  const unmetDeps = input.dependsOnTaskIds?.length ? input.dependsOnTaskIds.length : 0;
  const id = database.generateId();
  await database.db.transaction(async (tx) => {
    await tx.insert(schema.agentTasks).values({
      id,
      parentTaskId: input.parentTaskId || null,
      agentId: input.agentId || null,
      gapId: input.gapId || null,
      deploymentId: input.deploymentId || null,
      specificationId: input.specificationId || null,
      buildProjectId: input.buildProjectId || null,
      taskType: input.taskType,
      title: input.title,
      state: unmetDeps ? 'waiting_for_dependencies' : 'ready',
      inputJson: json(input.input),
      policyStatus: POLICY_NOT_CONFIGURED,
      idempotencyKey,
      createdBy: input.createdBy || null,
    });
    for (const dependsOnTaskId of input.dependsOnTaskIds || []) {
      await tx.insert(schema.taskDependencies).values({ id: database.generateId(), taskId: id, dependsOnTaskId });
    }
  });
  await recordAgentEvent({ agentId: input.agentId || null, taskId: id, eventType: 'task_created', message: 'Agent task created.' });
  return (await database.db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id)).limit(1))[0];
}

export async function updateAgentTaskState(id: string, state: AgentTaskState, input: { output?: unknown; errorMessage?: string | null; recoveryCheckpoint?: unknown } = {}) {
  if (state === 'running') {
    const { enforcePolicy } = await import('./policyEngine');
    const task = (await database.db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id)).limit(1))[0];
    if (!task) throw new Error('Task not found.');
    await enforcePolicy({ category: 'agents', action: 'tool_execution', deploymentId: task.deploymentId || undefined, gapId: task.gapId || undefined, actorId: task.agentId || 'unassigned', facts: {} });
  }
  if (state === 'ready') {
    const deps = await database.db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, id));
    if (deps.length) {
      const depIds = deps.map((dep) => dep.dependsOnTaskId);
      const completed = await database.db.select().from(schema.agentTasks).where(and(inArray(schema.agentTasks.id, depIds), eq(schema.agentTasks.state, 'completed')));
      if (completed.length !== deps.length) {
        state = 'waiting_for_dependencies';
      }
    }
  }
  await database.db.update(schema.agentTasks).set({
    state,
    outputJson: input.output === undefined ? undefined : json(input.output),
    errorMessage: input.errorMessage === undefined ? undefined : input.errorMessage,
    recoveryCheckpointJson: input.recoveryCheckpoint === undefined ? undefined : json(input.recoveryCheckpoint),
    updatedAt: new Date(),
  } as any).where(eq(schema.agentTasks.id, id));
  const task = (await database.db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, id)).limit(1))[0];
  await recordAgentEvent({ agentId: task?.agentId || null, taskId: id, eventType: `task_${state}`, message: `Task moved to ${state}.` });
  return task;
}

export async function recordAgentEvent(input: { agentId?: string | null; taskId?: string | null; eventType: string; message: string; metadata?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.agentEvents).values({
    id,
    agentId: input.agentId || null,
    taskId: input.taskId || null,
    eventType: input.eventType,
    message: input.message,
    metadataJson: json(input.metadata),
  });
  return id;
}

export async function createBuildProject(input: { gapId?: string | null; deploymentId?: string | null; specificationId?: string | null; projectType?: string; architecture?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.buildProjects).values({
    id,
    gapId: input.gapId || null,
    deploymentId: input.deploymentId || null,
    specificationId: input.specificationId || null,
    projectType: input.projectType || 'software',
    status: 'draft',
    architectureJson: json(input.architecture),
    policyStatus: POLICY_NOT_CONFIGURED,
  });
  return getBuildProject(id);
}

export async function listBuildProjects(input: { deploymentId?: string; status?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.deploymentId ? eq(schema.buildProjects.deploymentId, input.deploymentId) : undefined,
    input.status ? eq(schema.buildProjects.status, input.status) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.buildProjects).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.buildProjects.updatedAt)).limit(limit).offset(offset);
}

export async function getBuildProject(id: string) {
  const project = (await database.db.select().from(schema.buildProjects).where(eq(schema.buildProjects.id, id)).limit(1))[0];
  if (!project) return null;
  const artifacts = await database.db.select().from(schema.buildArtifacts).where(eq(schema.buildArtifacts.buildProjectId, id)).orderBy(desc(schema.buildArtifacts.createdAt));
  const logs = await database.db.select().from(schema.buildLogs).where(eq(schema.buildLogs.buildProjectId, id)).orderBy(desc(schema.buildLogs.createdAt)).limit(100);
  return { ...project, artifacts, logs };
}

export async function addBuildArtifact(input: { buildProjectId: string; artifactType: string; name: string; uri?: string | null; metadata?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.buildArtifacts).values({
    id,
    buildProjectId: input.buildProjectId,
    artifactType: input.artifactType,
    name: input.name,
    uri: input.uri || null,
    contentHash: hashParts([input.buildProjectId, input.artifactType, input.name, input.uri, json(input.metadata)]),
    metadataJson: json(input.metadata),
  });
  return id;
}

export async function addBuildLog(input: { buildProjectId: string; level?: string; message: string; metadata?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.buildLogs).values({
    id,
    buildProjectId: input.buildProjectId,
    level: input.level || 'info',
    message: input.message,
    metadataJson: json(input.metadata),
  });
  return id;
}

export async function createQcJob(input: { buildProjectId?: string | null; artifactId?: string | null; assignedAgentId?: string | null; summary?: string | null }) {
  const id = database.generateId();
  await database.db.insert(schema.qcJobs).values({
    id,
    buildProjectId: input.buildProjectId || null,
    artifactId: input.artifactId || null,
    assignedAgentId: input.assignedAgentId || null,
    status: 'pending',
    releaseDecision: POLICY_NOT_CONFIGURED,
    summary: input.summary || null,
  });
  return id;
}

export async function listQcJobs(input: { status?: string; buildProjectId?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.status ? eq(schema.qcJobs.status, input.status) : undefined,
    input.buildProjectId ? eq(schema.qcJobs.buildProjectId, input.buildProjectId) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.qcJobs).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.qcJobs.updatedAt)).limit(limit).offset(offset);
}

export async function recordQcTestRun(input: { qcJobId: string; suiteName: string; testName: string; status: string; evidence?: unknown; output?: string | null }) {
  const id = database.generateId();
  await database.db.insert(schema.qcTestRuns).values({
    id,
    qcJobId: input.qcJobId,
    suiteName: input.suiteName,
    testName: input.testName,
    status: input.status,
    evidenceJson: json(input.evidence),
    output: input.output || null,
  });
  return id;
}

export async function createDefectReport(input: { qcJobId?: string | null; buildProjectId?: string | null; severity?: string; title: string; detail: string }) {
  const id = database.generateId();
  await database.db.insert(schema.defectReports).values({
    id,
    qcJobId: input.qcJobId || null,
    buildProjectId: input.buildProjectId || null,
    severity: input.severity || 'medium',
    title: input.title,
    detail: input.detail,
  });
  return id;
}

export async function createLead(input: { deploymentId?: string | null; source: string; name?: string | null; company?: string | null; email?: string | null; metadata?: unknown }) {
  const emailHash = input.email ? hashParts([input.email]) : null;
  const dedupHash = hashParts([input.deploymentId, input.source, input.name, input.company, emailHash]);
  const existing = await database.db.select().from(schema.leads).where(eq(schema.leads.dedupHash, dedupHash)).limit(1);
  if (existing[0]) return existing[0];
  const id = database.generateId();
  await database.db.insert(schema.leads).values({
    id,
    deploymentId: input.deploymentId || null,
    source: input.source,
    name: input.name || null,
    company: input.company || null,
    emailHash,
    metadataJson: json(input.metadata),
    dedupHash,
  });
  return (await database.db.select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1))[0];
}

export async function listLeads(input: { deploymentId?: string; status?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.deploymentId ? eq(schema.leads.deploymentId, input.deploymentId) : undefined,
    input.status ? eq(schema.leads.status, input.status) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.leads).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.leads.createdAt)).limit(limit).offset(offset);
}

export async function createCustomer(input: { deploymentId?: string | null; leadId?: string | null; name?: string | null; company?: string | null; email?: string | null; metadata?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.customers).values({
    id,
    deploymentId: input.deploymentId || null,
    leadId: input.leadId || null,
    name: input.name || null,
    company: input.company || null,
    emailHash: input.email ? hashParts([input.email]) : null,
    metadataJson: json(input.metadata),
  });
  return id;
}

export async function listCustomers(input: { deploymentId?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  return database.db.select().from(schema.customers)
    .where(input.deploymentId ? eq(schema.customers.deploymentId, input.deploymentId) : undefined)
    .orderBy(desc(schema.customers.createdAt)).limit(limit).offset(offset);
}

export async function recordSalesActivity(input: { deploymentId?: string | null; leadId?: string | null; customerId?: string | null; activityType: string; status?: string; notes?: string | null; attribution?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.salesActivities).values({
    id,
    deploymentId: input.deploymentId || null,
    leadId: input.leadId || null,
    customerId: input.customerId || null,
    activityType: input.activityType,
    status: input.status || 'recorded',
    notes: input.notes || null,
    attributionJson: json(input.attribution),
  });
  return id;
}

export async function listSalesActivities(input: { deploymentId?: string; leadId?: string; customerId?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.deploymentId ? eq(schema.salesActivities.deploymentId, input.deploymentId) : undefined,
    input.leadId ? eq(schema.salesActivities.leadId, input.leadId) : undefined,
    input.customerId ? eq(schema.salesActivities.customerId, input.customerId) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.salesActivities).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.salesActivities.createdAt)).limit(limit).offset(offset);
}

export async function createRevenueAccount(input: { deploymentId?: string | null; accountType: string; currency?: string }) {
  const id = database.generateId();
  await database.db.insert(schema.revenueAccounts).values({
    id,
    deploymentId: input.deploymentId || null,
    accountType: input.accountType,
    currency: input.currency || 'USD',
    policyStatus: POLICY_NOT_CONFIGURED,
  });
  return id;
}

export async function recordRevenueTransaction(input: { deploymentId?: string | null; paymentId?: string | null; customerId?: string | null; accountId?: string | null; transactionType: string; amount: string; currency?: string; idempotencyKey: string; metadata?: unknown }) {
  if (['verified_payment_revenue', 'verified_crypto_revenue'].includes(input.transactionType) && input.paymentId) {
    const { ingestVerifiedPayment } = await import('./financialLifecycle');
    await ingestVerifiedPayment(input.paymentId);
  }
  const existing = await database.db.select().from(schema.revenueTransactions).where(eq(schema.revenueTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing[0]) return existing[0];
  const id = database.generateId();
  await database.db.insert(schema.revenueTransactions).values({
    id,
    deploymentId: input.deploymentId || null,
    paymentId: input.paymentId || null,
    customerId: input.customerId || null,
    accountId: input.accountId || null,
    transactionType: input.transactionType,
    amount: input.amount,
    currency: input.currency || 'USD',
    idempotencyKey: input.idempotencyKey,
    metadataJson: json(input.metadata),
  });
  return (await database.db.select().from(schema.revenueTransactions).where(eq(schema.revenueTransactions.id, id)).limit(1))[0];
}

export async function listRevenueTransactions(input: { deploymentId?: string; paymentId?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.deploymentId ? eq(schema.revenueTransactions.deploymentId, input.deploymentId) : undefined,
    input.paymentId ? eq(schema.revenueTransactions.paymentId, input.paymentId) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.revenueTransactions).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.revenueTransactions.createdAt)).limit(limit).offset(offset);
}

export async function createSettlementRecord(input: { deploymentId?: string | null; revenueTransactionId?: string | null; settlementType: string; amount?: string; currency?: string; metadata?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.settlementRecords).values({
    id,
    deploymentId: input.deploymentId || null,
    revenueTransactionId: input.revenueTransactionId || null,
    settlementType: input.settlementType,
    amount: input.amount || '0.00',
    currency: input.currency || 'USD',
    status: POLICY_NOT_CONFIGURED,
    policyStatus: POLICY_NOT_CONFIGURED,
    metadataJson: json(input.metadata),
  });
  return id;
}

export async function listSettlements(input: { deploymentId?: string; status?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.deploymentId ? eq(schema.settlementRecords.deploymentId, input.deploymentId) : undefined,
    input.status ? eq(schema.settlementRecords.status, input.status) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.settlementRecords).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.settlementRecords.createdAt)).limit(limit).offset(offset);
}

export async function createLifecycleRecord(input: { deploymentId?: string | null; gapId?: string | null; state?: string }) {
  const id = database.generateId();
  await database.db.insert(schema.businessLifecycleRecords).values({
    id,
    deploymentId: input.deploymentId || null,
    gapId: input.gapId || null,
    state: input.state || 'monitoring',
    deadlinePolicyStatus: POLICY_NOT_CONFIGURED,
    extensionPolicyStatus: POLICY_NOT_CONFIGURED,
    shutdownPolicyStatus: POLICY_NOT_CONFIGURED,
  });
  return id;
}

export async function listLifecycleRecords(input: { deploymentId?: string; state?: string; limit?: number; skip?: number } = {}) {
  const { limit, offset } = page(input);
  const filters = [
    input.deploymentId ? eq(schema.businessLifecycleRecords.deploymentId, input.deploymentId) : undefined,
    input.state ? eq(schema.businessLifecycleRecords.state, input.state) : undefined,
  ].filter(Boolean) as any[];
  return database.db.select().from(schema.businessLifecycleRecords).where(filters.length ? and(...filters) : undefined).orderBy(desc(schema.businessLifecycleRecords.updatedAt)).limit(limit).offset(offset);
}

export async function recordLifecycleEvent(input: { lifecycleId: string; eventType: string; status?: string; detail: string; metadata?: unknown }) {
  const id = database.generateId();
  await database.db.insert(schema.businessLifecycleEvents).values({
    id,
    lifecycleId: input.lifecycleId,
    eventType: input.eventType,
    status: input.status || 'recorded',
    detail: input.detail,
    metadataJson: json(input.metadata),
  });
  return id;
}

export async function getBusinessTrace(input: { gapId?: string; deploymentId?: string }) {
  const [evidence, specs, tasks, builds, leadsRows, customersRows, revenue, lifecycle] = await Promise.all([
    listEvidence({ gapId: input.gapId, deploymentId: input.deploymentId, limit: 25 }),
    listBusinessSpecifications({ gapId: input.gapId, deploymentId: input.deploymentId, limit: 25 }),
    listAgentTasks({ deploymentId: input.deploymentId, limit: 25 }),
    listBuildProjects({ deploymentId: input.deploymentId, limit: 25 }),
    listLeads({ deploymentId: input.deploymentId, limit: 25 }),
    listCustomers({ deploymentId: input.deploymentId, limit: 25 }),
    listRevenueTransactions({ deploymentId: input.deploymentId, limit: 25 }),
    listLifecycleRecords({ deploymentId: input.deploymentId, limit: 25 }),
  ]);
  return { evidence, specifications: specs, tasks, buildProjects: builds, leads: leadsRows, customers: customersRows, revenue, lifecycle };
}

export async function getInfrastructureOverview() {
  const count = async (table: any) => {
    const rows = await database.db.select({ count: sql<number>`count(*)` }).from(table);
    return Number(rows[0]?.count || 0);
  };
  return {
    evidence: await count(schema.evidenceRecords),
    specifications: await count(schema.businessSpecifications),
    agents: await count(schema.agents),
    tasks: await count(schema.agentTasks),
    buildProjects: await count(schema.buildProjects),
    qcJobs: await count(schema.qcJobs),
    leads: await count(schema.leads),
    customers: await count(schema.customers),
    revenueTransactions: await count(schema.revenueTransactions),
    lifecycleRecords: await count(schema.businessLifecycleRecords),
    policyStatus: POLICY_NOT_CONFIGURED,
  };
}
