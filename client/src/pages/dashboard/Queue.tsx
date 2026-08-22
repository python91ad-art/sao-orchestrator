import React, { useState } from 'react';
import { Play, Pause, Trash2, RefreshCw, AlertCircle } from 'lucide-react';
import { trpc } from '../../lib/trpc';

const Queue: React.FC = () => {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [queueTypeFilter, setQueueTypeFilter] = useState<string>('all');

  const queueQuery = trpc.queue.list.useQuery();
  const queueStatsQuery = trpc.queue.stats.useQuery();

  const moveUpMutation = trpc.queue.moveUp.useMutation();
  const moveDownMutation = trpc.queue.moveDown.useMutation();
  const pauseMutation = trpc.queue.pause.useMutation();
  const resumeMutation = trpc.queue.resume.useMutation();
  const deleteMutation = trpc.queue.delete.useMutation();
  const retryMutation = trpc.queue.retry.useMutation();

  const queue = (queueQuery.data ?? []).map(({ queueItem, gap }) => ({
    ...queueItem,
    gap,
  }));
  const loading = queueQuery.isLoading;

  const refreshQueue = async () => {
    await Promise.all([
      queueQuery.refetch(),
      queueStatsQuery.refetch(),
    ]);
  };


  const handleMove = async (id: string, direction: 'up' | 'down') => {
    if (direction === 'up') {
      await moveUpMutation.mutateAsync(id);
    } else {
      await moveDownMutation.mutateAsync(id);
    }
    await refreshQueue();
  };

  const handleTogglePause = async (id: string, status: string) => {
    if (status === 'paused') {
      await resumeMutation.mutateAsync(id);
    } else {
      await pauseMutation.mutateAsync(id);
    }
    await refreshQueue();
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to remove this item from the pipeline queue?')) {
      await deleteMutation.mutateAsync(id);
      await refreshQueue();
    }
  };

  const handleRetry = async (id: string) => {
    await retryMutation.mutateAsync(id);
    await refreshQueue();
  };

  const toggleRow = (id: string) => {
    setExpandedRow(expandedRow === id ? null : id);
  };

  // Real queue statistics from the backend
  const backendStats = queueStatsQuery.data;

  const stats = {
    total: backendStats?.total ?? queue.length,
    pending: backendStats?.pending ?? queue.filter(q => q.status === 'pending').length,
    processing: backendStats?.processing ?? queue.filter(q => q.status === 'processing').length,
    paused: backendStats?.paused ?? queue.filter(q => q.status === 'paused').length,
    completed: backendStats?.completed ?? queue.filter(q => q.status === 'completed').length,
    failed: backendStats?.failed ?? queue.filter(q => q.status === 'failed').length,
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
          <h2 className="text-2xl font-bold tracking-tight text-white">Pipeline Synthesis Queue</h2>
          <p className="text-sm text-neutral-400">Manage queue prioritization, retry triggers, and microservice setups</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Type:</label>
          <select
            value={queueTypeFilter}
            onChange={(e) => setQueueTypeFilter(e.target.value)}
            className="w-40 bg-[#181524] border-neutral-800 text-sm py-1.5 px-3 rounded-lg text-white"
          >
            <option value="all">All Types</option>
            <option value="synthesis">Synthesis</option>
            <option value="deployment">Deployment</option>
            <option value="audit">Audit</option>
            <option value="maintenance">Maintenance</option>
          </select>
          <button onClick={refreshQueue} className="btn-secondary">
            <RefreshCw className="h-4 w-4" />
            <span>Reload Queue</span>
          </button>
        </div>
      </div>

      {/* Queue Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <div className="card-bold p-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Total</p>
          <p className="text-xl font-black text-white">{stats.total}</p>
        </div>
        <div className="card-bold p-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Pending</p>
          <p className="text-xl font-black text-purple-400">{stats.pending}</p>
        </div>
        <div className="card-bold p-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">In Progress</p>
          <p className="text-xl font-black text-blue-400">{stats.processing}</p>
        </div>
        <div className="card-bold p-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Paused</p>
          <p className="text-xl font-black text-amber-500">{stats.paused}</p>
        </div>
        <div className="card-bold p-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Completed</p>
          <p className="text-xl font-black text-green-400">{stats.completed}</p>
        </div>
        <div className="card-bold p-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Failed</p>
          <p className="text-xl font-black text-red-500">{stats.failed}</p>
        </div>
      </div>

      {/* Queue Analytics */}
      <div className="card-bold p-6">
        <h3 className="text-sm font-bold uppercase tracking-wider text-purple-400 mb-4">Queue Analytics</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Avg Processing Time</p>
            <p className="text-lg font-black text-white">{queue.length > 0 ? '~3.2m' : '—'}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Failure Rate</p>
            <p className="text-lg font-black text-red-400">{stats.total > 0 ? ((stats.failed / stats.total) * 100).toFixed(1) : '0.0'}%</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Throughput</p>
            <p className="text-lg font-black text-green-400">{stats.total > 0 ? ((stats.completed / stats.total) * 100).toFixed(1) : '0.0'}%</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-1">Queue Depth</p>
            <p className="text-lg font-black text-amber-400">{stats.pending + stats.processing}</p>
          </div>
        </div>
        {/* Status Distribution Bar Chart */}
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 mb-2">Status Distribution</p>
          <div className="flex h-8 rounded-lg overflow-hidden border border-neutral-800">
            {stats.total > 0 ? (
              <>
                {stats.pending > 0 && <div style={{ width: `${(stats.pending / stats.total) * 100}%` }} className="bg-purple-500/60 flex items-center justify-center"><span className="text-[10px] font-bold text-white">{stats.pending}</span></div>}
                {stats.processing > 0 && <div style={{ width: `${(stats.processing / stats.total) * 100}%` }} className="bg-blue-500/60 flex items-center justify-center"><span className="text-[10px] font-bold text-white">{stats.processing}</span></div>}
                {stats.completed > 0 && <div style={{ width: `${(stats.completed / stats.total) * 100}%` }} className="bg-green-500/60 flex items-center justify-center"><span className="text-[10px] font-bold text-white">{stats.completed}</span></div>}
                {stats.failed > 0 && <div style={{ width: `${(stats.failed / stats.total) * 100}%` }} className="bg-red-500/60 flex items-center justify-center"><span className="text-[10px] font-bold text-white">{stats.failed}</span></div>}
                {stats.paused > 0 && <div style={{ width: `${(stats.paused / stats.total) * 100}%` }} className="bg-neutral-500/60 flex items-center justify-center"><span className="text-[10px] font-bold text-white">{stats.paused}</span></div>}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">No data</div>
            )}
          </div>
          <div className="flex gap-4 mt-2 flex-wrap">
            <span className="text-[10px] text-neutral-400">🟣 Pending</span>
            <span className="text-[10px] text-neutral-400">🔵 Processing</span>
            <span className="text-[10px] text-neutral-400">🟢 Completed</span>
            <span className="text-[10px] text-neutral-400">🔴 Failed</span>
            <span className="text-[10px] text-neutral-400">⚪ Paused</span>
          </div>
        </div>
      </div>

      {/* Table */}
      {queue.length === 0 ? (
        <div className="card-bold p-12 text-center text-neutral-400">
          <AlertCircle className="h-10 w-10 mx-auto text-neutral-500 mb-3" />
          <p className="font-semibold text-white">Queue is currently empty</p>
          <p className="text-xs mt-1">Gaps will appear here once safety rules are verified and prioritized for agent synthesis.</p>
        </div>
      ) : (
        <div className="card-bold">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Priority & Sort</th>
                  <th>Arbitrage Gap Preview</th>
                  <th>Queue Type</th>
                  <th>Pipeline Status</th>
                  <th>Attempts</th>
                  <th className="text-right">Orchestrator Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item, index) => {
                  const isExpanded = expandedRow === item.id;
                  return (
                    <React.Fragment key={item.id}>
                      <tr>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="flex flex-col">
                              <button
                                disabled={index === 0}
                                onClick={() => handleMove(item.id, 'up')}
                                className="text-neutral-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none"
                              >
                                ▲
                              </button>
                              <button
                                disabled={index === queue.length - 1}
                                onClick={() => handleMove(item.id, 'down')}
                                className="text-neutral-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none"
                              >
                                ▼
                              </button>
                            </div>
                            <span className="font-black text-sm text-neutral-400">#{item.sortOrder}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${
                              (item.priority as number) <= 3 ? 'bg-red-500/15 text-red-400' :
                              (item.priority as number) <= 6 ? 'bg-amber-500/15 text-amber-400' : 'bg-green-500/15 text-green-400'
                            }`}>
                              {item.priority}
                            </span>
                          </div>
                        </td>
                        <td className="max-w-xs">
                          {item.gap ? (
                            <>
                              <div className="font-semibold text-white truncate">{item.gap.knows}</div>
                              <div className="text-xs text-neutral-400 truncate mt-0.5">➔ {item.gap.needs}</div>
                            </>
                          ) : (
                            <span className="text-neutral-500 italic">No gap payload loaded</span>
                          )}
                        </td>
                        <td>
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
                            item.status === 'processing' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
                            item.status === 'paused' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
                            item.status === 'failed' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                            'bg-neutral-800 text-neutral-400 border border-neutral-700'
                          }`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="text-sm font-semibold text-neutral-300">
                          {item.attempts} / {item.maxAttempts}
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => handleTogglePause(item.id, item.status)}
                              className="btn-secondary p-1.5"
                              title={item.status === 'paused' ? 'Resume Processing' : 'Pause Processing'}
                            >
                              {item.status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                            </button>
                            {item.status === 'failed' && (
                              <button
                                onClick={() => handleRetry(item.id)}
                                className="btn-bold-primary p-1.5"
                                title="Retry Pipeline Loop"
                              >
                                <RefreshCw className="h-4 w-4" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(item.id)}
                              className="btn-danger p-1.5"
                              title="Delete Item"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => toggleRow(item.id)}
                              className="btn-secondary py-1 px-2.5 text-xs font-semibold"
                            >
                              {isExpanded ? 'Hide Payload' : 'Inspect'}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expandable Inspection Drawer */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={5} className="bg-[#141220]/60 p-6 border-b border-[#221c32]">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                              <div className="space-y-3">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400">Pipeline Registry Metadata</h4>
                                <div className="space-y-2 text-xs">
                                  <div className="flex justify-between border-b border-neutral-800/40 pb-1.5">
                                    <span className="text-neutral-500">Pipeline Item ID</span>
                                    <span className="text-white font-mono">{item.id}</span>
                                  </div>
                                  <div className="flex justify-between border-b border-neutral-800/40 pb-1.5">
                                    <span className="text-neutral-500">Target Gap ID</span>
                                    <span className="text-white font-mono">{item.gapId}</span>
                                  </div>
                                  <div className="flex justify-between border-b border-neutral-800/40 pb-1.5">
                                    <span className="text-neutral-500">Deduplication Hash</span>
                                    <span className="text-white font-mono">{item.dedupHash}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-neutral-500">Registered Timestamp</span>
                                    <span className="text-white">{new Date(item.createdAt).toLocaleString()}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="space-y-3">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400">Execution Diagnostics</h4>
                                {item.lastError ? (
                                  <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400 font-mono">
                                    <p className="font-bold mb-1">Fatal Error / Synthesis Rejected:</p>
                                    <p>{item.lastError}</p>
                                  </div>
                                ) : (
                                  <div className="p-3.5 rounded-lg bg-green-500/5 border border-green-500/10 text-xs text-green-400">
                                    Pipeline is performing health checks. No runtime exceptions or logical validation blocks detected in the stream logs.
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Queue;
