defmodule Grappa.Session do
  @moduledoc """
  Public facade for the per-(user, network) IRC session GenServer
  (`Grappa.Session.Server`). Callers spawn sessions via `start_session/1`
  and look them up by `(user_name, network_id)` via `whereis/2`.

  Sessions are registered in `Grappa.SessionRegistry` (a `:unique` Registry
  declared in the application supervision tree) under the key
  `{:session, user_name, network_id}`. They run as `:transient` children of
  `Grappa.SessionSupervisor` (a `DynamicSupervisor`), so abnormal exits
  trigger a restart while clean shutdowns do not.

  This module is intentionally thin — no business logic. It exists to:

    1. Centralize the registry-key shape so callers don't reinvent it
       (the via-tuple lives in `Grappa.Session.Server`).
    2. Hide the `DynamicSupervisor` + `child_spec` plumbing from
       `Grappa.Bootstrap` and from any future REST/WS surface that
       wants to inspect or terminate a session.

  ## Opts shape (architecture review A6)

  `start_session/1` accepts a flat map of primitive fields rather than
  a `Grappa.Config.Network` struct. The Session module is decoupled
  from the operator-config schema so Phase 2's DB-backed network
  records can construct the same opts shape without Config knowing
  about Session or vice-versa.

  Per CLAUDE.md "Contexts at `lib/grappa/<context>.ex`. ... Public API
  on the context module; schemas internal."
  """

  alias Grappa.{Log, Session.Server}

  require Logger

  @type start_opts :: %{
          required(:user_name) => String.t(),
          required(:network_id) => String.t(),
          required(:host) => String.t(),
          required(:port) => 1..65_535,
          required(:tls) => boolean(),
          required(:nick) => String.t(),
          optional(:autojoin) => [String.t()]
        }

  @doc """
  Spawns a `Grappa.Session.Server` under `Grappa.SessionSupervisor`.

  Returns whatever `DynamicSupervisor.start_child/2` returns —
  `{:ok, pid}` on success, `{:error, {:already_started, pid}}` if a
  session for the same `(user_name, network_id)` is already registered,
  or `{:error, reason}` on init failure (e.g. upstream connection
  refused).
  """
  @spec start_session(start_opts()) :: DynamicSupervisor.on_start_child()
  def start_session(%{user_name: u, network_id: n} = opts)
      when is_binary(u) and is_binary(n) do
    DynamicSupervisor.start_child(Grappa.SessionSupervisor, {Server, opts})
  end

  @doc """
  Spawns a list of sessions sequentially, logging one line per result
  with the canonical `Grappa.Log.session_context/2` metadata. Returns
  `%{started:, failed:}` counts so the caller can render a summary.

  Use from any session-batch producer: Bootstrap reads the operator
  TOML, Phase 2 REST `add network` endpoints will wrap a single-element
  list, etc. Failures are non-fatal — every entry in the list is
  attempted.
  """
  @spec spawn_batch([start_opts()]) :: %{started: non_neg_integer(), failed: non_neg_integer()}
  def spawn_batch(list) when is_list(list) do
    Enum.reduce(list, %{started: 0, failed: 0}, fn opts, acc ->
      context = Log.session_context(opts.user_name, opts.network_id)

      case start_session(opts) do
        {:ok, _} ->
          Logger.info("session started", context)
          %{acc | started: acc.started + 1}

        {:error, reason} ->
          Logger.error("session start failed", Keyword.put(context, :error, inspect(reason)))
          %{acc | failed: acc.failed + 1}
      end
    end)
  end

  @doc """
  Returns the pid of the session for `(user_name, network_id)`, or
  `nil` if no such session is registered.
  """
  @spec whereis(String.t(), String.t()) :: pid() | nil
  def whereis(user_name, network_id) when is_binary(user_name) and is_binary(network_id) do
    case Registry.lookup(Grappa.SessionRegistry, {:session, user_name, network_id}) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end
end
