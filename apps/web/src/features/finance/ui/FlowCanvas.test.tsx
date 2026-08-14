import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmptyDiagram } from '@/features/finance/lib/document';
import { addAccount, addFrame, addHolding, addJob, connect, updateFlow } from '@/features/finance/lib/operations';
import type { Diagram } from '@/features/finance/model/types';
import { NO_FINANCE_CAMERA_VIEWS } from '@/features/finance/lib/cameraViews';

import { FlowCanvas } from './FlowCanvas';

afterEach(cleanup);

function TestWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const next = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    // The camera store is present before the canvas mounts, so these interaction
    // tests do not need an HTTP server just to exercise local camera movement.
    next.setQueryData(['storage', 'finance-camera-views'], NO_FINANCE_CAMERA_VIEWS);
    return next;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function populated(id = 'd1'): Diagram {
  let diagram = createEmptyDiagram(id);
  diagram = addJob(diagram, { id: 'job-1', position: { x: 40, y: 40 } });
  diagram = addAccount(diagram, { id: 'acc-1', position: { x: 400, y: 300 } });
  return diagram;
}

function canvasProps() {
  return {
    selection: null,
    connectMode: false,
    connectFrom: null,
    frameMode: false,
    onSelect: vi.fn(),
    onMoveNode: vi.fn(),
    onAnchorClick: vi.fn(),
    onCreateFrame: vi.fn(),
    onMoveFrame: vi.fn(),
    onResizeFrame: vi.fn(),
  };
}

function renderCanvas(diagram: Diagram) {
  return render(<FlowCanvas diagram={diagram} {...canvasProps()} />, { wrapper: TestWrapper });
}

describe('camera controls', () => {
  it('starts at 100%', () => {
    renderCanvas(populated());
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' })).toHaveTextContent('100%');
  });

  it('steps the zoom in and out', async () => {
    const user = userEvent.setup();
    renderCanvas(populated());
    const level = screen.getByRole('button', { name: 'Reset zoom to 100%' });

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(level).toHaveTextContent('120%');

    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(level).toHaveTextContent('100%');
  });

  it('goes back to 100% from the level itself', async () => {
    const user = userEvent.setup();
    renderCanvas(populated());
    const level = screen.getByRole('button', { name: 'Reset zoom to 100%' });

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(level).not.toHaveTextContent('100%');

    await user.click(level);
    expect(level).toHaveTextContent('100%');
  });

  it('stops at the far end of the range instead of running away', async () => {
    const user = userEvent.setup();
    renderCanvas(populated());
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });

    for (let press = 0; press < 12; press += 1) await user.click(zoomIn);
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' })).toHaveTextContent('300%');
  });
});

describe('minimap', () => {
  it('marks every node on the canvas', () => {
    renderCanvas(populated());
    const minimap = screen.getByRole('img', { name: 'Diagram minimap' });
    expect(minimap.querySelectorAll('rect')).toHaveLength(2);
  });

  it('stays away while there is nothing to map', () => {
    renderCanvas(createEmptyDiagram('empty'));
    expect(screen.queryByRole('img', { name: 'Diagram minimap' })).not.toBeInTheDocument();
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });
});

describe('flow labels', () => {
  it('draws an edited label above the amount', () => {
    let diagram = addAccount(createEmptyDiagram('label'), {
      id: 'source-account',
      position: { x: 0, y: 0 },
    });
    const source = addHolding(diagram, {
      id: 'source',
      accountId: 'source-account',
      asset: 'USD',
      position: { x: 0, y: 0 },
    });
    if (!source.ok) throw new Error('fixture should add source holding');
    diagram = addAccount(source.value, { id: 'target-account', position: { x: 400, y: 0 } });
    const target = addHolding(diagram, {
      id: 'target',
      accountId: 'target-account',
      asset: 'USD',
      position: { x: 400, y: 0 },
    });
    if (!target.ok) throw new Error('fixture should add target holding');
    const flow = connect(target.value, { id: 'f1', from: 'source', to: 'target', amount: 50 });
    if (!flow.ok) throw new Error('fixture should connect holdings');

    renderCanvas(updateFlow(flow.value, 'f1', { label: 'Salary' }));
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });
});

describe('per-diagram cameras', () => {
  it('keeps each diagram at its own zoom', async () => {
    const user = userEvent.setup();
    const first = populated('d1');
    const second = populated('d2');

    const { rerender } = renderCanvas(first);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' })).toHaveTextContent('120%');

    const props = canvasProps();

    // Switching to the other diagram shows its own camera, not the one left behind.
    rerender(<FlowCanvas diagram={second} {...props} />);
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' })).toHaveTextContent('100%');

    // And coming back finds the first one where it was.
    rerender(<FlowCanvas diagram={first} {...props} />);
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' })).toHaveTextContent('120%');
  });
});

/**
 * A press that starts a gesture has to claim the default, or the browser reads
 * the same drag as a text selection and the labels light up blue behind the
 * thing being moved. These check the claim is made, since the stylesheet half of
 * the fix cannot be seen from jsdom.
 */
describe('gestures do not double as text selection', () => {
  function pressed(element: Element): boolean {
    // fireEvent returns false once a listener has prevented the default.
    return !fireEvent.pointerDown(element, { bubbles: true, cancelable: true, pointerId: 1 });
  }

  it('claims the press that starts a node drag', () => {
    renderCanvas(populated());
    expect(pressed(screen.getByLabelText('Job Job'))).toBe(true);
  });

  it('claims the press that starts a pan', () => {
    const { container } = renderCanvas(populated());
    const viewport = container.firstElementChild;
    expect(viewport).not.toBeNull();
    expect(pressed(viewport as Element)).toBe(true);
  });

  it('claims the press that starts a frame move', () => {
    renderCanvas(
      addFrame(populated(), {
        id: 'f1',
        position: { x: 0, y: 0 },
        size: { width: 320, height: 240 },
        name: 'Savings',
      }),
    );
    const header = screen.getByTitle('Drag to move the frame');
    expect(pressed(header)).toBe(true);
  });

  it('leaves a press on the zoom controls alone, so they still take a click', () => {
    renderCanvas(populated());
    // Not a gesture: the button needs its default to focus and activate.
    expect(pressed(screen.getByRole('button', { name: 'Zoom in' }))).toBe(false);
  });
});

/**
 * Saving is a round trip and the canvas draws from the saved document, so a node
 * that waited for the write to land trailed the pointer and stopped dead when one
 * was slow. These drive a drag while the diagram prop never changes — storage
 * saying nothing at all — and expect the node to have moved anyway.
 */
describe('a drag draws itself, without waiting for storage', () => {
  function drag(element: Element, to: { x: number; y: number }) {
    fireEvent.pointerDown(element, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerMove(element, { bubbles: true, pointerId: 1, clientX: to.x, clientY: to.y });
  }

  it('moves the node with the pointer while the document stays put', () => {
    const props = canvasProps();
    // The job sits at 40,40 and is grabbed 10px in, so it lands at 140,140.
    render(<FlowCanvas diagram={populated()} {...props} />, { wrapper: TestWrapper });
    const node = screen.getByLabelText('Job Job');

    drag(node, { x: 150, y: 150 });

    expect(node).toHaveStyle({ left: '140px', top: '140px' });
    // Storage is still told; it is only no longer what the canvas draws from.
    expect(props.onMoveNode).toHaveBeenCalledWith('job-1', { x: 140, y: 140 });
  });

  it('carries what is drawn from it rather than leaving it behind', () => {
    // The account owns a holding, so a tether is drawn between the two.
    const held = addHolding(populated(), {
      id: 'h1',
      accountId: 'acc-1',
      asset: 'USD',
      position: { x: 600, y: 300 },
    });
    if (!held.ok) throw new Error('the fixture should hold an asset');

    const { container } = render(<FlowCanvas diagram={held.value} {...canvasProps()} />, {
      wrapper: TestWrapper,
    });
    const before = container.querySelector('svg path')?.getAttribute('d');
    expect(before).toBeTruthy();

    drag(screen.getByLabelText('Account Account'), { x: 400, y: 400 });

    expect(container.querySelector('svg path')?.getAttribute('d')).not.toBe(before);
  });

  it('hands the position back to the document once the gesture ends', () => {
    const props = canvasProps();
    const { rerender } = render(<FlowCanvas diagram={populated()} {...props} />, {
      wrapper: TestWrapper,
    });
    const node = screen.getByLabelText('Job Job');

    drag(node, { x: 150, y: 150 });
    fireEvent.pointerUp(node, { bubbles: true, pointerId: 1 });

    // Storage never caught up, so the node falls back to where the document says.
    rerender(<FlowCanvas diagram={populated()} {...props} />);
    expect(screen.getByLabelText('Job Job')).toHaveStyle({ left: '40px', top: '40px' });
  });
});

describe('frames', () => {
  function framed(): Diagram {
    let diagram = populated();
    // Wide enough to enclose the job at 40,40 and nothing else.
    diagram = addFrame(diagram, {
      id: 'f1',
      position: { x: 0, y: 0 },
      size: { width: 320, height: 240 },
      name: 'Savings',
    });
    return diagram;
  }

  it('draws the frame with its name and what it holds', () => {
    renderCanvas(framed());
    const frame = screen.getByLabelText('Frame Savings');
    expect(frame).toBeInTheDocument();
    expect(frame).toHaveTextContent('Savings');
    expect(frame).toHaveTextContent('1 node');
  });

  it('counts nothing when the rectangle encloses nothing', () => {
    const diagram = addFrame(populated(), {
      id: 'f1',
      position: { x: 4000, y: 4000 },
      size: { width: 300, height: 300 },
      name: 'Empty',
    });
    renderCanvas(diagram);
    expect(screen.getByLabelText('Frame Empty')).toHaveTextContent('0 nodes');
  });

  it('puts the frame on the minimap', () => {
    renderCanvas(framed());
    // Two nodes and the frame; the view marker stays off until jsdom has a size.
    expect(
      screen.getByRole('img', { name: 'Diagram minimap' }).querySelectorAll('rect'),
    ).toHaveLength(3);
  });

  it('shows a frame even on a diagram with no nodes left', () => {
    const diagram = addFrame(createEmptyDiagram('bare'), {
      id: 'f1',
      position: { x: 0, y: 0 },
      size: { width: 300, height: 300 },
    });
    renderCanvas(diagram);
    expect(screen.getByLabelText('Frame Frame 1')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Diagram minimap' })).toBeInTheDocument();
  });
});
