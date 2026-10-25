import type { ReactNode } from 'react';

import { RowsSkeleton } from './RowsSkeleton';
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

const BAR_HEIGHTS = [42, 68, 53, 84, 62, 76, 48, 91, 58, 73, 52, 80];
const CANDLE_HEIGHTS = [44, 61, 37, 73, 57, 82, 48, 69, 89, 53, 76, 64, 93, 71];

function Frame({
  children,
  shape,
  className = '',
}: {
  children: ReactNode;
  shape?: string;
  className?: string;
}) {
  return (
    <div className={`${styles.frame} ${className}`} data-skeleton-shape={shape}>
      {children}
    </div>
  );
}

function Plot({
  shape,
  kind,
  compact = false,
}: {
  shape: string;
  kind: 'line' | 'bars' | 'candles';
  compact?: boolean;
}) {
  return (
    <div
      className={`${styles.plot} ${compact ? styles.compactPlot : ''}`}
      data-skeleton-shape={shape}
      data-skeleton-kind={kind}
    >
      <div className={styles.plotHeading}>
        <Skeleton width="32%" height={15} />
        <Skeleton width="18%" height={11} />
      </div>
      <div className={styles.plotBody}>
        <div className={styles.valueAxis}>
          {[0, 1, 2, 3].map((tick) => (
            <Skeleton key={tick} width="80%" height={8} />
          ))}
        </div>
        <div className={styles.plotCanvas}>
          {[0, 1, 2, 3].map((line) => (
            <Skeleton key={line} className={styles.gridLine} width="100%" height={1} />
          ))}
          {kind === 'line' ? (
            <Skeleton className={styles.lineTrace} width="100%" height="100%" radius={0} />
          ) : null}
          {kind === 'bars' ? (
            <div className={styles.bars}>
              {BAR_HEIGHTS.map((height, index) => (
                <Skeleton key={index} width="6%" height={`${height}%`} radius={2} />
              ))}
            </div>
          ) : null}
          {kind === 'candles' ? (
            <div className={styles.candles}>
              {CANDLE_HEIGHTS.map((height, index) => (
                <div
                  className={styles.candle}
                  data-skeleton-candle
                  key={index}
                  style={{ height: `${height}%` }}
                >
                  <Skeleton className={styles.wick} width={2} height="100%" radius={0} />
                  <Skeleton className={styles.candleBody} width="70%" height="45%" radius={1} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className={styles.timeAxis} data-skeleton-axis>
        {[0, 1, 2, 3, 4].map((tick) => (
          <Skeleton key={tick} width="12%" height={8} />
        ))}
      </div>
    </div>
  );
}

function Heatmap() {
  return (
    <Frame shape="calendar-heatmap" className={styles.heatmapFrame}>
      <Skeleton width="42%" height={16} />
      <div className={styles.heatmap}>
        {Array.from({ length: 52 * 7 }, (_, index) => (
          <span data-skeleton-day key={index}>
            <Skeleton width="100%" height="100%" radius={2} />
          </span>
        ))}
      </div>
    </Frame>
  );
}

function PostList() {
  return (
    <Frame shape="post-list" className={styles.postList}>
      <Skeleton width="24%" height={17} />
      {[0, 1, 2].map((row) => (
        <div className={styles.postRow} key={row}>
          <Skeleton width={35} height={35} radius="50%" />
          <div className={styles.postBubble}>
            <Skeleton width="35%" height={10} />
            <Skeleton width="90%" height={11} />
            <Skeleton width="65%" height={11} />
          </div>
        </div>
      ))}
    </Frame>
  );
}

function DiagramCanvas() {
  return (
    <Frame shape="diagram-canvas" className={styles.diagramCanvas}>
      <Skeleton width="20%" height={11} />
      <div className={styles.diagramSurface}>
        <Skeleton className={`${styles.diagramNode} ${styles.nodeOne}`} width="26%" height={64} />
        <Skeleton className={`${styles.diagramNode} ${styles.nodeTwo}`} width="22%" height={64} />
        <Skeleton className={`${styles.diagramNode} ${styles.nodeThree}`} width="28%" height={64} />
        <span className={`${styles.connector} ${styles.connectorOne}`} aria-hidden="true" />
        <span className={`${styles.connector} ${styles.connectorTwo}`} aria-hidden="true" />
      </div>
    </Frame>
  );
}

function DataTable({ shape, rows = 6 }: { shape: string; rows?: number }) {
  return (
    <Frame shape={shape} className={styles.tableFrame}>
      {Array.from({ length: rows + 1 }, (_, row) => (
        <div className={styles.tableRow} key={row}>
          {[0, 1, 2, 3].map((cell) => (
            <Skeleton
              key={cell}
              width={row === 0 ? '65%' : cell === 1 ? '85%' : '65%'}
              height={row === 0 ? 11 : 12}
            />
          ))}
        </div>
      ))}
    </Frame>
  );
}

function RouteMap() {
  return (
    <Frame shape="route-map" className={styles.routeMap}>
      <div className={styles.mapControls}>
        <Skeleton width={95} height={28} />
        <Skeleton width={65} height={28} />
      </div>
      <div className={styles.globe}>
        <span className={styles.mapArc} aria-hidden="true" />
        <span className={`${styles.mapArc} ${styles.mapArcTwo}`} aria-hidden="true" />
      </div>
      <Skeleton width="38%" height={11} />
    </Frame>
  );
}

function WeekGrid() {
  return (
    <Frame shape="week-grid" className={styles.weekFrame}>
      <Skeleton width="16%" height={18} />
      <div className={styles.weekGrid}>
        {Array.from({ length: 12 }, (_, index) => (
          <div className={styles.weekCard} key={index}>
            <Skeleton width="70%" height={10} />
            <span className={styles.weekBarTrack}>
              <span data-skeleton-week-bar>
                <Skeleton width="100%" height={`${BAR_HEIGHTS[index]}%`} radius={2} />
              </span>
            </span>
            <Skeleton width="55%" height={9} />
          </div>
        ))}
      </div>
    </Frame>
  );
}

function ProjectionTable() {
  return (
    <div className={styles.projectionTable} data-skeleton-shape="projection-table">
      <Skeleton width="55%" height={15} />
      {Array.from({ length: 6 }, (_, row) => (
        <div className={styles.projectionRow} key={row}>
          <Skeleton width="55%" height={10} />
          <Skeleton width="68%" height={10} />
          <Skeleton width="72%" height={10} />
        </div>
      ))}
    </div>
  );
}

function ProjectionSkeleton() {
  return (
    <Frame shape="projection-panel">
      <div className={styles.projectionHeading}>
        <Skeleton width={190} height={18} />
        <Skeleton width={115} height={32} />
        <Skeleton width={90} height={32} />
      </div>
      <div className={styles.projectionColumns}>
        <ProjectionTable />
        <Plot shape="projection-curve" kind="line" compact />
        <ProjectionTable />
      </div>
    </Frame>
  );
}

/** Page silhouettes serve both code download and the first page-wide data load. */
export function PageSkeleton({ page }: { page: PageSkeletonKind }) {
  const label = page === 'login' ? 'Loading sign in' : `Loading ${page}`;
  return (
    <section className={`${styles.page} ${styles[page]}`} role="status" aria-label={label}>
      <span className={styles.srOnly}>{label}…</span>
      {page === 'login' ? (
        <Frame className={styles.loginCard}>
          <Skeleton width="45%" height={20} />
          <Skeleton width="100%" height={34} />
          <Skeleton width="100%" height={34} />
          <Skeleton width="65%" height={30} />
        </Frame>
      ) : null}
      {page === 'error' ? (
        <Frame>
          <Skeleton width="35%" height={24} />
          <Skeleton width="75%" height={14} />
          <Skeleton width="28%" height={30} />
        </Frame>
      ) : null}
      {page === 'dashboard' ? (
        <>
          <div className={styles.clocks}>
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} width="100%" height={57} />
            ))}
          </div>
          <div className={styles.dashboardOverview}>
            <div className={styles.resetOverview}>
              <Frame className={styles.resetCard}>
                <Skeleton width="60%" height={12} />
                <Skeleton width="70%" height={42} />
                <Skeleton width="42%" height={12} />
              </Frame>
              <Heatmap />
            </div>
            <Frame className={styles.fxPanel}>
              <div className={styles.fxQuotes}>
                <Skeleton width="55%" height={14} />
                {Array.from({ length: 7 }, (_, index) => (
                  <div className={styles.quoteRow} key={index}>
                    <Skeleton width="52%" height={11} />
                    <Skeleton width="24%" height={11} />
                  </div>
                ))}
              </div>
              <Plot shape="fx-line-chart" kind="line" compact />
            </Frame>
          </div>
          <Skeleton className={styles.centerTitle} width={165} height={25} />
          <div className={styles.twoColumns}>
            <PostList />
            <PostList />
          </div>
        </>
      ) : null}
      {page === 'finance' ? (
        <>
          <div className={styles.toolbar}>
            <Skeleton width={130} height={30} />
            <Skeleton width={95} height={30} />
            <Skeleton width={95} height={30} />
            <Skeleton width={95} height={30} />
          </div>
          <div className={styles.financeWorkspace}>
            <DiagramCanvas />
            <div className={styles.stack}>
              <Frame shape="property-panel" className={styles.propertyPanel}>
                <Skeleton width="48%" height={16} />
                <Skeleton width="90%" height={12} />
                <Skeleton width="72%" height={12} />
                <Skeleton width="85%" height={32} />
              </Frame>
              <Frame shape="balance-summary">
                <Skeleton width="45%" height={16} />
                <div className={styles.summaryRows}>
                  <Skeleton width="80%" height={13} />
                  <Skeleton width="65%" height={13} />
                  <Skeleton width="90%" height={13} />
                </div>
              </Frame>
            </div>
          </div>
        </>
      ) : null}
      {page === 'greenlight' ? (
        <>
          <div className={styles.statRow}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width="100%" height={54} />
            ))}
            <Skeleton width={110} height={34} />
          </div>
          <div className={styles.greenlightOverview}>
            <Plot shape="weekly-line" kind="line" />
            <Plot shape="monthly-bars" kind="bars" />
          </div>
          <ProjectionSkeleton />
          <WeekGrid />
        </>
      ) : null}
      {page === 'investing' ? (
        <>
          <div className={styles.tickerTape}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} width="14%" height={15} />
            ))}
          </div>
          <div className={styles.investingWorkspace}>
            <Plot shape="candlestick-chart" kind="candles" />
            <Frame className={styles.watchlistPanel}>
              <Skeleton width="45%" height={18} />
              <Skeleton width="100%" height={32} />
              <RowsSkeleton variant="watchlist" rows={6} />
            </Frame>
          </div>
          <Frame className={styles.wideList}>
            <Skeleton width="24%" height={18} />
            <RowsSkeleton variant="positions" rows={4} />
          </Frame>
          <Frame shape="price-alerts" className={styles.wideList}>
            <Skeleton width="22%" height={18} />
            <RowsSkeleton variant="alerts" rows={3} />
          </Frame>
        </>
      ) : null}
      {page === 'airfare' ? (
        <>
          <div className={styles.airfareWorkspace}>
            <RouteMap />
            <Frame shape="route-list" className={styles.routeList}>
              <Skeleton width="48%" height={18} />
              <RowsSkeleton variant="watchlist" rows={6} />
            </Frame>
          </div>
          <div className={styles.twoColumns}>
            <Plot shape="fare-history-chart" kind="line" />
            <Plot shape="departure-bars" kind="bars" />
          </div>
          <DataTable shape="flight-table" rows={6} />
        </>
      ) : null}
      {page === 'seace' ? (
        <>
          <div className={styles.viewTabs}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} width={75} height={30} />
            ))}
          </div>
          <div className={styles.filters} data-skeleton-shape="seace-filters">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width="100%" height={34} />
            ))}
          </div>
          <DataTable shape="procurement-table" rows={10} />
        </>
      ) : null}
      {page === 'sentiment' ? (
        <>
          <Plot shape="featured-history-chart" kind="line" />
          <div className={styles.twoColumns}>
            {Array.from({ length: 7 }, (_, i) => (
              <Plot key={i} shape="indicator-history-chart" kind="line" compact />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
