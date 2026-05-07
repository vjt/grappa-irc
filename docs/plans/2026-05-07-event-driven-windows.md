# Event-Driven Windows — cluster intent

**Status**: brainstorm closed 2026-05-07. Cluster opens after CP14 closes
(post-B3, post-/clear, post-/start). This file is the survives-/clear
intent doc; the implementation plan will be a sibling
`docs/plans/2026-05-07-event-driven-windows-impl.md` written at cluster
open.

## Why

Cic today is OPTIMISTIC: when the operator clicks JOIN, cic mutates its
own state immediately and *assumes* the server will agree. When reality
disagrees (IRC says "invite-only", upstream is dead, NickServ rotated
the nick mid-session), the UI lies — empty members panes, ghost
windows that look healthy-but-empty, scrollback rendered for channels
the operator can't actually post in.

The diagnostic that opened this cluster: the **members-empty bug**
re-surfaced on prod 2026-05-07. The "fix" landed in commits 50cdd21 +
a67e890 was correct for the cic-initiated JOIN path (POST /channels →
server JOIN → 366 → broadcast → cic seeds). It does **not** cover the
**deploy / WS reconnect / server-bootstrap autojoin** path: server
re-JOINs autojoin channels on its own, NAMES + 366 fire BEFORE cic's
WS reconnect re-subscribes to the per-channel topic, broadcast lost,
cic sits with the stale empty snapshot it cached at first cold load.

That's a SYMPTOM. The deeper bug: **cic carries parallel state that
the server is already authoritative for**. CLAUDE.md invariant:
> One IRC parser, on the server. cicchetto NEVER parses IRC; it
> consumes typed JSON events.

We extend it: **One state model, on the server. cicchetto NEVER assumes
state transitions; it consumes typed JSON events.**

This cluster makes that real. Side-effect: 3 todo items close, the
members race goes away permanently, the "not connected" empty-state
becomes natural, and the it-opers ghost-window vanishes.

## Architectural shift

**Today** (per surface):
- Sidebar: shows what cic *thinks* it's joined (mutated optimistically
  on POST /channels).
- ScrollbackPane: renders any sqlite history for the focused channel,
  whether currently joined or not.
- MembersPane: fires REST `loadMembers` on mount; empty result becomes
  permanent via the once-per-channel gate.
- ComposeBox: always enabled if a window is focused.

**After:**
- Window LIFECYCLE is event-driven (server emits state transitions).
- Window CONTENT (members, topic, modes, "loading…") is event-driven.
- Window VISIBILITY (active vs archive) is user-action-driven (PART /
  window-× / typing in archived query → revive).

**Important nuance** (clarified during brainstorm 2026-05-07): the
operator clicking JOIN still **opens the window optimistically** — same
as today. What changes is the WINDOW STATE: it transitions through
`pending` → `joined` (or `failed`) based on server events, with UI
affordances that match each state. No silent lying.

## State machine — per window

```
                    ┌─────────────────┐
       user JOIN    │                 │  bahamut JOIN echo
   ───────────────► │     pending     │ ──────────────────────►  joined
                    │ (loading…)      │
                    └─────────────────┘
                            │
                            │  471/473/474/475/403/405 numeric
                            ▼
                       ┌─────────┐                   ┌──────────┐
                       │ failed  │ ◄─── KICK ──────  │  joined  │
                       │ kicked  │                   │          │
                       │ parked  │ ◄─── T32 :parked ─┤          │
                       └─────────┘                   └──────────┘
                                                         │
                                          user PART      │
                                          window ×       │
                                          ─────────────► ▼
                                                    ┌──────────┐
                                                    │ archived │ (out of active sidebar)
                                                    └──────────┘
                                                         │
                                                         │ user click "join"
                                                         │ user types in archived query
                                                         ▼
                                                      pending
```

States:
- **pending** — opened by user intent (POST /channels). Awaiting JOIN
  echo. Members pane: `loading…` muted text. ComposeBox: enabled (any
  /command works; PRIVMSG body queues client-side or returns
  immediately and gets a server-side "you're not joined" reply that
  renders in-window).
- **joined** — JOIN echo received. Members may still be empty pending
  366 (still `loading…`). ComposeBox: enabled. Topic/modes populate
  via existing topic_changed/channel_modes_changed events.
- **failed** — failure numeric received (cannot-join family). Read-only
  visual cue. Members pane: hidden or "not joined" text. ComposeBox:
  not specially gated — operator can type `/join #chan key` to retry.
  If they try a regular PRIVMSG, server replies "cannot send to
  channel" → renders in-window. Sidebar entry greyed/dim. Failure
  reason rendered as a scrollback row.
- **kicked** — same UI as `failed`. Reason in scrollback. Same
  retry path.
- **parked** — same UI as `failed` (network-level T32 disconnect).
  Same retry path is a no-op until network reconnects (T32
  `:connected`).
- **archived** — out of the active sidebar entirely. Lives in the
  collapsed Archive section per network.

**Special**:
- `$server` window: ALWAYS active, never archived, never goes through
  this state machine. It's a system surface (MOTD, NOTICEs from
  hostnames, bouncer-side notices), not a chat surface.
- Query (DM) windows: NO joined/failed concept (no IRC JOIN for DMs).
  States are just `active` or `archived`. Typing in an archived query
  revives it.

## Active/Archive boundary — user-action-driven

Active → archived (USER intent only):
- User types `/part #chan` → `:parted` event → archived.
- User clicks × on channel window → server-side PART → `:parted` →
  archived.
- User clicks × on query window → `query_window_closed` event →
  archived.

NOT archived on:
- KICK (other party's action — keeps window in active sidebar in
  `kicked` state with retry button).
- T32 network disconnect / `:parked` — keeps all windows active in
  `parked` state, retry on `:connected`.
- bahamut /kill / netsplit — same as kicked, transient.

Archived → active:
- Click "Join" button on archived channel window.
- Type+send in archived query window's compose (single keystroke
  promotes the window).

Visual cue for greyed/inactive (failed/kicked/parked) windows in the
ACTIVE list: opacity-dim + italic name. (Final visual is implementation
detail — the design surface is "user can tell at a glance that the
window is not currently usable for messaging.")

## Archive surface

**Shape**: per-network section, separate from active. Collapsed by
default.

**Source**: `GET /networks/:slug/archive` (new endpoint). Returns:
```
[
  { target: "#sniffo", kind: "channel", last_activity: 1778000000, row_count: 576 },
  { target: "vjt-irssi", kind: "query", last_activity: 1777900000, row_count: 8 },
  ...
]
```
Server filter: targets that have scrollback rows AND are NOT currently
in active state (i.e. not in `state.members` for channels, not in
`query_windows` table for queries).

**Render**: mixed list (channels + queries together), sorted by
`last_activity desc`. Channel/query distinction shown via a small
icon prefix (`#` vs nick).

**Click behavior**:
- Channel: opens read-only window. Scrollback loads via existing REST.
  Members pane: hidden or "not joined" text. ComposeBox: contains a
  "Join channel" button (clicking sends POST /channels → enters
  `pending` → window transitions to active). The operator can also
  type `/join` slash-commands inside the compose if we keep it; UX
  detail TBD at implementation.
- Query: opens with compose enabled (typing+sending revives).

**Delete**: deferred. Future `DELETE /networks/:slug/archive/:target`
(hard delete of scrollback rows for that target). Trash icon on the
archive list row. Don't implement yet.

## Server-side changes

### New events

- `:joined` — emitted on bahamut JOIN echo (BEFORE NAMES). Carries
  `{network, channel}`. Broadcast on per-channel topic.
- `:join_failed` — emitted on cannot-join numerics (471/473/474/475/
  403/405 family). Carries `{network, channel, reason, numeric}`.
  Broadcast on per-channel topic.
- `:parted` — emitted on user-initiated PART success. Carries
  `{network, channel}`. Broadcast on per-channel topic.
- `:kicked` — already exists as a kick scrollback row; needs to also
  trigger a window-state event so cic transitions the visual without
  parsing the scrollback. Carries `{network, channel, by, reason}`.

### Existing events that stay

- `members_seeded` (a67e890) — emitted on 366. STILL needed because
  the new `:joined` fires earlier (on JOIN echo).
- `topic_changed` / `channel_modes_changed` — already emitted on 332 /
  324 etc. Stay.
- `channels_changed` — emitted on `state.members` keyset delta. Cic's
  use of it for sidebar mutation goes AWAY (sidebar reacts to
  `:joined` / `:parted` directly). Server can keep emitting it for
  Phase 6 listener — orthogonal.

### `push_channel_snapshot` — extend

Today (`grappa_channel.ex:637`): pushes cached `topic_changed` +
`channel_modes_changed` on `after_join` (the WS topic-join callback).

Add: push cached `members_seeded` (when `state.members[channel]` is
non-empty AND state is `joined`). Same shape as the existing pushes.
This eliminates the deploy-reconnect race.

Add: push current window state (`{kind: "window_state", state:
"joined"|"failed"|"kicked"|"parked"}`). Cic uses this to set the
window state on cold WS-subscribe (page reload, deploy reconnect).

Server-side state needed: a per-channel `window_state` enum on
`state.channels` (or wherever `state.members` lives). Updated on every
state transition above. Read on after_join.

### In-flight JOIN map

Server tracks "JOIN attempts in flight" per (user_id, network_id)
session, ~last N per network (TTL-bounded by IRC server's reply
timing, typically <1s; soft-cap to handle network unreachable).
Maps `target_channel → from_window_label?` (window_label is for
labeled-response IRCv3 cap when the network supports it; fallback is
match-by-channel-param-on-numeric).

Used by EventRouter to route `:join_failed` to the right
per-channel topic when a numeric arrives.

### REST surface

- New: `GET /networks/:slug/archive` → list of archived targets.
- Existing: `GET /networks/:slug/channels/:chan/messages` works for
  archived channels (returns sqlite rows regardless of join state).
  No change.
- Existing: `GET /networks/:slug/channels/:chan/members` for archived
  channels — returns 404 (no live state)? Or 200 with empty list? My
  call: 200 + empty list, with a `joined: false` flag in the response
  so cic can decide rendering. Confirm at implementation.

## Cic-side changes

### New state model

- `windowStateByChannel: Record<ChannelKey, "pending"|"joined"|"failed"|"kicked"|"parked">`
  module-singleton signal store.
- `windowFailureReasonByChannel: Record<ChannelKey, string>` for
  failed/kicked/parked display.
- `archivedWindows: Resource` per network, lazily loaded when archive
  section is expanded.

### Drop optimistic mutations

`networks.ts` / sidebar: do NOT add a channel to the live channel list
on POST /channels success. Wait for the `:joined` (or `pending` event
via the in-flight map) to be received via WS, THEN add.

ACTUALLY (per brainstorm): the WINDOW opens optimistically when user
clicks JOIN — but in `pending` state. The sidebar entry appears
immediately, just dimmed/loading. Server events transition it to
joined/failed. So "drop optimistic mutations" is wrong wording — keep
the optimistic OPEN, drop the optimistic STATE assumption.

### Subscribe.ts handlers

Add handlers for `:joined`, `:join_failed`, `:parted`, `:kicked`,
`:window_state`. Each updates `windowStateByChannel` + relevant store.

### MembersPane

When `windowStateByChannel[key] === "joined"` AND members store has no
entry: render `loading…` muted text.

When `windowStateByChannel[key] !== "joined"`: hide pane or render
"not joined" text. No REST fetch (REST returns empty anyway).

Drop the once-per-channel `loadedChannels` gate — `loadMembers` is
gone, replaced by event-driven seeding via `members_seeded` (server
pushes on after_join now, plus on every 366).

### ScrollbackPane

No state-machine awareness needed for scrollback ROW rendering — rows
render the same regardless of window state. The READ-ONLY visual
(failed/kicked/parked/archived-channel) is at the ComposeBox layer.

### ComposeBox

When window state is `failed` / `kicked` / `parked` / archived-channel:
visual cue (greyed out, "not joined" hint label, irssi-style).
Compose stays functional — user can type `/join` etc. PRIVMSG send
attempts go through; server replies with "cannot send to channel"
which renders in-window.

When window state is archived-query: compose enabled, sending revives.

### Sidebar

Two sections per network:
1. Active windows — current behavior.
2. Archive (collapsed) — lazy-loaded list, mixed channels + queries
   sorted by last_activity desc.

Within active section, failed/kicked/parked windows are dimmed but
present.

Mobile bottom-bar: same model, archive layout TBD at implementation
(separate collapsible vs nested vs swipe-to-archive). Defer the visual
detail.

## Test plan (sketch — full plan at impl time)

Server:
- EventRouter unit tests for new events.
- In-flight JOIN map: tests for TTL, sort, attribution-on-numeric.
- `push_channel_snapshot` extension: tests for members + window_state
  push on after_join.
- REST `/archive` endpoint tests.

Cic:
- vitest: `windowStateByChannel` transitions on each event kind.
- vitest: ComposeBox rendering per window state.
- vitest: MembersPane "loading…" vs rendered list vs "not joined".
- e2e (Playwright): full flow — POST /channels → window appears
  pending → loading members → joined+populated. Failure flow: invite-only
  channel → window appears pending → fails → greyed + retry. Archive
  flow: PART → moves to archive → click in archive → re-joins → moves
  back to active.

## Decisions pinned (brainstorm 2026-05-07 vjt)

1. **Autojoin same path**, no special-case (server-bootstrap autojoin
   emits the same `:joined` events as cic-initiated JOIN).
2. **Window opens on JOIN intent (optimistic open)**, transitions
   based on server events. Members "loading…" until 366.
3. **Failed/kicked/parked render in the same window** (no $server
   redirect for failure messages — better UX, operator stays in
   context).
4. **Out-of-order events fine** (cic projects each event independently;
   no ordering invariants beyond "events arrive after subscribe").
5. **Visitor same lifecycle** (TODO: verify visitor JOIN path emits
   the same events at impl time).
6. **Archive UX**:
   - Active and archive in **separate sections** per network.
   - Active → archive triggers: USER PART, USER × on channel/query
     window. NOT KICK (stays active, kicked state). NOT T32 disconnect
     (stays active, parked state).
   - Archive → active triggers: click "Join" on archived channel; type+
     send in archived query.
   - Archive collapsed by default.
   - Mixed channels + queries.
   - Sorted by last_activity desc.
   - Archived channel windows: read-only visual, "Join channel"
     button. Operator can type `/join #chan key` if needed.
   - Archived query windows: typing+sending revives the window.
   - $server: always active, never archived.
   - Delete deferred (future trash icon).
   - Members "loading…" copy: literally `loading…` muted text.
7. **Members race fix (after_join push) STILL needed alongside**
   — different race window (deploy reconnect) than the one a67e890
   covered. Will be the same `members_seeded` payload, pushed from
   `push_channel_snapshot` instead of from EventRouter.

## Sequencing

Pre-cluster:
- CP14 B3 (DM `:dm_with` schema) lands first → unblocks the archive
  surface's "list distinct DM targets" logic. Without `:dm_with`,
  archive splits DMs across past own-nicks.
- CP14 closes (B1, B2, B3 all LANDED).
- /close → /clear → /start → open this cluster.

Cluster open:
- Read this intent doc.
- Write `docs/plans/2026-05-07-event-driven-windows-impl.md` —
  detailed bucket breakdown, TDD steps, exit criteria.
- Buckets (sketch — refine at plan time):
  - **B1 — server-side `:joined` event** + emit on JOIN echo (route
    parsing, EventRouter, broadcast, server tests).
  - **B2 — server-side `:join_failed` event** + in-flight JOIN map +
    failure numeric routing.
  - **B3 — server-side `:parted`/`:kicked`/`:window_state` events** +
    `push_channel_snapshot` extension (window_state + members).
  - **B4 — REST /archive endpoint** + cic archive store + Sidebar
    archive section UI.
  - **B5 — cic window state model** (`windowStateByChannel` store +
    subscribe.ts handlers + MembersPane "loading…" + ComposeBox
    state-aware rendering + drop optimistic mutations).
  - **B6 — full e2e**: pending/joined/failed/kicked/parked/archived
    flows, verified via integration.sh.
  - **B7 — docs sweep**: DESIGN_NOTES entry for the projection rule
    extension; CLAUDE.md invariant updated; README.md note on UX
    behavior.

Sized: 4–6 sessions. Closes 3 todo items + the members race + the
channel-not-connected ghost-window bug.

## Closes

- todo.md "Channel-window must show 'not connected' state when upstream
  is failing." (line 126)
- todo.md "Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER
  C5)." — already closed by CP14 B2.
- The members-empty bug surfaced 2026-05-07 (deploy-reconnect race).
- The "ghost window for unjoinable channel" bug (it-opers case).
- The optimistic-state-assumption class of bugs at large.

## Implementation-time questions (deferred to plan doc)

- Visitor JOIN path verification (same events emitted?).
- Bootstrap autojoin failures: same `:join_failed` shape, or a
  bootstrap-specific event for "tried 5 channels at boot, 1 failed"?
  (Lean: same shape, no special-case per Q1.)
- `/archive` REST shape: single endpoint or per-kind sub-endpoints?
- `state.window_state` schema — atom in GenServer state vs separate
  ETS/registry? (Lean: GenServer state, same lifetime as `state.members`.)
- Window-state persistence across server restart — derive from
  `state.members` keyset (channels we successfully JOINed = `:joined`,
  not in keyset but in autojoin = `:pending`/`:failed` per last
  attempt outcome)? Or persist explicitly? (Lean: derive on boot,
  no new persistence.)
- Mobile archive layout (separate collapsible tab vs nested in active
  network group).
- Compose box dimming visual specifics — irssi-style label, opacity,
  border treatment.
- /join slash-command parser presence (need to check).
- Failure numeric → window mapping when no in-flight attempt matches
  (server-initiated JOIN with no labeled-response cap, server-side
  bug where the in-flight map lost the entry): fall back to $server.
