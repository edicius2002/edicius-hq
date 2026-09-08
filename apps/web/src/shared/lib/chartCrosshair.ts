/** A box as `getBoundingClientRect` reports it. */
export type ClientBox = { left: number; top: number; width: number; height: number };

/** The drawing's own viewBox size. */
export type PlotSize = { width: number; height: number };

/**
 * Convert a client coordinate into SVG view units while honouring the default
 * `preserveAspectRatio="xMidYMid meet"` letterbox or pillarbox bars.
 */
export function pointerInView(
  box: ClientBox,
  plot: PlotSize,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || plot.width <= 0 || plot.height <= 0) return null;
  const scale = Math.min(box.width / plot.width, box.height / plot.height);
  return {
    x: (clientX - box.left - (box.width - plot.width * scale) / 2) / scale,
    y: (clientY - box.top - (box.height - plot.height * scale) / 2) / scale,
  };
}

/** Pick a real observation; an exact tie stays on the earlier point. */
export function nearestPointIndex(
  points: readonly { timestamp: string }[],
  timestamp: string,
): number | null {
  const target = Date.parse(timestamp);
  if (!Number.isFinite(target)) return null;

  let best: number | null = null;
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const at = Date.parse(points[index].timestamp);
    if (!Number.isFinite(at)) continue;
    const distance = Math.abs(at - target);
    if (distance < shortest) {
      best = index;
      shortest = distance;
    }
  }
  return best;
}
