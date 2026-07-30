# #554 — Operator KILL/AKILL must be terminal, not a Backoff reconnect

## Problem

An oper-initiated `KILL` (and an AKILL, delivered upstream as a `KILL` + socket
close) is not modelled as a terminal condition. `KILL` is parsed
(`parser.ex:90` → `:kill`, typed `message.ex:67`) but no `handle_info/2` clause
in `server.ex` matches `command: :kill`. So a self-`KILL` falls through the
generic `delegate` clause (`server.ex:2874`) → `EventRouter` catch-all
`route_unhandled_command` (`event_router.ex:2359`) → persists a `:server_event`
row on `$server` (visible but **not** terminal) → then the upstream socket
closes → `tcp_closed` → `terminate/2` abnormal → `Backoff.record_failure` →
`:transient` respawn → reconnect straight into the ban that was just applied.

The ban is only discovered on the *next* connect, via numeric 465, which is
already terminal (`server.ex:2633` → `handle_terminal_failure/2`). That costs
one extra full connect per akill — and reconnecting against a banned address is
exactly what upstream connection throttling punishes, so the current recovery
path makes things worse.

## Domain check (challenge the spec) — RESOLVED in favour

The load-bearing assumption is that the upstream delivers the `KILL` to the
victim with the victim's own nick as the target. This holds: `m_kill` in the
hybrid lineage (bahamut / Azzurra, all of prod) and the ratbox lineage
(solanum / Libera) both `sendto_one(target, ":<killer> KILL <victim> :<reason>")`
to the *local* victim before calling `exit_client`. So `params = [own_nick,
comment]`. The real integration e2e is what proves this end-to-end; if some
ircd does NOT deliver the KILL to the victim, the fallback would be to key off
the `ERROR :Closing Link ... (Killed ...)` line instead — out of scope unless
the e2e disproves the assumption.

## Design

One new `handle_info` clause in `lib/grappa/session/server.ex`, placed BEFORE
the generic `delegate` clause (`:2874`), mirroring the 465 handler (`:2633`):

```elixir
def handle_info({:irc, %Message{command: :kill, params: [target | rest]} = msg}, state)
    when is_binary(target) do
  if fold_key(state, target) == fold_key(state, state.nick) do
    comment = List.last(rest) || "killed"
    reason = "killed: #{comment}"
    Logger.error(
      "operator KILL received — session marked :failed (network_id=#{state.network_id})",
      reason: reason
    )
    handle_terminal_failure(reason, state)
  else
    delegate(msg, state)
  end
end
```

### Decisions

- **Self-match** via `fold_key/2` (`server.ex:2980`, the network-aware
  `canonical_target`) so a cased KILL target (`OwnNick` vs `ownnick`) still
  matches — respects the #537/#121 identifier-fold invariant. Never a bare `==`
  or `String.downcase`.
- **Match on TARGET only, sender-agnostic.** An AKILL/services kill may arrive
  from a server or a service prefix, not an oper nick; keying on `target ==
  own_nick` is the general rule (fix the class, not the oper-nick example).
- **Distinct reason prefix** `"killed: "` — distinct from `"k-line: "` (465) and
  `"sasl: "` (904) so the client can render "killed by an operator" instead of a
  generic reconnect spinner. The reason ships to cic verbatim through the
  existing `Networks.mark_failed/2` → `broadcast_state_change/4` →
  `{:connection_state_changed, %{reason: ...}}` on `Topic.user`.
- **No Backoff, no respawn, no Bootstrap-retry** — all free via
  `handle_terminal_failure/2`: it fires the `credential_failer` (→
  `Networks.mark_failed` → `connection_state=:failed`, which Bootstrap skips on
  the next deploy) and returns `{:stop, :normal, state}`; `terminate/2` excludes
  `:normal` from `Backoff.record_failure`, and `:transient` does not restart on
  a normal exit.
- **KILL targeting another nick** → `delegate(msg, state)` unchanged: it still
  persists the `:server_event` row and the socket stays open. Ordinary traffic.
- **Malformed KILL** (empty params / non-binary target) falls through to the
  generic clause (`:2874`) → non-terminal. Correct: a malformed KILL is not a
  ban signal.
- **No scrollback row on self-KILL**, mirroring 465: the comment lives in the
  credential reason, not a `$server` row. (Non-self KILL keeps its row.)
- **cic UI rendering** of the distinct "killed" reason is a follow-up (separate
  cic issue); this change is server-only. cic already surfaces
  `connection_state_reason` for `:failed`, so no reconnect spinner is shown.

## Mailbox ordering proof (KILL beats Backoff — proven, not assumed)

The concern: after a KILL the ircd sends `ERROR :Closing Link ... (Killed ...)`
then FINs the socket. If the disconnect signal (`tcp_closed` → `{:EXIT}` →
`Backoff.record_failure`) were processed before the KILL, the session would
respawn and the bug would return. It does not, proven from `IRC.Client`:

1. **Line framing, `active: :once`** (`client.ex:1273`/`:1281`): socket is
   `packet: :line, active: :once`. Each complete IRC line (`KILL x :reason\r\n`)
   arrives as ONE `{:tcp, sock, line}` — OS-level framing, "immune to TCP packet
   boundary races" (moduledoc `:18`).
2. **Forward BEFORE anything** (`client.ex:1483`): `process_line/2` does
   `send(state.dispatch_to, {:irc, msg})` to `Session.Server` before the FSM step
   and before re-arming `active: :once` (`:1500`).
3. **Re-arm only AFTER the forward** → moduledoc invariant (`:19-24`): the Client
   does not receive line N+1 until line N has been parsed and forwarded. So the
   Client cannot even observe `{:tcp_closed}` until the KILL has been forwarded.
4. **`tcp_closed` → stop** (`client.ex:1032`): `{:stop, :tcp_closed, state}` → the
   linked Client dies → `{:EXIT, client_pid, :tcp_closed}` reaches `Session.Server`.
5. **FIFO mailbox**: `{:irc, kill}` was delivered strictly before the Client
   processed `{:tcp_closed}`, so `Session.Server`'s mailbox is `{:irc, kill}`
   (and any `{:irc, error}`) THEN `{:EXIT}`. It processes the KILL first →
   `handle_terminal_failure` → `{:stop, :normal}` → stops before ever dequeuing
   `{:EXIT}`, so the abnormal-EXIT clause that calls `Backoff.record_failure`
   never runs.

**ERROR is not terminal**: there is no `handle_info` for `command: :error` in
`server.ex` (the only `:error` match, `:2261`, is `{:irc_peer, {:error, _}}` —
the downstream facade, unrelated). ERROR falls to the generic `delegate` →
`server_event`; its order relative to the KILL is irrelevant. The ONLY Backoff
trigger is `tcp_closed`→`{:EXIT}`, which is strictly last.

**The single assumption the code cannot self-prove** is that the ircd delivers
the KILL as a complete line before the FIN. That is exactly what the integration
e2e proves against real bahamut — hence it is load-bearing, not decorative.

## Testing

### Unit (TDD, `test/grappa/session/server_test.exs`)

Mirror the 465 terminal test at `:6168` (describe block `:6154`):

1. **self-KILL** (`params: [own_nick, comment]`) → calls `mark_failed` with
   `"killed: <comment>"` reason, session terminates `:normal`, **no** Backoff
   bump.
2. **fold-case self-KILL** (`params: ["OwnNick", ...]` vs `state.nick =
   "ownnick"`) → still terminal.
3. **KILL targeting another nick** → delegates, persists a `:server_event` row,
   session **stays alive** (process still `Process.alive?`).
4. **malformed KILL** (`params: []`) → stays alive (falls to generic clause).

### Integration e2e (real ircd)

An oper peer issues `KILL` against the grappa session's nick on the real
testnet; assert the credential transitions to `:failed` and there is **no**
reconnect. Proves the ircd delivers the KILL to the victim AND the terminal
path end-to-end. Requires a vjt-allocated e2e lane.

## Out of scope

- Address mapping / ban granularity (#454).
- ERROR-line fallback (only if the e2e disproves KILL delivery).
- cic dedicated "killed by an operator" rendering (follow-up cic issue).
