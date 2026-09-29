import { useEffect, useState } from 'react';
import { useFx } from './useFx';
import { sources, ranges, isReference, type Source } from './sources';
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
  const [category, setCategory] = useState<'All' | 'Online' | 'References'>('All');
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
  const selectedRow = rows.find((row) => row.source === selected.id);
  const visible = sources
    .filter((source) => category === 'All' || source.reference === (category === 'References'))
    .toSorted(
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
  return (
    <section className={styles.card} aria-labelledby="fx-title">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>CURRENCY WATCH</span>
          <h2 id="fx-title">
            USD <span>/</span> PEN <small>US dollar → Peruvian sol</small>
          </h2>
        </div>
        <button
          className={styles.refresh}
          onClick={() => {
            void latest.refetch();
            void history.refetch();
          }}
          disabled={latest.isFetching || history.isFetching}
        >
          {latest.isFetching || history.isFetching ? 'Updating…' : '↻ Refresh'}
        </button>
      </header>
      <div className={styles.description}>
        <span>
          <b>Buy</b> · source buys your USD
        </span>
        <span>
          <b>Sell</b> · source sells you USD
        </span>
        <small>PEN per US$1</small>
      </div>
      <div className={`${styles.body} ${expanded ? styles.expanded : ''}`}>
        <div className={styles.tableArea}>
          <nav className={styles.filters} aria-label="Source category">
            {(['All', 'Online', 'References'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
              >
                {value}
              </button>
            ))}
          </nav>
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
                <th>Buy</th>
                <th>Sell</th>
                <th>Capture</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((source) => {
                const row = rows.find((item) => item.source === source.id),
                  status = row ? freshness(row, now.getTime()) : undefined,
                  eligible = row && !source.reference && status === 'Fresh';
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
                      {row ? (
                        <>
                          <span>{price(row.buy)}</span>
                          {eligible && row.buy === best.buy ? (
                            <small className={styles.best}>Best</small>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={styles.sell}>
                      {row ? (
                        <>
                          <span>{price(row.sell)}</span>
                          {eligible && row.sell === best.sell ? (
                            <small className={styles.best}>Best</small>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={styles.status}>
                      {row ? (
                        <>
                          <time title={time(row.observed_at)} dateTime={row.observed_at}>
                            {age(row.observed_at, now.getTime())}
                          </time>
                          {status === 'Stale' ? (
                            <small className={styles.stale}>Stale</small>
                          ) : (
                            <small>{source.reference ? 'Reference' : 'Fresh'}</small>
                          )}
                        </>
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
          <p className={styles.footnote}>Best = fresh online quotes only · stale after 45 min</p>
        </div>
        <div className={styles.history}>
          <div className={styles.chartHeader}>
            <div>
              <span className={styles.eyebrow}>SOURCE HISTORY</span>
              <h3>
                <a href={selected.url} target="_blank" rel="noreferrer">
                  {selected.name} ↗
                </a>
              </h3>
            </div>
            <button
              aria-label={expanded ? 'Collapse chart' : 'Expand chart'}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '↙' : '↗'}
            </button>
          </div>
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
          {selectedRow ? (
            <p className={styles.footnote}>
              Captured {time(selectedRow.observed_at)}
              {isReference(selected.id) ? (
                <>
                  <br />
                  Effective {time(selectedRow.effective_at)} · daily reference
                </>
              ) : null}
            </p>
          ) : null}
          {selected.id === 'rextie' ? (
            <p className={styles.footnote}>Standard quote for US$1,000.</p>
          ) : null}
          {selected.reference ? (
            <p className={styles.footnote}>
              Source: BCRP statistical series
              {selected.id === 'sbs' ? ' · SBS daily rates published through BCRP' : ''}. Stale
              after 12h without capture or 7 days without an effective rate.
            </p>
          ) : null}
        </div>
      </div>
      <footer className={styles.footer}>
        Commercial history starts with the first capture. Official references can include earlier
        dates.
      </footer>
    </section>
  );
}
