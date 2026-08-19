import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flowDelay } from '@/features/airfare/lib/arcFlow';
import type { RouteGeometry } from '@/features/airfare/lib/geo';
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
});

const LIM_CUZ: RouteGeometry = {
  id: 'LIM-CUZ-2026-10-17',
  origin: 'LIM',
  destination: 'CUZ',
  from: [-77.114444, -12.021944],
  to: [-71.938889, -13.535833],
  fromCity: 'Lima',
  toCity: 'Cusco',
};

const LIM_MAD: RouteGeometry = {
  id: 'LIM-MAD-2026-10-17',
  origin: 'LIM',
  destination: 'MAD',
  from: [-77.114444, -12.021944],
  to: [-3.567222, 40.498333],
  fromCity: 'Lima',
  toCity: 'Madrid',
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
const NRT_LIM: RouteGeometry = {
  id: 'NRT-LIM-2026-11-28',
  origin: 'NRT',
  destination: 'LIM',
  from: [140.3864, 35.7647],
  to: [-77.114444, -12.021944],
  fromCity: 'Tokyo',
  toCity: 'Lima',
};

/** Lima to Tokyo goes round the back of the globe from the home view. */
const LIM_TOKYO: RouteGeometry = {
  id: 'LIM-NRT-2026-11-14',
  origin: 'LIM',
  destination: 'NRT',
  from: [-77.114444, -12.021944],
  to: [140.3864, 35.7647],
  fromCity: 'Lima',
  toCity: 'Tokyo',
};

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

function renderMap(overrides: Partial<React.ComponentProps<typeof RouteMap>> = {}) {
  const props = {
    routes: [LIM_CUZ, LIM_MAD],
    selectedId: null,
    onSelect: vi.fn(),
    colours: new Map<string, string>(),
    projection: 'globe' as const,
    onProjectionChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<RouteMap {...props} />), props };
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
    const { container } = renderMap({ routes: [LIM_CUZ], selectedId: LIM_CUZ.id });
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
    const { container } = renderMap({ routes: [LIM_CUZ, LIM_MAD], selectedId: LIM_CUZ.id });

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
      selectedId: LIM_CUZ.id,
    });
    rerender(
      <RouteMap
        routes={[LIM_CUZ, LIM_MAD]}
        selectedId={LIM_MAD.id}
        onSelect={vi.fn()}
        colours={new Map()}
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

  it('picks up the phase the hidden half of an arc carried round the back', () => {
    /*
     * Tokyo to Lima leaves from behind the globe: the stretch before the limb
     * is never drawn, and the run that comes into view begins part-way along
     * its own great circle. Starting its dashes at zero would pin the pattern
     * to the horizon instead of to the geography, so the dashes would slide
     * with the limb as the globe turns rather than staying on the arc. The
     * hidden length is counted, so they stay put.
     */
    const { container } = renderMap({ routes: [NRT_LIM], selectedId: NRT_LIM.id });
    const arcs = [...container.querySelectorAll('[class*="flow"]')] as SVGElement[];
    expect(arcs).toHaveLength(1);
    expect(arcs[0].style.animationDelay).not.toBe(flowDelay(0));
  });

  it('leaves the flat map still, because a solid line cannot show flow', () => {
    // Mercator arcs are solid by decision, so there is nothing to animate and
    // no phase to give them — including the open one, which is the case that
    // would break if the flow were hung on the selection alone.
    const { container } = renderMap({ projection: 'mercator', selectedId: LIM_CUZ.id });
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
      colours: new Map([
        [LIM_CUZ.id, '#d6a65d'],
        [LIM_MAD.id, '#70b9c9'],
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
    const hit = container.querySelector(`[data-route="${LIM_MAD.id}"]`)!;

    // Down on the line, up in the same place. Selection is settled on the way
    // up rather than with a click handler on the path: the stage captures the
    // pointer as soon as a drag starts, and a captured pointer sends its click
    // to the capturing element instead of the path it began on.
    pointer(hit, 'pointerDown', [500, 300]);
    pointer(stage, 'pointerUp', [500, 300]);

    expect(props.onSelect).toHaveBeenCalledWith(LIM_MAD.id);
  });

  it('does not open a route when the press was a drag across it', () => {
    const { props, container } = renderMap();
    const stage = container.querySelector('[class*="stage"]')!;
    const hit = container.querySelector(`[data-route="${LIM_MAD.id}"]`)!;

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
    expect(container.querySelectorAll(`[data-route="${LIM_TOKYO.id}"]`).length).toBe(arcs.length);

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
