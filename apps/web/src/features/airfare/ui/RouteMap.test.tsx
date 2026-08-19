import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RouteGeometry } from '@/features/airfare/lib/geo';
import { RouteMap } from '@/features/airfare/ui/RouteMap';

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
      renderMap({ projection });
      const zoomIn = screen.getByRole('button', { name: /zoom in/i });
      for (let press = 0; press < 3; press += 1) await user.click(zoomIn);

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

  it('offers zoom, and refuses to reset a view nobody has moved', () => {
    renderMap();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeEnabled();
    // Zoomed all the way out already, so there is nothing to go back to.
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reset the view/i })).toBeDisabled();
  });

  it('lets the view be reset once it has been zoomed', async () => {
    const user = userEvent.setup();
    renderMap();
    await user.click(screen.getByRole('button', { name: /zoom in/i }));

    expect(screen.getByRole('button', { name: /reset the view/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeEnabled();
  });

  it('does not crash without a canvas context', () => {
    // jsdom's `getContext` returns null. The component has to treat that as
    // "nothing to paint" rather than throwing, or every test on this page
    // would fail on a detail none of them are about.
    expect(() => renderMap()).not.toThrow();
  });
});
