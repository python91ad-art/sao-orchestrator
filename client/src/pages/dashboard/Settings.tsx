import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Key, ShieldCheck, DollarSign, Bell } from 'lucide-react';
import { trpcQuery, trpcMutation } from '../../lib/trpc';
import { trpc } from '../../lib/trpc';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import SettingsPanels from './SettingsPanels';

const Settings: React.FC = () => {
  const [section, setSection] = useState('Core Loop & Automation');
  const [search, setSearch] = useState('');
  const [maintenanceReport, setMaintenanceReport] = useState<unknown>(null);
  const [dirtyGroups, setDirtyGroups] = useState<string[]>([]);
  const dirty = dirtyGroups.length > 0;
  const [loadError, setLoadError] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const clearDirty = (group: string) => setDirtyGroups(current => current.filter(value => value !== group));
  useUnsavedChanges(dirty);
  const sections = ['General & System', 'Core Loop & Automation', 'Queue & Workers', 'AI Agents & Reasoning', 'Budgets & Financial Controls', 'Security & Approvals', 'Notifications', 'Monitoring & Diagnostics', 'Data Management', 'Policies'];
  const resetPreview = trpc.policies.discoveryResetPreview.useQuery(undefined, { enabled: false });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // Retry Config state
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [backoffMultiplier, setBackoffMultiplier] = useState(1.5);
  const [baseDelayMs, setBaseDelayMs] = useState(5000);
  const [retrySaved, setRetrySaved] = useState(false);

  // Queue Limits state
  const [queueMaxSize, setQueueMaxSize] = useState(1000);
  const [queueExpirationHours, setQueueExpirationHours] = useState(72);
  const [queueSaved, setQueueSaved] = useState(false);

  // Concurrency state
  const [concurrencyLevel, setConcurrencyLevel] = useState(1);
  const [concurrencySaved, setConcurrencySaved] = useState(false);
  // Loop Settings
  const [intervalMs, setIntervalMs] = useState<number>(10800000);

  // Load authoritative runtime configuration from the backend.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const state: any = await trpcQuery('coreLoop.status');

        if (cancelled || !state) {
          return;
        }

        if (typeof state.intervalMs === 'number') {
          setIntervalMs(state.intervalMs);
        }

        if (state.maxCostPerDay !== undefined) {
          setMaxCost(Number(state.maxCostPerDay));
        }

        if (typeof state.maxDeployments === 'number') {
          setMaxDeployments(state.maxDeployments);
        }

        if (typeof state.autoPauseOnHighBanRisk === 'boolean') {
          setAutoPause(state.autoPauseOnHighBanRisk);
        }

        if (typeof state.emailNotifications === 'boolean') {
          setEmailNotify(state.emailNotifications);
        }

        if (typeof state.slackNotifications === 'boolean') {
          setSlackNotify(state.slackNotifications);
        }
      } catch (error) {
        console.error('[Settings] Failed to load runtime configuration:', error);
        setLoadError('Failed to load persisted runtime configuration.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadVersion]);

  // Load persisted concurrency configuration.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const value: any = await trpcQuery('settings.getConcurrency');

        if (!cancelled && typeof value?.concurrency === 'number') {
          setConcurrencyLevel(value.concurrency);
        }
      } catch (error) {
        console.error('[Settings] Failed to load concurrency:', error);
        setLoadError('Failed to load persisted concurrency.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadVersion]);

  // Load persisted retry configuration.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const value: any = await trpcQuery('settings.getRetryConfig');

        if (!cancelled && value) {
          if (typeof value.maxAttempts === 'number') {
            setMaxAttempts(value.maxAttempts);
          }
          if (typeof value.backoffMultiplier === 'number') {
            setBackoffMultiplier(value.backoffMultiplier);
          }
          if (typeof value.baseDelayMs === 'number') {
            setBaseDelayMs(value.baseDelayMs);
          }
        }
      } catch (error) {
        console.error('[Settings] Failed to load retry configuration:', error);
        setLoadError('Failed to load persisted retry configuration.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadVersion]);

  // Load persisted queue limits.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const value: any = await trpcQuery('settings.getQueueLimits');

        if (!cancelled && value) {
          if (typeof value.maxSize === 'number') {
            setQueueMaxSize(value.maxSize);
          }
          if (typeof value.expirationHours === 'number') {
            setQueueExpirationHours(value.expirationHours);
          }
        }
      } catch (error) {
        console.error('[Settings] Failed to load queue limits:', error);
        setLoadError('Failed to load persisted queue limits.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadVersion]);

  // Budgets
  const [maxCost, setMaxCost] = useState<number>(50.00);
  const [maxDeployments, setMaxDeployments] = useState<number>(10);
  const [autoPause, setAutoPause] = useState<boolean>(true);

  // Notifications
  const [emailNotify, setEmailNotify] = useState<boolean>(true);
  const [slackNotify, setSlackNotify] = useState<boolean>(false);

  const handleSave = async () => {
    try {
      // Runtime configuration is persisted by the backend.
      await trpcMutation('settings.save', {
        intervalMs,
        maxCostPerDay: maxCost,
        maxDeployments,
        autoPauseOnHighBanRisk: autoPause,
        emailNotifications: emailNotify,
        slackNotifications: slackNotify,
      });
      const state: any = await trpcQuery('coreLoop.status');
      if (state) {
        if (typeof state.intervalMs === 'number') setIntervalMs(state.intervalMs);
        if (state.maxCostPerDay !== undefined) setMaxCost(Number(state.maxCostPerDay));
        if (typeof state.maxDeployments === 'number') setMaxDeployments(state.maxDeployments);
        if (typeof state.autoPauseOnHighBanRisk === 'boolean') setAutoPause(state.autoPauseOnHighBanRisk);
        if (typeof state.emailNotifications === 'boolean') setEmailNotify(state.emailNotifications);
        if (typeof state.slackNotifications === 'boolean') setSlackNotify(state.slackNotifications);
      }

      clearDirty('configuration');
      alert('Settings saved and applied to the application.');
    } catch (error: any) {
      console.error('[Settings] Failed to save configuration:', error);
      alert(`Settings could not be saved: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleReset = async () => {
    setSection('Data Management');
    const result = await resetPreview.refetch();
    if (result.error) alert(result.error.message);
    else setMaintenanceReport(result.data);
  };

  if (loadError) return <section role="alert" className="card-bold"><p>{loadError}</p><p>Saved configuration could not be loaded. Reload before editing to avoid overwriting persisted values.</p><button className="btn-secondary" onClick={() => window.location.reload()}>Reload saved settings</button></section>;
  return (
    <div className="space-y-6" onChangeCapture={event => { const target = event.target as HTMLElement; if (!target.closest('[data-operational-panel]') && target.getAttribute('aria-label') !== 'Search settings') { const group = target.closest('[data-settings-group]')?.getAttribute('data-settings-group') || 'configuration'; setDirtyGroups(current => [...new Set([...current, group])]); } }}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Settings Control Center</h2>
          <p className="text-sm text-neutral-400">Configure orchestrator intervals, budgets, retries, and security</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={() => { if (!window.dispatchEvent(new Event('sao:before-navigation', { cancelable: true }))) return; setDirtyGroups([]); setReloadVersion(value => value + 1); }}>Restore all saved form values</button>
          <button onClick={handleReset} className="btn-secondary">
            <RotateCcw className="h-4 w-4" />
            <span>Preview Discovery Cleanup</span>
          </button>
          <button onClick={handleSave} className="btn-bold-primary">
            <Save className="h-4 w-4" />
            <span>Save Configuration</span>
          </button>
        </div>
      </div>

      <label className="block">Find settings<input aria-label="Search settings" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search settings categories" /></label>
      <nav aria-label="Settings categories" className="flex flex-wrap gap-2">{sections.filter(item => item.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item} className={section === item ? 'btn-bold-primary' : 'btn-secondary'} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>{item}</button>)}</nav>
      <h3 className="text-lg font-bold">{section}</h3>
      <SettingsPanels key={reloadVersion} section={section} />
      {section === 'Data Management' && <section className="card-bold space-y-3"><p>Preview candidate scope and protected business references before maintenance.</p><button className="btn-secondary" onClick={handleReset} disabled={resetPreview.isFetching}>Refresh cleanup preview</button>{maintenanceReport ? <pre className="overflow-auto text-xs">{JSON.stringify(maintenanceReport, null, 2)}</pre> : <p>No preview loaded.</p>}<p>Prepare a verified database backup and review exact protected-record counts in Operations → Maintenance before executing a scoped reset.</p></section>}
      <div className="grid grid-cols-1 gap-6">
        {/* Core Loop & Budgets */}
        <div className="space-y-6">
          {/* Core Loop Settings */}
          <div hidden={section !== 'Core Loop & Automation'} className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[var(--border)] pb-2">
              <ShieldCheck className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Orchestrator Execution Loop</h3>
            </div>
            <div>
              <label htmlFor="field-settings-1" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                Processing Interval (milliseconds)
              </label>
              <input id="field-settings-1"
                type="number"
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value))}
                placeholder="10800000"
              />
              <p className="text-[11px] text-neutral-500 mt-1.5">
                Default: 10,800,000ms (3 hours). Lower intervals increase API rate limit consumption.
              </p>
            </div>
          </div>

          {/* Budget Limits */}
          <div hidden={section !== 'Budgets & Financial Controls'} className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[var(--border)] pb-2">
              <DollarSign className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Budget Limits</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="field-settings-2" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Max Cost per Day ($)
                </label>
                <input id="field-settings-2"
                  type="number"
                  step="0.01"
                  value={maxCost}
                  onChange={(e) => setMaxCost(parseFloat(e.target.value) || 0)}
                  placeholder="50.00"
                />
              </div>
              <div>
                <label htmlFor="field-settings-3" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Max Active Deployments
                </label>
                <input id="field-settings-3"
                  type="number"
                  value={maxDeployments}
                  onChange={(e) => setMaxDeployments(parseInt(e.target.value) || 10)}
                  placeholder="10"
                />
              </div>
            </div>
            <div className="flex items-center justify-between pt-2">
              <div>
                <p className="text-sm font-medium text-white">Auto-pause on High Ban Risk</p>
                <p className="text-[11px] text-neutral-500">Automatically pauses deployments flagged with high ban risk</p>
              </div>
              <button
                onClick={() => setAutoPause(!autoPause)}
                className={`relative h-6 w-11 rounded-full transition-colors ${autoPause ? 'bg-purple-600' : 'bg-neutral-700'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${autoPause ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          </div>

          {/* Retry & Queue Settings */}
          <div hidden={section !== 'Queue & Workers'} className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[var(--border)] pb-2">
              <RotateCcw className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Retry & Queue Configuration</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="field-settings-4" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Max Attempts</label>
                <input id="field-settings-4" type="number" min="1" max="10" value={maxAttempts} data-settings-group="retry" onChange={(e) => setMaxAttempts(Number(e.target.value))} />
              </div>
              <div>
                <label htmlFor="field-settings-5" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Backoff Multiplier</label>
                <input id="field-settings-5" type="number" step="0.1" min="1" max="3" value={backoffMultiplier} data-settings-group="retry" onChange={(e) => setBackoffMultiplier(Number(e.target.value))} />
              </div>
              <div>
                <label htmlFor="field-settings-6" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Base Delay (ms)</label>
                <input id="field-settings-6" type="number" min="1000" max="60000" step="500" value={baseDelayMs} data-settings-group="retry" onChange={(e) => setBaseDelayMs(Number(e.target.value))} />
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  await trpcMutation('settings.retryConfig', {
                    maxAttempts,
                    backoffMultiplier,
                    baseDelayMs,
                  });
                  const value: any = await trpcQuery('settings.getRetryConfig');
                  if (value) {
                    if (typeof value.maxAttempts === 'number') setMaxAttempts(value.maxAttempts);
                    if (typeof value.backoffMultiplier === 'number') setBackoffMultiplier(value.backoffMultiplier);
                    if (typeof value.baseDelayMs === 'number') setBaseDelayMs(value.baseDelayMs);
                  }
                  setRetrySaved(true);
                  clearDirty('retry');
                  setTimeout(() => setRetrySaved(false), 2000);
                } catch (e: any) {
                  console.error('[Settings] Retry config save failed:', e);
                  alert(`Failed to save retry configuration: ${e?.message || 'Unknown error'}`);
                }
              }}
              className="btn-bold-primary"
            >
              <Save className="h-4 w-4" />
              <span>Save Retry Config</span>
            </button>
            {retrySaved && <span className="text-xs text-emerald-400 ml-2">✓ Saved</span>}
          </div>

          {/* Queue Limits */}
          <div hidden={section !== 'Queue & Workers'} className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[var(--border)] pb-2">
              <Key className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Queue Limits</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="field-settings-7" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Max Queue Size</label>
                <input id="field-settings-7" type="number" min="100" max="10000" value={queueMaxSize} data-settings-group="queue" onChange={(e) => setQueueMaxSize(Number(e.target.value))} />
              </div>
              <div>
                <label htmlFor="field-settings-8" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Expiration (hours)</label>
                <input id="field-settings-8" type="number" min="1" max="168" value={queueExpirationHours} data-settings-group="queue" onChange={(e) => setQueueExpirationHours(Number(e.target.value))} />
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  await trpcMutation('settings.queueLimits', {
                    maxSize: queueMaxSize,
                    expirationHours: queueExpirationHours,
                  });
                  const value: any = await trpcQuery('settings.getQueueLimits');
                  if (value) {
                    if (typeof value.maxSize === 'number') setQueueMaxSize(value.maxSize);
                    if (typeof value.expirationHours === 'number') setQueueExpirationHours(value.expirationHours);
                  }
                  setQueueSaved(true);
                  clearDirty('queue');
                  setTimeout(() => setQueueSaved(false), 2000);
                } catch (e: any) {
                  console.error('[Settings] Queue limits save failed:', e);
                  alert(`Failed to save queue limits: ${e?.message || 'Unknown error'}`);
                }
              }}
              className="btn-bold-primary"
            >
              <Save className="h-4 w-4" />
              <span>Save Queue Limits</span>
            </button>
            {queueSaved && <span className="text-xs text-emerald-400 ml-2">✓ Saved</span>}
          </div>
        </div>

        {/* Concurrency & Notifications */}
        <div className="space-y-6">
          {/* Concurrency */}
          <div hidden={section !== 'Queue & Workers'} className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[var(--border)] pb-2">
              <Key className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Worker Pool Concurrency</h3>
            </div>
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <label htmlFor="field-settings-9" className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Concurrency Level (1-10)
                </label>
                <input id="field-settings-9"
                  type="number"
                  min={1}
                  max={10}
                  value={concurrencyLevel}
                  data-settings-group="concurrency" onChange={(e) => setConcurrencyLevel(Number(e.target.value))}
                  className="w-32"
                />
              </div>
              <div className="flex-1 pt-5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      try {
                        await trpcMutation('settings.setConcurrency', {
                          level: concurrencyLevel,
                        });
                        const value: any = await trpcQuery('settings.getConcurrency');
                        if (typeof value?.concurrency === 'number') setConcurrencyLevel(value.concurrency);
                        setConcurrencySaved(true);
                        clearDirty('concurrency');
                        setTimeout(() => setConcurrencySaved(false), 2000);
                      } catch (e: any) {
                        console.error('[Settings] Concurrency save failed:', e);
                        alert(`Failed to save concurrency: ${e?.message || 'Network error'}`);
                      }
                    }}
                    className="btn-bold-primary"
                  >
                    Set Concurrency
                  </button>
                  {concurrencySaved && <span className="text-xs text-green-400">✓ Saved</span>}
                </div>
              </div>
            </div>
            {concurrencyLevel > 1 && (
              <p className="text-xs text-amber-400 mt-3">
                ⚠ Multiple workers will process gaps in parallel. Ensure this complies with the one-gap-at-a-time policy.
              </p>
            )}
          </div>

          {/* Notifications */}
          <div hidden={section !== 'Notifications'} className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[var(--border)] pb-2">
              <Bell className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Notifications</h3>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Email Notifications</p>
                <p className="text-[11px] text-neutral-500">Send audit alerts and critical events via Resend</p>
              </div>
              <button
                onClick={() => setEmailNotify(!emailNotify)}
                className={`relative h-6 w-11 rounded-full transition-colors ${emailNotify ? 'bg-purple-600' : 'bg-neutral-700'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${emailNotify ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Slack Notifications</p>
                <p className="text-[11px] text-neutral-500">Post audit alerts to a Slack channel</p>
              </div>
              <button
                onClick={() => setSlackNotify(!slackNotify)}
                className={`relative h-6 w-11 rounded-full transition-colors ${slackNotify ? 'bg-purple-600' : 'bg-neutral-700'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${slackNotify ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
