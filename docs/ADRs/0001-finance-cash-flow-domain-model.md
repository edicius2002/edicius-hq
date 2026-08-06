# ADR 0001 — Finance cash-flow domain model

- **Status:** Accepted
- **Date:** 2026-08-05
- **Context:** Delivery step 5 — Finance ([#14](https://github.com/edicius2002/edicius-hq/issues/14))
- **Supersedes:** nothing

## Context

Finance ports the legacy **Cash Flow** page (`ediciuscorp/index.html` + `js/flow.js`, ~3.8k lines): a canvas of jobs, accounts and asset balances connected by money flows.

Per decision 1.4 of the implementation plan, the legacy app is a **behaviour** reference only. Its structure is not something to copy, and four traits in particular do not survive contact with a typed, testable codebase:

- **One node type carrying every field.** A node holds `amount`, `currency`, `feeIn/Out`, `feeIn/OutType`, plus job-only `curAmts`, `customCurrencies` and `frozenCurAmts`. Most fields are meaningless for most types, so every consumer must know by convention which ones apply.
- **Three parallel structures for one idea.** A job's balances live across `curAmts` (active), `customCurrencies` (names) and `frozenCurAmts` (remembered), kept in sync by hand.
- **Structural relationships mixed with money movements.** Account-owns-asset is stored as an `own` edge in the same collection as real flows, forcing `kind` checks and undeletable-edge guards throughout.
- **Mutable module-level arrays** re-rendered wholesale, with derived totals recomputed inside render and `O(n)` lookups nested inside loops.

Zoom, pan, minimap, frames, undo/redo and multiple diagrams are deliberately out of scope for #14, but all of them are expected. The model chosen now decides whether they arrive as additions or as rewrites.

## Decision

### 1. State changes are pure transitions

Diagram mutations are pure functions `(diagram, …args) => diagram` in a framework-free module. The React layer dispatches them and renders the result; it does not compute domain state.

Fallible operations return a `Result` rather than failing silently, so invalid connections are surfaced and testable.

### 2. Diagram state is normalized

Nodes and flows are stored as `Record<Id, T>` alongside an explicit order array, rather than plain arrays.

### 3. Ownership is a field, not an edge

An asset balance references its owning account directly. There are no structural edges: **every edge is a real movement of money.**

### 4. Domain is separated from geometry

Money math never reads coordinates. Positions, anchors, edge paths and hit testing live in their own module.

### 5. Vocabulary describes what is stored, not the legacy name

The legacy `currency` node is renamed **`holding`**, and the code it carries is an **`asset`**.

In the legacy the word `currency` means three different things — a node type, an asset-code field, and the fiat classification set — and in one of them it is simply wrong: a `currency` node can hold `USDT` or a stock ticker, which the legacy's own summary then lists under _Stocks / assets_.

## Consequences

**Enabled**

- Undo/redo becomes a stack of diagram values, since every transition already returns a new one.
- Multiple diagrams become a collection in the stored document; the persisted shape reserves room for this from the start.
- Domain rules — especially the fee chain — are unit-testable with no DOM and no React.
- Deleting an account cascades to its balances through one ownership field instead of edge bookkeeping.
- Zoom, pan and minimap can be added in the geometry layer without touching money math.

**Accepted costs**

- More verbose than mutating arrays, and at 20–50 nodes the normalized lookups buy no measurable speed. The payoff is in update code and in what stays additive later, not in performance today.
- Names diverge from the legacy source, so a side-by-side comparison needs a mental mapping: `currency` node → `holding`, `currency` field → `asset`.
- Every transition allocates a new diagram object. Irrelevant at this scale; revisit only if profiling says otherwise.

## Alternatives considered

**Mirror the legacy model.** Fastest to port and no mental mapping. Rejected: it carries the wide-node problem and the three parallel balance structures into typed code, where the compiler could have prevented both, and it makes undo/redo a rewrite rather than an addition.

**Keep `currency` as the node name and rename only the field.** Removes the worst ambiguity (`currency.currency`) at half the churn. Rejected as the smaller half of the fix: it leaves a node type whose name contradicts how the app itself classifies its contents.

**Separate layout into its own map, keyed by node id.** Cleanest separation of domain from view. Rejected as indirection without a current payoff — positions stay on the node, and isolation is achieved instead by having domain functions take narrow inputs that exclude coordinates.
