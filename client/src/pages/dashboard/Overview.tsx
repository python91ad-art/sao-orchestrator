import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  Search,
  List,
  Rocket,
  Play,
  Square,
  RefreshCw,
  Zap,
  Clock,
  ShieldCheck
} from 'lucide-react';
import { Gap, AuditLog, Stats } from '../../lib/trpc';
import { useWebSocket } from '../../hooks/useWebSocket';
import { trpc } from '../../lib/trpc'; // <-- added

const Overview: React.FC = () => {
  const [stats, setStats] = useState<Stats>({
    totalGaps: 0,
    activeDeployments: 0,
    queueItems: 0,
    totalRevenue: 0,
  });

  // 👇 Replaced fake state with real tRPC query
  const coreLoopStatusQuery = trpc.coreLoop.status.useQuery();

  // 👇 Real mutations for core loop controls
  const startLoop = trpc.coreLoop.start.useMutation();
  const stopLoop = trpc.coreLoop.stop.useMutation();
  const runOnce = trpc.coreLoop.runOnce.useMutation();
  const runAudit = trpc.coreLoop.runAudit.useMutation();

  const { connected: wsConnected, lastEvent } = useWebSocket();

  const [recentGaps, setRecentGaps] = useState<Gap[]>([]);
  const [recentAuditLogs, setRecentAuditLogs] = useState<AuditLog[]>([]);

   // Real dashboard data from the backend
  const analyticsQuery = trpc.analytics.overview.useQuery();
  const gapsQuery = trpc.gaps.list.useQuery({ limit: 3, skip: 0 });
  const auditLogsQuery = trpc.audit.list.useQuery({ limit: 3, skip: 0 });

  const loading =
    analyticsQuery.isLoading ||
    gapsQuery.isLoading ||
    auditLogsQuery.isLoading;

  const handleRefresh = async () => {
    await Promise.all([
      analyticsQuery.refetch(),
      gapsQuery.refetch(),
      auditLogsQuery.refetch(),
      coreLoopStatusQuery.refetch(),
    ]);
  };

  useEffect(() => {
    if (analyticsQuery.data) {
      setStats({
        totalGaps: analyticsQuery.data.totalGaps ?? 0,
        activeDeployments: analyticsQuery.data.activeDeployments ?? 0,
        queueItems: analyticsQuery.data.queue?.total ?? 0,
        totalRevenue: Number(analyticsQuery.data.totalRevenue ?? 0),
      });
    }

    if (gapsQuery.data) {
      setRecentGaps(gapsQuery.data);
    }

    if (auditLogsQuery.data) {
      setRecentAuditLogs(
        (auditLogsQuery.data ?? []).map(log => ({
          ...log,
          gapId: log.gapId ?? undefined,
          deploymentId: log.deploymentId ?? undefined,
          decision: log.decision as AuditLog["decision"],
        }))
      );
    }
  }, [
    analyticsQuery.data,
    gapsQuery.data,
    auditLogsQuery.data,
  ]);



  // 👇 Real action handlers using mutations WITH error handling
  const handleStartLoop = async () => {
    try {
      await startLoop.mutateAsync();
      await coreLoopStatusQuery.refetch();
    } catch (error: any) {
      console.error('[Overview] Failed to start core loop:', error);
      alert(`Failed to start core loop: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleStopLoop = async () => {
    try {
      await stopLoop.mutateAsync();
      await coreLoopStatusQuery.refetch();
    } catch (error: any) {
      console.error('[Overview] Failed to stop core loop:', error);
      alert(`Failed to stop core loop: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleRunOnce = async () => {
    try {
      await runOnce.mutateAsync();
    } catch (error: any) {
      console.error('[Overview] Failed to run once:', error);
      alert(`Failed to run once: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleRunAudit = async () => {
    try {
      await runAudit.mutateAsync();
    } catch (error: any) {
      console.error('[Overview] Failed to run audit:', error);
      alert(`Failed to run audit: ${error?.message || 'Unknown error'}`);
    }
  };


  // Derive core loop status from query result
  const coreLoopStatus = coreLoopStatusQuery.data ?? {
    isRunning: false,
    intervalMs: 0,
    lastExecutedAt: null,
    nextExecutionAt: null,
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
      {/* Real-time WebSocket Status */}
      <div className="flex items-center justify-end gap-2">
        <span className={`status-indicator ${wsConnected ? 'green' : 'red'}`} />
        <span className="text-xs text-neutral-400">
          {wsConnected ? 'Live (WebSocket)' : 'Offline (polling)'}
        </span>
        {lastEvent && (
          <span className="text-[10px] text-neutral-500 ml-2">
            Last event: {lastEvent.type}
          </span>
        )}
      </div>
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">System Overview</h2>
          <p className="text-sm text-neutral-400">Real-time telemetry and orchestrator loops</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRefresh} className="btn-secondary">
            <RefreshCw className="h-4 w-4" />
            <span>Refresh Telemetry</span>
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card-bold flex items-center gap-4">
          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <Search className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Total Gaps</p>
            <p className="text-2xl font-black text-white">{stats.totalGaps}</p>
          </div>
        </div>

        <div className="card-bold flex items-center gap-4">
          <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400">
            <Rocket className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Active Deployments</p>
            <p className="text-2xl font-black text-white">{stats.activeDeployments}</p>
          </div>
        </div>

        <div className="card-bold flex items-center gap-4">
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
            <List className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Queue Items</p>
            <p className="text-2xl font-black text-white">{stats.queueItems}</p>
          </div>
        </div>

        <div className="card-bold flex items-center gap-4">
          <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Total Revenue</p>
            <p className="text-2xl font-black text-white">${stats.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
        </div>
      </div>

      {/* Core Loop Controller Banner */}
      <div className="card-bold border border-purple-500/20 bg-gradient-to-r from-[#171424] to-[#110e1a]">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="p-3.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
              <Zap className="h-7 w-7" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-bold text-white">Core Orchestration Loop</h3>
                <div className="flex items-center gap-1.5">
                  <span className={`status-indicator ${coreLoopStatus.isRunning ? 'green' : 'red'}`}></span>
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                    {coreLoopStatus.isRunning ? 'Active & Teleporting' : 'Paused'}
                  </span>
                </div>
              </div>
              <p className="text-sm text-neutral-400 mt-1 max-w-xl">
                Automatically scrapes new gaps, filters for safety rules, builds execution plans, and spins up micro-workers.
              </p>
              <div className="flex items-center gap-4 mt-3 text-xs text-neutral-500">
                <div className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  <span>Interval: {coreLoopStatus.intervalMs / 3600000} hours</span>
                </div>
                <div className="flex items-center gap-1">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>Last Checked: {coreLoopStatus.lastExecutedAt ? new Date(coreLoopStatus.lastExecutedAt).toLocaleTimeString() : 'Never'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {coreLoopStatus.isRunning ? (
              <button onClick={handleStopLoop} className="btn-danger">
                <Square className="h-4 w-4 fill-white" />
                <span>Pause Loop</span>
              </button>
            ) : (
              <button onClick={handleStartLoop} className="btn-bold-primary">
                <Play className="h-4 w-4 fill-white" />
                <span>Start Loop</span>
              </button>
            )}
            <button onClick={handleRunOnce} className="btn-secondary">
              <Play className="h-4 w-4" />
              <span>Run Once Now</span>
            </button>
            <button onClick={handleRunAudit} className="btn-secondary">
              <ShieldCheck className="h-4 w-4" />
              <span>Force Safety Audit</span>
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Gaps Card */}
        <div className="card-bold flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#221c32]">
              <h3 className="text-base font-bold text-white">Recent Discovered Gaps</h3>
              <span className="text-xs text-neutral-400">Latest manual & stream scans</span>
            </div>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Asymmetric Match</th>
                    <th>Source</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentGaps.length > 0 ? (
                    recentGaps.map((gap) => (
                      <tr key={gap.id}>
                        <td className="max-w-[200px]">
                          <div className="font-semibold text-white truncate">{gap.knows}</div>
                          <div className="text-xs text-neutral-400 truncate mt-0.5">➔ {gap.needs}</div>
                        </td>
                        <td>
                          <span className="badge-gray">{gap.source}</span>
                        </td>
                        <td>
                          <span className={`badge-${
                            gap.status === 'deployed' ? 'success' :
                            gap.status === 'pending' ? 'primary' :
                            gap.status === 'safe' ? 'success' :
                            gap.status === 'unsafe' ? 'danger' : 'warning'
                          }`}>
                            {gap.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="text-center py-8 text-neutral-500">
                        No gaps found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Recent Audit Logs */}
        <div className="card-bold flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#221c32]">
              <h3 className="text-base font-bold text-white">Safety & Audit Loop</h3>
              <span className="text-xs text-neutral-400">LLM Guardrail enforcement</span>
            </div>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Decision</th>
                    <th>Reason / Safeguard</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {recentAuditLogs.length > 0 ? (
                    recentAuditLogs.map((log) => (
                      <tr key={log.id}>
                        <td>
                          <span className={`badge-${
                            log.decision === 'allow' ? 'success' :
                            log.decision === 'block' ? 'danger' : 'warning'
                          }`}>
                            {log.decision}
                          </span>
                        </td>
                        <td className="max-w-[220px]">
                          <div className="font-semibold text-white truncate">{log.explanation}</div>
                          <div className="text-xs text-neutral-400 truncate mt-0.5">{log.reasoning}</div>
                        </td>
                        <td>
                          <span className="text-xs text-neutral-500">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="text-center py-8 text-neutral-500">
                        No audit logs found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Overview;
