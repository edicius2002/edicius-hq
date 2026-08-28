import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';
import { Stat } from '@/shared/ui/Stat';

import styles from './DashboardPage.module.css';

export function DashboardPage() {
  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader
        actions={
          <Button variant="primary" disabled>
            Open hub
          </Button>
        }
      />
      <Panel>
        <div className={styles.stats}>
          <Stat label="Shell" value="Ready" tone="accent" />
          <Stat label="Data plane" value="Local KV" tone="income" />
          <Stat label="Features" value="Queued" />
        </div>
      </Panel>
    </section>
  );
}
