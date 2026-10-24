# SEACE paged read design

The SEACE explorer must show the same four views and filters while loading only the requested page of records. The current browser path downloads every record for a region and year before applying the view, filters, sorting, and pagination. In Arequipa this sends at least 6,955 records for a 50-row page.

## Approach

Add an authenticated Supabase RPC that filters, sorts, counts, and pages records in PostgreSQL. Return `{rows, total}` in one request. Derive searchable view fields from payload during a database trigger so existing collector writes and existing records receive the same values. Keep the page's current controls and display payload unchanged. Fetch sync metadata separately so it cannot delay the table.

The other considered approaches were parallelizing the existing full download, which still transfers all records, and caching that download, which does not improve a first visit. The owner chose server pagination after reviewing the production measurements.

## Requirements

- Preserve the existing recent, open, closed, and published membership, including Peru time and the rolling 24-hour boundary.
- Preserve Minor, object, search, exclusion, sortable columns, page size, and exact total count.
- Return at most the requested page size of full payloads and apply owner scope on the server.
- Keep the collector's existing upsert shape valid and backfill derived values for existing rows.
- Ignore stale responses when controls change quickly. No production migration or deployment is authorized by this design.

## Verification

Use SQL fixtures for the four views, boundaries, exclusions, pagination, sorting, search, and cross-owner isolation. Use web tests for RPC parsing, control-driven reloads, and page display. Compare production timings only after a separate deployment.
