# Server-side `:pending` window-state origination

Cluster: `cluster/server-side-pending` (CP17). Closes Theme 2 of the
2026-05-08 architecture review: cic re-introduces a parallel state
machine via `compose.ts:210 setPending(...)`, which is a CLAUDE.md
hard-invariant violation ("cic NEVER originates state — no optimistic
STATE assumptions, no parallel client-side state machine").

## Problem

The CP15 B5 typed window-state surface put the server in charge of
`:joined / :failed / :kicked / :parked` transitions, with cic mirroring
via per-channel topic events. But `:pending` was left as a cic-side
optimistic write because of a bootstrap race:

* `Session.Server` records `record_in_flight_join/2` on `{:send_join,
  ch}` cast (and during 001 RPL_WELCOME autojoin), but does NOT mutate
  `window_states[ch] = :pending` — pre-cluster the slot was implicit
  ("absence == pending while a JOIN is in flight" per the moduledoc
  on `lib/grappa/session/server.ex:181`).
* cic `compose.ts:210` calls `setPending(channelKey(...))` immediately
  after `postJoin(...)` so that `subscribe.ts:425`'s pre-subscribe
  loop can join the per-channel WS topic BEFORE the upstream JOIN
  echo arrives. Without this, Phoenix PubSub doesn't replay to late
  subscribers and the typed `joined` / `join_failed` events drop on
  the floor.

The cic-side mutation is a workaround for a missing server-side
broadcast. It violates the invariant; it's the only `setPending`
call site that originates state (the others mirror server events).

## Design

### Why the broadcast lives on `Topic.user`, not the per-channel topic

The `:joined / :failed / :kicked` events are broadcast on the
per-channel topic because by the time those fire, cic is already
subscribed (the pending-loop joined the topic in advance). For
`:pending` the situation is inverted: cic only learns to subscribe
to the per-channel topic AFTER seeing `:pending` in
`windowStateByChannel`. Broadcasting `:pending` on the per-channel
topic would be a chicken-and-egg — cic can't receive an event on a
topic it hasn't subscribed to yet.

The user-level topic is the right transport: cic is subscribed to
`Topic.user(...)` from boot (userTopic.ts createRoot effect, joins
on token resolution). A `kind: "window_pending"` event reaches
EVERY tab logged into the same account immediately, mirroring the
existing `connection_state_changed` user-topic event (CP15
codebase-review-fixes H1 + CP16 B3).

### Snapshot semantics

The `push_window_state_if_known` snapshot push on per-channel
after_join is IRRELEVANT for `:pending` — cic only subscribes to a
per-channel topic AFTER state is already `:pending`, so the snapshot
can't deliver new information. The user-topic after_join push
likewise SKIPS pending-channels snapshot because:

* In-flight TTL is 30s — by the time a cic reconnect cycle
  completes, the JOIN has typically already resolved.
* Pre-cluster, `setPending` was also transient (cleared on token
  rotation), so this maintains behavioral parity.
* Tight scope per cluster brief — out-of-scope work creates churn.

Snapshot for `:pending` is therefore a no-op via design, not a
forgotten case. Documented in the moduledoc + DESIGN_NOTES.

### Effect-arm shape

`record_in_flight_join/2` currently mutates only `state.in_flight_joins`.
The cluster wraps it in a higher-level helper that ALSO:

1. Writes `window_states[channel] = :pending`.
2. Broadcasts `SessionWire.window_pending(network_slug, channel)` on
   `Topic.user(state.subject_label)`.

Same call sites: `handle_cast({:send_join, ch})` AND the autojoin
loop in `handle_info({:irc, %Message{command: {:numeric, 1}}})`.

### `Grappa.Session.Wire.window_pending/2`

New verb. Shape:

```elixir
%{kind: "window_pending", network: String.t(), channel: String.t(), state: "pending"}
```

`kind:` differs from the per-channel `joined / join_failed / kicked`
naming because the user-topic dispatcher (`userTopic.ts`) needs a
distinct kind to route to `setPending`. Naming convention:
`window_<state>` mirrors the existing `connection_state_changed`
user-topic verb (state-change events on user-topic carry a
"window-namespace" prefix to avoid collision with channel-namespace
verbs that share state names like `joined`).

### cic-side changes

* `compose.ts:210` — DROP the `setPending(channelKey(...))` call.
  Add a comment pointing at the server-side origin.
* `userTopic.ts` — add `case "window_pending"` arm; dispatch to
  `setPending(channelKey(payload.network, payload.channel))`.
* `lib/api.ts` `WireUserEvent` discriminated union — add
  `{ kind: "window_pending"; network: string; channel: string;
  state: "pending" }` arm. tsc enforces exhaustiveness.
* `windowState.ts` `setPending` export — KEEP. It's now fed by the
  user-topic dispatcher instead of compose.ts. Same signal mutation;
  the pre-subscribe loop in `subscribe.ts:425` re-runs on the
  signal change regardless of who calls setPending.

### Tests

* Server: `test/grappa/session/wire_test.exs` — add `window_pending/2`
  shape + JSON-encodable test.
* Server: `test/grappa/session/server_test.exs` (or the corresponding
  test file for `handle_cast({:send_join, _})`) — assert that the
  cast updates `window_states[ch] = :pending` AND broadcasts the
  Wire payload on `Topic.user`.
* Server: same coverage for the autojoin loop on 001 RPL_WELCOME.
* cic: `__tests__/userTopic.test.ts` — add a case driving the
  `window_pending` event through the dispatcher; assert
  `windowStateByChannel()` contains the key with state `"pending"`.
* cic: `__tests__/compose.test.ts` — REMOVE the assertion that
  `setPending` is called on `/join`; replace with assertion that
  setPending is NOT called by compose.ts (server-driven now).
* cic: `__tests__/subscribe.test.ts` — verify the pre-subscribe
  loop still triggers when state goes pending via WS event (not
  via compose).
* e2e: `cicchetto/e2e/tests/cp17-server-side-pending.spec.ts` —
  Playwright. Issue `/join #foo` from the compose box; assert the
  channel appears greyed (pending) in the sidebar; assert the
  channel transitions to joined-style when upstream echoes.

## Buckets

### B0 — open worktree + plan + CP17 (this commit)

* `.worktrees/server-side-pending` from local main ✓
* This plan file ✓
* `docs/checkpoints/2026-05-08-cp17.md` (status: active)
* todo.md note (Theme 2 in progress)

### B1 — server-side: Wire verb + state mutation + broadcast

TDD — failing tests FIRST in this order:

1. `wire_test.exs` — `window_pending(slug, channel)` returns the
   pinned shape; Jason-encodes; type spec matches.
2. Server-test for `handle_cast({:send_join, ch})` — assert
   post-cast `state.window_states[channel] == :pending` AND
   `Phoenix.PubSub` received `Wire.window_pending(...)` on
   `Topic.user(subject_label)`.
3. Server-test for the autojoin path on 001 RPL_WELCOME — same
   assertions.
4. Snapshot path — `get_window_state` for `:pending` returns
   `{:ok, Wire.window_pending(slug, channel)}` (not the existing
   `:not_tracked` arm).
5. `window_state_payload/3` arm for `:pending` — symmetric.

Implementation:

* Add `Grappa.Session.Wire.window_pending/2` + typespec.
* Wrap `record_in_flight_join/2` so its callers ALSO mutate
  `window_states + broadcast`. Two call sites:
  * `handle_cast({:send_join, channel}, state)` line 898.
  * The autojoin reduce in 001 RPL_WELCOME (line 1015).
* Update `get_window_state` arms (line 854) to handle `:pending`.
* Update `window_state_payload/3` (line 1931) for `:pending`.

Gates: scripts/test.sh on the touched paths + scripts/credo.sh +
scripts/dialyzer.sh.

### B2 — cic: drop setPending workaround + dispatch typed pending event

TDD — failing test FIRST:

1. `userTopic.test.ts` — drive `kind: "window_pending"` payload
   through dispatcher; assert `windowStateByChannel()` mutates.
2. `compose.test.ts` — assert `setPending` is NOT called by
   `/join` action (REMOVE the existing assertion that it IS).
3. `subscribe.test.ts` — verify pre-subscribe loop fires on the
   server-driven mutation.

Implementation:

* `lib/api.ts` — extend `WireUserEvent` union with `window_pending`.
* `lib/userTopic.ts` — add `case "window_pending"` arm dispatching
  to `setPending(channelKey(...))`.
* `lib/compose.ts:210` — REMOVE the `setPending(...)` call. Add a
  comment explaining server-side origin (CP17).

Gates: scripts/bun.sh check + scripts/bun.sh test + e2e spec.

### B3 — cluster close

* DESIGN_NOTES entry under `## 2026-05-08 — CP17 server-side-pending`.
* CP17 close (status: complete).
* todo.md update — drop the "cic re-introduces parallel state
  machine" pending follow-up (was logged in CP16 close).
* Full check.sh + dialyzer.sh + bun check + bun test +
  integration.sh — literal gate-tail paste.
* Rebase onto main → merge --no-ff → push → deploy →
  healthcheck → browser smoke at voygrappa.bad.ass:
  hard-reload, /join a fresh channel from compose box, observe
  the greyed pending row → joined transition.

## Out of scope (explicit non-goals)

* arch A6 `channels_changed` typed-delta refactor — bigger
  conceptual change with cic store implications. NOT bundled here
  per cluster brief.
* Theme 3 `Session.Server.WindowState` extraction — separate
  cluster (~half session). The new `:pending` arm just slots into
  the existing maps; the extraction is mechanical once Wire is
  pervasive (which it is now after CP16).
* T32 parked-spec design pass — DESIGN-BLOCKED, separate cluster.
* User-topic snapshot push for currently-pending channels on
  WS reconnect — design choice for parity (see "Snapshot
  semantics" above). Document the tradeoff; do not implement.

## Risk + rollback

Risk surface is small: the `:pending` event is additive on the wire.
A rollback is `git revert` of the cluster merge — cic falls back
to compose-driven setPending (the workaround), server falls back
to implicit absence-means-pending. The cic dispatcher arm with no
matching server event is a no-op (defensive narrowing inside the
switch); the server broadcast with no cic listener is a no-op
(PubSub silently drops). No persistent state change, no migration.
