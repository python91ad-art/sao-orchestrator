export function minorUnits(amount: string): bigint {
  if (!/^-?\d+\.\d{2}$/.test(amount)) throw new Error('Amount must have exactly two decimal places.');
  const negative = amount.startsWith('-');
  const [whole, fraction] = amount.replace('-', '').split('.');
  return (BigInt(whole) * 100n + BigInt(fraction)) * (negative ? -1n : 1n);
}
export function money(amount: bigint): string {
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export type AccountingEntry = { id: string; kind: 'revenue' | 'expense' | 'refund' | 'fee' | 'tax'; amount: string; currency: string; verified: boolean; disputed: boolean };
export function calculateVerifiedProfit(input: { entries: AccountingEntry[]; currency: string; openingLoss: string; rounding: 'half_up' | 'down' }) {
  if (!['half_up', 'down'].includes(input.rounding)) throw new Error('Explicit rounding convention required.');
  const identifiers = new Set<string>();
  const totals = { revenue: 0n, expense: 0n, refund: 0n, fee: 0n, tax: 0n };
  for (const entry of input.entries) {
    if (identifiers.has(entry.id)) throw new Error('Duplicate accounting entry.');
    identifiers.add(entry.id);
    if (!entry.verified || entry.disputed) throw new Error('Settlement paused: unverified or disputed entry.');
    if (entry.currency !== input.currency) throw new Error('Currency conversion and reconciliation required.');
    const amount = minorUnits(entry.amount);
    if (amount < 0n || !(entry.kind in totals)) throw new Error('Invalid accounting entry.');
    totals[entry.kind] += amount;
  }
  const openingLoss = minorUnits(input.openingLoss);
  if (openingLoss < 0n) throw new Error('Loss carryforward must be nonnegative.');
  const net = totals.revenue - totals.expense - totals.refund - totals.fee - totals.tax;
  const afterLoss = net - openingLoss;
  const eligible = afterLoss > 0n ? afterLoss : 0n;
  const platform = (eligible * 20n + (input.rounding === 'half_up' ? 50n : 0n)) / 100n;
  return { grossRevenue: money(totals.revenue), expenses: money(totals.expense), refunds: money(totals.refund), fees: money(totals.fee), taxes: money(totals.tax), netProfit: money(net), openingLoss: money(openingLoss), closingLoss: money(afterLoss < 0n ? -afterLoss : 0n), eligibleProfit: money(eligible), platformPortion: money(platform), businessPortion: money(eligible - platform), payoutStatus: 'UNAVAILABLE' as const };
}
