defmodule Grappa.Application do
  @moduledoc false

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Admission,
      Grappa.AdminEvents,
      Grappa.Bootstrap,
      Grappa.Health,
      Grappa.Net.PtrCache,
      Grappa.OutboundV6Pool,
      Grappa.PubSub,
      Grappa.Push,
      Grappa.RateLimit,
      Grappa.Repo,
      Grappa.Session,
      Grappa.Uploads,
      Grappa.Uploads.Reaper,
      Grappa.Vault,
      Grappa.Accounts.Reaper,
      Grappa.Visitors.Reaper,
      Grappa.Visitors.ShareTokens,
      Grappa.WSPresence,
      GrappaWeb
    ]

  use Application

  @impl Application
  def start(_, _) do
    # Boot-time captcha config injection — read :admission keys once,
    # validate, store in :persistent_term. CLAUDE.md "Application.{put,get}_env:
    # boot-time only" — this is the designated boundary site for the
    # :admission keyspace. See spec decision A in
    # docs/superpowers/specs/2026-05-03-t31-cleanup-design.md.
    :ok = Grappa.Admission.Config.boot()

    # UX-6-B1: stash the uploads storage root in `:persistent_term` so
    # the UploadsController + Uploads.Reaper read it lock-free at
    # runtime. Boot-time read of `Application.get_env/2` is the
    # CLAUDE.md-designated boundary (mirrors Admission.Config.boot/0).
    :ok = Grappa.Uploads.boot(uploads_storage_root())

    # H16 (REV-D 2026-05-22): pin the VAPID public key in
    # `:persistent_term` so PushVapidController reads lock-free per
    # request instead of doing a runtime `Application.fetch_env!/2`
    # (CLAUDE.md "boot-time only, runtime banned" — the lone offender
    # in the codebase). Mirrors `Grappa.Uploads.boot/1`. Must run
    # AFTER `config/runtime.exs` has populated `:web_push_elixir,
    # :vapid_public_key` from `VAPID_PUBLIC_KEY` env, which is
    # guaranteed by the time `Application.start/2` is invoked.
    :ok = Grappa.Push.boot()

    # Outbound v6 source-address pool. Initialize an EMPTY pool at boot;
    # `Grappa.Bootstrap` installs the DB-curated `in_pool` vhosts via
    # `apply_pool/1` before spawning any session (#228 — DB-driven, no
    # env var). Empty pool = kernel-default source selection.
    :ok = Grappa.OutboundV6Pool.boot()

    # Child order is load-bearing — see CLAUDE.md "Don't touch supervision
    # tree ordering casually." Each comment below documents the WHY so a
    # reorder is a deliberate choice.
    children =
      [
        # Vault before Repo: Cloak's Ecto types (Grappa.EncryptedBinary)
        # reach into the Vault GenServer at schema dump/load time. If
        # Repo loaded a schema with an encrypted field before Vault was
        # up, the type callback would crash with `:noproc`.
        Grappa.Vault,

        # Must come first (after Vault): every context that touches the
        # DB depends on Repo being up. Sessions write Scrollback rows;
        # Phase 2 schemas (network_credentials) carry encrypted columns
        # that need Vault — hence Vault first.
        Grappa.Repo,

        # PubSub before Endpoint — Endpoint's compile-time config names
        # `pubsub_server: Grappa.PubSub` and the channel layer subscribes
        # at join time. Sessions broadcast inbound PRIVMSGs over PubSub.
        {Phoenix.PubSub, name: Grappa.PubSub},

        # Registry before DynamicSupervisor — Session.Server registers
        # itself under {:session, user, network_id} via this Registry,
        # and lookups happen in DynamicSupervisor's start_child cascade.
        # Application-wide singleton (`name: Grappa.SessionRegistry`)
        # shared across the entire `mix test` run; tests sharing the
        # same `network_id` would observe each other's registered
        # session pids. `config :ex_unit, max_cases: 1` in
        # `config/test.exs` is the global guard. Tests touching this
        # registry (Session.whereis/2 callers, Bootstrap.spawn_*,
        # SpawnOrchestrator.spawn/4) MUST stay `async: false`.
        {Registry, keys: :unique, name: Grappa.SessionRegistry},

        # Backoff before SessionSupervisor — owns the ETS table that
        # tracks per-(subject, network_id) failure counts across
        # `:transient` Session.Server respawns. Reads are direct ETS
        # lookups from `Session.Server.handle_continue/2`'s start path,
        # so the table MUST exist before the first session spawn. See
        # `Grappa.Session.Backoff` moduledoc for the curve + rationale.
        Grappa.Session.Backoff,
        # WSPresence: tracks live WS socket pids per user_name to drive auto-away
        # (S3.1). Must come before SessionSupervisor so session processes can subscribe
        # to its notifications as soon as they start. Restart: :permanent (infrastructure).
        Grappa.WSPresence,
        # Grappa.Admission.NetworkCircuit (T31): both ETS-backed
        # singletons that must exist before the first session spawn or
        # admission check. NetworkCircuit funnels writes through its
        # GenServer; the named table is created in init/1.
        Grappa.Admission.NetworkCircuit,
        # AdminEvents (M-cluster M-11): singleton GenServer that
        # attaches :telemetry handlers in init/1 + holds the admin-
        # events ring buffer. Must boot AFTER NetworkCircuit (which
        # emits the events we subscribe to) so the first transition
        # doesn't fire into a non-existent handler; AND BEFORE
        # SessionSupervisor so any session crash-loop that trips a
        # circuit on startup already has a handler attached.
        # Restart: :permanent (infrastructure).
        #
        # `attach_telemetry: false` in test env: the global handler
        # routes admission telemetry from EVERY async test to the
        # AdminEvents pid, which then calls `Networks.get_network/1`
        # via Wire.lookup_slug/1 → the sandbox connection is owned
        # by the EMITTING test's pid, not AdminEvents' pid, so the
        # lookup crashes with "could not lookup Ecto repo". Per-test
        # opt-in via `Process.whereis(AdminEvents) |>
        # Ecto.Adapters.SQL.Sandbox.allow(...)` keeps the
        # AdminEvents-targeting tests honest without bleeding into
        # unrelated suites.
        {Grappa.AdminEvents, attach_telemetry: attach_admin_telemetry?(), persist: persist_admin_events?()},
        # SessionLog (#215): singleton GenServer sink for the persisted IRC
        # session-lifecycle log. Attaches `[:grappa, :session, :log, _]`
        # telemetry in init/1 + persists each event to `session_log_events`.
        # Same ordering rationale as AdminEvents: boot BEFORE
        # SessionSupervisor so the first session's connect/disconnect
        # telemetry has a handler attached. Restart: :permanent
        # (infrastructure). `attach_telemetry: false` in test env for the
        # same sandbox-ownership reason as AdminEvents.
        {Grappa.SessionLog, attach_telemetry: attach_session_log_telemetry?()},
        # ShareTokens: ETS-backed one-shot set for visitor share-link
        # token redemption. Must come before Endpoint so the consume
        # controller never races a missing table. No upstream deps;
        # placed here to sit alongside the other ETS singletons
        # (Backoff, NetworkCircuit) for ordering clarity.
        Grappa.Visitors.ShareTokens,
        # #75 — per-(bucket, subject, day) creation quota. ETS-backed
        # singleton, sibling of Backoff / NetworkCircuit / ShareTokens:
        # must exist before Endpoint so `Grappa.Themes.create_theme/2`'s
        # rate-limit check (via the ThemesController) never races a
        # missing table. No upstream deps; writes funnel through its
        # GenServer for atomic check-and-record.
        Grappa.RateLimit.DailyQuota,
        # #252 — vhost reverse-DNS (PTR) name cache. ETS-backed singleton
        # sibling of Backoff / NetworkCircuit / ShareTokens: must exist
        # before Endpoint so `UserSettingsController.show_vhost/2`'s
        # lock-free `names_for/1` read never races a missing table. The
        # resolver is injected at boot (test wires an offline stub via
        # `:vhost_ptr_resolver`); dev/prod fall through to the module's
        # baked-in real `:inet_res` resolver. No SessionSupervisor /
        # TaskSupervisor dependency — resolves run in its own cast handler.
        ptr_cache_child(),
        # Task.Supervisor for detached fire-and-forget work that must NOT be
        # linked to the spawning process (S37). `Session.Server`'s terminal-
        # failure handler runs its `credential_failer` callback here: it
        # can't run it synchronously (mark_failed → stop_session would
        # deadlock the exiting server) nor linked (a linked task dies with
        # the server's :normal exit before the DB transition lands), so it
        # detaches. `Task.start/1` detached it but left it unsupervised — a
        # raise in the failer then silently skipped the `:failed` DB
        # transition. Under this supervisor the task is tracked and its crash
        # is a visible SASL report. Must precede SessionSupervisor so a
        # session terminating on its start path can already reach it.
        {Task.Supervisor, name: Grappa.TaskSupervisor},
        # max_restarts: 10_000, max_seconds: 60 — DynamicSupervisor's
        # default (3 restarts in 5s) is GLOBAL across all children; one
        # upstream network-wide outage causing several Session.Server
        # retries blows the budget and the supervisor itself exits
        # :shutdown, torching every OTHER session under it. Cluster
        # visitor-auth flake characterization measured ~2000 restarts/sec
        # for a single session against a refused TCP port (RST returns
        # immediately, so the `:transient` restart cycle spins at full
        # CPU speed). Bumping the budget to 10_000 in 60s gives ~167/sec
        # sustained — enough to absorb 5s of full-rate restart-loop
        # before tripping, while still catching genuinely catastrophic
        # loops (10k restarts/min from one session is wildly abnormal).
        # Phase 5's per-session reconnect/backoff replaces the
        # exhaust-and-give-up shape with proper session-health tracking
        # + telemetry — these limits become genuinely-defensive failsafes
        # rather than the front-line tolerance. See DESIGN_NOTES
        # 2026-05-02.
        {DynamicSupervisor,
         name: Grappa.SessionSupervisor, strategy: :one_for_one, max_restarts: 10_000, max_seconds: 60},

        # Endpoint after PubSub + Registry — HTTP requests (REST controller,
        # WS Channel join) reach into both at request time.
        GrappaWeb.Endpoint,

        # Reaper after Repo (it queries Visitors via Repo) and after
        # Endpoint (so a slow boot doesn't sweep before the public
        # surface is up — Reaper's sweep deletes rows that REST/WS
        # might reach for; ordering it after Endpoint keeps the
        # "everything visible to clients is also visible to Reaper"
        # invariant honest). The default 60s interval is far longer
        # than boot, so the first sweep waits anyway — ordering is
        # belt-and-braces. Reaper consumes Grappa.Visitors; the
        # Application boundary has it listed in deps for that reason.
        Grappa.Visitors.Reaper,

        # UX-6-B1 (2026-05-20): embedded image uploader Reaper. Same
        # rationale as Visitors.Reaper for the ordering: after Repo
        # (it queries `uploads`) + after Endpoint (so the GET surface
        # is up before sweeps remove rows + files clients might be
        # reaching for). The Reaper also mkdir_p's the storage_root
        # in `init/1` so a fresh deploy needs no separate bootstrap.
        # `:storage_root` is read from `:grappa, :uploads_storage_root`
        # at THIS boot-time boundary — the controller + Reaper read
        # from `:persistent_term` thereafter (CLAUDE.md
        # "Application.{put,get}_env: boot-time only").
        {Grappa.Uploads.Reaper, storage_root: uploads_storage_root()},

        # #223: auth-session housekeeping GC. Sibling of Visitors.Reaper
        # / Uploads.Reaper — a THIRD domain (Accounts) gets its OWN
        # periodic sweep rather than folding into an unrelated reaper
        # (CLAUDE.md rule 6 — reuse the verb, not the noun). Same
        # ordering rationale: after Repo (it queries `sessions`) and
        # after Endpoint (so the auth surface is up before the sweep
        # removes idle-expired rows). Bulk `delete_all` over USER
        # sessions past the 7-day idle window that `authenticate/1`
        # already rejects; visitor sessions are out of scope (they
        # CASCADE from the visitor row via Visitors.Reaper). Default
        # 60s interval >> boot, so the first sweep waits anyway.
        Grappa.Accounts.Reaper

        # Bootstrap is appended LAST below: it depends on Registry +
        # SessionSupervisor existing so it can spawn sessions. Conditional
        # on :start_bootstrap so test boots empty.
      ] ++ bootstrap_child()

    opts = [strategy: :one_for_one, name: Grappa.Supervisor]

    case Supervisor.start_link(children, opts) do
      {:ok, _} = result ->
        # H26 (review 2026-05-22): flip the substrate-readiness flag
        # so `/healthz` returns 200 (vs the default 503-on-not-ready).
        # `:persistent_term` write — survives the start callback's
        # caller pid; surfaces wedge state if the supervisor restart-
        # loops (the flag stays `true` from the last successful boot,
        # but Repo + ETS checks in the controller catch the wedge).
        :ok = Grappa.Health.mark_ready()
        result

      other ->
        other
    end
  end

  # Bootstrap is opt-in via the `:start_bootstrap` flag (true in dev/prod,
  # false in test) so the test suite doesn't try to spawn live IRC sessions
  # against the operator's bound DB credentials when running `mix test`.
  @spec bootstrap_child() :: [] | [Grappa.Bootstrap]
  defp bootstrap_child do
    if Application.get_env(:grappa, :start_bootstrap, true) do
      [Grappa.Bootstrap]
    else
      []
    end
  end

  # UX-6-B1: storage_root for the embedded image uploader. Configured
  # via `:grappa, :uploads_storage_root` in `config/runtime.exs` (prod)
  # / `config/dev.exs` (dev) / `config/test.exs` (test). Read at boot
  # only (here + via `Grappa.Uploads.boot/1`); the runtime hot path
  # reads from `:persistent_term`.
  defp uploads_storage_root do
    Application.fetch_env!(:grappa, :uploads_storage_root)
  end

  # #252 — the vhost PTR cache child spec. Boot-time read (the CLAUDE.md
  # designated boundary for `Application.get_env/2`) of an OPTIONAL
  # resolver override: when unset (dev/prod) the child spec carries no
  # `:resolver` opt, so `Grappa.Net.PtrCache` uses its own baked-in real
  # resolver default; the test env sets an offline stub. Injecting only
  # the override keeps this module off a Boundary dep on the resolver.
  @spec ptr_cache_child() :: module() | {module(), keyword()}
  defp ptr_cache_child do
    case Application.get_env(:grappa, :vhost_ptr_resolver) do
      nil -> Grappa.Net.PtrCache
      resolver -> {Grappa.Net.PtrCache, resolver: resolver}
    end
  end

  # M-11 telemetry-attach gating. False in test env (set in
  # `config/test.exs`) so AdminEvents doesn't capture admission
  # telemetry from every async test pid (which would crash on the
  # sandbox-ownership lookup mismatch). AdminEvents-targeting tests
  # still invoke `record/1` directly and bypass the telemetry path
  # entirely; tests that EXERCISE the telemetry adapter use the
  # `:sys.replace_state` + `Ecto.Adapters.SQL.Sandbox.allow/3`
  # pattern in `test/grappa/admin_events_test.exs`.
  @spec attach_admin_telemetry?() :: boolean()
  defp attach_admin_telemetry?, do: Application.get_env(:grappa, :attach_admin_telemetry, true)

  # #215 Option B — AdminEvents disk mirror. On in prod; off in test env
  # (the singleton's Repo write would hit a foreign sandbox connection).
  @spec persist_admin_events?() :: boolean()
  defp persist_admin_events?, do: Application.get_env(:grappa, :persist_admin_events, true)

  # #215 — same test-env opt-out as admin telemetry: the SessionLog sink
  # persists to Repo, which must be sandbox-allowed per test; a global
  # handler routing every test's session-lifecycle telemetry would write
  # on a foreign sandbox connection.
  @spec attach_session_log_telemetry?() :: boolean()
  defp attach_session_log_telemetry?,
    do: Application.get_env(:grappa, :attach_session_log_telemetry, true)

  @impl Application
  def config_change(changed, _, removed) do
    GrappaWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
