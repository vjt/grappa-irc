defmodule Grappa.Bootstrap do
  @moduledoc """
  Boot-time loader that enumerates every bound `(user, network)`
  credential and spawns one `Grappa.Session.Server` per row under
  `Grappa.SessionSupervisor`.

  Lives in the application supervision tree as a `Task` with
  `restart: :transient` — runs once, exits `:normal` on completion (does
  not restart). If `run/0` itself crashes (an unhandled exception
  inside the spawn loop), `:transient` restarts it subject to the
  supervisor's restart budget (default `max_restarts: 3` over 5s);
  exhausting the budget terminates the application.

  ## DB is the source of truth

  `Credentials.list_credentials_for_all_users/0` returns every
  `Credential` with `:network` preloaded; the spawn loop calls
  `SessionPlan.resolve/1` per row to flatten the credential +
  picked server into the primitive `Session.start_opts/0` map and
  hands the result to `Session.start_session/3`. Pre-Cluster-2 the
  Session itself reached back into Networks/Accounts/Repo from
  `init/1`; the inversion (A2) makes Bootstrap the sole producer of
  the resolved opts.

  Operator door for adding a binding: `mix grappa.create_user` then
  `mix grappa.bind_network --auth ...`. Bootstrap re-reads the DB
  every boot, so the next deploy picks up new bindings without any
  config edit.

  ## Failure modes — boot web-only, never crash the app

  Bootstrap is "best-effort." A fresh deploy with no credentials yet
  bound logs a warning and returns `:ok` — the rest of the supervision
  tree (Endpoint, Repo, PubSub, Registry, SessionSupervisor) is up and
  the bouncer continues running with zero sessions, ready for the
  operator to bind the first credential and reboot. Per-session
  Bootstrap-time failures (no enabled server, missing user) increment
  the `failed` counter and continue with the next session; one bad row
  does not block the others.

  Two counters, two operationally-distinct conditions:

    * `started` — `Session.start_session/3` returned `{:ok, pid}` OR
      `{:error, {:already_started, pid}}` (idempotent success — the
      session is up under the same Registry key, which is what
      Bootstrap restarts find on every previously-spawned row).
    * `failed`  — `{:error, _}` from `SessionPlan.resolve/1`
      (`:no_server`, `:user_not_found`) OR a hard Session-init failure
      (`{:missing_password, _}` from `IRC.Client.init/1`'s validation
      path, propagating up via the linked Client crash inside
      `Session.handle_continue/2`'s `Client.start_link/1`).

  Note — post-C2 (CP10 S3) `init/1` no longer blocks on TCP/TLS
  connect: `Session.Server.init/1` and `IRC.Client.init/1` defer the
  socket setup into `handle_continue(:connect, _)` so Bootstrap's
  `Enum.reduce` loop is not serialized by upstream latency. Connection
  refused / DNS hang / TCP RST are now surfaced **async** via the
  per-Session `:transient` restart policy (`max_restarts: 3` over 5s)
  followed by `DynamicSupervisor` terminating the child. Bootstrap
  itself reports `started=N failed=0` for any row whose Session passed
  its `init/1` validation regardless of upstream health; operators
  grep `(stop) {:connect_failed, _}` from the `Session.Server` /
  `IRC.Client` terminate path to surface the bad network. Phase 5
  reconnect/backoff replaces the exhaust-and-give-up shape with proper
  health tracking.

  ## Test surface

  `run/0` is the synchronous, testable function. Production wires
  `start_link/1` (which spawns `run/0` under a `Task.start_link/3`) so
  Bootstrap participates in the supervision tree. The arg is whatever
  the supervisor child spec passes through (always `[]` from the
  bare-module `[Grappa.Bootstrap]` child entry); Bootstrap reads its
  work from the DB so the arg is unused. Tests invoke `run/0` directly
  to assert effects synchronously without race-prone `Task.await`
  dances.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Networks, Grappa.Session, Grappa.Visitors]

  use Task, restart: :transient

  alias Grappa.{Networks, Session, Visitors}
  alias Grappa.Networks.{Credential, Credentials, Network, SessionPlan}
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan
  alias Grappa.Visitors.Visitor

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
    case Credentials.list_credentials_for_all_users() do
      [] ->
        Logger.warning("bootstrap: no credentials bound — running web-only")

      credentials ->
        spawn_all(credentials)
    end

    spawn_visitors()
    :ok
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
  defp spawn_one(
         %Credential{user_id: user_id, network_id: network_id, network: %Network{slug: slug}} =
           credential,
         acc
       ) do
    with {:ok, plan} <- SessionPlan.resolve(credential),
         {:ok, _} <- Session.start_session({:user, user_id}, network_id, plan) do
      Logger.info("session started", user: user_id, network: slug)
      %{acc | started: acc.started + 1}
    else
      {:error, {:already_started, _}} ->
        # Bootstrap is `restart: :transient` — on the (single) restart
        # every previously-spawned session is still alive under the
        # same `{:via, Registry, ...}` key and `start_session/3`
        # returns `{:error, {:already_started, pid}}`. That is the
        # idempotent success case, NOT a start failure: the session
        # is up; nothing for the operator to investigate. Counting it
        # under `failed` (the previous behaviour) misdirected operator
        # action on every Bootstrap restart. Logged at `:debug` so
        # the success path stays quiet but a noisy boot is still
        # diagnosable.
        Logger.debug("session already started", user: user_id, network: slug)
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

  @spec spawn_visitors() :: :ok
  defp spawn_visitors do
    visitors = Visitors.list_active()
    stats = Enum.reduce(visitors, %{started: 0, failed: 0}, &spawn_visitor/2)

    Logger.info("bootstrap visitors done",
      visitors: length(visitors),
      started: stats.started,
      failed: stats.failed
    )

    :ok
  end

  @spec spawn_visitor(Visitor.t(), %{started: non_neg_integer(), failed: non_neg_integer()}) ::
          %{started: non_neg_integer(), failed: non_neg_integer()}
  defp spawn_visitor(%Visitor{} = visitor, acc) do
    with {:ok, plan} <- VisitorSessionPlan.resolve(visitor),
         {:ok, %Network{} = network} <- Networks.get_network_by_slug(plan.network_slug),
         {:ok, _} <- Session.start_session({:visitor, visitor.id}, network.id, plan) do
      Logger.info("visitor session started",
        visitor_id: visitor.id,
        network: plan.network_slug
      )

      %{acc | started: acc.started + 1}
    else
      {:error, {:already_started, _}} ->
        # Mirror `spawn_one/2`'s F3 idempotency: on Bootstrap restart
        # the session is still alive under the same Registry key.
        Logger.debug("visitor session already started",
          visitor_id: visitor.id,
          network: visitor.network_slug
        )

        %{acc | started: acc.started + 1}

      {:error, reason} ->
        Logger.error("visitor session start failed",
          visitor_id: visitor.id,
          network: visitor.network_slug,
          error: inspect(reason)
        )

        %{acc | failed: acc.failed + 1}
    end
  end
end
