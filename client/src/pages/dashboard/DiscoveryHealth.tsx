import { trpc } from '../../lib/trpc';

export default function DiscoveryHealth() {
  const health = trpc.discovery.pipelineDiagnostic.useQuery(undefined, { refetchInterval: 30000 });
  if (health.error) return <div className="card-bold">Discovery status unavailable: {health.error.message}</div>;
  if (!health.data) return <div className="card-bold">Loading discovery status…</div>;
  const { multiSource: report, webSearch } = health.data;
  if (!report || !webSearch) return <div className="card-bold">Discovery status unavailable</div>;
  const fallback = webSearch.attempts.filter(a => a.provider !== webSearch.activeProvider);
  return <div className="card-bold space-y-3">
    <h3 className="text-base font-bold text-white">Business discovery</h3>
    <p>{report.status === 'unavailable' ? 'Discovery unavailable' : report.status === 'idle' ? 'Awaiting discovery cycle' : report.status === 'running' ? 'Discovery running' : report.validated === 0 ? 'No opportunities found' : `${report.validated} validated candidates`}{report.status === 'partial' ? ' · Some discovery sources unavailable' : ''}</p>
    <div className="grid grid-cols-2 gap-2 text-sm">
      <span>ONS: {report.ons.status} · {report.ons.signals} statistical signals</span>
      <span>Tavily: {webSearch.providers.tavily?.status || 'not checked'}</span>
      <span>Active web provider: {webSearch.activeProvider || 'none'}</span>
      <span>Web discovery: {report.web.status}</span>
      <span>Candidates: {Object.entries(report.candidatesBySource).map(([source, count]) => `${source}: ${count}`).join(', ') || '0'}</span>
      <span>Validated: {report.validated} · Rejected: {report.rejected} · Queued: {report.queued}</span>
      <span>Last successful discovery: {report.lastSuccess || 'none'}</span>
      <span>Last failed discovery: {report.lastFailure || 'none'}</span>
    </div>
    {fallback.length > 0 && <p className="text-xs text-amber-300">Fallback routing: {fallback.map(a => `${a.provider}: ${a.reason || a.status}`).join(' → ')}</p>}
    {Object.entries(webSearch.providers).map(([provider, state]) => state && <p key={provider} className="text-xs text-neutral-400">{provider}: {state.status}{state.retryAt ? ` · restricted until ${state.retryAt}` : ''}{state.lastFailure ? ` · last failure ${state.lastFailure}` : ''}</p>)}
    {report.ons.errors.map((error, i) => <p key={i} className="text-xs text-amber-300">{error}</p>)}
    <p className="text-xs text-neutral-400">Validated discovery evidence still requires the existing independent source and legal reviews before business creation.</p>
  </div>;
}
