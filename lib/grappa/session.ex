defmodule Grappa.Session do
  @moduledoc """
  Public facade for the per-(user, network) IRC session GenServer
  (`Grappa.Session.Server`). Callers spawn sessions via
  `start_session/3` and look them up by `(user_id, network_id)` via
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

  ## Cluster 2 — A2 cycle inversion

  `start_session/3` takes `(user_id, network_id, opts)` where `opts`
  is the fully-resolved primitive plan — no `Credential` / `Network`
  / `Server` struct refs cross the Session boundary. `Networks.session_plan/1`
  is the canonical producer of that plan; `Bootstrap` threads the
  resolved opts in. The Server's `init/1` is therefore a pure data
  consumer (no `Repo`, no `Networks`, no `Accounts` reads), which
  shrinks the Session boundary deps from 7 → 4 (`Grappa.IRC`,
  `Grappa.Log`, `Grappa.PubSub`, `Grappa.Scrollback`) and makes the
  reverse `Networks → Session` edge legal — `Networks.unbind_credential/2`
  now calls `Session.stop_session/2` directly instead of the inlined
  registry-tuple workaround.

  Trade-off: on a `:transient` restart the Server replays the same
  cached opts (the supervisor child spec captures them at first
  start). A live credential change in the DB propagates to the
  running Server ONLY when `Networks.unbind_credential/2` runs
  INSIDE the prod BEAM (e.g. via `bin/grappa rpc
  'Grappa.Networks.unbind_credential(...)'` or any future operator
  REST surface) — that path goes through `Session.stop_session/2`
  and the next bind triggers a fresh `start_session/3`. Bare
  `mix grappa.unbind_network` runs in a SEPARATE short-lived BEAM
  with its own (empty) session registry, so the `stop_session/2`
  call there is a no-op and the prod BEAM's running Session
  outlives the deleted credential row until the next deploy
  reboots Bootstrap. The operator path that actually re-spawns
  must hit the live BEAM. Phase 5 hot-reload of credentials gets a
  dedicated `Session.refresh/2` if the deploy-cycle gap becomes
  painful.
  """

  # `Server` is exported for the test path only — `server_test.exs`
  # tweaks per-module log level via `Logger.put_module_level/2`.
  # Runtime callers go through this facade (`start_session/3`,
  # `send_*`, `whereis/2`).
  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Log, Grappa.PubSub, Grappa.Scrollback],
    exports: [Server]

  alias Grappa.IRC.{Client, Identifier}
  alias Grappa.Session.Server

  require Logger

  @typedoc """
  Pre-resolved primitive opts consumed by `start_session/3` and
  `Grappa.Session.Server`'s `init/1` callback. Produced canonically by
  `Grappa.Networks.session_plan/1`; the field set is the single
  source of truth for what the Session boundary needs to start an
  upstream IRC connection — adding a field requires extending this
  type AND `session_plan/1`'s `build_plan/4` AND the Server state
  struct in lockstep.
  """
  @type start_opts :: %{
          required(:user_name) => String.t(),
          required(:network_slug) => String.t(),
          required(:nick) => String.t(),
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => Client.auth_method(),
          required(:password) => String.t() | nil,
          required(:autojoin_channels) => [String.t()],
          required(:host) => String.t(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean()
        }

  @doc """
  Spawns a `Grappa.Session.Server` under `Grappa.SessionSupervisor`
  for `(user_id, network_id)` with the pre-resolved `opts` plan.

  Returns whatever `DynamicSupervisor.start_child/2` returns —
  `{:ok, pid}` on success, `{:error, {:already_started, pid}}` if a
  session for the same key is already registered, or `{:error,
  reason}` on init failure (upstream connection refused, etc.).
  """
  @spec start_session(Ecto.UUID.t(), integer(), start_opts()) ::
          DynamicSupervisor.on_start_child()
  def start_session(user_id, network_id, opts)
      when is_binary(user_id) and is_integer(network_id) and is_map(opts) do
    full_opts = Map.merge(opts, %{user_id: user_id, network_id: network_id})

    DynamicSupervisor.start_child(
      Grappa.SessionSupervisor,
      {Server, full_opts}
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
