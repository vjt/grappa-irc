defmodule Grappa.Bootstrap do
  @moduledoc """
  Boot-time loader that reads `grappa.toml` and spawns one session per
  `(user, network)` entry under `Grappa.SessionSupervisor`.

  Lives in the application supervision tree as a `Task` with
  `restart: :transient` — runs once, exits `:normal` on completion (does
  not restart). If `run/1` itself crashes (i.e. an unhandled exception
  inside the spawn loop), `:transient` brings it back exactly once.

  ## Failure modes — boot web-only, never crash the app

  Bootstrap is "best-effort." A missing or malformed config file logs a
  warning and returns `:ok` — the rest of the supervision tree
  (Endpoint, Repo, PubSub, Registry, SessionSupervisor) is already up
  and the bouncer continues running with zero sessions. Per-session
  start failures (upstream connection refused, etc.) increment the
  `failed` counter and continue with the next session; one bad network
  does not block the others.

  ## Test surface

  `run/1` is the synchronous, testable function. Production wires
  `start_link/1` (which spawns `run/1` under a `Task.start_link/3`) so
  Bootstrap participates in the supervision tree. Tests invoke `run/1`
  directly to assert effects synchronously without race-prone
  `Task.await` dances.
  """
  use Task, restart: :transient

  alias Grappa.{Config, Log, Session}

  require Logger

  @type opts :: [config_path: Path.t()]

  @doc """
  Production entry point — wraps `run/1` in `Task.start_link/3` so
  Bootstrap can sit in the application supervision tree.
  """
  @spec start_link(opts()) :: {:ok, pid()}
  def start_link(opts), do: Task.start_link(__MODULE__, :run, [opts])

  @doc """
  Reads the TOML config at `opts[:config_path]` and spawns one session
  per `(user, network)` entry. Returns `:ok` whether all sessions
  start, some fail, or the config is missing/malformed (best-effort —
  a broken config does not block the rest of the supervision tree).
  """
  @spec run(opts()) :: :ok
  def run(opts) do
    path = Keyword.fetch!(opts, :config_path)

    case Config.load(path) do
      {:ok, %Config{users: users}} ->
        spawn_all(users)
        :ok

      {:error, reason} ->
        Logger.warning("bootstrap: no config — running web-only",
          path: path,
          reason: reason
        )

        :ok
    end
  end

  @spec spawn_all([Config.User.t()]) :: :ok
  defp spawn_all(users) do
    counts =
      Enum.reduce(users, %{started: 0, failed: 0}, fn user, acc ->
        Enum.reduce(user.networks, acc, &spawn_one(&1, user.name, &2))
      end)

    Logger.info("bootstrap done",
      users: length(users),
      started: counts.started,
      failed: counts.failed
    )

    :ok
  end

  @spec spawn_one(Config.Network.t(), String.t(), %{started: non_neg_integer(), failed: non_neg_integer()}) ::
          %{started: non_neg_integer(), failed: non_neg_integer()}
  defp spawn_one(network, user_name, acc) do
    context = Log.session_context(user_name, network.id)

    case Session.start_session(%{user_name: user_name, network: network}) do
      {:ok, _} ->
        Logger.info("bootstrap session started", context)
        %{acc | started: acc.started + 1}

      {:error, reason} ->
        Logger.error("bootstrap session failed", Keyword.put(context, :error, inspect(reason)))
        %{acc | failed: acc.failed + 1}
    end
  end
end
