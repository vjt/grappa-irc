defmodule Grappa.LiveIntrospection do
  @moduledoc """
  Shared live-BEAM introspection helper for the operator surface
  (M-cluster M-4). Centralizes the `Grappa.SessionRegistry` scan +
  `Process.info/2` projection + `Grappa.Session.list_channels/2`
  call that BOTH `Grappa.Operator`'s tab-separated text formatters
  AND the `GrappaWeb.Admin.*Controller` JSON wires consume.

  One feature, one code path, every door (CLAUDE.md). Pre-M-4 the
  `Registry.select` match spec + `Process.info` projection lived
  inline in `Grappa.Operator.list_sessions_text!/0`; M-4 lifts it
  here so the JSON controllers don't fork the logic.

  ## Public surface

    * `list_sessions/0` — full registry scan; one
      `LiveIntrospection.SessionEntry` per live `Session.Server`.
    * `lookup_session/2` — single-pid variant. Used by the visitor
      admin endpoint to attach live state per visitor row without
      scanning the whole registry.

  ## joined_channels timeout shape

  `Grappa.Session.list_channels/2` is a synchronous `GenServer.call`
  into the target Session.Server. A mailbox-bloated or leaked pid
  could exhaust the default 5s receive timeout — exactly the
  pathological case operators need to see. We call it with an
  explicit 250 ms timeout per pid; on `:exit, {:timeout, _}` the
  entry's `joined_channels` is `nil` and `:joined_channels` is
  added to `introspection_degraded` so the wire surfaces "sick
  session" honestly instead of silently empty.

  ## Boundary

  Deps: `Grappa.Session` (for `list_channels/2` + `subject` type +
  `Server.registry_key/2`). `Registry` is Erlang stdlib — no
  boundary entry. Callers join to DB (Visitors, Credentials) at
  the call site; this module is pure live-state and does NOT
  resolve subjects to domain rows.
  """

  use Boundary, top_level?: true, deps: [Grappa.Session], exports: [AdminWire, SessionEntry]

  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Session
  alias Grappa.Session.Server

  @list_channels_timeout_ms 250

  @doc """
  Enumerate every live `Session.Server` registered in
  `Grappa.SessionRegistry`. One `SessionEntry` per process.
  """
  @spec list_sessions() :: [SessionEntry.t()]
  def list_sessions do
    # Match spec pins the literal `:session` registry-key tag (mirror of
    # `Grappa.Session.Server.registry_key/2`): if a future registration
    # with a different key shape lands in `Grappa.SessionRegistry`, this
    # verb silently skips it rather than crashing mid-output on a
    # destructure mismatch.
    Grappa.SessionRegistry
    |> Registry.select([
      {{{:session, :"$1", :"$2"}, :"$3", :_}, [], [{{:"$1", :"$2", :"$3"}}]}
    ])
    |> Enum.map(fn {subject, network_id, pid} ->
      build_entry(subject, network_id, pid)
    end)
  end

  @doc """
  Look up the `SessionEntry` for a single `(subject, network_id)` pair.
  Returns `nil` when no pid is registered — the U-0 honesty signal
  surfaces this nil at the admin wire as `live_state: null`.
  """
  @spec lookup_session(Session.subject(), pos_integer()) :: SessionEntry.t() | nil
  def lookup_session(subject, network_id) when is_integer(network_id) do
    case Registry.lookup(Grappa.SessionRegistry, Server.registry_key(subject, network_id)) do
      [{pid, _}] -> build_entry(subject, network_id, pid)
      [] -> nil
    end
  end

  defp build_entry(subject, network_id, pid) do
    info = Process.info(pid, [:message_queue_len, :memory]) || []
    {channels, degraded} = fetch_joined_channels(subject, network_id)

    %SessionEntry{
      subject: subject,
      network_id: network_id,
      pid: pid,
      alive: Process.alive?(pid),
      mailbox_len: Keyword.get(info, :message_queue_len, 0),
      memory_bytes: Keyword.get(info, :memory, 0),
      joined_channels: channels,
      introspection_degraded: degraded
    }
  end

  defp fetch_joined_channels(subject, network_id) do
    case Session.list_channels(subject, network_id, @list_channels_timeout_ms) do
      {:ok, channels} -> {channels, []}
      {:error, :no_session} -> {[], []}
      {:error, :timeout} -> {nil, [:joined_channels]}
    end
  end
end
