defmodule Grappa.PubSub do
  @moduledoc """
  Namespace for grappa-internal `Phoenix.PubSub` helpers.

  The atom `Grappa.PubSub` doubles as the registered name of the
  application's `Phoenix.PubSub` server (started under the application
  supervision tree). Erlang/OTP allows the same atom to serve as
  both a module name and a registered process name without conflict —
  module definitions live in the code-server table; registered names
  live in the kernel name table.

  ## Channel-event broadcast helper

  `broadcast_event/2` is the single source of truth for emitting an
  `"event"`-typed payload to a `GrappaWeb.GrappaChannel` topic. It
  wraps the Phoenix-internal `Phoenix.Channel.Server.broadcast` helper
  (used by `Phoenix.Endpoint.broadcast` itself), which sends a
  `%Phoenix.Socket.Broadcast{event: "event", payload: payload}` via
  `Phoenix.PubSub` using the framework's channel-server dispatcher.

  Two important properties of this dispatcher (vs the default PubSub
  one used by raw `Phoenix.PubSub.broadcast/3`):

    1. **Fastlane-aware fan-out.** The channel-server dispatcher
       inspects each subscriber's metadata and, for fastlane entries
       (installed automatically when a channel join completes),
       serializes the broadcast ONCE and writes it directly to the
       transport pid — bypassing the channel's `handle_info/2`
       mailbox. Plain subscribers (test processes, internal
       observers) still receive the `%Broadcast{}` message intact.

    2. **No double-push.** When the channel uses ONLY the framework's
       fastlane subscription (no manual `Phoenix.PubSub.subscribe`),
       a single `broadcast_event/2` call results in a single WS push.
       Mixing manual `subscribe` + framework fastlane causes a 2x
       push per event — see BUG 6.

  Use this from any broadcaster (REST controller, `Session.Server`,
  `QueryWindows`, future Phase 6 listener facade) so the wire
  contract stays single-sourced.
  """

  use Boundary, top_level?: true, deps: [], exports: [Topic]

  @doc """
  Broadcasts a typed `"event"` payload to a `GrappaChannel` topic via
  the Phoenix Channel framework's fastlane-aware dispatcher.

  The payload is delivered to clients as `phx_msg{event: "event",
  payload: payload}` exactly once per connected socket on the topic.
  Plain `Phoenix.PubSub.subscribe/2` subscribers (test processes,
  internal observers) receive the raw `%Phoenix.Socket.Broadcast{}`
  struct.

  `Phoenix.Channel.Server.broadcast` returns `:ok | {:error, term()}`
  but the local PG2 adapter (the only one configured for this app)
  never errors in practice — distributed adapters would. The
  state-transition is the authoritative effect; a missed broadcast is
  at most a stale UI badge, not a correctness problem. Returning `:ok`
  unconditionally lets callers stay in `:ok =`-only arms (mirrors
  the `broadcast_state_change` private helper in `Grappa.Networks`).

  ## Struct guard (no-silent-drops B6.2)

  The `is_map(payload) and not is_struct(payload)` guard is
  load-bearing. CP15 B6 root cause was a raw `%Window{}` schema struct
  reaching Phoenix's serializer fastlane path, where `Jason.Encoder`
  derive on the schema isn't enough because the schema's storage shape
  rarely matches the wire shape — so the serializer crashed at the WS
  edge during fan-out. CLAUDE.md's "PubSub broadcast + Channel push
  payloads MUST be JSON-encodable — convert structs to wire shape via
  a context-owned `*.Wire` module" invariant is enforced HERE: any
  caller passing a struct gets a `FunctionClauseError` at the boundary
  so the wrong shape is caught at the broadcast site instead of an
  opaque encoder crash inside Phoenix's fan-out path.

  Pre-fix the guard was the looser `%{} = payload` shape, which
  matches every struct (every `%__MODULE__{}` is also a `%{}`). The
  CP15 B6 finding stayed reachable until B6.2 tightened it.
  """
  @spec broadcast_event(String.t(), map()) :: :ok
  def broadcast_event(topic, payload)
      when is_binary(topic) and is_map(payload) and not is_struct(payload) do
    _ = Phoenix.Channel.Server.broadcast(__MODULE__, topic, "event", payload)
    :ok
  end
end
