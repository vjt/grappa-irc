# PWA home-screen icon notification badge — design (vjt-approved 2026-06-12)

Status: design approved, implementation NOT started. Approved via
brainstorm Q&A 2026-06-11/12; vjt's words for the semantics: "the same
exact messages a user has chosen to receive a notification for,
depending on their prefs. minimum effort, max consistency."

## One sentence

The icon badge shows how many unread messages the operator chose to be
notified about — same predicate as Web Push (`should_notify?`),
server-counted, derived from read cursors, cleared by reading.

## Semantics (locked)

Badge = count of unread rows (id > `last_read_message_id` per
(subject, network, channel)) that pass `Grappa.Push.Triggers.should_notify?`
over the subject's notification prefs (DMs all/whitelist, channels
all/whitelist, mentions). Capped at 99. Fully derived — no new
persisted state (CLAUDE.md design discipline rule 1).

Consequences accepted by vjt:
- No push subscription ⇒ no closed-app badge (badge mirrors notify set
  by construction).
- Closed phone + reading on desktop ⇒ phone badge stale until next
  push or app open. No silent-push pipeline to fix this; not worth it.

## Server — one context function, three doors

`Grappa.Push.BadgeCount.count(subject) :: 0..99` — bounded, never a
table scan:
- DM / channel-whitelist / channels-all prefs branches: pure SQL
  index-range COUNT over the unread tail, per-channel LIMIT cap
  (subquery shape: `SELECT COUNT(*) FROM (SELECT 1 ... LIMIT cap)`).
- mentions branch: `LIKE '%nick%'` prefilter on the unread tail ONLY
  (~200 rows/channel cap), candidates verified with the REAL
  `Mentions.mentioned?` + `should_notify?` — predicate reused, never
  reimplemented server-side.
- early-bail at the 99 cap.

Doors (one feature, one code path):
1. Push payload gains `badge:` — computed at dispatch in
   `Triggers.evaluate_and_dispatch/2` (verify the triggering message is
   already persisted at that point so the count includes it).
2. `/me` envelope gains `badge_count` (boot seed; rides
   `bulk_for_subject` territory in the controller).
3. `read_cursor_set` broadcast (`Grappa.ReadCursor.Wire`) gains
   `badge_count` — reading anywhere updates every listening client.

## cicchetto

- `src/lib/badge.ts`: one signal + one effect →
  `navigator.setAppBadge(n)` / `clearAppBadge()` (feature-detected)
  AND the document.title mirror `(n) <base>` (vjt opted IN to the
  title mirror — it is also the only e2e-observable surface).
- Foreground sources: seed from `/me`; update on `read_cursor_set`;
  increment on arriving messages via a small TS `shouldNotify()`
  mirror of the server predicate (needed so the desktop title moves on
  unfocused-tab mentions). Drift-proofing: TS mirror and Elixir
  predicate both run against ONE shared truth-table JSON fixture
  (ExUnit + vitest consume the same file — wireTypes-style parity).
- Service worker (`src/service-worker.ts` `handlePush`):
  `self.navigator.setAppBadge(payload.badge)` — the server's number,
  NO SW-local counter, no IndexedDB. Runs even when the notification
  toast is suppressed by `shouldSuppressPush` (badge update is not
  intrusive). Payloads without `badge` (old server) → skip.
  `narrowPushPayload` widens accordingly (optional field).

## Tests

- ExUnit `BadgeCount`: every prefs branch, cap behavior, no-cursor
  channel (counts capped, not unbounded), mention-window cap,
  truth-table parity cases.
- Wire shape: payload `badge`, `/me` `badge_count`, `read_cursor_set`
  `badge_count`.
- vitest: badge effect (navigator mock), title format, SW badge call,
  TS `shouldNotify` truth-table parity (same JSON as ExUnit).
- e2e: extend a push spec — push-catcher asserts `badge >= 1` in the
  payload; title-mirror assertion on `document.title` after a DM.
- iOS `setAppBadge` may require granted notification permission —
  device dogfood verifies (Playwright cannot see home-screen icons).

## Infrastructure map (from recon, 2026-06-11)

- Read cursors: `lib/grappa/read_cursor.ex` (`get/3`, `set/4`,
  `bulk_for_subject/1`, `broadcast_set/4`), wire at
  `lib/grappa/read_cursor/wire.ex:42-60`.
- Push triggers: `lib/grappa/push/triggers.ex:97-150`
  (`evaluate_and_dispatch/2`, `should_notify?/4`); payload builder
  `lib/grappa/push/payload.ex:87-107` (`{title, body, tag, url}`);
  sender `lib/grappa/push/sender.ex` (`send_to_subject/2`).
- Prefs: `lib/grappa/user_settings.ex:91-97` (`notification_prefs`).
- cic unread memos: `src/lib/selection.ts:212-298`
  (`perChannelUnread`, `messagesUnread`, `eventsUnread`,
  `unreadCounts`); mentions: `src/lib/mentions.ts:24-46`.
- SW: `src/service-worker.ts:101-154` (push handler), payload narrower
  `src/lib/pushPayload.ts:26-31`; registration `src/main.tsx:196`.
- Platform helpers: `src/lib/platform.ts` (`isIos`,
  `isStandalonePwa`).
- No badge code exists anywhere yet.
