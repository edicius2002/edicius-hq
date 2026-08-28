import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Stat } from '@/shared/ui/Stat';
import styles from '@/shared/ui/Stat.module.css';

describe('Stat', () => {
  it('uses compact styling only when requested', () => {
    const { rerender } = render(<Stat label="Gross" value="$100" tone="accent" />);

    expect(screen.getByText('Gross').closest('article')).not.toHaveClass(styles.compact);

    rerender(<Stat label="Gross" value="$100" tone="accent" size="sm" />);

    expect(screen.getByText('Gross').closest('article')).toHaveClass(styles.compact);
  });
});
