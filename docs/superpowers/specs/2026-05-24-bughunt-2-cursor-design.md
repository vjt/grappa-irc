# BUGHUNT-2 — Unread-marker cursor-write contract rewrite

**Date**: 2026-05-24
**Author**: brainstorm session (vjt + Claude orchestrator)
**Status**: approved — proceed to plan

## What this fixes

User-visible: opening a window with unreads makes the unread marker
flash for ~500ms then vanish — operator never gets to see it.

Root cause: UX-8(a3) added `tail.scrollIntoView({block:"end"})` to the
window-activation routine (commit `2cb827f`); UX-8(b+c) added a 500ms
scroll-settle debounce that POSTs the new cursor (commit `b55e5f6`).
Programmatic `scrollIntoView` fires a real DOM scroll event → arms
the settle timer → 500ms later POSTs `last-fully-visible-row` (which
is now the tail because we just scrolled there) → server broadcasts
`read_cursor_set` → cic cursor signal advances → marker (which sat
just below the OLD cursor) is now BELOW the new cursor → vanishes.

Worse, the broader cursor-write contract is incoherent. Today:

| Event | Cursor written? | Value |
|---|---|---|
| Window switch (cic→cic) | yes — `selection.ts` leave-arm | `store-tail` (= last id in scrollback store) |
| Browser blur | yes — `selection.ts` visibility-arm | `store-tail` |
| Scroll-settle | yes — `ScrollbackPane.onScroll` 500ms debounce | `lastFullyVisibleRowId(listRef)` |
| Window open / activate | NO (intentionally) | n/a |
| Send | NO | n/a |

`store-tail` on switch/blur ignores where the operator was actually
looking — if you scrolled up to read history then switched away, the
cursor jumps to the tail and the next visit shows no marker even
though you didn't read the bottom rows. `scroll-settle` writes the
honest "last fully visible" value but is corrupted by programmatic
scrolls.

vjt's contract (2026-05-24): cursor advances ONLY when the operator
demonstrably moved on. Three triggers; ALL three write the same
honest value (`lastFullyVisibleRowId(listRef)` for the relevant pane);
NO write on bare window-open.

## New contract

| Event | Cursor → | UX result |
|---|---|---|
| Open / activate window | **no write** | Marker stays where server says; activation routine scrolls to marker (existing behavior). |
| Switch away (cic→cic) | `lastFullyVisibleRowId` of LEAVING pane, measured BEFORE the activation routine touches the listRef geometry | If operator scrolled up to read history, only what they actually saw counts as read. |
| Scroll-settle (current window) | `lastFullyVisibleRowId` of current pane, debounced 500ms | Marker re-renders walking down with operator's scroll. Disappears only when cursor reaches absolute tail. |
| Browser blur (tab→hidden) | `lastFullyVisibleRowId` of focused pane | Same semantic as switch-away. |
| Send | **no write** | Out of scope this cluster — deferred. |

Forward-only gate (server's `Grappa.ReadCursor.set/4` last-write-wins
+ cic's `setCursorIfAdvances` candidate>current guard) protects
against scroll-up writing a smaller id; operator scrolling up reveals
a lower visible-tail → POST dropped at cic.

## Approach

Move cursor-write ownership FROM `selection.ts` TO `ScrollbackPane.tsx`.
Rationale per CLAUDE.md "no leaky abstractions: each context owns its
domain": the pane owns its DOM geometry; selection.ts owns "which
window is focused". Today selection.ts reaches into scrollback STORE
state (`scrollbackByChannel()[k].last().id`) to compute the cursor —
that's the leaky shape. Honest cursor needs DOM geometry, which lives
in the pane.

ScrollbackPane already has the right shape: the `<Show>` in `Shell.tsx`
is non-keyed so the DOM node + component instance survive across
selection changes (existing comment line 1050-1051). The pane already
tracks `key()` (slug+channel signal). When `key()` changes, the listRef
geometry STILL reflects the leaving window's scroll position — we read
`lastFullyVisibleRowId(listRef)` for the OLD key BEFORE the activation
routine runs.

### Bucket A — Move cursor-write to ScrollbackPane + input-event gate

**`cicchetto/src/ScrollbackPane.tsx`**:

1. **New module-singleton signal** `lastInputEventAtMs: number | null`
   (or per-pane via component state — module-singleton is fine
   because only one ScrollbackPane is mounted at a time). Set to
   `Date.now()` from:
   - `onPointerDown` on the listRef `<div>` (covers wheel-on-element,
     touch-start, drag-scrollbar).
   - `onTouchMove` on the listRef (covers touch-scroll where pointerdown
     might race the scroll-fire).
   - `onKeyDown` on the listRef when key ∈ `{PageUp, PageDown, Home,
     End, ArrowUp, ArrowDown, " "}`. Requires `tabindex="-1"` on the
     listRef so it can receive keyboard focus when clicked.
   - NOT set from programmatic scroll (no DOM event fires for
     synthetic scrollIntoView / scrollTop=).

2. **`onScroll` settle-arm gate**: skip arming the 500ms timer if
   `lastInputEventAtMs === null` OR `(now - lastInputEventAtMs) >
   1500ms`. 1500ms covers user wheel → 500ms debounce + browser layout
   slop. Programmatic activation `scrollIntoView`: no preceding input
   event → no arm.

3. **`on(key, …)` effect at line 1078**: BEFORE the existing
   `setMarkerScrolled(false)` reset, if `prevKey !== undefined &&
   prevKey !== currentKey && listRef` exists: read
   `lastFullyVisibleRowId(listRef)` (returns the leaving pane's
   visible-tail because DOM scrollTop hasn't yet been touched for the
   new pane), decode `prevKey` back to (slug, channel), call
   `setCursorIfAdvances(slug, channel, id)`. Skip if id is null
   (empty scrollback). After this block, reset
   `lastInputEventAtMs = null` so the new pane starts with a fresh
   gate (programmatic activation must not inherit the leaving pane's
   input timestamp).

4. **New `createEffect(on(isDocumentVisible, …))`**: fires on
   `prev === true && visible === false`. If listRef exists, read
   `lastFullyVisibleRowId(listRef)`, write cursor for CURRENT
   `key()` via `setCursorIfAdvances`. Mirror of the leave path.
   No false→true arm needed (no cursor-write on focus regain;
   marker stays where it is).

**`cicchetto/src/lib/selection.ts`**:

1. **DELETE** `setCursorForWindow` helper (lines 122-143). No
   remaining callers after Bucket A lands.
2. **DELETE** the cursor-write block in `createEffect(on(selectedChannel,
   …))` lines 225-231 (the leave-arm cursor write). KEEP the badge-
   clear + MRU-record + `loadInitialScrollback` arms (orthogonal).
3. **DELETE** the cursor-write line in `createEffect(on(isDocumentVisible,
   …))` line 280 (the blur-arm cursor write). KEEP the visibility-
   regain badge-clear arm (orthogonal).
4. **KEEP** `setCursorIfAdvances` (now consumed by ScrollbackPane in
   three places: scroll-settle, key-leave, blur).

### Bucket B — Sentinel tests

**Three e2e specs** (`cicchetto/e2e/tests/`):

1. **`cursor-no-advance-on-open.spec.ts`** — seed window with cursor
   mid-list (server-side via test fixture), open the window from
   sidebar, wait 1500ms (longer than 500ms settle + slop), assert:
   - marker still rendered at the same DOM position
   - server cursor unchanged (GET via REST or read via the in-app
     `getReadCursor` exposed via test hook)

2. **`cursor-advances-on-switch.spec.ts`** — open window A scrolled
   such that visible-tail is row X (not the absolute tail); switch
   to window B; assert server cursor for A == row X (not the store-
   tail).

3. **`cursor-walks-with-scroll.spec.ts`** — open window with marker
   mid-list; real wheel-scroll down N rows; wait 500ms+; assert
   marker re-rendered at the new visible-tail position; server
   cursor advanced to that id.

**One vitest** (`cicchetto/src/__tests__/ScrollbackPane.test.tsx`):
- Programmatic `scrollIntoView`-equivalent (manually fire a scroll
  event WITHOUT preceding pointerdown) → assert
  `setCursorIfAdvances` NOT called.
- Real `pointerdown` + scroll event → assert
  `setCursorIfAdvances` called with `lastFullyVisibleRowId` of
  the current pane.

## Order

A → B is the recommended order:

- A is the load-bearing fix; ships first so vjt can deploy and stop
  bleeding the cursor flash.
- B sentinels lock the contract in place; ship as a separate commit
  so the bug-fix is reviewable in isolation from test infrastructure.
- One worktree, two commits, single push.

## Out of scope

- **Send-side cursor-write**. Deferred per vjt 2026-05-24. Future
  cluster if dogfooding reveals need. With Bucket A landed, send
  while at-bottom is captured by the scroll-settle path naturally
  (auto-follow scroll + visible-tail = just-sent row). Send while
  scrolled-up is captured on the next switch/blur. Holes exist
  only for "send-while-scrolled-up then close tab" — narrow.
- **Dwell-time threshold** on scroll-settle. vjt picked
  "reveal-new-rows" earlier then dropped it after restating the
  contract — forward-only gate alone suffices.
- **Activation-baseline tail id**. Earlier design draft included
  this; dropped after contract clarification — server-side
  forward-only handles scroll-up-then-back-down correctly without
  extra cic-side bookkeeping.
- **Per-window scroll-position memory**. Orthogonal; UX-8 already
  settled it.
- **iPhone-specific input quirks** (rotation, split keyboard).
  Investigate if e2e flakes, not pre-emptively.

## Risks

- **`tabindex="-1"` on the listRef**: makes the scrollback div
  programmatically focusable. No tab-stop side effect (-1 excludes
  from tab order). Mobile: iOS doesn't surface keyboard scroll
  typically, so the keydown arm is effectively desktop-only.
  Acceptable: the touch arm covers mobile.
- **`onPointerDown` vs `onMouseDown`**: PointerEvent covers mouse +
  touch + pen uniformly. iOS Safari supports PointerEvent as of
  iOS 13+. Acceptable.
- **Switch-from-empty-pane**: listRef has no rows or scrollTop=0
  with content not yet rendered → `lastFullyVisibleRowId` returns
  null → skip-write. Correct: nothing to mark.
- **Switch-from-pane-where-everything-fits-on-screen**:
  `lastFullyVisibleRowId` returns the store-tail (last row IS
  fully visible) → write tail. Correct.
- **Race between switch fire and DOM-scrollTop-restore**: when does
  Solid reset scrollTop for the new pane? Today nothing explicitly
  resets it (existing comment line 1052: "scrollTop survives the
  switch"). `scrollToActivation` runs INSIDE double-rAF, so the
  key-effect body runs BEFORE any rAF — listRef geometry is
  guaranteed to reflect the leaving pane at the moment we read it.
- **Forward-only gate hides correct backward writes**: not a
  regression — current cic-side behavior already monotonic per the
  `setCursorIfAdvances` comment (lines 145-152). Server supports
  backward but cic never exercises it. Same after this change.

## Acceptance

- Opening a window with unread mid-list rows shows the marker
  persistently — does not vanish within 1500ms of bare open.
- Switching away from a window with operator scrolled-up writes
  the visible-tail (not store-tail) cursor; next visit shows
  marker at the scrolled-up position, not at the actual tail.
- Wheel/touch scroll within a window writes cursor + walks the
  marker down with the operator. Marker disappears only when
  cursor reaches absolute tail.
- Browser blur on a window with operator scrolled-up writes
  visible-tail cursor.
- All e2e specs in Bucket B pass on first run (no flake budget
  for fresh sentinels per `feedback_recurring_e2e_not_flake`).
- `scripts/check.sh` clean.

## Deployment

Bucket A is cic-only → `scripts/deploy-cic.sh` (Vite bundle + refresh
banner broadcast, no BEAM restart). Per
`feedback_per_bucket_deploy`: deploy + healthcheck + browser-smoke
at each bucket close. Bucket B is test-only → no deploy-cic needed
beyond the A close, but CI run on push is the gate.

No server changes → no `scripts/deploy.sh` invocation in this
cluster. No migration → no cold-deploy classification concern.
