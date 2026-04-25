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

  use Boundary, top_level?: true, deps: [Grappa.Config, Grappa.Session]

  use Task, restart: :transient

  alias Grappa.{Config, Session}

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
        log_load_failure(reason, path)
        :ok
    end
  end

  defp log_load_failure({:file_not_found, _} = err, path) do
    Logger.warning("bootstrap: " <> Config.format_error(err) <> " — running web-only",
      path: path
    )
  end

  defp log_load_failure({:io_error, posix, _} = err, path) do
    Logger.error("bootstrap: " <> Config.format_error(err) <> " — running web-only",
      path: path,
      reason: posix
    )
  end

  defp log_load_failure({:invalid_toml, msg} = err, path) do
    Logger.error("bootstrap: " <> Config.format_error(err) <> " — running web-only",
      path: path,
      reason: msg
    )
  end

  defp log_load_failure({:invalid_config, msg} = err, path) do
    Logger.error("bootstrap: " <> Config.format_error(err) <> " — running web-only",
      path: path,
      reason: msg
    )
  end

  @spec spawn_all([Config.User.t()]) :: :ok
  defp spawn_all(users) do
    opts_list =
      Enum.flat_map(users, fn user ->
        Enum.map(user.networks, &session_opts(user.name, &1))
      end)

    stats = Session.spawn_batch(opts_list)

    Logger.info("bootstrap done",
      users: length(users),
      started: stats.started,
      failed: stats.failed
    )

    :ok
  end

  @spec session_opts(String.t(), Config.Network.t()) :: Grappa.Session.start_opts()
  defp session_opts(user_name, %Config.Network{} = net) do
    %{
      user_name: user_name,
      network_id: net.id,
      host: net.host,
      port: net.port,
      tls: net.tls,
      nick: net.nick,
      autojoin: net.autojoin
    }
  end
end
