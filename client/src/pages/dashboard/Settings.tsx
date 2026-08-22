import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Key, ShieldCheck, DollarSign, Bell, Trash2, Power, PowerOff } from 'lucide-react';
import { trpcQuery, trpcMutation, type IntegrationTestResult } from '../../lib/trpc';
import { trpc } from '../../lib/trpc';

type CredentialService = 'groq' | 'google-search' | 'github' | 'stripe' | 'resend' | 'slack' | 'tavily';

interface CredentialStatus {
  service: CredentialService;
  configured: boolean;
  enabled: boolean;
  updatedAt: string | null;
}

const credentialDefinitions: Array<{
  service: CredentialService;
  label: string;
  placeholder: string;
  secondaryLabel?: string;
  secondaryPlaceholder?: string;
}> = [
  { service: 'groq', label: 'Groq', placeholder: 'gsk_...' },
  {
    service: 'google-search',
    label: 'Google Search',
    placeholder: 'AIza...',
    secondaryLabel: 'Search CX',
    secondaryPlaceholder: 'Search engine ID',
  },
  { service: 'github', label: 'GitHub', placeholder: 'ghp_...' },
  { service: 'stripe', label: 'Stripe', placeholder: 'sk_live_...' },
  { service: 'resend', label: 'Resend', placeholder: 're_...' },
  { service: 'slack', label: 'Slack', placeholder: 'xoxb-...' },
  { service: 'tavily', label: 'Tavily', placeholder: 'tvly-...' },
];

const Settings: React.FC = () => {
  const resetOperationalDataMutation = trpc.coreLoop.resetOperationalData.useMutation();
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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Budgets
  const [maxCost, setMaxCost] = useState<number>(50.00);
  const [maxDeployments, setMaxDeployments] = useState<number>(10);
  const [autoPause, setAutoPause] = useState<boolean>(true);

  // Notifications
  const [emailNotify, setEmailNotify] = useState<boolean>(true);
  const [slackNotify, setSlackNotify] = useState<boolean>(false);

  // Test connection states
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, IntegrationTestResult | null>>({});
  const [credentialStatuses, setCredentialStatuses] = useState<CredentialStatus[]>([]);
  const [credentialInputs, setCredentialInputs] = useState<Record<string, string>>({});
  const [credentialSecondaryInputs, setCredentialSecondaryInputs] = useState<Record<string, string>>({});
  const [credentialBusy, setCredentialBusy] = useState<string | null>(null);
  const [credentialMessage, setCredentialMessage] = useState<string | null>(null);

  const loadCredentialStatuses = async () => {
    const statuses = await trpcQuery<CredentialStatus[]>('settings.credentials.list');
    setCredentialStatuses(statuses);
  };

  useEffect(() => {
    loadCredentialStatuses().catch((error) => {
      console.error('[Settings] Failed to load credential status:', error);
    });
  }, []);

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

      alert('Settings saved and applied to the application.');
    } catch (error: any) {
      console.error('[Settings] Failed to save configuration:', error);
      alert(`Settings could not be saved: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleReset = async () => {
    if (!confirm(
      'RESET OPERATIONAL DATA?\\n\\n' +
      'This will permanently delete all gaps, queue items, deployments, audit logs, health checks, and recurring actors.\\n\\n' +
      'Users, policies, invitations, and application configuration will be preserved.\\n\\n' +
      'This action cannot be undone.'
    )) {
      return;
    }

    try {
      await resetOperationalDataMutation.mutateAsync();

      const defaults = {
        intervalMs: 10800000,
        maxCost: 50.00,
        maxDeployments: 10,
        autoPause: true,
        emailNotify: true,
        slackNotify: false,
      };

      setIntervalMs(defaults.intervalMs);
      setMaxCost(defaults.maxCost);
      setMaxDeployments(defaults.maxDeployments);
      setAutoPause(defaults.autoPause);
      setEmailNotify(defaults.emailNotify);
      setSlackNotify(defaults.slackNotify);

      alert('Operational data reset successfully. Runtime state restored to defaults.');
    } catch (error: any) {
      console.error('[Settings] Failed to reset operational data:', error);
      alert(`Operational reset failed: ${error?.message || 'Unknown error'}`);
    }
  };

  // ==========================================
  // TEST CONNECTION HANDLER
  // ==========================================
  const handleSetCredential = async (service: CredentialService) => {
    const definition = credentialDefinitions.find(item => item.service === service);
    const value = credentialInputs[service]?.trim() || '';
    const secondaryValue = credentialSecondaryInputs[service]?.trim() || '';

    if (!value || (definition?.secondaryLabel && !secondaryValue)) {
      setCredentialMessage('Enter the required credential fields before saving.');
      return;
    }

    try {
      setCredentialBusy(service);
      await trpcMutation('settings.credentials.set', {
        service,
        value,
        secondaryValue: definition?.secondaryLabel ? secondaryValue : undefined,
      });
      setCredentialInputs(prev => ({ ...prev, [service]: '' }));
      setCredentialSecondaryInputs(prev => ({ ...prev, [service]: '' }));
      setCredentialMessage(`${definition?.label || service} credential saved.`);
      await loadCredentialStatuses();
    } catch (error: any) {
      setCredentialMessage(error?.message || 'Credential could not be saved.');
    } finally {
      setCredentialBusy(null);
    }
  };

  const handleRemoveCredential = async (service: CredentialService) => {
    const definition = credentialDefinitions.find(item => item.service === service);
    if (!confirm(`Remove the ${definition?.label || service} credential? Environment fallback may still apply if configured.`)) {
      return;
    }

    try {
      setCredentialBusy(service);
      await trpcMutation('settings.credentials.remove', { service });
      setCredentialMessage(`${definition?.label || service} credential removed.`);
      await loadCredentialStatuses();
    } catch (error: any) {
      setCredentialMessage(error?.message || 'Credential could not be removed.');
    } finally {
      setCredentialBusy(null);
    }
  };

  const handleToggleCredential = async (service: CredentialService, enabled: boolean) => {
    const definition = credentialDefinitions.find(item => item.service === service);

    try {
      setCredentialBusy(service);
      await trpcMutation(enabled ? 'settings.credentials.disable' : 'settings.credentials.enable', { service });
      setCredentialMessage(`${definition?.label || service} credential ${enabled ? 'disabled' : 'enabled'}.`);
      await loadCredentialStatuses();
    } catch (error: any) {
      setCredentialMessage(error?.message || 'Credential status could not be changed.');
    } finally {
      setCredentialBusy(null);
    }
  };

  const handleTestConnection = async (service: CredentialService) => {
    setTesting(service);
    setTestResults(prev => ({ ...prev, [service]: null }));

    try {
      const result = await trpcMutation<IntegrationTestResult>('settings.credentials.test', { service });
      setTestResults(prev => ({
        ...prev,
        [service]: {
          success: result.success,
          message: result.message || (result.success ? 'Connected successfully.' : 'Connection failed.'),
        }
      }));
    } catch (error: any) {
      setTestResults(prev => ({
        ...prev,
        [service]: { success: false, message: error.message || 'Connection failed. Is the server running?' }
      }));
    } finally {
      setTesting(null);
    }
  };

  // ==========================================
  // REUSABLE TEST UI COMPONENTS
  // ==========================================

  const TestButton = ({ service }: { service: CredentialService }) => (
    <button
      type="button"
      onClick={() => handleTestConnection(service)}
      disabled={testing === service || credentialBusy === service}
      className="btn-secondary py-2.5 px-3.5"
    >
      {testing === service ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="spinner" style={{ width: '14px', height: '14px' }} />
          Testing...
        </span>
      ) : (
        'Test'
      )}
    </button>
  );

  const TestResult = ({ service }: { service: CredentialService }) => {
    const result = testResults[service];
    if (!result) return null;
    return (
      <p className={`text-[11px] mt-1.5 ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
        {result.success ? 'Success: ' : 'Failed: '}{result.message}
      </p>
    );
  };

  const CredentialCard = ({ definition }: { definition: typeof credentialDefinitions[number] }) => {
    const status = credentialStatuses.find(item => item.service === definition.service);
    const isBusy = credentialBusy === definition.service;
    const inputValue = credentialInputs[definition.service] || '';
    const secondaryValue = credentialSecondaryInputs[definition.service] || '';

    return (
      <div className="rounded-md border border-[#221c32] bg-[#111018] p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">{definition.label}</p>
            <p className={`text-xs mt-1 ${status?.configured ? 'text-emerald-400' : 'text-neutral-500'}`}>
              {status?.configured ? 'Configured' : 'Not configured'}
              {status?.configured && !status.enabled ? ' • Disabled' : ''}
            </p>
            <p className="text-[11px] text-neutral-500 mt-1">
              Updated: {status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : 'Never'}
            </p>
          </div>
          {status?.configured && (
            <button
              type="button"
              onClick={() => handleToggleCredential(definition.service, Boolean(status.enabled))}
              disabled={isBusy}
              className="btn-secondary py-2 px-3"
              title={status.enabled ? 'Disable credential' : 'Enable credential'}
            >
              {status.enabled ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
            </button>
          )}
        </div>

        <div className="space-y-2">
          <input
            type="password"
            value={inputValue}
            onChange={(e) => setCredentialInputs(prev => ({ ...prev, [definition.service]: e.target.value }))}
            placeholder={status?.configured ? 'Enter replacement credential' : definition.placeholder}
          />
          {definition.secondaryLabel && (
            <input
              type="password"
              value={secondaryValue}
              onChange={(e) => setCredentialSecondaryInputs(prev => ({ ...prev, [definition.service]: e.target.value }))}
              placeholder={status?.configured ? `Enter replacement ${definition.secondaryLabel}` : definition.secondaryPlaceholder}
            />
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleSetCredential(definition.service)}
            disabled={isBusy}
            className="btn-bold-primary py-2 px-3"
          >
            {status?.configured ? 'Replace' : 'Add'}
          </button>
          <TestButton service={definition.service} />
          {status?.configured && (
            <button
              type="button"
              onClick={() => handleRemoveCredential(definition.service)}
              disabled={isBusy}
              className="btn-secondary py-2 px-3"
              title="Remove credential"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
        <TestResult service={definition.service} />
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">System Settings</h2>
          <p className="text-sm text-neutral-400">Configure free API keys, orchestrator intervals, budgets, and security</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleReset} className="btn-secondary">
            <RotateCcw className="h-4 w-4" />
            <span>Reset Operational Data</span>
          </button>
          <button onClick={handleSave} className="btn-bold-primary">
            <Save className="h-4 w-4" />
            <span>Save Configuration</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Core Loop & Budgets */}
        <div className="space-y-6">
          {/* Core Loop Settings */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <ShieldCheck className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Orchestrator Execution Loop</h3>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                Processing Interval (milliseconds)
              </label>
              <input
                type="number"
                value={intervalMs}
                onChange={(e) => setIntervalMs(parseInt(e.target.value) || 10800000)}
                placeholder="10800000"
              />
              <p className="text-[11px] text-neutral-500 mt-1.5">
                Default: 10,800,000ms (3 hours). Lower intervals increase API rate limit consumption.
              </p>
            </div>
          </div>

          {/* Budget Limits */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <DollarSign className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Budget Limits</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Max Cost per Day ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={maxCost}
                  onChange={(e) => setMaxCost(parseFloat(e.target.value) || 0)}
                  placeholder="50.00"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Max Active Deployments
                </label>
                <input
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
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <RotateCcw className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Retry & Queue Configuration</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Max Attempts</label>
                <input type="number" min="1" max="10" value={maxAttempts} onChange={(e) => setMaxAttempts(parseInt(e.target.value) || 3)} />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Backoff Multiplier</label>
                <input type="number" step="0.1" min="1" max="3" value={backoffMultiplier} onChange={(e) => setBackoffMultiplier(parseFloat(e.target.value) || 1.5)} />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Base Delay (ms)</label>
                <input type="number" min="1000" max="60000" step="500" value={baseDelayMs} onChange={(e) => setBaseDelayMs(parseInt(e.target.value) || 5000)} />
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  const res = await fetch('/api/trpc/settings.retryConfig', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      maxAttempts,
                      backoffMultiplier,
                      baseDelayMs,
                    }),
                  });

                  if (!res.ok) {
                    throw new Error(`Retry configuration save failed (${res.status})`);
                  }

                  setRetrySaved(true);
                  setTimeout(() => setRetrySaved(false), 2000);
                } catch (e) { console.error(e); }
              }}
              className="btn-bold-primary"
            >
              <Save className="h-4 w-4" />
              <span>Save Retry Config</span>
            </button>
            {retrySaved && <span className="text-xs text-emerald-400 ml-2">✓ Saved</span>}
          </div>

          {/* Queue Limits */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <Key className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Queue Limits</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Max Queue Size</label>
                <input type="number" min="100" max="10000" value={queueMaxSize} onChange={(e) => setQueueMaxSize(parseInt(e.target.value) || 1000)} />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Expiration (hours)</label>
                <input type="number" min="1" max="168" value={queueExpirationHours} onChange={(e) => setQueueExpirationHours(parseInt(e.target.value) || 72)} />
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  const res = await fetch('/api/trpc/settings.queueLimits', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      maxSize: queueMaxSize,
                      expirationHours: queueExpirationHours,
                    }),
                  });

                  if (!res.ok) {
                    throw new Error(`Queue configuration save failed (${res.status})`);
                  }

                  setQueueSaved(true);
                  setTimeout(() => setQueueSaved(false), 2000);
                } catch (e) { console.error(e); }
              }}
              className="btn-bold-primary"
            >
              <Save className="h-4 w-4" />
              <span>Save Queue Limits</span>
            </button>
            {queueSaved && <span className="text-xs text-emerald-400 ml-2">✓ Saved</span>}
          </div>
        </div>

        {/* API Keys & Concurrency */}
        <div className="space-y-6">
          {/* Concurrency */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <Key className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Worker Pool Concurrency</h3>
            </div>
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Concurrency Level (1-10)
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={concurrencyLevel}
                  onChange={(e) => setConcurrencyLevel(Number(e.target.value))}
                  className="w-32"
                />
              </div>
              <div className="flex-1 pt-5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch('/api/trpc/settings.setConcurrency', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ level: concurrencyLevel }),
                        });
                        if (res.ok) setConcurrencySaved(true);
                      } catch (e) { console.error(e); }
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

          {/* Integration Credentials */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <Key className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Integration Credentials</h3>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {credentialDefinitions.map(definition => (
                <CredentialCard key={definition.service} definition={definition} />
              ))}
            </div>
            {credentialMessage && (
              <p className="text-xs text-neutral-300">{credentialMessage}</p>
            )}
          </div>

          {/* Notifications */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
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
