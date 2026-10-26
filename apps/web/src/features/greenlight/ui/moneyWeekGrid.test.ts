import { describe, expect, it } from 'vitest';

import CSS_SOURCE from './MoneyWeekChart.module.css?inline';

const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(source: string, name: string): string {
  const found = new RegExp(`\\._${name}_[0-9a-z]+\\s*\\{([^}]*)\\}`).exec(source);
  expect(found, `.${name} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

function media(maxWidth: number): string {
  const head = new RegExp(`@media\\s*\\(max-width:\\s*${maxWidth}px\\)\\s*\\{`).exec(CSS);
  expect(head, `the ${maxWidth}px media query must exist`).not.toBeNull();
  let scan = (head?.index ?? 0) + (head?.[0].length ?? 0);
  const start = scan;
  let level = 1;
  while (scan < CSS.length && level > 0) {
    if (CSS[scan] === '{') level += 1;
    if (CSS[scan] === '}') level -= 1;
    scan += 1;
  }
  return CSS.slice(start, scan - 1);
}

function columns(body: string): number {
  const tracks = /grid-template-columns:\s*repeat\((\d+),/.exec(body);
  return tracks ? Number(tracks[1]) : 1;
}

function fontSize(body: string): number {
  const size = /font-size:\s*([\d.]+)rem/.exec(body);
  expect(size, 'the rule must define its font size').not.toBeNull();
  return Number(size?.[1]);
}

describe('Greenlight week layout', () => {
  it('places three months per wide row and four weeks within each month', () => {
    expect(columns(rule(CSS, 'list'))).toBe(3);
    expect(columns(rule(CSS, 'weeks'))).toBe(4);
    expect(columns(rule(media(1480), 'list'))).toBe(2);
    expect(columns(rule(media(1100), 'list'))).toBe(1);
    expect(columns(rule(media(600), 'weeks'))).toBe(2);
    expect(columns(rule(media(400), 'weeks'))).toBe(1);
  });

  it('places subscription controls between the month and its amount', () => {
    expect(rule(CSS, 'monthTitle')).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
    expect(rule(CSS, 'toolChips')).toMatch(/grid-column:\s*2/);
    expect(rule(CSS, 'toolChips')).toMatch(/grid-row:\s*1/);
    expect(rule(CSS, 'toolChips')).toMatch(/justify-content:\s*center/);
  });

  it('makes the centered month percentage larger than the amount', () => {
    expect(fontSize(rule(CSS, 'weekPctValue'))).toBeGreaterThan(fontSize(rule(CSS, 'weekValue')));
    expect(rule(CSS, 'weekPct')).toMatch(/align-items:\s*center/);
    expect(rule(CSS, 'weekCard')).toMatch(/grid-template-rows:\s*auto auto auto/);
    expect(rule(CSS, 'weekCard')).toMatch(/align-content:\s*center/);
    expect(rule(CSS, 'weekCard')).toMatch(/min-height:\s*3\.4rem/);
    expect(CSS).not.toMatch(/\.barTrack|\.barFill/);
  });

  it('reserves the same marker gutter for every week', () => {
    expect(rule(CSS, 'weekCluster')).toMatch(/padding-inline-end:\s*0\.5rem/);
    expect(rule(CSS, 'markerSlot')).toMatch(/width:\s*0\.5rem/);
  });
});
