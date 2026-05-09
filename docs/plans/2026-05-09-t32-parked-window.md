# T32 parked-window — design pass

> **Status**: design brainstorm 2026-05-09. Pinned decisions go to a
> "Decisions pinned" section at the bottom before impl starts. NO CODE
> until vjt signs off.

## Why this doc exists

CP15 B6 brief said `cp15-b6-parked.spec.ts` was "mechanically
authorable now." That was wrong on the producer side. CP18 pending
flagged the gap. CP19 picks it up.

**The gap** (verified 2026-05-09 against current main):

- `Networks.disconnect/2` (`lib/grappa/networks.ex:291-302`) does:
  best_effort_quit → `Session.stop_session/2` → DB transition →
  `broadcast_state_change(updated, :connected, :parked, reason)` on
  the user-topic.
- `Session.stop_session/2` calls `DynamicSupervisor.terminate_child/2`.
  The Session.Server dies. **No per-channel `:parked` event ever
  fires.** `state.window_states` evaporates with the GenServer.
- cic receives `connection_state_changed → :parked` on the user-topic
  and updates `networkBySlug[slug].connection_state = :parked`. But
  the **per-window sidebar rows for channels under that network stay
  visually normal** — `windowStateByChannel` still has them as
  `:joined` (last value before the GenServer died), and even if it
  didn't, cic doesn't read the network's `connection_state` to derive
  a per-channel greyed class.
- `Sidebar.tsx:45` `NOT_JOINED_STATES = {failed, kicked, parked}` is
  ready to grey parked rows — but nothing puts them in the parked
  state.
- `ComposeBox.tsx:28` same — ready, not driven.

**Net**: today, /disconnect leaves the cic UI looking fully connected
across every channel window. The only signal is the network-row in
some hypothetical future "network connection state" pill, which
doesn't exist as a UI surface yet either.

## Three design questions (CP18 raised)

### Q1 — Do per-channel windows survive park?

**Two options:**

#### Q1.A — Yes, emit per-window `:parked` from Session.Server `terminate/2`

`Session.Server` adds a `terminate(reason, state)` callback that, when
the reason is the T32 supervised stop, iterates `state.window_states`
and broadcasts `%{kind: "parked", network: slug, channel: chan, state:
"parked"}` on each per-channel topic before the GenServer exits.

- **Pro**: cic's existing `windowStateByChannel` model handles it.
  Sidebar greys rows. ComposeBox greys. Zero new state model.
- **Pro**: symmetric with `:joined`/`:failed`/`:kicked` event surface.
  The "one state model on the server" invariant stays clean.
- **Con**: `terminate/2` running broadcast logic during shutdown is
  fragile — a crash in the iteration silently swallows window updates
  (the supervisor would log, the broadcast would partial-fire).
- **Con**: race with Session.stop_session — DynamicSupervisor's
  `terminate_child/2` issues `:shutdown` (default 5s timeout); the
  terminate callback's broadcasts must complete before the trap exits.
  Phoenix.PubSub.broadcast is fast (sub-ms) so this is fine in
  practice.
- **Con**: the broadcast lands on cic but if cic is offline (mobile
  backgrounded), the per-channel topic sub is dropped until WS
  reconnect — no replay of `:parked` because the GenServer is dead and
  there's no `push_channel_snapshot` for per-channel topics on a
  parked network (the channel topic itself goes silent — Phoenix
  PubSub is fan-out, not durable).

#### Q1.B — No, derive parked from `connection_state == :parked`

cic reads `networkBySlug[slug].connection_state`. When `:parked`,
treat **every** window for that network as visually parked — Sidebar
greys all rows under the parked network, ComposeBox greys for any
selected window in that network. No new server-side event.

- **Pro**: zero server-side change. The user-topic
  `connection_state_changed` event already carries the network-level
  intent. cic just reads it.
- **Pro**: derivation is automatic on WS reconnect — `userTopic.ts`
  already pulls fresh `connection_state` on join.
- **Pro**: no per-window broadcast bursts on disconnect. A network
  with 30 channels triggers 1 user-topic event, not 30 channel-topic
  events.
- **Con**: cic gains a derivation path that mixes "per-channel state"
  (`windowStateByChannel`) with "per-network state"
  (`networkBySlug.connection_state`). The Sidebar/ComposeBox helpers
  need to consult both. Not a hard problem but it's two sources of
  truth for "is this window usable."
- **Con**: when the network goes back to `:connected`, cic must
  remember which channels were `:joined` before park to render them
  correctly. Today `windowStateByChannel` is the source — and it's
  authoritative until the WS reconnects + `push_channel_snapshot`
  re-pushes window_state for each channel from the freshly-spawned
  Session.Server. So the post-`/connect` flow is: `connection_state →
  :connected` event arrives → no per-channel event yet → cic still
  shows greyed → WS re-subscribes per-channel → snapshot pushes
  `:joined` (after autojoin completes, typically <1s) → ungreys.
  That's actually the same flow as B6 e2e for "T32 reconnect."
- **Con**: window_states map evaporates on GenServer death — cic's
  in-memory `windowStateByChannel` retains the LAST values from before
  park. That's OK as long as cic's derivation is "parked OR not joined
  → greyed." The post-park values are stale-but-not-misleading.

#### Recommendation: Q1.B (derive)

Aligns with CLAUDE.md "Don't duplicate state that already exists —
derive it." `connection_state == :parked` is the single source of
truth; cic's per-window rendering becomes a function of (window state,
network connection state). No new event surface. No `terminate/2`
broadcast contortions. The per-channel topic going silent on park is
correct — there's no Session.Server to listen for, anything sent on
that topic during park would be dropped anyway.

The derivation rule, codified:

```
window-effective-state(window) =
  if window.network.connection_state == :parked then :parked
  else if window.network.connection_state == :failed then :failed
  else windowStateByChannel[window.key] ?? :joined-implied
```

(cic helpers `isGreyed(slug, name)` etc. extend to consult
`networkBySlug[slug].connection_state` as a first check.)

### Q2 — Per-network overlay vs per-channel?

If Q1.B picks derivation: BOTH apply naturally.

- **Network-row**: render greyed when `connection_state ∈ {:parked,
  :failed}`. Simple top-level visual.
- **Per-channel rows under that network**: render greyed via the
  derivation rule above. Cascading visual.

Per CLAUDE.md "lightweight over heavyweight" — the cascading rule is
ONE conditional in the rendering helper, not a parallel state map.

**Network-row rendering**: today Sidebar.tsx renders network as a
header + a list of channels under it. There's no greyed style for the
network header itself. We add `.sidebar-network-greyed` class applied
to the network header when `connection_state ∈ {:parked, :failed}`.
Existing `.sidebar-window-greyed` at the row level handles the
cascade.

The reason text — `connection_state_reason` — surfaces as a tooltip
on the greyed network header (HTML `title=` attr is the
zero-bundle-cost option; if the design wants a richer tooltip we can
escalate later).

### Q3 — Wake on `Networks.connect/1` — Bootstrap restart latency vs eager spawn?

**Resolved by code inspection (no design needed).**

`NetworksController.connect/2` (`lib/grappa_web/controllers/networks_controller.ex:172-191`)
calls `Networks.connect(credential)` then `spawn_session_after_connect/3`,
which routes through `SpawnOrchestrator` (admission + Backoff.reset +
`Session.start_session/3`). Wake is **eager, sub-second** on the same
HTTP round-trip. No Bootstrap restart needed.

The post-`/connect` UI flow (per Q1.B):

1. cic POSTs `/connect`.
2. NetworksController flips DB to `:connected`, broadcasts
   `connection_state_changed → :connected` on user-topic.
3. NetworksController spawns Session.Server via SpawnOrchestrator.
4. cic receives the user-topic event → `networkBySlug[slug].connection_state = :connected`.
   Sidebar ungreys network-row immediately.
5. Per-channel rows still derived as `:joined` from cached
   `windowStateByChannel` (which retained pre-park values). They render
   ungreyed because the network derivation no longer overrides.
6. Session.Server's RPL_WELCOME 001 handler runs autojoin loop →
   per-channel `:pending` → `:joined` events fire → cic updates
   `windowStateByChannel` to fresh values. (If autojoin hits
   `:failed` for a channel, that channel renders greyed via the
   per-channel rule.)

**Edge case**: between steps 5 and 6 (post-connect, pre-autojoin-complete)
there's a ~1s window where cic shows channels as joined but the
underlying Session.Server hasn't actually JOINed them yet. PRIVMSG
during this window is server-rejected with "cannot send to channel."
That's the same race as a fresh page load before WS subscribe — cic
already handles it by surfacing the server's reject as an inline
scrollback row. Not new, not blocking.

**Alternative** (rejected): hold the user-topic `:connected` broadcast
until post-autojoin to avoid the race. Rejected because (a) some
channels might never JOIN (failed numerics) — the broadcast would
hang; (b) the operator wants immediate feedback on `/connect`.

## Cluster scope

**3 commits, single bucket**:

1. **server**: nothing to do (verified). The user-topic
   `connection_state_changed` event is already sufficient under Q1.B.
   Add a sanity test asserting the broadcast fires on disconnect +
   connect.
2. **cic**:
   - Sidebar derivation: extend `isGreyed/2` to consult
     `networkBySlug[slug].connection_state` first; if `∈ {:parked,
     :failed}` return true.
   - Network header: add `.sidebar-network-greyed` class when network
     connection_state ∈ {:parked, :failed}; tooltip with reason.
   - ComposeBox: same network-derivation in the `NOT_JOINED_STATES`
     check (mixed state — per-window OR network-level).
   - vitest coverage: each derivation rule.
3. **e2e**: `cp15-b6-parked.spec.ts` covers the full flow:
   - JOIN a few channels → assert active state.
   - `/disconnect` → assert network header + all channel rows greyed.
     Assert ComposeBox greyed.
   - `/connect` → assert network ungreys → assert channels ungrey
     once autojoin completes (wait for `:joined` events).
   - Reason rendering: tooltip on greyed network header.

**Sized**: 1 session. The code is small; the design doc is the heavy
lift.

## Open follow-ups (out of scope this cluster)

- **Network header reason rendering** — title attr now; richer
  tooltip later if vjt wants it.
- **Bootstrap-time `:failed`** — if Session.Server hits
  `mark_failed/2` for a network at boot (k-line on autojoin), cic
  shows `:failed` on the network. Same derivation rule covers it.
  No additional work.
- **Mobile BottomBar parity** — same derivation; needs visual
  greyed treatment on the BottomBar grouped-by-network rows. If
  BottomBar already reads `windowStateByChannel` for its own greyed
  treatment, the network-derivation slots in identically.

## Decisions pinned 2026-05-09 vjt

- **Q1**: derive (B) — no per-window `:parked` event from
  `terminate/2`; cic derives from `networkBySlug[slug].connection_state`.
- **Q2**: cascading per-channel + network header greying via the
  same derivation rule. `.sidebar-network-greyed` on network header,
  `.sidebar-window-greyed` (existing) on per-channel rows via the
  extended derivation.
- **Q3**: nothing to decide — eager spawn already in
  `NetworksController.connect/2`.
- **Reason rendering**: tooltip via `title=` attr.
- **Cluster sequencing**: server sanity test + cic derivation + e2e.

## Decisions pending vjt sign-off

- **Q1**: derive (B) vs emit (A). Recommendation: B.
- **Q2**: cascading per-channel + network header greying.
  Recommendation: both, via the same derivation rule.
- **Q3**: nothing to decide — eager spawn already in code.
- **Reason rendering**: tooltip via `title=` attr.
- **Cluster sequencing**: 1 commit (cic) + 1 commit (e2e) +
  documentation update in same cluster.
