import { useEffect, useState } from 'react';
import { Dialog, ErrorState, LoadingState } from '../../components/ui';
import { trpc } from '../../lib/trpc';
import type { Assignment } from '../../../../shared/providerAssignments';

export default function ProviderAssignments({ connectionId, onClose, onSaved }: { connectionId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const query = trpc.providers.assignments.useQuery(connectionId, { gcTime: 0, refetchOnWindowFocus: false });
  const sections = trpc.providers.serviceTypes.useQuery();
  const save = trpc.providers.saveAssignments.useMutation();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [revision, setRevision] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (query.data) { setAssignments(query.data.assignments); setRevision(query.data.revision); }
  }, [query.data]);
  const data = query.data;
  const update = (section: string, patch: Partial<Assignment>) => setAssignments(old => old.map(a => a.section === section ? { ...a, ...patch } : a));
  return <Dialog title={`Manage Assignments${data ? ` — ${data.name}` : ''}`} onClose={onClose}>
    {query.isLoading ? <LoadingState label="Loading assignments…" /> : query.error ? <ErrorState message={query.error.message} retry={() => query.refetch()} /> : data && <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); setError('');
      try { await save.mutateAsync({ connectionId, assignments, revision }); await onSaved(); onClose(); }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not save assignments.'); }
    }}>
      <p>Connection: <strong>{data.connectionStatus}</strong> · {data.enabled ? 'Enabled' : 'Disabled'}</p>
      <p className="text-xs text-neutral-400">Capabilities: {[...new Set(data.offerings.flatMap(o => o.capabilities))].join(', ') || 'No executable adapter available'}. Search availability is checked again on every response using source evidence.</p>
      {!data.enabled && <p className="text-amber-300 text-sm">Enable the provider connection before these assignments can execute.</p>}
      <p className="text-sm text-neutral-400">Choose sections. Higher priority runs first; fallback order breaks ties. Removing a section keeps your connection and its credentials.</p>
      {(sections.data || []).map(section => {
        const offering = data.offerings.find(o => o.section === section.id);
        const assignment = assignments.find(a => a.section === section.id);
        const defaults = (): Assignment => ({ section: section.id, operation: offering!.operation, enabled: true, priority: 100, fallbackOrder: 0, model: offering!.defaultModel, settings: {} });
        const health = data.health[section.id];
        return <fieldset key={section.id} className="border border-[var(--border)] rounded-lg p-3 space-y-3">
          <label className="flex items-center gap-2 font-semibold"><input type="checkbox" disabled={!offering || save.isPending} checked={!!assignment} onChange={event => {
            if (event.target.checked && offering) setAssignments(old => [...old, defaults()]);
            else setAssignments(old => old.filter(a => a.section !== section.id));
          }} />Assign to {section.label}</label>
          {!offering && <p className="text-xs text-neutral-500">Unavailable: this adapter lacks the required capability for {section.label}.</p>}
          {assignment && offering && <>
            <div className="flex gap-4 items-center">
              <label className="flex gap-2"><input type="checkbox" checked={assignment.enabled} onChange={e => update(section.id, { enabled: e.target.checked })} />Enabled for {section.label}</label>
              <label className="text-sm">Priority for {section.label}<input type="number" min="-10000" max="10000" required value={assignment.priority} onChange={e => update(section.id, { priority: Number(e.target.value) })} /></label>
            </div>
            {assignment.model && offering.models.length > 0 && !offering.models.includes(assignment.model) && data.providerId !== 'openrouter' && <p role="alert" className="text-xs text-amber-300">Model {assignment.model} lacks a verified {offering.operation} capability. Choose a supported model before saving.</p>}
            <p className="text-xs text-neutral-400">Operation: {offering.operation}{health ? ` · ${health.status} · Last success: ${health.lastSuccess || 'never'} · Last failure: ${health.lastFailure || 'never'}${health.reason ? ` · ${health.reason}` : ''}` : ' · No execution recorded'}</p>
            {offering.operation === 'live_web_search' && data.providerId !== 'tavily' && <p className="text-xs text-amber-300">{data.billingApproved ? 'Existing connection billing approval still applies; all account caps remain enforced.' : 'Paid search is blocked until you explicitly approve it and configure budgets in Edit Provider. Saving an assignment does not authorize spending.'}</p>}
            <details className="space-y-3">
              <summary className="cursor-pointer text-sm">Advanced settings for {section.label}</summary>
              {offering.models.length > 0 && <label className="block text-sm">Model for {section.label}<select aria-label={`Model for ${section.label}`} value={assignment.model || ''} onChange={e => update(section.id, { model: e.target.value || null })}>
                {offering.operation === 'inference' && <option value="">Automatic — existing compatible models</option>}
                {offering.models.map(model => <option key={model} value={model}>{model}</option>)}
              </select></label>}
              <label className="block text-sm">Fallback order for {section.label}<input type="number" min="0" max="10000" required value={assignment.fallbackOrder} onChange={e => update(section.id, { fallbackOrder: Number(e.target.value) })} /></label>
              {['inference', 'live_web_search'].includes(offering.operation) && <>
                <p className="text-xs text-neutral-400">Leave optional caps blank to keep existing limits. Assignment caps only restrict use. Failed requests also count.</p>
                {([
                  ['maxRequestsPerDay', 'Daily request cap', 0, 100000, 1], ['maxRequestsPerMinute', 'Requests per minute', 0, 10000, 1],
                  ...(offering.operation === 'inference' ? [['maxTokensPerDay', 'Daily token cap', 0, 100000000, 1]] : []),
                  ['dailyBudgetUsd', 'Daily spending cap (USD)', 0, 1000, 0.01], ['maxRequestCostUsd', 'Maximum reserved request cost (USD)', 0, 100, 0.01],
                  ['timeoutMs', 'Timeout (milliseconds)', 1000, 60000, 1],
                  ...(offering.operation === 'live_web_search' ? [['retries', 'Transient retries', 0, 1, 1]] : []),
                ] as [keyof Assignment['settings'], string, number, number, number][]).map(([key, label, min, max, step]) => <label key={key} className="block text-sm">{label} for {section.label}<input type="number" min={min} max={max} step={step} value={assignment.settings[key] ?? ''} onChange={e => {
                  const settings = { ...assignment.settings };
                  if (e.target.value === '') delete settings[key]; else settings[key] = Number(e.target.value);
                  update(section.id, { settings });
                }} /></label>)}
              </>}
              <label className="block text-sm">Copy applicable settings to {section.label}<select aria-label={`Copy applicable settings to ${section.label}`} value="" onChange={e => {
                const source = assignments.find(a => a.section === e.target.value);
                if (source) update(section.id, { priority: source.priority, fallbackOrder: source.fallbackOrder,
                  model: source.model && offering.models.includes(source.model) ? source.model : offering.defaultModel,
                  settings: ['inference', 'live_web_search'].includes(offering.operation) ? { ...source.settings, ...(offering.operation !== 'live_web_search' ? { retries: undefined } : { maxTokensPerDay: undefined }) } : {} });
              }}><option value="">Choose an existing assignment</option>{assignments.filter(a => a.section !== section.id).map(a => <option key={a.section} value={a.section}>{(sections.data || []).find(s => s.id === a.section)?.label}</option>)}</select></label>
              <button type="button" className="btn-secondary text-xs" onClick={() => update(section.id, { ...defaults(), enabled: assignment.enabled })}>Restore defaults for {section.label}</button>
            </details>
          </>}
        </fieldset>;
      })}
      {(error || sections.error) && <p role="alert" className="text-red-400">{error || sections.error?.message}</p>}
      <div className="flex justify-end gap-3"><button type="button" className="btn-secondary" onClick={onClose} disabled={save.isPending}>Cancel</button><button type="submit" className="btn-bold-primary" disabled={save.isPending || !sections.data}>{save.isPending ? 'Saving…' : 'Save Assignments'}</button></div>
    </form>}
  </Dialog>;
}
