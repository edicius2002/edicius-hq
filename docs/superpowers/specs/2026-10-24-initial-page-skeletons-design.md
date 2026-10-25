# Initial page skeletons

## Intent

Show the shape of every application page while its first code or data request is pending. Use the shared animated `Skeleton` visual already used by Airfare and SEACE. Keep navigation and any content already loaded visible, and keep cached content visible during later refreshes.

## Scope and behavior

- Give every route a layout-specific fallback during lazy module loading: Dashboard, Finance, Greenlight, Investing, Airfare, SEACE, Sentiment, and the error pages.
- Show a login-shaped placeholder while authentication status is being checked.
- Replace first-data-load text or empty placeholders in Dashboard, Finance, Greenlight, Investing, and Sentiment with skeletons shaped like their panels, rows, charts, and canvas.
- Match the actual visualization in each pending region: calendar cells and FX history on Dashboard; a node canvas in Finance; a weekly line, monthly bars, projection tables and curve, and week cards in Greenlight; candles and distinct watchlist, position, and alert rows in Investing; a route map, fare history, departure bars, and flight table in Airfare; a results table in SEACE; and history plots in Sentiment. A graph must not fall back to a generic text card.
- Keep route and in-page placeholders consistent: Investing's first candle request shows candle bodies and wicks, Dashboard's FX history shows both price lines, and Investing's pending positions use the same responsive card grid as loaded positions.
- Retain Airfare and SEACE's existing data skeletons. Reuse the same visual system for all new placeholders.
- A failed request shows the existing error or retry UI. A completed empty request shows the existing empty state. A refresh with cached data keeps that data visible.
- Loading placeholders announce a single useful status to assistive technology; decorative shapes are hidden and noninteractive. Respect reduced-motion preference through the shared Skeleton component.

## Approach

Use one shared component for route-level page templates and for page-level first-load states. This reduces duplication and aligns the two waiting phases. Use each page's own data state for in-page transitions, so independent data regions can resolve separately. Avoid a global loading overlay: it would hide loaded content and cause extra layout changes.

## Constraints

Keep current React Router lazy loading, React Query caching, and page data/error semantics. Do not delay a completed page to display a skeleton for a minimum time. Responsive templates should fit mobile and desktop.
