import { useEffect, useState } from 'react';
import { useFx } from './useFx';
import { sources, ranges, type Source } from './sources';
import { age, bestQuotes, freshness, price, readPreferences, time } from './model';
import { FxChart } from './FxChart';
import styles from './UsdPenGadget.module.css';
const STORAGE = 'edicius.fx.preferences';
export function UsdPenGadget({ now }: { now: Date }) {
  const [preferences, setPreferences] = useState(() => {
    try {
      return readPreferences(localStorage.getItem(STORAGE));
    } catch {
      return readPreferences(null);
    }
  });
  const [expanded, setExpanded] = useState(false);
  const { latest, history } = useFx(preferences.source, preferences.range);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(preferences));
    } catch {
      /* Storage is optional. */
    }
  }, [preferences]);
  const rows = latest.data ?? [],
    best = bestQuotes(rows, now.getTime());
  const selected = sources.find((source) => source.id === preferences.source)!;
  const ordered = sources.toSorted(
    (a, b) =>
      Number(preferences.favorites.includes(b.id)) - Number(preferences.favorites.includes(a.id)),
  );
  const favorite = (source: Source) =>
    setPreferences((previous) => ({
      ...previous,
      favorites: previous.favorites.includes(source)
        ? previous.favorites.filter((id) => id !== source)
        : [...previous.favorites, source],
    }));
  const priceCell = (value: number, isBest: boolean) => (
    <>
      <span data-best={isBest || undefined}>{price(value)}</span>
      {isBest ? <span className={styles.srOnly}>Best</span> : null}
    </>
  );
  return (
    <section className={styles.card} aria-labelledby="fx-title">
      <header className={styles.header}>
        <h2 id="fx-title">
          USD <span>/</span> PEN
        </h2>
      </header>
      <div className={`${styles.body} ${expanded ? styles.expanded : ''}`}>
        <div className={styles.tableArea}>
          {latest.isPending ? <p role="status">Loading quotes…</p> : null}
          {latest.isError ? (
            <p role="alert">
              {latest.data
                ? 'Could not refresh quotes. Showing saved captures.'
                : 'Could not load quotes.'}
            </p>
          ) : null}
          <table className={styles.table} aria-label="USD/PEN source quotes">
            <thead>
              <tr>
                <th>Source</th>
                <th title="The source buys your dollars">Buy</th>
                <th title="The source sells you dollars">Sell</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((source) => {
                const row = rows.find((item) => item.source === source.id),
                  status = row ? freshness(row, now.getTime()) : undefined,
                  eligible = Boolean(row && !source.reference && status === 'Fresh');
                return (
                  <tr key={source.id} data-selected={source.id === preferences.source}>
                    <td>
                      <div className={styles.source}>
                        <button
                          className={styles.star}
                          aria-label={`${preferences.favorites.includes(source.id) ? 'Unfavorite' : 'Favorite'} ${source.name}`}
                          aria-pressed={preferences.favorites.includes(source.id)}
                          onClick={() => favorite(source.id)}
                        >
                          {preferences.favorites.includes(source.id) ? '★' : '☆'}
                        </button>
                        <button
                          className={styles.select}
                          aria-label={`Select ${source.name}`}
                          aria-pressed={source.id === preferences.source}
                          onClick={() =>
                            setPreferences((previous) => ({ ...previous, source: source.id }))
                          }
                        >
                          {source.name}
                        </button>
                      </div>
                    </td>
                    <td className={styles.buy}>
                      {row ? priceCell(row.buy, eligible && row.buy === best.buy) : '—'}
                    </td>
                    <td className={styles.sell}>
                      {row ? priceCell(row.sell, eligible && row.sell === best.sell) : '—'}
                    </td>
                    <td className={styles.status}>
                      {row ? (
                        status === 'Stale' ? (
                          <span className={styles.stale} title={time(row.observed_at)}>
                            Stale
                          </span>
                        ) : (
                          <time title={time(row.observed_at)} dateTime={row.observed_at}>
                            {age(row.observed_at, now.getTime())}
                          </time>
                        )
                      ) : latest.isError ? (
                        'Unavailable'
                      ) : latest.isPending ? (
                        '…'
                      ) : (
                        'No capture'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className={styles.history}>
          <div className={styles.chartHeader}>
            <h3>
              <a href={selected.url} target="_blank" rel="noreferrer">
                {selected.name} ↗
              </a>
            </h3>
            <nav className={styles.ranges} aria-label="History range">
              {ranges.map((range) => (
                <button
                  key={range}
                  aria-pressed={preferences.range === range}
                  onClick={() => setPreferences((previous) => ({ ...previous, range }))}
                >
                  {range === 'ALL' ? 'All' : range}
                </button>
              ))}
            </nav>
            <button
              className={styles.expand}
              aria-label={expanded ? 'Collapse chart' : 'Expand chart'}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '↙' : '↗'}
            </button>
          </div>
          {history.isPending ? (
            <div className={styles.placeholder} role="status">
              Loading history…
            </div>
          ) : null}
          {history.isError ? (
            <p role="alert">
              {history.data
                ? 'Could not refresh history. Showing saved captures.'
                : 'Could not load history.'}{' '}
              <button onClick={() => void history.refetch()}>Retry history</button>
            </p>
          ) : null}
          {history.data ? (
            <FxChart
              key={`${selected.id}:${preferences.range}`}
              history={history.data}
              expanded={expanded}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
