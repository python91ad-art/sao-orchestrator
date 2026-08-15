import React, { useState, useEffect } from 'react';
import { RefreshCw, TrendingUp, Activity, Filter, Zap } from 'lucide-react';

const Analytics: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [analytics, setAnalytics] = useState<any>(null);
  const [funnel, setFunnel] = useState<any>(null);
  const [recentActivity, setRecentActivity] = useState<any[]>([]);

  const loadData = async () => {
    setLoading(true);
    setTimeout(() => {
      setAnalytics({
        gaps: { total: 42, deployed: 12, safe: 18, unsafe: 6, gray: 4, pending: 2 },
        queue: { total: 28, completed: 15, failed: 3, pending: 7, processing: 3, synthesis: 20, deployment: 5, audit: 3, maintenance: 0 },
        deployments: { total: 12, active: 8, paused: 3, stopped: 1, totalRevenue: 4580.50 },
        audits: { total: 38, safe: 18, unsafe: 6, gray: 4, false: 10 },
      });
      setFunnel({
        totalGaps: 42,
        queuedGaps: 28,
        classifiedGaps: 38,
        deployedGaps: 12,
        conversionRate: { toQueue: '66.7', toClassified: '82.1', toDeployed: '31.6' },
      });
      setRecentActivity([
        { id: '1', gapId: 'gap-1', decision: 'safe', banRisk: 'low', timestamp: new Date(Date.now() - 600000).toISOString() },
        { id: '2', gapId: 'gap-2', decision: 'unsafe', banRisk: 'high', timestamp: new Date(Date.now() - 1800000).toISOString() },
        { id: '3', gapId: 'gap-3', decision: 'gray', banRisk: 'medium', timestamp: new Date(Date.now() - 3600000).toISOString() },
        { id: '4', gapId: 'gap-1', decision: 'safe', banRisk: 'low', timestamp: new Date(Date.now() - 7200000).toISOString() },
        { id: '5', gapId: 'gap-4', decision: 'false', banRisk: 'low', timestamp: new Date(Date.now() - 10800000).toISOString() },
      ]);
      setLoading(false);
    }, 500);
  };

  useEffect(() => {
    loadData();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-[50vh]">
        <div className="spinner"></div>
      </div>
    );
  }

  const gapData = analytics?.gaps || {};
  const queueData = analytics?.queue || {};
  const deployData = analytics?.deployments || {};
  const auditData = analytics?.audits || {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Advanced Analytics</h2>
          <p className="text-sm text-neutral-400">Deep dive into orchestrator performance, funnel metrics, and system health</p>
        </div>
        <button onClick={loadData} className="btn-secondary">
          <RefreshCw className="h-4 w-4" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Top-Level Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card-bold p-5 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Total Revenue</p>
          <p className="text-2xl font-black text-white">${Number(deployData.totalRevenue || 0).toLocaleString()}</p>
          <p className="text-[10px] text-emerald-400 mt-1">↗ {deployData.active || 0} active deployments</p>
        </div>
        <div className="card-bold p-5 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Gaps Discovered</p>
          <p className="text-2xl font-black text-white">{gapData.total || 0}</p>
          <p className="text-[10px] text-purple-400 mt-1">{gapData.pending || 0} pending audit</p>
        </div>
        <div className="card-bold p-5 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Queue Processed</p>
          <p className="text-2xl font-black text-white">{queueData.completed || 0}/{queueData.total || 0}</p>
          <p className="text-[10px] text-blue-400 mt-1">{queueData.processing || 0} in progress</p>
        </div>
        <div className="card-bold p-5 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Success Rate</p>
          <p className="text-2xl font-black text-white">
            {queueData.total > 0 ? ((queueData.completed / queueData.total) * 100).toFixed(1) : '0.0'}%
          </p>
          <p className="text-[10px] text-red-400 mt-1">{queueData.failed || 0} failures</p>
        </div>
      </div>

      {/* Funnel */}
      <div className="card-bold p-6">
        <h3 className="text-sm font-bold uppercase tracking-wider text-purple-400 mb-4 flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> Gap-to-Deployment Funnel
        </h3>
        <div className="space-y-3">
          {[
            { label: 'Gaps Discovered', value: funnel?.totalGaps || 0, pct: 100, color: 'bg-purple-500/60' },
            { label: 'Queued for Processing', value: funnel?.queuedGaps || 0, pct: parseFloat(funnel?.conversionRate?.toQueue || '0'), color: 'bg-blue-500/60' },
            { label: 'Classified by AI', value: funnel?.classifiedGaps || 0, pct: parseFloat(funnel?.conversionRate?.toClassified || '0'), color: 'bg-amber-500/60' },
            { label: 'Deployed as Micro-startup', value: funnel?.deployedGaps || 0, pct: parseFloat(funnel?.conversionRate?.toDeployed || '0'), color: 'bg-emerald-500/60' },
          ].map((stage) => (
            <div key={stage.label} className="flex items-center gap-4">
              <span className="text-xs text-neutral-400 w-44 flex-shrink-0">{stage.label}</span>
              <div className="flex-1 h-8 bg-neutral-800/50 rounded-lg overflow-hidden relative">
                <div
                  className={`h-full ${stage.color} flex items-center justify-end pr-3 transition-all duration-500`}
                  style={{ width: `${Math.max(stage.pct, 5)}%` }}
                >
                  <span className="text-[11px] font-bold text-white">{stage.pct}%</span>
                </div>
              </div>
              <span className="text-sm font-black text-white w-8 text-right">{stage.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Gap Status Distribution + Audit Decisions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card-bold p-6">
          <h3 className="text-sm font-bold uppercase tracking-wider text-purple-400 mb-4">Gap Status Distribution</h3>
          <div className="space-y-3">
            {[
              { label: 'Deployed', value: gapData.deployed || 0, total: gapData.total || 1, color: 'bg-emerald-500/60' },
              { label: 'Safe', value: gapData.safe || 0, total: gapData.total || 1, color: 'bg-green-500/60' },
              { label: 'Pending', value: gapData.pending || 0, total: gapData.total || 1, color: 'bg-purple-500/60' },
              { label: 'Gray (Review)', value: gapData.gray || 0, total: gapData.total || 1, color: 'bg-amber-500/60' },
              { label: 'Unsafe', value: gapData.unsafe || 0, total: gapData.total || 1, color: 'bg-red-500/60' },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <span className="text-xs text-neutral-400 w-24">{item.label}</span>
                <div className="flex-1 h-6 bg-neutral-800/50 rounded overflow-hidden">
                  <div
                    className={`h-full ${item.color}`}
                    style={{ width: `${(item.value / item.total) * 100}%` }}
                  />
                </div>
                <span className="text-sm font-bold text-white w-8 text-right">{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card-bold p-6">
          <h3 className="text-sm font-bold uppercase tracking-wider text-purple-400 mb-4">AI Classification Results</h3>
          <div className="space-y-3">
            {[
              { label: 'Safe', value: auditData.safe || 0, total: auditData.total || 1, color: 'bg-emerald-500/60' },
              { label: 'Unsafe', value: auditData.unsafe || 0, total: auditData.total || 1, color: 'bg-red-500/60' },
              { label: 'Gray', value: auditData.gray || 0, total: auditData.total || 1, color: 'bg-amber-500/60' },
              { label: 'False', value: auditData.false || 0, total: auditData.total || 1, color: 'bg-neutral-500/60' },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <span className="text-xs text-neutral-400 w-24">{item.label}</span>
                <div className="flex-1 h-6 bg-neutral-800/50 rounded overflow-hidden">
                  <div
                    className={`h-full ${item.color}`}
                    style={{ width: `${(item.value / item.total) * 100}%` }}
                  />
                </div>
                <span className="text-sm font-bold text-white w-8 text-right">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Queue Type Breakdown */}
      <div className="card-bold p-6">
        <h3 className="text-sm font-bold uppercase tracking-wider text-purple-400 mb-4 flex items-center gap-2">
          <Filter className="h-4 w-4" /> Queue Type Breakdown
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-3 rounded-lg bg-neutral-800/30 border border-neutral-800">
            <Zap className="h-5 w-5 mx-auto text-purple-400 mb-2" />
            <p className="text-xl font-black text-white">{queueData.synthesis || 0}</p>
            <p className="text-[10px] text-neutral-400 uppercase">Synthesis</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-neutral-800/30 border border-neutral-800">
            <TrendingUp className="h-5 w-5 mx-auto text-blue-400 mb-2" />
            <p className="text-xl font-black text-white">{queueData.deployment || 0}</p>
            <p className="text-[10px] text-neutral-400 uppercase">Deployment</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-neutral-800/30 border border-neutral-800">
            <Activity className="h-5 w-5 mx-auto text-amber-400 mb-2" />
            <p className="text-xl font-black text-white">{queueData.audit || 0}</p>
            <p className="text-[10px] text-neutral-400 uppercase">Audit</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-neutral-800/30 border border-neutral-800">
            <RefreshCw className="h-5 w-5 mx-auto text-neutral-400 mb-2" />
            <p className="text-xl font-black text-white">{queueData.maintenance || 0}</p>
            <p className="text-[10px] text-neutral-400 uppercase">Maintenance</p>
          </div>
        </div>
      </div>

      {/* Recent Activity Feed */}
      <div className="card-bold p-6">
        <h3 className="text-sm font-bold uppercase tracking-wider text-purple-400 mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4" /> Recent Audit Activity
        </h3>
        <div className="space-y-2">
          {recentActivity.map((item) => (
            <div key={item.id} className="flex items-center gap-4 p-3 rounded-lg bg-neutral-800/20 border border-neutral-800/50">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                item.decision === 'safe' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' :
                item.decision === 'unsafe' ? 'bg-red-500/10 text-red-400 border border-red-500/30' :
                item.decision === 'gray' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' :
                'bg-neutral-500/10 text-neutral-400 border border-neutral-500/30'
              }`}>{item.decision}</span>
              <span className="text-xs text-neutral-400">Gap: {item.gapId}</span>
              <span className="text-xs text-neutral-500">Ban Risk: {item.banRisk}</span>
              <span className="text-xs text-neutral-500 ml-auto">
                {new Date(item.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Analytics;
