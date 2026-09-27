import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useRetainedData } from './useRetainedData';

it('retains a successful response while a replacement is unavailable', () => {
  const { result, rerender } = renderHook<string | undefined, { value: string | undefined }>(
    ({ value }) => useRetainedData('route-a', value),
    { initialProps: { value: 'March' } },
  );
  rerender({ value: undefined });
  expect(result.current).toBe('March');
  rerender({ value: 'April' });
  expect(result.current).toBe('April');
});

it('never shows a previous resource while a new resource is loading, even on returning', () => {
  const { result, rerender } = renderHook<
    string | undefined,
    { scope: string; value: string | undefined }
  >(({ scope, value }) => useRetainedData(scope, value), {
    initialProps: { scope: 'route-a', value: 'March' },
  });
  rerender({ scope: 'route-b', value: undefined });
  expect(result.current).toBeUndefined();
  rerender({ scope: 'route-a', value: undefined });
  expect(result.current).toBeUndefined();
});

it('accepts a confirmed empty response and does not resurrect the earlier rows', () => {
  const { result, rerender } = renderHook<
    string | null | undefined,
    { value: string | null | undefined }
  >(({ value }) => useRetainedData('route-a', value), { initialProps: { value: 'flights' } });
  rerender({ value: null });
  expect(result.current).toBeNull();
  rerender({ value: undefined });
  expect(result.current).toBeNull();
});
