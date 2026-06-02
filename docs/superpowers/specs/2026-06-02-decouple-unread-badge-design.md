# Decouple the unread badge from the read cursor

**Date:** 2026-06-02
**Scope:** cicchetto (web PWA) — `cicchetto/src/lib/selection.ts`
**Status:** design, pending implementation

## Problem

The "Unread-badges-from-cursor cluster" unified two UX elements onto a single
source of truth — the server-owned read cursor:

- **Sidebar unread badge** (`messagesUnread` / `eventsUnread` /
  `unreadCounts` memos in `selection.ts:212-279`) = count of rows with
  `id > cursor` per channel.
- **In-pane unread marker** (`── N unread ──`, `ScrollbackPane.tsx:867-902`)
  = rows in `(cursor, sessionTop]`, where `sessionTop` = max message id
  captured at window mount.

The cursor advances on scroll-settle, defocus, browser-blur, and send — but
**not** on plain window selection. So selecting a window with unread messages
leaves the badge stuck until the operator scrolls or leaves. That is the UX
stupidity.

The deeper issue: the badge and the marker want **different lifetimes**, and
coupling them onto one cursor was the mistake.

| Element | Means | Should clear when |
|---------|-------|-------------------|
| Badge   | "have I opened this window?" | I *look* at it (select) |
| Marker  | "where did I leave off reading?" | I *move past it* (scroll / defocus / send) |

## Decision

Split the badge off the cursor **for the focused window only**. The cursor and
the marker keep their current mechanics unchanged.

In `selection.ts`'s `perChannelUnread` memo, after counts are computed from
`(scrollbackByChannel, readCursors, serverSeedCounts)`, force the
currently-focused-and-visible window's `{messages, events}` to `0` as a final
overwrite:

```
suppressKey =
  (selectedChannel() && isDocumentVisible())
    ? channelKey(sel.networkSlug, sel.channelName)
    : null

if (suppressKey) result[suppressKey] = { messages: 0, events: 0 }
```

- Derived from the existing `selectedChannel` signal (same module) and the
  shared `isDocumentVisible` signal (`lib/documentVisibility.ts`, already
  imported at `selection.ts:5`). **No new persistent state.** The cursor is
  never written on select — derive, don't duplicate.
- The overwrite runs after both the seed-only and locally-hydrated loops, so it
  covers a freshly-selected cold-start channel (seed badge) as well as a
  hydrated one.
- All three derived memos and every consumer (Sidebar badge, BottomBar total,
  Shell title, focus-rule) read through `perChannelUnread`, so suppression is
  consistent everywhere — single code path, no view-level divergence.

### Visibility gate

Suppress only while the window is selected **AND** the document is visible.
A selected-but-backgrounded window (phone locked, tab switched) keeps accruing
its badge so the operator sees activity on return; the badge clears again when
they look back. This matches the "present" semantics already used by
`WSPresence` / auto-away. "Selected" ≠ "looking".

## Behaviour after the change

- Select a window → its badge drops to `0` immediately (gated on visible). ✓
- Cursor never moves on select → the marker survives. Badge `0` while the
  marker still shows "5 unread" is **intended** — different meanings. ✓
- Select a window with 50 unread, scroll past only 10, then leave → window
  deselected → memo recomputes from the honest cursor (advanced to last-seen by
  the existing focus-leave write) → the remaining ~40 re-badge. ✓
- Send / scroll / defocus / marker injection / cursor writes: **no change.**

## Rejected alternatives

- **Suppress in `Sidebar.tsx` render only.** Localized, but BottomBar total and
  Shell title would still count the focused window → two divergent truths.
  Violates "one feature, one code path."
- **Advance the cursor on select (mark whole window read).** Clears the badge
  but also jumps the cursor past `sessionTop`, killing the marker on select —
  contradicts the "marker survives select" requirement, and marks unscrolled
  messages read (operator wanted the honest leftover).

## Out of scope

- **Mention badge** (`mentionCounts`, `mentions.ts`) is already cleared on focus
  via `clearMentionsForFocus` (`selection.ts:313-339`) and is body-text-predicate
  based, not cursor-derived. It clears *permanently* on select (not
  suppress-then-recompute). Different mechanism, working as intended — untouched.
- Marker, send-clears-marker (bucket D, already works), scroll-settle, blur, and
  all server-side read-cursor machinery.

## Testing

- `cicchetto/src/lib/selection.test.ts` (or sibling): TDD failing test first.
  - Selecting a channel with unread zeros that channel's `messagesUnread` /
    `eventsUnread` while leaving sibling channels' counts intact.
  - Deselecting recomputes the channel's count from its cursor (leftover
    re-badges) — assert against the cursor, not a hardcoded number.
  - With the document hidden, a selected channel is **not** suppressed.
  - Cold-start seed-only selected channel is suppressed too.
- `mix test`-style gate on the cic side: `scripts/bun.sh run test`,
  zero warnings.

## Stale-comment cleanup

`ScrollbackPane.tsx:829-831` still claims "the cursor only advances when the
user navigates AWAY" — it predates scroll-settle (UX-8b) and send (bucket D).
Fix the comment in the same change to stop propagating the wrong mental model.
