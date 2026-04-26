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

  use Boundary, top_level?: true, deps: [Grappa.Accounts, Grappa.Config, Grappa.Session]

  use Task, restart: :transient

  alias Grappa.{Accounts, Config, Session}
  alias Grappa.Accounts.User

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
    {opts_list, missing} = build_opts_list(users)

    stats = Session.spawn_batch(opts_list)

    Logger.info("bootstrap done",
      users: length(users),
      started: stats.started,
      failed: stats.failed + missing
    )

    :ok
  end

  # Resolve every TOML user name to its DB `Accounts.User` row. Phase 2
  # made user identity DB-backed (the `users` table backs the FK on
  # `messages.user_id`); a TOML user that has no matching DB row gets
  # logged + skipped, counted as a `failed` start. The operator must
  # `mix grappa.create_user` before grappa.toml-driven Bootstrap can
  # spawn that user's sessions.
  defp build_opts_list(users) do
    Enum.reduce(users, {[], 0}, fn user, {acc, missing} ->
      case Accounts.get_user_by_name(user.name) do
        {:ok, %User{} = db_user} ->
          opts = Enum.map(user.networks, &session_opts(db_user, &1))
          {acc ++ opts, missing}

        {:error, :not_found} ->
          Logger.warning("bootstrap: user not in DB, skipping",
            user: user.name,
            networks: length(user.networks)
          )

          {acc, missing + length(user.networks)}
      end
    end)
  end

  @spec session_opts(User.t(), Config.Network.t()) :: Grappa.Session.start_opts()
  defp session_opts(%User{id: user_id, name: user_name}, %Config.Network{} = net) do
    %{
      user_id: user_id,
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
