import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { useDiagramCamera } from '@/features/finance/hooks/useDiagramCamera';
import { useElementSize } from '@/shared/lib/useElementSize';
import {
  fitCamera,
  IDENTITY_CAMERA,
  centerOn,
  screenToWorld,
  unionRect,
  visibleRect,
  zoomAt,
  WHEEL_STEP,
  ZOOM_STEP,
  type Camera,
} from '@/features/finance/lib/camera';
import { computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
import {
  frameMembership,
  frameRect,
  listFrames,
  rectBetween,
  resizeRect,
  FRAME_MIN_SIZE,
  type ResizeEdge,
} from '@/features/finance/lib/frames';
import {
  anchorPoint,
  contentRect,
  facingAnchors,
  flowLabelPoint,
  flowPath,
  sizeOf,
} from '@/features/finance/lib/geometry';
import { formatAmount, formatAssetAmount } from '@/shared/lib/money';
import {
  isFlowActive,
  selectAccountSummary,
  selectAllocation,
  selectAssetAllocations,
  selectNodeContent,
  selectFrameSummary,
} from '@/features/finance/lib/summary';
import type {
  Anchor,
  Diagram,
  FinanceNode,
  Flow,
  Frame,
  FrameId,
  NodeId,
  Point,
  Rect,
  Size,
} from '@/features/finance/model/types';

import { CanvasMinimap } from './CanvasMinimap';
import { FlowNode } from './FlowNode';
import { FrameBox } from './FrameBox';
import styles from './FlowCanvas.module.css';

/** Spacing of the backdrop dots at 100%, so the grid scales with the camera. */
const GRID = 26;

export type Selection = { type: 'node' | 'flow' | 'frame'; id: string } | null;

type FlowCanvasProps = {
  diagram: Diagram;
  selection: Selection;
  /** Anchors are only offered while connecting, so they never block a drag. */
  connectMode: boolean;
  connectFrom: { nodeId: NodeId; anchor: Anchor } | null;
  /** While on, dragging bare canvas draws a frame instead of panning. */
  frameMode: boolean;
  onSelect: (selection: Selection) => void;
  onMoveNode: (id: NodeId, position: Point) => void;
  onAnchorClick: (nodeId: NodeId, anchor: Anchor) => void;
  onCreateFrame: (rect: Rect) => void;
  onMoveFrame: (id: FrameId, position: Point) => void;
  onResizeFrame: (id: FrameId, position: Point, size: Size) => void;
  /** Keeps keyboard connect/cancel on the same state as the toolbar and pointer anchors. */
  onConnectModeChange?: (active: boolean) => void;
  /**
   * Chrome pinned to the top-left of the window. A readout about the diagram
   * belongs over the diagram, where the eye already is — in the toolbar it was
   * a row away from the thing it describes. The canvas stays ignorant of what
   * it is being handed.
   */
  status?: ReactNode;
};

/*
 * Every gesture below carries where it has got to, not just where it began.
 *
 * Saving is a round trip, and the saved document is what the canvas draws from,
 * so reading the position back from it made whatever was being dragged trail the
 * pointer by a whole write — and stop dead whenever one was slow. The gesture
 * owns the position while it lasts and the document catches up behind it.
 */
type Drag = {
  nodeId: NodeId;
  pointerId: number;
  /** Where inside the node the pointer grabbed it, so it does not jump. */
  grabOffset: Point;
  position: Point;
};

/**
 * A pan in progress. It keeps the camera it started from and applies the whole
 * delta each move, rather than accumulating per-event ones, so a slow drag
 * cannot round its way somewhere the pointer never went.
 */
type Pan = { pointerId: number; origin: Point; from: Camera };

/** A frame being moved or pulled. Both anchor on where the gesture started. */
type FrameDrag = {
  frameId: FrameId;
  pointerId: number;
  origin: Point;
  from: Point;
  position: Point;
};

type FrameResize = {
  frameId: FrameId;
  pointerId: number;
  edge: ResizeEdge;
  origin: Point;
  from: Rect;
  rect: Rect;
};

/** A frame being drawn: two world corners, until the pointer comes up. */
type FrameDraft = { pointerId: number; start: Point; current: Point };

type Direction = 'left' | 'right' | 'up' | 'down';

const FINE_STEP = 10;
const COARSE_STEP = 50;

export function FlowCanvas({
  diagram,
  selection,
  connectMode,
  connectFrom,
  frameMode,
  onSelect,
  onMoveNode,
  onAnchorClick,
  onCreateFrame,
  onMoveFrame,
  onResizeFrame,
  onConnectModeChange = () => undefined,
  status,
}: FlowCanvasProps) {
  const [viewportRef, viewportSize] = useElementSize<HTMLDivElement>();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const { camera, setCamera, isFetching: isRestoringCamera } = useDiagramCamera(diagram.id);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pan, setPan] = useState<Pan | null>(null);
  const [frameDrag, setFrameDrag] = useState<FrameDrag | null>(null);
  const [frameResize, setFrameResize] = useState<FrameResize | null>(null);
  const [draft, setDraft] = useState<FrameDraft | null>(null);
  // Keyboard mutations get the same optimistic drawing guarantee as pointer
  // drags. They clear as soon as the document catches up or changes underneath.
  const [keyboardNodePosition, setKeyboardNodePosition] = useState<{
    nodeId: NodeId;
    position: Point;
  } | null>(null);
  const [keyboardFrameRect, setKeyboardFrameRect] = useState<{
    frameId: FrameId;
    rect: Rect;
  } | null>(null);
  const [keyboardConnecting, setKeyboardConnecting] = useState(false);
  const [anchorCursor, setAnchorCursor] = useState<Anchor>('r');
  const [announcement, setAnnouncement] = useState('Canvas ready. Press ? for keyboard shortcuts.');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const wasConnecting = useRef(connectMode);

  useEffect(() => {
    setKeyboardNodePosition(null);
    setKeyboardFrameRect(null);
  }, [diagram]);

  useEffect(() => {
    // A completed or externally cancelled connection releases the keyboard
    // sub-mode too. Starting it locally is safe: the ref avoids clearing it in
    // the render before FinancePage has received the mode update.
    if (wasConnecting.current && !connectMode) setKeyboardConnecting(false);
    wasConnecting.current = connectMode;
  }, [connectMode]);

  // A switched-off holding keeps its amount but leaves the canvas.
  const nodes = diagram.nodeOrder
    .map((id) => diagram.nodes[id])
    .filter((node) => node && (node.kind !== 'holding' || node.active))
    // Drawn where the gesture has taken it rather than where the document has
    // got to, so it keeps up with the pointer instead of with the network.
    .map((node) => {
      if (drag?.nodeId === node.id) return { ...node, position: drag.position };
      if (keyboardNodePosition?.nodeId === node.id) {
        return { ...node, position: keyboardNodePosition.position };
      }
      return node;
    });
  // Everything that draws a node reads it from here, so the flows and the
  // minimap travel with it rather than staying behind on the stored position.
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  // Drawing a flow to a node that is not on the canvas would leave an arrow
  // pointing at nothing, so dormant ends hide their flows too.
  const flows = diagram.flowOrder
    .map((id) => diagram.flows[id])
    .filter((flow) => flow && isFlowActive(diagram, flow));

  const frames = listFrames(diagram).map((frame) => {
    if (frameDrag?.frameId === frame.id) return { ...frame, position: frameDrag.position };
    if (frameResize?.frameId === frame.id) {
      const { left, top, width, height } = frameResize.rect;
      return { ...frame, position: { x: left, y: top }, size: { width, height } };
    }
    if (keyboardFrameRect?.frameId === frame.id) {
      const { left, top, width, height } = keyboardFrameRect.rect;
      return { ...frame, position: { x: left, y: top }, size: { width, height } };
    }
    return frame;
  });
  // One pass for the whole canvas rather than a search per frame.
  const membership = frameMembership(diagram);

  // What the diagram reaches, in every direction. The canvas has no corner, so
  // this is measured rather than assumed to start at the origin.
  // Measured with each node's rows, not with the kind's default: fit-to-view
  // frames what is drawn, and what is drawn is now as tall as it has to say.
  const contentOf = (node: FinanceNode) => selectNodeContent(diagram, node);
  /*
   * Which of a node's assets promise more than they hold. The canvas knows the
   * diagram and the node only draws, which is the same split `accountSummary`
   * already uses. An account's own totals carry the sign; a job's do not.
   */
  const overAllocatedOf = (node: FinanceNode): ReadonlySet<string> | undefined => {
    if (node.kind !== 'job') return undefined;
    const over = new Set<string>();
    for (const balance of node.balances) {
      if (!balance.active) continue;
      if (selectAllocation(diagram, node.id, balance.asset)?.exceeded) over.add(balance.asset);
    }
    return over.size ? over : undefined;
  };
  const content = contentRect(nodes, frames, undefined, contentOf);
  /*
   * The minimap covers the view as well as the diagram. Without that, a view
   * wider than the content puts the frame outside the box and the map shows
   * nothing about where you are; with it, panning away simply grows the map.
   */
  const mapped = unionRect(content, visibleRect(camera, viewportSize));

  /**
   * Ownership is a field on the holding, not an edge, so these tethers are
   * derived at draw time rather than stored — see ADR 0001.
   */
  const ownership = nodes.flatMap((node) => {
    if (node.kind !== 'holding') return [];
    const account = nodeById.get(node.accountId);
    if (account?.kind !== 'account') return [];
    const anchors = facingAnchors(account, node, contentOf);
    return [
      {
        id: node.id,
        from: anchorPoint(account, anchors.from, contentOf(account)),
        to: anchorPoint(node, anchors.to, contentOf(node)),
        anchors,
      },
    ];
  });

  /** Pointer position in viewport pixels, before the camera is undone. */
  const toViewport = useCallback(
    (event: { clientX: number; clientY: number }): Point => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    },
    [viewportRef],
  );

  /** Where the pointer is in the diagram, whatever the camera is doing. */
  function toWorld(event: PointerEvent): Point {
    return screenToWorld(camera, toViewport(event));
  }

  /*
   * Bound by hand rather than through onWheel: React listens passively, and a
   * passive listener cannot stop the page scrolling out from under the zoom.
   */
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pivot = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setCamera((current) =>
        zoomAt(current, event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, pivot),
      );
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setCamera, viewportRef]);

  function zoomFromCentre(factor: number) {
    setCamera((current) =>
      zoomAt(current, factor, { x: viewportSize.width / 2, y: viewportSize.height / 2 }),
    );
  }

  function startDrag(nodeId: NodeId, event: PointerEvent<HTMLElement>) {
    const node = diagram.nodes[nodeId];
    if (!node) return;
    const pointer = toWorld(event);
    beginGesture(event);
    setDrag({
      nodeId,
      pointerId: event.pointerId,
      grabOffset: { x: pointer.x - node.position.x, y: pointer.y - node.position.y },
      position: node.position,
    });
  }

  function startFrameDrag(frame: Frame, event: PointerEvent<HTMLElement>) {
    beginGesture(event);
    setFrameDrag({
      frameId: frame.id,
      pointerId: event.pointerId,
      origin: toWorld(event),
      from: frame.position,
      position: frame.position,
    });
  }

  function startFrameResize(frame: Frame, edge: ResizeEdge, event: PointerEvent<HTMLElement>) {
    beginGesture(event);
    setFrameResize({
      frameId: frame.id,
      pointerId: event.pointerId,
      edge,
      origin: toWorld(event),
      from: frameRect(frame),
      rect: frameRect(frame),
    });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    // Only a press on bare canvas starts a gesture here. Anything else — a node,
    // a flow, a frame header, the controls, the minimap — is doing its own thing
    // with the pointer.
    const onBackground =
      event.target === event.currentTarget || event.target === surfaceRef.current;
    if (!onBackground) return;

    onSelect(null);
    beginGesture(event);

    if (frameMode) {
      const start = toWorld(event);
      setDraft({ pointerId: event.pointerId, start, current: start });
      return;
    }

    setPan({
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      from: camera,
    });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (draft && event.pointerId === draft.pointerId) {
      setDraft({ ...draft, current: toWorld(event) });
      return;
    }

    if (pan && event.pointerId === pan.pointerId) {
      setCamera({
        ...pan.from,
        x: pan.from.x + (event.clientX - pan.origin.x),
        y: pan.from.y + (event.clientY - pan.origin.y),
      });
      return;
    }

    if (frameDrag && event.pointerId === frameDrag.pointerId) {
      const pointer = toWorld(event);
      const position = {
        x: Math.round(frameDrag.from.x + pointer.x - frameDrag.origin.x),
        y: Math.round(frameDrag.from.y + pointer.y - frameDrag.origin.y),
      };
      setFrameDrag({ ...frameDrag, position });
      onMoveFrame(frameDrag.frameId, position);
      return;
    }

    if (frameResize && event.pointerId === frameResize.pointerId) {
      const pointer = toWorld(event);
      const next = resizeRect(frameResize.from, frameResize.edge, {
        x: pointer.x - frameResize.origin.x,
        y: pointer.y - frameResize.origin.y,
      });
      const rect = {
        left: Math.round(next.left),
        top: Math.round(next.top),
        width: Math.round(next.width),
        height: Math.round(next.height),
      };
      setFrameResize({ ...frameResize, rect });
      onResizeFrame(
        frameResize.frameId,
        { x: rect.left, y: rect.top },
        { width: rect.width, height: rect.height },
      );
      return;
    }

    if (!drag || event.pointerId !== drag.pointerId) return;
    const pointer = toWorld(event);
    // Nowhere is out of bounds. The node goes where the pointer took it.
    const position = {
      x: Math.round(pointer.x - drag.grabOffset.x),
      y: Math.round(pointer.y - drag.grabOffset.y),
    };
    setDrag({ ...drag, position });
    onMoveNode(drag.nodeId, position);
  }

  function endGesture(event: PointerEvent<HTMLDivElement>) {
    if (drag && event.pointerId === drag.pointerId) setDrag(null);
    if (pan && event.pointerId === pan.pointerId) setPan(null);
    if (frameDrag && event.pointerId === frameDrag.pointerId) setFrameDrag(null);
    if (frameResize && event.pointerId === frameResize.pointerId) setFrameResize(null);

    if (draft && event.pointerId === draft.pointerId) {
      const rect = rectBetween(draft.start, draft.current);
      setDraft(null);
      // A click rather than a drag is a change of mind, not a tiny frame. The
      // minimum only rescues something that was actually dragged.
      if (rect.width >= FRAME_MIN_SIZE.width / 2 && rect.height >= FRAME_MIN_SIZE.height / 2) {
        onCreateFrame(rect);
      }
    }
  }

  /*
   * Keyboard model
   * --------------
   * The viewport is the one tab stop for diagram objects. Arrow keys choose a
   * node by its spatial neighbour, rather than `nodeOrder`; F and E cycle
   * frames and flows; the selected item receives the same `selection` state as
   * a pointer click. This keeps a 32-node diagram navigable without making its
   * nodes, anchors, SVG paths, and minimap hundreds of stops long. If a selected
   * item disappears after another action, the effect below clears selection and
   * leaves focus on this viewport, where the user can continue navigating.
   */
  // Memoised so the effects that call it can name it as a dependency: declared
  // plain, it was a new function on every render and listing it would have run
  // them every time.
  const focusCanvas = useCallback(() => {
    viewportRef.current?.focus({ preventScroll: true });
  }, [viewportRef]);

  useEffect(() => {
    if (!selection) return;
    const present =
      (selection.type === 'node' && nodes.some((node) => node.id === selection.id)) ||
      (selection.type === 'frame' && frames.some((frame) => frame.id === selection.id)) ||
      (selection.type === 'flow' && flows.some((flow) => flow.id === selection.id));
    if (present) return;
    onSelect(null);
    setAnnouncement('The selected item was removed. Canvas selection cleared.');
    focusCanvas();
  }, [focusCanvas, frames, nodes, flows, onSelect, selection]);

  useEffect(() => {
    if (!selection) return;
    setAnnouncement(`${selectionDescription(selection, diagram)} selected.`);
  }, [diagram, selection]);

  function selectNode(node: FinanceNode) {
    onSelect({ type: 'node', id: node.id });
    setAnnouncement(`${nodeDescription(node)} selected.`);
    focusCanvas();
  }

  function moveSelected(direction: Direction, step: number) {
    const delta = directionDelta(direction, step);
    if (selection?.type === 'node') {
      const node = nodeById.get(selection.id);
      if (!node) return;
      const position = { x: node.position.x + delta.x, y: node.position.y + delta.y };
      setKeyboardNodePosition({ nodeId: node.id, position });
      onMoveNode(node.id, position);
      setAnnouncement(`${nodeDescription(node)} moved ${direction} ${step} pixels.`);
      return;
    }
    if (selection?.type === 'frame') {
      const frame = frames.find((item) => item.id === selection.id);
      if (!frame) return;
      const rect = {
        left: frame.position.x + delta.x,
        top: frame.position.y + delta.y,
        width: frame.size.width,
        height: frame.size.height,
      };
      setKeyboardFrameRect({ frameId: frame.id, rect });
      onMoveFrame(frame.id, { x: rect.left, y: rect.top });
      setAnnouncement(`Frame ${frame.name || 'Frame'} moved ${direction} ${step} pixels.`);
      return;
    }
    setAnnouncement('Select a node or frame before moving it.');
  }

  function resizeSelectedFrame(direction: Direction, step: number) {
    if (selection?.type !== 'frame') {
      setAnnouncement('Select a frame before resizing it.');
      return;
    }
    const frame = frames.find((item) => item.id === selection.id);
    if (!frame) return;
    const edge: Record<Direction, ResizeEdge> = {
      left: 'w',
      right: 'e',
      up: 'n',
      down: 's',
    };
    const next = resizeRect(frameRect(frame), edge[direction], directionDelta(direction, step));
    const rect = {
      left: Math.round(next.left),
      top: Math.round(next.top),
      width: Math.round(next.width),
      height: Math.round(next.height),
    };
    setKeyboardFrameRect({ frameId: frame.id, rect });
    onResizeFrame(frame.id, { x: rect.left, y: rect.top }, { width: rect.width, height: rect.height });
    setAnnouncement(`Frame ${frame.name || 'Frame'} resized ${direction} ${step} pixels.`);
  }

  function createKeyboardFrame() {
    const selectedNode = selection?.type === 'node' ? nodeById.get(selection.id) : undefined;
    const size = selectedNode ? sizeOf(selectedNode, contentOf(selectedNode)) : FRAME_MIN_SIZE;
    const rect = selectedNode
      ? {
          left: selectedNode.position.x - 24,
          top: selectedNode.position.y - 24,
          width: Math.max(FRAME_MIN_SIZE.width, size.width + 48),
          height: Math.max(FRAME_MIN_SIZE.height, size.height + 48),
        }
      : {
          left: Math.round((viewportSize.width / 2 - FRAME_MIN_SIZE.width / 2 - camera.x) / camera.zoom),
          top: Math.round((viewportSize.height / 2 - FRAME_MIN_SIZE.height / 2 - camera.y) / camera.zoom),
          ...FRAME_MIN_SIZE,
        };
    onCreateFrame(rect);
    setAnnouncement(
      selectedNode
        ? `Frame created around ${nodeDescription(selectedNode)}. Press F to select frames.`
        : 'Frame created at the centre of the current view. Press F to select frames.',
    );
  }

  function chooseAnchor() {
    if (!keyboardConnecting || selection?.type !== 'node') return;
    if (connectFrom?.nodeId === selection.id) {
      setAnnouncement('Choose a different destination node, or press Escape to cancel connecting.');
      return;
    }
    onAnchorClick(selection.id, anchorCursor);
    setAnnouncement(
      connectFrom
        ? `Connecting to ${nodeDescription(nodeById.get(selection.id) ?? diagram.nodes[selection.id])} at ${anchorCursor}.`
        : `Source anchor ${anchorCursor} chosen. Use arrows to select the destination, A to choose its anchor, then Enter.`,
    );
  }

  function onCanvasKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Chrome controls and the help's close button keep their native keyboard
    // behaviour. Diagram commands are only for the viewport's own focus.
    if (event.target !== event.currentTarget) return;
    const key = event.key.toLowerCase();

    if (event.key === '?') {
      event.preventDefault();
      setShortcutsOpen((open) => !open);
      return;
    }
    if (event.key === 'Escape') {
      if (shortcutsOpen) {
        event.preventDefault();
        setShortcutsOpen(false);
        return;
      }
      if (keyboardConnecting || connectMode) {
        event.preventDefault();
        setKeyboardConnecting(false);
        onConnectModeChange(false);
        setAnnouncement('Connecting cancelled.');
      }
      return;
    }

    if (key === 'c') {
      event.preventDefault();
      if (selection?.type !== 'node') {
        setAnnouncement('Select a source node with the arrow keys before connecting.');
        return;
      }
      setKeyboardConnecting(true);
      onConnectModeChange(true);
      setAnnouncement(
        connectFrom
          ? `Destination ${nodeDescription(nodeById.get(selection.id) ?? diagram.nodes[selection.id])}. Press A to choose its anchor, then Enter.`
          : `Connecting from ${nodeDescription(nodeById.get(selection.id) ?? diagram.nodes[selection.id])}. Press A to choose an anchor, then Enter.`,
      );
      return;
    }

    if (keyboardConnecting && key === 'a') {
      event.preventDefault();
      const next = nextAnchor(anchorCursor);
      setAnchorCursor(next);
      setAnnouncement(`Anchor ${next}. Press Enter to choose it.`);
      return;
    }
    if (keyboardConnecting && event.key === 'Enter') {
      event.preventDefault();
      chooseAnchor();
      return;
    }

    if (key === 'f') {
      event.preventDefault();
      if (event.shiftKey) createKeyboardFrame();
      else selectNextFrame(frames, selection, onSelect, setAnnouncement);
      return;
    }
    if (key === 'e') {
      event.preventDefault();
      selectNextFlow(flows, nodeById, selection, onSelect, setAnnouncement);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setCamera(fitCamera(content, viewportSize));
      setAnnouncement('Diagram fitted to view.');
      return;
    }

    const direction = keyDirection(event.key);
    if (!direction) return;
    event.preventDefault();
    const step = event.altKey ? COARSE_STEP : FINE_STEP;
    if (event.ctrlKey && event.shiftKey) {
      resizeSelectedFrame(direction, step);
      return;
    }
    if (event.shiftKey) {
      moveSelected(direction, step);
      return;
    }
    if (event.ctrlKey) {
      const delta = directionDelta(direction, Math.max(viewportSize.width, viewportSize.height) * 0.1);
      setCamera((current) => ({ ...current, x: current.x - delta.x, y: current.y - delta.y }));
      setAnnouncement(`View moved ${direction}.`);
      return;
    }
    const next = directionalNode(nodes, selection?.type === 'node' ? selection.id : null, direction);
    if (next) selectNode(next);
    else setAnnouncement(`No node ${direction} of the current selection.`);
  }

  return (
    <div
      ref={viewportRef}
      className={`${styles.viewport} ${pan ? styles.panning : ''} ${
        isRestoringCamera ? styles.restoring : ''
      }`}
      style={{
        // The backdrop travels and scales with the camera; a fixed grid under a
        // moving diagram reads as the canvas standing still.
        backgroundSize: `${GRID * camera.zoom}px ${GRID * camera.zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onKeyDown={onCanvasKeyDown}
      tabIndex={0}
      role="region"
      aria-label="Diagram canvas"
      aria-describedby="finance-canvas-keyboard-description"
      aria-busy={isRestoringCamera || undefined}
    >
      <div className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <span id="finance-canvas-keyboard-description" className={styles.srOnly}>
        Use arrow keys to select nearby nodes. Press question mark for all canvas keyboard shortcuts.
      </span>
      {isRestoringCamera ? (
        <div className={styles.restoringMessage}>Restoring diagram view…</div>
      ) : null}
      {/* The world. It carries no size of its own: it is the origin the camera
          moves and everything inside it is placed in world coordinates, which
          may be negative. */}
      <div
        ref={surfaceRef}
        className={styles.surface}
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
      >
        {/* First in the DOM, so frames sit under the flows and the nodes and can
            never take a click meant for either. */}
        {frames.map((frame) => (
          <FrameBox
            key={frame.id}
            frame={frame}
            summary={selectFrameSummary(diagram, membership.get(frame.id) ?? [])}
            selected={selection?.type === 'frame' && selection.id === frame.id}
            onSelect={() => {
              onSelect({ type: 'frame', id: frame.id });
              setAnnouncement(`Frame ${frame.name || 'Frame'} selected.`);
              focusCanvas();
            }}
            onMoveStart={(event) => startFrameDrag(frame, event)}
            onResizeStart={(edge, event) => startFrameResize(frame, edge, event)}
          />
        ))}

        {draft ? <FrameDraftBox rect={rectBetween(draft.start, draft.current)} /> : null}

        {/* Positioned and given a matching viewBox so paths keep using world
            coordinates while the layer follows content that runs negative. */}
        <svg
          className={styles.edges}
          style={{
            left: content.left,
            top: content.top,
            width: content.width,
            height: content.height,
          }}
          viewBox={`${content.left} ${content.top} ${content.width} ${content.height}`}
        >
          <defs>
            <marker id="flowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <polygon points="0 0, 8 4, 0 8" fill="rgba(253, 186, 116, 0.9)" />
            </marker>
          </defs>

          {/* Drawn first so real money flows sit on top of the tethers. */}
          {ownership.map((link) => (
            <path
              key={`own-${link.id}`}
              className={styles.ownership}
              d={flowPath(link.from, link.to, link.anchors.from, link.anchors.to)}
            />
          ))}

          {flows.map((flow) => {
            const source = nodeById.get(flow.from);
            const target = nodeById.get(flow.to);
            if (!source || !target) return null;

            const from = anchorPoint(source, flow.fromAnchor, contentOf(source));
            const to = anchorPoint(target, flow.toAnchor, contentOf(target));
            const path = flowPath(from, to, flow.fromAnchor, flow.toAnchor);
            const label = flowLabelPoint(from, to, flow.labelOffset);
            const isSelected = selection?.type === 'flow' && selection.id === flow.id;

            return (
              <g key={flow.id}>
                <path
                  className={styles.edgeHit}
                  d={path}
                  onPointerDown={() => {
                    onSelect({ type: 'flow', id: flow.id });
                    setAnnouncement(`${flowDescription(flow, nodeById)} selected.`);
                    focusCanvas();
                  }}
                />
                <path
                  className={`${styles.edge} ${isSelected ? styles.edgeSelected : ''}`}
                  d={path}
                  markerEnd="url(#flowArrow)"
                  onPointerDown={() => {
                    onSelect({ type: 'flow', id: flow.id });
                    setAnnouncement(`${flowDescription(flow, nodeById)} selected.`);
                    focusCanvas();
                  }}
                />
                {flow.amount !== null && flow.amount > 0 ? (
                  <FlowLabel x={label.x} y={label.y} flow={flow} source={source} target={target} />
                ) : null}
              </g>
            );
          })}
        </svg>

        {nodes.map((node) => (
          <FlowNode
            key={node.id}
            node={node}
            selected={selection?.type === 'node' && selection.id === node.id}
            connecting={connectMode}
            isConnectSource={connectFrom?.nodeId === node.id}
            content={contentOf(node)}
            overAllocated={overAllocatedOf(node)}
            allocations={selectAssetAllocations(diagram, node)}
            accountSummary={
              node.kind === 'account' ? selectAccountSummary(diagram, node.id) : undefined
            }
            keyboardAnchor={
              keyboardConnecting && selection?.type === 'node' && selection.id === node.id
                ? anchorCursor
                : undefined
            }
            onSelect={() => selectNode(node)}
            onDragStart={(event) => startDrag(node.id, event)}
            onAnchorClick={(anchor) => onAnchorClick(node.id, anchor)}
          />
        ))}
      </div>

      {/* Chrome, not diagram: it sits outside the surface so the camera cannot
          shrink it or push it off screen. */}
      {!nodes.length ? (
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>Nothing here yet</span>
          <span>Add a job or an account to start mapping where money moves.</span>
        </div>
      ) : null}

      {status ? <div className={styles.statusCorner}>{status}</div> : null}

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.control}
          aria-label="Zoom out"
          onClick={() => zoomFromCentre(1 / ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          className={styles.zoomLevel}
          aria-label="Reset zoom to 100%"
          onClick={() => setCamera(IDENTITY_CAMERA)}
        >
          {Math.round(camera.zoom * 100)}%
        </button>
        <button
          type="button"
          className={styles.control}
          aria-label="Zoom in"
          onClick={() => zoomFromCentre(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className={styles.control}
          aria-label="Fit the diagram in view"
          onClick={() => setCamera(fitCamera(content, viewportSize))}
        >
          Fit
        </button>
      </div>

      <div className={styles.keyboardHelp}>
        <button
          type="button"
          className={styles.control}
          aria-expanded={shortcutsOpen}
          aria-controls="finance-canvas-keyboard-help"
          onClick={() => setShortcutsOpen((open) => !open)}
        >
          Keyboard shortcuts
        </button>
        {shortcutsOpen ? (
          <section id="finance-canvas-keyboard-help" className={styles.shortcuts} aria-label="Canvas keyboard shortcuts">
            <strong>Canvas keyboard shortcuts</strong>
            <span>Arrows: select the nearest node in that direction.</span>
            <span>Shift + arrows: move selected node or frame; add Alt for 50px steps.</span>
            <span>Ctrl + Shift + arrows: resize selected frame; add Alt for 50px steps.</span>
            <span>C, A, Enter: connect, choose anchor, and confirm; Escape cancels.</span>
            <span>F: next frame. Shift + F: create a frame. E: next flow. Ctrl + arrows: pan. Home: fit.</span>
            <button type="button" className={styles.closeHelp} onClick={() => setShortcutsOpen(false)}>
              Close shortcuts
            </button>
          </section>
        ) : null}
      </div>

      {nodes.length || frames.length ? (
        <CanvasMinimap
          nodes={nodes}
          frames={frames}
          world={mapped}
          camera={camera}
          viewport={viewportSize}
          contentOf={contentOf}
          onMoveTo={(point) => setCamera((current) => centerOn(point, viewportSize, current.zoom))}
        />
      ) : null}
    </div>
  );
}

function keyDirection(key: string): Direction | null {
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  return null;
}

function directionDelta(direction: Direction, step: number): Point {
  if (direction === 'left') return { x: -step, y: 0 };
  if (direction === 'right') return { x: step, y: 0 };
  if (direction === 'up') return { x: 0, y: -step };
  return { x: 0, y: step };
}

function orderedByPosition<T extends { id: string; position: Point }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id),
  );
}

/** The nearest candidate in the requested half-plane, favouring forward progress. */
function directionalNode(nodes: FinanceNode[], selectedId: string | null, direction: Direction): FinanceNode | null {
  const ordered = orderedByPosition(nodes);
  if (!ordered.length) return null;
  const current = selectedId ? nodes.find((node) => node.id === selectedId) : undefined;
  if (!current) return ordered[0];
  const axis = directionDelta(direction, 1);
  const candidates = nodes
    .map((node) => {
      const dx = node.position.x - current.position.x;
      const dy = node.position.y - current.position.y;
      const forward = dx * axis.x + dy * axis.y;
      const sideways = Math.abs(dx * axis.y - dy * axis.x);
      return { node, forward, sideways };
    })
    .filter((candidate) => candidate.forward > 0)
    .sort(
      (a, b) =>
        a.forward * 2 + a.sideways - (b.forward * 2 + b.sideways) ||
        a.node.id.localeCompare(b.node.id),
    );
  return candidates[0]?.node ?? null;
}

function nextAnchor(anchor: Anchor): Anchor {
  const anchors: Anchor[] = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
  return anchors[(anchors.indexOf(anchor) + 1) % anchors.length];
}

function nodeDescription(node: FinanceNode | undefined): string {
  if (!node) return 'selected node';
  const kind = node.kind[0].toUpperCase() + node.kind.slice(1);
  return `${kind} ${node.name || (node.kind === 'holding' ? node.asset : kind)}`;
}

function flowDescription(flow: Flow, nodes: Map<string, FinanceNode>): string {
  return `Flow from ${nodeDescription(nodes.get(flow.from))} to ${nodeDescription(nodes.get(flow.to))}`;
}

function selectionDescription(selection: Exclude<Selection, null>, diagram: Diagram): string {
  if (selection.type === 'node') return nodeDescription(diagram.nodes[selection.id]);
  if (selection.type === 'frame') return `Frame ${diagram.frames[selection.id]?.name || 'Frame'}`;
  const flow = diagram.flows[selection.id];
  if (!flow) return 'Flow';
  return flowDescription(flow, new Map<string, FinanceNode>(Object.entries(diagram.nodes)));
}

function selectNextFrame(
  frames: Frame[],
  selection: Selection,
  onSelect: (selection: Selection) => void,
  announce: (message: string) => void,
) {
  const ordered = orderedByPosition(frames);
  if (!ordered.length) {
    announce('There are no frames in this diagram. Press Shift and F to create one.');
    return;
  }
  const index = selection?.type === 'frame' ? ordered.findIndex((frame) => frame.id === selection.id) : -1;
  const frame = ordered[(index + 1) % ordered.length];
  onSelect({ type: 'frame', id: frame.id });
  announce(`Frame ${frame.name || 'Frame'} selected.`);
}

function selectNextFlow(
  flows: Flow[],
  nodes: Map<string, FinanceNode>,
  selection: Selection,
  onSelect: (selection: Selection) => void,
  announce: (message: string) => void,
) {
  const ordered = [...flows].sort((a, b) => {
    const sourceA = nodes.get(a.from)?.position ?? { x: 0, y: 0 };
    const sourceB = nodes.get(b.from)?.position ?? { x: 0, y: 0 };
    return sourceA.y - sourceB.y || sourceA.x - sourceB.x || a.id.localeCompare(b.id);
  });
  if (!ordered.length) {
    announce('There are no flows in this diagram.');
    return;
  }
  const index = selection?.type === 'flow' ? ordered.findIndex((flow) => flow.id === selection.id) : -1;
  const flow = ordered[(index + 1) % ordered.length];
  onSelect({ type: 'flow', id: flow.id });
  announce(`${flowDescription(flow, nodes)} selected. Tab reaches its properties and actions.`);
}

/**
 * Takes the pointer for the rest of a gesture.
 *
 * The capture keeps the moves coming when a fast drag outruns the element it
 * started on or leaves the window, so the release is never missed and the canvas
 * cannot be left thinking a drag is still going. Preventing the default stops
 * the browser reading the same press as the start of a text selection or a
 * native drag — the stylesheet already makes the canvas unselectable, but that
 * only covers what is inside it, and a gesture may end anywhere.
 */
function beginGesture(event: PointerEvent<HTMLElement>) {
  event.preventDefault();
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  } catch {
    // Capturing is an improvement on the gesture, not a condition of it: a
    // pointer that is already gone cannot be captured and throws for saying so.
    // The drag still works from the events that do arrive, so it goes ahead.
  }
}

/** The rectangle being dragged out, before it is a frame. */
function FrameDraftBox({ rect }: { rect: Rect }) {
  return (
    <div
      className={styles.draft}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      aria-hidden="true"
    />
  );
}

/**
 * Gross on the first line, and what actually arrives underneath when fees take a
 * cut. The net comes from the same computeTransfer the totals use, so a label can
 * never claim something the summary disagrees with.
 */
function FlowLabel({
  x,
  y,
  flow,
  source,
  target,
}: {
  x: number;
  y: number;
  flow: Flow;
  source: FinanceNode;
  target: FinanceNode;
}) {
  const breakdown = computeTransfer(flow.amount ?? 0, source, target);
  const charged = breakdown.steps.length > 0;
  const overdrawn = isOverdrawnByFees(breakdown);
  const label = flow.label.trim();
  const hasLabel = label.length > 0;

  return (
    <text className={styles.edgeLabel} x={x} y={y} textAnchor="middle">
      {hasLabel ? (
        <tspan className={styles.edgeLabelName} x={x} dy={charged ? '-1.05em' : '-0.6em'}>
          {label}
        </tspan>
      ) : null}
      <tspan className={styles.edgeLabelAmount} x={x} dy={hasLabel ? '1.2em' : charged ? '-0.35em' : '0'}>
        {formatAssetAmount(flow.asset, breakdown.gross)}
      </tspan>
      {charged ? (
        <tspan
          className={overdrawn ? styles.edgeLabelBlocked : styles.edgeLabelNet}
          x={x}
          dy="1.2em"
        >
          {overdrawn ? 'fees exceed it' : `→ ${formatAmount(breakdown.net)}`}
        </tspan>
      ) : null}
    </text>
  );
}
