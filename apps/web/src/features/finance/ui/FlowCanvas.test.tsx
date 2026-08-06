import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmptyDiagram } from '@/features/finance/lib/document';
import { addAccount, addFrame, addJob } from '@/features/finance/lib/operations';
import type { Diagram } from '@/features/finance/model/types';

import { FlowCanvas } from './FlowCanvas';

afterEach(cleanup);

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
  return render(<FlowCanvas diagram={diagram} {...canvasProps()} />);
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
