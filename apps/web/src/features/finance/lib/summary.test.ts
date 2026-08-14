import { describe, expect, it } from 'vitest';

import {
  selectAccountSummary,
  selectAllocation,
  selectAvailable,
  selectFrameSummary,
  selectInTransit,
  selectNodeContent,
} from '@/features/finance/lib/summary';
import { HOLDING_CONTENT_WIDTH, sizeOf } from '@/features/finance/lib/geometry';
import type {
  Balance,
  Diagram,
  Fee,
  FinanceNode,
  Flow,
  Frame,
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

function diagram(nodes: FinanceNode[], flows: Flow[] = [], frames: Frame[] = []): Diagram {
  return {
    id: 'd1',
    name: 'Cash flow',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    nodeOrder: nodes.map((node) => node.id),
    flows: Object.fromEntries(flows.map((item) => [item.id, item])),
    flowOrder: flows.map((item) => item.id),
    frames: Object.fromEntries(frames.map((item) => [item.id, item])),
    frameOrder: frames.map((item) => item.id),
  };
}

describe('account node geometry', () => {
  function contentFor(...holdings: FinanceNode[]) {
    const accountNode = account('a1');
    const model = diagram([accountNode, ...holdings]);
    return { account: accountNode, content: selectNodeContent(model, accountNode) };
  }

  it('shrinks a one-holding account to its own content', () => {
    const { account: accountNode, content } = contentFor(
      holding('h1', 'a1', 'USD', 12005.13, { position: { x: 0, y: 0 } }),
    );

    expect(content.holdingSpanWidth).toBe(HOLDING_CONTENT_WIDTH);
    expect(sizeOf(accountNode, content).width).toBeLessThan(240);
  });

  it('uses the holdings bounding box, including overlap rather than exact x columns', () => {
    const { content } = contentFor(
      holding('left', 'a1', 'USD', 0, { position: { x: -153, y: 0 } }),
      holding('right', 'a1', 'PEN', 0, { position: { x: -135, y: 0 } }),
    );

    expect(content.holdingSpanWidth).toBe(HOLDING_CONTENT_WIDTH + 18);
  });

  it('keeps an account wide when holdings truly occupy separate columns', () => {
    const { account: accountNode, content } = contentFor(
      holding('left', 'a1', 'USD', 0, { position: { x: -581, y: 0 } }),
      holding('right', 'a1', 'PEN', 0, { position: { x: -387, y: 0 } }),
    );

    expect(content.holdingSpanWidth).toBe(HOLDING_CONTENT_WIDTH + 194);
    expect(sizeOf(accountNode, content).width).toBeGreaterThan(240);
  });
});

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

describe('selectFrameSummary', () => {
  it('reports its members and nothing else', () => {
    const inside = holding('h1', 'a1', 'USD', 1000);
    const outside = holding('h2', 'a2', 'USD', 400);
    const document = diagram([account('a1'), account('a2'), inside, outside]);

    expect(selectAvailable(document)).toEqual([{ asset: 'USD', amount: 1400 }]);
    expect(selectFrameSummary(document, [inside])).toEqual({
      nodeCount: 1,
      totals: [{ asset: 'USD', amount: 1000 }],
    });
  });

  it('subtracts what a member committed, exactly as the headline does', () => {
    const source = holding('h1', 'a1', 'USD', 1000);
    const target = holding('h2', 'a2', 'USD', 0);
    const document = diagram(
      [account('a1'), account('a2'), source, target],
      [flow('f1', 'h1', 'h2', 'USD', 300)],
    );

    expect(selectFrameSummary(document, [source]).totals).toEqual([{ asset: 'USD', amount: 700 }]);
  });

  it('counts an account as holding nothing of its own', () => {
    const document = diagram([account('a1'), holding('h1', 'a1', 'USD', 500)]);

    // An account is never an endpoint, so a frame around one whose holdings sit
    // outside it honestly reports nothing — see decision 7.1.
    expect(selectFrameSummary(document, [document.nodes.a1])).toEqual({ nodeCount: 1, totals: [] });
  });

  it('never adds one asset to another', () => {
    const usd = holding('h1', 'a1', 'USD', 500);
    const eur = holding('h2', 'a1', 'EUR', 200);
    const document = diagram([account('a1'), usd, eur]);

    expect(selectFrameSummary(document, [usd, eur]).totals).toEqual([
      { asset: 'EUR', amount: 200 },
      { asset: 'USD', amount: 500 },
    ]);
  });

  it('leaves out a member that is switched off', () => {
    const off = holding('h1', 'a1', 'USD', 900, { active: false });
    const document = diagram([account('a1'), off]);

    expect(selectFrameSummary(document, [off]).totals).toEqual([]);
  });
});

describe('selectAllocation', () => {
  it('reports what is committed as well as what is left', () => {
    const d = diagram(
      [account('a1'), holding('h1', 'a1', 'USD', 1000), holding('h2', 'a1', 'USD', 0)],
      [flow('f1', 'h1', 'h2', 'USD', 900)],
    );

    expect(selectAllocation(d, 'h1', 'USD')).toEqual({
      total: 1000,
      committed: 900,
      remaining: 100,
      pct: 10,
      exceeded: false,
    });
  });

  it('says a balance is exceeded rather than pretending it is empty', () => {
    // The case worth having: a diagram that does not add up. `remaining` is
    // reported negative because that is the fact; only `pct` is clamped,
    // because a share of a balance cannot be less than none of it.
    const d = diagram(
      [account('a1'), holding('h1', 'a1', 'USD', 100), holding('h2', 'a1', 'USD', 0)],
      [flow('f1', 'h1', 'h2', 'USD', 250)],
    );

    expect(selectAllocation(d, 'h1', 'USD')).toMatchObject({
      remaining: -150,
      pct: 0,
      exceeded: true,
    });
  });

  it('counts only the flows of the asset asked about', () => {
    const d = diagram(
      [
        job('j1', [{ asset: 'USD', amount: 500, active: true }]),
        account('a1'),
        holding('h1', 'a1', 'PEN', 0),
      ],
      [flow('f1', 'j1', 'h1', 'PEN', 400)],
    );

    // The job's PEN flow must not eat into its USD balance.
    expect(selectAllocation(d, 'j1', 'USD')).toMatchObject({ committed: 0, remaining: 500 });
  });

  it('has nothing to say about an inactive balance or an account', () => {
    const d = diagram([account('a1'), job('j1', [{ asset: 'USD', amount: 500, active: false }])]);

    expect(selectAllocation(d, 'j1', 'USD')).toBeNull();
    // An account holds nothing itself — its holdings do.
    expect(selectAllocation(d, 'a1', 'USD')).toBeNull();
  });

  it('divides nothing by nothing without producing a number', () => {
    const d = diagram([account('a1'), holding('h1', 'a1', 'USD', 0)]);
    expect(selectAllocation(d, 'h1', 'USD')).toMatchObject({ pct: 0, exceeded: false });
  });
});
