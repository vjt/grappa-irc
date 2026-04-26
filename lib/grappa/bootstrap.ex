defmodule Grappa.Bootstrap do
  @moduledoc """
  Boot-time loader that reads `grappa.toml` and spawns one session per
  `(user, network)` entry under `Grappa.SessionSupervisor`.

  Lives in the application supervision tree as a `Task` with
  `restart: :transient` — runs once, exits `:normal` on completion (does
  not restart). If `run/1` itself crashes (i.e. an unhandled exception
  inside the spawn loop), `:transient` brings it back exactly once.

  ## Sub-task 2g — TOML names the spawn list, DB owns the configuration

  TOML still drives WHICH `(user, network)` pairs to spawn at boot.
  Everything else — host / port / TLS / nick / password / auth_method
  / autojoin — comes from the bound `Grappa.Networks.Credential` +
  `Grappa.Networks.Server` rows. The TOML's per-network credential
  fields are read-but-ignored (full TOML deletion is sub-task 2j).

  Resolution at boot:

    * TOML `name` → `Accounts.get_user_by_name/1` → user UUID. Missing
      user logs `"bootstrap: user not in DB, skipping"` and contributes
      `length(networks)` to the `skipped` counter.
    * TOML network `id` (slug) → `Networks.find_or_create_network/1` →
      integer FK. The find-or-create is race-safe (sub-task 2e).
    * `Session.start_session(user_id, network_id)` resolves the rest
      from DB (`Networks.get_credential!/2` + `Networks.get_network!/1
      |> Repo.preload(:servers)`). Missing credential / no enabled
      server raises inside `Session.Server.init/1` and bubbles out as
      `{:error, _}` which lands on the `failed` counter.

  ## Failure modes — boot web-only, never crash the app

  Bootstrap is "best-effort." A missing or malformed config file logs a
  warning and returns `:ok` — the rest of the supervision tree
  (Endpoint, Repo, PubSub, Registry, SessionSupervisor) is already up
  and the bouncer continues running with zero sessions. Per-session
  start failures (upstream connection refused, missing DB credential,
  etc.) increment the `failed` counter and continue with the next
  session; one bad network does not block the others.

  Three counters, three operationally-distinct conditions:

    * `started` — `Session.start_session/2` returned `{:ok, pid}`.
    * `failed`  — `{:error, _}`; transient infra issue OR missing DB
      bind. Operator action: investigate the network or
      `mix grappa.bind_network`.
    * `skipped` — TOML user has no DB row; operator config drift.
      Operator action: `mix grappa.create_user`.

  ## Test surface

  `run/1` is the synchronous, testable function. Production wires
  `start_link/1` (which spawns `run/1` under a `Task.start_link/3`) so
  Bootstrap participates in the supervision tree. Tests invoke `run/1`
  directly to assert effects synchronously without race-prone
  `Task.await` dances.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Config, Grappa.Networks, Grappa.Session]

  use Task, restart: :transient

  alias Grappa.{Accounts, Config, Networks, Session}
  alias Grappa.Accounts.User
  alias Grappa.Networks.Network

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
    {pairs, skipped} = resolve_pairs(users)
    stats = Enum.reduce(pairs, %{started: 0, failed: 0}, &spawn_one/2)

    Logger.info("bootstrap done",
      users: length(users),
      started: stats.started,
      failed: stats.failed,
      skipped: skipped
    )

    :ok
  end

  # Resolve every TOML user name to its DB `Accounts.User` row. Phase 2
  # made user identity DB-backed (the `users` table backs the FK on
  # `messages.user_id`); a TOML user that has no matching DB row gets
  # logged + counted toward `skipped`. The operator must
  # `mix grappa.create_user` before grappa.toml-driven Bootstrap can
  # spawn that user's sessions. Returns the list of `{User.t(),
  # network_slug}` pairs ready for the find-or-create + spawn loop.
  @spec resolve_pairs([Config.User.t()]) :: {[{User.t(), String.t()}], non_neg_integer()}
  defp resolve_pairs(users) do
    Enum.reduce(users, {[], 0}, &resolve_user/2)
  end

  @spec resolve_user(Config.User.t(), {[{User.t(), String.t()}], non_neg_integer()}) ::
          {[{User.t(), String.t()}], non_neg_integer()}
  defp resolve_user(user, {acc, skipped}) do
    case Accounts.get_user_by_name(user.name) do
      {:ok, %User{} = db_user} ->
        pairs = Enum.map(user.networks, fn net -> {db_user, net.id} end)
        {acc ++ pairs, skipped}

      {:error, :not_found} ->
        Logger.warning("bootstrap: user not in DB, skipping",
          user: user.name,
          networks: length(user.networks)
        )

        {acc, skipped + length(user.networks)}
    end
  end

  @spec spawn_one({User.t(), String.t()}, %{started: non_neg_integer(), failed: non_neg_integer()}) ::
          %{started: non_neg_integer(), failed: non_neg_integer()}
  defp spawn_one({%User{} = user, network_slug}, acc) do
    with {:ok, %Network{id: network_id}} <-
           Networks.find_or_create_network(%{slug: network_slug}),
         {:ok, _} <- Session.start_session(user.id, network_id) do
      Logger.info("session started", user: user.name, network: network_slug)
      %{acc | started: acc.started + 1}
    else
      {:error, reason} ->
        Logger.error("session start failed",
          user: user.name,
          network: network_slug,
          error: inspect(reason)
        )

        %{acc | failed: acc.failed + 1}
    end
  end
end
