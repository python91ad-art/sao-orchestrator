import React, { useState } from 'react';
import { Megaphone, RefreshCw, Play, Eye } from 'lucide-react';
import { trpc } from '../../lib/trpc';

interface Channel {
  id: string; name: string; status: string;
  capabilities: {
    canCreateCampaign: boolean;
    canPublishCreatives: boolean;
    canRetrieveMetrics: boolean;
    canPauseResume: boolean;
    requiresPayment: boolean;
    supportedContentFormats: string[];
  };
  missingCredentials: string[];
}

interface Campaign {
  id: string; deploymentId: string; name: string; channel: string;
  status: string; campaignType: string; budget: string; spent: string;
  providerStatus?: string | null; errorMessage?: string | null;
  startedAt?: string | null; createdAt: string;
}

const Advertising: React.FC = () => {
  const [selectedDeployment, setSelectedDeployment] = useState('');
  const [creatives, setCreatives] = useState<any[]>([]);
  const [showCreatives, setShowCreatives] = useState<string | null>(null);

  const overviewQuery = trpc.advertising.overview.useQuery();
  const channelsQuery = trpc.advertising.channels.useQuery();
  const deploymentsQuery = trpc.deployments.list.useQuery();

  const analyzeMutation = trpc.advertising.analyze.useMutation();
  const strategyMutation = trpc.advertising.generateStrategy.useMutation();
  const creativesMutation = trpc.advertising.generateCreatives.useMutation();
  const publishMutation = trpc.advertising.publish.useMutation();

  const campaigns: Campaign[] = overviewQuery.data?.campaigns || [];

  const loadCreatives = async (campaignId: string) => {
    try {
      const resp = await fetch(`/api/trpc/advertising.getCreatives?input=${encodeURIComponent(JSON.stringify(campaignId))}`, { credentials: 'include' });
      const json = await resp.json();
      setCreatives(json?.result?.data || []);
      setShowCreatives(campaignId);
    } catch { setCreatives([]); }
  };

  const handleAnalyze = async () => {
    if (!selectedDeployment) { alert('Select a deployment'); return; }
    try { await analyzeMutation.mutateAsync(selectedDeployment); overviewQuery.refetch(); }
    catch (e: any) { alert(e.message); }
  };

  const handleGenerateStrategy = async () => {
    if (!selectedDeployment) { alert('Select a deployment'); return; }
    try {
      await strategyMutation.mutateAsync({ deploymentId: selectedDeployment });
      overviewQuery.refetch();
    } catch (e: any) { alert(e.message); }
  };

  const handleGenerateCreatives = async (campaignId: string) => {
    try { await creativesMutation.mutateAsync({ campaignId }); overviewQuery.refetch(); }
    catch (e: any) { alert(e.message); }
  };

  const handlePublish = async (campaignId: string) => {
    try {
      const result = await publishMutation.mutateAsync({ campaignId });
      if (!result.success) alert(`Not published: ${(result as any).error || 'Unknown'}`);
      overviewQuery.refetch();
    } catch (e: any) { alert(e.message); }
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      ACTIVE: 'badge-success', DRAFT: 'badge-gray', READY: 'badge-primary',
      FAILED: 'badge-danger', PAUSED: 'badge-warning', COMPLETED: 'badge-success',
      WAITING_FOR_BUDGET: 'badge-warning', WAITING_FOR_CREDENTIALS: 'badge-warning',
      NOT_CONFIGURED: 'badge-danger', CONFIGURED: 'badge-primary',
    };
    return colors[status] || 'badge-gray';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-white">Advertising</h2>
        <p className="text-sm text-neutral-400">Manage advertising campaigns for deployed projects</p>
      </div>

      {/* Channel Status */}
      <div className="card-bold">
        <h3 className="text-base font-bold text-white mb-4 pb-2 border-b border-[#221c32]">Channel Configuration</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {(channelsQuery.data || []).map((ch: Channel) => (
            <div key={ch.id} className="bg-[#0c0a12] border border-[#221c32] rounded-lg p-3 text-center">
              <div className="text-xs font-bold text-white mb-1">{ch.name}</div>
              <span className={`badge-xs ${getStatusBadge(ch.status)}`}>{ch.status}</span>
              {ch.missingCredentials.length > 0 && (
                <div className="text-[10px] text-red-400 mt-1">
                  {ch.missingCredentials.length} credential(s) missing
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Action Panel */}
      <div className="card-bold">
        <h3 className="text-base font-bold text-white mb-4 pb-2 border-b border-[#221c32]">Create Campaign</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Deployment</label>
            <select value={selectedDeployment} onChange={e => setSelectedDeployment(e.target.value)} className="w-full">
              <option value="">Select deployment...</option>
              {(deploymentsQuery.data || []).map((d: any) => (
                <option key={d.id} value={d.id}>{d.id.slice(0,8)} — ${Number(d.revenue).toFixed(2)}</option>
              ))}
            </select>
          </div>
          <button onClick={handleAnalyze} disabled={analyzeMutation.isPending} className="btn-secondary">
            {analyzeMutation.isPending ? <RefreshCw className="animate-spin h-4 w-4" /> : 'Analyze'}
          </button>
          <button onClick={handleGenerateStrategy} disabled={strategyMutation.isPending} className="btn-bold-primary">
            {strategyMutation.isPending ? <RefreshCw className="animate-spin h-4 w-4" /> : 'Generate Strategy'}
          </button>
        </div>
        {analyzeMutation.data && (
          <div className="mt-4 p-3 bg-[#0c0a12] border border-[#221c32] rounded-lg text-xs text-neutral-400">
            <div>Completeness: <span className="text-white font-bold">{analyzeMutation.data.analysis.completeness}</span></div>
            <div>Budget: <span className="text-white font-bold">${analyzeMutation.data.budget.calculatedBudget.toFixed(2)}</span> ({analyzeMutation.data.budget.advertisingRevenuePercentage}% of ${analyzeMutation.data.budget.deploymentRevenue.toFixed(2)})</div>
            {analyzeMutation.data.analysis.keywords.length > 0 && (
              <div>Keywords: {analyzeMutation.data.analysis.keywords.join(', ')}</div>
            )}
          </div>
        )}
      </div>

      {/* Campaign List */}
      <div className="card-bold">
        <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#221c32]">
          <h3 className="text-base font-bold text-white">Campaigns</h3>
          <div className="flex gap-3 text-sm text-neutral-400">
            <span>Budget: ${overviewQuery.data?.totalBudget?.toFixed(2) || '0.00'}</span>
            <span>Spent: ${overviewQuery.data?.totalSpent?.toFixed(2) || '0.00'}</span>
            <span>Active: {overviewQuery.data?.activeCount || 0}</span>
          </div>
        </div>

        {campaigns.length === 0 ? (
          <div className="text-center py-8 text-neutral-500">
            <Megaphone className="h-8 w-8 mx-auto mb-3 text-neutral-600" />
            <p>No advertising campaigns yet. Select a deployment above and generate a strategy.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Channel</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Budget</th>
                  <th>Spent</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c: Campaign) => (
                  <tr key={c.id}>
                    <td>
                      <div className="font-semibold text-white">{c.name}</div>
                      <div className="text-xs text-neutral-500">Deployment: {c.deploymentId.slice(0,8)}</div>
                    </td>
                    <td><span className="text-neutral-300">{c.channel}</span></td>
                    <td>
                      <span className={c.campaignType === 'FREE_ORGANIC' ? 'badge-gray' : 'badge-primary'}>
                        {c.campaignType}
                      </span>
                    </td>
                    <td>
                      <span className={getStatusBadge(c.status)}>{c.status}</span>
                      {c.errorMessage && (
                        <div className="text-[10px] text-red-400 mt-1 max-w-[150px] truncate" title={c.errorMessage}>
                          {c.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="text-right">${parseFloat(c.budget || '0').toFixed(2)}</td>
                    <td className="text-right">${parseFloat(c.spent || '0').toFixed(2)}</td>
                    <td>
                      <div className="flex gap-1">
                        {(c.status === 'DRAFT' || c.status === 'READY') && (
                          <button onClick={() => handleGenerateCreatives(c.id)}
                            disabled={creativesMutation.isPending}
                            className="btn-secondary p-1.5" title="Generate creatives">
                            <RefreshCw className="h-3 w-3" />
                          </button>
                        )}
                        <button onClick={() => loadCreatives(c.id)}
                          className="btn-secondary p-1.5" title="View creatives">
                          <Eye className="h-3 w-3" />
                        </button>
                        {c.status === 'READY' && (
                          <button onClick={() => handlePublish(c.id)}
                            disabled={publishMutation.isPending}
                            className="btn-bold-primary p-1.5" title="Publish">
                            <Play className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Creatives Modal */}
      {showCreatives && (
        <div className="modal-overlay">
          <div className="modal-content max-w-2xl">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#221c32]">
              <h3 className="text-lg font-bold text-white">Creatives</h3>
              <button onClick={() => setShowCreatives(null)} className="text-neutral-400 hover:text-white">✕</button>
            </div>
            {creatives.length === 0 ? (
              <p className="text-neutral-400">No creatives yet. Generate them first.</p>
            ) : (
              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                {creatives.map((cr: any, i: number) => (
                  <div key={i} className="bg-[#0c0a12] p-3 rounded-lg border border-[#221c32]">
                    <div className="flex justify-between items-start mb-1">
                      <span className="badge-primary text-xs">{cr.format}</span>
                      {cr.variation > 1 && <span className="text-xs text-neutral-500">Var {cr.variation}</span>}
                    </div>
                    <p className="text-sm text-neutral-200">{cr.content}</p>
                    {cr.headline && <p className="text-xs text-purple-400 mt-1">Headline: {cr.headline}</p>}
                    {cr.callToAction && <p className="text-xs text-green-400 mt-1">CTA: {cr.callToAction}</p>}
                    {cr.targetAudience && <p className="text-xs text-neutral-500 mt-1">Audience: {cr.targetAudience}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Advertising;
