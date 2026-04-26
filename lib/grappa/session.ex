defmodule Grappa.Session do
  @moduledoc """
  Public facade for the per-(user, network) IRC session GenServer
  (`Grappa.Session.Server`). Callers spawn sessions via
  `start_session/2` and look them up by `(user_id, network_id)` via
  `whereis/2`.

  Sessions are registered in `Grappa.SessionRegistry` (a `:unique`
  Registry declared in the application supervision tree) under the key
  `{:session, user_id, network_id}` — both halves of the key are
  internal identifiers (`Ecto.UUID.t` + `integer`) that every authn'd
  request handler already has on `conn.assigns`. They run as
  `:transient` children of `Grappa.SessionSupervisor` (a
  `DynamicSupervisor`), so abnormal exits trigger a restart while clean
  shutdowns do not.

  This module is intentionally thin — no business logic. It exists to:

    1. Centralize the registry-key shape so callers don't reinvent it
       (the via-tuple lives in `Grappa.Session.Server`).
    2. Hide the `DynamicSupervisor` + `child_spec` plumbing from
       `Grappa.Bootstrap` and from any future REST/WS surface that
       wants to inspect or terminate a session.

  ## Sub-task 2g — DB-backed configuration

  `start_session/2` now takes `(user_id, network_id)` and the
  Server's `init/1` resolves the host / port / TLS / nick / password
  / auth_method / autojoin from the bound `Grappa.Networks.Credential`
  + `Grappa.Networks.Server` rows. The flat opts map (Phase 1 +
  pre-2g) is gone — the DB is the single source of truth so the same
  spawn shape works from Bootstrap, the operator REST surface, and
  future re-bind paths without each one re-deriving a Config-shape
  bridge.
  """

  # `Server` is exported for the test path only — `server_test.exs`
  # tweaks per-module log level via `Logger.put_module_level/2`.
  # Runtime callers go through this facade (`start_session/2`,
  # `send_*`, `whereis/2`).
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.IRC,
      Grappa.Log,
      Grappa.Networks,
      Grappa.PubSub,
      Grappa.Repo,
      Grappa.Scrollback
    ],
    exports: [Server]

  alias Grappa.IRC.Identifier
  alias Grappa.Session.Server

  require Logger

  @doc """
  Spawns a `Grappa.Session.Server` under `Grappa.SessionSupervisor`
  for `(user_id, network_id)`.

  Returns whatever `DynamicSupervisor.start_child/2` returns —
  `{:ok, pid}` on success, `{:error, {:already_started, pid}}` if a
  session for the same key is already registered, or `{:error,
  reason}` on init failure (missing credential row, no enabled server,
  upstream connection refused, etc.).
  """
  @spec start_session(Ecto.UUID.t(), integer()) :: DynamicSupervisor.on_start_child()
  def start_session(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    DynamicSupervisor.start_child(
      Grappa.SessionSupervisor,
      {Server, %{user_id: user_id, network_id: network_id}}
    )
  end

  @doc """
  Returns the pid of the session for `(user_id, network_id)`, or
  `nil` if no such session is registered.
  """
  @spec whereis(Ecto.UUID.t(), integer()) :: pid() | nil
  def whereis(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    case Registry.lookup(Grappa.SessionRegistry, Server.registry_key(user_id, network_id)) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  @doc """
  Stops the running `Grappa.Session.Server` for `(user_id, network_id)`,
  if any. Idempotent: returns `:ok` whether or not a session was
  registered for the key.

  Used by `Grappa.Networks.unbind_credential/2` to tear down the
  GenServer BEFORE the credential row is deleted (S29 H5). Without
  this, a unbind would leave the GenServer running with cached
  `state.network_id` pointing at a deleted FK; the next outbound
  PRIVMSG crashes the server, the `:transient` policy restarts it,
  init fails to load the credential row, and the cycle repeats every
  retry until something else clears the registry.
  """
  @spec stop_session(Ecto.UUID.t(), integer()) :: :ok
  def stop_session(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    case whereis(user_id, network_id) do
      nil ->
        :ok

      pid ->
        # `terminate_child` returns `{:error, :not_found}` on a race
        # where the child died between whereis and terminate; treat
        # both branches as success since the post-condition (no
        # session for the key) is what we promise.
        _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
        :ok
    end
  end

  @doc """
  Sends a PRIVMSG upstream through the session for `(user_id,
  network_id)`. Persists a `Grappa.Scrollback.Message` row with
  `sender = session.nick`, broadcasts on the per-channel PubSub topic,
  AND writes to the upstream socket — atomic from the caller's view.

  Returns `{:ok, message}` with the persisted row on success,
  `{:error, :no_session}` if no session is registered, or
  `{:error, Ecto.Changeset.t()}` on validation failure.
  """
  @spec send_privmsg(Ecto.UUID.t(), integer(), String.t(), String.t()) ::
          {:ok, Grappa.Scrollback.Message.t()}
          | {:error, :no_session | :invalid_line}
          | {:error, Ecto.Changeset.t()}
  def send_privmsg(user_id, network_id, target, body)
      when is_binary(user_id) and is_integer(network_id) and is_binary(target) and
             is_binary(body) do
    # CRLF/NUL check fires BEFORE the registry lookup so an injection
    # attempt against a non-existent session still surfaces as
    # :invalid_line — input-shape error beats not-found. The Scrollback
    # row is never persisted on rejection (the call_session never runs).
    if Identifier.safe_line_token?(target) and Identifier.safe_line_token?(body) do
      call_session(user_id, network_id, {:send_privmsg, target, body})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Queues a JOIN upstream through the session. Cast — returns `:ok` as
  soon as the message is in the Session.Server mailbox; the actual
  socket write happens asynchronously. The REST surface returns 202
  Accepted to mirror this. `{:error, :no_session}` if not registered.
  """
  @spec send_join(Ecto.UUID.t(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line}
  def send_join(user_id, network_id, channel)
      when is_binary(user_id) and is_integer(network_id) and is_binary(channel) do
    if Identifier.safe_line_token?(channel) do
      cast_session(user_id, network_id, {:send_join, channel})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Queues a PART upstream through the session. Cast (see `send_join/3`
  for the rationale). `{:error, :no_session}` if not registered.
  """
  @spec send_part(Ecto.UUID.t(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line}
  def send_part(user_id, network_id, channel)
      when is_binary(user_id) and is_integer(network_id) and is_binary(channel) do
    if Identifier.safe_line_token?(channel) do
      cast_session(user_id, network_id, {:send_part, channel})
    else
      {:error, :invalid_line}
    end
  end

  defp call_session(user_id, network_id, request) do
    case whereis(user_id, network_id) do
      nil -> {:error, :no_session}
      pid -> GenServer.call(pid, request)
    end
  end

  defp cast_session(user_id, network_id, request) do
    case whereis(user_id, network_id) do
      nil -> {:error, :no_session}
      pid -> GenServer.cast(pid, request)
    end
  end
end
