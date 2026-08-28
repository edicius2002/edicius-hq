import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Panel } from '@/shared/ui/Panel';
import styles from '@/shared/ui/Panel.module.css';

describe('Panel', () => {
  it('uses compact density only when requested', () => {
    const { rerender } = render(<Panel>Overview</Panel>);

    expect(screen.getByText('Overview')).not.toHaveClass(styles.compact);

    rerender(<Panel density="compact">Overview</Panel>);

    expect(screen.getByText('Overview')).toHaveClass(styles.compact);
  });
});
