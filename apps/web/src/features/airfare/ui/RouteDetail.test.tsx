import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RouteDetail } from '@/features/airfare/ui/RouteDetail';
import type { FareInsights, FareSnapshot, WatchHealth } from '@/shared/api/fares';
import TOKENS_SOURCE from '@/styles/tokens.css?inline';

import CSS_SOURCE from './RouteDetail.module.css?inline';

/**
 * The panel that answers "what is this route, and should I care today".
 *
 * Two things it has to keep getting right: the header says which route and
 * when in as few words as possible, and the five figures follow the reader's
 * decision order. This suite pins their words and order; fit is measured in
 * the browser and explained beside the stylesheet rules.
 */

const ROUTE = {
  origin: 'LIM',
  destination: 'AQP',
  months: ['2026-12'],
  currency: 'USD',
};

const SNAPSHOT: FareSnapshot = {
  capturedAt: '2026-08-19T03:45:00',
  source: 'google-flights',
  origin: 'LIM',
  destination: 'AQP',
  flightDate: '2026-12-06',
  returnDate: null,
  currency: 'USD',
  offers: [
    {
      airline: 'JA',
      airlineName: 'JetSMART',
      flightNumber: '7015',
      departureAt: '2026-12-06T08:55',
      arrivalAt: '2026-12-06T10:25',
      transfers: 0,
      durationMinutes: 90,
      price: 63.36,
      currency: 'USD',
    },
    {
      airline: 'LA',
      airlineName: 'LATAM',
      flightNumber: '2011',
      departureAt: '2026-12-06T14:10',
      arrivalAt: '2026-12-06T15:40',
      transfers: 0,
      durationMinutes: 90,
      price: 104.64,
      currency: 'USD',
    },
  ],
} as FareSnapshot;

const INSIGHTS: FareInsights = { typical: 80, usualLow: 55, usualHigh: 130 };
const HEALTH: WatchHealth = {
  checks: 1,
  changes: 1,
  errors: 0,
  // The API sends this with an offset, and the naive form this fixture used to
  // carry is what hid the defect: 03:45 UTC is 22:45 the *previous* day in Lima.
  lastCheckedAt: '2026-08-19T03:45:00+00:00',
};

function renderDetail(overrides: Partial<React.ComponentProps<typeof RouteDetail>> = {}) {
  return render(
    <RouteDetail
      route={ROUTE}
      month={ROUTE.months[0]}
      latest={SNAPSHOT}
      insights={INSIGHTS}
      health={HEALTH}
      cities={{ from: 'Lima', to: 'Arequipa' }}
      {...overrides}
    />,
  );
}

describe('RouteDetail', () => {
  it('puts the departure month beside the pair, with no word in between', () => {
    // "Departs" was doing no work: a route has one month, and it is written
    // next to the two airports it belongs to. Named rather than numbered —
    // 12.114 — so nothing in this heading reads as a day that is not one.
    renderDetail();
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.textContent?.replace(/\s+/g, ' ')).toBe('LIM → AQP December 2026');
    expect(heading.textContent).not.toMatch(/departs/i);
  });

  it('keeps a space between the code and the month for a screen reader', () => {
    // The gap beside it is a margin, and a margin is not something a screen
    // reader can hear.
    const heading = renderDetail().container.querySelector('h3')!;
    expect(heading.textContent).toContain('AQP December 2026');
  });

  it('names the cities under the pair, and when it was last looked at', () => {
    renderDetail();
    expect(screen.getByText('Lima to Arequipa')).toBeInTheDocument();
    expect(screen.getByText(/Last look 18\/08\/2026 22:45/)).toBeInTheDocument();
  });

  it('offers no way out of the month, because there is nothing to be let out of', () => {
    /*
     * "Read the whole month" stood in this header and existed for one reason:
     * to clear a focus — 12.182. A watch names no departure now (12.260), so
     * the whole month is the only thing this panel ever reads and a control
     * offering to go back to it would be offering the state the reader is
     * already in.
     *
     * "That day has departed" went with it — 12.133 was about a focused day
     * whose figures had frozen, and a month that has been and gone is said in
     * the watchlist row instead, where it always was.
     */
    renderDetail();
    expect(screen.queryByRole('button', { name: /read the whole month/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/has departed/i)).not.toBeInTheDocument();
  });

  it('says nothing about a last look when nothing has looked yet', () => {
    renderDetail({ health: null });
    expect(screen.queryByText(/last look/i)).not.toBeInTheDocument();
  });

  it('shows five figures in reading order, with the usual range on its own row', () => {
    /*
     * The price and context lead; the chosen departure follows, and the
     * baseline range has a whole row. The board date, collector counts and
     * discarded offer counts do not compete with that decision.
     */
    const { container } = renderDetail();
    const boxes = container.querySelectorAll('dl');
    // One definition list keeps each label attached to its value.
    expect(boxes).toHaveLength(1);
    const figures = boxes[0] as HTMLElement;
    expect(Array.from(figures.querySelectorAll('dt'), (dt) => dt.textContent)).toEqual([
      'Cheapest now',
      'Usually',
      'Cheapest on',
      'Vs usual',
      'Usual range',
    ]);
    for (const gone of [
      'Dearest on board',
      'Itineraries',
      'Airlines',
      'Board date',
      'Looks taken',
      'Changes',
      'Failed',
    ]) {
      expect(within(figures).queryByText(gone)).not.toBeInTheDocument();
    }
    // The last look stays in the compact header, even before a board exists.
    expect(within(figures).queryByText('Last look')).not.toBeInTheDocument();
  });

  it('writes the carrier and its departure out in full, however long the name', () => {
    /*
     * `Aerolineas Argentinas · 14:35` used to be drawn on top of the figure
     * beside it — see `a-figure-takes-what-it-holds`. The repair is a value
     * that folds, and the thing a repair like that is tempted into is cutting
     * the name short instead, which tells the reader less than it looks like
     * it does.
     *
     * jsdom lays nothing out, so this cannot see an overlap; what it can see
     * is that the whole string is in the document and that nothing has put an
     * ellipsis in it. The overlap itself was measured in a browser, over
     * thirteen viewport widths and eight strip widths, and the arithmetic is
     * in the stylesheet.
     */
    const longName = 'Aerolineas Argentinas Sociedad Anonima';
    const offers = [{ ...SNAPSHOT.offers[0], airlineName: longName }];
    renderDetail({ latest: { ...SNAPSHOT, offers } });

    const value = screen.getByText('Cheapest on').parentElement!.querySelector('dd')!;
    expect(value.textContent).toBe(`${longName} · 08:55`);
    expect(value.textContent).not.toContain('…');
    // The separator and the clock are one unbreakable run, so a fold can never
    // leave the dot at the end of a line with its time on the next.
    expect(value.querySelector('span')?.textContent).toBe('· 08:55');
  });

  it('asks for a collection rather than showing empty figures', () => {
    renderDetail({ latest: null, insights: null });
    expect(screen.getByText(/nothing observed yet/i)).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll('dl dt'), (dt) => dt.textContent)).toEqual([
      'Cheapest now',
      'Usually',
      'Vs usual',
    ]);
  });

  it('says what to do when no route is open at all', () => {
    renderDetail({ route: null });
    expect(screen.getByText(/add a route to start building/i)).toBeInTheDocument();
  });

  it('does not call a route uncollected while its archive is still being fetched', () => {
    /*
     * `a-fetch-is-not-an-empty-archive`. Every figure in this panel is derived
     * from one query's `data`, and react-query holds none for a key it has not
     * answered — so opening a second route emptied the whole strip and printed
     * "Nothing observed yet. Run a collection pass." about a route the reader
     * had already collected, until the response landed.
     *
     * Measured before the fix by driving the real `useFareHistory` through a
     * route change against a fetch held open: three renders, the middle one
     * carrying the new pair's heading over four `—` and that sentence.
     */
    renderDetail({ latest: null, insights: null, health: null, loading: true });

    expect(screen.queryByText(/nothing observed yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/reading the archive/i)).toBeInTheDocument();
    // Still the route it was asked about, so the heading is not empty either.
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('LIM');
  });

  it('still asks for a collection once the fetch is done and there is nothing', () => {
    // The sentence is not withdrawn, only moved off the case it was wrong
    // about: a settled query with no observations is exactly what it is for.
    renderDetail({ latest: null, insights: null, health: null, loading: false });
    expect(screen.getByText(/nothing observed yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/reading the archive/i)).not.toBeInTheDocument();
  });

  it('keeps waiting and settled notes in the same reserved detail box', () => {
    /*
     * Both sentences occupy the same position in `.detail`. The panel's
     * height is reserved by the map on desktop and by `.detail` on phones;
     * changing which sentence is shown cannot change the box's geometry.
     * The last `<p>` is that sentence; the earlier ones are the header's.
     */
    const noteOf = (loading: boolean) => {
      const paragraphs = renderDetail({
        latest: null,
        insights: null,
        health: null,
        loading,
      }).container.querySelectorAll('p');
      return paragraphs[paragraphs.length - 1];
    };

    const waiting = noteOf(true);
    const settled = noteOf(false);
    expect(waiting.textContent).toMatch(/reading the archive/i);
    expect(settled.textContent).toMatch(/nothing observed yet/i);
    // Both states use the same note treatment inside the reserved detail.
    expect(waiting.className.split(/\s+/)).toHaveLength(2);
    expect(waiting.className).toBe(settled.className);
  });
});

/**
 * What the strip is, whichever route is open and however far its archive has
 * got — `a-strip-that-holds-its-height`.
 *
 * jsdom lays nothing out, so every test above passes whether the box holds its
 * shape or collapses to a single line the moment a figure goes missing. The
 * heights are read out of the compiled stylesheet instead and checked against
 * the rules they were derived from, which is what `workspaceBreakpoint.test`
 * and `routesScroll.test` do for the same reason.
 *
 * Class names come through as `_local_hash`, so it is the local name that
 * identifies a rule and a rename fails loudly rather than matching nothing.
 */

/** Comments come out first: this stylesheet quotes the very lengths matched for. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const CSS = withoutComments(CSS_SOURCE);
const TOKENS = withoutComments(TOKENS_SOURCE);

/** What one rem is worth here, taken from the token rather than assumed. */
const REM_PX = (() => {
  const percent = /--font-size-base:\s*([\d.]+)%/.exec(TOKENS);
  expect(percent, 'tokens.css must state a base font size').not.toBeNull();
  return (16 * Number(percent?.[1])) / 100;
})();

/** The line box `reset.css` gives every one of these rules. */
const LINE_HEIGHT = 1.5;

/** The body of a rule, found by the local class name the source declares. */
function rule(local: string): string {
  const found = new RegExp(`\\._${local}_[0-9a-z]+\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(found, `.${local} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

/** A rule's declared font size, in px. */
function fontSize(local: string): number {
  const found = /font-size:\s*([\d.]+)rem/.exec(rule(local));
  expect(found, `.${local} must declare a rem font size`).not.toBeNull();
  return Number(found?.[1]) * REM_PX;
}

/**
 * A `min-height: calc(...)` resolved to px.
 *
 * Every term is a plain `rem` or `px` length added together, deliberately — a
 * reserved height is arithmetic and it should be legible as arithmetic in the
 * file rather than collapsed into one number nobody can check.
 */
function reserved(local: string): number {
  const found = /min-height:\s*calc\(([^)]*)\)/.exec(rule(local));
  expect(found, `.${local} must reserve a height`).not.toBeNull();
  let total = 0;
  for (const term of (found?.[1] ?? '').split('+')) {
    const length = /^\s*([\d.]+)(rem|px)\s*$/.exec(term);
    expect(length, `every term of .${local}'s reserve must be a rem or px length`).not.toBeNull();
    total += Number(length?.[1]) * (length?.[2] === 'rem' ? REM_PX : 1);
  }
  return total;
}

describe('the vertical flight detail column', () => {
  it('places route identity, figures and note in one readable flow', () => {
    expect(rule('detail')).toMatch(/display:\s*flex/);
    expect(rule('detail')).toMatch(/flex-direction:\s*column/);
    expect(rule('detail')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('gives paired figures two shrinking columns and the range a full row', () => {
    const figures = rule('figures');
    expect(figures).toMatch(/display:\s*grid/);
    expect(figures).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(figures).toMatch(/align-content:\s*start/);
    expect(figures).not.toMatch(/height:\s*\d/);
    expect(rule('range')).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it('lets a carrier name fold inside its figure instead of touching its neighbor', () => {
    const value = new RegExp(`\\._figures_[0-9a-z]+ dd\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    expect(value).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('clock')).toMatch(/white-space:\s*nowrap/);
  });

  it('keeps the optional last look from moving the figures', () => {
    const gap = Number(/gap:\s*(\d+)px/.exec(rule('head'))?.[1] ?? NaN);
    const lines = fontSize('pair') * LINE_HEIGHT + 2 * fontSize('cities') * LINE_HEIGHT + 2 * gap;
    expect(reserved('head')).toBeCloseTo(lines, 5);
  });

  it('makes the stacked phone detail shorter by dropping its header reserve', () => {
    const phone = CSS.slice(CSS.indexOf('@media (max-width: 640px)'));
    expect(phone).toMatch(/min-height:\s*0/);
    expect(phone).toMatch(/min-height:\s*143px/);
    expect(phone).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  });
});
