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
  user) increment one of the typed failure counters and continue with
  the next session; one bad row does not block the others.

  ## Hard-fail config invariant — refuse to boot on misconfig

  One pre-spawn invariant is enforced by `raise RuntimeError` so a
  bad operator config halts the supervisor instead of silently
  degrading:

    * **Servers-bound invariant** — every distinct network referenced
      by a `Networks.Credential` (mode-1 admin) OR an active `Visitor`
      (visitor mode, via its credentials) must have at least one enabled
      server in `network_servers`. Without it, `SessionPlan.resolve/1`
      returns `{:error, :no_server}` per row at spawn time AND every
      subsequent `POST /auth/login` / cicchetto reconnect for that
      network surfaces as an opaque 500 (the controller's catch-all maps
      unknown reasons to `:internal`). The bouncer is unusable for that
      network in either direction; the only honest signal is to refuse
      to boot and tell the operator how to recover
      (`mix grappa.add_server`).

  This runs BEFORE the spawn loops so a misconfig surfaces on the very
  first boot attempt, not after the supervisor has been up long enough
  for the first user to hit login. This is the SAME bias as CLAUDE.md
  "errors are loud, not silent": "better to refuse to boot loudly than
  to drop scrollback on a misconfiguration."

  (#211 phase 7 — the former **W7 visitor-orphan invariant**
  `validate_visitor_networks!/1` is RETIRED. It required every active
  visitor's `network_slug` to resolve to a `Networks.Network`; that
  scalar column is dropped, per-network identity now lives on
  `network_credentials`, and the credential's `network_id` FK is
  `ON DELETE RESTRICT` — an orphaned visitor network is structurally
  impossible, so there is nothing left to validate at boot.)

  Per-row best-effort failure modes (below) handle conditions that are
  legitimately transient or per-row (cap exceeded, upstream connect
  refused) and cannot be ruled out at boot.

  Five counters (U-2 honest-log split per `feedback_log_honesty`),
  five operationally-distinct conditions:

    * `spawned` — `SpawnOrchestrator.spawn/4` returned `{:ok, :spawned, pid}`.
      Bootstrap actually brought up a fresh session for this row.
    * `already_running` — `{:ok, :already_started, pid}`. The session is
      already alive under the same `{:via, Registry, ...}` key.
      Idempotent NO-OP on Bootstrap restart (`:transient` policy: every
      previously-spawned row is still up). Distinct from spawning so the
      operator dashboard can tell a fresh boot from a Bootstrap restart.
    * `capacity_rejected` — any `Admission.capacity_error()`
      (`:visitor_cap_exceeded`, `:user_cap_exceeded`, `:ip_cap_exceeded`,
      `{:network_circuit_open, _}`) tripped the admission gate. Operator
      policy decision, not a fault — sized the cap correctly or accept
      the policy. (T31 Plan 2 Task 4 + U-2 typed-error split.)
    * `network_failed` — `{:error, {:start_failed, _}}` from the
      SpawnOrchestrator. Hard Session-init failure (e.g. upstream
      connect refused at `init/1` validation, missing-password CRASH).
    * `plan_failed` — `SessionPlan.resolve/1` returned an `{:error, _}`
      (`:no_server`, `:user_not_found`). Config-shape error per row,
      reported before admission/spawn.

  Operator dashboard semantics fall out cleanly: `spawned > 0` ⇒
  fresh start brought up new sessions; `capacity_rejected > 0` on a
  fresh boot ⇒ cap policy is tripping (size it correctly or accept
  the policy); `already_running > 0` on a Bootstrap restart ⇒
  everything is already alive (idempotent no-op — the expected
  case); `network_failed > 0` or `plan_failed > 0` ⇒ investigate.

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
    deps: [
      Grappa.Networks,
      Grappa.OutboundV6Pool,
      Grappa.Session,
      Grappa.SpawnOrchestrator,
      Grappa.Vhosts,
      Grappa.Visitors
    ]

  use Task, restart: :transient

  alias Grappa.Networks.{Credential, Credentials, Network, Servers, SessionPlan}
  alias Grappa.{Session, Visitors}
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan
  alias Grappa.Visitors.Visitor

  require Logger

  defmodule Result do
    @moduledoc """
    Five-counter accumulator + return value for `Grappa.Bootstrap.run/0`.

    See parent moduledoc's "Failure modes" section for the semantic
    distinction between `spawned`, `already_running`,
    `capacity_rejected`, `network_failed`, and `plan_failed`.
    """

    defstruct spawned: 0,
              already_running: 0,
              capacity_rejected: 0,
              network_failed: 0,
              plan_failed: 0,
              subject_row_gone: 0

    @type t :: %__MODULE__{
            spawned: non_neg_integer(),
            already_running: non_neg_integer(),
            capacity_rejected: non_neg_integer(),
            network_failed: non_neg_integer(),
            plan_failed: non_neg_integer(),
            subject_row_gone: non_neg_integer()
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

    # Hard-fail config invariant runs BEFORE any spawn so a bad operator
    # config halts the supervisor instead of degrading silently. See
    # moduledoc "Hard-fail config invariants" — the raise is
    # operator-facing and tells them how to recover.
    #
    # #211 phase 7 — `validate_visitor_networks!/1` was RETIRED: a visitor's
    # networks come from its `network_credentials` (FK `ON DELETE RESTRICT`
    # to `networks`), so an orphan "visitor pinned to a dropped network"
    # is structurally impossible — the DB FK is the guard. The
    # server-existence invariant below still covers visitor networks (via
    # their credentials, folded into `cred_networks`).
    validate_credential_servers!(credentials)

    # Install the outbound v6 rotation pool from the DB-curated `in_pool`
    # vhosts, MINUS every configured per-server fixed source, BEFORE any
    # session spawns — so no auto-allocated session can pick/0 a dedicated
    # oper IP (spec §3 safety net, preserved). Subtract-never-assert:
    # overlap is silently excluded, never a boot failure. #228 (vjt
    # 2026-07-14) — the pool source is now the DB, not the
    # GRAPPA_OUTBOUND_V6_POOL env var.
    apply_outbound_pool()

    user_stats =
      case credentials do
        [] ->
          log_web_only_warning()
          %Result{}

        credentials ->
          spawn_all(credentials)
      end

    visitor_stats = spawn_visitors(visitors)

    {:ok, sum_results(user_stats, visitor_stats)}
  end

  # Installs the effective outbound v6 pool = DB-curated `in_pool` vhosts
  # MINUS per-server fixed sources, before any session spawns. #228 (vjt
  # 2026-07-14) — pool is DB-driven (`Vhosts.pool_addresses/0`), no env
  # var. The fixed-source subtraction is the spec §3 safety net: a
  # dedicated per-network source_address must never leak into the
  # auto-rotation pool. String set-difference on canonical literals (both
  # stores canonicalize via `Grappa.Net.IpLiteral`), so `::9000` vs
  # `0:0:..:9000` can't slip past. `apply_pool/1` keeps only v6 entries.
  # Honest log states what we OBSERVED (pool / excluded / effective).
  @spec apply_outbound_pool() :: :ok
  defp apply_outbound_pool do
    pool = Grappa.Vhosts.pool_addresses()
    effective = Grappa.Vhosts.effective_pool(Servers.list_source_addresses())
    :ok = Grappa.OutboundV6Pool.apply_pool(effective)

    excluded = length(pool) - length(effective)

    msg =
      "outbound pool: #{length(pool)} in_pool vhosts, #{excluded} excluded as fixed " <>
        "sources, #{length(effective)} effective"

    # Quiet on deployments not using the feature (no pool at all).
    if pool == [], do: Logger.debug(msg), else: Logger.info(msg)

    :ok
  end

  # T-4 log-honesty: when the spawn loop runs against zero rows we MUST
  # distinguish "DB is empty (no operator binding yet)" from "rows exist
  # but every one is non-`:connected`" (every cred parked via T32, every
  # cred failed via k-line, etc.). Pre-T-4 the bare "no credentials
  # bound — running web-only" line lied in the parked / failed cases
  # and hid the configuration vjt's session-start incident chased to its
  # root cause. `Credentials.count_by_state/0` materializes the
  # state-by-state row count via one GROUP BY query so the operator sees
  # the truth: total rows + per-state breakdown.
  #
  # REV-H H8 (2026-05-22): per-state breakdown derived from
  # `Credential.connection_states/0` instead of hardcoded
  # `counts.parked + counts.failed`. A 4th state added to the schema's
  # `:connection_states` enum (e.g. `:reconnecting`) flows through
  # without an edit here — `count_by_state/0` zero-fills the new state
  # and the reject-connected-or-zero filter surfaces it in the log
  # line automatically.
  defp log_web_only_warning do
    counts = Credentials.count_by_state()
    total = counts |> Map.values() |> Enum.sum()

    if total == 0 do
      Logger.warning("bootstrap: no credentials bound — running web-only")
    else
      breakdown =
        counts
        |> Enum.reject(fn {state, n} -> state == :connected or n == 0 end)
        |> Enum.sort_by(fn {state, _} -> state end)
        |> Enum.map_join(", ", fn {state, n} -> "#{n} #{state}" end)

      Logger.warning(
        "bootstrap: 0 credentials in :connected state " <>
          "(#{breakdown}) — running web-only. " <>
          "Inspect with `bin/grappa list-credentials`."
      )
    end
  end

  @spec sum_results(Result.t(), Result.t()) :: Result.t()
  defp sum_results(%Result{} = a, %Result{} = b) do
    %Result{
      spawned: a.spawned + b.spawned,
      already_running: a.already_running + b.already_running,
      capacity_rejected: a.capacity_rejected + b.capacity_rejected,
      network_failed: a.network_failed + b.network_failed,
      plan_failed: a.plan_failed + b.plan_failed,
      subject_row_gone: a.subject_row_gone + b.subject_row_gone
    }
  end

  @spec spawn_all([Credential.t()]) :: Result.t()
  defp spawn_all(credentials) do
    stats = Enum.reduce(credentials, %Result{}, &spawn_one/2)

    Logger.info("bootstrap done",
      credentials: length(credentials),
      spawned: stats.spawned,
      already_running: stats.already_running,
      capacity_rejected: stats.capacity_rejected,
      network_failed: stats.network_failed,
      plan_failed: stats.plan_failed,
      subject_row_gone: stats.subject_row_gone
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
          # #171: cold-start has no HTTP conn → no source IP, so the
          # per-(source-IP, network) cap short-circuits on nil.
          source_ip: nil,
          flow: :bootstrap_user,
          # Boot-time spawn has no prior subject of record.
          requesting_subject: nil
        }

        spawn_with_admission({:user, user_id}, network_id, plan, capacity_input, log_keys, acc)

      {:error, reason} ->
        Logger.error("session plan failed", [error: inspect(reason)] ++ log_keys)
        %{acc | plan_failed: acc.plan_failed + 1}
    end
  end

  @spec spawn_visitors([Visitor.t()]) :: Result.t()
  defp spawn_visitors(visitors) do
    stats = Enum.reduce(visitors, %Result{}, &spawn_visitor/2)

    Logger.info("bootstrap visitors done",
      visitors: length(visitors),
      spawned: stats.spawned,
      already_running: stats.already_running,
      capacity_rejected: stats.capacity_rejected,
      network_failed: stats.network_failed,
      plan_failed: stats.plan_failed,
      subject_row_gone: stats.subject_row_gone
    )

    stats
  end

  @spec spawn_visitor(Visitor.t(), Result.t()) :: Result.t()
  defp spawn_visitor(%Visitor{id: visitor_id} = visitor, acc) do
    # #211 phase 4c/7 — a visitor's credentials can span MULTIPLE networks
    # (accretion), and identity lives per-network on the credential now.
    # Respawn ONE Session.Server per credential so a reboot restores ALL of
    # the identity's networks. An identity with no credentials (a fresh row
    # whose atomic provision half-committed, or an operator-mangled DB)
    # contributes nothing.
    case Credentials.list_visitor_credentials(visitor_id) do
      [] ->
        Logger.warning("bootstrap visitor has no credentials — skipped",
          visitor_id: visitor_id
        )

        acc

      credentials ->
        Enum.reduce(credentials, acc, &spawn_visitor_credential(visitor, &1, &2))
    end
  end

  @spec spawn_visitor_credential(Visitor.t(), Credential.t(), Result.t()) :: Result.t()
  defp spawn_visitor_credential(
         %Visitor{id: visitor_id},
         %Credential{connection_state: state, network: %Network{} = network},
         acc
       )
       when state in [:parked, :failed] do
    # #211 phase 6 (ruling D) — persistent visitor park across reboot.
    # A visitor who /disconnected network A parked its credential; on a
    # bouncer reboot Bootstrap must NOT respawn it (vjt: "visitor per
    # network disconnect persists after reboot, yes, of course cazzo").
    # Mirrors the user path (`list_credentials_for_all_users/0` filters to
    # `:connected`, i.e. skips BOTH :parked and :failed); the visitor path
    # enumerates ALL credentials (TTL identity lifecycle is orthogonal to
    # per-network session state), so the skip is per-credential here.
    # `:failed` is included for symmetry with the user path — visitor
    # credentials don't reach it today (the visitor terminal-failure axis
    # is Reaper/TTL on the identity row), but a future `:failed`-for-
    # visitors change must not silently diverge. Brought back via
    # `PATCH /networks/:id {connected}`.
    Logger.info("bootstrap: skipping #{state} visitor credential",
      visitor_id: visitor_id,
      network: network.slug
    )

    acc
  end

  defp spawn_visitor_credential(
         %Visitor{id: visitor_id} = visitor,
         %Credential{network: %Network{} = network},
         acc
       ) do
    log_keys = [visitor_id: visitor_id, network: network.slug]

    case VisitorSessionPlan.resolve(visitor, network) do
      {:ok, plan} ->
        capacity_input = %{
          network_id: network.id,
          # #171: cold-start visitor spawn — no conn, no source IP.
          source_ip: nil,
          flow: :bootstrap_visitor,
          requesting_subject: nil
        }

        spawn_with_admission(
          {:visitor, visitor_id},
          network.id,
          plan,
          capacity_input,
          log_keys,
          acc
        )

      {:error, reason} ->
        Logger.error(
          "visitor session plan failed",
          visitor_id: visitor_id,
          network: network.slug,
          error: inspect(reason)
        )

        %{acc | plan_failed: acc.plan_failed + 1}
    end
  end

  # Wrapper over `Grappa.SpawnOrchestrator.spawn/4` that buckets the
  # unified outcome shape into Bootstrap's 5-counter struct (U-2 honest
  # log per `feedback_log_honesty`) + emits the structured
  # subject-keyed log line the operator dashboard reads. The
  # orchestrator owns the dance (admission → Backoff.reset → spawn);
  # this helper owns ONLY the local concerns (counter accumulator +
  # Logger metadata shape). M-life-5 reset-on-success rationale lives
  # in the orchestrator's moduledoc.
  @spec spawn_with_admission(
          Session.subject(),
          integer(),
          Session.start_opts(),
          map(),
          keyword(),
          Result.t()
        ) :: Result.t()
  defp spawn_with_admission(subject, network_id, plan, capacity_input, log_keys, acc) do
    subject
    |> Grappa.SpawnOrchestrator.spawn(network_id, plan, capacity_input)
    |> classify_outcome(log_keys, acc)
  end

  @doc false
  # REV-H H7 (2026-05-22): testable seam — kept `@doc false` so the
  # closed-set regression test (`BootstrapTest classify_outcome…`) can
  # drive the catch-all branch without standing up an orchestrator
  # mock. Production callers go through `spawn_with_admission/6`.
  @spec classify_outcome(
          {:ok, atom(), pid()} | {:error, term()},
          keyword(),
          Result.t()
        ) :: Result.t()
  def classify_outcome({:ok, :spawned, _}, log_keys, acc) do
    Logger.info("session started", log_keys)
    %{acc | spawned: acc.spawned + 1}
  end

  def classify_outcome({:ok, :already_started, _}, log_keys, acc) do
    # F3 (S29) + U-2 honest log: Bootstrap is `restart: :transient`.
    # On the (single) restart every previously-spawned session is
    # still alive under the same `{:via, Registry, ...}` key, so
    # the orchestrator surfaces `{:already_started, _}` as
    # `{:ok, :already_started, _}`. Idempotent NO-OP, NOT a fresh
    # start: Bootstrap did nothing because the session was already
    # up. U-2: this used to share the `:skipped` bucket with
    # capacity rejections — now distinct so the dashboard can tell
    # "expected idempotent restart" from "capacity policy tripped."
    Logger.debug("session already started", log_keys)
    %{acc | already_running: acc.already_running + 1}
  end

  def classify_outcome({:ok, :ignored}, log_keys, acc) do
    # Session.Server.init/1 returned `:ignore` because the
    # subject's DB row is gone (operator-driven delete that fired
    # while this Session.Server was mid-respawn loop). Honest log
    # bucket — distinct from `:already_running` (expected
    # idempotent restart) and `:capacity_rejected` (admission
    # policy). DynamicSupervisor drops the child permanently;
    # bouncer state stays consistent with the DB.
    Logger.info("session skipped — subject row gone", log_keys)
    %{acc | subject_row_gone: acc.subject_row_gone + 1}
  end

  def classify_outcome({:error, cap_err}, log_keys, acc)
      when cap_err in [
             :visitor_cap_exceeded,
             :user_cap_exceeded,
             :ip_cap_exceeded
           ] do
    # T31 Plan 2 Task 4 + U-2 + #171: a per-network total or per-IP cap
    # tripped. Best-effort per the moduledoc's failure-modes contract:
    # skip the row + warn, no queue or retry shape. Operator sizes the
    # cap correctly is the right pressure. All cap atoms collapse here —
    # the dashboard distinguishes via the per-row Logger line's :error
    # key, not the summary counter (which collapses capacity-policy
    # events into one actionable bucket). Bootstrap carries
    # `source_ip: nil` so `:ip_cap_exceeded` is unreachable from boot; it
    # stays in the guard for completeness over `capacity_error()`.
    Logger.warning(
      "session skipped — capacity rejected",
      [error: cap_err] ++ log_keys
    )

    %{acc | capacity_rejected: acc.capacity_rejected + 1}
  end

  def classify_outcome({:error, {:network_circuit_open, _} = circuit_err}, log_keys, acc) do
    # U-2: circuit-open is a capacity-class rejection (operator-
    # controlled cooldown after repeated upstream failures). Counts
    # against capacity_rejected, not network_failed: the bouncer
    # CHOSE not to attempt the spawn, the upstream wasn't asked.
    Logger.warning(
      "session skipped — circuit open",
      [error: inspect(circuit_err)] ++ log_keys
    )

    %{acc | capacity_rejected: acc.capacity_rejected + 1}
  end

  def classify_outcome({:error, {:start_failed, reason}}, log_keys, acc) do
    # Session.start_session/3 returned a non-already_started error
    # (init refused — upstream connect failure, etc.). Distinct
    # bucket so the dashboard tells "the network is unreachable or
    # config is bad" apart from "capacity policy tripped" — only
    # network_failed should page on-call.
    Logger.error("session start failed", [error: inspect(reason)] ++ log_keys)
    %{acc | network_failed: acc.network_failed + 1}
  end

  def classify_outcome({:error, other}, log_keys, acc) do
    # REV-H H7 (2026-05-22): explicit catch-all for any future
    # SpawnOrchestrator failure shape (e.g. a 5th capacity-class
    # atom added to `Admission.capacity_error_atoms/0`) so a new
    # error tag doesn't crash-loop Bootstrap on every boot. We
    # WANT the surprise to be loud — Logger.error + bucket as
    # network_failed (the "investigate" lane) rather than silently
    # absorbing it.
    Logger.error(
      "session start failed — unknown error shape from SpawnOrchestrator",
      [error: inspect(other)] ++ log_keys
    )

    %{acc | network_failed: acc.network_failed + 1}
  end

  # Servers-bound invariant: every distinct network referenced by a bound
  # user credential OR an active visitor's credential must have at least one
  # enabled server in `network_servers`. A network without a usable server
  # is silently broken in BOTH directions:
  #
  #   - Bootstrap's per-row `SessionPlan.resolve` returns
  #     `{:error, :no_server}` and bumps the `failed` counter, but the
  #     supervision tree comes up healthy and the operator only sees
  #     it via grep.
  #   - Every subsequent `POST /auth/login` (admin or visitor) for
  #     that network exercises the same resolve path, fails with
  #     `:no_server`, and the controller's catch-all maps the unknown
  #     reason to `{:error, :internal}` → opaque 500. Cicchetto users
  #     see a generic error with no actionable signal.
  #
  # The honest signal is to refuse to boot and point the operator at
  # `mix grappa.add_server`.
  #
  # #211 phase 7 — visitor networks now come from `network_credentials`
  # (identity is per-network on the credential; the `visitors.network_slug`
  # scalar is dropped). `list_credentials_for_all_users/0` returns only
  # USER credentials, so this folds in each active visitor's credential
  # networks (preloaded `network: :servers` by
  # `list_visitor_credentials/1`) alongside the user side. One in-memory
  # walk over the union feeds the check.
  @spec validate_credential_servers!([Credential.t()]) :: :ok
  defp validate_credential_servers!(credentials) do
    cred_networks =
      Enum.map(credentials, fn %Credential{network: %Network{} = n} -> n end)

    visitor_networks =
      Visitors.list_active()
      |> Enum.flat_map(fn %Visitor{id: id} -> Credentials.list_visitor_credentials(id) end)
      |> Enum.map(fn %Credential{network: %Network{} = n} -> n end)

    serverless =
      (cred_networks ++ visitor_networks)
      |> Enum.uniq_by(& &1.id)
      |> Enum.filter(fn %Network{servers: servers} ->
        Enum.filter(servers, & &1.enabled) == []
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
