import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('./*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// jsdom does not lay out CSS. Read actual declarations, excluding prose, and
// keep these contracts alongside the browser measurements in the QA report.
function mobile(file: string): string {
  const css = sources[`./${file}.module.css`].replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: string[] = [];
  for (const match of css.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    const start = end;
    while (depth && end < css.length) {
      if (css[end] === '{') depth++;
      if (css[end] === '}') depth--;
      end++;
    }
    blocks.push(css.slice(start, end - 1));
  }
  return blocks.join('\n');
}
function rule(file: string, selector: string): string {
  const declarations = [...mobile(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').some((s) => s.trim() === selector))
    .map((m) => m[2])
    .join('\n');
  expect(declarations, `${file} ${selector} needs a mobile rule`).not.toBe('');
  return declarations;
}

describe('Airfare mobile layout contracts', () => {
  it('uses route emphasis instead of the native SVG tap rectangle on phones', () => {
    expect(rule('RouteMap', '.stage')).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
    expect(rule('RouteMap', '.stage')).not.toMatch(/outline:\s*(none|0)/);
  });

  it('reclaims only Airfare side gutters, respecting both safe areas', () => {
    const page = rule('AirfarePage', '.page');
    expect(page).toContain('env(safe-area-inset-left');
    expect(page).toContain('env(safe-area-inset-right');
    expect(page).toContain('var(--space-3)');
    expect(rule('AirfarePage', '.page .visualPanel')).toMatch(/padding-inline:\s*0/);
  });

  it('keeps chart metadata at the right edge without reserving an empty row', () => {
    expect(rule('AnalysisPanel', '.chartMeta')).toMatch(/justify-content:\s*end/);
    expect(rule('AnalysisPanel', '.chartMeta')).not.toMatch(/min-height/);
    expect(mobile('AnalysisPanel')).not.toMatch(/44\.99cqw/);
  });

  it.each([
    ['DepartureChart', '.steps button'],
    ['DepartureChart', '.pinButton'],
    ['PeriodSwitch', '.switch button'],
    ['RouteList', '.monthTab'],
    ['RouteEditor', '.monthChip'],
    ['RouteEditor', '.form input'],
    ['FlightTable', '.filter select'],
    ['FlightTable', '.flightLink'],
    ['FlightTable', '.sort'],
    ['FlightTable', '.pager button'],
  ])('%s keeps %s compact but at least 32px tall on phones', (file, selector) => {
    expect(rule(file, selector)).toMatch(/min-height:\s*32px/);
  });

  it('lets the watchlist wrap without collapsing route names or losing months', () => {
    expect(rule('RouteList', '.row')).toMatch(
      /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/,
    );
    expect(rule('RouteList', '.months')).toMatch(/grid-column:\s*2/);
  });

  it('keeps the flight table scroll local and filters within their tracks', () => {
    expect(rule('FlightTable', '.scroller')).toMatch(/overflow-x:\s*auto/);
    expect(rule('FlightTable', '.head')).toMatch(/display:\s*grid/);
    expect(rule('FlightTable', '.filters')).toMatch(/repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('leaves vertical scrolling and page zoom available on the band plot', () => {
    expect(rule('PriceBandChart', '.chart')).toMatch(/touch-action:\s*pan-y pinch-zoom/);
  });

  it('draws band-chart crosshair readouts over the plot without a reserved row', () => {
    expect(rule('PriceBandChart', '.readout')).not.toMatch(/position:\s*static/);
    expect(rule('PriceBandChart', '.readout')).not.toMatch(/min-height/);
  });
  it('keeps airport labels beside their fields and flight filters on compact inline tracks', () => {
    expect(rule('RouteEditor', '.airports > div')).toMatch(
      /grid-template-columns:\s*auto minmax\(0, 1fr\)/,
    );
    expect(rule('FlightTable', '.filter')).toMatch(
      /grid-template-columns:\s*auto minmax\(0, 1fr\)/,
    );
    expect(rule('FlightTable', '.filter input')).toMatch(/font-size:\s*0.6rem/);
    expect(rule('FlightTable', '.filter > span')).toMatch(/font-size:\s*0.6rem/);
  });
  it('keeps the globe projection control inside the map on phones', () => {
    expect(rule('RouteMap', '.switch button')).toMatch(/min-height:\s*32px/);
    expect(rule('RouteMap', '.switch')).toMatch(/padding:\s*1px/);
    expect(rule('RouteMap', '.switch')).toMatch(/top:\s*8px/);
    expect(rule('RouteMap', '.switch')).toMatch(/right:\s*8px/);
  });
  it('reserves one phone detail height and steps its type down', () => {
    expect(rule('RouteDetail', '.detail')).toMatch(/height:\s*405px/);
    expect(rule('RouteDetail', '.price')).toMatch(/font-size:\s*1\.35rem/);
    expect(rule('RouteDetail', '.tile')).toMatch(/min-height:\s*58px/);
  });
});
