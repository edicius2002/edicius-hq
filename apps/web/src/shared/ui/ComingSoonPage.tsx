import styles from './ComingSoonPage.module.css';

type ComingSoonPageProps = {
  title: string;
};

export function ComingSoonPage({ title }: ComingSoonPageProps) {
  return (
    <section className={styles.page} aria-labelledby="page-title">
      <h1 id="page-title" className={styles.title}>
        {title}
      </h1>
      <p className={styles.copy}>Coming soon.</p>
    </section>
  );
}
