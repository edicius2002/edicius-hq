import { describe, expect, it } from 'vitest';

import {
  selectAccountSummary,
  selectAvailable,
  selectInTransit,
} from '@/features/finance/lib/summary';
import type {
  Balance,
  Diagram,
  Fee,
  FinanceNode,
  Flow,
  HoldingNode,
} from '@/features/finance/model/types';

const percent = (value: number): Fee => ({ value, type: 'percent' });
const fixed = (value: number): Fee => ({ value, type: 'fixed' });

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
  };
}

describe('selectAvailable', () => {
  it('subtracts what a source already committed', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 1000),
        account('a2'),
        holding('h2', 'a2', 'USD', 0),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 400)],
    );
    expect(selectAvailable(model)).toEqual([{ asset: 'USD', amount: 600 }]);
  });

  it('never adds different assets together', () => {
    const model = diagram([
      account('a1'),
      holding('h1', 'a1', 'USD', 100),
      holding('h2', 'a1', 'PEN', 200),
    ]);
    expect(selectAvailable(model)).toEqual([
      { asset: 'PEN', amount: 200 },
      { asset: 'USD', amount: 100 },
    ]);
  });

  it('counts a job balance per asset', () => {
    const model = diagram([
      job('j1', [
        { asset: 'USD', amount: 500, active: true },
        { asset: 'PEN', amount: 300, active: true },
      ]),
    ]);
    expect(selectAvailable(model)).toEqual([
      { asset: 'PEN', amount: 300 },
      { asset: 'USD', amount: 500 },
    ]);
  });

  it('skips inactive balances and inactive holdings', () => {
    const model = diagram([
      job('j1', [
        { asset: 'USD', amount: 500, active: false },
        { asset: 'PEN', amount: 300, active: true },
      ]),
      account('a1'),
      holding('h1', 'a1', 'EUR', 900, { active: false }),
    ]);
    expect(selectAvailable(model)).toEqual([{ asset: 'PEN', amount: 300 }]);
  });
});

describe('selectInTransit', () => {
  it('reports the net after the fee chain, not the gross', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 1000, { fees: { in: null, out: percent(10) } }),
        account('a2'),
        holding('h2', 'a2', 'USD', 0, { fees: { in: percent(10), out: null } }),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 1000)],
    );
    // 1000 -> 900 -> 810, the running-amount chain rather than 800.
    expect(selectInTransit(model)).toEqual([{ asset: 'USD', amount: 810 }]);
  });

  it('ignores a flow with no amount', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 100),
        account('a2'),
        holding('h2', 'a2', 'USD', 0),
      ],
      [flow('f1', 'h1', 'h2', 'USD', null)],
    );
    expect(selectInTransit(model)).toEqual([]);
  });

  it('ignores a flow whose fixed fee swallows the amount', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 100),
        account('a2'),
        holding('h2', 'a2', 'USD', 0, { fees: { in: fixed(50), out: null } }),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 40)],
    );
    expect(selectInTransit(model)).toEqual([]);
  });

  it('drops every flow of a source that committed more than it holds', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 100),
        account('a2'),
        holding('h2', 'a2', 'USD', 0),
        account('a3'),
        holding('h3', 'a3', 'USD', 0),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 80), flow('f2', 'h1', 'h3', 'USD', 80)],
    );
    // 160 committed against 100 held, so neither flow counts.
    expect(selectInTransit(model)).toEqual([]);
  });

  it('keeps the flows when the source is exactly spent', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 100),
        account('a2'),
        holding('h2', 'a2', 'USD', 0),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 100)],
    );
    expect(selectInTransit(model)).toEqual([{ asset: 'USD', amount: 100 }]);
  });

  it('ignores a flow whose destination is switched off', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 1000),
        account('a2'),
        holding('h2', 'a2', 'USD', 0, { active: false }),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 500)],
    );
    // Nothing can arrive at a holding that is out of play.
    expect(selectInTransit(model)).toEqual([]);
  });

  it('ignores a flow whose source is switched off', () => {
    const model = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 1000, { active: false }),
        account('a2'),
        holding('h2', 'a2', 'USD', 0),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 500)],
    );
    expect(selectInTransit(model)).toEqual([]);
  });

  it('counts the flow again once the holding comes back', () => {
    const nodes = [
      account('a1'),
      holding('h1', 'a1', 'USD', 1000),
      account('a2'),
      holding('h2', 'a2', 'USD', 0),
    ];
    const flows = [flow('f1', 'h1', 'h2', 'USD', 500)];
    expect(selectInTransit(diagram(nodes, flows))).toEqual([{ asset: 'USD', amount: 500 }]);
  });

  it('checks a job source per asset rather than in total', () => {
    const model = diagram(
      [
        job('j1', [
          { asset: 'USD', amount: 100, active: true },
          { asset: 'PEN', amount: 100, active: true },
        ]),
        account('a1'),
        holding('hUsd', 'a1', 'USD', 0),
        holding('hPen', 'a1', 'PEN', 0),
      ],
      [flow('f1', 'j1', 'hUsd', 'USD', 90), flow('f2', 'j1', 'hPen', 'PEN', 90)],
    );
    // 180 across the two assets, but neither asset is over its own 100.
    expect(selectInTransit(model)).toEqual([
      { asset: 'PEN', amount: 90 },
      { asset: 'USD', amount: 90 },
    ]);
  });
});

describe('selectAccountSummary', () => {
  const model = diagram(
    [
      account('bank'),
      holding('usd', 'bank', 'USD', 1000),
      holding('pen', 'bank', 'PEN', 500),
      holding('old', 'bank', 'EUR', 700, { active: false }),
      account('broker'),
      holding('bUsd', 'broker', 'USD', 0),
      job('j1', [{ asset: 'USD', amount: 400, active: true }]),
    ],
    [
      flow('out1', 'usd', 'bUsd', 'USD', 300),
      flow('in1', 'j1', 'usd', 'USD', 400),
      flow('in2', 'bUsd', 'pen', 'PEN', 100),
    ],
  );

  const summary = selectAccountSummary(model, 'bank');

  it('shows what each active holding has left after its commitments', () => {
    expect(summary.remaining).toEqual([
      { asset: 'PEN', amount: 500 },
      { asset: 'USD', amount: 700 }, // 1000 held less the 300 sent out
    ]);
  });

  it('leaves inactive holdings out of the account view', () => {
    expect(summary.remaining.some((total) => total.asset === 'EUR')).toBe(false);
  });

  it('counts incoming and outgoing operations separately, broken down by asset', () => {
    expect(summary.outgoing).toEqual({ count: 1, totals: [{ asset: 'USD', amount: 300 }] });
    expect(summary.incoming).toEqual({
      count: 2,
      totals: [
        { asset: 'PEN', amount: 100 },
        { asset: 'USD', amount: 400 },
      ],
    });
  });

  it('keeps an emptied holding visible on its own account', () => {
    const emptied = diagram([account('a1'), holding('h1', 'a1', 'USD', null)]);
    expect(selectAccountSummary(emptied, 'a1').remaining).toEqual([{ asset: 'USD', amount: 0 }]);
  });

  it('counts the net that arrived, not the gross that was sent', () => {
    const withFee = diagram(
      [
        account('a1'),
        holding('h1', 'a1', 'USD', 1000),
        account('a2'),
        holding('h2', 'a2', 'USD', 0, { fees: { in: percent(10), out: null } }),
      ],
      [flow('f1', 'h1', 'h2', 'USD', 500)],
    );
    expect(selectAccountSummary(withFee, 'a2').incoming.totals).toEqual([
      { asset: 'USD', amount: 450 },
    ]);
    expect(selectAccountSummary(withFee, 'a1').outgoing.totals).toEqual([
      { asset: 'USD', amount: 500 },
    ]);
  });
});
