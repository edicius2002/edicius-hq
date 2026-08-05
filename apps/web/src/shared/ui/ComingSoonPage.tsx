import { PageHeader } from '@/shared/ui/PageHeader';

import styles from './ComingSoonPage.module.css';

type ComingSoonPageProps = {
  title: string;
};

export function ComingSoonPage({ title }: ComingSoonPageProps) {
  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader title={title} subtitle="Coming soon." titleId="page-title" />
    </section>
  );
}
