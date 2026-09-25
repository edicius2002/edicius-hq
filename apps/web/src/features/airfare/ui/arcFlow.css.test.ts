import { describe, expect, it } from 'vitest';

import { ARC_FLOW_SECONDS, ARC_FLOW_STEPS } from '@/features/airfare/lib/arcFlow';

import MAP_SOURCE from './RouteMap.module.css?inline';

/*
 * What a flowing arc costs per frame. LIM-MAD animates 39 arcs; each used to
 * carry `filter: drop-shadow`, so the browser re-blurred ~612,000 px² of
 * bounding boxes sixty times a second and the map lagged. The dashes still move
 * on every arc — slower, and in fewer repaints — and the glow is a still stroke
 * underneath rather than a filter on the moving one.
 */

const MAP = MAP_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(local: string): string {
  const found = new RegExp(`\\._${local}_[0-9a-z]+\\s*\\{([^}]*)\\}`).exec(MAP);
  expect(found, `.${local} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

describe('the flowing arc', () => {
  it('moves its dashes on the timing the phase arithmetic assumes, in stepped repaints', () => {
    // `flowDelay` phases a split arc's runs against ARC_FLOW_SECONDS, so the
    // stylesheet and the constant must agree or the runs stop lining up.
    // The keyframes name is module-hashed too (`_flow_1b7fef`).
    expect(rule('flow')).toMatch(
      new RegExp(
        `animation: _?flow[_0-9a-z]* ${ARC_FLOW_SECONDS}s steps\\(${ARC_FLOW_STEPS}\\) infinite`,
      ),
    );
  });

  it('carries no filter, which is what made every frame re-blur the arc', () => {
    expect(rule('flow')).not.toMatch(/filter/);
  });

  it('gets its glow from a still stroke that never repaints with the dashes', () => {
    const glow = rule('glow');
    expect(glow).toMatch(/stroke-width/);
    expect(glow).not.toMatch(/animation|filter|dasharray/);
  });
});
