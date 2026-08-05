import { type HTMLAttributes, type ReactNode } from 'react';

import styles from './Panel.module.css';

type PanelProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  as?: 'section' | 'div' | 'article';
};

export function Panel({ children, className, as: Tag = 'section', ...props }: PanelProps) {
  const classes = [styles.panel, className].filter(Boolean).join(' ');
  return (
    <Tag className={classes} {...props}>
      {children}
    </Tag>
  );
}
