import React, { useRef, useState } from 'react';
import { RefreshCw, Plus, ShieldAlert } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { useAuth } from '../../hooks/useAuth';
import { Dialog } from '../../components/ui';

const tabs = [
  { id: 'evidence', label: 'Evidence' },
  { id: 'specs', label: 'Specs' },
  { id: 'agents', label: 'Agents' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'builder', label: 'Builder' },
  { id: 'qc', label: 'QC' },
  { id: 'sales', label: 'Sales' },
  { id: 'finance', label: 'Finance' },
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'trace', label: 'Trace' },
];

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-lg border border-[var(--border)] bg-[var(--sidebar)] p-4 text-sm text-neutral-400">{text}</div>;
}

function PolicyBadge({ value = 'POLICY_NOT_CONFIGURED' }: { value?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-200">
      <ShieldAlert className="h-3 w-3" />
      {value}
    </span>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card-bold space-y-4">
      <h3 className="text-base font-bold text-white">{title}</h3>
      {children}
    </section>
  );
}

function RowList({ rows, render }: { rows: any[] | undefined; render: (row: any) => React.ReactNode }) {
  if (!rows) return <EmptyState text="Loading records..." />;
  if (rows.length === 0) return <EmptyState text="No records yet." />;
  return <div className="space-y-2">{rows.map(render)}</div>;
}

const Infrastructure: React.FC = () => {
  const { user } = useAuth();
  const canManage = user?.role === 'admin';
  const [working, setWorking] = useState(false);
  const executing = useRef(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceDraft, setEvidenceDraft] = useState({ title: '', sourceUrl: '', summary: '' });
  const [tab, setTab] = useState('evidence');
  const [message, setMessage] = useState<string | null>(null);
  const utils = trpc.useContext();

  const overview = trpc.infrastructure.overview.useQuery();
  const evidence = trpc.evidence.list.useQuery({});
  const specs = trpc.specifications.list.useQuery({});
  const agents = trpc.agents.list.useQuery();
  const tasks = trpc.supervisor.tasks.useQuery({});
  const builds = trpc.builder.list.useQuery({});
  const qc = trpc.qc.list.useQuery({});
  const leads = trpc.sales.leads.useQuery({});
  const customers = trpc.sales.customers.useQuery({});
  const revenue = trpc.finance.transactions.useQuery({});
  const settlements = trpc.finance.settlements.useQuery({});
  const lifecycle = trpc.lifecycle.list.useQuery({});
  const trace = trpc.infrastructure.businessTrace.useQuery({});
  const queryErrors = [overview, evidence, specs, agents, tasks, builds, qc, leads, customers, revenue, settlements, lifecycle, trace].flatMap(query => query.error ? [query.error.message] : []);

  const createEvidence = trpc.evidence.create.useMutation();
  const createSpec = trpc.specifications.createDraft.useMutation();
  const ensureAgents = trpc.agents.ensureDefaults.useMutation();
  const createTask = trpc.supervisor.createTask.useMutation();
  const createBuild = trpc.builder.create.useMutation();
  const createQc = trpc.qc.create.useMutation();
  const createLead = trpc.sales.createLead.useMutation();
  const createAccount = trpc.finance.createAccount.useMutation();
  const createLifecycle = trpc.lifecycle.create.useMutation();

  const refreshAll = async () => {
    await utils.invalidate();
  };

  const run = async (action: () => Promise<unknown>, label: string) => {
    if (!canManage || executing.current) return;
    executing.current = true;
    setWorking(true);
    setMessage(null);
    try {
      await action();
      await refreshAll();
      setMessage(`${label} completed.`);
    } catch (error: any) {
      setMessage(error?.message || `${label} failed.`);
    } finally {
      executing.current = false;
      setWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Lifecycle Infrastructure</h2>
          <p className="text-sm text-neutral-400">Traceable evidence, specifications and lifecycle records. Draft records are not verified outcomes.</p>
        </div>
        <button onClick={refreshAll} className="btn-secondary">
          <RefreshCw className="h-4 w-4" />
          <span>Refresh</span>
        </button>
      </div>

      {message && <div role="status" className="rounded border border-purple-500/20 bg-purple-500/10 px-3 py-2 text-sm text-purple-100">{message}</div>}
      {queryErrors.length > 0 && <div role="alert" className="rounded border border-red-500/30 p-3 text-red-200"><p>Infrastructure records could not be loaded. Check server availability, schema readiness and access permissions.</p>{Array.from(new Set(queryErrors)).map(error => <p key={error}>{error}</p>)}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Object.entries(overview.data || {}).filter(([key]) => key !== 'policyStatus').map(([key, value]) => (
          <div key={key} className="rounded-lg border border-[var(--border)] bg-[var(--sidebar)] p-3">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">{key}</div>
            <div className="mt-1 text-xl font-black text-white">{String(value)}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((item) => (
          <button key={item.id} onClick={() => setTab(item.id)} className={tab === item.id ? 'btn-bold-primary' : 'btn-secondary'}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'evidence' && (
        <Card title="Evidence Storage">
          <button disabled={!canManage || working}
            className="btn-bold-primary"
            onClick={() => setEvidenceOpen(true)}
          >
            <Plus className="h-4 w-4" />
            <span>Record Evidence</span>
          </button>
          <RowList rows={evidence.data} render={(row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
              <div className="font-semibold text-white">{row.title || row.category}</div>
              <div className="text-neutral-400">{row.provider} · {row.status} · {row.retrievedAt ? new Date(row.retrievedAt).toLocaleString() : 'retrieved'}</div>
              {row.sourceUrl && <a className="text-purple-300" href={row.sourceUrl} target="_blank" rel="noreferrer">Source</a>}
            </div>
          )} />
        </Card>
      )}

      {tab === 'specs' && (
        <Card title="Master Business Specifications">
          <button disabled={!canManage || working}
            className="btn-bold-primary"
            onClick={() => run(() => createSpec.mutateAsync({ title: 'Draft specification', sections: { objectives: [], dependencies: [] } }), 'Create draft specification')}
          >
            <Plus className="h-4 w-4" />
            <span>Create Draft</span>
          </button>
          <RowList rows={specs.data} render={(row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
              <div className="font-semibold text-white">{row.title}</div>
              <div className="text-neutral-400">{row.status}</div>
              <PolicyBadge value={row.approvalState} />
            </div>
          )} />
        </Card>
      )}

      {tab === 'agents' && (
        <Card title="Agent Registry">
          <button disabled={!canManage || working} className="btn-bold-primary" onClick={() => run(() => ensureAgents.mutateAsync(), 'Ensure default agents')}>
            <Plus className="h-4 w-4" />
            <span>Ensure Defaults</span>
          </button>
          <RowList rows={agents.data} render={(row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
              <div className="font-semibold text-white">{row.name}</div>
              <div className="text-neutral-400">{row.role} · {row.availability} · {row.implementationStatus}</div>
            </div>
          )} />
        </Card>
      )}

      {tab === 'tasks' && (
        <Card title="Supervisor Task Coordination">
          <button disabled={!canManage || working} className="btn-bold-primary" onClick={() => run(() => createTask.mutateAsync({ taskType: 'manual_review', title: 'Policy-blocked infrastructure task' }), 'Create task')}>
            <Plus className="h-4 w-4" />
            <span>Create Task</span>
          </button>
          <RowList rows={tasks.data} render={(row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
              <div className="font-semibold text-white">{row.title}</div>
              <div className="text-neutral-400">{row.taskType} · {row.state}</div>
              <PolicyBadge value={row.policyStatus} />
            </div>
          )} />
        </Card>
      )}

      {tab === 'builder' && (
        <Card title="Business Builder Projects">
          <button disabled={!canManage || working} className="btn-bold-primary" onClick={() => run(() => createBuild.mutateAsync({ projectType: 'software', architecture: { status: 'draft' } }), 'Create build project')}>
            <Plus className="h-4 w-4" />
            <span>Create Project</span>
          </button>
          <RowList rows={builds.data} render={(row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
              <div className="font-semibold text-white">{row.projectType}</div>
              <div className="text-neutral-400">{row.status}</div>
              <PolicyBadge value={row.policyStatus} />
            </div>
          )} />
        </Card>
      )}

      {tab === 'qc' && (
        <Card title="Independent QC">
          <button disabled={!canManage || working} className="btn-bold-primary" onClick={() => run(() => createQc.mutateAsync({ summary: 'Manual QC job' }), 'Create QC job')}>
            <Plus className="h-4 w-4" />
            <span>Create QC Job</span>
          </button>
          <RowList rows={qc.data} render={(row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
              <div className="font-semibold text-white">QC {row.id.slice(0, 8)}</div>
              <div className="text-neutral-400">{row.status}</div>
              <PolicyBadge value={row.releaseDecision} />
            </div>
          )} />
        </Card>
      )}

      {tab === 'sales' && (
        <Card title="Sales and Customers">
          <button disabled={!canManage || working} className="btn-bold-primary" onClick={() => run(() => createLead.mutateAsync({ source: 'manual', name: 'Manual lead' }), 'Create lead')}>
            <Plus className="h-4 w-4" />
            <span>Create Lead</span>
          </button>
          <div className="grid gap-4 md:grid-cols-2">
            <RowList rows={leads.data} render={(row) => <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm text-white">{row.name || row.source} · {row.status}</div>} />
            <RowList rows={customers.data} render={(row) => <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm text-white">{row.name || row.company || row.id} · {row.status}</div>} />
          </div>
        </Card>
      )}

      {tab === 'finance' && (
        <Card title="Revenue and Settlement Infrastructure">
          <button disabled={!canManage || working} className="btn-bold-primary" onClick={() => run(() => createAccount.mutateAsync({ accountType: 'platform_revenue_share_pending' }), 'Create revenue account')}>
            <Plus className="h-4 w-4" />
            <span>Create Account</span>
          </button>
          <div className="grid gap-4 md:grid-cols-2">
            <RowList rows={revenue.data} render={(row) => <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm text-white">{row.transactionType} · {row.amount} {row.currency}</div>} />
            <RowList rows={settlements.data} render={(row) => <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm text-white">{row.settlementType} · <PolicyBadge value={row.status} /></div>} />
          </div>
        </Card>
      )}

      {tab === 'lifecycle' && (
        <Card title="Business Lifecycle Monitoring">
          <button disabled={!canManage || working} className="btn-bold-primary" onClick={() => run(() => createLifecycle.mutateAsync({ state: 'monitoring' }), 'Create lifecycle record')}>
            <Plus className="h-4 w-4" />
            <span>Create Lifecycle</span>
          </button>
          <RowList rows={lifecycle.data} render={(row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
              <div className="font-semibold text-white">{row.state}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <PolicyBadge value={row.deadlinePolicyStatus} />
                <PolicyBadge value={row.extensionPolicyStatus} />
                <PolicyBadge value={row.shutdownPolicyStatus} />
              </div>
            </div>
          )} />
        </Card>
      )}

      {tab === 'trace' && (
        <Card title="Unified Business Trace">
          <pre className="max-h-[560px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--sidebar)] p-4 text-xs text-neutral-200">
            {JSON.stringify(trace.data || {}, null, 2)}
          </pre>
        </Card>
      )}
      {evidenceOpen && <Dialog title="Record evidence" onClose={() => { if (!working) setEvidenceOpen(false); }}><form className="space-y-4" onSubmit={event => { event.preventDefault(); void run(async () => { await createEvidence.mutateAsync({ ...evidenceDraft, provider: 'manual', category: 'market_context', caveats: ['Operator-supplied evidence requires independent verification.'] }); setEvidenceOpen(false); setEvidenceDraft({ title: '', sourceUrl: '', summary: '' }); }, 'Record evidence'); }}><p>Record an actual source and findings. This does not grant legal clearance or verify demand.</p><label className="block">Evidence title<input required value={evidenceDraft.title} onChange={event => setEvidenceDraft(current => ({ ...current, title: event.target.value }))} /></label><label className="block">Source URL<input required type="url" value={evidenceDraft.sourceUrl} onChange={event => setEvidenceDraft(current => ({ ...current, sourceUrl: event.target.value }))} /></label><label className="block">Evidence findings<textarea required value={evidenceDraft.summary} onChange={event => setEvidenceDraft(current => ({ ...current, summary: event.target.value }))} /></label><button type="submit" className="btn-bold-primary" disabled={!canManage || working}>Save source evidence</button></form></Dialog>}
    </div>
  );
};

export default Infrastructure;
