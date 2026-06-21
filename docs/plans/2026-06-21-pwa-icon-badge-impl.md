# PWA icon badge — implementation plan (TDD, derived from the approved design)

Design spec (LOCKED, vjt-approved 2026-06-12):
`docs/plans/2026-06-12-pwa-icon-badge.md`. This file is the executable
TDD breakdown — phases bottom-up, each a red→green cycle with exact
anchors re-grounded against HEAD (`0cb6285`) on 2026-06-21. Do NOT
re-litigate semantics; the spec settled them.

Branch `vjt-claude/pwa-badge`, worktree `.claude/worktrees/pwa-badge`.

## One feature, one predicate, three doors

Predicate = `Grappa.Push.Triggers.should_notify?/4` (reused verbatim,
never reimplemented). Server count =
`Grappa.Push.BadgeCount.count(subject) :: 0..99`. Doors: (1) push
payload `badge`, (2) `/me` `badge_count`, (3) `read_cursor_set`
`badge_count`. cic: `badge.ts` signal+effect → `setAppBadge` +
`document.title` mirror.

## Grounded anchors (re-verified 2026-06-21 — line numbers are HEAD)

- `Grappa.Push.Triggers.should_notify?/4` — `lib/grappa/push/triggers.ex:139`.
  `evaluate_and_dispatch/2` (`:97`) spawns a Task AFTER `persist_event`,
  builds `Payload.build/3`, calls `Sender.send_to_subject/2`. ctx carries
  `:subject, :network_slug, :own_nick` (live nick).
- `Grappa.Mentions.mentioned?/3` — `lib/grappa/mentions.ex:144`. Word-boundary,
  caseless, `own_nick | patterns`. cic mirror `mentionMatch.ts:12 mentionsUser`.
- `Grappa.Scrollback.count_after/5` — `lib/grappa/scrollback.ex:364`. THE model
  query: `subject_where |> network_id |> channel_or_dm_where(channel, own_nick)
  |> m.id > after_id |> count`. `channel_or_dm_where/3` (`:622`) handles DM vs
  channel windows (nick-shaped → `channel == ^c OR dm_with == ^c`).
- `Grappa.ReadCursor.bulk_for_subject/1` — `read_cursor.ex:168` →
  `%{slug => %{channel => last_read_id|nil}}`. `broadcast_set/4` (`:206`) →
  `Wire.read_cursor_set/1` (`wire.ex:54`), payload `%{kind, last_read_message_id}`.
- `UserSettings.get_notification_prefs/1` (`user_settings.ex:270`),
  `get_highlight_patterns/1` (`:168`), `default_notification_prefs/0` (`:246`).
  prefs shape: `channel_messages_all|_only, channel_mentions,
  private_messages_all|_only`.
- own_nick per network: `Networks.resolve_network_nick(user_id, cred)`
  (`networks.ex:411`, asks live Session, falls back to `cred.nick`).
  BadgeCount stays OFF live Session (see Phase 1 decision).
- `GrappaWeb.MeController.show/2` (`me_controller.ex:90`) already renders
  `read_cursors` + `unread_counts` via `bulk_for_subject` + `count_after_split`.
  Door #2 rides this exact assembler.
- codegen: `mix grappa.gen_wire_types [--check]`, glob `lib/grappa/**/wire.ex`,
  output `cicchetto/src/lib/wireTypes.ts`. ONLY `ReadCursor.Wire` is under the
  glob → only door #3 trips `--check`.
- cic hooks (Explore recon 2026-06-21):
  - `pushPayload.ts:26 PushPayload` + `narrowPushPayload` (add optional `badge`).
  - `service-worker.ts:122 handlePush` (+ `shouldSuppressPush` from `pushDedup.ts`);
    `self.registration.showNotification` at `:147`; `self.navigator.setAppBadge`
    reachable. Badge update must run EVEN when push toast suppressed.
  - `api.ts:147 MeResponse` (hand-rolled; add `badge_count?: number`);
    applied in `networks.ts:47` (`applyMeEnvelope`) + `selection.ts:190`
    (`applySeedEnvelope` effect on `user`).
  - `api.ts:543 WireChannelEvent read_cursor_set` + `wireNarrow.ts:284`
    narrower + `subscribe.ts:366 applyReadCursorSet` dispatch.
  - `platform.ts` exports `isIos, isStandalonePwa, ...` (no badge/permission helper).
  - parity today = structural `wireTypesAssert.ts` `Equal<A,B>`; NO shared
    runtime JSON truth-table exists → Phase 5 creates it.
  - `document.title` — unused (no current writer). `navigator.setAppBadge` —
    unused. `Notification.permission` read in `push.ts:233`.

---

## Phase 1 — `Grappa.Push.BadgeCount` (server heart) — RED→GREEN

New `lib/grappa/push/badge_count.ex`. `count(subject) :: 0..99`.

**Algorithm**: `cursors = ReadCursor.bulk_for_subject(subject)`;
`prefs`, `patterns` once. Fold over `{slug, channel, cursor}` (skip
`nil` cursor like `/me` does), resolve `network_id` from slug index,
accumulate per-channel notify-worthy unread count, **early-bail at 99**.

Per-channel branch selection (mirrors `should_notify?` structure but at
the SQL/aggregate level, NOT a reimplementation of the predicate — the
mention gate calls the REAL `Mentions.mentioned?`):
- **DM window** (channel is nick-shaped, i.e. `channel_or_dm_where`
  treats it as a peer): `private_messages_all` → capped COUNT of unread
  DM rows; else `private_messages_only` → capped COUNT where
  `lower(sender) IN whitelist`; else 0.
- **Channel window** (`#`/`&`-shaped): `channel_messages_all` OR channel
  in `channel_messages_only` → capped COUNT of unread content rows; else
  if `channel_mentions` → **mention branch**: fetch capped unread
  content tail (`@mention_cap ~200`, `body LIKE` prefilter on
  `own_nick`+patterns as an index-friendly narrowing), verify each
  candidate with `should_notify?` (which calls `Mentions.mentioned?`);
  count matches. else 0.
- per-channel COUNT capped (`@per_channel_cap`, subquery
  `SELECT COUNT(*) FROM (SELECT 1 ... LIMIT cap)`); only content kinds
  (`:privmsg|:notice|:action`) count (events never notify).

**own_nick decision (LOCKED here)**: resolved per network from the
*configured* nick — user → credential nick, visitor → `visitor.nick` —
NOT the live `Session.current_nick`. Rationale: door #3 runs on every
read-cursor settle (hot); a GenServer round-trip per network there is
unacceptable, and `/me` already takes the same off-Session stance.
Accepted staleness: after a `/nick` rename the mention match uses the
configured nick until reconnect. Documented in moduledoc + DESIGN_NOTES.
own_nick is needed ONLY in the mention branch — resolve it lazily and
memoize per network inside the fold.

**Boundary**: `use Boundary` deps need ReadCursor, Scrollback, Mentions,
UserSettings, Networks, Push(self), Subject — wide aggregation context.
If a cycle appears (Networks ↔ Push), resolve own_nick via a narrower
read (credential nick lookup) rather than the full `resolve_network_nick`.
Decide at green time; do not pre-engineer.

**Tests** (`test/grappa/push/badge_count_test.exs`):
1. no cursors → 0. 2. DM-all counts unread inbound DMs; DM-whitelist
counts only whitelisted senders; DM prefs off → 0. 3. channel-all counts
unread content; channel-whitelist; channel not whitelisted + mentions
off → 0. 4. mention branch: nick mention counts; pattern mention counts;
non-mention in same channel does NOT. 5. events (`:join` etc.) never
count. 6. per-channel cap: 250 unread in one channel with channels-all →
capped contribution, not 250. 7. global 99 cap + early bail. 8. nil
cursor channel skipped. 9. visitor subject path. 10. own_nick staleness:
documented, mention uses configured nick. 11. truth-table parity cases
(shared fixture, added in Phase 5 — back-reference here).

Gate: `scripts/check.sh` (mix test + dialyzer + format + credo).

---

## Phase 2 — Door #1: push payload `badge` — RED→GREEN

`Triggers.evaluate_and_dispatch/2`: inside the spawned Task, after the
`should_notify?` gate passes, compute `badge = BadgeCount.count(subject)`
and merge `badge:` into the payload before `Sender.send_to_subject`.
The triggering message is ALREADY persisted (Task runs post
`persist_event` per moduledoc) so the count includes it — assert this in
test (badge ≥ 1 when the trigger itself is notify-worthy).

- `Payload.t()` (`payload.ex:66`) + `Sender.payload()` (`sender.ex:120`)
  gain `optional(:badge) => non_neg_integer()`. `Payload.build/3` stays
  pure (no badge — it has no DB); badge is merged in Triggers.
- `Sender.send_to_subscription/2` already `Jason.encode!`s the whole map
  → `badge` rides for free.

**Tests**: `triggers_test.exs` — payload passed to Sender carries
`badge` = BadgeCount for the subject (mock/inject BadgeCount or assert
against a seeded DB); old non-notify path unchanged. `payload_test.exs`
— `build/3` still returns the 4-field map (badge NOT added here).

---

## Phase 3 — Door #2: `/me` `badge_count` — RED→GREEN

`MeController.show/2`: add `badge_count: BadgeCount.count(subject)` to
both `:user` and `:visitor` render calls. `MeJSON.show/1` emits
`badge_count` (integer) in both clauses.

**Tests**: `me_controller_test.exs` — response includes `badge_count`;
value matches a seeded notify-worthy unread set; 0 when nothing unread.

---

## Phase 4 — Door #3: `read_cursor_set` `badge_count` — RED→GREEN

RECON FIRST: read the read-cursor POST controller (the `broadcast_set/4`
call site) — it has the subject in scope, needed to compute BadgeCount
AFTER the set.

- `ReadCursor.Wire.read_cursor_set/2` (arity bump) → payload
  `%{kind, last_read_message_id, badge_count}`. Update `@type` +
  `@spec`.
- `ReadCursor.broadcast_set/5` (arity bump) takes `badge_count`, OR a
  variant that takes the subject and computes it. Prefer: caller (POST
  controller) computes `BadgeCount.count(subject)` after the successful
  `set/4` and passes it down — keeps ReadCursor free of a Push dep
  (avoid Push ↔ ReadCursor cycle). Verify boundary at green time.
- regen: `mix grappa.gen_wire_types` (Wire `@type` changed) → commit the
  updated `wireTypes.ts`. `--check` must pass in `scripts/check.sh`.

**Tests**: `read_cursor/wire_test.exs` — payload shape carries
`badge_count`. Controller test — POST read-cursor broadcasts an event
whose `badge_count` reflects the post-set count (reading a mentioned
channel drops it).

---

## Phase 5 — TS `shouldNotify` mirror + shared truth-table — RED→GREEN

The drift-proofing keystone. New `cicchetto/src/lib/pushTriggers.ts`
`shouldNotify(message, ownNick, prefs, patterns): boolean` — a faithful
mirror of `should_notify?/4` (DM all/whitelist; channel all/whitelist;
mention via `mentionsUser` from `mentionMatch.ts`).

Shared fixture `test/support/fixtures/should_notify_truth_table.json`
(or a path both suites can read) — array of
`{name, message, own_nick, prefs, patterns, expected}` cases covering
every branch + edge (caseless sender, pattern-only mention, DM vs
channel, events).

- ExUnit `should_notify_parity_test.exs` reads the JSON, runs each case
  through `Triggers.should_notify?/4`, asserts `expected`.
- vitest `pushTriggers.test.ts` reads the SAME JSON, runs each through
  `shouldNotify`, asserts `expected`.
- Add a case → both suites pick it up. Phase 1 truth-table tests
  reference this fixture too.

Gate: cic real type gate is `bun run build` (NOT `bun run check` — biome
red masks tsc, `feedback_cic_check_gate_masks_tsc`). Run vitest + build.

---

## Phase 6 — cic `badge.ts` — RED→GREEN

New `cicchetto/src/lib/badge.ts`: `[badge, setBadge]` signal (0..99) +
one `createEffect` → feature-detected `navigator.setAppBadge(n)` /
`clearAppBadge()` when `n === 0`, AND `document.title` mirror
`(n) <base>` (n>0) / `<base>` (n===0). Title mirror is the ONLY
e2e-observable surface.

**Tests** (`badge.test.ts`): effect calls `setAppBadge(3)` with
navigator mock; `clearAppBadge` at 0; title format `(3) grappa` / bare
base at 0; `setAppBadge` absent (unsupported) → no throw.

---

## Phase 7 — cic wiring — RED→GREEN

- `/me` seed: read `m.badge_count` → `setBadge` (in the `selection.ts`
  effect-on-`user` or `networks.ts` apply site).
- `read_cursor_set`: `subscribe.ts` dispatch reads `badge_count` →
  `setBadge`. Add `badge_count` to `api.ts` `WireChannelEvent` arm +
  `wireNarrow.ts` narrower (number).
- arriving message increment: when a new scrollback message arrives and
  the tab is NOT the source of a cursor advance, run `shouldNotify`
  (Phase 5) against current prefs/nick; if true and the row is unread,
  `setBadge(badge()+1)` (cap 99). This is what moves the DESKTOP title on
  an unfocused-tab mention. Keep server values authoritative (seed +
  read_cursor_set overwrite the local increment).

**Tests**: vitest — `/me` seed sets badge; `read_cursor_set` overwrites;
unfocused mention increments; focused-read resets via broadcast.

Grep `cicchetto/e2e/tests` for any title assertions before changing the
title format (`feedback_grep_e2e_on_render_change`).

---

## Phase 8 — service worker `setAppBadge` — RED→GREEN

`service-worker.ts handlePush`: after (or independent of)
`showNotification`, call `self.navigator.setAppBadge(payload.badge)` when
`payload.badge !== undefined` — feature-detected, `.catch(()=>{})`. Runs
EVEN when `shouldSuppressPush` short-circuits the toast (badge is
non-intrusive). `narrowPushPayload` (`pushPayload.ts`) widens `badge?:
number` (optional; old server without it → skip, no SW-local counter).

**Tests**: vitest/SW unit — `handlePush` with `badge` calls
`setAppBadge`; without `badge` does not; suppressed-toast still badges.

---

## Phase 9 — e2e — RED→GREEN

Extend an existing push spec under `cicchetto/e2e/tests`: push-catcher
asserts `badge >= 1` in the caught payload after a DM; assert
`document.title` mirrors `(n) ...` after the DM arrives. `testnet.sh`
auto-inits the e2e submodule (`feedback_e2e_worktree_landmines`).

iOS `setAppBadge` (home-screen icon) is NOT Playwright-observable and
needs GRANTED notification permission → **device dogfood** is the only
real verification of the icon itself. Flag it for vjt at close.

---

## Gates / landmines (standing)

- `scripts/check.sh` green each server phase (mix test, dialyzer, format, credo).
- `gen_wire_types --check` WILL fire on Phase 4 — regen + commit `wireTypes.ts`.
- cic type gate = `bun run build`, not `bun run check`.
- Deploy: server reload (HOT — config allowlist likely unchanged) + `--cic`
  bundle. Batch into ONE restart window. Device dogfood for the icon.
- After: `/start` re-flags the still-DUE codebase review.
