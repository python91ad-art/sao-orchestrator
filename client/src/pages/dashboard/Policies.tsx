import React, { useState, useEffect } from 'react';
import { Plus, Check, Trash2, ShieldCheck, AlertCircle } from 'lucide-react';
import { Policy } from '../../lib/trpc';

const Policies: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [ruleText, setRuleText] = useState('');

  const loadData = async () => {
    setLoading(true);
    setTimeout(() => {
      setPolicies([
        {
          id: 'p-1',
          ruleText: 'The bot must never perform high-frequency scraping on systems with explicit robot.txt bans or standard API limitations.',
          createdAt: new Date(Date.now() - 3600000 * 24 * 30).toISOString(),
          acknowledgedAt: new Date(Date.now() - 3600000 * 24 * 29).toISOString()
        },
        {
          id: 'p-2',
          ruleText: 'No synthesized microservices may perform payments, trade executions, or financial clearing without human manual override approval.',
          createdAt: new Date(Date.now() - 3600000 * 24 * 10).toISOString(),
          acknowledgedAt: new Date(Date.now() - 3600000 * 24 * 9).toISOString()
        },
        {
          id: 'p-3',
          ruleText: 'Scraper agents must identify themselves using designated user-agent strings conforming to ethical research guidelines.',
          createdAt: new Date(Date.now() - 3600000 * 5).toISOString(),
          acknowledgedAt: undefined // Pending Acknowledgment
        }
      ]);
      setLoading(false);
    }, 400);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddPolicy = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleText.trim()) return;

    const newPolicy: Policy = {
      id: `p-${Date.now()}`,
      ruleText,
      createdAt: new Date().toISOString()
    };

    setPolicies([newPolicy, ...policies]);
    setIsAddModalOpen(false);
    setRuleText('');
  };

  const handleAcknowledge = (id: string) => {
    setPolicies(policies.map(p => {
      if (p.id === id) {
        return {
          ...p,
          acknowledgedAt: new Date().toISOString()
        };
      }
      return p;
    }));
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to remove this policy restriction? Removing policy constraints can significantly increase system execution risks.')) {
      setPolicies(policies.filter(p => p.id !== id));
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-[50vh]">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Ethical Guardrails & Policies</h2>
          <p className="text-sm text-neutral-400">Establish safety constraints, rate-limit policies, and custom compliance check rules</p>
        </div>
        <button onClick={() => setIsAddModalOpen(true)} className="btn-bold-primary">
          <Plus className="h-4 w-4" />
          <span>Add Custom Guardrail</span>
        </button>
      </div>

      {/* Main Table */}
      <div className="card-bold">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Rule Constraint Description</th>
                <th>Established Date</th>
                <th>Acknowledge Status</th>
                <th className="text-right">Policy Controls</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => {
                const isAcknowledged = !!policy.acknowledgedAt;
                return (
                  <tr key={policy.id} className={!isAcknowledged ? 'bg-amber-500/5' : ''}>
                    <td className="max-w-lg">
                      <div className="flex items-start gap-3">
                        {!isAcknowledged && (
                          <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                        )}
                        <span className={`text-sm ${!isAcknowledged ? 'text-amber-200 font-semibold' : 'text-neutral-300'}`}>
                          {policy.ruleText}
                        </span>
                      </div>
                    </td>
                    <td className="text-xs text-neutral-400">
                      {new Date(policy.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      {isAcknowledged ? (
                        <div className="flex items-center gap-1.5 text-green-400">
                          <Check className="h-4 w-4" />
                          <span className="text-xs font-semibold uppercase tracking-wider">
                            Verified ({new Date(policy.acknowledgedAt!).toLocaleDateString()})
                          </span>
                        </div>
                      ) : (
                        <span className="badge-warning">Pending Review</span>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {!isAcknowledged && (
                          <button
                            onClick={() => handleAcknowledge(policy.id)}
                            className="btn-bold-primary py-1.5 px-3 text-xs"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            <span>Acknowledge</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(policy.id)}
                          className="btn-secondary py-1.5 px-3 text-xs text-red-400 hover:bg-red-500/5 hover:border-red-500/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Policy Modal */}
      {isAddModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#221c32]">
              <h3 className="text-lg font-bold text-white">Add Ethical Guardrail</h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-neutral-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleAddPolicy} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Policy Constraint / System Rule Text
                </label>
                <textarea
                  required
                  rows={4}
                  value={ruleText}
                  onChange={(e) => setRuleText(e.target.value)}
                  placeholder="e.g. Scrapers must enforce a minimum jitter delay of 500ms between calls to avoid API request bursts."
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-[#221c32]">
                <button type="button" onClick={() => setIsAddModalOpen(false)} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-bold-primary">
                  Activate Policy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Policies;
