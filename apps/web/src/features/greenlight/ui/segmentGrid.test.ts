import { describe, expect, it } from 'vitest';

import TOKENS_SOURCE from '@/styles/tokens.css?inline';

import PAGE_SOURCE from './GreenlightPage.module.css?inline';
import CSS_SOURCE from './SegmentSummary.module.css?inline';

const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
const PAGE = PAGE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
const REM_PX = (16 * Number(/--font-size-base:\s*([\d.]+)%/.exec(TOKENS_SOURCE)?.[1])) / 100;

function rule(source: string, name: string): string {
  const found = new RegExp(`\\._${name}_[0-9a-z]+\\s*\\{([^}]*)\\}`).exec(source);
  expect(found, `.${name} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

function partRule(name: string, tag: string): string {
  const found = new RegExp(`\\._${name}_[0-9a-z]+\\s+${tag}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(found, `.${name} ${tag} must have a rule`).not.toBeNull();
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
  return Number(size?.[1]) * REM_PX;
}

describe('Greenlight fee cards', () => {
  it('uses four columns at desktop width and compacts as space decreases', () => {
    expect(columns(rule(CSS, 'list'))).toBe(4);
    expect(columns(rule(media(1465), 'list'))).toBe(3);
    expect(columns(rule(media(1204), 'list'))).toBe(2);
    expect(columns(rule(media(943), 'list'))).toBe(1);
  });

  it('places all three label-value pairs on one horizontal row', () => {
    expect(rule(CSS, 'metrics')).toMatch(/display:\s*flex/);
    expect(rule(CSS, 'metrics')).toMatch(/justify-content:\s*space-between/);
    expect(rule(CSS, 'metric')).toMatch(/display:\s*flex/);
    expect(rule(CSS, 'metric')).toMatch(/white-space:\s*nowrap/);
  });

  it('reserves enough height for the first row of marker segments', () => {
    const cardHeight =
      2 * 6 +
      2 +
      fontSize(rule(CSS, 'range')) * 1.5 +
      5 +
      fontSize(partRule('metric', 'strong')) * 1.5;
    const reserved =
      Number(/min-height:\s*([\d.]+)rem/.exec(rule(PAGE, 'segmentsSlot'))?.[1]) * REM_PX;

    expect(cardHeight).toBeLessThan(60);
    expect(reserved).toBeGreaterThanOrEqual(cardHeight + 20);
    expect(reserved).toBeLessThan(100);
  });
});
