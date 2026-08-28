import { type ReactNode } from 'react';

import styles from './PageHeader.module.css';

type PageHeaderProps = {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  /**
   * Sits on the title's own line, at its left. For a control that names *which*
   * of something the page is showing — Finance's diagram tabs — as opposed to
   * `actions`, which is what you can do to it.
   */
  beside?: ReactNode;
  titleId?: string;
  /** For a page that needs its header to behave differently — Finance keeps its to one line. */
  className?: string;
};

export function PageHeader({
  title,
  subtitle,
  actions,
  beside,
  titleId = 'page-title',
  className,
}: PageHeaderProps) {
  return (
    <header className={[styles.header, className].filter(Boolean).join(' ')}>
      <div className={styles.text}>
        {title || beside ? (
          <div className={styles.titleRow}>
            {title ? (
              <h1 id={titleId} className={styles.title}>
                {title}
              </h1>
            ) : null}
            {beside}
          </div>
        ) : null}
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
