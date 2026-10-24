import { Skeleton } from './Skeleton';
import styles from './PageSkeleton.module.css';

export type PageSkeletonKind =
  | 'dashboard'
  | 'finance'
  | 'greenlight'
  | 'investing'
  | 'airfare'
  | 'seace'
  | 'sentiment'
  | 'login'
  | 'error';

function Lines({ count = 3 }: { count?: number }) {
  return (
    <div className={styles.lines}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} width={index % 3 === 2 ? '58%' : '90%'} height={12} />
      ))}
    </div>
  );
}

function Card({ className = '', rows = 3 }: { className?: string; rows?: number }) {
  return (
    <div className={`${styles.card} ${className}`}>
      <Skeleton width="42%" height={18} />
      <Lines count={rows} />
    </div>
  );
}

function Header() {
  return (
    <div className={styles.header}>
      <Skeleton width={160} height={28} />
      <Skeleton width={260} height={30} />
    </div>
  );
}

function Table({ rows = 6 }: { rows?: number }) {
  return (
    <div className={styles.card}>
      <div className={styles.tableHeader}>
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} width="72%" height={12} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div className={styles.tableRow} key={row}>
          {[0, 1, 2, 3].map((column) => (
            <Skeleton key={column} width={column === 1 ? '85%' : '65%'} height={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The same page silhouette serves both the route download and first data load. */
export function PageSkeleton({ page }: { page: PageSkeletonKind }) {
  const label = page === 'login' ? 'Loading sign in' : `Loading ${page}`;
  return (
    <section className={`${styles.page} ${styles[page]}`} role="status" aria-label={label}>
      <span className={styles.srOnly}>{label}…</span>
      {page === 'login' ? (
        <Card className={styles.loginCard} rows={2} />
      ) : page === 'error' ? (
        <>
          <Header />
          <Card rows={2} />
        </>
      ) : page === 'dashboard' ? (
        <>
          <div className={styles.clocks}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} width="80%" height={34} />
            ))}
          </div>
          <div className={styles.twoColumns}>
            <Card className={styles.tall} />
            <Card className={styles.tall} />
          </div>
          <Skeleton width={140} height={24} />
          <div className={styles.twoColumns}>
            <Card rows={5} />
            <Card rows={5} />
          </div>
        </>
      ) : page === 'finance' ? (
        <>
          <Header />
          <div className={styles.workspace}>
            <Card className={styles.canvas} rows={4} />
            <div className={styles.stack}>
              <Card rows={4} />
              <Card rows={4} />
            </div>
          </div>
        </>
      ) : page === 'greenlight' ? (
        <>
          <Header />
          <div className={styles.twoColumns}>
            <Card className={styles.chart} />
            <Card className={styles.chart} />
          </div>
          <Card className={styles.chart} />
          <Table rows={5} />
        </>
      ) : page === 'investing' ? (
        <>
          <Skeleton width="100%" height={30} />
          <div className={styles.workspace}>
            <Card className={styles.chart} rows={5} />
            <Table rows={7} />
          </div>
          <div className={styles.twoColumns}>
            <Table rows={4} />
            <Card rows={4} />
          </div>
        </>
      ) : page === 'airfare' ? (
        <>
          <Header />
          <div className={styles.workspace}>
            <Card rows={7} />
            <Card className={styles.chart} rows={5} />
          </div>
          <Table rows={10} />
        </>
      ) : page === 'seace' ? (
        <>
          <Header />
          <div className={styles.filters}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width="100%" height={32} />
            ))}
          </div>
          <Table rows={10} />
        </>
      ) : (
        <>
          <Card className={styles.featured} rows={5} />
          <div className={styles.twoColumns}>
            {Array.from({ length: 7 }, (_, i) => (
              <Card key={i} className={styles.metric} rows={4} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
