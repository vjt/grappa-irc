# Event-driven windows — implementation plan

Companion to [`2026-05-07-event-driven-windows.md`](2026-05-07-event-driven-windows.md)
(intent doc, brainstorm-pinned 2026-05-07). The intent doc is the
**why** + the **what**; this plan is the **how** — file paths,
function signatures, TDD steps, exit criteria per bucket. Resolves
every "Implementation-time question" the intent doc deferred.

> **Read this with the intent doc open.** This plan does not repeat
> the architectural rationale; it picks up where the intent doc says
> "deferred to plan doc."

## Open questions — recommended resolutions (PENDING vjt sign-off)

These are the resolutions the impl plan proposes for the deferred
questions. **Pin only after vjt review** (separate "Decisions pinned
2026-05-NN vjt" section appended below before B1 starts).

### Q1. Visitor JOIN path emits the same events?

**Recommended: yes, no special-case.**

`Grappa.Visitors.SessionPlan.resolve/1` produces the same shape as
`Grappa.Networks.SessionPlan.resolve/1` — both feed
`Grappa.Session.Server.start_link/1`, which holds the `subject` only
to discriminate persist target + the optional `visitor_committer`
callback. EventRouter NEVER reads `subject` outside `build_persist`
(it routes purely on `command:` + `params:` of the inbound IRC line).
Therefore: a visitor's JOIN echo arrives via the same
`{:irc, %Message{command: :join, ...}}` tuple → same EventRouter
clause → same `:joined` effect emission. The per-channel topic
shape is `Topic.channel(state.subject_label, state.network_slug,
channel)` — `subject_label` is `"visitor:<uuid>"` for visitors, real
user_name for users; cic's per-subject WS routing already isolates
correctly (CP10/Task 6.5).

**Rationale**: keeping the path uniform avoids a special-case branch
in EventRouter that would need re-validation every time a new event
class is added. The cost is zero — the visitor surface is bytewise
identical.

**Verification**: B1 RED test seeds a visitor `state` (subject =
`{:visitor, uuid}`) and asserts the same `{:joined, channel}` effect
fires from the JOIN echo. Locked in by test, not by branch.

### Q2. Bootstrap autojoin failures: same `:join_failed` shape, or bootstrap-specific event?

**Recommended: same shape.**

Bootstrap-time autojoin (`Grappa.Session.Server.handle_info` 001 clause
at `lib/grappa/session/server.ex:895-929`, calls
`Client.send_join/2` for each `state.autojoin` channel) is operationally
indistinguishable from a runtime user-initiated JOIN — same upstream
JOIN line, same potential failure numerics from the same upstream
ircd. `:join_failed` carries `{network, channel, reason, numeric}` —
the same payload covers both cases.

cic's reaction: a bootstrap-time `:join_failed` arriving on the
per-channel topic for a channel cic doesn't yet have an open window
for falls into the catch-all "unfocused failed autojoin" case. cic's
sidebar derives "channels for this network" from existing surfaces
(GET /channels for joined; GET /networks/:slug/archive for archived)
— a failed autojoin channel is NOT in either; the failure is
visible at the operator's choice via the archive section (B4) when
they look. No silent loss; no special UI either.

**Alternative considered**: emit a separate `:autojoin_failed` event
with a "this was a boot-time failure" hint for cic to surface as a
banner. Rejected: extra surface for a marginal UX delta, and the
information ("which channels you wanted at boot but couldn't reach")
is recoverable from `state.autojoin` keyset minus joined keyset.

### Q3. `/archive` REST shape: single endpoint or per-kind sub-endpoints?

**Recommended: single endpoint.**

`GET /networks/:slug/archive` returns a flat list mixing channels +
queries, sorted by `last_activity desc`. Per-row `kind` field
(`"channel" | "query"`) discriminates. Matches the intent doc's
"mixed list … sorted by last_activity desc."

Response shape:
```json
[
  {"target": "#sniffo", "kind": "channel", "last_activity": 1778000000, "row_count": 576},
  {"target": "vjt-irssi", "kind": "query", "last_activity": 1777900000, "row_count": 8}
]
```

**Alternative considered**: `/archive/channels` + `/archive/queries`.
Rejected: the mixed sort requires recombining client-side anyway, two
round-trips with no semantic gain.

**Implementation**: new `Grappa.Scrollback.list_archive/2` query —
groups `messages` by `(channel, dm_with)`, joins against `state.members`
keyset (channels currently in active state) AND
`QueryWindows.list_for_user/1` keyset (active query windows). The
"NOT in active state" predicate runs in Elixir, not SQL, because
`state.members` is in-process GenServer state.

**Implementation note** (deferred follow-up): consider an Ecto query
that returns `(target, server_time_max, count)` per group; minus the
active-state filter step. The SQL needs `dm_with` to coalesce inbound
DMs with their peer name (CP14 B3 already populates `:dm_with` so
the COUNT is correct). For channels the GROUP BY key is `channel`;
for DMs it's `COALESCE(dm_with, channel)` only when the row is
DM-shaped (kind in `:privmsg | :action` AND nick-shaped). May land as
two separate queries (channels + DMs, both `GROUP BY` + `MAX` +
`COUNT`) for clarity. B4 RED test pins the exact response shape.

### Q4. `state.window_state` schema — atom in GenServer state vs separate ETS/registry?

**Recommended: GenServer state, on-process.**

A new field `window_states: %{String.t() => window_state()}` on
`Session.Server`'s state map. Atom enum:
`:pending | :joined | :failed | :kicked | :parked`. Sibling to
`state.members`, identical lifetime + supervision. No ETS table, no
new Registry entry — those introduce process boundaries we don't need.

**Alternative considered**: separate ETS owned by Session.SessionRegistry
so cic could read state without an RPC. Rejected: cic only reads via
WS broadcasts (`:window_state` event); REST already goes through
`Session.list_channels/2` etc. which RPCs into the Session.Server.
Adding ETS doubles the source of truth (Tony Hoare etc.).

**Type definition** (added to `lib/grappa/session/server.ex` `state`
typespec):
```elixir
@type window_state :: :pending | :joined | :failed | :kicked | :parked
@type window_states :: %{(channel :: String.t()) => window_state()}
```

The map key is the channel string (case-preserved, like `state.members`).
Lookups normalize via `String.downcase/1` at read sites — same convention
as topics + channel_modes caches.

### Q5. Window-state persistence across server restart — derive or persist?

**Recommended: derive on boot.**

After a Session.Server restart, the autojoin loop (existing 001 handler)
fires `Client.send_join/2` for each `state.autojoin` channel.
Pre-001-completion the keyset is empty (`window_states = %{}`); on
each JOIN echo a `:joined` transition appends `{channel => :joined}`;
on each failure numeric the in-flight map matches and appends
`{channel => :failed}`. Within ~1s of a restart the state is fully
populated by the same code path that handles steady-state JOINs.

For channels that were `:archived` on the cic side (PART or × with
scrollback rows) before the restart: those are NOT in `state.autojoin`,
NOT in `state.members`, but ARE in scrollback — they live in the
archive surface (B4). The window-state map has no entry for them.
Cic's sidebar reads them from `GET /networks/:slug/archive`, derives
their state as `:archived`. The Server's window_states map is the
source of truth ONLY for currently-tracked windows; `:archived`
lives outside.

**Alternative considered**: persist `window_states` to a new sqlite
table indexed by `(network_id, channel)`. Rejected: derivation is
free, persistence creates a sync invariant we'd have to maintain
across every state transition + a rebuild path on schema migrations.
The cluster's whole premise is "use what's already authoritative."

### Q6. Mobile archive layout — separate collapsible tab vs nested in active network group?

**Recommended: nested, follow Sidebar shape.**

Mobile `BottomBar.tsx` already groups by network (one network header
per row, channels horizontally scrollable beneath). Adding an archive
section inline as a second collapsible row beneath each network's
active windows row keeps the model identical to desktop Sidebar.
Bottom bar reads from the same `archivedWindows` resource as the
desktop Sidebar.

**Alternative considered**: a global "Archive" tab + horizontal
network swiper. Rejected: doubles the navigation paradigm
(per-network everywhere else, global only for archive) — operator
mental model fragments.

**Defer**: exact CSS / collapse-affordance to B4 implementation.
Behavior contract pinned now; pixel-level visual is implementation
detail.

### Q7. /join slash-command parser — present?

**Confirmed present** at `cicchetto/src/lib/slashCommands.ts:133-137`
(emits `{kind: "join", channel}` SlashCommand). Dispatched in
`cicchetto/src/lib/compose.ts:197` `case "join"`. No new parser
work needed for B5 — operator can already type `/join #chan` and
the existing path runs POST /channels.

**Implication for archive UI (B4)**: the "Join" button on archived
channel windows fires the same `postCreateChannel(slug, channel)` REST
call that `/join` already does. Single code path, no new handler.

### Q8. Failure numeric → window mapping fallback when no in-flight match?

**Recommended: fall back to `$server`.**

Three layers of attribution priority for failure numerics
(471/473/474/475/403/405):
1. **Labeled-response cap**: if active AND the numeric carries a
   `label` tag matching `state.labels_pending`, the recorded
   origin_window wins. Maximum precision. Already implemented for
   404 etc. via `NumericRouter.label_lookup/2`.
2. **In-flight JOIN map**: B2 introduces `state.in_flight_joins ::
   %{channel_name_lower => {channel, monotonic_at_ms, label?}}`.
   On every JOIN cast (cic-initiated via `handle_cast({:send_join,
   channel}, state)` AND autojoin via the 001 handler), insert
   `{normalize(channel), {channel, ts, label}}`. On failure numerics,
   look up by the `<channel>` param (numeric position 2 for 471/473/
   474/475/403; position 1 for 405 — verify per-numeric in B2). Match
   → emit `:join_failed` for that channel, remove the in-flight entry.
3. **Fallback**: no match → route to `$server` via existing
   NumericRouter scan (the failure numeric still gets a persist row
   on `$server` so the operator can see the diagnostic).

**TTL on in-flight entries**: 30s soft cap, swept lazily on next
insert. Race window: an upstream that takes >30s to reply with a
failure numeric (extremely rare; bahamut + ircd-seven reply in
sub-second). The fallback to `$server` covers this; no row lost.

**Alternative considered**: persist in-flight indefinitely + reap on
session restart. Rejected: long-tail entries clutter state for no
operational value.

## Bucket plans

### B1 — server-side `:joined` event + emit on JOIN echo

#### Files touched

- `lib/grappa/session/event_router.ex` — extend the `:join` clause
  (currently at `lib/grappa/session/event_router.ex:198-237`) to
  emit a `{:joined, channel}` effect when the JOIN sender == own_nick
  (the existing `if sender == state.nick` branch).
- `lib/grappa/session/event_router.ex` — extend the `@type effect`
  union (`lib/grappa/session/event_router.ex:163-170`) with
  `{:joined, String.t()}`.
- `lib/grappa/session/server.ex` — add `window_states: %{}` to
  `init/1` state seed (currently at
  `lib/grappa/session/server.ex:302-331`), add type to the `state()`
  typespec at `lib/grappa/session/server.ex:194-246`.
- `lib/grappa/session/server.ex` — add `apply_effects` clause for
  `{:joined, channel}` (sibling to the `{:members_seeded, ...}`
  arm at `lib/grappa/session/server.ex:1570-1593`). Updates
  `state.window_states[channel] = :joined` AND broadcasts
  `%{kind: "joined", network: slug, channel: channel,
  state: "joined"}` on the per-channel topic.
- `test/grappa/session/event_router_test.exs` — RED test for
  `:joined` emission on self-JOIN echo, both user + visitor subject
  fixtures.
- `test/grappa/session/server_test.exs` — RED test for state mutation
  + broadcast (subscribe to per-channel topic, fire `{:irc, %Message{
  command: :join, ...}}`, assert `{:event, %{kind: "joined", ...}}`
  arrives).

#### TDD sequence

1. RED: EventRouter unit test asserts a self-JOIN with sender ==
   state.nick produces both the existing `{:persist, :join, _}`
   effect AND a new `{:joined, channel}` effect. Fails: only
   `:persist` emitted today.
2. GREEN: extend the `:join` route clause to append
   `{:joined, channel}` to the effect list when `sender == state.nick`.
3. RED: Session.Server integration test subscribes to the per-channel
   topic, sends `{:irc, %Message{command: :join, sender: own,
   params: [channel]}}` to the Server, asserts state.window_states
   gains the entry AND `{:event, %{kind: "joined", state: "joined"}}`
   arrives on the topic.
4. GREEN: add the `apply_effects` `:joined` arm + state seed.
5. Other-nick JOIN unchanged: assert no `:joined` effect for non-self
   sender (regression test).

#### Exit criteria

- `scripts/check.sh` exit 0 (zero-warning + zero-error: format/credo/
  dialyzer/sobelow/doctor/test/mix audit/hex audit).
- Literal gate-tail paste in CP15 B1 entry.
- Other-user JOINs continue to behave as before (no broadcast).
- Per-bucket cadence: ff-merge to main → push → deploy → healthcheck
  → BROWSER SMOKE NOT REQUIRED (no cic-side change in B1; the event
  surface is server-only and cic ignores unknown `kind:` values).

### B2 — server-side `:join_failed` + in-flight JOIN map + failure numeric routing

#### Files touched

- `lib/grappa/session/server.ex` — new `state.in_flight_joins ::
  %{String.t() => {channel :: String.t(), at_ms :: integer(),
  label :: String.t() | nil}}`. Insert site:
  - `handle_cast({:send_join, channel}, state)` at
    `lib/grappa/session/server.ex:785-788`.
  - The 001 autojoin loop at
    `lib/grappa/session/server.ex:895-929` (one insert per channel
    in the `Enum.each`).
  - The unsupervised `handle_continue({:join_unattended, _}, _)` if
    any (verify in code).
- `lib/grappa/session/event_router.ex` — add new clauses for the
  failure numerics (471 + 473 + 474 + 475 + 403 + 405), each
  emitting a `{:join_failed, channel, reason, numeric}` effect when
  the channel param matches the in-flight map.
  - **Caveat**: EventRouter is pure — it doesn't read
    `state.in_flight_joins` directly via env, but `state` IS the
    second argument and `in_flight_joins` lives there. Match via
    `Map.get(state.in_flight_joins, normalize(channel))`. Strip the
    matched entry from the returned `next_state`.
  - Numeric param positions (RFC 2812 + RPL):
    - 471 ERR_CHANNELISFULL: `:server 471 own_nick #chan :Cannot join channel (+l)`
    - 473 ERR_INVITEONLYCHAN: `:server 473 own_nick #chan :Cannot join channel (+i)`
    - 474 ERR_BANNEDFROMCHAN: `:server 474 own_nick #chan :Cannot join channel (+b)`
    - 475 ERR_BADCHANNELKEY: `:server 475 own_nick #chan :Cannot join channel (+k)`
    - 403 ERR_NOSUCHCHANNEL: `:server 403 own_nick #chan :No such channel`
    - 405 ERR_TOOMANYCHANNELS: `:server 405 own_nick #chan :You have joined too many channels`
    All have channel at `params[1]` (params[0] = own_nick echo).
- `lib/grappa/session/numeric_router.ex` — add the 6 failure numerics
  to `@delegated_numerics` (currently at
  `lib/grappa/session/numeric_router.ex:131-156`) so the existing
  scan-based routing doesn't double-process them. EventRouter handles
  them now.
- `lib/grappa/session/server.ex` — add `apply_effects` clause for
  `{:join_failed, channel, reason, numeric}`. Updates
  `state.window_states[channel] = :failed`, stores
  `state.window_failure_reasons[channel] = reason` (new field), AND
  broadcasts `%{kind: "join_failed", network: slug, channel: channel,
  state: "failed", reason: reason, numeric: numeric}` on the
  per-channel topic. Also persists a `:notice` row on the channel
  scrollback so the failure shows in the window's history.
- `lib/grappa/session/server.ex` — TTL sweeper: lazy O(1)-amortized
  drop of entries older than 30s on each `:send_join` insert. No
  separate timer.
- `test/grappa/session/event_router_test.exs` — RED tests for each of
  the 6 numerics, both with-match and no-match cases.
- `test/grappa/session/server_test.exs` — RED test for the in-flight
  insert + broadcast on a 473 numeric.

#### TDD sequence

1. RED: Server test casts `{:send_join, "#sniffo"}`, asserts
   `state.in_flight_joins["#sniffo"]` populated with `{channel,
   at_ms, nil}`.
2. GREEN: extend the cast clause + autojoin loop to insert.
3. RED: EventRouter unit test fires a 473 with `params = [own,
   "#sniffo", "Cannot join channel (+i)"]` against a state with
   `in_flight_joins["#sniffo"]` set. Asserts a `{:join_failed,
   "#sniffo", "Cannot join channel (+i)", 473}` effect AND the
   in-flight entry stripped from `next_state`.
4. GREEN: add the EventRouter clauses + apply_effects arm.
5. RED: Server integration test subscribes to channel topic, casts
   send_join, then fires the IRC line, asserts the broadcast arrives
   AND state.window_states["#sniffo"] = :failed.
6. RED: TTL test — insert entry, advance monotonic clock by >30s,
   call send_join for a different channel, assert old entry swept.
   GREEN: implement lazy sweep helper.
7. RED: no-match case — fire 473 with no in-flight entry. Assert
   no `:join_failed` effect (falls through to existing
   NumericRouter `$server` route).

#### Exit criteria

- `scripts/check.sh` exit 0 + literal gate-tail.
- All 6 failure numerics covered.
- B2 deploy + healthcheck. NO browser smoke (server-only surface).

### B3 — `:parted`/`:kicked`/`:window_state` events + push_channel_snapshot extension

#### Files touched

- `lib/grappa/session/event_router.ex` — extend the `:part` clause
  (`lib/grappa/session/event_router.ex:239-318`) to emit
  `{:parted, channel}` effect when sender == state.nick. Extend the
  `:kick` clause (`lib/grappa/session/event_router.ex:465-536`) to
  emit `{:kicked, channel, by, reason}` when target == state.nick.
- `lib/grappa/session/server.ex` — `apply_effects` arms for
  `{:parted, channel}` (state.window_states[channel] removed entirely
  → window state inferred from absence + scrollback presence as
  `:archived` by cic) and `{:kicked, channel, by, reason}`
  (state.window_states[channel] = :kicked, broadcast on per-channel
  topic).
- `lib/grappa_web/channels/grappa_channel.ex:637-653` — extend
  `push_channel_snapshot/4`:
  - Push cached `members_seeded` if `state.members[channel]` is
    non-empty (new private function `push_members_if_seeded/4`
    sibling to `push_topic_if_cached/4`).
  - Push current `window_state` if known (new private function
    `push_window_state_if_known/4`). Uses a new
    `Session.get_window_state/3` lookup helper.
- `lib/grappa/session.ex` — new public verb
  `get_window_state(subject, network_id, channel) :: {:ok,
  window_state()} | {:error, :no_session | :not_tracked}`. Mirror of
  `get_topic/3` shape.
- `lib/grappa/session/server.ex` — `handle_call({:get_window_state,
  channel}, _, state)` clause.
- `test/grappa/session/event_router_test.exs` — RED for both
  `:parted` (self-PART → effect emitted) + `:kicked`
  (self-target KICK → effect emitted with by + reason).
- `test/grappa_web/channels/grappa_channel_test.exs` — RED for
  push_channel_snapshot pushing `members_seeded` + `window_state` on
  after_join when state is populated.

#### TDD sequence

1. RED: EventRouter test for self-PART emitting `{:parted, channel}`.
2. GREEN: add to `:part` clause.
3. RED: EventRouter test for self-target KICK emitting `{:kicked,
   channel, by, reason}`.
4. GREEN: add to `:kick` clause.
5. RED: Channel test simulates after_join with seeded members + state
   = `:joined`; asserts both `members_seeded` event + `window_state`
   event pushed to socket.
6. GREEN: extend `push_channel_snapshot/4`.

#### Exit criteria

- `scripts/check.sh` exit 0 + gate-tail.
- B3 closes the deploy-reconnect race documented in intent doc.
- DEPLOY + HEALTHCHECK + BROWSER SMOKE: cic-touching surface change
  (cic side gains a useful event but doesn't yet handle it; smoke
  validates the existing surfaces still work).

### B4 — REST `/networks/:slug/archive` + cic archive store + Sidebar archive section

#### Files touched (server)

- `lib/grappa_web/router.ex` — add
  `get "/archive", ArchiveController, :index` inside the
  `scope "/networks/:network_id"` block at
  `lib/grappa_web/router.ex:74-90`.
- `lib/grappa_web/controllers/archive_controller.ex` — new file. Pulls
  from `Grappa.Scrollback.list_archive/2` (new function), renders
  JSON list.
- `lib/grappa/scrollback.ex` — new
  `list_archive(subject, network_id, active_keyset) ::
  [%{target: String.t(), kind: :channel | :query, last_activity:
  integer(), row_count: integer()}]`. The `active_keyset` is a
  MapSet of strings to exclude (joined channels + open query-window
  targets). Implementation: SQL `SELECT COALESCE(dm_with, channel)
  AS target, MAX(server_time), COUNT(*) FROM messages WHERE …
  GROUP BY target` then filter in Elixir against active_keyset.
- `lib/grappa/scrollback.ex` — `kind` field derivation: a target is
  `:channel` if `String.starts_with?(target, ["#", "&", "!", "+"])`,
  otherwise `:query`.

#### Files touched (cic)

- `cicchetto/src/lib/api.ts` — new `listArchive(token, slug)` REST
  verb sibling to `listChannels`.
- `cicchetto/src/lib/archive.ts` — NEW module. `archivedBySlug`
  resource, lazy on section expand. Identity-scoped cleanup mirror
  of `members.ts` / `scrollback.ts`.
- `cicchetto/src/Sidebar.tsx` — extend per-network section: add a
  collapsed `<details>` for "Archive" beneath the active windows
  list. Click an archived row → setSelectedChannel + (for channel
  kind) the rendered ComposeBox shows the "Join channel" button
  (B5 wires the button visual; B4 just wires the open).

#### TDD sequence

1. RED: `Grappa.ScrollbackTest.list_archive/3` — seed 3 channel rows
   for #a (one with dm_with nil), 2 DM rows for "vjt", 1 row for
   "$server"; with active_keyset = `MapSet.new(["#a"])`, expect
   only "vjt" + "$server" excluded (filter out $server; result is
   `[{"vjt", :query, ts, 2}]`).
2. GREEN: implement `list_archive/3`.
3. RED: ArchiveControllerTest — GET /networks/:slug/archive returns
   200 + the list. Includes the active_keyset assembly from
   `Session.list_channels/2` + `QueryWindows.list_for_user/1`.
4. GREEN: implement controller.
5. RED: cic vitest — `listArchive` mock returns 2 entries; archive
   resource holds them.
6. RED: cic vitest — Sidebar renders Archive section collapsed by
   default; expanding triggers fetch.
7. GREEN: implement archive.ts + Sidebar additions.

#### Exit criteria

- `scripts/check.sh` exit 0 (server) + `cicchetto/scripts/test.sh`
  + `bun check` (cic) all green; literal gate-tails.
- Archive surface visible in browser smoke (PART a channel; expect
  it to appear under Archive section); cic-touching → BROWSER SMOKE
  MANDATORY.
- README.md updated in same bucket (per
  `feedback_readme_currency`) with archive section description.

### B5 — cic window state model + drop optimistic STATE assumption

#### Files touched (cic)

- `cicchetto/src/lib/windowState.ts` — NEW module. Exports
  `windowStateByChannel: () => Record<ChannelKey, WindowState>`,
  `windowFailureReasonByChannel: () => Record<ChannelKey, string>`,
  setters used by subscribe.ts. `WindowState` enum:
  `"pending" | "joined" | "failed" | "kicked" | "parked"`.
  Identity-scoped cleanup mirror of `members.ts`.
- `cicchetto/src/lib/networks.ts` — When the operator clicks JOIN
  (POST /channels success), DROP the optimistic mutation that
  presumes the channel will appear. Instead: set
  `windowStateByChannel[key] = "pending"` immediately so the window
  opens in pending state. The sidebar entry is NOT mutated here —
  the existing `channels_changed` heartbeat + GET /channels refetch
  remains the source of truth for the joined-channels list. cic
  reads BOTH `channelsBySlug()` (for the actual current state) AND
  `windowStateByChannel()` (for the rendered transition state). A
  `pending` entry that's not in `channelsBySlug` yet renders as a
  pending sidebar row via a new derivation step in Sidebar.tsx.
- `cicchetto/src/lib/subscribe.ts` — new handler arms for `joined`,
  `join_failed`, `parted`, `kicked`, `window_state` events. Wire
  to the windowState setters. Sibling to existing `topic_changed`
  arm at `cicchetto/src/lib/subscribe.ts:225-232`.
- `cicchetto/src/lib/members.ts` — DELETE `loadMembers` REST verb +
  `loadedChannels` Set (the once-per-channel HTTP gate). Server
  pushes `members_seeded` on after_join (B3) AND on every 366; cic
  has no remaining reason to fetch /members. The existing
  `seedMembers` handler stays — same payload, only the source goes
  from "REST + WS" to "WS only."
- `cicchetto/src/lib/api.ts` — DELETE `listMembers` if no other
  caller. Verify by grep.
- `cicchetto/src/MembersPane.tsx` — the `createEffect(() => void
  loadMembers(...))` at `cicchetto/src/MembersPane.tsx:41-43` GOES
  AWAY. New rendering branches:
  - `windowStateByChannel[key]` not in `[joined]`: render
    `not joined` muted text. No member fetch.
  - state == joined AND `membersByChannel[key]` undefined or empty:
    render `loading…` muted text.
  - state == joined AND members non-empty: render the existing list.
- `cicchetto/src/ComposeBox.tsx` — visual cue when state is one of
  `failed | kicked | parked`. Add a CSS class `compose-box-greyed`
  to the form root, inline label "(not joined)" beneath the textarea.
  Compose stays functional (operator can still type `/join` or
  `/part`).
- `cicchetto/src/Sidebar.tsx` — extend the channel + query rows: if
  `windowStateByChannel[key] in [failed, kicked, parked]`, add a
  CSS class `sidebar-window-greyed`. Apply to both the channel row
  AND the query row.

#### TDD sequence

1. RED: vitest — windowState.ts transitions correctly on each event
   kind (joined → state=joined; join_failed → state=failed +
   reason set; parted → state removed entirely; kicked → state=kicked;
   window_state replay → state set from snapshot).
2. GREEN: implement windowState.ts.
3. RED: vitest — subscribe.ts handlers fire windowState setters when
   each event arrives.
4. GREEN: extend subscribe.ts.
5. RED: vitest — MembersPane renders `loading…` when state=joined +
   members empty; `not joined` when state=failed; rendered list
   when both populated.
6. GREEN: rewrite MembersPane.
7. RED: vitest — ComposeBox renders greyed visual when state=failed.
8. GREEN: extend ComposeBox.
9. RED: vitest — clicking JOIN sets state=pending immediately
   (optimistic open kept; STATE assumption dropped).
10. GREEN: wire networks.ts JOIN handler.
11. Verify deletion: grep for any remaining `loadMembers` or
    `loadedChannels` references; remove dead code.

#### Exit criteria

- vitest green; `bun check` (biome) green; literal gate-tails.
- BROWSER SMOKE MANDATORY: invite-only channel attempt should render
  as failed window with reason (irssi-style). PART then re-JOIN
  cycle from the archive section shows pending → joined transition.
- Playwright e2e MANDATORY (per `feedback_ux_e2e_mandatory`).

### B6 — full e2e

#### Files touched

- `cicchetto/e2e/event-driven-windows.spec.ts` — NEW Playwright e2e
  covering the 6 transition flows from the intent doc.
- `scripts/integration.sh` invocation added to CI gate (verify
  already runs all e2e specs).

#### Test scenarios (each is a Playwright spec)

1. **Pending → joined**: click JOIN on `#cic-test-pending`, assert
   pending visual, wait for `:joined`, assert joined visual + member
   list populated.
2. **Pending → failed (invite-only)**: target a channel with `+i`
   on testnet (configure as test fixture), click JOIN, assert
   pending → failed transition + reason "Cannot join channel (+i)"
   visible in scrollback.
3. **Kicked**: arrange a peer testnet user to KICK us, assert state
   transitions to `kicked` with reason in scrollback, sidebar
   greyed; window stays in active section (not archived).
4. **Parked (T32 disconnect)**: trigger /disconnect, assert all
   windows for that network transition to parked, sidebar greyed.
   /connect → assert pending → joined transitions on autojoin.
5. **PART → archive → re-join**: PART a channel, assert it leaves
   the active section + appears in Archive collapsed section.
   Expand archive, click the entry, assert "Join channel" button
   visible. Click button, assert pending → joined.
6. **Archived query revival**: `/q peer` then × the window, assert
   it appears in Archive. Type a message in the (now archived)
   compose if visible, OR re-open via clicking the archive entry,
   send a message, assert window moves back to active.

#### Exit criteria

- All 6 e2e specs green via `scripts/integration.sh`.
- Browser smoke against prod confirms each flow.
- Literal gate-tails.

### B7 — docs sweep

#### Files touched

- `docs/DESIGN_NOTES.md` — new entry: "2026-05-NN — event-driven
  windows. Server is the only state model; cic projects events.
  Closes 3 todo items + the deploy-reconnect race + the
  optimistic-STATE-assumption class."
- `CLAUDE.md` — extend the invariant section: add "**One state
  model, on the server.** cicchetto NEVER assumes state transitions;
  it consumes typed JSON events." (sibling to the existing "One IRC
  parser, on the server" line).
- `README.md` — add archive surface description to the user-facing
  features section. Update window state diagram if one exists.
- `docs/todo.md` — remove the 3 closed items (channel-not-connected
  state; ghost-window class; members-empty bug).
- `docs/project-story.md` — episode entry per CLAUDE.md
  "project story lives on" rule. Title: "Event-driven windows: dropping
  the parallel state model."

#### Exit criteria

- All living docs reflect shipped reality.
- CP15 closes (`status: closed`); next checkpoint opens for the
  next cluster (channel-client-polish per `project_post_p4_1_arc`).

## Cluster sequencing summary

```
B1 (server) → B2 (server) → B3 (server + after_join) → B4 (REST + cic) →
B5 (cic — heavy) → B6 (e2e) → B7 (docs).
```

Sized 6 sessions per the intent doc estimate; B5 is the heaviest
single bucket (5+ TDD steps). B4 + B5 + B6 are cic-touching and
require browser smoke + (B5/B6) Playwright e2e per the discipline
memos.

## Decisions pinned 2026-05-07 vjt

vjt signed off all 8 deferred-question resolutions wholesale on
2026-05-07, post-CP14 close, pre-B1-worktree-open. The "Open
questions — recommended resolutions" section above is now
authoritative for the cluster:

- **Q1** — visitor JOIN path emits the same `:joined` events; no
  special-case. RED test pins both subjects.
- **Q2** — bootstrap autojoin failures emit the same `:join_failed`
  shape; no `:autojoin_failed` variant.
- **Q3** — single `GET /networks/:slug/archive` endpoint returning
  a flat `[{target, kind, last_activity, row_count}]` list.
- **Q4** — `window_states` lives on `Session.Server.state()` as an
  in-process map; no ETS, no Registry.
- **Q5** — derived on boot from autojoin's natural transition flow;
  no new persistence table.
- **Q6** — mobile BottomBar archive is nested per-network (not a
  global tab), mirroring desktop Sidebar.
- **Q7** — `/join` parser already present at
  `cicchetto/src/lib/slashCommands.ts:133-137`; archive's "Join
  channel" button reuses `postCreateChannel`.
- **Q8** — 3-layer attribution priority for failure numerics:
  labeled-response → in-flight JOIN map → `$server` fallback.
