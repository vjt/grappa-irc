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

  Per CLAUDE.md "Contexts at `lib/grappa/<context>.ex`. ... Public API
  on the context module; schemas internal."
  """

  alias Grappa.Session.Server

  @type start_opts :: %{
          required(:user_name) => String.t(),
          required(:network) => Grappa.Config.Network.t()
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
  def start_session(%{user_name: u, network: %Grappa.Config.Network{}} = opts)
      when is_binary(u) do
    DynamicSupervisor.start_child(Grappa.SessionSupervisor, {Server, opts})
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
