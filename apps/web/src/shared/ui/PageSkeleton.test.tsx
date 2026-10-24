import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageSkeleton } from './PageSkeleton';
import { pageSkeletonForPath } from './pageSkeletonForPath';

describe('PageSkeleton', () => {
  it.each([
    'dashboard',
    'finance',
    'greenlight',
    'investing',
    'airfare',
    'seace',
    'sentiment',
    'login',
    'error',
  ] as const)('shows a shaped, accessible %s loading state', (page) => {
    const { container } = render(<PageSkeleton page={page} />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(2);
    expect(container.querySelector('button, input, a')).toBeNull();
  });
});

it.each([
  ['/dashboard', 'dashboard'],
  ['/finance', 'finance'],
  ['/greenlight', 'greenlight'],
  ['/investing', 'investing'],
  ['/airfare', 'airfare'],
  ['/seace/recent', 'seace'],
  ['/seace/closed', 'seace'],
  ['/sentiment', 'sentiment'],
  ['/missing', 'error'],
] as const)('chooses the %s route silhouette', (path, page) => {
  expect(pageSkeletonForPath(path)).toBe(page);
});
