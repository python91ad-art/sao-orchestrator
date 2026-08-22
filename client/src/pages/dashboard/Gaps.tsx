import React, { useState, useEffect } from 'react';
import { Plus, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { Gap, trpc } from '../../lib/trpc';

const Gaps: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [knows, setKnows] = useState('');
  const [needs, setNeeds] = useState('');
  const [controlsAccess, setControlsAccess] = useState('');
  const [underestimatesValue, setUnderestimatesValue] = useState('');
  const [source, setSource] = useState('manual');
  const [priority, setPriority] = useState<number>(5);

  const gapsQuery = trpc.gaps.list.useQuery({ limit: 100, skip: 0 });

  const createMutation = trpc.gaps.create.useMutation();
  const retryMutation = trpc.gaps.retry.useMutation();

  const gapsData = gapsQuery.data ?? [];

  useEffect(() => {
    setGaps(gapsData);
    setLoading(gapsQuery.isLoading);
  }, [gapsQuery.data, gapsQuery.isLoading]);

  const loadData = async () => {
    setLoading(true);
    try {
      await gapsQuery.refetch();
    } catch (error) {
      console.error('[Gaps] Failed to load gaps:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddGap = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await createMutation.mutateAsync({
        knows,
        needs,
        controlsAccess,
        underestimatesValue,
        source,
        priority,
      });

      setGaps(prev => [created, ...prev]);
      setIsAddModalOpen(false);
    } catch (error) {
      console.error('[Gaps] Failed to create gap:', error);
      alert('Failed to create gap.');
      return;
    }
    setKnows('');
    setNeeds('');
    setControlsAccess('');
    setUnderestimatesValue('');
    setSource('manual');
  };

  const handleRetry = async (id: string) => {
    try {
      await retryMutation.mutateAsync(id);
      setGaps(prev =>
        prev.map(g => g.id === id ? { ...g, status: 'pending' } : g)
      );
    } catch (error) {
      console.error('[Gaps] Failed to retry gap:', error);
      alert('Failed to retry gap.');
    }
  };

  const toggleRow = (id: string) => {
    setExpandedRow(expandedRow === id ? null : id);
  };

  const filteredGaps = filter === 'all' ? gaps : gaps.filter(g => g.status === filter);

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
          <h2 className="text-2xl font-bold tracking-tight text-white">Asymmetric Arbitrage Gaps</h2>
          <p className="text-sm text-neutral-400">Manage discovered market gaps and coordinate agent synthesis</p>
        </div>
        <button onClick={() => setIsAddModalOpen(true)} className="btn-bold-primary">
          <Plus className="h-4 w-4" />
          <span>Add Asymmetric Gap</span>
        </button>
      </div>

      {/* Filter / Search Bar */}
      <div className="card-bold p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <label className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Filter Status:</label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-48 bg-[#181524] border-neutral-800 text-sm py-1.5 px-3 rounded-lg text-white"
          >
            <option value="all">All Gaps</option>
            <option value="pending">Pending Audit</option>
            <option value="deployed">Deployed</option>
            <option value="safe">Safe to run</option>
            <option value="unsafe">Unsafe / Blocked</option>
            <option value="gray">Review / Gray</option>
          </select>
        </div>
        <button onClick={loadData} className="btn-secondary py-1.5 px-3">
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Reload</span>
        </button>
      </div>

      {/* Gaps Table */}
      <div className="card-bold">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Arbitrage Core Match</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Scrape Date</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredGaps.map((gap) => {
                const isExpanded = expandedRow === gap.id;
                return (
                  <React.Fragment key={gap.id}>
                    <tr>
                      <td className="max-w-md">
                        <div className="font-semibold text-white truncate">{gap.knows}</div>
                        <div className="text-xs text-neutral-400 truncate mt-0.5">➔ {gap.needs}</div>
                      </td>
                      <td>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          (gap.priority as number) <= 3 ? 'bg-red-500/10 text-red-400 border border-red-500/30' :
                          (gap.priority as number) <= 6 ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' :
                          'bg-green-500/10 text-green-400 border border-green-500/30'
                        }`}>
                          P{(gap.priority as number)}
                        </span>
                      </td>
                      <td>
                        <span className={`badge-${
                          gap.status === 'deployed' ? 'success' :
                          gap.status === 'safe' ? 'success' :
                          gap.status === 'pending' ? 'primary' :
                          gap.status === 'unsafe' ? 'danger' : 'warning'
                        }`}>
                          {gap.status}
                        </span>
                      </td>
                      <td className="text-neutral-400 text-xs">
                        {new Date(gap.createdAt).toLocaleDateString()}
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => toggleRow(gap.id)}
                            className="btn-secondary py-1.5 px-3"
                          >
                            <span>{isExpanded ? 'Hide Details' : 'View Details'}</span>
                            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                          {gap.status === 'unsafe' && (
                            <button
                              onClick={() => handleRetry(gap.id)}
                              className="btn-bold-primary py-1.5 px-3"
                            >
                              <span>Retry Audit</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {/* Expandable Panel */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={5} className="bg-[#141220]/60 p-6 border-b border-[#221c32]">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-4">
                              <div>
                                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">
                                  Who Has Knowledge/Resource? (Knows)
                                </h4>
                                <p className="text-sm text-white bg-[#0e0c15] p-3 rounded-lg border border-neutral-800">
                                  {gap.knows}
                                </p>
                              </div>
                              <div>
                                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">
                                  Who Controls Platform/Gatekeeper? (Controls Access)
                                </h4>
                                <p className="text-sm text-white bg-[#0e0c15] p-3 rounded-lg border border-neutral-800">
                                  {gap.controlsAccess || 'N/A / Open platform'}
                                </p>
                              </div>
                            </div>

                            <div className="space-y-4">
                              <div>
                                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">
                                  Who Needs What They Lack? (Needs)
                                </h4>
                                <p className="text-sm text-white bg-[#0e0c15] p-3 rounded-lg border border-neutral-800">
                                  {gap.needs}
                                </p>
                              </div>
                              <div>
                                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">
                                  Who Underestimates Value?
                                </h4>
                                <p className="text-sm text-white bg-[#0e0c15] p-3 rounded-lg border border-neutral-800">
                                  {gap.underestimatesValue || 'Not specified'}
                                </p>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-4 mt-4 pt-4 border-t border-neutral-800 text-xs text-neutral-400">
                            <div>Source Scraper: <span className="text-white font-medium">{gap.source}</span></div>
                            <div>Scrape ID: <span className="text-white font-medium">{gap.id}</span></div>
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

      {/* Add Gap Modal */}
      {isAddModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content max-w-2xl">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#221c32]">
              <h3 className="text-lg font-bold text-white">Add Asymmetric Gap</h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-neutral-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleAddGap} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Who has this knowledge/resource/access? (Knows)
                </label>
                <textarea
                  required
                  rows={2}
                  value={knows}
                  onChange={(e) => setKnows(e.target.value)}
                  placeholder="e.g. Local farm cooperatives with extra diesel surplus"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Who needs what they don't have? (Needs)
                </label>
                <textarea
                  required
                  rows={2}
                  value={needs}
                  onChange={(e) => setNeeds(e.target.value)}
                  placeholder="e.g. Decentralized cold-storage distribution routes"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                    Who controls the gatekeeper/platform?
                  </label>
                  <input
                    type="text"
                    required
                    value={controlsAccess}
                    onChange={(e) => setControlsAccess(e.target.value)}
                    placeholder="e.g. Regional logistics platform"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                    Who doesn't realize their hidden value?
                  </label>
                  <input
                    type="text"
                    required
                    value={underestimatesValue}
                    onChange={(e) => setUnderestimatesValue(e.target.value)}
                    placeholder="e.g. Small local agricultural operations"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                    Source
                  </label>
                  <input
                    type="text"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="manual"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                    Priority
                  </label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as any)}
                    className="w-full"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-[#221c32]">
                <button type="button" onClick={() => setIsAddModalOpen(false)} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-bold-primary">
                  Synthesize & Orchestrate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Gaps;
