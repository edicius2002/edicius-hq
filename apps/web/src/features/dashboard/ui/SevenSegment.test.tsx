import { render } from '@testing-library/react';
import { expect, it } from 'vitest';

import { SevenSegment } from './SevenSegment';

it.each([
  ['0', 'abcdef'],
  ['1', 'bc'],
  ['2', 'abdeg'],
  ['3', 'abcdg'],
  ['4', 'bcfg'],
  ['5', 'acdfg'],
  ['6', 'acdefg'],
  ['7', 'abc'],
  ['8', 'abcdefg'],
  ['9', 'abcdfg'],
])('lights only the correct segments for %s', (digit, litSegments) => {
  const { container } = render(<SevenSegment digit={digit} />);
  const svg = container.querySelector('svg');
  const segments = [...container.querySelectorAll('[data-segment]')];

  expect(svg).toHaveAttribute('aria-hidden', 'true');
  expect(segments).toHaveLength(7);
  expect(segments.map((segment) => segment.getAttribute('data-segment')).join('')).toBe('abcdefg');
  expect(
    segments
      .filter((segment) => segment.getAttribute('data-lit') === 'true')
      .map((segment) => segment.getAttribute('data-segment'))
      .join(''),
  ).toBe(litSegments);
  expect(segments.filter((segment) => segment.getAttribute('data-lit') === 'false')).toHaveLength(
    7 - litSegments.length,
  );
});
