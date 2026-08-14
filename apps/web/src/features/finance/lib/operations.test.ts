import { describe, expect, it } from 'vitest';

import { createEmptyDiagram } from '@/features/finance/lib/document';
import {
  addAccount,
  addHolding,
  addJob,
  addJobAsset,
  connect,
  deleteFlow,
  deleteNode,
  describeConnectError,
  moveNode,
  setHoldingActive,
  setJobBalance,
  updateFlow,
  updateHolding,
} from '@/features/finance/lib/operations';
import type { Diagram, HoldingNode, JobNode } from '@/features/finance/model/types';

const origin = { x: 0, y: 0 };

/** A bank with USD and PEN, a broker with USD, and a job paid in USD. */
function scenario(): Diagram {
  let diagram = createEmptyDiagram('d1');
  diagram = addAccount(diagram, { id: 'bank', position: origin, name: 'Bank' });
  diagram = addAccount(diagram, { id: 'broker', position: origin, name: 'Broker' });
  diagram = addJob(diagram, { id: 'job', position: origin, name: 'Job' });
  diagram = addJobAsset(diagram, 'job', 'USD');

  const usd = addHolding(diagram, {
    id: 'bankUsd',
    accountId: 'bank',
    asset: 'USD',
    position: origin,
  });
  const pen = addHolding(usd.ok ? usd.value : diagram, {
    id: 'bankPen',
    accountId: 'bank',
    asset: 'PEN',
    position: origin,
  });
  const brokerUsd = addHolding(pen.ok ? pen.value : diagram, {
    id: 'brokerUsd',
    accountId: 'broker',
    asset: 'USD',
    position: origin,
  });
  return brokerUsd.ok ? brokerUsd.value : diagram;
}

function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('node transitions', () => {
  it('never mutates the diagram it is given', () => {
    const before = createEmptyDiagram('d1');
    const after = addJob(before, { id: 'j1', position: origin });

    expect(before.nodeOrder).toEqual([]);
    expect(after.nodeOrder).toEqual(['j1']);
    expect(after).not.toBe(before);
  });

  it('appends new nodes to the order but keeps it stable on edits', () => {
    let diagram = addJob(createEmptyDiagram('d1'), { id: 'j1', position: origin });
    diagram = addAccount(diagram, { id: 'a1', position: origin });
    diagram = moveNode(diagram, 'j1', { x: 50, y: 60 });

    expect(diagram.nodeOrder).toEqual(['j1', 'a1']);
    expect(diagram.nodes.j1.position).toEqual({ x: 50, y: 60 });
  });

  it('ignores an edit aimed at a node that is not there', () => {
    const diagram = createEmptyDiagram('d1');
    expect(moveNode(diagram, 'ghost', { x: 1, y: 1 })).toBe(diagram);
  });
});

describe('addHolding', () => {
  it('refuses an account that does not exist', () => {
    const result = addHolding(createEmptyDiagram('d1'), {
      id: 'h1',
      accountId: 'ghost',
      asset: 'USD',
      position: origin,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('account-missing');
  });

  it('refuses an asset the account already holds', () => {
    const result = addHolding(scenario(), {
      id: 'dup',
      accountId: 'bank',
      asset: 'USD',
      position: origin,
    });
    expect(result.ok === false && result.error).toEqual({
      code: 'asset-already-held',
      asset: 'USD',
    });
  });

  it('reactivates a switched-off asset instead of creating a second one', () => {
    const withOff = setHoldingActive(scenario(), 'bankUsd', false);
    const restored = expectOk(
      addHolding(withOff, { id: 'other', accountId: 'bank', asset: 'usd', position: origin }),
    );

    expect(restored.nodes.other).toBeUndefined();
    const holding = restored.nodes.bankUsd as HoldingNode;
    expect(holding.active).toBe(true);
  });

  it('keeps the amount of a holding switched off and on again', () => {
    let diagram = updateHolding(scenario(), 'bankUsd', { amount: 250 });
    diagram = setHoldingActive(diagram, 'bankUsd', false);
    diagram = setHoldingActive(diagram, 'bankUsd', true);
    expect((diagram.nodes.bankUsd as HoldingNode).amount).toBe(250);
  });

  it('normalizes edited fees so they cannot create money', () => {
    const diagram = updateHolding(scenario(), 'bankUsd', {
      fees: { out: { type: 'fixed', value: -5 }, in: { type: 'percent', value: 120 } },
    });

    expect((diagram.nodes.bankUsd as HoldingNode).fees).toEqual({
      out: { type: 'fixed', value: 0 },
      in: { type: 'percent', value: 100 },
    });
  });
});

describe('job balances', () => {
  it('adds an asset once and normalizes its code', () => {
    let diagram = addJob(createEmptyDiagram('d1'), { id: 'j1', position: origin });
    diagram = addJobAsset(diagram, 'j1', ' usdt ');
    diagram = addJobAsset(diagram, 'j1', 'USDT');

    expect((diagram.nodes.j1 as JobNode).balances).toEqual([
      { asset: 'USDT', amount: null, active: true },
    ]);
  });

  it('keeps the amount when an asset is switched off and on', () => {
    let diagram = addJob(createEmptyDiagram('d1'), { id: 'j1', position: origin });
    diagram = addJobAsset(diagram, 'j1', 'USD');
    diagram = setJobBalance(diagram, 'j1', 'USD', 900);
    diagram = addJobAsset(diagram, 'j1', 'USD'); // re-adding reactivates

    expect((diagram.nodes.j1 as JobNode).balances).toEqual([
      { asset: 'USD', amount: 900, active: true },
    ]);
  });

  it('ignores a blank asset code', () => {
    const diagram = addJob(createEmptyDiagram('d1'), { id: 'j1', position: origin });
    expect(addJobAsset(diagram, 'j1', '   ')).toBe(diagram);
  });
});

describe('connect', () => {
  it('links a job to a holding of an asset it is paid in', () => {
    const diagram = expectOk(connect(scenario(), { id: 'f1', from: 'job', to: 'bankUsd' }));
    expect(diagram.flows.f1.asset).toBe('USD');
    expect(diagram.flowOrder).toEqual(['f1']);
  });

  it('links holdings that sit in different accounts', () => {
    const diagram = expectOk(connect(scenario(), { id: 'f1', from: 'bankUsd', to: 'brokerUsd' }));
    expect(diagram.flows.f1.from).toBe('bankUsd');
  });

  it.each([
    ['a node to itself', 'bankUsd', 'bankUsd', 'same-node'],
    ['anything into a job', 'bankUsd', 'job', 'job-target'],
    ['an account as the source', 'bank', 'brokerUsd', 'account-endpoint'],
    ['an account as the target', 'bankUsd', 'broker', 'account-endpoint'],
    ['two holdings of one account', 'bankUsd', 'bankPen', 'same-account'],
  ])('refuses %s', (_label, from, to, code) => {
    const result = connect(scenario(), { id: 'f1', from, to });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe(code);
  });

  it('refuses an asset the job is not paid in, and names it', () => {
    const result = connect(scenario(), { id: 'f1', from: 'job', to: 'bankPen' });
    expect(result.ok === false && result.error).toEqual({
      code: 'asset-not-on-job',
      asset: 'PEN',
    });
  });

  it('refuses a second flow between the same pair, in either direction', () => {
    const linked = expectOk(connect(scenario(), { id: 'f1', from: 'bankUsd', to: 'brokerUsd' }));

    expect(connect(linked, { id: 'f2', from: 'bankUsd', to: 'brokerUsd' }).ok).toBe(false);
    const reversed = connect(linked, { id: 'f3', from: 'brokerUsd', to: 'bankUsd' });
    expect(reversed.ok === false && reversed.error.code).toBe('already-connected');
  });

  it('explains every refusal in words', () => {
    const codes = [
      { code: 'same-node' },
      { code: 'missing-node' },
      { code: 'already-connected' },
      { code: 'job-target' },
      { code: 'account-endpoint' },
      { code: 'same-account' },
      { code: 'asset-not-on-job', asset: 'PEN' },
    ] as const;

    for (const error of codes) {
      expect(describeConnectError(error)).toMatch(/\S/);
    }
  });
});

describe('deletion', () => {
  it('takes an account holdings with it', () => {
    const diagram = deleteNode(scenario(), 'bank');

    expect(diagram.nodes.bank).toBeUndefined();
    expect(diagram.nodes.bankUsd).toBeUndefined();
    expect(diagram.nodes.bankPen).toBeUndefined();
    expect(diagram.nodes.brokerUsd).toBeDefined();
    expect(diagram.nodeOrder).toEqual(['broker', 'job', 'brokerUsd']);
  });

  it('drops the flows attached to whatever it removes', () => {
    let diagram = expectOk(connect(scenario(), { id: 'f1', from: 'job', to: 'bankUsd' }));
    diagram = expectOk(connect(diagram, { id: 'f2', from: 'bankUsd', to: 'brokerUsd' }));

    const after = deleteNode(diagram, 'bank');
    expect(after.flows).toEqual({});
    expect(after.flowOrder).toEqual([]);
  });

  it('removes a single holding without touching its account', () => {
    const diagram = deleteNode(scenario(), 'bankUsd');
    expect(diagram.nodes.bank).toBeDefined();
    expect(diagram.nodes.bankPen).toBeDefined();
    expect(diagram.nodes.bankUsd).toBeUndefined();
  });

  it('leaves the diagram alone for an unknown id', () => {
    const diagram = scenario();
    expect(deleteNode(diagram, 'ghost')).toBe(diagram);
    expect(deleteFlow(diagram, 'ghost')).toBe(diagram);
  });
});

describe('flow edits', () => {
  it('updates an amount without disturbing the order', () => {
    let diagram = expectOk(connect(scenario(), { id: 'f1', from: 'bankUsd', to: 'brokerUsd' }));
    diagram = updateFlow(diagram, 'f1', { amount: 500, label: 'rent' });

    expect(diagram.flows.f1.amount).toBe(500);
    expect(diagram.flows.f1.label).toBe('rent');
    expect(diagram.flowOrder).toEqual(['f1']);
  });

  it('deletes a flow and forgets its place in the order', () => {
    const diagram = expectOk(connect(scenario(), { id: 'f1', from: 'bankUsd', to: 'brokerUsd' }));
    const after = deleteFlow(diagram, 'f1');

    expect(after.flows).toEqual({});
    expect(after.flowOrder).toEqual([]);
  });
});
