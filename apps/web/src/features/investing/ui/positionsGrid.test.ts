import { describe, expect, it } from 'vitest';

import TOKENS_SOURCE from '@/styles/tokens.css?inline';

import CSS_SOURCE from './Positions.module.css?inline';

/* jsdom cannot measure the grid, so check the card floor against its text. */
const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS = TOKENS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
const REM_PX = (16 * Number(/--font-size-base:\s*([\d.]+)%/.exec(TOKENS)?.[1])) / 100;

function rule(...locals: string[]): string {
  const selector = locals.map((local) => `\\._${local}_[0-9a-z]+`).join(',\\s*');
  const found = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(found, `.${locals.join(', .')} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

function token(name: string): number {
  const value = new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(TOKENS);
  expect(value, `--${name} must be a rem token`).not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

function fontSize(body: string): number {
  const value = /font-size:\s*([\d.]+)rem/.exec(body);
  expect(value, 'the rule must set a font size in rem').not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

const CARD_PX = (() => {
  const columns = /grid-template-columns:([^;]*);/.exec(rule('list'))?.[1] ?? '';
  const floor = /minmax\(\s*min\(\s*([\d.]+)rem\s*,\s*100%\s*\)/.exec(columns);
  expect(floor, 'the cards need a width that can shrink on narrow screens').not.toBeNull();
  return Number(floor?.[1]) * REM_PX;
})();

describe('the three-line position cards', () => {
  it('fits a value and percentage beside each other with room for padding', () => {
    const value = '1,234,567.89'.length * fontSize(rule('value')) * 0.6;
    const percent = '+123.45%'.length * fontSize(rule('up', 'down')) * 0.6;
    const gap = Number(/gap:\s*([\d.]+)rem/.exec(rule('valuation'))?.[1]) * REM_PX;
    const padding = 2 * token(/padding:\s*var\(--(space-\d)\)/.exec(rule('pick'))?.[1] ?? '');

    expect(CARD_PX).toBeGreaterThan(value + percent + gap + padding + 2);
    expect(rule('pick')).toMatch(/text-align:\s*center/);
    expect(rule('valuation')).toMatch(/justify-content:\s*center/);
  });

  it('fits four cards across the measured page and reduces the count as space shrinks', () => {
    const gap = token(/gap:\s*var\(--(space-\d)\)/.exec(rule('list'))?.[1] ?? '');
    const columnsAt = (width: number) =>
      Math.floor((width - 2 * token('space-2') + gap) / (CARD_PX + gap));

    expect(columnsAt(1141)).toBe(4);
    expect(columnsAt(900)).toBe(3);
    expect(columnsAt(700)).toBe(2);
    expect(columnsAt(300)).toBe(1);
    expect(rule('list')).toMatch(/auto-fill/);
  });
});
