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
      `LiveIntrospection.SessionEntry` per live `Session.Server`,
      carrying the live nick alongside the process vitals (#618).
    * `lookup_session/2` — single-pid variant. Used by the visitor
      admin endpoint to attach live state per visitor row without
      scanning the whole registry.
    * `count_sessions_by_user/0` — per-user `Session.Server` count
      across networks. M-cluster M-6 `GET /admin/users` consumes the
      count for per-row `live_session_count` projection.

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
  # #550 — same honesty budget as list_channels: an instant state read on a
  # healthy session, but a mailbox-bloated pid degrades to nil rather than
  # blocking the admin scan on the default 5s exit cascade.
  @peer_address_timeout_ms 250

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

  @doc """
  Count of live `Session.Server`s registered under `{:user, user_id}`
  shape, grouped by user_id. M-cluster M-6 `GET /admin/users` uses
  the count to project per-user `live_session_count` without scanning
  the registry per user row.

  ONE registry scan + `Enum.frequencies/1`; visitor sessions are
  silently dropped (M-6's combined-shape is per-user only). Empty
  registry → `%{}`.
  """
  @spec count_sessions_by_user() :: %{Ecto.UUID.t() => non_neg_integer()}
  def count_sessions_by_user do
    Grappa.SessionRegistry
    |> Registry.select([
      {{{:session, {:user, :"$1"}, :_}, :_, :_}, [], [:"$1"]}
    ])
    |> Enum.frequencies()
  end

  defp build_entry(subject, network_id, pid) do
    info = Process.info(pid, [:message_queue_len, :memory]) || []
    {channels, channels_degraded} = fetch_joined_channels(subject, network_id)
    {peer_address, peer_port, peer_degraded} = fetch_peer_address(subject, network_id)

    %SessionEntry{
      subject: subject,
      network_id: network_id,
      pid: pid,
      nick: fetch_live_nick(subject, network_id),
      alive: Process.alive?(pid),
      mailbox_len: Keyword.get(info, :message_queue_len, 0),
      memory_bytes: Keyword.get(info, :memory, 0),
      joined_channels: channels,
      peer_address: peer_address,
      peer_port: peer_port,
      introspection_degraded: channels_degraded ++ peer_degraded
    }
  end

  # #618 — the live half of "who does this session answer to". Deliberately
  # NOT a `Session.call`: `current_nick/2` reads the SessionRegistry entry
  # value (#498), so unlike joined_channels / peer_address there is no
  # timeout budget to spend and no `introspection_degraded` marker to earn.
  # `:no_session` here is the pid deregistering between the registry scan
  # and this read — nil, never a fabricated fallback to the configured nick,
  # which is precisely the value the operator needs to compare against.
  defp fetch_live_nick(subject, network_id) do
    case Session.current_nick(subject, network_id) do
      {:ok, nick} -> nick
      {:error, :no_session} -> nil
    end
  end

  defp fetch_joined_channels(subject, network_id) do
    case Session.list_channels(subject, network_id, @list_channels_timeout_ms) do
      {:ok, channels} -> {channels, []}
      {:error, :no_session} -> {[], []}
      {:error, :timeout} -> {nil, [:joined_channels]}
    end
  end

  # #550 — mirror of fetch_joined_channels/2 for the upstream peer. Unlike
  # channels (where an empty list is a meaningful "connected, no channels"),
  # there is no meaningful "empty address": every not-connected / stuck
  # outcome (:no_peer, :no_session race, :timeout) collapses to nil + the
  # :peer_address degraded marker — an honest "unknown", never fabricated.
  defp fetch_peer_address(subject, network_id) do
    case Session.peer_address(subject, network_id, @peer_address_timeout_ms) do
      {:ok, {address, port}} ->
        {address, port, []}

      {:error, reason} when reason in [:no_peer, :no_session, :timeout] ->
        {nil, nil, [:peer_address]}
    end
  end
end
