import { useEffect, useState } from 'react';
import { trpc } from '../../lib/trpc';
import { PolicyCategory, policyDefinitions, validatePolicy } from '../../../../shared/policyContracts';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { configurationReadiness } from '../../../../shared/policyReadiness';

export default function Policies() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<PolicyCategory>(() => { const stored = localStorage.getItem('policyCategory'); return stored && stored in policyDefinitions ? stored as PolicyCategory : 'discovery'; });
  const [config, setConfig] = useState<Record<string, any>>(policyDefinitions.discovery.defaults);
  const [reason, setReason] = useState('');
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const [impactOffset, setImpactOffset] = useState(0);
  const [editing, setEditing] = useState<{ id: string; expectedHash: string } | null>(null);
  const edit = trpc.operations.editDraft.useMutation();
  const assign = trpc.operations.assignPolicy.useMutation();
  const disable = trpc.operations.disablePolicy.useMutation();
  const [businessId, setBusinessId] = useState('');
  const [guardrailText, setGuardrailText] = useState('');
  const guardrails = trpc.policies.list.useQuery();
  const createGuardrail = trpc.policies.create.useMutation();
  const acknowledgeGuardrail = trpc.policies.acknowledge.useMutation();
  const deleteGuardrail = trpc.policies.delete.useMutation();
  const overview = trpc.policies.overview.useQuery();
  const history = trpc.policies.history.useQuery({ category, offset });
  const activity = trpc.policies.activity.useQuery({ category, offset });
  const impact = trpc.operations.impactPage.useQuery({ category, offset: impactOffset, limit: 50 });
  const save = trpc.policies.saveDraft.useMutation();
  const validate = trpc.policies.validateDraft.useMutation();
  const activate = trpc.policies.activate.useMutation();
  const utils = trpc.useUtils();
  const selected = overview.data?.find(policy => policy.category === category);
  const validation = validatePolicy(category, config);
  const busy = save.isPending || validate.isPending || activate.isPending || edit.isPending || assign.isPending || disable.isPending;
  useEffect(() => {
    if (!dirty) setConfig(selected?.config || policyDefinitions[category].defaults);
  }, [category, selected?.active?.id]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function perform(action: () => Promise<unknown>) {
    try { await action(); await utils.policies.invalidate(); setMessage('Operation completed.'); } catch (error: any) { setMessage(error.message); }
  }
  if (overview.isLoading) return <p role="status">Loading policy configurations…</p>;
  if (overview.error) return <div role="alert">{overview.error.message}<button onClick={() => overview.refetch()} className="btn-secondary">Retry</button></div>;
  return <div className="space-y-6">
    <header><h2 className="text-2xl font-bold text-white">Policies</h2><p className="text-neutral-400">Versioned business rules, validation and enforcement activity</p></header>
    <details className="card-bold"><summary>Production configuration readiness — all nine policies</summary><p>Only saved active configurations are shown. No suggested or test values are activated. Existing businesses retain pinned versions and separate owner consent.</p>{configurationReadiness(Object.fromEntries((overview.data || []).filter(policy => policy.active).map(policy => [policy.category, policy.config]))).map(readiness => <section key={readiness.category} className="py-3"><h3 className="font-bold">{readiness.name} · {readiness.state}</h3><p className="text-sm">Affected workflows: {readiness.workflows.join(', ')}</p>{readiness.validation.errors.map(error => <p role="alert" key={error}>{error}</p>)}{readiness.fields.filter(field => field.missing).map(field => <p key={field.name}>{field.name}: required {field.type}{field.acceptedValues ? ` (${field.acceptedValues.join(', ')})` : ''}; dependent workflows remain blocked. {field.rules.length ? JSON.stringify(field.rules) : ''}</p>)}</section>)}</details>
    <label className="block">Search categories<input aria-label="Search policies" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <details className="card-bold"><summary>Existing custom guardrails</summary><p className="text-sm text-neutral-400">Existing rule text and acknowledgement history remain separate from structured lifecycle policies.</p><form onSubmit={event => { event.preventDefault(); perform(async () => { await createGuardrail.mutateAsync({ ruleText: guardrailText }); setGuardrailText(''); }); }}><label>Custom guardrail<input required value={guardrailText} onChange={event => setGuardrailText(event.target.value)} /></label><button type="submit" className="btn-secondary" disabled={createGuardrail.isPending}>Add guardrail</button></form>{guardrails.data?.map(guardrail => <article key={guardrail.id} className="py-2"><p>{guardrail.ruleText}</p><p>{guardrail.acknowledgedAt ? 'Acknowledged' : 'Pending acknowledgement'}</p>{!guardrail.acknowledgedAt && <button className="btn-secondary" onClick={() => perform(() => acknowledgeGuardrail.mutateAsync(guardrail.id))}>Acknowledge</button>}<button className="btn-secondary" onClick={() => { if (confirm('Remove this custom guardrail?')) perform(() => deleteGuardrail.mutateAsync(guardrail.id)); }}>Delete custom guardrail</button></article>)}</details>
    <div className="grid lg:grid-cols-[260px_1fr] gap-6">
      <nav aria-label="Policy categories" className="space-y-2">{overview.data?.filter(policy => `${policy.name} ${policy.description}`.toLowerCase().includes(search.toLowerCase())).map(policy => <button key={policy.category} aria-current={category === policy.category ? 'page' : undefined} className={`w-full text-left card-bold ${category === policy.category ? 'border-purple-500' : ''}`} onClick={() => {
        if (dirty && !confirm('Discard unsaved policy changes?')) return;
        setDirty(false); setEditing(null); setCategory(policy.category); localStorage.setItem('policyCategory', policy.category); setConfig(policy.config); setReason(''); setOffset(0); setImpactOffset(0); setMessage('');
      }}><strong>{policy.name}</strong><span className="block text-xs text-neutral-400">{policy.status} · {policy.validation.missing.length} unresolved settings</span></button>)}</nav>
      <main className="space-y-6">
        <section className="card-bold space-y-3"><h3 className="font-bold">Enforcement scope and pinned business assignments</h3><p>Global activation governs new work. Existing businesses retain immutable assigned versions. Financial reassignment requires separate owner consent for the exact target version.</p><label>Business ID for explicit assignment<input value={businessId} onChange={event => setBusinessId(event.target.value)} /></label><label>Eligible policy version<select defaultValue="" onChange={event => { const versionId = event.target.value; if (businessId && reason.trim() && versionId && confirm('Assign this reviewed version to the specific business? Existing authorizations remain independently enforced.')) perform(() => assign.mutateAsync({ deploymentId: businessId, category, versionId, reason })); event.target.value = ''; }} disabled={busy || !businessId || !reason.trim()}><option value="">Select version after entering a change reason</option>{history.data?.filter(version => ['active', 'superseded'].includes(version.status)).map(version => <option key={version.id} value={version.id}>{version.id} · {version.status}</option>)}</select></label>{category === 'pricing' && selected?.active && <button className="btn-secondary" disabled={busy || !reason.trim()} onClick={() => { if (confirm('Disable optional pricing changes globally? Dependent pricing operations remain denied; existing agreements are not overwritten.')) perform(() => disable.mutateAsync({ category, reason })); }}>Disable optional pricing changes</button>}</section>
        <section className="card-bold space-y-4"><h3 className="text-xl font-bold">{selected?.name}</h3><p>{selected?.description}</p><p className="text-sm text-neutral-400">Agents: {selected?.agents.join(', ')}<br />Workflows: {selected?.workflows.join(', ')}<br />Active version: {selected?.active?.id || 'Policy Not Configured'}<br />Modified by: {selected?.active?.actorId || '—'} · {selected?.active?.updatedAt ? new Date(selected.active.updatedAt).toLocaleString() : '—'}</p>
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); perform(async () => { if (editing) await edit.mutateAsync({ ...editing, config, reason }); else await save.mutateAsync({ category, config, reason }); setEditing(null); setDirty(false); }); }}>
            <div className="grid md:grid-cols-2 gap-4">{Object.entries(config).map(([key, value]) => {
              const locked = ['requireArchitectReview', 'requireSupervisorForHighRisk', 'requireUserForSpending', 'requireUserForIrreversible', 'requireMarketEvidence', 'requireIndependentQc', 'requireArchitectCompliance', 'organicFirst', 'requireUserAuthorization', 'requireReinvestmentAuthorization', 'platformPercent', 'settlementFrequency', 'requireSupervisorForClosure', 'requireUserForDeletion', 'preserveObligations', 'freshBuildOnRestart'].includes(key);
              const options: Record<string, string[]> = { complexReasoning: ['high', 'extended'], complexity: ['normal', 'complex', 'very_complex'], accountingConvention: ['cash', 'accrual'], transactionEligibility: ['verified_received'], taxTreatment: ['verified_tax_deduction'], rounding: ['half_up', 'down'] };
              const numeric = typeof value === 'number' || (value === null && !['currency', 'timezone', 'accountingConvention', 'transactionEligibility', 'taxTreatment', 'rounding', 'industry', 'complexity'].includes(key));
              const update = (next: unknown) => { setConfig(current => ({ ...current, [key]: next })); setDirty(true); };
              return <label key={key} className="block text-sm"><span className="block mb-1">{key.replace(/([A-Z])/g, ' $1').replace(/^./, character => character.toUpperCase())}</span>
                {typeof value === 'boolean' ? <input type="checkbox" checked={value} disabled={locked} onChange={event => update(event.target.checked)} /> : options[key] ? <select value={value ?? ''} onChange={event => update(event.target.value || null)}><option value="">Not configured</option>{options[key].map(option => <option key={option}>{option}</option>)}</select> : <input disabled={locked} type={numeric ? 'number' : 'text'} step="any" value={Array.isArray(value) ? value.join(', ') : value ?? ''} onChange={event => update(Array.isArray(value) ? event.target.value.split(',').map(item => item.trim()).filter(Boolean) : numeric ? event.target.value === '' ? null : Number(event.target.value) : event.target.value || null)} />}
                <small className="block text-neutral-500">{locked ? 'Agreed mandatory rule.' : value === null ? 'Administrator configuration required before activation.' : Array.isArray(value) ? 'Comma-separated values.' : 'Applies to new work after activation.'}</small></label>;
            })}</div>
            <label className="block">Reason for change<input required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
            <div role="status" className="text-amber-300">{[...validation.errors, ...validation.missing.map(field => `Not configured: ${field}`)].join(' · ') || 'Configuration passes local validation.'}</div>
            <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || !validation.valid || !reason.trim()} className="btn-bold-primary">Save draft</button><button type="button" className="btn-secondary" onClick={() => { setConfig(selected?.config || policyDefinitions[category].defaults); setDirty(false); }}>Reset to saved values</button></div>
          </form>
          {message && <p role="status">{message}</p>}
        </section>
        <section className="card-bold space-y-3"><h3 className="font-bold">Change impact</h3>{impact.error ? <p role="alert">{impact.error.message}</p> : <><p>{impact.data?.application}</p><p>{impact.data?.counts?.businesses ?? 0} businesses · {impact.data?.counts?.assignments ?? 0} pinned assignments · {impact.data?.counts?.queue ?? 0} pending queue items · Paginated drill-down (50 per page)</p><details><summary>Affected records</summary><pre className="overflow-auto text-xs">{JSON.stringify(impact.data, null, 2)}</pre></details><div className="flex gap-2"><button className="btn-secondary" disabled={impactOffset === 0} onClick={() => setImpactOffset(Math.max(0, impactOffset - 50))}>Previous impact page</button><button className="btn-secondary" disabled={Math.max(...Object.values(impact.data?.counts || {}).map(value => Number(value))) <= impactOffset + 50} onClick={() => setImpactOffset(impactOffset + 50)}>Next impact page</button></div></>}</section>
        <section className="card-bold space-y-3"><h3 className="font-bold">Version history & comparison</h3>{history.error && <p role="alert">{history.error.message}</p>}{!history.data?.length && <p>No versions yet. Save a draft to begin.</p>}{history.data?.map(version => <article key={version.id} className="border-b border-neutral-800 pb-3"><p>{version.status} · {version.actorId} · {new Date(version.createdAt).toLocaleString()}</p><p>{version.reason}</p><details><summary>Compare with current form</summary><pre className="overflow-auto text-xs">{JSON.stringify({ version: JSON.parse(version.configJson), proposed: config }, null, 2)}</pre></details><div className="flex flex-wrap gap-2 mt-2">{['draft', 'invalid', 'validated'].includes(version.status) && <button className="btn-secondary" disabled={busy} onClick={() => { if (dirty && !confirm('Discard unsaved changes?')) return; setConfig(JSON.parse(version.configJson)); setReason(version.reason); setEditing({ id: version.id, expectedHash: version.configHash }); setDirty(false); }}>Edit draft</button>}{['draft', 'invalid', 'validated'].includes(version.status) && <button className="btn-secondary" disabled={busy} onClick={() => perform(async () => { const result = await validate.mutateAsync(version.id); if (result.errors.length || result.missing.length) throw new Error([...result.errors, ...result.missing.map(field => `Not configured: ${field}`)].join(', ')); })}>Validate</button>}{version.status === 'validated' && <button className="btn-bold-primary" disabled={busy || dirty || impact.isLoading || !!impact.error} onClick={() => { if (confirm('Activate this version for new work? Review the impact above. Existing consent is preserved.')) perform(() => activate.mutateAsync(version.id)); }}>Activate version</button>}<button className="btn-secondary" disabled={busy} onClick={() => { if (confirm('Create a new draft from this historical version?')) perform(() => save.mutateAsync({ category, config: {}, reason: `Restore ${version.id}`, restoreId: version.id })); }}>Restore as new draft</button></div></article>)}</section>
        <section className="card-bold space-y-3"><h3 className="font-bold">Enforcement activity</h3>{activity.error && <p role="alert">{activity.error.message}</p>}{!activity.data?.length && <p>No recorded evaluations on this page.</p>}{activity.data?.map(event => <article key={event.id}><strong>{event.decision}</strong> · {event.action}<p>{event.reason}</p><small>{event.versionId || 'No active version'} · {event.actorId}</small></article>)}</section>
        <div className="flex gap-2"><button className="btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous history page</button><button className="btn-secondary" disabled={(history.data?.length || 0) < 50 && (activity.data?.length || 0) < 50} onClick={() => setOffset(offset + 50)}>Next history page</button></div>
      </main>
    </div>
  </div>;
}
