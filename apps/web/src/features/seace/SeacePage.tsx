import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useLocation } from 'react-router-dom';

import {
  exclusionKey,
  loadSeacePage,
  loadSeaceSync,
  setExcludedMany,
  type SeaceRow,
  type SeaceSync,
  type SeaceView,
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
  { path: '/seace/recent', navLabel: '24h' },
  { path: '/seace/all-open', navLabel: 'Open' },
  { path: '/seace/closed', navLabel: 'Closed' },
  { path: '/seace/published', navLabel: 'Publi' },
];
const pageSizes = [5, 10, 20, 50, 100];
const columnWidths: Record<string, number> = {
  code: 120,
  entity: 185,
  description: 450,
  object: 90,
  published: 105,
  start: 105,
  end: 105,
  amount: 120,
  links: 125,
  signed: 105,
  termStart: 105,
  termEnd: 105,
};
const mobileColumnWidths: Record<string, number> = {
  code: 102,
  entity: 0,
  description: 280,
  object: 82,
  published: 90,
  start: 126,
  end: 0,
  amount: 100,
  links: 110,
  signed: 90,
  termStart: 126,
  termEnd: 0,
};
const mobileHiddenFields = new Set(['entity', 'end', 'termEnd']);
const objectOptions = ['Todos', 'Bien', 'Servicio', 'Obra', 'Consultoría de Obra'];
const objectLabels: Record<string, string> = {
  Todos: 'All',
  Bien: 'Goods',
  Servicio: 'Services',
  Obra: 'Works',
  'Consultoría de Obra': 'Works consulting',
};
const text = (row: SeaceRow, field: string) => {
  const value = row.payload[field];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
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
const compactDate = (value: string) => {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/\d{4}(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return value || '—';
  const date = `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}`;
  return match[3] ? `${date} ${match[3].padStart(2, '0')}:${match[4]}` : date;
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
const itemLines = (row: SeaceRow): string[] => {
  const value = row.payload.items;
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter(Boolean);
};
const isPdfLink = (name: string, url: string) =>
  /\.pdf$/i.test(name) || /\bPDF$/i.test(name) || /\.pdf$/i.test(new URL(url).pathname);
const links = (row: SeaceRow) => {
  const result: { name: string; url: string }[] = [];
  const primary = safeUrl(row.payload.documentUrl);
  const primaryName = text(row, 'documentName');
  if (primary && isPdfLink(primaryName, primary))
    result.push({ name: primaryName || 'PDF', url: primary });
  if (Array.isArray(row.payload.documents)) {
    for (const item of row.payload.documents) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const doc = item as Record<string, unknown>;
        const url = safeUrl(doc.url);
        const name = typeof doc.name === 'string' ? doc.name.trim() : '';
        if (url && isPdfLink(name, url) && !result.some((link) => link.url === url)) {
          result.push({ name: name || 'PDF', url });
        }
      }
    }
  }
  return result;
};

export function SeacePage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const view: SeaceView = location.pathname.endsWith('/published')
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
  const [objectFilter, setObjectFilter] = useState('Todos');
  const [syncResult, setSyncResult] = useState<{ key: string; rows: SeaceSync[] } | undefined>();
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [savingExclusions, setSavingExclusions] = useState(false);
  const [excludedByView, setExcludedByView] = useState<Record<SeaceView, boolean>>({
    recent: false,
    open: false,
    closed: false,
    published: false,
  });
  const excludedView = excludedByView[view];
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ field: string; ascending: boolean }>({
    field: 'published',
    ascending: false,
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [actionMessage, setActionMessage] = useState('');
  const [detailModal, setDetailModal] = useState<
    | { kind: 'items'; code: string; items: string[] }
    | { kind: 'entity'; code: string; entity: string }
    | null
  >(null);
  const detailDialogRef = useRef<HTMLDialogElement>(null);
  const filterKey = JSON.stringify([
    region,
    year,
    view,
    minorOnly,
    objectFilter,
    excludedView,
    search,
    sort.field,
    sort.ascending,
    pageSize,
  ]);
  const syncKey = `${region}:${year}`;
  const loadPage = useCallback(
    async (targetPage: number) => ({
      ...(await loadSeacePage({
        region,
        year,
        view,
        minorOnly,
        objectFilter,
        excluded: excludedView,
        search,
        sortField: sort.field,
        ascending: sort.ascending,
        page: targetPage,
        pageSize,
        now: new Date().toISOString(),
      })),
      page: targetPage,
    }),
    [
      region,
      year,
      view,
      minorOnly,
      objectFilter,
      excludedView,
      search,
      sort.field,
      sort.ascending,
      pageSize,
    ],
  );
  const pageQuery = useQuery({
    queryKey: ['seace', 'page', filterKey, page],
    queryFn: () => loadPage(page),
    staleTime: 30_000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === filterKey ? previousData : undefined,
  });
  const loading = pageQuery.isPending || pageQuery.isPlaceholderData;
  const records = pageQuery.data?.rows ?? [];
  const total = pageQuery.data?.total ?? 0;
  const message =
    (pageQuery.error instanceof Error ? pageQuery.error.message : '') || actionMessage;
  const syncs = syncResult?.key === syncKey ? syncResult.rows : [];

  useEffect(() => {
    if (!pageQuery.data || pageQuery.isPlaceholderData) return;
    const lastPage = Math.max(1, Math.ceil(pageQuery.data.total / pageSize));
    if (page > lastPage) {
      queueMicrotask(() => setPage((current) => Math.min(current, lastPage)));
    } else if (page < lastPage) {
      void queryClient.prefetchQuery({
        queryKey: ['seace', 'page', filterKey, page + 1],
        queryFn: () => loadPage(page + 1),
        staleTime: 30_000,
      });
    }
  }, [
    pageQuery.data,
    pageQuery.isPlaceholderData,
    page,
    pageSize,
    queryClient,
    filterKey,
    loadPage,
  ]);

  useEffect(() => {
    let cancelled = false;
    void loadSeaceSync(region, year)
      .then((value) => {
        if (!cancelled) setSyncResult({ key: syncKey, rows: value });
      })
      .catch(() => {
        if (!cancelled) setSyncResult({ key: syncKey, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [region, year, syncKey]);

  const exclusionsReady = !loading;

  const latestFetchedAt = syncs.reduce<string | null>(
    (latest, sync) =>
      !latest || Date.parse(sync.fetched_at) > Date.parse(latest) ? sync.fetched_at : latest,
    null,
  );
  const latestSyncs = syncs.filter((sync) => sync.fetched_at === latestFetchedAt);
  const newCount =
    latestSyncs.length > 0 && latestSyncs.every((sync) => typeof sync.new_count === 'number')
      ? latestSyncs.reduce((total, sync) => total + sync.new_count!, 0)
      : null;
  const fetchTime = latestFetchedAt
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Lima',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .format(new Date(latestFetchedAt))
        .replace(',', ' ·')
    : '—';

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(pageQuery.data?.page ?? page, pages);
  const visible = records;
  const visibleKeys = visible.map(exclusionKey);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selectedKeys.has(key));
  const columns =
    view === 'published'
      ? [
          'code',
          'entity',
          'description',
          'object',
          'signed',
          'termStart',
          'termEnd',
          'amount',
          'links',
        ]
      : ['code', 'entity', 'description', 'object', 'published', 'start', 'end', 'links'];
  const tableWidth = 42 + columns.reduce((width, field) => width + columnWidths[field], 0);
  const mobileTableWidth =
    42 + columns.reduce((width, field) => width + mobileColumnWidths[field], 0);
  const labels: Record<string, string> = {
    code: 'Code',
    entity: 'Entity',
    description: 'Description',
    object: 'Object',
    signed: 'Signed',
    termStart: 'Term start',
    termEnd: 'Term end',
    amount: 'Amount',
    links: 'Links',
    published: 'Published',
    start: 'Start',
    end: 'End',
  };

  const toggleSort = (field: string) => {
    setSort((value) => ({ field, ascending: value.field === field ? !value.ascending : true }));
    setPage(1);
    setSelectedKeys(new Set());
  };
  const changeExclusion = async () => {
    if (!exclusionsReady || !selectedKeys.size || savingExclusions) return;
    const keys = [...selectedKeys];
    const excluded = !excludedView;
    setSavingExclusions(true);
    try {
      await setExcludedMany(keys, excluded);
      setSelectedKeys(new Set());
      await queryClient.invalidateQueries({ queryKey: ['seace', 'page'] });
      setActionMessage('');
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Could not update');
    } finally {
      setSavingExclusions(false);
    }
  };
  const openItems = (row: SeaceRow) => {
    const items = itemLines(row);
    if (!items.length) return;
    setDetailModal({ kind: 'items', code: text(row, 'code'), items });
    detailDialogRef.current?.showModal();
  };
  const openEntity = (row: SeaceRow) => {
    const entity = text(row, 'entity');
    if (!entity) return;
    setDetailModal({ kind: 'entity', code: text(row, 'code'), entity });
    detailDialogRef.current?.showModal();
  };
  const closeDetails = () => {
    detailDialogRef.current?.close();
    setDetailModal(null);
  };

  return (
    <div className={styles.page}>
      <div className={styles.topPanel}>
        <div className={styles.sidebar}>
          <nav aria-label="SEACE views">
            {views.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => {
                  setPage(1);
                  setSelectedKeys(new Set());
                }}
                className={({ isActive }) => (isActive ? styles.active : '')}
              >
                {item.navLabel}
              </NavLink>
            ))}
          </nav>
          <div className={styles.filters}>
            <div className={styles.field}>
              <div className={styles.regionControl}>
                <select
                  id="seace-region"
                  aria-label="Region"
                  value={region}
                  onChange={(event) => {
                    setRegion(event.target.value);
                    setPage(1);
                    setSelectedKeys(new Set());
                  }}
                >
                  {regions.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <div className={styles.fetchInfo} aria-label="Last SEACE fetch">
                  <span>{newCount === null ? '—' : newCount.toLocaleString()} new</span>
                  <time dateTime={latestFetchedAt ?? undefined}>{fetchTime}</time>
                </div>
              </div>
            </div>
            <label className={styles.toggleRow}>
              <strong>Minor</strong>
              <input
                type="checkbox"
                aria-label="Minor"
                checked={minorOnly}
                onChange={(event) => {
                  setMinorOnly(event.target.checked);
                  setPage(1);
                  setSelectedKeys(new Set());
                }}
              />
            </label>
            <div className={styles.field}>
              <select
                id="seace-object"
                aria-label="Object"
                value={objectFilter}
                onChange={(event) => {
                  setObjectFilter(event.target.value);
                  setPage(1);
                  setSelectedKeys(new Set());
                }}
              >
                {objectOptions.map((item) => (
                  <option key={item} value={item}>
                    {objectLabels[item]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={styles.resetFilters}
              aria-label="Reset filters"
              title="Reset filters"
              onClick={() => {
                setRegion('Arequipa');
                setMinorOnly(true);
                setObjectFilter('Todos');
                setSearch('');
                setSort({ field: 'published', ascending: false });
                setPage(1);
                setSelectedKeys(new Set());
              }}
            >
              ×
            </button>
          </div>
        </div>
        <div className={styles.toolbar}>
          <div className={styles.tableControls}>
            <label className={styles.searchField}>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m15.5 15.5 5 5" />
              </svg>
              <input
                aria-label="Search records"
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                  setSelectedKeys(new Set());
                }}
              />
            </label>
            <div className={styles.actions}>
              <div className={styles.tableSwitch} role="group" aria-label="Exclusion view">
                <button
                  type="button"
                  aria-pressed={!excludedView}
                  className={!excludedView ? styles.selected : ''}
                  onClick={() => {
                    setExcludedByView((current) => ({ ...current, [view]: false }));
                    setPage(1);
                    setSelectedKeys(new Set());
                  }}
                >
                  Not excluded
                </button>
                <button
                  type="button"
                  aria-pressed={excludedView}
                  className={excludedView ? styles.selected : ''}
                  onClick={() => {
                    setExcludedByView((current) => ({ ...current, [view]: true }));
                    setPage(1);
                    setSelectedKeys(new Set());
                  }}
                >
                  Excluded
                </button>
              </div>
              <button
                type="button"
                disabled={!exclusionsReady || savingExclusions || selectedKeys.size === 0}
                onClick={() => void changeExclusion()}
              >
                {excludedView ? 'Restore' : 'Exclude'} selected ({selectedKeys.size})
              </button>
            </div>
          </div>
        </div>
        <strong className={styles.tableCount}>
          {total.toLocaleString()} {total === 1 ? 'record' : 'records'}
        </strong>
      </div>
      <section className={styles.content} aria-label="SEACE records">
        {message && <p role="status">{message}</p>}
        {loading && <p role="status">Loading…</p>}
        <div className={styles.tableWrap} tabIndex={0} aria-label="SEACE records table">
          <table
            style={
              {
                '--desktop-table-width': `max(100%, ${tableWidth}px)`,
                '--mobile-table-width': `max(100%, ${mobileTableWidth}px)`,
              } as CSSProperties
            }
          >
            <colgroup>
              <col style={{ width: 42 }} />
              {columns.map((field) => (
                <col
                  key={field}
                  className={`${styles.dataColumn} ${mobileHiddenFields.has(field) ? styles.mobileHiddenColumn : ''}`}
                  style={
                    {
                      '--desktop-column-width': `${columnWidths[field]}px`,
                      '--mobile-column-width': `${mobileColumnWidths[field]}px`,
                    } as CSSProperties
                  }
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={styles.selectCell}>
                  <input
                    type="checkbox"
                    aria-label="Select visible page"
                    checked={allVisibleSelected}
                    disabled={!exclusionsReady || savingExclusions || visibleKeys.length === 0}
                    onChange={(event) => {
                      const next = new Set(selectedKeys);
                      for (const key of visibleKeys) {
                        if (event.target.checked) next.add(key);
                        else next.delete(key);
                      }
                      setSelectedKeys(next);
                    }}
                  />
                </th>
                {columns.map((field) => (
                  <th
                    key={field}
                    scope="col"
                    className={mobileHiddenFields.has(field) ? styles.mobileHiddenColumn : ''}
                    aria-sort={
                      sort.field === field ? (sort.ascending ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    <button type="button" onClick={() => toggleSort(field)}>
                      {field === 'start' || field === 'termStart' ? (
                        <>
                          <span className={styles.desktopOnly}>{labels[field]}</span>
                          <span className={styles.mobileOnly}>Period</span>
                        </>
                      ) : (
                        labels[field]
                      )}{' '}
                      {sort.field === field ? (sort.ascending ? '↑' : '↓') : '↕'}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={`${row.kind}:${row.recordKey}`}>
                  <td className={styles.selectCell}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${text(row, 'code')}`}
                      checked={selectedKeys.has(exclusionKey(row))}
                      disabled={!exclusionsReady || savingExclusions}
                      onChange={(event) => {
                        const key = exclusionKey(row);
                        const next = new Set(selectedKeys);
                        if (event.target.checked) next.add(key);
                        else next.delete(key);
                        setSelectedKeys(next);
                      }}
                    />
                  </td>
                  {columns.map((field) => (
                    <td
                      key={field}
                      className={[
                        field === 'code'
                          ? styles.codeCell
                          : field === 'entity'
                            ? styles.entityCell
                            : field === 'description'
                              ? styles.descriptionCell
                              : field === 'amount'
                                ? styles.amountCell
                                : '',
                        mobileHiddenFields.has(field) ? styles.mobileHiddenColumn : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {field === 'code' ? (
                        text(row, field) || '—'
                      ) : field === 'links' ? (
                        <span className={styles.links}>
                          {itemLines(row).length > 0 && (
                            <button type="button" onClick={() => openItems(row)}>
                              Items
                            </button>
                          )}
                          {text(row, 'entity') && (
                            <a
                              className={styles.mobileEntityLink}
                              href="#seace-detail-dialog"
                              aria-haspopup="dialog"
                              onClick={(event) => {
                                event.preventDefault();
                                openEntity(row);
                              }}
                            >
                              Entity
                            </a>
                          )}
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
                      ) : field === 'amount' ? (
                        money(row)
                      ) : field === 'start' || field === 'termStart' ? (
                        <>
                          <span className={styles.desktopOnly}>{plainDate(text(row, field))}</span>
                          <span className={styles.mobilePeriod}>
                            <span>
                              <strong>Start</strong>
                              {compactDate(text(row, field))}
                            </span>
                            <span>
                              <strong>End</strong>
                              {compactDate(text(row, field === 'start' ? 'end' : 'termEnd'))}
                            </span>
                          </span>
                        </>
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
              {visible.length === 0 && !loading && (
                <tr>
                  <td className={styles.emptyCell} colSpan={columns.length + 1}>
                    <span className={styles.emptyMessage}>
                      No records match this view and these filters.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className={styles.pager}>
          <span>
            {total
              ? `${(currentPage - 1) * pageSize + 1}–${(currentPage - 1) * pageSize + visible.length} of ${total}`
              : '0 records'}
          </span>
          <div className={styles.pagerControls}>
            <div className={styles.pageNavigation}>
              <button
                type="button"
                disabled={loading || currentPage <= 1}
                onClick={() => {
                  setPage(currentPage - 1);
                  setSelectedKeys(new Set());
                }}
              >
                Previous
              </button>
              <span>
                Page {currentPage} of {pages}
              </span>
              <button
                type="button"
                disabled={loading || currentPage >= pages}
                onClick={() => {
                  setPage(currentPage + 1);
                  setSelectedKeys(new Set());
                }}
              >
                Next
              </button>
            </div>
            <div className={styles.pageSize}>
              <label htmlFor="seace-page-size">Rows per page</label>
              <select
                id="seace-page-size"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                  setSelectedKeys(new Set());
                }}
              >
                {pageSizes.map((size) => (
                  <option key={size}>{size}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>
      <dialog
        id="seace-detail-dialog"
        ref={detailDialogRef}
        className={styles.itemsDialog}
        aria-labelledby="seace-detail-title"
        onClose={() => setDetailModal(null)}
      >
        <div className={styles.itemsDialogHeader}>
          <h2 id="seace-detail-title">{detailModal?.kind === 'entity' ? 'Entity' : 'Items'}</h2>
          <button
            type="button"
            aria-label={`Close ${detailModal?.kind ?? 'items'}`}
            onClick={closeDetails}
          >
            ×
          </button>
        </div>
        {detailModal && (
          <>
            <p className={styles.itemsDialogCode}>{detailModal.code}</p>
            {detailModal.kind === 'items' ? (
              <ul className={styles.itemsDialogList}>
                {detailModal.items.map((item, index) => (
                  <li key={`${index}:${item}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className={styles.entityDialogText}>{detailModal.entity}</p>
            )}
          </>
        )}
      </dialog>
    </div>
  );
}
