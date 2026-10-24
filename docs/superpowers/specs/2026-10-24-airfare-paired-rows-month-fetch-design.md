# Airfare paired rows and month fetch design

## Intent

Show two consecutive watched routes in each list row, with each route's months beside it and one Fetch and Remove action area at the row's end. Keep the existing click-to-switch behavior for reciprocal directions. Make manual requests independent by route and month so different months of the same route can be queued together while an active month cannot be requested twice.

## Behavior

- Each row contains two consecutive displayed route groups. The final row may contain one. Reciprocal directions continue to share one route cell and switch on click.
- Clicking a route or month makes it the target of that row's Fetch and Remove controls. A row with no current selection targets its first route and that route's opening month.
- Fetch enqueues exactly the targeted route and month. While that request is active, the action changes from the reload mark to a download arrow and its percentage, followed by an upload arrow and its own percentage. Selecting another idle month restores Fetch for that month; selecting the active month shows its progress.
- The same route can have requests for different months in flight. A route-month already in flight cannot be enqueued again. Remove deletes the whole selected route.
- The progress bar and count below the row disappear. Terminal outcomes keep their existing notices.
- Percentages reflect backend work. Unknown collection totals display a preparing state instead of inventing a denominator. Sync progress counts completed upload/finalization units and reaches 100 only when they finish.

## Constraints and approach

The request queue already deduplicates an active route-month and allows different months. The worker serializes months of the same directional route to protect the archive. The UI will index active requests by route-month instead of route alone. The sync path will publish completed and total sync units through the existing progress shape. The shared action area stays at the end of each two-route row; a separate Fetch button on every month would contradict the requested layout.

## Verification

Cover route-month concurrency and duplicate suppression, two consecutive route groups including an odd last row, reciprocal switching, Fetch and Remove targeting, replacement of the button with stage percentages, and sync progress from actual upload/finalization work. Run focused tests, type checks, and the relevant full suites; report any unrelated baseline failures.
