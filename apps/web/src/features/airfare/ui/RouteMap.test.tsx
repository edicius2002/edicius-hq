import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flowDelay } from '@/features/airfare/lib/arcFlow';
import { pairKey, type LngLat, type RouteGeometry } from '@/features/airfare/lib/geo';
import { nameBox } from '@/features/airfare/lib/globe';
import { RouteMap } from '@/features/airfare/ui/RouteMap';

/*
 * What the arcs *look* like is not testable from here and is not tried.
 *
 * The dash pattern, the sign the offset travels to and the ring's paint order
 * all live in the stylesheet. Vitest replaces a CSS module with a proxy over
 * its class names, `?raw` is intercepted by the same extension check and hands
 * back that proxy again, and reading the file with `node:fs` builds under
 * Vitest and then fails `tsc -b` — `src` is browser code and its tsconfig
 * types it as such, which is the reason `csv.test.ts` gives for the same
 * choice. So those numbers are held by the comments beside them and by
 * decision 12.70, and what is tested here is everything the DOM does carry:
 * the direction the geometry runs in, and the phase each run is given.
 */

/**
 * jsdom gives this component no canvas — `getContext` returns null and the
 * globe never paints. That is the point of the split: the sphere and the land
 * live on a canvas nobody can test, and the *routes* live in the DOM, where
 * these assertions and a screen reader can both reach them.
 *
 * A map built on a tile renderer would fail every test below, because its
 * entire output is one opaque canvas element.
 */

beforeEach(() => {
  // jsdom has no canvas, and left alone it logs a "Not implemented" error on
  // every mount — noise that would drown the failure this suite is meant to
  // report. Returning null is honest: the component already treats a missing
  // context as nothing to paint. Same stub `CandleChart.test.tsx` uses.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // jsdom has no pointer capture; the component only uses it to keep receiving
  // moves once the pointer leaves the box.
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  // jsdom measures every element as 0×0, and the map genuinely needs a box:
  // place names are culled against the frame, and with no frame they all
  // project onto the same point and collide with each other.
  //
  // A client pixel is a map unit here, and unlike on the two airfare charts
  // that holds at every box: this map sets its viewBox from its own measured
  // size, so the drawing and the box are the same shape by construction and
  // `preserveAspectRatio` never has anything to centre. Any box would do; this
  // one is a plausible stage.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 960,
    bottom: 540,
    width: 960,
    height: 540,
    toJSON: () => ({}),
  });
  /*
   * The map asks the API for one country's subdivisions once a reader has
   * zoomed into it, so a suite that zooms will reach `fetch`. Answering 404 by
   * default is what a country Natural Earth does not divide answers, which
   * means every test in this file that is not about subdivisions runs the
   * fallback path — and none of them touches the network. The tests that want
   * a country to *have* subdivisions stub over this.
   */
  subdivisionRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      subdivisionRequests.push(String(input));
      return Promise.resolve(new Response('null', { status: 404 }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let subdivisionRequests: string[] = [];

/**
 * An arc standing for a single watch, which is what most of this suite wants.
 *
 * Built rather than written out since `a-pair-draws-one-arc`, because an arc
 * carries the watches it was collapsed from and repeating that bookkeeping in
 * every fixture would bury the two coordinates each one is actually about. The
 * arc's own `id` is its city pair; `leading` is the watch id, and it is what a
 * `selectedId`, a colour key or a `data-route` is compared against.
 *
 * `lib/geo` builds the real ones and is where the collapsing is tested. This
 * is a shape, not a second implementation of the rule.
 */
function arcFor(
  watchId: string,
  [origin, destination]: [string, string],
  from: LngLat,
  to: LngLat,
  [fromCity, toCity]: [string, string],
): RouteGeometry {
  return {
    id: pairKey(origin, destination),
    watches: [{ id: watchId, origin, destination }],
    leading: watchId,
    // One watch, so the arc points at it and is coloured for it — the two
    // fields part company only on a pair watched more than once.
    wearing: watchId,
    origin,
    destination,
    from,
    to,
    fromCity,
    toCity,
    bothWays: false,
  };
}

const LIMA: LngLat = [-77.114444, -12.021944];
const CUSCO: LngLat = [-71.938889, -13.535833];
const MADRID: LngLat = [-3.567222, 40.498333];
const TOKYO: LngLat = [140.3864, 35.7647];

const LIM_CUZ = arcFor('LIM-CUZ-2026-10-17', ['LIM', 'CUZ'], LIMA, CUSCO, ['Lima', 'Cusco']);

const LIM_MAD = arcFor('LIM-MAD-2026-10-17', ['LIM', 'MAD'], LIMA, MADRID, ['Lima', 'Madrid']);

/**
 * Lima and Santiago watched both ways, drawn as the one arc they are.
 *
 * Pointed at Lima, which is the return leg — the case the owner asked for:
 * `SCL→LIM` collected after `LIM→SCL` was already on the map, and no second
 * dotted line laid over the first.
 */
const SCL: LngLat = [-70.7858, -33.393];
const LIM_SCL_BOTH: RouteGeometry = {
  id: pairKey('LIM', 'SCL'),
  watches: [
    { id: 'LIM|SCL|2027-03', origin: 'LIM', destination: 'SCL' },
    { id: 'SCL|LIM|2027-03', origin: 'SCL', destination: 'LIM' },
  ],
  leading: 'SCL|LIM|2027-03',
  // The outbound leg, because it is first in the watchlist — and it stays that
  // whichever way the arc is pointed. `colour-holds-the-first-watch`.
  wearing: 'LIM|SCL|2027-03',
  origin: 'SCL',
  destination: 'LIM',
  from: SCL,
  to: LIMA,
  fromCity: 'Santiago',
  toCity: 'Lima',
  bothWays: true,
};

/**
 * The same pair, pointed the other way — which is what the page hands down once
 * the outbound leg is the open one.
 *
 * `the-open-watch-leads-its-arc` is decided in `lib/geo`, so from this
 * component's side it arrives as nothing more than a different `leading` on the
 * same two watches — and, deliberately, the *same* `wearing`. That is the point
 * of the split: the rules are tested where they are decided, and what is
 * checked here is which field each visible thing reads.
 */
const LIM_SCL_OUTBOUND: RouteGeometry = {
  ...LIM_SCL_BOTH,
  leading: 'LIM|SCL|2027-03',
  origin: 'LIM',
  destination: 'SCL',
  from: LIMA,
  to: SCL,
  fromCity: 'Lima',
  toCity: 'Santiago',
};

/**
 * One pair watched twice in the same direction — March and June.
 *
 * The other way `leading` and `wearing` come apart, and the only one that keeps
 * an arrival dot: nothing here flies the other way, so the far end is still a
 * coloured marker rather than a second departure. June is open and points the
 * arc; March is first in the watchlist and colours it.
 */
const LIM_MAD_TWICE: RouteGeometry = {
  id: pairKey('LIM', 'MAD'),
  watches: [
    { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
    { id: 'LIM|MAD|2027-06', origin: 'LIM', destination: 'MAD' },
  ],
  leading: 'LIM|MAD|2027-06',
  wearing: 'LIM|MAD|2027-03',
  origin: 'LIM',
  destination: 'MAD',
  from: LIMA,
  to: MADRID,
  fromCity: 'Lima',
  toCity: 'Madrid',
  bothWays: false,
};

/**
 * A pointer event the component can actually read.
 *
 * It works in `offsetX`/`offsetY` — coordinates relative to the map's own box,
 * which is what a projection wants — and jsdom leaves both at 0 however they
 * are passed to `fireEvent`. Without this a "drag" runs from (0,0) to (0,0)
 * and turns the globe by nothing at all, which looks exactly like a passing
 * test.
 */
function pointer(
  target: Element,
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  at: [number, number],
) {
  const event = createEvent[type](target, { pointerId: 1 });
  Object.defineProperty(event, 'offsetX', { get: () => at[0] });
  Object.defineProperty(event, 'offsetY', { get: () => at[1] });
  fireEvent(target, event);
}

/**
 * The same track read the other way, so the *origin* is the end round the back.
 *
 * From the home view the arc leaves Tokyo behind the globe, crosses the limb
 * and runs on to Lima — one drawn path, but one that begins part-way along its
 * own great circle. It is the case the flow's phase exists for.
 */
const NRT_LIM = arcFor('NRT-LIM-2026-11-28', ['NRT', 'LIM'], TOKYO, LIMA, ['Tokyo', 'Lima']);

/** Lima to Tokyo goes round the back of the globe from the home view. */
const LIM_TOKYO = arcFor('LIM-NRT-2026-11-14', ['LIM', 'NRT'], LIMA, TOKYO, ['Lima', 'Tokyo']);

/**
 * A wheel notch over a given spot on the map.
 *
 * `offsetX`/`offsetY` again: the handler zooms about the point under the
 * cursor, and jsdom leaves both at 0 however they are passed. A wheel test
 * without them would only ever prove that zooming about the origin works.
 */
function wheel(target: Element, deltaY: number, at: [number, number]) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
  Object.defineProperty(event, 'offsetX', { get: () => at[0] });
  Object.defineProperty(event, 'offsetY', { get: () => at[1] });
  target.dispatchEvent(event);
}

/**
 * Let the map's own frame run.
 *
 * A wheel notch only writes the new scale and wakes the loop; the drawing and
 * the overlay's commit happen on the next frame, the same path a drag takes.
 * Reading the DOM straight after the event measures whatever render the
 * `moving` flag happened to cause, which is not the zoom.
 */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 24));
  });
}

/**
 * A query client, because the map asks the API for one country's subdivisions
 * once a reader has zoomed into it.
 *
 * A fresh one per render, unlike `useSubdivisions.test`: here the cache is not
 * what is being proved, and one shared between tests would let a country
 * fetched by an earlier test appear in a later one.
 */
function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderMap(overrides: Partial<React.ComponentProps<typeof RouteMap>> = {}) {
  const props = {
    routes: [LIM_CUZ, LIM_MAD],
    selectedId: null,
    onSelect: vi.fn(),
    colours: new Map<string, string>(),
    lastCollectedId: null,
    projection: 'globe' as const,
    onProjectionChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<RouteMap {...props} />, { wrapper }), props };
}

describe('RouteMap', () => {
  it('renders one reachable item per watched route', () => {
    renderMap();
    const list = screen.getByRole('list', { name: /watched routes/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('names each route by its cities rather than its codes', () => {
    // The arc is the only thing on this map carrying meaning, so it is the one
    // thing that has to say what it is out loud.
    renderMap();
    expect(screen.getByLabelText('Lima to Cusco')).toBeInTheDocument();
    expect(screen.getByLabelText('Lima to Madrid')).toBeInTheDocument();
  });

  it('offers both projections and says which is showing', () => {
    renderMap();
    expect(screen.getByRole('button', { name: 'Globe' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Mercator' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('asks for the other projection when the other button is pressed', () => {
    const { props } = renderMap();
    screen.getByRole('button', { name: 'Mercator' }).click();
    expect(props.onProjectionChange).toHaveBeenCalledWith('mercator');
  });

  it('draws the same routes flat', () => {
    renderMap({ projection: 'mercator' });
    expect(screen.getByLabelText('Lima to Madrid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mercator' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('survives having nothing to draw', () => {
    // A watchlist whose routes have never been collected has no coordinates
    // yet, and an empty map is a normal state rather than a broken one.
    renderMap({ routes: [] });
    expect(within(screen.getByRole('list')).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('dashes the arcs on the globe and draws them solid when flat', () => {
    // A dash reads as depth on a curved, busy surface. On a flat map it only
    // fragments a line that already reads perfectly well.
    const { container, rerender } = renderMap();
    expect(container.querySelectorAll('[class*="dashed"]').length).toBeGreaterThan(0);

    rerender(
      <RouteMap
        routes={[LIM_CUZ, LIM_MAD]}
        selectedId={null}
        onSelect={vi.fn()}
        colours={new Map()}
        lastCollectedId={null}
        projection="mercator"
        onProjectionChange={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('[class*="dashed"]')).toHaveLength(0);
  });

  it('draws each arc from its origin, which is the way the dashes then run', () => {
    /*
     * Forwards along the path only means "towards the destination" because the
     * path is sampled that way — `greatCircle` interpolates from `from` to
     * `to`. Reverse that and the animation is still correct and the map is
     * still wrong, so the geometry's own direction is checked rather than
     * assumed: the first point of the arc is where the origin's dot is.
     */
    const { container } = renderMap({ routes: [LIM_CUZ] });
    const arc = container.querySelector('[class*="arc"]')!;
    const [x, y] = arc.getAttribute('d')!.slice(1).split('L')[0].split(',').map(Number);

    const lima = container.querySelector('circle[class*="home"]')!;
    expect(x).toBeCloseTo(Number(lima.getAttribute('cx')), 1);
    expect(y).toBeCloseTo(Number(lima.getAttribute('cy')), 1);
  });

  it('starts an arc that is wholly in view at the start of the pattern', () => {
    // Opened, because only the open route flows now.
    const { container } = renderMap({ routes: [LIM_CUZ], selectedId: LIM_CUZ.leading });
    const arc = container.querySelector('[class*="flow"]') as SVGElement;
    expect(arc.style.animationDelay).toBe(flowDelay(0));
  });

  it('flows the route the reader has open and leaves every other one still', () => {
    /*
     * Nine arcs leaving one city, all of them moving, is a page of activity
     * with nothing singled out. One moving line is the route that is open,
     * saying which way it goes — which is what the flow was for.
     *
     * jsdom does no layout and runs no animation, so what is checked is the
     * class that carries the keyframes and the phase set beside it. That the
     * dashes actually travel is not provable here.
     */
    const { container } = renderMap({ routes: [LIM_CUZ, LIM_MAD], selectedId: LIM_CUZ.leading });

    const flowing = [...container.querySelectorAll('[class*="flow"]')];
    expect(flowing.length).toBeGreaterThan(0);
    for (const arc of flowing) {
      expect(arc.closest('g[role="listitem"]')).toBe(
        container.querySelector(`[aria-label="Lima to Cusco"]`)?.closest('g[role="listitem"]'),
      );
    }

    // Madrid keeps its dashes and loses its clock.
    const madrid = container
      .querySelector('[aria-label="Lima to Madrid"]')
      ?.closest('g[role="listitem"]') as SVGElement;
    expect(madrid.querySelectorAll('[class*="flow"]')).toHaveLength(0);
    expect(madrid.querySelectorAll('[class*="dashed"]').length).toBeGreaterThan(0);
    for (const arc of madrid.querySelectorAll('path[class*="arc"]')) {
      expect((arc as SVGElement).style.animationDelay).toBe('');
    }
  });

  it('moves the flow to whichever route is opened next', () => {
    // The animation belongs to the selection, not to a route, so it has to
    // travel when the selection does.
    const { container, rerender } = renderMap({
      routes: [LIM_CUZ, LIM_MAD],
      selectedId: LIM_CUZ.leading,
    });
    rerender(
      <RouteMap
        routes={[LIM_CUZ, LIM_MAD]}
        selectedId={LIM_MAD.leading}
        onSelect={vi.fn()}
        colours={new Map()}
        lastCollectedId={null}
        projection="globe"
        onProjectionChange={vi.fn()}
      />,
    );

    const cusco = container
      .querySelector('[aria-label="Lima to Cusco"]')
      ?.closest('g[role="listitem"]') as SVGElement;
    const madrid = container
      .querySelector('[aria-label="Lima to Madrid"]')
      ?.closest('g[role="listitem"]') as SVGElement;
    expect(cusco.querySelectorAll('[class*="flow"]')).toHaveLength(0);
    expect(madrid.querySelectorAll('[class*="flow"]').length).toBeGreaterThan(0);
  });

  it('leaves the whole globe still when no route is open', () => {
    // Nothing selected is a real state — it is what the page shows before the
    // watchlist has loaded — and it should cost no animation at all.
    const { container } = renderMap({ routes: [LIM_CUZ, LIM_MAD], selectedId: null });
    expect(container.querySelectorAll('[class*="flow"]')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="dashed"]').length).toBeGreaterThan(0);
  });

  it('flows the arc a collection has just landed on, without it being opened', () => {
    /*
     * The case the whole of `a-pair-draws-one-arc` has to answer for. A pair
     * watched both ways is one line, so what a finished collection on the
     * return leg changes is that line's *direction* — and a line that is not
     * moving cannot show a direction changing. Adding a route does not open
     * it, so waiting for the reader to click first would mean nothing at all
     * happened when the fetch came back.
     */
    const { container } = renderMap({
      routes: [LIM_CUZ, LIM_SCL_BOTH],
      selectedId: LIM_CUZ.leading,
      lastCollectedId: 'SCL|LIM|2027-03',
    });

    const santiago = container
      .querySelector('[aria-label^="Santiago to Lima"]')
      ?.closest('g[role="listitem"]') as SVGElement;
    expect(santiago.querySelectorAll('[class*="flow"]').length).toBeGreaterThan(0);
    // And it is not the open one, so it does not also thicken.
    expect(santiago.querySelectorAll('[class*="active"]')).toHaveLength(0);
  });

  it('draws a pair watched both ways as one arc, running the leading way', () => {
    // Two watches, one line — and the line leaves Santiago, because that is
    // the leg the geometry was pointed at.
    const { container } = renderMap({ routes: [LIM_SCL_BOTH] });
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);

    const arc = container.querySelector('path[class*="arc"]')!;
    const [x, y] = arc.getAttribute('d')!.slice(1).split('L')[0].split(',').map(Number);
    const dots = [...container.querySelectorAll('circle')];
    const santiago = dots.find((dot) => Math.abs(Number(dot.getAttribute('cx')) - x) < 0.5);
    expect(santiago).toBeDefined();
    expect(Number(santiago!.getAttribute('cy'))).toBeCloseTo(y, 1);
  });

  it('leaves both ends of a both-ways pair neutral, because both are departures', () => {
    /*
     * `a-both-ways-pair-has-two-homes`. Lima carries every other arc on this
     * page and each draws its own neutral dot there; letting one arc flip to
     * point *at* Lima and colour it would drop a smaller coloured dot on that
     * stack, and which ended up on top would come down to watchlist order.
     */
    const { container } = renderMap({ routes: [LIM_SCL_BOTH] });
    expect(container.querySelectorAll('circle[class*="node"]')).toHaveLength(0);
    expect(container.querySelectorAll('circle[class*="home"]')).toHaveLength(2);
  });

  it('names a both-ways arc after the way it is running, and says it is both', () => {
    // A reader who cannot see the dashes move has no other way to learn either
    // of those two things.
    renderMap({ routes: [LIM_SCL_BOTH] });
    expect(screen.getByLabelText('Santiago to Lima, watched both ways')).toBeInTheDocument();
  });

  it('thickens a shared arc when either of its watches is the open one', () => {
    // One line stands for both; an arc that is plainly the reader's route and
    // does not look it is the worse failure.
    for (const open of ['LIM|SCL|2027-03', 'SCL|LIM|2027-03']) {
      const { container, unmount } = renderMap({ routes: [LIM_SCL_BOTH], selectedId: open });
      expect(container.querySelectorAll('[class*="active"]').length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('turns the arc round without changing the colour it is drawn in', () => {
    /*
     * The owner, having seen the direction rule working: "no debe cambiar el
     * color". `colour-holds-the-first-watch` against
     * `the-open-watch-leads-its-arc` — the two now name different watches on a
     * both-ways pair, and this is the one place a reader can see both at once.
     * The line reverses when the other leg is opened; the stroke does not move.
     */
    const colours = new Map([
      ['LIM|SCL|2027-03', '#d6a65d'],
      ['SCL|LIM|2027-03', '#70b9c9'],
    ]);

    const outbound = renderMap({
      routes: [LIM_SCL_OUTBOUND],
      selectedId: 'LIM|SCL|2027-03',
      colours,
    });
    const named = outbound.container.querySelector(
      '[aria-label="Lima to Santiago, watched both ways"]',
    );
    expect(named).toBeInTheDocument();
    // The arc leaves the airport it is named after: the first point of the
    // drawn path sits on the dot labelled LIM.
    const start = outbound.container
      .querySelector('path[class*="arc"]')!
      .getAttribute('d')!
      .slice(1)
      .split('L')[0]
      .split(',')
      .map(Number);
    const at = [...outbound.container.querySelectorAll('circle')].find(
      (dot) => Math.abs(Number(dot.getAttribute('cx')) - start[0]) < 0.5,
    );
    expect(at?.closest('g')?.querySelector('text')?.textContent).toBe('LIM');
    expect((named as SVGElement).style.stroke).toBe('#d6a65d');
    outbound.unmount();

    // The other leg opened. The same line now runs the other way and says so,
    // and it is the same colour it was before the click.
    const inbound = renderMap({
      routes: [LIM_SCL_BOTH],
      selectedId: 'SCL|LIM|2027-03',
      colours,
    });
    const back = inbound.container.querySelector(
      '[aria-label="Santiago to Lima, watched both ways"]',
    );
    expect(back).toBeInTheDocument();
    expect((back as SVGElement).style.stroke).toBe('#d6a65d');
    // And the second row's colour is on no line at all, which is what one arc
    // standing for two watches costs.
    const strokes = [...inbound.container.querySelectorAll('path[class*="arc"]')].map(
      (arc) => (arc as SVGElement).style.stroke,
    );
    expect(strokes).not.toContain('#70b9c9');
  });

  it('colours the arrival dot for the same watch the line is drawn for', () => {
    /*
     * The arrival marker is the map's other coloured thing, and it had the
     * same fault to inherit: a 4px dot that repainted when the reader opened
     * the other month is the stroke's fault repeated small. Two months on one
     * pair is the case that shows it — the arc keeps an arrival dot because
     * neither watch flies the other way, and June points the line while March
     * colours it.
     */
    const { container } = renderMap({
      routes: [LIM_MAD_TWICE],
      selectedId: 'LIM|MAD|2027-06',
      colours: new Map([
        ['LIM|MAD|2027-03', '#d6a65d'],
        ['LIM|MAD|2027-06', '#70b9c9'],
      ]),
    });
    const arrival = container.querySelector('circle[class*="node"]') as SVGElement;
    expect(arrival).toBeInTheDocument();
    expect(arrival.style.fill).toBe('#d6a65d');
    const stroke = (container.querySelector('path[class*="arc"]') as SVGElement).style.stroke;
    expect(stroke).toBe('#d6a65d');
  });

  it('cycles to the other watch whichever of the two is leading the arc', () => {
    /*
     * `arc-click-cycles-its-watches` under `the-open-watch-leads-its-arc`. With
     * the open watch leading, the branch that opens the leading one never
     * fires on this arc — so what has to be checked is that the press still
     * moves on by one from *either* end rather than answering the watch that is
     * already open.
     */
    const outbound = renderMap({
      routes: [LIM_SCL_OUTBOUND],
      selectedId: 'LIM|SCL|2027-03',
    });
    expect(outbound.container.querySelector('[class*="hit"]')?.getAttribute('data-route')).toBe(
      'SCL|LIM|2027-03',
    );
    outbound.unmount();

    const inbound = renderMap({ routes: [LIM_SCL_BOTH], selectedId: 'SCL|LIM|2027-03' });
    expect(inbound.container.querySelector('[class*="hit"]')?.getAttribute('data-route')).toBe(
      'LIM|SCL|2027-03',
    );
  });

  it('offers the other watch on a shared arc once the first one is open', () => {
    /*
     * `arc-click-cycles-its-watches`. Answering the leading watch whatever is
     * open would leave the second one a line the reader can see, can hover and
     * cannot reach.
     */
    const closed = renderMap({ routes: [LIM_SCL_BOTH], selectedId: null });
    expect(closed.container.querySelector('[class*="hit"]')?.getAttribute('data-route')).toBe(
      'SCL|LIM|2027-03',
    );
    closed.unmount();

    const open = renderMap({ routes: [LIM_SCL_BOTH], selectedId: 'SCL|LIM|2027-03' });
    expect(open.container.querySelector('[class*="hit"]')?.getAttribute('data-route')).toBe(
      'LIM|SCL|2027-03',
    );
  });

  it('picks up the phase the hidden half of an arc carried round the back', () => {
    /*
     * Tokyo to Lima leaves from behind the globe: the stretch before the limb
     * is never drawn, and the run that comes into view begins part-way along
     * its own great circle. Starting its dashes at zero would pin the pattern
     * to the horizon instead of to the geography, so the dashes would slide
     * with the limb as the globe turns rather than staying on the arc. The
     * hidden length is counted, so they stay put.
     */
    const { container } = renderMap({ routes: [NRT_LIM], selectedId: NRT_LIM.leading });
    const arcs = [...container.querySelectorAll('[class*="flow"]')] as SVGElement[];
    expect(arcs).toHaveLength(1);
    expect(arcs[0].style.animationDelay).not.toBe(flowDelay(0));
  });

  it('leaves the flat map still, because a solid line cannot show flow', () => {
    // Mercator arcs are solid by decision, so there is nothing to animate and
    // no phase to give them — including the open one, which is the case that
    // would break if the flow were hung on the selection alone.
    const { container } = renderMap({ projection: 'mercator', selectedId: LIM_CUZ.leading });
    expect(container.querySelectorAll('[class*="flow"]')).toHaveLength(0);
    for (const arc of container.querySelectorAll('[class*="arc"]')) {
      expect((arc as SVGElement).style.animationDelay).toBe('');
    }
  });

  it('names the continents while the whole world is in view, either projection', () => {
    // Ours, because a blank basemap has no symbol layers — and on the flat map
    // as much as on the globe, since at this zoom neither one names anything
    // else.
    const { rerender } = renderMap();
    expect(screen.getByText('South America')).toBeInTheDocument();

    rerender(
      <RouteMap
        routes={[LIM_CUZ]}
        selectedId={null}
        onSelect={vi.fn()}
        colours={new Map()}
        lastCollectedId={null}
        projection="mercator"
        onProjectionChange={vi.fn()}
      />,
    );
    expect(screen.getByText('South America')).toBeInTheDocument();
  });

  it('does not name a country before there is any point in naming one', () => {
    // Brazil has room for its name in the very first frame. Printing it beside
    // SOUTH AMERICA is the clutter the handover exists to avoid.
    renderMap();
    expect(screen.queryByText('Brazil')).not.toBeInTheDocument();
  });

  it.each(['globe', 'mercator'] as const)(
    'hands the continents over to country names as %s closes in',
    async (projection) => {
      const user = userEvent.setup();
      const { container } = renderMap({ projection });
      const stage = container.querySelector('[class*="stage"]') as HTMLElement;
      stage.focus();
      /*
       * The keyboard route, since the plus and minus buttons are gone. Eight
       * presses, not the five the target arithmetic suggests: zoom eases
       * towards its target, and jsdom does not reliably run the frame loop
       * that does the easing. Eight is past the handover on the immediate
       * first step of each press alone — so the test does not care whether any
       * frames ran, which is what stopped it flickering.
       */
      for (let press = 0; press < 8; press += 1) await user.keyboard('+');

      expect(screen.getByText('Peru')).toBeInTheDocument();
      expect(screen.queryByText('South America')).not.toBeInTheDocument();
    },
  );

  /* ------------------------------------------------------- subdivisions -- */

  /**
   * Two Peruvian departments and the border between them, as the API sends it.
   *
   * Peru because the home view is turned to Lima, so the middle of the frame
   * is already over it — which is what the map inverts to decide whose
   * subdivisions to ask for, and why zooming in from the default view is the
   * whole gesture this feature answers to.
   */
  const PERU_SUBDIVISIONS = {
    country: '604',
    borders: {
      type: 'Topology',
      objects: { borders: { type: 'MultiLineString', arcs: [[0]] } },
      arcs: [
        [
          [-76, -6],
          [-74, -9],
        ],
      ],
    },
    labels: [
      { name: 'Loreto', at: [-74.4242, -4.0942], area: 0.0092493 },
      { name: 'Cusco', at: [-72.1831, -13.1676], area: 0.0018352 },
    ],
  };

  function servingPeru() {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        subdivisionRequests.push(String(input));
        return Promise.resolve(
          String(input).includes('/604')
            ? Response.json(PERU_SUBDIVISIONS)
            : new Response('null', { status: 404 }),
        );
      }),
    );
  }

  /**
   * Six notches of wheel over the middle of the frame, and then long enough
   * for the map to settle and ask.
   *
   * Five notches of a size that puts the *target* near 7.4x, rather than two
   * big ones that would peg it at the 32x ceiling. Both would clear the 4.6x
   * crossover, but the ceiling is not where these tests want to be: at 32x a
   * 540px frame spans four degrees, so Peru's own centroid and half its
   * departments fall outside it, and a name that is culled for being off the
   * frame looks exactly like a name that was refused for want of room.
   *
   * The wheel rather than the keyboard because it moves further per event, and
   * over the middle, so the zoom anchors on the point the globe is already
   * turned to and Peru stays under it.
   *
   * Two `act` blocks, not one. Dispatching the events and then awaiting a
   * timer inside the *same* async act leaves the wheel handler's work
   * unapplied — measured, the scale was still 1.0 at the end of it. Closing
   * the act after the gesture is what commits it, which is also how a browser
   * sees it: a gesture, and then time passing.
   */
  async function closeInOnPeru(stage: HTMLElement) {
    await act(async () => {
      for (let notch = 0; notch < 5; notch += 1) wheel(stage, -200, [480, 270]);
    });
    // Past the 320ms the wheel holds the map "moving" and the 250ms it then
    // has to sit still before it asks.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
  }

  it('gives a country its name back as subdivisions once you are close enough', async () => {
    servingPeru();
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Loreto')).toBeInTheDocument());
    /*
     * One thing becoming another, not two things at once: past the crossover
     * the country's own name is gone and the departments inside it are what is
     * left.
     *
     * Waited for rather than asserted straight away, because the becoming now
     * takes `ARRIVAL_MS`: the departments fade up and Peru's own name fades
     * down at exactly the same rate, so this is the *end* of a cross-fade and
     * not a state the very next frame is in.
     */
    await waitFor(() => expect(screen.queryByText('Peru')).not.toBeInTheDocument());
    expect(subdivisionRequests.some((url) => url.includes('/api/geography/subdivisions/604'))).toBe(
      true,
    );
  });

  it('holds the view still while the detail arrives, instead of resuming the glide', async () => {
    /*
     * The fade wakes the frame loop, and the frame loop used to pick up an
     * unfinished zoom.
     *
     * `approach` is an exponential and an exponential never arrives, so it
     * snaps once the remainder is under a twentieth of a percent of the target.
     * Small, and not nothing: measured in Chrome after a sixteen-notch wheel
     * zoom, the loop shut down 320 ms past the last notch with the scale 0.022
     * short of 24.51, which on a globe whose radius is `0.42 x 460 x zoom` is
     * 1.3 px. The map sat there until Peru's subdivisions landed a second
     * later, the arrival woke the loop for the fade, and the loop went back to
     * easing — so the whole view crept while the borders were coming up
     * underneath it, which is two movements where the map means to show one.
     *
     * Geometry rather than opacity is what this watches, because opacity is
     * *supposed* to be changing here: the airports must be exactly where they
     * were, from the frame the first name appears to the frame the fade ends.
     */
    servingPeru();
    const { container } = renderMap({ routes: [LIM_CUZ] });
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);
    await waitFor(() => expect(screen.getByText('Loreto')).toBeInTheDocument());

    const airports = () =>
      [...container.querySelectorAll('circle')]
        .map((dot) => `${dot.getAttribute('cx')},${dot.getAttribute('cy')}`)
        .join(' ');
    const asDetailLands = airports();
    // Past `ARRIVAL_MS`, so the whole of the fade has run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(airports()).toBe(asDetailLands);
  });

  it('names a subdivision its own name fits and refuses one three times too wide', async () => {
    /*
     * The room a name needs is the room *that name* needs. Two units with
     * exactly the same ground under them and nothing different about them but
     * how long they are called: measured at the cap, both have about 5,000px²,
     * `Ica` is 15px wide and needs 546, and the longest first-level name in
     * Natural Earth's whole admin-1 list — Chile's Aisén region, which the
     * stub stands in for here because the pair is about length and not about
     * geography — is 203px wide and needs 7,467.
     *
     * The flat threshold this replaced gave both of them full strength, which
     * is how a 203px name came to be printed across 77px of ground. It also
     * refused `Ica` at 1,222px², which is where the other seventeen of Peru's
     * twenty-six departments went.
     */
    const SHORT = 'Ica';
    const LONG = 'Aisén del General Carlos Ibáñez del Campo';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        subdivisionRequests.push(url);
        // The index answered as an index. Answering it with a country's
        // payload leaves `countries` empty, which is the map being told that
        // nothing in the world has subdivisions — and it then correctly asks
        // for none.
        if (url.endsWith('/api/geography/subdivisions')) {
          return Promise.resolve(Response.json({ countries: { '604': 43_085 } }));
        }
        return Promise.resolve(
          Response.json({
            country: '604',
            borders: PERU_SUBDIVISIONS.borders,
            // Two degrees either side of the point the globe is turned to, so
            // both are face-on, both are on the frame, and the 187px between
            // them is far more than either box is tall.
            labels: [
              { name: LONG, at: [-77, -9], area: 0.001537 },
              { name: SHORT, at: [-77, -3], area: 0.001537 },
            ],
          }),
        );
      }),
    );

    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText(SHORT)).toBeInTheDocument());
    expect(screen.queryByText(LONG)).not.toBeInTheDocument();
  });

  it('keeps a country with no subdivisions named, and says nothing about it', async () => {
    /*
     * The silent fallback, which is the whole of what a reader over Western
     * Sahara or the Falklands should notice: the country keeps its name and
     * there is no banner, no empty flash and nothing to dismiss. Here the
     * stub 404s every country, Peru included.
     */
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Peru')).toBeInTheDocument());
    expect(screen.queryByText('Loreto')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /* ------------------------------------------------------------ fan-out -- */

  /**
   * Bolivia, as the API sends it, with two departments large enough to name.
   *
   * Bolivia because it is the country in the complaint: at 10x with eleven
   * Peruvian departments showing, Bolivia beside them was a flat shape with
   * only its country name on it, and Chile below the border had no internal
   * lines at all. It is the discontinuity this whole change removes.
   */
  const BOLIVIA_SUBDIVISIONS = {
    country: '068',
    borders: {
      type: 'Topology',
      objects: { borders: { type: 'MultiLineString', arcs: [[0]] } },
      arcs: [
        [
          [-66, -14],
          [-64, -18],
        ],
      ],
    },
    labels: [
      { name: 'Beni', at: [-66, -14], area: 0.0052 },
      { name: 'Pando', at: [-67.5, -11], area: 0.0025 },
    ],
  };

  /**
   * Ecuador, whose own name the map already draws at this zoom.
   *
   * It is the control for the handover: `does not name a country before there
   * is any point in naming one` and the dump of what this view renders both
   * say Ecuador is on the frame with its name lit, so a test that finds that
   * name gone has watched a neighbour give it up to its own provinces.
   */
  const ECUADOR_SUBDIVISIONS = {
    country: '218',
    borders: {
      type: 'Topology',
      objects: { borders: { type: 'MultiLineString', arcs: [[0]] } },
      arcs: [
        [
          [-78.5, -1],
          [-77.5, -2],
        ],
      ],
    },
    labels: [{ name: 'Napo', at: [-77.5, -1], area: 0.003 }],
  };

  /** Real byte counts, because the budget is spent in real ones. */
  const WEIGHS: Record<string, number> = {
    '604': 43_085,
    '068': 20_656,
    '218': 12_463,
    '152': 127_823,
  };

  function servingSouthAmerica(catalogue: Record<string, number> | null = WEIGHS) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        subdivisionRequests.push(url);
        if (url.endsWith('/api/geography/subdivisions')) {
          return Promise.resolve(
            catalogue
              ? Response.json({ countries: catalogue })
              : new Response('{"detail":"boom"}', { status: 500 }),
          );
        }
        if (url.endsWith('/604')) return Promise.resolve(Response.json(PERU_SUBDIVISIONS));
        if (url.endsWith('/068')) return Promise.resolve(Response.json(BOLIVIA_SUBDIVISIONS));
        if (url.endsWith('/218')) return Promise.resolve(Response.json(ECUADOR_SUBDIVISIONS));
        return Promise.resolve(new Response('null', { status: 404 }));
      }),
    );
  }

  it('draws the subdivisions of every country in view, not only the one in the middle', async () => {
    /*
     * The whole change, in one test. Peru is the country the reader zoomed
     * into; Bolivia is the neighbour that used to sit beside it as a flat
     * shape with only its country name on it. Now both are drawn department by
     * department, and the view reads as one map rather than as one detailed
     * country among blank ones.
     */
    servingSouthAmerica();
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Beni')).toBeInTheDocument());
    expect(screen.getByText('Loreto')).toBeInTheDocument();
  });

  it('has a neighbour give up its own name the way the middle country does', async () => {
    // The handover is per country now, not one country's privilege. Ecuador
    // was named before its provinces arrived and is not named after.
    servingSouthAmerica();
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Napo')).toBeInTheDocument());
    // The end of each country's own cross-fade, which is `ARRIVAL_MS` after
    // its geometry landed and not the frame after it.
    await waitFor(() => expect(screen.queryByText('Ecuador')).not.toBeInTheDocument());
    expect(screen.queryByText('Peru')).not.toBeInTheDocument();
  });

  it('leaves a country the budget will not stretch to with its own name on it', async () => {
    /*
     * The cap, and the one thing it must not do quietly. A country the fan-out
     * could not afford is in exactly the same position as one Natural Earth
     * does not divide: it keeps its name. So every country on screen is either
     * showing its subdivisions and has given up its name to them, or is
     * showing its name — and a reader can read off the map which ones it drew
     * in detail without being handed a number to trust.
     */
    servingSouthAmerica({ ...WEIGHS, '218': 40_000_000 });
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Loreto')).toBeInTheDocument());
    expect(screen.getByText('Ecuador')).toBeInTheDocument();
    expect(screen.queryByText('Napo')).not.toBeInTheDocument();
    expect(subdivisionRequests.some((url) => url.endsWith('/218'))).toBe(false);
  });

  it('never asks for a country the index says has nothing to give', async () => {
    /*
     * Before the index that cost a 404 to find out, which one country per
     * request could afford and a view holding thirty cannot. Chile has no
     * entry here, so it is never asked about at all.
     */
    servingSouthAmerica({ '604': 43_085, '068': 20_656, '218': 12_463 });
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Beni')).toBeInTheDocument());
    expect(subdivisionRequests.some((url) => url.endsWith('/152'))).toBe(false);
  });

  it('pulls a name off the edge of the panel so the whole word is on the map', async () => {
    /*
     * The map's stage clips and the names are centred on the point they name,
     * so a name near an edge had its far half cut off by the panel: at 10x
     * with Peru's departments showing, Bolivia rendered as `Bolivi`, which is
     * not a place, in a face small enough that a reader cannot tell it from
     * one.
     *
     * Two names on the same point and nothing different about them but how
     * long they are. Sixteen degrees east of the middle of this view is about
     * 890px across a 960px frame, so `Ica` at 15px wide has room to stay
     * exactly where it belongs and the 198px name does not — and where the
     * long one ends up is flush inside the frame rather than anywhere the
     * geometry chose, which is why one constant could never have covered both.
     */
    const SHORT = 'Ica';
    const LONG = 'Aisén del General Carlos Ibáñez del Campo';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        subdivisionRequests.push(url);
        if (url.endsWith('/api/geography/subdivisions')) {
          return Promise.resolve(Response.json({ countries: { '604': 43_085 } }));
        }
        return Promise.resolve(
          url.endsWith('/604')
            ? Response.json({
                country: '604',
                borders: PERU_SUBDIVISIONS.borders,
                labels: [
                  { name: LONG, at: [-61, -6], area: 0.02 },
                  { name: SHORT, at: [-61, -6], area: 0.019 },
                ],
              })
            : new Response('null', { status: 404 }),
        );
      }),
    );

    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText(LONG)).toBeInTheDocument());
    const at = (text: string) => Number(screen.getByText(text).getAttribute('x'));
    // Flush inside the right-hand edge, to the pixel — moved, and moved only
    // as far as it had to be.
    expect(at(LONG)).toBeCloseTo(960 - nameBox(LONG, 'subdivision').width / 2, 6);
    // Real rather than vacuous: the same point left the short name alone,
    // where a rule that culled or clamped everything near an edge would have
    // moved it too.
    expect(at(SHORT)).toBeGreaterThan(at(LONG));
    expect(at(SHORT) + nameBox(SHORT, 'subdivision').width / 2).toBeLessThanOrEqual(960);
  });

  it('still details the country in the middle when the index will not load', async () => {
    /*
     * Which is how the map behaved before there was an index. The fan-out is
     * the improvement and the single country is the floor, so an API that
     * cannot answer for the collection still leaves a reader with the country
     * they zoomed into rather than with a blank one.
     */
    servingSouthAmerica(null);
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Loreto')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /* ----------------------------------------------------------- arriving -- */

  it('leaves no name behind when two subdivisions on screen are called the same thing', async () => {
    /*
     * The reader's report, reproduced: names of certain states and provinces
     * getting stuck on the globe.
     *
     * A name was the whole of a label's identity, and it is not one. Misiones
     * is a province of Argentina and a department of Paraguay 237 km away —
     * one frame holds both — Amazonas belongs to four countries, La Paz to
     * three, and Latvia has two Daugavpils five kilometres apart: forty-eight
     * names in Natural Earth's admin-1 list are shared across countries and
     * fifteen countries repeat one inside themselves. Two React children under
     * one key is unsupported, and what React 19 does with it is leave one of
     * the two `<text>` nodes behind on the commit that drops it — permanently,
     * because reconciliation has lost track of it. Measured in Chrome on the
     * reader's own stage, one drag away from the Argentine-Paraguayan border
     * left **eight** stuck `Misiones` labels strewn across Brazil and the
     * South Atlantic.
     *
     * Two labels of one name six degrees apart, which is 187px here — far more
     * than either box is tall, so `withoutOverlaps` keeps both and the
     * collision is real rather than hidden by the overlap rule. Then the map
     * is taken back out past the crossover, where the whole rung is dropped:
     * every one of them should go.
     */
    const TWINNED = 'Misiones';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        subdivisionRequests.push(url);
        if (url.endsWith('/api/geography/subdivisions')) {
          return Promise.resolve(Response.json({ countries: { '604': 43_085 } }));
        }
        return Promise.resolve(
          Response.json({
            country: '604',
            borders: PERU_SUBDIVISIONS.borders,
            labels: [
              { name: TWINNED, at: [-77, -9], area: 0.001537 },
              { name: TWINNED, at: [-77, -3], area: 0.001537 },
            ],
          }),
        );
      }),
    );

    const { container } = renderMap();
    const stage = container.querySelector('[class*="stage"]') as HTMLElement;
    await closeInOnPeru(stage);
    await waitFor(() => expect(screen.getAllByText(TWINNED)).toHaveLength(2));

    // Back out to about 3x: past the 4.6x crossover, so the subdivision rung
    // is gone, and short of 1.6x, so the country rung is still lit and there
    // is something to compare an orphan against.
    await act(async () => {
      for (let notch = 0; notch < 3; notch += 1) wheel(stage, 150, [480, 270]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    await waitFor(() => expect(screen.getByText('Peru')).toBeInTheDocument());
    expect(screen.queryAllByText(TWINNED)).toHaveLength(0);
  });

  it('brings a country in by fading rather than in the frame its geometry lands on', async () => {
    /*
     * The reader's other report: the detail appears neither fluidly nor at the
     * same moment for every country.
     *
     * Half of that is what a fan-out is — several countries land when they
     * land — and the half that was wrong is that each of them landed in a
     * single frame. A country went from coarse-and-named to fine-and-divided
     * between one frame and the next, so a view made of several arrivals read
     * as a run of separate pops rather than as one thing filling in. Measured
     * cold in Chrome on the reader's own 529x460 stage, the reader watched
     * nothing at all for about 1.6s and then the whole view changed at once.
     *
     * Everything else on this map that appears, appears by fading, and the
     * fade comes from the geometry — 12.27, 12.28, `limbFade`, `roomFade`.
     * This is that rule reaching the one layer that was not using it, and the
     * fade is a genuine cross-fade: for as long as Peru's own name is still
     * lit, its departments are dimmer than they end up.
     */
    servingPeru();
    const { container } = renderMap();
    await closeInOnPeru(container.querySelector('[class*="stage"]') as HTMLElement);

    // A moment when both rungs are on the map at once, which is what a
    // cross-fade *is* and which a layer that switches on has none of.
    let midway = Number.NaN;
    await waitFor(() => {
      midway = Number((screen.getByText('Loreto') as unknown as SVGTextElement).style.opacity);
      expect(screen.getByText('Peru')).toBeInTheDocument();
    });

    await waitFor(() => expect(screen.queryByText('Peru')).not.toBeInTheDocument());
    const settled = Number((screen.getByText('Loreto') as unknown as SVGTextElement).style.opacity);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(settled);
  });

  it('asks for nothing at all while the globe is only being spun', async () => {
    /*
     * The first of the three things damping the fetch, and the one that keeps
     * a reader who never zooms in from sending a single request.
     *
     * Each spin is pulled out and brought back, so the globe finishes where it
     * started and Peru is still under the middle of the frame — otherwise the
     * drag itself would carry the middle out over the Pacific and the test
     * would pass because there was no country to ask about, which is not the
     * thing being proved. The only reason nothing is requested here is the
     * zoom gate.
     */
    const { container } = renderMap();
    const stage = container.querySelector('[class*="stage"]') as HTMLElement;
    for (let spin = 0; spin < 5; spin += 1) {
      pointer(stage, 'pointerDown', [400, 240]);
      pointer(stage, 'pointerMove', [460, 260]);
      pointer(stage, 'pointerMove', [400, 240]);
      pointer(stage, 'pointerUp', [400, 240]);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(subdivisionRequests).toEqual([]);
  });

  it('fades a continent name out as it turns towards the limb', () => {
    /*
     * The fade is the request: `facesViewer` answers yes right up to 90° and
     * no immediately after, so a name blinks out mid-rotation. Opacity comes
     * from the geometry instead, which means a name on its way round the back
     * is on screen and already partly gone.
     */
    renderMap();
    const strengths = ['South America', 'Antarctica'].map((name) =>
      Number(
        screen
          .getByText(name)
          .getAttribute('style')
          ?.match(/opacity:\s*([\d.]+)/)?.[1],
      ),
    );
    // Looking at Lima, South America is face-on and Antarctica is 83° round,
    // most of the way out. Africa would have served as well but from Lima it is
    // 97° away, which is past the limb entirely.
    expect(strengths[0]).toBeGreaterThan(strengths[1]);
    expect(strengths[1]).toBeGreaterThan(0);
  });

  it('moves the arcs and the names in the same frame as the land', () => {
    /*
     * The two surfaces have to agree. `draw` paints the canvas inside the
     * frame callback, but a plain `setState` only *schedules* a React render,
     * and React's scheduler runs on a task the browser reaches after it has
     * already painted — so the land would move on this frame and the arcs, the
     * airport codes and the place names on the next one. A single frame of
     * slip at 60 Hz is small and entirely visible: the map slides out from
     * under its own labels for as long as the drag lasts.
     *
     * So the test reads the DOM the instant the frame callback returns, before
     * anything has had a chance to flush it. If the overlay has already moved
     * there, the two surfaces are in step.
     */
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    const { container } = renderMap();
    const stage = container.querySelector('[class*="stage"]')!;
    const lima = () => container.querySelector('text')?.getAttribute('x');

    // Inside the disc, or `invert` has nothing to hand back.
    pointer(stage, 'pointerDown', [480, 270]);
    const before = lima();

    pointer(stage, 'pointerMove', [600, 300]);

    /*
     * Outside `act`, deliberately. Inside it React parks `flushSync` on the act
     * queue and flushes everything on the way out, which is exactly the
     * difference this test exists to see — under `act` the lagging version
     * passes too.
     */
    const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasActEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    frames.pop()?.(0);
    const insideTheFrame = lima();
    scope.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;

    expect(insideTheFrame).not.toBe(before);
  });

  it('lets the place names transition only once the map is at rest', () => {
    // The geometry sets opacity every frame during a drag; a CSS transition on
    // top of that is a low-pass filter, and the names drift behind the globe.
    const { container } = renderMap();
    const overlay = container.querySelector('svg')!;
    expect(overlay.className.baseVal).toMatch(/settled/);

    pointer(container.querySelector('[class*="stage"]')!, 'pointerDown', [480, 270]);
    expect(overlay.className.baseVal).not.toMatch(/settled/);
  });

  it('draws each route in its own colour', () => {
    // Every route on this page starts at LIM, so the arcs leave as a fan. In
    // one colour they are one shape; the colour is what makes them separate
    // routes a reader can follow.
    const { container } = renderMap({
      // Keyed by the watch, not by the arc — an arc has no colour of its own
      // and wears the colour of its first watch in watchlist order.
      colours: new Map([
        [LIM_CUZ.wearing, '#d6a65d'],
        [LIM_MAD.wearing, '#70b9c9'],
      ]),
    });
    const strokes = [...container.querySelectorAll('[class*="arc"]')].map(
      (arc) => (arc as SVGElement).style.stroke,
    );
    expect(strokes).toContain('#d6a65d');
    expect(strokes).toContain('#70b9c9');
  });

  it('opens a route when its line is pressed', () => {
    const { props, container } = renderMap();
    const stage = container.querySelector('[class*="stage"]')!;
    const hit = container.querySelector(`[data-route="${LIM_MAD.leading}"]`)!;

    // Down on the line, up in the same place. Selection is settled on the way
    // up rather than with a click handler on the path: the stage captures the
    // pointer as soon as a drag starts, and a captured pointer sends its click
    // to the capturing element instead of the path it began on.
    pointer(hit, 'pointerDown', [500, 300]);
    pointer(stage, 'pointerUp', [500, 300]);

    expect(props.onSelect).toHaveBeenCalledWith(LIM_MAD.leading);
  });

  it('does not open a route when the press was a drag across it', () => {
    const { props, container } = renderMap();
    const stage = container.querySelector('[class*="stage"]')!;
    const hit = container.querySelector(`[data-route="${LIM_MAD.leading}"]`)!;

    pointer(hit, 'pointerDown', [500, 300]);
    pointer(stage, 'pointerMove', [560, 320]);
    pointer(stage, 'pointerUp', [560, 320]);

    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('leaves the empty map alone when the press was not on a line', () => {
    const { props, container } = renderMap();
    const stage = container.querySelector('[class*="stage"]')!;
    pointer(stage, 'pointerDown', [480, 270]);
    pointer(stage, 'pointerUp', [480, 270]);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('drops the half of an arc that has gone round the back, and keeps its airport', () => {
    /*
     * The globe is glass for *places*, not for lines. A faint curve across the
     * back reads as a curve across the front, and it crosses everything
     * genuinely in front of it on the way. A dot does not: knowing an endpoint
     * is round there is worth something, so it stays, dimmed.
     */
    const { container } = renderMap({ routes: [LIM_TOKYO] });

    const arcs = [...container.querySelectorAll('[class*="arc"]')];
    expect(arcs.length).toBeGreaterThan(0);
    for (const arc of arcs) expect(arc.getAttribute('class')).not.toContain('behind');

    // Cut at the limb, not dropped whole: Lima is still joined to the horizon.
    expect(container.querySelectorAll(`[data-route="${LIM_TOKYO.leading}"]`).length).toBe(
      arcs.length,
    );

    // Tokyo is on the far side and still on screen.
    const tokyo = [...container.querySelectorAll('text')].find((t) => t.textContent === 'NRT');
    expect(tokyo).toBeInTheDocument();
    expect(tokyo?.closest('g')?.getAttribute('class')).toContain('behind');
  });

  it('offers no zoom buttons, and refuses to reset a view nobody has moved', () => {
    /*
     * Two buttons stepping the scale by a fixed factor are the mechanical feel
     * this was meant to lose, and they zoom about the middle of the frame
     * rather than about what the reader is looking at. Reset is the only
     * control left.
     */
    renderMap();
    expect(screen.queryByRole('button', { name: /zoom in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /zoom out/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset the view/i })).toBeDisabled();
  });

  it('keeps zoom reachable from the keyboard', async () => {
    // With the buttons gone, a wheel is the only pointer route — and no route
    // at all for someone who does not have one.
    const user = userEvent.setup();
    const { container } = renderMap();
    const stage = container.querySelector('[class*="stage"]') as HTMLElement;
    stage.focus();
    await user.keyboard('+');

    expect(screen.getByRole('button', { name: /reset the view/i })).toBeEnabled();
  });

  it('zooms about the cursor, so the place under it stays under it', async () => {
    /*
     * Scaling about the middle of the frame slides the thing you are pointing
     * at away exactly when you are trying to get closer to it. The globe has
     * no pan to shift, so it has to *turn* to bring the point back.
     */
    const { container } = renderMap();
    const stage = container.querySelector('[class*="stage"]')!;
    const lima = () => {
      const dot = container.querySelector('circle[class*="home"]')!;
      return [Number(dot.getAttribute('cx')), Number(dot.getAttribute('cy'))] as const;
    };

    const [x, y] = lima();
    wheel(stage, -240, [x, y]);
    await frame();
    const [movedX, movedY] = lima();

    expect(Math.hypot(movedX - x, movedY - y)).toBeLessThan(2);
    expect(screen.getByRole('button', { name: /reset the view/i })).toBeEnabled();
  });

  it('eases towards a notch rather than jumping to it', async () => {
    /*
     * The complaint that produced this: proportional was not enough. A mouse
     * notch of 200 asks for 1.49×, and applying 1.49× in the frame the event
     * arrives is a step however well chosen the factor is. One frame should
     * cover about a fifth of the way — 16ms against a 70ms time constant.
     */
    const { container } = renderMap();
    const stage = container.querySelector('[class*="stage"]')!;
    const spread = () => {
      const xs = [...container.querySelectorAll('circle')].map((d) => Number(d.getAttribute('cx')));
      return Math.max(...xs) - Math.min(...xs);
    };

    const before = spread();
    wheel(stage, -200, [480, 270]);
    await frame();

    const grew = spread() / before;
    expect(grew).toBeGreaterThan(1.05);
    // Nowhere near the 1.49 the notch asked for.
    expect(grew).toBeLessThan(1.2);
  });

  it('goes further in than the old ceiling let it', async () => {
    /*
     * The ceiling moved from 8x to 32x, and the check is arithmetic rather
     * than a peek at the constant. jsdom measures the stage at 960x540, so the
     * globe's radius is `0.42 x 540 x zoom`, and Lima and Cusco — 570 km apart,
     * 0.0895 radians — are 162px apart at the old 8x ceiling. Any wider than
     * that is a scale the map could not previously reach at all.
     *
     * **Six moderate notches, not two hard ones, and no frame is waited for.**
     * Each wheel event applies one easing step the instant it arrives — 20.5%
     * of the distance to the target — so the scale a gesture reaches without a
     * single frame having run is entirely determined by how the *target*
     * climbs. Two notches of -1000 peg the target at 32 immediately, and
     * `aimZoom` then refuses every further notch because the target has not
     * moved, which leaves the scale at 8.4 and this test one pixel from
     * failing. Six notches of -300 walk the target up instead and put the
     * scale at about 12.5 on the events alone. That distinction is not
     * academic: written the first way this passed on its own and failed in a
     * full run, because jsdom had no spare frames under load.
     */
    const { container } = renderMap({ routes: [LIM_CUZ] });
    const stage = container.querySelector('[class*="stage"]') as HTMLElement;
    const spread = () => {
      const xs = [...container.querySelectorAll('circle')].map((dot) =>
        Number(dot.getAttribute('cx')),
      );
      return Math.max(...xs) - Math.min(...xs);
    };

    await act(async () => {
      for (let notch = 0; notch < 6; notch += 1) wheel(stage, -300, [480, 270]);
    });

    expect(spread()).toBeGreaterThan(200);
  });

  it('zooms by how hard the wheel was turned, not once per event', async () => {
    /*
     * Exponential in the delta. A trackpad reports a few pixels per gesture
     * and a mouse notch about a hundred, so a fixed factor per *event* gives
     * the trackpad a crawl and the mouse a jump.
     *
     * One notch per render, rather than two into the same map: the overlay
     * redraws from the frame loop, and jsdom does not run one here — so a
     * second event into the same tree changes the projections without
     * anything reading them again.
     */
    const spread = async (deltaY: number) => {
      const { container, unmount } = renderMap();
      const stage = container.querySelector('[class*="stage"]')!;
      const width = () => {
        const xs = [...container.querySelectorAll('circle')].map((d) =>
          Number(d.getAttribute('cx')),
        );
        return Math.max(...xs) - Math.min(...xs);
      };
      const before = width();
      wheel(stage, deltaY, [480, 270]);
      await frame();
      const grew = width() - before;
      unmount();
      return grew;
    };

    const gentle = await spread(-20);
    const firm = await spread(-200);
    expect(gentle).toBeGreaterThan(0);
    expect(firm).toBeGreaterThan(gentle * 3);
  });

  it('does not crash without a canvas context', () => {
    // jsdom's `getContext` returns null. The component has to treat that as
    // "nothing to paint" rather than throwing, or every test on this page
    // would fail on a detail none of them are about.
    expect(() => renderMap()).not.toThrow();
  });
});
