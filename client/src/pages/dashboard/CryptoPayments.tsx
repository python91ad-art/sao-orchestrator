import React, { useState } from 'react';
import { Bitcoin, Wallet, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';
import { trpc, type Payment } from '../../lib/trpc';

const PAY_CURRENCIES = [
  { value: 'btc', label: 'Bitcoin (BTC)' },
  { value: 'eth', label: 'Ethereum (ETH)' },
  { value: 'usdt', label: 'Tether (USDT)' },
  { value: 'usdc', label: 'USD Coin (USDC)' },
  { value: 'ltc', label: 'Litecoin (LTC)' },
  { value: 'doge', label: 'Dogecoin (DOGE)' },
];

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'paid':
      return 'bg-green-500/10 text-green-400 border border-green-500/30';
    case 'pending':
      return 'bg-amber-500/10 text-amber-400 border border-amber-500/30';
    case 'confirming':
    case 'confirmed':
      return 'bg-blue-500/10 text-blue-400 border border-blue-500/30';
    case 'failed':
      return 'bg-red-500/10 text-red-400 border border-red-500/30';
    case 'expired':
    case 'canceled':
      return 'bg-neutral-500/10 text-neutral-400 border border-neutral-500/30';
    default:
      return 'bg-neutral-500/10 text-neutral-400 border border-neutral-500/30';
  }
}

const CryptoPayments: React.FC = () => {
  const [deploymentId, setDeploymentId] = useState('');
  const [payCurrency, setPayCurrency] = useState('btc');
  const [message, setMessage] = useState<string | null>(null);

  const deploymentsQuery = trpc.deployments.list.useQuery();
  const paymentsQuery = trpc.payments.list.useQuery();
  const createPaymentMutation = trpc.payments.createCryptoPayment.useMutation();

  const deployments = deploymentsQuery.data ?? [];
  const payments = paymentsQuery.data ?? [];

  const handleCreate = async () => {
    if (!deploymentId) {
      setMessage('Select a deployment first.');
      return;
    }
    setMessage(null);
    try {
      await createPaymentMutation.mutateAsync({ deploymentId, payCurrency });
      setMessage('Payment created. Send the exact crypto amount to the address below, or open the payment page.');
      paymentsQuery.refetch();
    } catch (error: any) {
      setMessage(error?.message || 'Failed to create crypto payment.');
    }
  };

  return (
    <div className="card-bold space-y-5">
      <div className="flex items-center gap-3 border-b border-[#221c32] pb-3">
        <Bitcoin className="h-5 w-5 text-amber-400" />
        <h3 className="text-base font-bold text-white">Crypto Payments (NOWPayments)</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
            Deployment
          </label>
          <select
            value={deploymentId}
            onChange={(e) => setDeploymentId(e.target.value)}
            className="w-full bg-[#0c0a12] border border-[#221c32] rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
          >
            <option value="">Select a deployment…</option>
            {deployments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id} — {d.status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
            Cryptocurrency
          </label>
          <select
            value={payCurrency}
            onChange={(e) => setPayCurrency(e.target.value)}
            className="w-full bg-[#0c0a12] border border-[#221c32] rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
          >
            {PAY_CURRENCIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end">
          <button
            onClick={handleCreate}
            disabled={createPaymentMutation.isPending}
            className="btn-secondary w-full justify-center"
          >
            <Wallet className="h-4 w-4" />
            <span>{createPaymentMutation.isPending ? 'Creating…' : 'Create Payment'}</span>
          </button>
        </div>
      </div>

      {message && (
        <div className="flex items-start gap-2 text-sm text-amber-300 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{message}</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Payment</th>
              <th>Status</th>
              <th>Amount</th>
              <th>Address / Instructions</th>
              <th>Tx Hash</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-sm text-neutral-500 text-center py-6">
                  No crypto payments yet. Create one above to begin.
                </td>
              </tr>
            ) : (
              payments.map((p: Payment) => (
                <tr key={p.id}>
                  <td>
                    <div className="font-mono text-xs text-white">{p.id}</div>
                    <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
                      Deployment: {p.deploymentId}
                    </div>
                  </td>
                  <td>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider ${statusBadgeClass(p.status)}`}>
                      {p.status}
                    </span>
                  </td>
                  <td>
                    <div className="font-semibold text-white">
                      {p.amount} {p.currency}
                    </div>
                    {p.cryptoAmount && p.cryptoCurrency && (
                      <div className="text-[10px] text-neutral-400 font-mono">
                        {p.cryptoAmount} {p.cryptoCurrency.toUpperCase()}
                        {p.cryptoNetwork ? ` (${p.cryptoNetwork})` : ''}
                      </div>
                    )}
                  </td>
                  <td className="max-w-xs">
                    {p.paymentAddress ? (
                      <div className="font-mono text-xs text-neutral-300 break-all">
                        {p.paymentAddress}
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-600">Awaiting address…</span>
                    )}
                  </td>
                  <td className="max-w-[8rem]">
                    {p.transactionHash ? (
                      <div className="font-mono text-[10px] text-neutral-400 break-all">
                        {p.transactionHash}
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-600">—</span>
                    )}
                  </td>
                  <td className="text-right">
                    {p.checkoutUrl && (
                      <a
                        href={p.checkoutUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary p-1.5"
                        title="Open payment page"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button onClick={() => paymentsQuery.refetch()} className="btn-secondary">
          <RefreshCw className="h-4 w-4" />
          <span>Refresh Payments</span>
        </button>
      </div>
    </div>
  );
};

export default CryptoPayments;