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

  it('reserves a full second control row and metadata row across chart switches', () => {
    expect(rule('AnalysisPanel', '.periodFold')).toMatch(/height:\s*32px/);
    expect(rule('AnalysisPanel', '.periodFold')).toMatch(/visibility:\s*hidden/);
    expect(rule('AnalysisPanel', '.periodOpen')).toMatch(/visibility:\s*visible/);
    expect(rule('AnalysisPanel', '.chartMeta')).toMatch(/min-height:\s*54px/);
    expect(rule('AnalysisPanel', '.body')).toContain('calc(56.24cqw + 60px)');
  });

  it.each([
    ['DepartureChart', '.steps button'],
    ['DepartureChart', '.reset'],
    ['PeriodSwitch', '.switch button'],
    ['RouteList', '.monthTab'],
    ['RouteEditor', '.monthChip'],
    ['RouteEditor', '.form input'],
    ['FlightTable', '.filter select'],
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
    expect(rule('FlightTable', '.filters')).toMatch(/repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('leaves vertical scrolling and page zoom available on the band plot', () => {
    expect(rule('PriceBandChart', '.chart')).toMatch(/touch-action:\s*pan-y pinch-zoom/);
  });

  it('gives band-chart crosshair readouts their own reserved space', () => {
    expect(rule('PriceBandChart', '.readout')).toMatch(/position:\s*static/);
    expect(rule('PriceBandChart', '.readout')).toMatch(/min-height:\s*56px/);
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
  it('reduces the globe toolbar chrome and leaves breathing room around it', () => {
    expect(rule('RouteMap', '.switch button')).toMatch(/min-height:\s*32px/);
    expect(rule('RouteMap', '.switch')).toMatch(/padding:\s*1px/);
    expect(rule('RouteMap', '.toolbar')).toMatch(/padding-block:\s*2px/);
  });
  it('places detail labels beside values and gives long carrier and range values a full row', () => {
    expect(rule('RouteDetail', '.figures > div')).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\) auto/,
    );
    expect(rule('RouteDetail', '.figures > div:nth-last-child(-n + 2)')).toMatch(
      /grid-column:\s*1 \/ -1/,
    );
    expect(rule('RouteDetail', '.figures dt')).toMatch(/margin-bottom:\s*0/);
  });
});
