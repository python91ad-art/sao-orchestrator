import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Key, ShieldCheck, DollarSign, Bell } from 'lucide-react';
import { trpcQuery, trpcMutation, type IntegrationTestResult } from '../../lib/trpc';
import { trpc } from '../../lib/trpc';

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

  // API Keys (Free APIs)
  const [groqKey, setGroqKey] = useState<string>(() => localStorage.getItem('sao_key_groq') || '');
  const [googleSearchKey, setGoogleSearchKey] = useState<string>(() => localStorage.getItem('sao_key_google_search') || '');
  const [googleSearchCx, setGoogleSearchCx] = useState<string>(() => localStorage.getItem('sao_key_google_cx') || '');
  const [githubKey, setGithubKey] = useState<string>(() => localStorage.getItem('sao_key_github') || '');
  const [slackKey, setSlackKey] = useState<string>(() => localStorage.getItem('sao_key_slack') || '');
  const [resendKey, setResendKey] = useState<string>(() => localStorage.getItem('sao_key_resend') || '');
  const [stripeKey, setStripeKey] = useState<string>(() => localStorage.getItem('sao_key_stripe') || '');

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

  const handleSave = async () => {
    try {
      // Browser-local API keys remain local.
      localStorage.setItem('sao_key_groq', groqKey);
      localStorage.setItem('sao_key_google_search', googleSearchKey);
      localStorage.setItem('sao_key_google_cx', googleSearchCx);
      localStorage.setItem('sao_key_github', githubKey);
      localStorage.setItem('sao_key_slack', slackKey);
      localStorage.setItem('sao_key_resend', resendKey);
      localStorage.setItem('sao_key_stripe', stripeKey);

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
  const handleTestConnection = async (name: string) => {
    setTesting(name);
    setTestResults(prev => ({ ...prev, [name]: null }));

    try {
      const procedureMap: Record<string, string> = {
        'Groq': 'integrations.testGroq',
        'Google Search': 'integrations.testGoogleSearch',
        'GitHub': 'integrations.testGitHub',
        'Slack': 'integrations.testSlack',
        'Resend': 'integrations.testResend',
        'Stripe': 'integrations.testStripe',
        'Vercel': 'integrations.testVercel',
        'NOWPayments': 'integrations.testNowPayments',
        'LLM Router': 'integrations.testLLMRouter',
      };

      const procedure = procedureMap[name];
      if (!procedure) {
        setTestResults(prev => ({ ...prev, [name]: { success: false, message: 'Unknown service.' } }));
        return;
      }

      const result = await trpcQuery<IntegrationTestResult>(procedure);
      setTestResults(prev => ({
        ...prev,
        [name]: {
          success: result.success,
          message: result.message || (result.success ? 'Connected successfully.' : 'Connection failed.'),
        }
      }));
    } catch (error: any) {
      setTestResults(prev => ({
        ...prev,
        [name]: { success: false, message: error.message || 'Connection failed. Is the server running?' }
      }));
    } finally {
      setTesting(null);
    }
  };

  // ==========================================
  // REUSABLE TEST UI COMPONENTS
  // ==========================================

  const TestButton = ({ name, fullWidth = false }: { name: string; fullWidth?: boolean }) => (
    <button
      type="button"
      onClick={() => handleTestConnection(name)}
      disabled={testing === name}
      className="btn-secondary py-2.5 px-3.5"
      style={fullWidth ? { width: '100%' } : {}}
    >
      {testing === name ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="spinner" style={{ width: '14px', height: '14px' }} />
          Testing...
        </span>
      ) : (
        'Test'
      )}
    </button>
  );

  const TestResult = ({ name }: { name: string }) => {
    const result = testResults[name];
    if (!result) return null;
    return (
      <p className={`text-[11px] mt-1.5 ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
        {result.success ? '✅ ' : '❌ '}{result.message}
      </p>
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

          {/* Free API Keys */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <Key className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Free API Keys</h3>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Groq API Key (Free LLM)</label>
                <div className="flex gap-2">
                  <input type="password" value={groqKey} onChange={(e) => setGroqKey(e.target.value)} placeholder="gsk_..." className="flex-1" />
                  <TestButton name="Groq" />
                </div>
                <TestResult name="Groq" />
                <p className="text-[11px] text-neutral-500 mt-1">Get free key at console.groq.com/keys</p>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">LLM Router (multi-provider)</label>
                <div className="flex gap-2">
                  <input type="text" value="" readOnly placeholder="Configured via GROQ/CEREBRAS/GEMINI/OPENROUTER env vars" className="flex-1 bg-[#0c0a12] text-neutral-500 text-sm" />
                  <TestButton name="LLM Router" />
                </div>
                <TestResult name="LLM Router" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Google Search API Key</label>
                <input type="password" value={googleSearchKey} onChange={(e) => setGoogleSearchKey(e.target.value)} placeholder="AIza..." />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Google Search CX (Engine ID)</label>
                <div className="flex gap-2">
                  <input type="text" value={googleSearchCx} onChange={(e) => setGoogleSearchCx(e.target.value)} placeholder="your_search_engine_id" className="flex-1" />
                  <TestButton name="Google Search" />
                </div>
                <TestResult name="Google Search" />
                <p className="text-[11px] text-neutral-500 mt-1">100 free queries/day via Google Custom Search API</p>
              </div>
            </div>
          </div>

          {/* Integration Keys */}
          <div className="card-bold space-y-4">
            <div className="flex items-center gap-3 border-b border-[#221c32] pb-2">
              <Key className="h-5 w-5 text-purple-400" />
              <h3 className="text-base font-bold text-white">Integrations (All Free)</h3>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">GitHub Token</label>
                <div className="flex gap-2">
                  <input type="password" value={githubKey} onChange={(e) => setGithubKey(e.target.value)} placeholder="ghp_..." className="flex-1" />
                  <TestButton name="GitHub" />
                </div>
                <TestResult name="GitHub" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Slack Bot Token</label>
                <div className="flex gap-2">
                  <input type="password" value={slackKey} onChange={(e) => setSlackKey(e.target.value)} placeholder="xoxb-..." className="flex-1" />
                  <TestButton name="Slack" />
                </div>
                <TestResult name="Slack" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Resend API Key</label>
                <div className="flex gap-2">
                  <input type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder="re_..." className="flex-1" />
                  <TestButton name="Resend" />
                </div>
                <TestResult name="Resend" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Stripe Secret Key</label>
                <div className="flex gap-2">
                  <input type="password" value={stripeKey} onChange={(e) => setStripeKey(e.target.value)} placeholder="sk_live_..." className="flex-1" />
                  <TestButton name="Stripe" />
                </div>
                <TestResult name="Stripe" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Vercel Deployment</label>
                <div className="flex gap-2">
                  <input type="text" value="" readOnly placeholder="Configured via VERCEL_API_TOKEN env var" className="flex-1 bg-[#0c0a12] text-neutral-500 text-sm" />
                  <TestButton name="Vercel" />
                </div>
                <TestResult name="Vercel" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">NOWPayments (Crypto)</label>
                <div className="flex gap-2">
                  <input type="text" value="" readOnly placeholder="Configured via NOWPAYMENTS_API_KEY / NOWPAYMENTS_IPN_SECRET env vars" className="flex-1 bg-[#0c0a12] text-neutral-500 text-sm" />
                  <TestButton name="NOWPayments" />
                </div>
                <TestResult name="NOWPayments" />
              </div>
            </div>
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
