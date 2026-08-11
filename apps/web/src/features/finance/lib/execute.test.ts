import { describe, expect, it } from 'vitest';

import { canExecuteFlow, describeExecuteError, executeFlow } from '@/features/finance/lib/execute';
import type {
  Balance,
  Diagram,
  FinanceNode,
  Flow,
  HoldingNode,
} from '@/features/finance/model/types';

const position = { x: 0, y: 0 };

function job(id: string, balances: Balance[]): FinanceNode {
  return { id, kind: 'job', name: id, notes: '', position, balances };
}

function account(id: string): FinanceNode {
  return { id, kind: 'account', name: id, notes: '', position };
}

function holding(
  id: string,
  accountId: string,
  asset: string,
  amount: number | null,
  overrides: Partial<HoldingNode> = {},
): FinanceNode {
  return {
    id,
    kind: 'holding',
    name: asset,
    notes: '',
    position,
    accountId,
    asset,
    amount,
    active: true,
    fees: { in: null, out: null },
    ...overrides,
  };
}

function flow(id: string, from: string, to: string, asset: string, amount: number | null): Flow {
  return {
    id,
    from,
    to,
    fromAnchor: 'r',
    toAnchor: 'l',
    amount,
    asset,
    label: '',
    notes: '',
    labelOffset: null,
  };
}

function diagram(nodes: FinanceNode[], flows: Flow[] = []): Diagram {
  return {
    id: 'd1',
    name: 'Cash flow',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    nodeOrder: nodes.map((node) => node.id),
    flows: Object.fromEntries(flows.map((item) => [item.id, item])),
    flowOrder: flows.map((item) => item.id),
    frames: {},
    frameOrder: [],
  };
}

/** The straightforward shape: two holdings on different accounts, one flow. */
function pair(amount: number | null, held = 1000, overrides: Partial<HoldingNode> = {}) {
  return diagram(
    [
      account('a1'),
      account('a2'),
      holding('h1', 'a1', 'USD', held, overrides),
      holding('h2', 'a2', 'USD', 0),
    ],
    [flow('f1', 'h1', 'h2', 'USD', amount)],
  );
}

function reason(d: Diagram, id = 'f1'): string | null {
  const check = canExecuteFlow(d, id);
  return check.ok ? null : check.error.code;
}

describe('canExecuteFlow', () => {
  it('allows a transfer the source can afford', () => {
    expect(canExecuteFlow(pair(250), 'f1').ok).toBe(true);
  });

  it('refuses a flow with nothing on it', () => {
    expect(reason(pair(0))).toBe('no-amount');
    expect(reason(pair(null))).toBe('no-amount');
    expect(reason(pair(-5))).toBe('no-amount');
  });

  it('refuses when the source does not hold enough', () => {
    const check = canExecuteFlow(pair(1200, 1000), 'f1');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toEqual({ code: 'insufficient', asset: 'USD', held: 1000, needed: 1200 });
    }
  });

  it('refuses when the fees would eat the whole transfer', () => {
    const d = pair(100, 1000, { fees: { in: null, out: { value: 150, type: 'fixed' } } });
    expect(reason(d)).toBe('fees-exceed-amount');
  });

  it('refuses to convert between assets, because nothing here has a rate', () => {
    const d = diagram(
      [
        account('a1'),
        account('a2'),
        holding('h1', 'a1', 'USD', 500),
        holding('h2', 'a2', 'PEN', 0),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 100)],
    );
    expect(reason(d)).toBe('cross-asset');
  });

  it('refuses when the source is already promising more than it holds', () => {
    // Each flow fits on its own; together they do not. Executing either would
    // quietly decide which sibling goes unpaid.
    const d = diagram(
      [
        account('a1'),
        account('a2'),
        holding('h1', 'a1', 'USD', 100),
        holding('h2', 'a2', 'USD', 0),
        holding('h3', 'a2', 'USD', 0),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 80), flow('f2', 'h1', 'h3', 'USD', 80)],
    );
    expect(reason(d)).toBe('over-allocated');
  });

  it('refuses a flow whose end has been deleted, and one that is gone itself', () => {
    const d = diagram(
      [account('a1'), holding('h1', 'a1', 'USD', 500)],
      [flow('f1', 'h1', 'ghost', 'USD', 10)],
    );
    expect(reason(d)).toBe('missing-node');
    expect(reason(d, 'nope')).toBe('missing-flow');
  });

  it('refuses an account as an endpoint even though connect would not make one', () => {
    // A restored document is not ours to trust.
    const d = diagram(
      [account('a1'), account('a2'), holding('h2', 'a2', 'USD', 0)],
      [flow('f1', 'a1', 'h2', 'USD', 50)],
    );
    expect(reason(d)).toBe('account-endpoint');
  });

  it('lets a job pay out of an active balance', () => {
    const d = diagram(
      [
        job('j1', [{ asset: 'USD', amount: 800, active: true }]),
        account('a1'),
        holding('h1', 'a1', 'USD', 0),
      ],
      [flow('f1', 'j1', 'h1', 'USD', 800)],
    );
    expect(canExecuteFlow(d, 'f1').ok).toBe(true);
  });

  it('will not pay out of a balance the job has switched off', () => {
    const d = diagram(
      [
        job('j1', [{ asset: 'USD', amount: 800, active: false }]),
        account('a1'),
        holding('h1', 'a1', 'USD', 0),
      ],
      [flow('f1', 'j1', 'h1', 'USD', 100)],
    );
    expect(reason(d)).toBe('insufficient');
  });

  it('has words for every refusal', () => {
    const codes = [
      { code: 'missing-flow' },
      { code: 'missing-node' },
      { code: 'no-amount' },
      { code: 'fees-exceed-amount' },
      { code: 'account-endpoint' },
      { code: 'cross-asset', from: 'USD', to: 'PEN' },
      { code: 'insufficient', asset: 'USD', held: 1, needed: 2 },
      { code: 'over-allocated', asset: 'USD' },
    ] as const;

    for (const error of codes) {
      const said = describeExecuteError(error);
      expect(said.length).toBeGreaterThan(0);
      // A reason, not a code shown to a person.
      expect(said).not.toContain(error.code);
    }
  });
});

describe('executeFlow', () => {
  it('moves the gross out and the net in, and leaves the flow in place', () => {
    const after = executeFlow(pair(250), 'f1');

    expect((after.nodes.h1 as HoldingNode).amount).toBe(750);
    expect((after.nodes.h2 as HoldingNode).amount).toBe(250);
    // The connection survives; only what was pending on it is gone.
    expect(after.flows.f1).toBeDefined();
    expect(after.flows.f1.amount).toBeNull();
  });

  it('credits the destination net of fees, and the fees leave the diagram', () => {
    const d = pair(1000, 1000, { fees: { in: null, out: { value: 10, type: 'percent' } } });
    const after = executeFlow(d, 'f1');

    // The source pays the gross; the destination receives what survived.
    expect((after.nodes.h1 as HoldingNode).amount).toBe(0);
    expect((after.nodes.h2 as HoldingNode).amount).toBe(900);
  });

  it('takes the out fee before the in fee, each off what is left', () => {
    // 1000 → 10% out → 900 → 10% in → 810. Not 800.
    const d = diagram(
      [
        account('a1'),
        account('a2'),
        holding('h1', 'a1', 'USD', 1000, {
          fees: { in: null, out: { value: 10, type: 'percent' } },
        }),
        holding('h2', 'a2', 'USD', 0, { fees: { in: { value: 10, type: 'percent' }, out: null } }),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 1000)],
    );

    expect((executeFlow(d, 'f1').nodes.h2 as HoldingNode).amount).toBe(810);
  });

  it('takes a job payment out of the right balance and leaves the others alone', () => {
    const d = diagram(
      [
        job('j1', [
          { asset: 'USD', amount: 800, active: true },
          { asset: 'PEN', amount: 500, active: true },
        ]),
        account('a1'),
        holding('h1', 'a1', 'USD', 0),
      ],
      [flow('f1', 'j1', 'h1', 'USD', 300)],
    );

    const after = executeFlow(d, 'f1');
    const balances = after.nodes.j1.kind === 'job' ? after.nodes.j1.balances : [];
    expect(balances.find((b) => b.asset === 'USD')?.amount).toBe(500);
    expect(balances.find((b) => b.asset === 'PEN')?.amount).toBe(500);
  });

  it('changes nothing at all when it would be refused', () => {
    const before = pair(1200, 1000);
    // Not "does nothing much" — the same document, so a caller that skipped the
    // check cannot half-apply a transfer.
    expect(executeFlow(before, 'f1')).toBe(before);
    expect(executeFlow(before, 'nope')).toBe(before);
  });

  it('leaves the source unable to execute the same flow twice', () => {
    const once = executeFlow(pair(250), 'f1');
    expect(canExecuteFlow(once, 'f1').ok).toBe(false);
    expect(executeFlow(once, 'f1')).toBe(once);
  });
});
