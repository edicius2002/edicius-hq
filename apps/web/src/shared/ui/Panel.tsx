import { type HTMLAttributes, type ReactNode } from 'react';

import styles from './Panel.module.css';

type PanelProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  as?: 'section' | 'div' | 'article';
  density?: 'default' | 'compact';
};

export function Panel({
  children,
  className,
  as: Tag = 'section',
  density = 'default',
  ...props
}: PanelProps) {
  const classes = [styles.panel, density === 'compact' ? styles.compact : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={classes} {...props}>
      {children}
    </Tag>
  );
}
