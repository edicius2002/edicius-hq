import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('is hidden from assistive technology and accepts reusable dimensions', () => {
    const { container } = render(<Skeleton width="70%" height={12} radius={6} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.firstElementChild).toHaveStyle({
      width: '70%',
      height: '12px',
      borderRadius: '6px',
    });
  });

  it('accepts a caller class for layout', () => {
    const { container } = render(<Skeleton className="slot" />);
    expect(container.firstElementChild).toHaveClass('slot');
  });
});
