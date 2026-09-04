import React, { useState } from 'react';
import { Plus, Trash2, ShieldCheck, Power, Edit3 } from 'lucide-react';
import { trpc } from '../../lib/trpc';

type ServiceType = 'search' | 'llm' | 'deployment' | 'advertising' | 'payments';

interface ProviderRecord {
  id: string;
  service: ServiceType;
  name: string;
  providerId: string;
  credentialType: string;
  hasCredential: boolean;
  maskedCredential: string | null;
  baseUrl: string | null;
  config: any;
  enabled: boolean;
  priority: 'primary' | 'fallback' | null;
  compatibilityStatus: 'compatible' | 'adapter_required' | 'unknown';
  connectionStatus: string;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  envFallback: boolean;
}

const CONNECTION_BADGE: Record<string, string> = {
  untested: 'badge-gray',
  connected: 'badge-success',
  auth_failed: 'badge-danger',
  invalid_key: 'badge-danger',
  rate_limited: 'badge-warning',
  timeout: 'badge-warning',
  unreachable: 'badge-danger',
  invalid_config: 'badge-danger',
  unsupported: 'badge-warning',
};

const Providers: React.FC = () => {
  const utils = trpc.useContext();
  const listQuery = trpc.providers.list.useQuery({});
  const serviceTypesQuery = trpc.providers.serviceTypes.useQuery();
  const knownProvidersQuery = trpc.providers.knownProviders.useQuery();

  const createMutation = trpc.providers.create.useMutation();
  const updateMutation = trpc.providers.update.useMutation();
  const removeMutation = trpc.providers.remove.useMutation();
  const testMutation = trpc.providers.test.useMutation();
  const setPriorityMutation = trpc.providers.setPriority.useMutation();
  const setEnabledMutation = trpc.providers.setEnabled.useMutation();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderRecord | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { status: string; message: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const [form, setForm] = useState({
    service: 'search' as ServiceType,
    name: '',
    providerId: 'custom',
    credentialType: 'api_key',
    credential: '',
    baseUrl: '',
    priority: '' as '' | 'primary' | 'fallback',
  });

  const providers = (listQuery.data ?? []) as ProviderRecord[];
  const serviceTypes = (serviceTypesQuery.data ?? []) as { id: ServiceType; label: string }[];
  const knownProviders = (knownProvidersQuery.data ?? []) as {
    id: string; name: string; serviceType: ServiceType; credentialType: string; envConfigured: boolean;
  }[];

  const reload = async () => {
    await utils.providers.list.invalidate();
    await utils.providers.knownProviders.invalidate();
  };

  const openAdd = (service: ServiceType) => {
    setEditing(null);
    setForm({ service, name: '', providerId: 'custom', credentialType: 'api_key', credential: '', baseUrl: '', priority: '' });
    setIsAddOpen(true);
  };

  const openEdit = (p: ProviderRecord) => {
    setEditing(p);
    setForm({
      service: p.service,
      name: p.name,
      providerId: p.providerId,
      credentialType: p.credentialType,
      credential: '',
      baseUrl: p.baseUrl || '',
      priority: p.priority || '',
    });
    setIsAddOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing) {
        await updateMutation.mutateAsync({
          id: editing.id,
          name: form.name,
          baseUrl: form.baseUrl || null,
          credential: form.credential || undefined,
          priority: form.priority || null,
        });
      } else {
        await createMutation.mutateAsync({
          service: form.service,
          name: form.name || (knownProviders.find((k) => k.id === form.providerId)?.name ?? 'Custom Provider'),
          providerId: form.providerId,
          credentialType: form.credentialType,
          credential: form.credential,
          baseUrl: form.baseUrl || undefined,
          priority: form.priority || null,
        });
      }
      await reload();
      setIsAddOpen(false);
    } catch (error: any) {
      alert(`Failed to save provider: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    setTestResults((prev) => ({ ...prev, [id]: { status: 'testing', message: 'Testing…' } }));
    try {
      const result = await testMutation.mutateAsync(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
      await reload();
    } catch (error: any) {
      setTestResults((prev) => ({ ...prev, [id]: { status: 'unreachable', message: error?.message || 'Test failed' } }));
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this provider credential? This cannot be undone.')) return;
    try {
      await removeMutation.mutateAsync(id);
      await reload();
    } catch (error: any) {
      alert(`Failed to remove provider: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleToggle = async (p: ProviderRecord) => {
    try {
      await setEnabledMutation.mutateAsync({ id: p.id, enabled: !p.enabled });
      await reload();
    } catch (error: any) {
      alert(`Failed to update provider: ${error?.message || 'Unknown error'}`);
    }
  };

  const handlePriority = async (p: ProviderRecord, priority: 'primary' | 'fallback' | null) => {
    try {
      await setPriorityMutation.mutateAsync({ id: p.id, priority });
      await reload();
    } catch (error: any) {
      alert(`Failed to set priority: ${error?.message || 'Unknown error'}`);
    }
  };

  const grouped = serviceTypes.map((st) => ({
    ...st,
    providers: providers.filter((p) => p.service === st.id),
    known: knownProviders.filter((k) => k.serviceType === st.id),
  }));


  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-white">Providers & API Keys</h2>
        <p className="text-sm text-neutral-400">Register, test and manage service providers. Credentials are encrypted at rest.</p>
      </div>

      {grouped.map((group) => (
        <div key={group.id} className="card-bold space-y-4">
          <div className="flex items-center justify-between border-b border-[#221c32] pb-2">
            <h3 className="text-base font-bold text-white">{group.label}</h3>
            <button onClick={() => openAdd(group.id)} className="btn-secondary py-1.5 px-3 text-xs">
              <Plus className="h-3.5 w-3.5" /><span>Add New API Key</span>
            </button>
          </div>

          {group.known.length > 0 && (
            <div className="text-xs text-neutral-500 space-y-1">
              {group.known.map((k) => (
                <div key={k.id} className="flex items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 text-purple-400" />
                  <span className="font-medium text-neutral-300">{k.name}</span>
                  <span className="text-neutral-500">— adapter available</span>
                  {k.envConfigured && <span className="badge-gray">env fallback configured</span>}
                </div>
              ))}
            </div>
          )}

          {group.providers.length === 0 ? (
            <p className="text-sm text-neutral-500">No credentials registered for this service.</p>
          ) : (
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>API Key</th>
                    <th>Status</th>
                    <th>Compatibility</th>
                    <th>Priority</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {group.providers.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div className="font-semibold text-white">{p.name}</div>
                        <div className="text-xs text-neutral-500">{p.providerId}</div>
                      </td>
                      <td className="font-mono text-xs text-neutral-300">{p.maskedCredential || '—'}</td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <span className={`status-indicator ${p.enabled ? 'green' : 'red'}`} />
                          <span className="text-xs">{p.enabled ? 'Enabled' : 'Disabled'}</span>
                        </div>
                        {p.connectionStatus !== 'untested' && (
                          <span className={`badge ${CONNECTION_BADGE[p.connectionStatus] || 'badge-gray'} text-[10px] mt-1 inline-block`}>{p.connectionStatus}</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${p.compatibilityStatus === 'compatible' ? 'badge-success' : 'badge-warning'}`}>
                          {p.compatibilityStatus === 'compatible' ? 'Compatible' : 'Adapter required'}
                        </span>
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <button onClick={() => handlePriority(p, p.priority === 'primary' ? null : 'primary')}
                            className={`text-xs px-2 py-1 rounded ${p.priority === 'primary' ? 'bg-purple-600 text-white' : 'bg-neutral-800 text-neutral-300'}`}>Primary</button>
                          <button onClick={() => handlePriority(p, p.priority === 'fallback' ? null : 'fallback')}
                            className={`text-xs px-2 py-1 rounded ${p.priority === 'fallback' ? 'bg-amber-600 text-white' : 'bg-neutral-800 text-neutral-300'}`}>Fallback</button>
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => handleTest(p.id)} disabled={testing === p.id} className="btn-secondary py-1.5 px-3 text-xs">{testing === p.id ? '…' : 'Test'}</button>
                          <button onClick={() => openEdit(p)} className="btn-secondary py-1.5 px-3 text-xs" title="Edit"><Edit3 className="h-3.5 w-3.5" /></button>
                          <button onClick={() => handleToggle(p)} className="btn-secondary py-1.5 px-3 text-xs" title={p.enabled ? 'Disable' : 'Enable'}><Power className="h-3.5 w-3.5" /></button>
                          <button onClick={() => handleDelete(p.id)} className="btn-secondary py-1.5 px-3 text-xs text-red-400" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                        {testResults[p.id] && testResults[p.id].status !== 'testing' && (
                          <div className={`text-[11px] mt-1 text-right ${testResults[p.id].status === 'connected' ? 'text-emerald-400' : 'text-red-400'}`}>
                            {testResults[p.id].status === 'connected' ? '✅ ' : '❌ '}{testResults[p.id].message}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}


      {isAddOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#221c32]">
              <h3 className="text-lg font-bold text-white">{editing ? 'Edit Provider' : 'Add New API Key'}</h3>
              <button onClick={() => setIsAddOpen(false)} className="text-neutral-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Provider Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Tavily, My Custom Search" required />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Service Type</label>
                <select value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value as ServiceType })} disabled={!!editing}>
                  {serviceTypes.map((st) => <option key={st.id} value={st.id}>{st.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Provider</label>
                <select value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
                  <option value="custom">Custom / no adapter yet</option>
                  {knownProviders.filter((k) => k.serviceType === form.service).map((k) => (
                    <option key={k.id} value={k.id}>{k.name}</option>
                  ))}
                </select>
                {form.providerId === 'custom' && (
                  <p className="text-[11px] text-amber-400 mt-1.5">⚠ This provider requires an adapter before SAO can use it.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">API Key / Credential</label>
                <input type="password" value={form.credential} onChange={(e) => setForm({ ...form, credential: e.target.value })}
                  placeholder={editing ? 'Leave blank to keep existing key' : 'sk-...'} required={!editing} />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">API Base URL (optional)</label>
                <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Priority</label>
                <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as any })}>
                  <option value="">None</option>
                  <option value="primary">Primary</option>
                  <option value="fallback">Fallback</option>
                </select>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#221c32]">
                <button type="button" onClick={() => setIsAddOpen(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-bold-primary">{editing ? 'Save Changes' : 'Add Provider'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Providers;
