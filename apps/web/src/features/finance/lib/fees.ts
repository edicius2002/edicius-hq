import type { Fee, FinanceNode } from '@/features/finance/model/types';
import { roundAmount } from '@/shared/lib/money';

/** One deduction and what the transfer is worth after it. */
export type FeeStep = {
  direction: 'out' | 'in';
  fee: Fee;
  /** Amount left once this fee has been taken. */
  net: number;
};

export type TransferBreakdown = {
  gross: number;
  steps: FeeStep[];
  net: number;
};

function isCharged(fee: Fee | null): fee is Fee {
  return fee !== null && Number.isFinite(fee.value) && fee.value !== 0;
}

/**
 * Take a single fee off an amount. Percent is of the amount it is applied to.
 *
 * Rounded, because the result is money that gets stored and shown, and a
 * percentage in binary floating point does not land on a cent: 8 at 12% is
 * 7.040000000000001, and two steps of that is what put 7,039999999999964 in a
 * field. Rounding each step rather than the total is deliberate — a fee is
 * charged to the cent when it is charged, not once the chain is over.
 */
export function applyFee(amount: number, fee: Fee): number {
  return roundAmount(fee.type === 'fixed' ? amount - fee.value : amount * (1 - fee.value / 100));
}

/**
 * Fees charged on moving `gross` from one node to another.
 *
 * The source's out-fee is taken first, then the destination's in-fee, and **each
 * applies to the running amount, not to the original**. Both details change the
 * result: 1000 at 10% out and 10% in nets 810, not 800, and a fixed 50 out
 * followed by 10% in nets 855, where the reverse order would give 850.
 *
 * Only holdings carry fees. Jobs have none, and an account is never an endpoint
 * of a flow, so it can never charge one.
 */
export function computeTransfer(
  gross: number,
  source: FinanceNode | undefined,
  target: FinanceNode | undefined,
): TransferBreakdown {
  const base = Number.isFinite(gross) ? gross : 0;
  const steps: FeeStep[] = [];
  let running = base;

  const feeOut = source?.kind === 'holding' ? source.fees.out : null;
  if (isCharged(feeOut)) {
    running = applyFee(running, feeOut);
    steps.push({ direction: 'out', fee: feeOut, net: running });
  }

  const feeIn = target?.kind === 'holding' ? target.fees.in : null;
  if (isCharged(feeIn)) {
    running = applyFee(running, feeIn);
    steps.push({ direction: 'in', fee: feeIn, net: running });
  }

  return { gross: base, steps, net: running };
}

/**
 * True when a fixed fee is larger than what is being moved, which would land the
 * transfer at or below zero. Such a transfer carries no value and is left out of
 * the totals rather than subtracting from them.
 */
export function isOverdrawnByFees(breakdown: TransferBreakdown): boolean {
  return breakdown.gross > 0 && breakdown.net <= 0;
}
