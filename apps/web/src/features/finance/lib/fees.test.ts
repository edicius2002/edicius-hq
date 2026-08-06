import { describe, expect, it } from 'vitest';

import { applyFee, computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
import type { AccountNode, Fee, HoldingNode, JobNode } from '@/features/finance/model/types';

const percent = (value: number): Fee => ({ value, type: 'percent' });
const fixed = (value: number): Fee => ({ value, type: 'fixed' });

function holding(fees: Partial<HoldingNode['fees']> = {}): HoldingNode {
  return {
    id: 'h',
    kind: 'holding',
    name: 'USD',
    notes: '',
    position: { x: 0, y: 0 },
    accountId: 'a',
    asset: 'USD',
    amount: 1000,
    active: true,
    fees: { in: null, out: null, ...fees },
  };
}

const job: JobNode = {
  id: 'j',
  kind: 'job',
  name: 'Job',
  notes: '',
  position: { x: 0, y: 0 },
  balances: [],
};

const account: AccountNode = {
  id: 'a',
  kind: 'account',
  name: 'Bank',
  notes: '',
  position: { x: 0, y: 0 },
};

describe('applyFee', () => {
  it('takes a percent of the amount it is given', () => {
    expect(applyFee(1000, percent(10))).toBeCloseTo(900);
  });

  it('subtracts a fixed fee whole', () => {
    expect(applyFee(1000, fixed(50))).toBeCloseTo(950);
  });
});

describe('computeTransfer', () => {
  it('charges nothing when neither end has a fee', () => {
    const result = computeTransfer(1000, holding(), holding());
    expect(result.net).toBe(1000);
    expect(result.steps).toEqual([]);
  });

  // The two tests below are the point of this module: each fails if the fee
  // chain is implemented the obvious-but-wrong way.

  it('applies each fee to the running amount, not to the original', () => {
    const result = computeTransfer(
      1000,
      holding({ out: percent(10) }),
      holding({ in: percent(10) }),
    );

    expect(result.net).toBeCloseTo(810);
    // 800 is what deducting both fees from the original 1000 would give.
    expect(result.net).not.toBeCloseTo(800);
    expect(result.steps.map((step) => step.net)).toEqual([900, 810]);
  });

  it('takes the source fee before the destination fee', () => {
    const result = computeTransfer(1000, holding({ out: fixed(50) }), holding({ in: percent(10) }));

    expect(result.net).toBeCloseTo(855);
    // 850 is what applying the percent first would give.
    expect(result.net).not.toBeCloseTo(850);
    expect(result.steps.map((step) => step.direction)).toEqual(['out', 'in']);
  });

  it('reports each deduction in order so a label can show the chain', () => {
    const result = computeTransfer(1000, holding({ out: percent(10) }), holding({ in: fixed(40) }));
    expect(result.steps).toEqual([
      { direction: 'out', fee: percent(10), net: 900 },
      { direction: 'in', fee: fixed(40), net: 860 },
    ]);
  });

  it('ignores a fee of zero rather than recording an empty step', () => {
    const result = computeTransfer(1000, holding({ out: percent(0) }), holding({ in: fixed(0) }));
    expect(result.steps).toEqual([]);
    expect(result.net).toBe(1000);
  });

  it('charges nothing when the source is a job, since jobs have no fees', () => {
    const result = computeTransfer(500, job, holding({ in: percent(10) }));
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].direction).toBe('in');
    expect(result.net).toBeCloseTo(450);
  });

  it('charges nothing for an account, which is never an endpoint of a flow', () => {
    expect(computeTransfer(1000, account, account).net).toBe(1000);
  });

  it('treats a missing endpoint as fee free instead of throwing', () => {
    expect(computeTransfer(1000, undefined, undefined).net).toBe(1000);
  });

  it('falls back to zero for a non-finite amount', () => {
    expect(computeTransfer(Number.NaN, holding(), holding()).gross).toBe(0);
  });
});

describe('isOverdrawnByFees', () => {
  it('flags a fixed fee larger than the amount being moved', () => {
    const result = computeTransfer(30, holding({ out: fixed(50) }), holding());
    expect(result.net).toBeCloseTo(-20);
    expect(isOverdrawnByFees(result)).toBe(true);
  });

  it('flags a transfer left at exactly zero', () => {
    expect(isOverdrawnByFees(computeTransfer(50, holding({ out: fixed(50) }), holding()))).toBe(
      true,
    );
  });

  it('does not flag a transfer that keeps value', () => {
    expect(isOverdrawnByFees(computeTransfer(100, holding({ out: fixed(50) }), holding()))).toBe(
      false,
    );
  });

  it('does not flag an empty transfer', () => {
    expect(isOverdrawnByFees(computeTransfer(0, holding({ out: fixed(50) }), holding()))).toBe(
      false,
    );
  });
});
