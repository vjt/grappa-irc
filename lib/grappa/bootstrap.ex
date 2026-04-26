defmodule Grappa.Bootstrap do
  @moduledoc """
  Boot-time loader that enumerates every bound `(user, network)`
  credential and spawns one `Grappa.Session.Server` per row under
  `Grappa.SessionSupervisor`.

  Lives in the application supervision tree as a `Task` with
  `restart: :transient` — runs once, exits `:normal` on completion (does
  not restart). If `run/0` itself crashes (an unhandled exception
  inside the spawn loop), `:transient` brings it back exactly once.

  ## DB is the source of truth

  `Networks.list_credentials_for_all_users/0` returns every
  `Credential` with `:network` preloaded; the spawn loop calls
  `Session.start_session(credential.user_id, credential.network_id)`
  per row.

  Operator door for adding a binding: `mix grappa.create_user` then
  `mix grappa.bind_network --auth ...`. Bootstrap re-reads the DB
  every boot, so the next deploy picks up new bindings without any
  config edit.

  ## Failure modes — boot web-only, never crash the app

  Bootstrap is "best-effort." A fresh deploy with no credentials yet
  bound logs a warning and returns `:ok` — the rest of the supervision
  tree (Endpoint, Repo, PubSub, Registry, SessionSupervisor) is up and
  the bouncer continues running with zero sessions, ready for the
  operator to bind the first credential and reboot. Per-session start
  failures (upstream connection refused, no enabled server, SASL auth
  failure, etc.) increment the `failed` counter and continue with the
  next session; one bad network does not block the others.

  Two counters, two operationally-distinct conditions:

    * `started` — `Session.start_session/2` returned `{:ok, pid}`.
    * `failed`  — `{:error, _}`; transient infra issue or auth failure.
      Operator action: investigate the upstream or
      `mix grappa.update_network_credential`.

  ## Test surface

  `run/0` is the synchronous, testable function. Production wires
  `start_link/0` (which spawns `run/0` under a `Task.start_link/3`) so
  Bootstrap participates in the supervision tree. Tests invoke `run/0`
  directly to assert effects synchronously without race-prone
  `Task.await` dances.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Networks, Grappa.Session]

  use Task, restart: :transient

  alias Grappa.{Networks, Session}
  alias Grappa.Networks.{Credential, Network}

  require Logger

  @doc """
  Production entry point — wraps `run/0` in `Task.start_link/3` so
  Bootstrap can sit in the application supervision tree. The arg is
  whatever the supervisor child spec passes through (`use Task`'s
  generated `child_spec/1` forwards it); Bootstrap reads its work
  from the DB so the arg is always ignored.
  """
  @spec start_link(term()) :: {:ok, pid()}
  def start_link(_), do: Task.start_link(__MODULE__, :run, [])

  @doc """
  Enumerates every bound credential and spawns one session per row.
  Returns `:ok` whether all sessions start, some fail, or there are no
  bindings at all (best-effort — a fresh deploy without operator-bound
  credentials does not block the rest of the supervision tree).
  """
  @spec run() :: :ok
  def run do
    case Networks.list_credentials_for_all_users() do
      [] ->
        Logger.warning("bootstrap: no credentials bound — running web-only")
        :ok

      credentials ->
        spawn_all(credentials)
        :ok
    end
  end

  @spec spawn_all([Credential.t()]) :: :ok
  defp spawn_all(credentials) do
    stats = Enum.reduce(credentials, %{started: 0, failed: 0}, &spawn_one/2)

    Logger.info("bootstrap done",
      credentials: length(credentials),
      started: stats.started,
      failed: stats.failed
    )

    :ok
  end

  @spec spawn_one(Credential.t(), %{started: non_neg_integer(), failed: non_neg_integer()}) ::
          %{started: non_neg_integer(), failed: non_neg_integer()}
  defp spawn_one(%Credential{user_id: user_id, network_id: network_id, network: %Network{slug: slug}}, acc) do
    case Session.start_session(user_id, network_id) do
      {:ok, _} ->
        Logger.info("session started", user: user_id, network: slug)
        %{acc | started: acc.started + 1}

      {:error, reason} ->
        Logger.error("session start failed",
          user: user_id,
          network: slug,
          error: inspect(reason)
        )

        %{acc | failed: acc.failed + 1}
    end
  end
end
