import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { NO_FINANCE_CAMERA_VIEWS } from '@/features/finance/lib/cameraViews';
import { frameMembership } from '@/features/finance/lib/frames';
import {
  selectAccountSummary,
  selectAssetAllocations,
  selectNodeContent,
} from '@/features/finance/lib/summary';
import type { Diagram, FinanceNode, Frame, HoldingNode } from '@/features/finance/model/types';

import { FlowCanvas } from './FlowCanvas';

/**
 * Opt-in benchmark: it is skipped in the normal suite because elapsed time is
 * machine-dependent. Reproduce with:
 *
 *   FINANCE_PERF=1 npm --prefix apps/web test -- --testTimeout=30000 \
 *     src/features/finance/ui/FlowCanvas.perf.test.tsx
 */
const environment = globalThis as typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
    stdout?: { write: (line: string) => boolean };
  };
};
const describePerformance =
  environment.process?.env?.FINANCE_PERF === '1' ? describe : describe.skip;

function report(measurement: Record<string, string | number>): void {
  const line = JSON.stringify(measurement);
  // Direct stdout survives Vitest's successful-test console suppression and
  // makes an opt-in run easy to capture with shell redirection.
  environment.process?.stdout?.write(`${line}\n`);
}

afterEach(cleanup);

function TestWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const next = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    next.setQueryData(['storage', 'finance-camera-views'], NO_FINANCE_CAMERA_VIEWS);
    return next;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const ASSETS = ['USD', 'EUR', 'PEN', 'BTC', 'ETH', 'AAPL', 'NVDA', 'SCHD', 'GLDM', 'SPY'];
const IBKR_OFFSETS = [-94, 57, 63, 174, 176, 324, 326, 437, 439, 532, 535, 686];

/** 25% accounts / 75% holdings, including one 12-holding account like the real document. */
function realisticDiagram(nodeCount: number): Diagram {
  const accountCount = Math.floor(nodeCount / 4);
  const holdingCount = nodeCount - accountCount;
  const accounts: FinanceNode[] = Array.from({ length: accountCount }, (_, index) => ({
    id: `account-${index}`,
    kind: 'account',
    name: index === 0 ? 'IBKR' : `Account ${index + 1}`,
    notes: '',
    position: { x: (index % 5) * 1000, y: Math.floor(index / 5) * 900 },
  }));
  const holdings: HoldingNode[] = Array.from({ length: holdingCount }, (_, index) => {
    const accountIndex = index < 12 ? 0 : 1 + ((index - 12) % Math.max(1, accountCount - 1));
    const localIndex =
      index < 12 ? index : Math.floor((index - 12) / Math.max(1, accountCount - 1));
    const owner = accounts[accountIndex];
    const xOffset =
      accountIndex === 0
        ? IBKR_OFFSETS[localIndex % IBKR_OFFSETS.length]
        : (localIndex % 3) * 151 + (localIndex % 2 ? 4 : 0);

    return {
      id: `holding-${index}`,
      kind: 'holding',
      name: ASSETS[index % ASSETS.length],
      notes: '',
      accountId: owner.id,
      asset: `${ASSETS[index % ASSETS.length]}${index}`,
      amount: 12005.13 - index * 7,
      active: true,
      fees: { in: null, out: index % 7 === 0 ? { type: 'percent', value: 0.25 } : null },
      position: { x: owner.position.x + xOffset, y: owner.position.y + 180 + localIndex * 116 },
    };
  });
  const frames: Frame[] = accounts
    .filter((_, index) => index % 4 === 0)
    .map((account, index) => ({
      id: `frame-${index}`,
      name: `Group ${index + 1}`,
      position: { x: account.position.x - 140, y: account.position.y - 80 },
      size: { width: 920, height: 760 },
    }));
  const flows = holdings.slice(0, -1).map((holding, index) => ({
    id: `flow-${index}`,
    from: holding.id,
    to: holdings[index + 1].id,
    fromAnchor: 'r' as const,
    toAnchor: 'l' as const,
    amount: 10,
    asset: holding.asset,
    label: index % 9 === 0 ? 'Scheduled transfer' : '',
    notes: '',
    labelOffset: null,
  }));
  const nodes = [...accounts, ...holdings];

  return {
    id: `perf-${nodeCount}`,
    name: `Performance ${nodeCount}`,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    nodeOrder: nodes.map((node) => node.id),
    flows: Object.fromEntries(flows.map((flow) => [flow.id, flow])),
    flowOrder: flows.map((flow) => flow.id),
    frames: Object.fromEntries(frames.map((frame) => [frame.id, frame])),
    frameOrder: frames.map((frame) => frame.id),
  };
}

function elapsed(work: () => void): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

function sampled(work: () => void): number {
  // One timed run keeps the opt-in benchmark practical on WSL's mounted drive.
  // Its output is a local baseline, not a cross-machine performance threshold.
  return elapsed(work);
}

function selectorPass(diagram: Diagram): void {
  for (const id of diagram.nodeOrder) {
    const node = diagram.nodes[id];
    selectNodeContent(diagram, node);
    selectAssetAllocations(diagram, node);
    if (node.kind === 'account') selectAccountSummary(diagram, node.id);
  }
  frameMembership(diagram);
}

function repeatedSelectorPass(diagram: Diagram): void {
  // `FlowCanvas` asks these derived questions from several rendering branches.
  // Four passes estimates the avoidable work if one render-scoped cache served
  // those branches; it does not change production behaviour.
  for (let pass = 0; pass < 4; pass += 1) selectorPass(diagram);
}

function cachedSelectorPass(diagram: Diagram): number {
  const content = new Map<string, ReturnType<typeof selectNodeContent>>();
  const allocations = new Map<string, ReturnType<typeof selectAssetAllocations>>();
  const summaries = new Map<string, ReturnType<typeof selectAccountSummary>>();
  for (const id of diagram.nodeOrder) {
    const node = diagram.nodes[id];
    content.set(id, selectNodeContent(diagram, node));
    allocations.set(id, selectAssetAllocations(diagram, node));
    if (node.kind === 'account') summaries.set(id, selectAccountSummary(diagram, node.id));
  }
  const memberships = frameMembership(diagram);

  let cacheHits = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    for (const id of diagram.nodeOrder) {
      if (content.has(id)) cacheHits += 1;
      if (allocations.has(id)) cacheHits += 1;
      if (summaries.has(id)) cacheHits += 1;
    }
    cacheHits += memberships.size;
  }
  return cacheHits;
}

function nodeContentCost(diagram: Diagram): void {
  for (const id of diagram.nodeOrder) selectNodeContent(diagram, diagram.nodes[id]);
}

function allocationCost(diagram: Diagram): void {
  for (const id of diagram.nodeOrder) selectAssetAllocations(diagram, diagram.nodes[id]);
}

function accountSummaryCost(diagram: Diagram, accounts: FinanceNode[]): void {
  for (const account of accounts) selectAccountSummary(diagram, account.id);
}

function renderCost(diagram: Diagram): number {
  return sampled(() => {
    const view = render(
      <FlowCanvas
        diagram={diagram}
        selection={null}
        connectMode={false}
        connectFrom={null}
        frameMode={false}
        onSelect={() => undefined}
        onMoveNode={() => undefined}
        onAnchorClick={() => undefined}
        onCreateFrame={() => undefined}
        onMoveFrame={() => undefined}
        onResizeFrame={() => undefined}
      />,
      { wrapper: TestWrapper },
    );
    view.unmount();
  });
}

function dragCost(diagram: Diagram): number {
  const view = render(
    <FlowCanvas
      diagram={diagram}
      selection={null}
      connectMode={false}
      connectFrom={null}
      frameMode={false}
      onSelect={() => undefined}
      onMoveNode={() => undefined}
      onAnchorClick={() => undefined}
      onCreateFrame={() => undefined}
      onMoveFrame={() => undefined}
      onResizeFrame={() => undefined}
    />,
    { wrapper: TestWrapper },
  );
  const node = view.container.querySelector('[data-node-id="holding-0"]');
  if (!node) throw new Error('performance fixture must render holding-0');

  // Twenty pointer moves are long enough to exercise a sustained drag while
  // keeping the 500-node scenario reproducible on WSL's mounted drive.
  const cost = sampled(() => {
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
    for (let step = 1; step <= 20; step += 1) {
      fireEvent.pointerMove(node, { pointerId: 1, clientX: 10 + step, clientY: 10 + step });
    }
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 30, clientY: 30 });
  });
  view.unmount();
  return cost;
}

describePerformance('FlowCanvas performance baseline', () => {
  it.each([100, 500])(
    '%i nodes',
    (nodeCount) => {
      const diagram = realisticDiagram(nodeCount);
      const accounts = diagram.nodeOrder
        .map((id) => diagram.nodes[id])
        .filter((node) => node.kind === 'account');
      const accountGeometry = sampled(() => {
        for (const account of accounts) selectNodeContent(diagram, account);
      });
      const nodeContent = sampled(() => nodeContentCost(diagram));
      const allocations = sampled(() => allocationCost(diagram));
      const accountSummaries = sampled(() => accountSummaryCost(diagram, accounts));
      const memberships = sampled(() => frameMembership(diagram));
      const oneSelectorPass = sampled(() => selectorPass(diagram));
      const repeatedSelectors = sampled(() => repeatedSelectorPass(diagram));
      const cachedSelectors = sampled(() => cachedSelectorPass(diagram));
      const render = renderCost(diagram);
      const drag = dragCost(diagram);
      const memoizableSaving = ((repeatedSelectors - cachedSelectors) / repeatedSelectors) * 100;

      report({
        scenario: `${nodeCount} nodes (${accounts.length} accounts, ${nodeCount - accounts.length} holdings)`,
        accountGeometryMs: Number(accountGeometry.toFixed(2)),
        nodeContentMs: Number(nodeContent.toFixed(2)),
        assetAllocationsMs: Number(allocations.toFixed(2)),
        accountSummariesMs: Number(accountSummaries.toFixed(2)),
        frameMembershipMs: Number(memberships.toFixed(2)),
        selectorPassMs: Number(oneSelectorPass.toFixed(2)),
        repeatedSelectorsMs: Number(repeatedSelectors.toFixed(2)),
        cachedSelectorsMs: Number(cachedSelectors.toFixed(2)),
        estimatedMemoizableSelectorSavingPct: Number(memoizableSaving.toFixed(1)),
        fullRenderMs: Number(render.toFixed(2)),
        sustained20MoveDragMs: Number(drag.toFixed(2)),
      });

      expect(render).toBeGreaterThan(0);
      expect(drag).toBeGreaterThan(0);
    },
    60_000,
  );
});
