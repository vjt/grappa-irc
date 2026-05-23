# UX-8 — Scroll cluster design

**Date**: 2026-05-23
**Author**: brainstorm session (vjt + Claude SIBLING)
**Status**: approved — proceed to plan

## What this fixes

Two related scroll problems in cic, captured as one cluster because they
share the `ScrollbackPane.tsx` surface and the `ReadCursor.set/4` server
contract.

### (a) Channel-switch scroll position interference

**Symptom** (vjt dogfood, 2026-05-23): switching from a tall channel to
a short one leaves the short channel scrolled "above its own height"
— content pushed up out of view at the top, whitespace where the first
row should be. Same root cause manifests in CI as
`scroll-on-window-switch:141` failing with a ~66px gap from the bottom.

**Pre-existing fix** at `ScrollbackPane.tsx:959-974`
(`scrollToActivation`) attempts to snap to the bottom on every
channel switch. Wraps the DOM write in `queueMicrotask`.

**Root cause** (forensic agent report, 2026-05-23): `queueMicrotask`
flushes BEFORE the browser's layout pass. Solid has committed the new
`<For>` rows (DOM nodes exist), but their box geometry is not yet
included in `scrollHeight`. `scrollTop = scrollHeight` lands one-or-two
rows short of true bottom. CI's slower scheduler widens the window
between microtask and layout commit → consistent failure. Local
machines win the race often enough to mask.

**Same bug** exists in `measureOverflow` at line 877-890 — also reads
`scrollHeight` from microtask.

### (b) Read-cursor update on scroll

**Current state**: `Grappa.ReadCursor.set/4` fires from cic on:
- focus-leave (selection.ts:202-208)
- browser-blur (selection.ts:256-257)

**Missing**: scroll-settle. If the operator scrolls down through unread
messages and stops mid-channel without switching away, the cursor is
not updated. On next visit, the unread marker is wrong.

**Server contract**: already supports last-write-wins
(`Grappa.ReadCursor.set/4` semantics — see docstring at
`lib/grappa/read_cursor.ex:1-20`). No server change required.

## Approach

### (a) Fix: double-rAF the geometry reads

Replace `queueMicrotask` with double `requestAnimationFrame` in:
- `scrollToActivation` (line 959-974)
- `measureOverflow` (line 877-890)

```ts
// Before:
queueMicrotask(() => { /* read scrollHeight, write scrollTop */ });

// After:
requestAnimationFrame(() => {
  requestAnimationFrame(() => { /* read scrollHeight, write scrollTop */ });
});
```

**Why double**: first rAF callback fires inside the next frame's
pre-layout phase; second rAF guarantees layout has completed. Standard
browser idiom for "wait for layout, then read geometry, then write."

**Side cleanup**: the length-effect at line 1078-1100 has a stale-
`atBottom` race with `scrollToActivation`. With rAF, `scrollToActivation`
is guaranteed to win the post-switch settle and set `atBottom = true`
correctly. The length-effect's `if (atBottom())` gate is then reliably
true post-switch. No change needed there.

**Test**: `cicchetto/e2e/tests/scroll-on-window-switch.spec.ts` is the
green-witness. Both scenarios already covered (channel→empty
query→channel-back + channel-with-unreads marker centering). Turns
green naturally when the rAF fix lands.

### (b) Scroll-settle cursor update

#### Semantics
- Cursor = id of the last fully-visible row at the bottom of the
  viewport when the user stops scrolling.
- **Forward-only**: never moves backwards on scroll-up. If the
  scroll-settle would retreat the cursor, skip the POST. The
  focus-leave + browser-blur paths still allow backward moves (their
  "I'm leaving, here's where I was" semantic legitimately can go
  backwards). Scroll-settle is the live signal — monotonic.

#### Mechanics
- Client-only 500ms debounce. `setTimeout` on every scroll event,
  cleared on the next scroll, fires once when scroll has settled.
- No server change. `Grappa.ReadCursor.set/4`'s last-write-wins
  absorbs duplicates already.

#### Code split
- `ScrollbackPane.tsx` owns the timer + `lastFullyVisibleRowId(listRef)`
  helper (DOM measurement lives with the DOM).
- `selection.ts` owns `setCursorIfAdvances(slug, name, candidateId)`:
  reads current cursor, compares, POSTs only if `candidate > current`.

#### Visible-row math
```ts
function lastFullyVisibleRowId(listRef: HTMLDivElement): number | null {
  const viewportBottom = listRef.scrollTop + listRef.clientHeight;
  let candidate: number | null = null;
  for (const row of listRef.querySelectorAll<HTMLElement>(".scrollback-line")) {
    if (row.offsetTop + row.offsetHeight > viewportBottom) break;
    const id = row.dataset.msgId;
    if (id) candidate = Number.parseInt(id, 10);
  }
  return candidate;
}
```
Requires adding `data-msg-id={msg.id}` to `<ScrollbackLine>` at line 591
— test-seam-style attribute, no behavior change.

## Bucket cadence

Order is load-bearing: A first (sentinel turns green, CI back to 184/184
before any new behavior lands), then B (helpers), then C (wiring), then
D (e2e verifies the new behavior).

### Bucket A — double-rAF geometry reads
**File**: `cicchetto/src/ScrollbackPane.tsx`
**Change**: swap `queueMicrotask` → double `requestAnimationFrame` in
`scrollToActivation` (line 959-974) and `measureOverflow` (line 877-890).
**Green witness**: existing `scroll-on-window-switch.spec.ts` (CI
shifts from 183/184 to 184/184).
**Commit**: `ux-8(a): double-rAF DOM geometry reads to fix scroll-on-switch race`

### Bucket B — `lastFullyVisibleRowId` + `setCursorIfAdvances` helpers
**Files**:
- `cicchetto/src/ScrollbackPane.tsx`: add `lastFullyVisibleRowId` helper
  + `data-msg-id={msg.id}` attribute on `<ScrollbackLine>` (line 591).
- `cicchetto/src/lib/selection.ts`: add `setCursorIfAdvances(slug, name,
  candidateId)` next to `setCursorForWindow`.
**Tests**: vitest unit tests for both helpers (mock DOM for visible-row,
mock cursor store for forward-only gate).
**Commit**: `ux-8(b1): lastFullyVisibleRowId + setCursorIfAdvances helpers`

### Bucket C — wire scroll-settle into `onScroll`
**File**: `cicchetto/src/ScrollbackPane.tsx`
**Change**: add 500ms debounce inside existing `onScroll` handler (line
1114). Component-scope `let scrollSettleTimer`. `onCleanup` clears it.
**Commit**: `ux-8(b2): scroll-settle cursor update via 500ms debounce`

### Bucket D — e2e: scroll-settle advances cursor, never retreats
**File**: new `cicchetto/e2e/tests/scroll-settle-cursor.spec.ts`
**Scenarios**:
1. Open seeded #bofh (200 rows). Scroll up to middle. Wait 600ms.
   Assert cursor moved to middle-visible row id (via REST `GET
   /networks/{slug}/channels/{ch}/read-cursor` or the `/me` envelope).
2. Scroll BACK to bottom. Wait 600ms. Assert cursor advanced to bottom.
3. Scroll UP from bottom. Wait 600ms. Assert cursor did NOT retreat.
**Commit**: `ux-8(b3): e2e — scroll-settle advances cursor, never retreats`

## Per-bucket deploy cadence

Per `feedback_per_bucket_deploy`:
- Each bucket: rebase → merge → `scripts/deploy.sh` (HOT — cic-only,
  no migrations, no GenServer state-shape change) → healthcheck →
  browser smoke.
- Bucket D is e2e-only (no production code touched, no deploy needed
  beyond verifying CI green at HEAD).

## Hard rules carry-forward

- Worktree FIRST for buckets A/B/C (production code per CLAUDE.md
  Development Cycle step 0).
- No `@skip` / `--grep` exclusions.
- No spec masking — bucket A turns the sentinel green by fixing the
  root cause, not by adding `afterEach` cleanup.
- `scripts/check.sh` exit-0 + literal tail paste at each LANDED claim
  per `feedback_landed_claim_evidence`.
- Code review per bucket via `code-review:loop` per
  `feedback_subagent_driven_development`.

## Out of scope

- **No server-side rate limit on `ReadCursor.set/4`**. Client debounce
  is sufficient; adding rate limit doubles the surface for no win.
- **No backward-cursor on scroll-up**. Focus-leave + browser-blur
  preserve that semantic.
- **No IntersectionObserver per row**. Overkill for a debounced
  500ms settle path.
- **GREEN-CI-3 Tier 2/3 work**. Already deferred to its own future
  cluster pickup.

## Risks & open questions

- **Bucket C interaction with the `loadMore` block at line 1135**:
  both fire inside `onScroll`. `loadMore` triggers when `scrollTop ≤
  200px` (scrolling up to top), `setCursorIfAdvances` fires after the
  500ms settle regardless of direction. They're independent — no
  shared state. But if `loadMore` lands new rows during the 500ms
  window, the visible-row math may compute against the NEW
  scrollHeight. Forward-only gate makes this safe (a higher
  candidate is fine; a lower one is skipped). No special handling.

- **The 500ms debounce on touch-scroll inertia**: iOS momentum
  scrolling fires scroll events for 1-2s after the user lifts their
  finger. Debounce resets on every event, so the POST fires after
  the inertia stops — which is what we want. Verify in browser smoke.

- **Cursor read for forward-only gate**: `getReadCursor` reads from
  `readCursor.ts`'s in-memory store. If the store is empty (cold
  start, never POSTed) the gate treats anything as "advancing." Fine
  — first POST is always allowed.

## Memory hooks worth re-reading during implementation

- `feedback_per_bucket_deploy` — deploy cadence
- `feedback_landed_claim_evidence` — gate-tail paste at LANDED
- `feedback_reviewer_gate_evidence` — code-reviewer briefs require
  literal gate-tail paste
- `feedback_ux_e2e_mandatory` — bucket D is the mandatory Playwright
  e2e for the UX behavior change
- `feedback_no_localized_strings_server_side` — applies if any new
  server-side wire shape lands (none planned in this cluster)
