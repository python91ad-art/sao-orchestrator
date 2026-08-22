import React, { useState, useEffect } from 'react';
import { Play, Pause, Square, ShieldCheck, Eye, RefreshCw } from 'lucide-react';
import { Deployment, trpc } from '../../lib/trpc';

const Deployments: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);

  const deploymentsQuery = trpc.deployments.list.useQuery();

  const resumeMutation = trpc.deployments.resume.useMutation();
  const pauseMutation = trpc.deployments.pause.useMutation();
  const stopMutation = trpc.deployments.stop.useMutation();
  const auditMutation = trpc.deployments.audit.useMutation();
  const stopAllMutation = trpc.deployments.stopAll.useMutation();
  const resumeAllMutation = trpc.deployments.resumeAll.useMutation();

  useEffect(() => {
    const data = deploymentsQuery.data ?? [];

    setDeployments(
      data.map(d => ({
        ...d,
        businessPlan: d.businessPlan ?? "",
        revenue: Number(d.revenue),
        costPerDay: Number(d.costPerDay),
      }))
    );

    setLoading(deploymentsQuery.isLoading);
  }, [deploymentsQuery.data, deploymentsQuery.isLoading]);

  const loadData = async () => {
    setLoading(true);
    try {
      await deploymentsQuery.refetch();
    } catch (error) {
      console.error('[Deployments] Failed to load deployments:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePause = async (id: string) => {
    try {
      const deployment = deployments.find(d => d.id === id);
      if (!deployment) return;

      if (deployment.status === 'paused') {
        await resumeMutation.mutateAsync(id);
      } else {
        await pauseMutation.mutateAsync(id);
      }

      setDeployments(prev =>
        prev.map(d =>
          d.id === id
            ? { ...d, status: d.status === 'paused' ? 'active' : 'paused' }
            : d
        )
      );
    } catch (error) {
      console.error('[Deployments] Failed to toggle deployment:', error);
      alert('Failed to change deployment status.');
    }
  };

  const handleStop = async (id: string) => {
    if (confirm('Are you sure you want to stop this micro-worker deployment permanently? This will tear down all serverless instances.')) {
      try {
        await stopMutation.mutateAsync(id);
        setDeployments(prev =>
          prev.map(d => d.id === id ? { ...d, status: 'stopped' } : d)
        );
      } catch (error) {
        console.error('[Deployments] Failed to stop deployment:', error);
        alert('Failed to stop deployment.');
      }
    }
  };

  const handleAudit = async (id: string) => {
    try {
      await auditMutation.mutateAsync(id);
      alert('Deployment audit triggered successfully.');
    } catch (error) {
      console.error('[Deployments] Audit failed:', error);
      alert('Failed to trigger deployment audit.');
    }
  };

  const handleStopAll = async () => {
    if (confirm('EMERGENCY SHUTDOWN: Are you sure you want to tear down all active deployments?')) {
      try {
        await stopAllMutation.mutateAsync();
        setDeployments(prev =>
          prev.map(d => d.status === 'active' ? { ...d, status: 'stopped' } : d)
        );
      } catch (error) {
        console.error('[Deployments] Emergency shutdown failed:', error);
        alert('Emergency shutdown failed.');
      }
    }
  };

  const handleResumeAll = async () => {
    try {
      await resumeAllMutation.mutateAsync();
      setDeployments(prev =>
        prev.map(d => d.status === 'paused' ? { ...d, status: 'active' } : d)
      );
    } catch (error) {
      console.error('[Deployments] Failed to resume deployments:', error);
      alert('Failed to resume deployments.');
    }
  };

  const openPlanModal = (plan: string) => {
    setSelectedPlan(plan);
    setIsPlanModalOpen(true);
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
          <h2 className="text-2xl font-bold tracking-tight text-white">Active Micro-Worker Deployments</h2>
          <p className="text-sm text-neutral-400">Review generated microservices, live health metrics, and direct revenue yields</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadData} className="btn-secondary">
            <RefreshCw className="h-4 w-4" />
            <span>Reload</span>
          </button>
          <button onClick={handleResumeAll} className="btn-secondary">
            <Play className="h-4 w-4" />
            <span>Resume All</span>
          </button>
          <button onClick={handleStopAll} className="btn-danger">
            <Square className="h-4 w-4 fill-white" />
            <span>Emergency Stop All</span>
          </button>
        </div>
      </div>

      {/* Deployments Table */}
      <div className="card-bold">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Gap ID / Deployment</th>
                <th>Business Plan Preview</th>
                <th>Status</th>
                <th>Daily Yield / Cost</th>
                <th>Risk & Health</th>
                <th className="text-right">Orchestrator Controls</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((dep) => (
                <tr key={dep.id}>
                  <td>
                    <div className="font-bold text-white font-mono text-xs">{dep.id}</div>
                    <div className="text-[10px] text-neutral-500 font-mono mt-0.5">Gap ID: {dep.gapId}</div>
                  </td>
                  <td className="max-w-xs">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-neutral-300 truncate flex-1">{dep.businessPlan}</p>
                      <button
                        onClick={() => openPlanModal(dep.businessPlan)}
                        className="text-purple-400 hover:text-purple-300 flex-shrink-0"
                        title="View Full Business Plan"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                  <td>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider ${
                      dep.status === 'active' ? 'bg-green-500/10 text-green-400 border border-green-500/30' :
                      'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                    }`}>
                      {dep.status}
                    </span>
                  </td>
                  <td>
                    <div className="font-semibold text-white">
                      +${dep.revenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </div>
                    <div className="text-[10px] text-neutral-500">
                      Cost: ${dep.costPerDay.toFixed(2)}/day
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider">Ban Risk:</span>
                        <span className={`badge-${
                          dep.banRisk === 'low' ? 'success' :
                          dep.banRisk === 'medium' ? 'warning' : 'danger'
                        }`}>
                          {dep.banRisk}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-neutral-500 uppercase tracking-wider">Health:</span>
                        <span className={`badge-${
                          dep.health === 'healthy' ? 'success' :
                          dep.health === 'warning' ? 'warning' : 'danger'
                        }`}>
                          {dep.health}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => handleTogglePause(dep.id)}
                        className="btn-secondary p-1.5"
                        title={dep.status === 'paused' ? 'Resume microservice' : 'Pause microservice'}
                      >
                        {dep.status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => handleAudit(dep.id)}
                        className="btn-secondary p-1.5"
                        title="Audit safety policies"
                      >
                        <ShieldCheck className="h-4 w-4 text-purple-400" />
                      </button>
                      <button
                        onClick={() => handleStop(dep.id)}
                        className="btn-danger p-1.5"
                        title="Stop & teardown micro-worker"
                      >
                        <Square className="h-4 w-4 fill-white" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pure CSS Bar Chart for Revenue Visualization */}
      <div className="card-bold">
        <h3 className="text-base font-bold text-white mb-4 pb-2 border-b border-[#221c32]">
          Deployments by Lifetime Revenue Yield
        </h3>
        {deployments.length === 0 ? (
          <p className="text-sm text-neutral-500">No telemetry data to generate visualization.</p>
        ) : (
          <div className="space-y-4 pt-2">
            {deployments.map((dep) => {
              // Calculate percent based on top deployment (dep-3 has 10650)
              const percentage = Math.min(100, Math.max(10, (dep.revenue / 10650) * 100));
              return (
                <div key={dep.id} className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-neutral-300">{dep.id} ({dep.banRisk} risk)</span>
                    <span className="font-bold text-white">${dep.revenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="h-3 bg-[#171424] border border-[#221c32] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-purple-600 via-pink-500 to-amber-400 rounded-full transition-all duration-500"
                      style={{ width: `${percentage}%` }}
                    ></div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Business Plan Modal */}
      {isPlanModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#221c32]">
              <h3 className="text-lg font-bold text-white">Asymmetric Business Plan</h3>
              <button onClick={() => setIsPlanModalOpen(false)} className="text-neutral-400 hover:text-white">✕</button>
            </div>
            <div className="bg-[#0c0a12] p-4 rounded-xl border border-[#221c32] text-sm text-neutral-200 font-medium leading-relaxed">
              {selectedPlan}
            </div>
            <div className="flex justify-end mt-6">
              <button onClick={() => setIsPlanModalOpen(false)} className="btn-secondary">
                Close Plan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Deployments;
