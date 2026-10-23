import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import {
  enqueueRefresh,
  exclusionKey,
  loadExclusions,
  loadSeace,
  loadSeaceSync,
  refreshStatus,
  setExcluded,
  type SeaceRow,
  type SeaceSync,
} from './data';
import styles from './SeacePage.module.css';

const regions = [
  'Amazonas',
  'Áncash',
  'Apurímac',
  'Arequipa',
  'Ayacucho',
  'Cajamarca',
  'Callao',
  'Cusco',
  'Huancavelica',
  'Huánuco',
  'Ica',
  'Junín',
  'La Libertad',
  'Lambayeque',
  'Lima',
  'Loreto',
  'Madre de Dios',
  'Moquegua',
  'Pasco',
  'Piura',
  'Puno',
  'San Martín',
  'Tacna',
  'Tumbes',
  'Ucayali',
];
const views = [
  { path: '/seace/recent', label: 'Last 24h' },
  { path: '/seace/all-open', label: 'All open' },
  { path: '/seace/closed', label: 'Closed notices' },
  { path: '/seace/published', label: 'Published contracts' },
];
const pageSizes = [5, 10, 20, 50, 100];
const text = (row: SeaceRow, field: string) => {
  const value = row.payload[field];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};
const dateStamp = (value: string, endOfDay = false): number | null => {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [
    ,
    day,
    month,
    year,
    hour = endOfDay ? '23' : '00',
    minute = endOfDay ? '59' : '00',
    second = endOfDay ? '59' : '00',
  ] = match;
  const result = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}-05:00`);
  return Number.isNaN(result) ? null : result;
};
const isOpen = (row: SeaceRow) => {
  if (row.kind === 'contracts') return false;
  if (row.kind === 'notices')
    return text(row, 'state') === 'Vigente' && (dateStamp(text(row, 'end')) ?? 0) > Date.now();
  if (/adjudicad|desiert|cancelad|anulad|contratad|finalizad/i.test(text(row, 'state')))
    return false;
  const end = dateStamp(text(row, 'end'), true);
  const registration = dateStamp(text(row, 'registrationEnd'), true);
  return (
    Math.min(end ?? Infinity, registration ?? Infinity) > Date.now() &&
    (end !== null || registration !== null)
  );
};
const isRecent = (row: SeaceRow) => {
  const published = dateStamp(text(row, 'published'));
  return published !== null && published <= Date.now() && published >= Date.now() - 86_400_000;
};
const safeUrl = (candidate: unknown): string | null => {
  if (typeof candidate !== 'string') return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' &&
      (url.hostname === 'seace.gob.pe' || url.hostname.endsWith('.seace.gob.pe'))
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const codeUrl = (row: SeaceRow) =>
  row.kind === 'notices' && /^\d+$/.test(text(row, 'id'))
    ? `https://prod6.seace.gob.pe/cotizacion/contrataciones/contratacion-detalle/${text(row, 'id')}`
    : safeUrl(row.payload.source);
const plainDate = (value: string) => {
  if (!value) return '—';
  const [day, ...time] = value.split(' ');
  return (
    <span className={styles.date}>
      <span>{day}</span>
      {time.length > 0 && <small>{time.join(' ')}</small>}
    </span>
  );
};
const money = (row: SeaceRow) => {
  const raw = text(row, 'amount');
  const amount = raw.match(/\d[\d,.]*/)?.[0];
  if (!amount) return '—';
  const currency = `${text(row, 'currency')} ${raw}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const symbol = /sol|s\s*\/\s*\.?/.test(currency)
    ? 'S/'
    : /dolar|usd|us\$/.test(currency)
      ? 'US$'
      : '';
  return `${symbol ? `${symbol} ` : ''}${amount}`;
};
const itemText = (row: SeaceRow) => {
  const items = row.payload.items;
  if (!Array.isArray(items) || !items.length) return '—';
  return items.map(String).join(items.length === 1 ? '' : '; ');
};
const links = (row: SeaceRow) => {
  const result: { name: string; url: string }[] = [];
  const source = row.kind === 'notices' ? codeUrl(row) : safeUrl(row.payload.source);
  if (source) result.push({ name: 'Official record', url: source });
  const primary = safeUrl(row.payload.documentUrl);
  if (primary) result.push({ name: text(row, 'documentName') || 'PDF', url: primary });
  if (Array.isArray(row.payload.documents)) {
    for (const item of row.payload.documents) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const doc = item as Record<string, unknown>;
        const url = safeUrl(doc.url);
        if (url && !result.some((link) => link.url === url)) {
          result.push({ name: typeof doc.name === 'string' ? doc.name : 'Document', url });
        }
      }
    }
  }
  return result;
};

export function SeacePage() {
  const location = useLocation();
  const view = location.pathname.endsWith('/published')
    ? 'published'
    : location.pathname.endsWith('/closed')
      ? 'closed'
      : location.pathname.endsWith('/all-open')
        ? 'open'
        : 'recent';
  const year = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Lima',
      year: 'numeric',
    }).format(new Date()),
  );
  const [region, setRegion] = useState('Arequipa');
  const [minorOnly, setMinorOnly] = useState(true);
  const [records, setRecords] = useState<SeaceRow[]>([]);
  const [sync, setSync] = useState<SeaceSync[]>([]);
  const [exclusions, setExclusions] = useState<Set<string>>(new Set());
  const [excludedView, setExcludedView] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ field: string; ascending: boolean }>({
    field: 'published',
    ascending: false,
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, states, excluded] = await Promise.all([
        loadSeace(region, year),
        loadSeaceSync(region, year),
        loadExclusions(),
      ]);
      setRecords(rows);
      setSync(states);
      setExclusions(excluded);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'SEACE data unavailable');
    } finally {
      setLoading(false);
    }
  }, [region, year]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);
  useEffect(() => {
    if (!pendingId) return;
    const timer = window.setInterval(() => {
      void refreshStatus(pendingId)
        .then((status) => {
          if (status === 'complete') {
            setPendingId(null);
            void reload();
          } else if (status === 'failed' || status === 'expired') {
            setPendingId(null);
            setMessage(`Refresh ${status}`);
          }
        })
        .catch(() => setMessage('Refresh status unavailable'));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [pendingId, reload]);

  const rows = useMemo(
    () =>
      records
        .filter((row) => {
          if (view === 'published' ? row.kind !== 'contracts' : row.kind === 'contracts')
            return false;
          if (minorOnly && !row.payload.minor) return false;
          if (view === 'recent' && (!isOpen(row) || !isRecent(row))) return false;
          if (view === 'open' && (!isOpen(row) || isRecent(row))) return false;
          if (view === 'closed' && isOpen(row)) return false;
          if (exclusions.has(exclusionKey(row)) !== excludedView) return false;
          if (
            search &&
            !['code', 'entity', 'description', 'contractor', 'object'].some((field) =>
              text(row, field).toLowerCase().includes(search.toLowerCase()),
            )
          )
            return false;
          return true;
        })
        .sort((a, b) => {
          const value = (row: SeaceRow) => {
            const field =
              sort.field === 'published' && row.kind === 'contracts' ? 'signed' : sort.field;
            return ['published', 'signed', 'start', 'end', 'termStart', 'termEnd'].includes(field)
              ? (dateStamp(text(row, field)) ?? 0)
              : text(row, field).toLocaleLowerCase();
          };
          const first = value(a);
          const second = value(b);
          const comparison = first < second ? -1 : first > second ? 1 : 0;
          return sort.ascending ? comparison : -comparison;
        }),
    [records, view, minorOnly, exclusions, excludedView, search, sort],
  );
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const lastFetch = sync
    .map((item) => item.fetched_at)
    .sort()
    .at(-1);
  const count = records.length;
  const columns =
    view === 'published'
      ? [
          'code',
          'entity',
          'description',
          'contractor',
          'signed',
          'termStart',
          'termEnd',
          'amount',
          'links',
        ]
      : [
          'code',
          'entity',
          'description',
          'items',
          'published',
          'start',
          'end',
          'amount',
          'state',
          'links',
        ];
  const labels: Record<string, string> = {
    code: 'Code',
    entity: 'Entity',
    description: 'Description',
    contractor: 'Supplier',
    signed: 'Signed',
    termStart: 'Term start',
    termEnd: 'Term end',
    amount: 'Amount',
    links: 'Links',
    items: 'Items',
    published: 'Published',
    start: 'Start',
    end: 'End',
    state: 'Status',
  };

  const toggleSort = (field: string) => {
    setSort((value) => ({ field, ascending: value.field === field ? !value.ascending : true }));
  };
  const changeExclusion = async (row: SeaceRow) => {
    const key = exclusionKey(row);
    const excluded = !exclusions.has(key);
    try {
      await setExcluded(key, excluded);
      setExclusions((current) => {
        const next = new Set(current);
        if (excluded) next.add(key);
        else next.delete(key);
        return next;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update');
    }
  };
  const refresh = async () => {
    try {
      setPendingId(await enqueueRefresh(region, year));
      setMessage('Refresh queued');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Refresh unavailable');
    }
  };

  return (
    <main className={styles.page}>
      <aside className={styles.sidebar}>
        <h1>SEACE</h1>
        <nav aria-label="SEACE views">
          {views.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={() => {
                setPage(1);
                setExcludedView(false);
              }}
              className={({ isActive }) => (isActive ? styles.active : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <label htmlFor="seace-region">Region</label>
        <div className={styles.regionControl}>
          <select
            id="seace-region"
            value={region}
            onChange={(event) => {
              setRegion(event.target.value);
              setPage(1);
              setExcludedView(false);
            }}
          >
            {regions.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Refresh region"
            title="Refresh region"
            onClick={() => void refresh()}
            disabled={Boolean(pendingId)}
          >
            ↻
          </button>
        </div>
        <small>{count.toLocaleString()} records</small>
        <small>
          {lastFetch ? `Last fetch ${new Date(lastFetch).toLocaleString()}` : 'Never fetched'}
        </small>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={minorOnly}
            onChange={(event) => setMinorOnly(event.target.checked)}
          />
          Minor contracts only
        </label>
        {pendingId && <small>Refresh running or queued</small>}
      </aside>
      <section className={styles.content}>
        <div className={styles.toolbar}>
          <div>
            <h2>{views.find((item) => item.path === location.pathname)?.label ?? 'Last 24h'}</h2>
            <span>{rows.length.toLocaleString()} records</span>
          </div>
          <div className={styles.controls}>
            <input
              aria-label="Search records"
              placeholder="Search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <select
              aria-label="Sort"
              value={`${sort.field}:${sort.ascending ? 'asc' : 'desc'}`}
              onChange={(event) => {
                const [field, direction] = event.target.value.split(':');
                setSort({ field, ascending: direction === 'asc' });
              }}
            >
              <option value="published:desc">Newest</option>
              <option value="published:asc">Oldest</option>
              <option value="code:asc">Code A–Z</option>
              <option value="entity:asc">Entity A–Z</option>
            </select>
            <button
              type="button"
              onClick={() => {
                setExcludedView(!excludedView);
                setPage(1);
              }}
            >
              {excludedView ? 'Excluded' : 'Current'}
            </button>
          </div>
        </div>
        {message && <p role="status">{message}</p>}
        {loading && <p role="status">Loading…</p>}
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th scope="col">Exclude</th>
                {columns.map((field) => (
                  <th key={field} scope="col">
                    <button type="button" onClick={() => toggleSort(field)}>
                      {labels[field]} {sort.field === field ? (sort.ascending ? '↑' : '↓') : '↕'}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={`${row.kind}:${row.recordKey}`}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Exclude ${text(row, 'code')}`}
                      checked={exclusions.has(exclusionKey(row))}
                      onChange={() => void changeExclusion(row)}
                    />
                  </td>
                  {columns.map((field) => (
                    <td key={field}>
                      {field === 'code' ? (
                        codeUrl(row) ? (
                          <a href={codeUrl(row)!} target="_blank" rel="noopener noreferrer">
                            {text(row, field) || '—'}
                          </a>
                        ) : (
                          text(row, field) || '—'
                        )
                      ) : field === 'links' ? (
                        <span className={styles.links}>
                          {links(row).map((link) => (
                            <a
                              key={link.url}
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {link.name}
                            </a>
                          ))}
                        </span>
                      ) : field === 'items' ? (
                        itemText(row)
                      ) : field === 'amount' ? (
                        money(row)
                      ) : ['published', 'start', 'end', 'signed', 'termStart', 'termEnd'].includes(
                          field,
                        ) ? (
                        plainDate(text(row, field))
                      ) : (
                        text(row, field) || '—'
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1}>No records</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className={styles.pager}>
          <span>
            {rows.length
              ? `${(currentPage - 1) * pageSize + 1}–${(currentPage - 1) * pageSize + visible.length} of ${rows.length}`
              : '0 records'}
          </span>
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>
            Page {currentPage} of {pages}
          </span>
          <button
            type="button"
            disabled={currentPage >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
          <label htmlFor="seace-page-size">Rows per page</label>
          <select
            id="seace-page-size"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {pageSizes.map((size) => (
              <option key={size}>{size}</option>
            ))}
          </select>
        </div>
      </section>
    </main>
  );
}
