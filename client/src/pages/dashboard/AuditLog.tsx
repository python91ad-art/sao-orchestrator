import React, { useState, useEffect } from 'react';
import { RefreshCw, Eye } from 'lucide-react';
import { AuditLog, trpc } from '../../lib/trpc';

const AuditLogPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const auditQuery = trpc.audit.list.useQuery({
    limit: 100,
    skip: 0,
  });

  useEffect(() => {
    setLoading(auditQuery.isLoading);

    if (auditQuery.data) {
      setLogs(
        auditQuery.data.map(log => ({
          ...log,
          gapId: log.gapId ?? undefined,
          deploymentId: log.deploymentId ?? undefined,
          decision: log.decision as AuditLog["decision"],
        }))
      );
    }
  }, [auditQuery.data, auditQuery.isLoading]);

  const loadData = async () => {
    setLoading(true);
    try {
      await auditQuery.refetch();
    } catch (error) {
      console.error('[AuditLog] Failed to load audit logs:', error);
    } finally {
      setLoading(false);
    }
  };

  const openModal = (log: AuditLog) => {
    setSelectedLog(log);
    setIsModalOpen(true);
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
          <h2 className="text-2xl font-bold tracking-tight text-white">Security & Execution Audit Logs</h2>
          <p className="text-sm text-neutral-400">Complete audit trail of AI decision loops, ban risk assessments, and policy enforcement</p>
        </div>
        <button onClick={loadData} className="btn-secondary">
          <RefreshCw className="h-4 w-4" />
          <span>Reload Audit Logs</span>
        </button>
      </div>

      {/* Audit Log Table */}
      <div className="card-bold">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Safety Decision</th>
                <th>Target Gap / Deployment</th>
                <th>Ban Risk</th>
                <th>Business Health</th>
                <th className="text-right">Diagnostics</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="text-xs text-neutral-400">
                    {new Date(log.timestamp).toLocaleString()}
                  </td>
                  <td>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
                      log.decision === 'allow' ? 'bg-green-500/10 text-green-400 border border-green-500/25' :
                      log.decision === 'block' ? 'bg-red-500/10 text-red-400 border border-red-500/25' :
                      'bg-amber-500/10 text-amber-400 border border-amber-500/25'
                    }`}>
                      {log.decision}
                    </span>
                  </td>
                  <td>
                    <div className="text-sm text-neutral-200 font-mono">
                      {log.gapId ? `Gap: ${log.gapId}` : 'N/A'}
                    </div>
                    <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
                      {log.deploymentId ? `Deployment: ${log.deploymentId}` : 'No deployment initialized'}
                    </div>
                  </td>
                  <td>
                    <span className={`badge-${
                      log.banRisk === 'low' ? 'success' :
                      log.banRisk === 'medium' ? 'warning' : 'danger'
                    }`}>
                      {log.banRisk}
                    </span>
                  </td>
                  <td>
                    <span className={`badge-${
                      log.businessHealth === 'healthy' ? 'success' :
                      log.businessHealth === 'warning' ? 'warning' : 'danger'
                    }`}>
                      {log.businessHealth}
                    </span>
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => openModal(log)}
                      className="btn-secondary py-1.5 px-3 text-xs"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      <span>Inspect reasoning</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reasoning Inspection Modal */}
      {isModalOpen && selectedLog && (
        <div className="modal-overlay">
          <div className="modal-content max-w-xl">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#221c32]">
              <h3 className="text-lg font-bold text-white">Orchestrator Decision Reasoning</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-neutral-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-xs uppercase font-bold text-neutral-400">Verdict:</span>
                <span className={`px-2.5 py-0.5 rounded text-xs font-bold uppercase tracking-wider ${
                  selectedLog.decision === 'allow' ? 'bg-green-500/10 text-green-400' :
                  selectedLog.decision === 'block' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'
                }`}>
                  {selectedLog.decision}
                </span>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">Telemetry Summary</h4>
                <p className="text-sm text-neutral-200 bg-[#0c0a12] p-3.5 rounded-lg border border-[#221c32]">
                  {selectedLog.explanation}
                </p>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">Safety Rule Diagnostics</h4>
                <div className="text-sm text-neutral-400 bg-[#0c0a12] p-3.5 rounded-lg border border-[#221c32] font-mono leading-relaxed">
                  {selectedLog.reasoning}
                </div>
              </div>

              <div className="text-[10px] text-neutral-500 font-mono">
                Log ID: {selectedLog.id} | Timestamp: {new Date(selectedLog.timestamp).toISOString()}
              </div>
            </div>

            <div className="flex justify-end mt-6 pt-4 border-t border-[#221c32]">
              <button onClick={() => setIsModalOpen(false)} className="btn-secondary">
                Acknowledge & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AuditLogPage;
