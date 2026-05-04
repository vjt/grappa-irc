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
  bound logs a warning and returns `{:ok, %Result{}}` (zero counters)
  — the rest of the supervision tree (Endpoint, Repo, PubSub, Registry,
  SessionSupervisor) is up and the bouncer continues running with zero
  sessions, ready for the operator to bind the first credential and
  reboot. Per-session Bootstrap-time errors (no enabled server, missing
  user) increment the `failed` counter and continue with the next
  session; one bad row does not block the others.

  ## Hard-fail config invariants — refuse to boot on misconfig

  Two pre-spawn invariants are enforced by `raise RuntimeError` so a
  bad operator config halts the supervisor instead of silently
  degrading:

    * **W7** — every active visitor's `network_slug` must resolve to a
      `Networks.Network` row. A visitor pinned to a slug the operator
      has dropped is an orphan; `Visitors.Login` + `Visitors.SessionPlan`
      both trust the slug → network resolution at runtime.
    * **Servers-bound invariant** — every distinct network referenced
      by a `Networks.Credential` (mode-1 admin) OR an active `Visitor`
      (visitor mode) must have at least one enabled server in
      `network_servers`. Without it, `SessionPlan.resolve/1` returns
      `{:error, :no_server}` per row at spawn time AND every subsequent
      `POST /auth/login` / cicchetto reconnect for that network surfaces
      as an opaque 500 (the controller's catch-all maps unknown reasons
      to `:internal`). The bouncer is unusable for that network in
      either direction; the only honest signal is to refuse to boot
      and tell the operator how to recover (`mix grappa.add_server`).

  Both invariants run BEFORE the spawn loops so a misconfig surfaces
  on the very first boot attempt, not after the supervisor has been up
  long enough for the first user to hit login. This is the SAME bias as
  CLAUDE.md "errors are loud, not silent" + the W7 visitor-orphan
  decision: "better to refuse to boot loudly than to drop scrollback
  on a misconfiguration."

  Per-row best-effort failure modes (below) handle conditions that are
  legitimately transient or per-row (cap exceeded, upstream connect
  refused) and cannot be ruled out at boot.

  Three counters, three operationally-distinct conditions
  (post-M-life-4):

    * `spawned` — `Session.start_session/3` returned `{:ok, pid}`.
      Bootstrap actually brought up a fresh session for this row.
    * `skipped` — Bootstrap did nothing because nothing was needed
      OR nothing was permitted:
        - `{:error, {:already_started, pid}}` — the session is already
          alive under the same `{:via, Registry, ...}` key. Idempotent
          no-op on Bootstrap restart (`:transient` policy: every
          previously-spawned row is still up under the same key).
        - `{:error, :network_cap_exceeded}` — `Admission.check_capacity/1`
          tripped the per-network total cap. Operator policy decision,
          not a fault. (T31 Plan 2 Task 4.)
    * `failed` — real errors: `{:error, _}` from `SessionPlan.resolve/1`
      (`:no_server`, `:user_not_found`) OR a hard Session-init failure
      (`{:missing_password, _}` from `IRC.Client.init/1`'s validation
      path, propagating up via the linked Client crash inside
      `Session.handle_continue/2`'s `Client.start_link/1`).

  Operator dashboard semantics fall out cleanly: `spawned > 0` ⇒
  fresh start brought up new sessions; `skipped > 0` on a fresh boot
  ⇒ cap policy is tripping (size it correctly or accept the policy);
  `skipped > 0` on a Bootstrap restart ⇒ everything is already alive
  (idempotent no-op — the expected case); `failed > 0` ⇒ investigate.

  ## Backoff reset on bootstrap (M-life-5)

  Before calling `Session.start_session/3` on a row admission accepts,
  Bootstrap calls `Grappa.Session.Backoff.reset/2` for `(subject,
  network_id)`. Bootstrap is operator action (deploy / restart); any
  prior `Backoff` state is stale, the operator is overriding any
  failure history. Mirrors `Visitors.Login.preempt_and_respawn`'s
  reset call — same operator-intent semantic.

  ## Async surface for upstream-connect failures

  Post-C2 (CP10 S3) `init/1` no longer blocks on TCP/TLS connect:
  `Session.Server.init/1` and `IRC.Client.init/1` defer the socket
  setup into `handle_continue(:connect, _)` so Bootstrap's spawn loop
  is not serialized by upstream latency. Connection refused / DNS
  hang / TCP RST are surfaced **async** via the per-Session
  `:transient` restart policy (`max_restarts: 3` over 5s) followed by
  `DynamicSupervisor` terminating the child. Bootstrap itself reports
  `spawned=N failed=0` for any row whose Session passed its `init/1`
  validation regardless of upstream health; operators grep
  `(stop) {:connect_failed, _}` from the `Session.Server` /
  `IRC.Client` terminate path to surface the bad network. Phase 5
  reconnect/backoff replaces the exhaust-and-give-up shape with proper
  health tracking.

  ## Test surface

  `run/0` is the synchronous, testable function. It returns
  `{:ok, %Result{}}` with the summed user + visitor counters.
  Production wires `start_link/1` (which spawns `run/0` under a
  `Task.start_link/3`) so Bootstrap participates in the supervision
  tree. The arg is whatever the supervisor child spec passes through
  (always `[]` from the bare-module `[Grappa.Bootstrap]` child entry);
  Bootstrap reads its work from the DB so the arg is unused. Tests
  invoke `run/0` directly to assert effects synchronously without
  race-prone `Task.await` dances.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Admission, Grappa.Networks, Grappa.Session, Grappa.Visitors]

  use Task, restart: :transient

  alias Grappa.{Networks, Session, Visitors}
  alias Grappa.Networks.{Credential, Credentials, Network, Servers, SessionPlan}
  alias Grappa.Session.Backoff
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan
  alias Grappa.Visitors.Visitor

  require Logger

  defmodule Result do
    @moduledoc """
    Tri-counter accumulator + return value for `Grappa.Bootstrap.run/0`.

    See parent moduledoc's "Failure modes" section for the semantic
    distinction between `spawned`, `skipped`, and `failed`.
    """

    defstruct spawned: 0, failed: 0, skipped: 0

    @type t :: %__MODULE__{
            spawned: non_neg_integer(),
            failed: non_neg_integer(),
            skipped: non_neg_integer()
          }
  end

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
  Enumerates every bound credential + active visitor and spawns one
  session per row. Returns `{:ok, %Result{}}` with the summed counters
  whether all sessions start, some fail, some are skipped, or there
  are no bindings at all (best-effort — a fresh deploy without
  operator-bound credentials does not block the rest of the
  supervision tree).
  """
  @spec run() :: {:ok, Result.t()}
  def run do
    credentials = Credentials.list_credentials_for_all_users()
    visitors = Visitors.list_active()

    # Hard-fail config invariants run BEFORE any spawn so a bad operator
    # config halts the supervisor instead of degrading silently. See
    # moduledoc "Hard-fail config invariants" — both raises are
    # operator-facing and tell them how to recover.
    validate_visitor_networks!(visitors)
    validate_credential_servers!(credentials, visitors)

    user_stats =
      case credentials do
        [] ->
          Logger.warning("bootstrap: no credentials bound — running web-only")
          %Result{}

        credentials ->
          spawn_all(credentials)
      end

    visitor_stats = spawn_visitors(visitors)

    {:ok, sum_results(user_stats, visitor_stats)}
  end

  @spec sum_results(Result.t(), Result.t()) :: Result.t()
  defp sum_results(%Result{} = a, %Result{} = b) do
    %Result{
      spawned: a.spawned + b.spawned,
      failed: a.failed + b.failed,
      skipped: a.skipped + b.skipped
    }
  end

  @spec spawn_all([Credential.t()]) :: Result.t()
  defp spawn_all(credentials) do
    stats = Enum.reduce(credentials, %Result{}, &spawn_one/2)

    Logger.info("bootstrap done",
      credentials: length(credentials),
      spawned: stats.spawned,
      failed: stats.failed,
      skipped: stats.skipped
    )

    stats
  end

  @spec spawn_one(Credential.t(), Result.t()) :: Result.t()
  defp spawn_one(
         %Credential{user_id: user_id, network_id: network_id, network: %Network{slug: slug}} =
           credential,
         acc
       ) do
    log_keys = [user: user_id, network: slug]

    case SessionPlan.resolve(credential) do
      {:ok, plan} ->
        capacity_input = %{
          network_id: network_id,
          client_id: nil,
          flow: :bootstrap_user
        }

        spawn_with_admission({:user, user_id}, network_id, plan, capacity_input, log_keys, acc)

      {:error, reason} ->
        Logger.error("session start failed", [error: inspect(reason)] ++ log_keys)
        %{acc | failed: acc.failed + 1}
    end
  end

  @spec spawn_visitors([Visitor.t()]) :: Result.t()
  defp spawn_visitors(visitors) do
    stats = Enum.reduce(visitors, %Result{}, &spawn_visitor/2)

    Logger.info("bootstrap visitors done",
      visitors: length(visitors),
      spawned: stats.spawned,
      failed: stats.failed,
      skipped: stats.skipped
    )

    stats
  end

  @spec spawn_visitor(Visitor.t(), Result.t()) :: Result.t()
  defp spawn_visitor(%Visitor{id: visitor_id, network_slug: slug} = visitor, acc) do
    case VisitorSessionPlan.resolve(visitor) do
      {:ok, plan} ->
        case Networks.get_network_by_slug(plan.network_slug) do
          {:ok, %Network{id: network_id}} ->
            capacity_input = %{
              network_id: network_id,
              client_id: nil,
              flow: :bootstrap_visitor
            }

            log_keys = [visitor_id: visitor_id, network: slug]

            spawn_with_admission(
              {:visitor, visitor_id},
              network_id,
              plan,
              capacity_input,
              log_keys,
              acc
            )

          {:error, reason} ->
            Logger.error(
              "visitor session start failed",
              visitor_id: visitor_id,
              network: slug,
              error: inspect(reason)
            )

            %{acc | failed: acc.failed + 1}
        end

      {:error, reason} ->
        Logger.error(
          "visitor session start failed",
          visitor_id: visitor_id,
          network: slug,
          error: inspect(reason)
        )

        %{acc | failed: acc.failed + 1}
    end
  end

  # Shared spawn helper — admission check, Backoff.reset on green
  # light (M-life-5: operator action overrides stale failure history),
  # then start_session, with tri-counter outcome bucketing per
  # M-life-4. `plan` is the resolved start_opts map; `capacity_input`
  # is the Admission shape; `log_keys` is the keyword list of
  # subject-specific log metadata used by both success + skip log
  # lines.
  @spec spawn_with_admission(
          Session.subject(),
          integer(),
          Session.start_opts(),
          map(),
          keyword(),
          Result.t()
        ) :: Result.t()
  defp spawn_with_admission(subject, network_id, plan, capacity_input, log_keys, acc) do
    case Grappa.Admission.check_capacity(capacity_input) do
      :ok ->
        # M-life-5: Bootstrap is operator action (deploy/restart). Any
        # prior Backoff state for (subject, network) is stale — operator
        # is overriding any failure history. Mirrors
        # Visitors.Login.preempt_and_respawn's reset call.
        :ok = Backoff.reset(subject, network_id)

        case Session.start_session(subject, network_id, plan) do
          {:ok, _} ->
            Logger.info("session started", log_keys)
            %{acc | spawned: acc.spawned + 1}

          {:error, {:already_started, _}} ->
            # F3 (S29) + M-life-4: Bootstrap is `restart: :transient`. On
            # the (single) restart every previously-spawned session is
            # still alive under the same `{:via, Registry, ...}` key, so
            # `start_session/3` returns `{:error, {:already_started, pid}}`.
            # Idempotent NO-OP, NOT a fresh start: Bootstrap did nothing
            # because the session was already up. Routed to `:skipped`
            # so `:spawned` accurately reflects "Bootstrap brought this
            # up just now."
            Logger.debug("session already started", log_keys)
            %{acc | skipped: acc.skipped + 1}

          {:error, reason} ->
            Logger.error("session start failed", [error: inspect(reason)] ++ log_keys)
            %{acc | failed: acc.failed + 1}
        end

      {:error, :network_cap_exceeded} ->
        # T31 Plan 2 Task 4 — per-network total cap tripped. Best-effort
        # per the moduledoc's failure-modes contract: skip the row + warn,
        # no queue or retry shape. Operator sizes the cap correctly is
        # the right pressure. M-life-4: routed to `:skipped` (policy),
        # not `:failed` (faults).
        Logger.warning("session skipped — network cap exceeded", log_keys)
        %{acc | skipped: acc.skipped + 1}

      {:error, reason} ->
        # Other Admission errors (e.g. circuit-open) are operationally
        # closer to a real fault — surface as failed so the dashboard
        # cap-vs-fault distinction stays clean.
        Logger.error("session start failed", [error: inspect(reason)] ++ log_keys)
        %{acc | failed: acc.failed + 1}
    end
  end

  # W7 invariant: every active visitor's `network_slug` must resolve
  # to a `Networks.Network` row at boot. Visitor sessions trust the
  # slug → network resolution to succeed at runtime
  # (`Visitors.Login` + `Visitors.SessionPlan` both depend on it), so
  # if the operator drops a network from the DB while visitor rows
  # still point at it, those visitors are orphaned. The choice between
  # silent reap (lose user data on a config typo) and explicit
  # operator intervention (require a deliberate cleanup or restore)
  # is intentionally biased toward the latter — better to refuse to
  # boot loudly than to drop scrollback on a misconfiguration.
  @spec validate_visitor_networks!([Visitor.t()]) :: :ok
  defp validate_visitor_networks!(visitors) do
    orphans =
      visitors
      |> Enum.map(& &1.network_slug)
      |> Enum.uniq()
      |> Enum.reject(fn slug ->
        match?({:ok, _}, Networks.get_network_by_slug(slug))
      end)

    case orphans do
      [] ->
        :ok

      slugs ->
        msg =
          "visitor rows pinned to network(s) not in current config: " <>
            "#{inspect(slugs)}. Either restore the network in DB or run: " <>
            Enum.map_join(slugs, " ; ", &"mix grappa.reap_visitors --network=#{&1}")

        raise RuntimeError, msg
    end
  end

  # Servers-bound invariant: every distinct network referenced by a
  # bound credential or active visitor must have at least one enabled
  # server in `network_servers`. A network without a usable server is
  # silently broken in BOTH directions:
  #
  #   - Bootstrap's per-row `SessionPlan.resolve/1` returns
  #     `{:error, :no_server}` and bumps the `failed` counter, but the
  #     supervision tree comes up healthy and the operator only sees
  #     it via grep.
  #   - Every subsequent `POST /auth/login` (admin or visitor) for
  #     that network exercises the same resolve path, fails with
  #     `:no_server`, and the controller's catch-all maps the unknown
  #     reason to `{:error, :internal}` → opaque 500. Cicchetto users
  #     see a generic error with no actionable signal.
  #
  # The fix at the controller would still leave the bouncer in a
  # half-configured state. The honest signal is to refuse to boot and
  # point the operator at `mix grappa.add_server`. Mirrors the W7
  # visitor-network bias.
  @spec validate_credential_servers!([Credential.t()], [Visitor.t()]) :: :ok
  defp validate_credential_servers!(credentials, visitors) do
    cred_networks =
      Enum.map(credentials, fn %Credential{network: %Network{} = n} -> n end)

    visitor_networks =
      visitors
      |> Enum.map(& &1.network_slug)
      |> Enum.uniq()
      |> Enum.flat_map(fn slug ->
        case Networks.get_network_by_slug(slug) do
          {:ok, %Network{} = n} -> [n]
          {:error, :not_found} -> []
        end
      end)

    serverless =
      (cred_networks ++ visitor_networks)
      |> Enum.uniq_by(& &1.id)
      |> Enum.filter(fn %Network{} = n ->
        n |> Servers.list_servers() |> Enum.filter(& &1.enabled) == []
      end)
      |> Enum.map(& &1.slug)

    case serverless do
      [] ->
        :ok

      slugs ->
        msg =
          "network(s) referenced by bound credentials or active visitors " <>
            "have no enabled server in network_servers: #{inspect(slugs)}. " <>
            "Bind one with: " <>
            Enum.map_join(slugs, " ; ", fn slug ->
              "mix grappa.add_server --network=#{slug} --host=<host> --port=<port>"
            end)

        raise RuntimeError, msg
    end
  end
end
