# Server-side read state — flip the cic/server cursor invariant

# Server-side read state — flip the cic/server cursor invariant

**Status**: CLOSED 2026-05-13 — cluster shipped end-to-end. Buckets
R-1..R-Z merged to main; version `0.2.0 → 0.3.0`. cp13-S5 + vjt's
own-action unread bug both closed. See
[DESIGN_NOTES "CP29 server-side read-state cluster CLOSED"](../DESIGN_NOTES.md#2026-05-13--cp29-server-side-read-state-cluster-closed)
for the landing record + deferred decisions.

**Position**: insert ahead of P-0b (numeric-delegation cluster). Blocks
nothing in the P-0a server-side WHOIS leg (already LIVE-VERIFIED in
prod), but the cluster plan in `2026-05-13-numeric-delegation-p0.md`
references this work as a prerequisite for closing cp13-S5.
**Origin evidence**:
- 2026-05-13 cp13-S5 e2e race (vjt local, macOS Docker Desktop). cic
  GET /messages at t=0 returns empty; cic POST PRIVMSG at t=1ms; server
  401 INSERT at t=41ms; Phoenix Channel JOIN at t=61ms — broadcast
  fires before subscribe → 401 row vanishes from cic state. CI green
  on Linux runner because faster startup wins the race; macOS loses.
- 2026-05-13 vjt observation: "if I leave and join a chan I see 'unread
  messages' for my part and join actions" — cic counts the operator's
  own JOIN/PART against unread badges.
- Phase 6 IRCv3 listener facade needs `+draft/read-marker` + CHATHISTORY
  cursor support that doesn't exist as long as read state is client-only.

**Source of truth**:
- `lib/grappa/scrollback.ex` (server-side query API).
- `lib/grappa_web/controllers/messages_controller.ex` (REST surface).
- `lib/grappa/scrollback/message.ex` (schema — already has `id`,
  `server_time`, `user_id`/`visitor_id`, `network_id`, `channel`,
  `dm_with`).
- `cicchetto/src/lib/scrollback.ts`, `selection.ts`, `subscribe.ts`,
  `reconnectBackfill.ts` (cic side).
- `lib/grappa/visitors/visitor.ex` (visitor schema — UUID + CASCADE).
- IRCv3 spec: <https://ircv3.net/specs/extensions/read-marker> (for
  Phase 6 alignment).

## Why this cluster exists

CLAUDE.md's invariant **"No server-side `MARKREAD` / read cursors. Read
position is client-side only."** is being deliberately flipped. The
flip enables four things at once:

1. **Multi-device sync.** Read on phone → no badge on laptop. Today
   each cic instance is its own island; opening cic on device B after
   device A has read everything still shows N unread.
2. **Cp13-S5 race fix.** Subscribe-after-broadcast race is a SYMPTOM
   of "cic is the cursor authority": when cic's WS join lands after
   the broadcast, the row is lost forever. With server-side cursor +
   "refresh-on-join-ok" + a unified messages endpoint with `?after=`
   semantics, the WS join becomes "tell me what I missed since cursor
   X" and the row is recovered deterministically.
3. **Phase 6 IRCv3 foundation.** `+draft/read-marker` (`MARKREAD #chan
   timestamp=X`) and CHATHISTORY both presume server-side cursor
   storage. Building it now means the listener facade is a thin
   translation layer, not a redesign.
4. **Own-action unread filter.** Bug: cic bumps `messagesUnread` /
   `eventsUnread` for the operator's own JOIN/PART/QUIT. Independent
   bug class but lands cleanly in the same cluster — the badge logic
   is touched in the same file.

## CLAUDE.md invariant change (read first)

Current text (CLAUDE.md "Key invariants"):

> **No server-side `MARKREAD` / read cursors.** Read position is
> client-side only. Adding it later is forward-compatible; removing it
> later would break clients that came to depend on it.

New text after this cluster lands:

> **Read state is server-owned, per (subject, network, channel).**
> Cursor stored as `last_read_message_id` (FK to `messages.id`). cic
> reads the cursor from the subject envelope on login + per-window
> from a topic event; cic POSTs cursor advancements as the operator
> reads. Phase 6 IRCv3 facade exposes the same cursor as
> `+draft/read-marker` MARKREAD lines on the listener side. Removing
> server-side cursor is a breaking change.

DESIGN_NOTES entry mandatory in the cluster's first commit, dated
2026-05-13, recording the flip + its motivation (race + multi-device
+ Phase 6 alignment).

## Architecture

### Schema

New table `read_cursors`:

```elixir
create table(:read_cursors) do
  add :user_id, references(:users, type: :uuid, on_delete: :delete_all)
  add :visitor_id, references(:visitors, type: :uuid, on_delete: :delete_all)
  add :network_id, references(:networks, on_delete: :delete_all),
      null: false
  add :channel, :text, null: false
  add :last_read_message_id, references(:messages, on_delete: :nilify_all),
      null: false
  timestamps()
end

create unique_index(:read_cursors, [:user_id, :network_id, :channel],
       where: "user_id IS NOT NULL")
create unique_index(:read_cursors, [:visitor_id, :network_id, :channel],
       where: "visitor_id IS NOT NULL")
create constraint(:read_cursors, :exactly_one_subject,
       check: "(user_id IS NULL) <> (visitor_id IS NULL)")
```

Subject XOR mirrors `messages` schema convention (per `Grappa.Scrollback.Message`).

`last_read_message_id` cascade-on-message-delete: `nilify_all` (not
`delete_all`) — message deletion is rare (visitor reaping CASCADEs the
whole chain anyway), but a stale cursor with `last_read_message_id =
NULL` is recoverable to "everything before earliest extant row read".

### Channel key for DMs

DMs persist with `channel = peer` (outbound) AND
`channel = own_nick AND dm_with = peer` (inbound). The cursor key is
`channel = peer_nick` — same key cic uses for the DM window. Cursor
advancement queries the bidirectional shape via existing
`Scrollback.fetch_dm/5` semantics. No DB schema change needed for the
cursor table (it's still keyed on `channel` text).

### Visitor cursors

Visitors have a `visitors` row + UUID. Their cursors live in
`read_cursors` keyed on `visitor_id`. Cleaned up via the existing
visitor CASCADE on reaper-driven `Grappa.Visitors.Reaper` deletion.
No new lifecycle code.

### REST surface — unification

Today there are two endpoints:

- `GET /networks/:slug/channels/:chan/messages` — DESC paginated by
  `?before=<server_time>` (initial load + scroll-back).
- `GET /networks/:slug/channels/:chan/messages?after=<id>` — ASC by id
  (`Scrollback.fetch_after/6`, used by `reconnectBackfill`).

After this cluster: ONE endpoint with explicit cursor + ordering:

- `GET /networks/:slug/channels/:chan/messages?after=<id>&limit=<n>`
  → ASC by `(server_time ASC, id ASC)`, `id > after`.
- `GET /networks/:slug/channels/:chan/messages?before=<id>&limit=<n>`
  → DESC by `(server_time DESC, id DESC)`, `id < before`.
- `GET /networks/:slug/channels/:chan/messages?around=<id>&limit=<n>`
  → DESC `n/2` rows where `id <= around` UNION ASC `n/2` rows where
  `id > around`. For "open window centered on cursor": cic asks
  `?around=<cursor.last_read_message_id>&limit=150` and gets ~50
  before + ~100 after (per vjt's "50 before, 100 next" spec).
- No params (cold initial load with no cursor): treated as
  `?before=<MAX_INT>&limit=<default>` — DESC last `default` rows.
  Single-shot fast-path for first-time-ever opens.

`limit` defaults: 50 (no explicit), ceiling 200. Reject `limit > 200`
with HTTP 400 at controller boundary.

`?after`/`?before`/`?around` are mutually exclusive — controller
rejects multi-cursor requests with 400. Cursor type is **integer ID
ONLY** (per Q1: deterministic, monotonic, no tie-breaks). server_time
stays for ordering + display.

### Cursor write API

New endpoint:

`POST /networks/:slug/channels/:chan/read-cursor`
body: `{ "message_id": <int> }`

Semantics:
- `last_read_message_id < message_id` → update cursor.
- `last_read_message_id >= message_id` → no-op (cursor advances
  forward only).
- No row exists → INSERT.
- `message_id` does not belong to (subject, network, channel) → 422.
  Server validates the row exists + is visible to the subject.

Returns `200 { "last_read_message_id": <new_id> }` always, including
no-op (lets cic confirm without reading the body).

### Cursor read

Two paths:
- **Boot-time bulk**: subject envelope (`/me`) gains a
  `read_cursors: { "<channel_key>": <id> }` map (per network slug
  nested? — see Q below). Loaded once at login.
- **Per-channel refresh**: `read_cursors` is broadcast on the
  per-channel topic via a typed wire event `kind: "read_cursor_set"`,
  `payload: { last_read_message_id: <int> }`. Pushed when the operator
  POSTs to a different cic instance + cic Phoenix Channel join handler
  reflects current cursor on `phx_join` ack.

Phoenix Channel `join/3` callback returns the current cursor in the
join response: `{:ok, %{read_cursor: <id_or_nil>}, socket}`. cic stores
this in its `readCursorByKey` signal map. Same shape, single source.

### cic side — what changes

- **Drop `cicchetto/src/lib/readCursor.ts` entirely.** Per Q5 + the
  CLAUDE.md "total consistency" rule, the cic-side cursor module dies
  in the same cluster as the server-side cursor lands. No transition
  period.
- **Selection effect (`selection.ts:118-158`)** — replace
  `setReadCursor(...)` calls with `POST read-cursor` calls. The "read
  on focus-leave" semantic is unchanged; only the storage backend
  flips.
- **Refresh-on-WS-join-ok**: `subscribe.ts`'s `installChannelHandler`
  + `installDmListenerHandler` get a callback that, on every join-ok
  (NOT just count >= 2), calls a new unified `refreshScrollback(slug,
  chan)` verb. `refreshScrollback` calls
  `GET /messages?after=<lastSeenIdByKey[key] || cursor.id || 0>&limit=200`
  and ingests via `appendToScrollback` (id-dedupe). Closes cp13-S5 by
  construction — by the time the WS join completes, the missing row is
  in the DB and the after-cursor query returns it.
- **`reconnectBackfill.ts` collapses into the new flow.** Its
  `noteJoinOk` count gate goes away; `runBackfill` becomes the same
  call as `refreshScrollback` (different cursor-source heuristics,
  same endpoint). The high-water-mark `lastSeenIdByKey` is preserved
  as the cursor-source-of-last-resort when the server cursor is older
  or absent.
- **Own-action unread filter.** In `subscribe.ts`'s WS event handler,
  before `bumpMessageUnread`/`bumpEventUnread`, check `msg.sender ==
  ownNickForNetwork(net, user)`. Skip bump for own-actions. Independent
  bug, lands here for context locality.
- **`messagesByChannel` cleanup**: the cursor advancement effect that
  used to write to local storage now POSTs to server. Solid effect
  guards against echo (server pushes cursor change → cic reflects →
  cic does NOT POST again).

### Server side — module shape

- `Grappa.ReadCursor` context module (`lib/grappa/read_cursor.ex`):
  - `get/3 :: (subject, network_id, channel) -> %ReadCursor{} | nil`
  - `advance/4 :: (subject, network_id, channel, message_id) -> {:ok,
    %ReadCursor{}} | {:error, changeset}`. Idempotent; only advances
    forward.
  - `bulk_for_subject/1 :: (subject) -> %{network_slug => %{channel =>
    id}}`. Used by `/me` envelope assembly.
  - `broadcast_advance/3 :: (subject, network_id, channel)` — emits
    typed `read_cursor_set` wire event on per-channel topic for
    cross-device sync.
- `Grappa.ReadCursor.Cursor` schema (`lib/grappa/read_cursor/cursor.ex`):
  - Standard Ecto.Changeset shape; subject XOR validation mirrors
    `Scrollback.Message.changeset/2`.
- `Grappa.Scrollback.fetch_around/6` — new query for
  `?around=<id>&limit=<n>` semantic.

### Boundary

`Grappa.ReadCursor` is a new context. Boundary annotations:
- `Grappa.Scrollback` may call `Grappa.ReadCursor.advance/4` from
  inside `record_message/3` (fold the operator's own outbound into the
  cursor advance — sending a message implies you've read up to that
  point). If FK or boundary makes this awkward, do it from the
  controller layer instead.
- `Grappa.Session.Server` does NOT touch `ReadCursor` directly.
- `GrappaWeb.MessagesController` + `GrappaWeb.ReadCursorController`
  are the only HTTP boundaries.

## Buckets

### R-1 — Schema + context module (~3-4 hours, COLD)

- Migration: `read_cursors` table per spec above. Foreign keys +
  partial indexes + XOR check constraint.
- `Grappa.ReadCursor.Cursor` schema with subject XOR + advance-forward
  changeset.
- `Grappa.ReadCursor` context — `get/3`, `advance/4`,
  `bulk_for_subject/1`, `broadcast_advance/3`.
- Unit tests: subject XOR, advance idempotence (advancing to lower
  id is a no-op + no error), advance to nonexistent message_id is
  `{:error, _}`.
- Boundary annotations.

COLD-deploy: new migration + new schema → fold into deploy.sh's
auto-cold path (mix.exs / migrations don't trigger cold by themselves
but new schema field reads at boot might). Actually — no Bootstrap
read of this; HOT-deployable. **HOT** unless `application.ex`
supervises a new child for cursor reaping (it doesn't — visitor reaper
already CASCADEs).

### R-2 — REST surface unification (~3-4 hours, HOT)

- `MessagesController` accepts `?after=<id>&limit=<n>` /
  `?before=<id>&limit=<n>` / `?around=<id>&limit=<n>` / no-cursor.
- `Scrollback.fetch_around/6` new query.
- Validate `limit` (default 50, ceiling 200, reject > 200 → 400).
- Validate cursor mutex: at most one of `after`/`before`/`around`.
- DEPRECATE the `?before=<server_time>` shape: at first, accept BOTH
  `?before=<id>` AND `?before=<server_time>` — disambiguate by
  detecting integer-vs-ISO. Ship the cic side flip in R-3/R-4, then
  remove ts shape in a R-Z cleanup commit.
- Update `Scrollback.fetch_after/6` callers (only
  `reconnectBackfill.ts` over the wire, but server-side may have other
  callers — grep first).
- Tests: limit ceiling, cursor mutex, around shape, cursor-from-empty
  table.

### R-3 — POST read-cursor + cursor in `/me` + WS push (~3-4 hours, HOT)

- `GrappaWeb.ReadCursorController` — `POST .../read-cursor`.
- `GrappaWeb.MeController` (or wherever `/me` is assembled) emits
  `read_cursors: %{<network_slug> => %{<channel> => <id>}}`.
- `GrappaWeb.ChannelChannel` (Phoenix Channel module) — on `join/3`,
  return `{:ok, %{read_cursor: <id_or_nil>}, socket}`.
- `Grappa.ReadCursor.advance/4` callers broadcast typed
  `read_cursor_set` wire event on the per-channel topic via
  `Phoenix.PubSub.broadcast` to inform other live cic instances.
- Tests: advance API contract (forward-only, no-op on equal/lower,
  422 on invalid id), `/me` envelope shape, Phoenix Channel join
  reply shape, cross-device propagation (two channel subscribers,
  one POSTs cursor, the other receives `read_cursor_set`).

### R-4 — cic-side cursor backend flip (~4-5 hours, HOT cic-bundle deploy)

- DELETE `cicchetto/src/lib/readCursor.ts` — replaced by signal map
  fed from `/me` envelope + Phoenix Channel join replies +
  `read_cursor_set` wire event.
- `selection.ts` — replace `setReadCursor` call with POST verb.
- New `cicchetto/src/lib/readCursor.ts` (same name, new shape):
  signal-map of cursor-by-channel-key, hydrated from `/me` and live
  WS events. POST verb `advanceReadCursor(slug, chan, message_id)`
  with debounce (200ms? or rely on server-side forward-only idempotence
  + send eagerly). My pick: send eagerly, no debounce — server is
  idempotent, network is cheap, latency to next-device matters.
- `subscribe.ts` — install `read_cursor_set` event handler on
  per-channel topic (mirrors current `read_cursor_set` if it exists,
  or new) → updates signal map.
- All consumers of the OLD localStorage cursor → read from the new
  signal map. Grep for `getReadCursor`/`setReadCursor` callsites and
  flip them to the signal-derived getter.
- vitest unit tests for the new signal map + advance verb.
- LocalStorage migration: nuke the legacy `read_cursor` key on first
  load post-flip. One-shot cleanup.

### R-5 — Refresh-on-WS-join-ok (~2-3 hours, HOT cic-bundle deploy)

- `cicchetto/src/lib/scrollback.ts` — new `refreshScrollback(slug,
  chan)` verb that calls `GET /messages?after=<heuristic>&limit=200`
  + ingests via `appendToScrollback`. Heuristic:
  `lastSeenIdByKey[key] ?? cursor.id ?? null` — when null, no fetch
  (cold open path will load on selection).
- `cicchetto/src/lib/subscribe.ts` — every `joinChannel(...)`
  callback (5 sites: per-network channel loop, per-channel rejoin
  effect, per-query loop, dm-listener loop, $server loop) → call
  `refreshScrollback` on join-ok.
- `cicchetto/src/lib/reconnectBackfill.ts` — collapses into a
  cursor-source helper called by `refreshScrollback`. The
  `noteJoinOk` count-gate is removed (every join-ok refreshes; no
  "first-join skip"). High-water-mark `lastSeenIdByKey` stays as one
  of the cursor sources.
- E2E: cp13-S5 turns green. Add a NEW Playwright spec
  `tests/refresh-on-join.spec.ts` that simulates a brief disconnect
  then asserts a previously-broadcast message is recovered (mock
  scenario can be: disconnect WS via dev-tools `evaluate_script`,
  send a peer privmsg via fixtures/ircClient, reconnect, assert
  rendered). Mandatory per `feedback_ux_e2e_mandatory`.

### R-6 — Own-action unread filter (~1 hour, HOT cic-bundle deploy)

- `cicchetto/src/lib/subscribe.ts` — in the WS event handler,
  before `bumpMessageUnread` / `bumpEventUnread`, gate on
  `nickEquals(msg.sender, ownNickForNetwork(net, user))`. Skip the
  bump for own-actions. PRIVMSG echoes already gated by
  `operatorActionEcho` predicate; this extends the same gate to
  presence kinds (JOIN/PART/QUIT/MODE/NICK).
- vitest unit test: own-action JOIN does NOT bump `eventsUnread`;
  peer JOIN does.
- E2E: rejoin a channel, assert sidebar shows no events badge for
  the operator's own JOIN.

### R-Z — Removal of legacy code paths (~1 hour, HOT)

- Remove the old `?before=<server_time>` shape from `MessagesController`.
- Remove any server-side caller of the deprecated shape.
- DESIGN_NOTES update: "cursor invariant flip COMPLETE. Phase 6 IRCv3
  facade now has the server-side cursor it needs."
- CLAUDE.md update: replace the "Read state is server-owned" invariant
  block with the final wording.
- README update if affected.

## Standing rules (cluster-wide)

- **No localized strings.** Cursor is `{id, ts}` ints. Wire events
  carry typed atoms / ints, not English. Per
  `feedback_no_localized_strings_server_side`.
- **Scripts only.** `scripts/check.sh`, `scripts/integration.sh`,
  `scripts/deploy.sh`. Per CLAUDE.md "container is the runtime".
- **Per-bucket deploy + healthcheck + browser smoke** at each R-N
  close. Per `feedback_per_bucket_deploy`.
- **LANDED claim evidence**: full `scripts/check.sh` exit-0 + literal
  tail paste; CI green-on-FIRST-run. Per
  `feedback_landed_claim_evidence`.
- **Rebase before merge**, branch from local main not origin/main.
- **One bucket per commit.** No mega-commits.

## Open questions (need vjt sign-off before R-1)

**(O1) `/me` envelope cursor shape**: nested `%{slug => %{chan => id}}`
or flat `%{ "slug:chan" => id }`? Nested matches the Phoenix topic
shape (per-network grouping). Flat matches the cic ChannelKey
convention. My pick: **nested** — the data is naturally per-network +
the size is bounded by network count (~5-20).

**(O2) Cursor advance on send**: when the operator POSTs a PRIVMSG,
should the server auto-advance their cursor to that row's id?
Argument for: sending implies "I've read everything before this".
Argument against: the operator may have scrolled back and is replying
to an old message — auto-advance would mark intermediate rows as
read. My pick: **YES auto-advance** — the alternative leaks cic
scroll-position state into server semantics. If "reply to old
message without marking as read" matters later, add an explicit
`?advance=false` flag on the POST. KISS for now.

**(O3) Cursor for `$server` and `*` synthetic windows**: $server gets
numeric notices, * gets system messages. Treat them as regular
channels with names `"$server"` / `"*"` for cursor purposes? My pick:
**yes** — uniformity over carve-outs.

**(O4) Cursor for own-nick query window**: the own-nick window
displays self-msgs only post-CP14-B3. Cursor on that window? My pick:
**yes, same as any other channel** — keyed on `channel = own_nick`.
The DM-listener loop is the sole subscriber; advancement works the
same way.

**(O5) Bulk cursor fetch on subject login — heaviness?** With ~20
networks * ~30 channels each = 600 cursor rows. Trivial. No paging.

**(O6) Live cursor sync between cic instances**: if device A
advances, device B should reflect. Mechanism: `read_cursor_set` typed
wire event on the per-channel topic. Both devices subscribe to the
same topic via the user-rooted topic structure. My pick: **emit on
every advance**, no batching, no throttle. Cheap.

**(O7) When to fold the cluster into main vs feature-gate?** This
flips a documented invariant. Two options: (a) all-in-one feature
flag rollout, ship behind `FEATURE_SERVER_CURSOR=1` with both code
paths live for one deploy cycle, then flip default + remove old. (b)
straight cutover, all R-N buckets land in sequence + final R-Z
deletes the old. My pick: **(b) straight cutover** — feature flags
violate "total consistency" CLAUDE.md rule + create a dual-path
mess. Risk is low: cic state is reconstructable from server state
on first load post-flip.

## Halt-and-brief points

- **Before R-1**: vjt signs off on O1-O7 + the CLAUDE.md invariant
  flip wording.
- **Before R-2 ships**: confirm the integer-vs-ISO disambiguation
  in `?before=<...>` is robust. If it's hairy, split the endpoint
  earlier and accept the brief deprecation overlap.
- **Before R-4 ships**: confirm the LocalStorage migration shape
  (one-shot nuke of legacy `read_cursor` keys is fine; alternative
  is migrate-on-first-read).
- **Before R-5 ships**: review the e2e for `tests/refresh-on-join.spec.ts`
  — it simulates a disconnect, which is fragile. Alternative: rely on
  cp13-S5 going green as the "refresh fixed the race" signal.

## Out-of-scope (DO NOT pull in)

- IRCv3 listener facade work (Phase 6) — this cluster ENABLES it,
  doesn't ship it.
- Multi-device WebSocket session reconciliation (e.g. one connection
  per device, smarter routing). Out-of-scope; PubSub broadcast to
  all subscribers is the mechanism.
- Read receipts shown to OTHER users ("vjt read your message") — out-
  of-scope; this is a personal-cursor feature, not social.
- Push notifications on unread accumulation — Phase 5+ work.
- The wider scrollback-pagination UX rework (infinite scroll polish,
  load-more spinners) — separate cluster.
