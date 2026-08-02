defmodule Grappa.Application do
  @moduledoc false

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Admission,
      Grappa.AdminEvents,
      Grappa.Bootstrap,
      Grappa.Cic.Bundle,
      Grappa.Health,
      Grappa.HttpHosts,
      Grappa.Net.PtrCache,
      # #543 INC-5: start/2 calls SourceAlias.Config.boot/0 (adapter/cmd DI-seam)
      # and supervises SourceAliasManager (arm gate + ref-count lifecycle).
      Grappa.Net.SourceAlias,
      Grappa.Net.SourceAliasManager,
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
      # #364 J/cross-module-S2: start/2 calls WindowCounts.PushSource.boot/0
      # + Themes.boot/0 to inject the two remaining DI-seams at boot.
      Grappa.WindowCounts,
      Grappa.Themes,
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

    # #364 J/cross-module-S2: stash the door #1 badge-count DI-seam impl in
    # `:persistent_term` so `Grappa.Push.BadgeSource.impl/0` resolves it
    # lock-free on the push hot path instead of a runtime `Application.get_env/2`
    # read (banned by CLAUDE.md). Mirrors `Grappa.Admission.Config.boot/0`.
    :ok = Grappa.Push.BadgeSource.boot()

    # #364 J/cross-module-S2: stash the #267 per-message window_counts push
    # DI-seam impl in `:persistent_term` so `WindowCounts.PushSource.impl/0`
    # resolves it lock-free from the Session.Server persist arm instead of a
    # runtime `Application.get_env/2` read. Mirrors `BadgeSource.boot/0`.
    :ok = Grappa.WindowCounts.PushSource.boot()

    # #364 J/cross-module-S2: stash the theme background image-fetcher DI-seam
    # in `:persistent_term` so `Themes.BackgroundImage` resolves it lock-free
    # instead of a runtime `Application.get_env(:grappa, :themes)` read.
    # Delegates to BackgroundImage.boot/0 (kept internal to the Themes context).
    :ok = Grappa.Themes.boot()

    # GH #630 — stash the coarse per-subject inbound request budget in
    # `:persistent_term` so `Grappa.RateLimit.RequestBudget.check/1`
    # (called from the REST write plug + the WS handle_in guard) reads it
    # lock-free instead of a runtime `Application.get_env/2` (banned by
    # CLAUDE.md). Mirrors `Grappa.Admission.Config.boot/0`. The
    # TokenBucket + FailureWindow ETS singletons it consumes are supervised
    # children (started below); this only seeds config, so ordering vs them
    # is immaterial — `check/1` is never called before the tree is up.
    :ok = Grappa.RateLimit.RequestBudget.boot()

    # #543 INC-5: stash the source-alias substrate → adapter + command runner
    # in `:persistent_term` so `Grappa.Net.SourceAlias.Config` resolves them
    # lock-free (the FreeBSD/Linux adapters + the ref-count manager read the
    # adapter/cmd per call). Boot-time read of `Application.get_env(:grappa,
    # :source_alias)` is the CLAUDE.md-designated boundary (mirrors
    # `Grappa.Admission.Config.boot/0`). The ARM state is NOT set here — the
    # manager computes it once the Repo is up (it needs the DB prefix).
    :ok = Grappa.Net.SourceAlias.Config.boot()

    # Outbound v6 source-address pool. Initialize an EMPTY pool at boot;
    # `Grappa.Bootstrap` installs the DB-curated `in_pool` vhosts via
    # `apply_pool/1` before spawning any session (#228 — DB-driven, no
    # env var). Empty pool = kernel-default source selection.
    :ok = Grappa.OutboundV6Pool.boot()

    # #324: stash the deployment's HTTP host aliases in `:persistent_term`
    # so `ServerSettings.public_view/0` advertises them to cic lock-free
    # (the media-link classifier admits any deployment alias, not just the
    # page origin). Boot-time read of `Application.get_env/2` is the
    # CLAUDE.md-designated boundary (mirrors `Grappa.Uploads.boot/1`).
    :ok = Grappa.HttpHosts.boot(http_host_aliases())

    # #399: stash the built cicchetto SPA dist root in `:persistent_term`
    # so the endpoint's `Plug.Static` + SPA history-fallback and
    # `Grappa.Cic.Bundle`'s hash/version live-read resolve against ONE
    # root lock-free. Boot-time read of `Application.get_env/2` is the
    # CLAUDE.md-designated boundary (mirrors `Grappa.Uploads.boot/1`).
    :ok = Grappa.Cic.Bundle.boot(cic_dist_root())

    # #671: resolve the auto-away debounce window into `:persistent_term`
    # so `Grappa.Session.start_session/3` injects it into every session's
    # start opts lock-free (dynamic children have no static-child inject
    # point; boot → persistent_term → spawn-boundary inject is the
    # start_link-opts pattern for them). Prod sets no config key → the
    # compile-time 600_000 default; the integration env (config/dev.exs)
    # sets it short. Mirrors `Grappa.Uploads.boot/1`.
    :ok = Grappa.Session.Server.boot()

    # Child order is load-bearing — see CLAUDE.md "Don't touch supervision
    # tree ordering casually." Each comment below documents the WHY so a
    # reorder is a deliberate choice.
    # Endpoint after PubSub + Registry — HTTP requests (REST controller,
    # WS Channel join) reach into both at request time. Conditional on
    # :start_endpoint (mirrors :start_bootstrap below): the `grappa.*`
    # one-shot operator mix tasks (Mix.Tasks.Grappa.Boot.start_app_silent/0)
    # need Repo + the domain contexts but NOT the HTTP surface — starting
    # it anyway used to force "stop the live service first" for every
    # admin task (create_user, bind_network, seed_themes, ...), since a
    # second bind of the same port crashes `:eaddrinuse`. An app that
    # ships hot code-reload has no business demanding a full stop/start
    # cycle just to run a one-off DB mutation alongside it. Found live
    # 2026-07-23 running `grappa.seed_themes` against a live host.
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

        # #543 INC-6 — the derived-source-alias holder index. A `:duplicate`
        # Registry keyed BY ADDRESS: each `Session.Server` that acquires a
        # derived `::cb` alias registers itself under that address, so many
        # NAT-collapsed sessions sharing one `/64` appear as many entries under
        # the one key. `Grappa.Net.SourceAliasManager` reads it (via the
        # injected `held_source_fn`) at reconcile to rebuild the held set AFTER
        # its OWN restart — the refcount table it keeps is authoritative for
        # prompt bind/unbind but does NOT survive a manager crash, whereas this
        # Registry is auto-GC'd by the BEAM on holder death and DOES survive.
        # Before SessionSupervisor (sessions register into it) and before the
        # manager (the reconcile reader). See `SourceAliasManager.held_addresses/1`
        # for why the two sources are deliberately not folded.
        {Registry, keys: :duplicate, name: Grappa.SourceAliasHolders},

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
        # DbLatency (#357): singleton GenServer that attaches :telemetry
        # handlers in init/1 and folds `[:grappa, :repo, :query]` +
        # the D1 write-path spans into in-memory latency counters. The
        # interim in-code consumer for the #357 spans (which "ship no
        # handler by default") so the 25s-under-load sample survives a
        # restart instead of being hand-attached over rpc and wiped by
        # the next cold. Boot alongside the other telemetry sinks
        # (AdminEvents / SessionLog) and BEFORE SessionSupervisor so the
        # FIRST session's persist/send spans already have a handler; it
        # holds no ETS/Registry/DB state of its own — the only ordering
        # requirement is to EXIST before the emitters fire. Restart:
        # :permanent (infrastructure). `attach_telemetry: false` in test
        # env so the global handler doesn't fold every async test's
        # queries into the shared singleton (per-test opt-in via manual
        # attach); unlike AdminEvents/SessionLog it needs NO sandbox
        # allow — the fold touches no Repo.
        {Grappa.DbLatency, attach_telemetry: attach_db_latency_telemetry?()},
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
        # S6 (review 2026-07-19) — per-(bucket, key) failure window.
        # ETS-backed singleton, sibling of DailyQuota above: must exist
        # before Endpoint so AuthController's mode-1 login throttle
        # never races a missing table. Reads are lock-free; failure
        # writes funnel through its GenServer.
        Grappa.RateLimit.FailureWindow,
        # #340 — per-(subject, network) inbound message-send token bucket.
        # ETS-backed singleton, sibling of DailyQuota / FailureWindow: must
        # exist before Endpoint so MessagesController.create's send throttle
        # never races a missing table. The refill-check-consume funnels
        # through its GenServer for atomicity (no lock-free peek — observing
        # a token bucket refills it).
        Grappa.RateLimit.TokenBucket,
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
         name: Grappa.SessionSupervisor, strategy: :one_for_one, max_restarts: 10_000, max_seconds: 60}
      ] ++
        endpoint_child() ++
        [
          # #543 INC-5: source-alias ref-count manager. Placed AFTER Endpoint
          # and BEFORE Bootstrap deliberately (supervision ordering is
          # load-bearing — CLAUDE.md). After Endpoint: its `handle_continue`
          # boot reconcile sweeps orphan aliases a crashed prior run left
          # bound, and ordering the sweep after the public surface is up keeps
          # the "everything clients can reach is reconciled" invariant honest
          # (sibling rationale to the Reapers below). Before Bootstrap: INC-6
          # sessions call `SourceAliasManager.acquire/1` on their connect path,
          # so the manager must already exist when Bootstrap spawns them. Its
          # `init/1` reads `ServerSettings.static_mapping_prefix/0` (Repo is up
          # this late) to run the platform `arm_check`. Opt-out via
          # `:start_source_alias_manager` (false in test — its unit tests start
          # their own Mox-wired instance under the default name).
        ] ++
        source_alias_manager_child() ++
        [
          # Reaper after Repo (it queries Visitors via Repo) and after
          # Endpoint, WHEN PRESENT (so a slow boot doesn't sweep before the
          # public surface is up — Reaper's sweep deletes rows that REST/WS
          # might reach for; ordering it after Endpoint keeps the
          # "everything visible to clients is also visible to Reaper"
          # invariant honest). The default 60s interval is far longer
          # than boot, so the first sweep waits anyway — ordering is
          # belt-and-braces. Reaper consumes Grappa.Visitors; the
          # Application boundary has it listed in deps for that reason.
          Grappa.Visitors.Reaper,

          # UX-6-B1 (2026-05-20): embedded image uploader Reaper. Same
          # rationale as Visitors.Reaper for the ordering: after Repo
          # (it queries `uploads`) + after Endpoint, when present (so the
          # GET surface is up before sweeps remove rows + files clients
          # might be reaching for). The Reaper also mkdir_p's the
          # storage_root in `init/1` so a fresh deploy needs no separate
          # bootstrap. `:storage_root` is read from
          # `:grappa, :uploads_storage_root` at THIS boot-time boundary —
          # the controller + Reaper read from `:persistent_term`
          # thereafter (CLAUDE.md "Application.{put,get}_env: boot-time
          # only").
          {Grappa.Uploads.Reaper, storage_root: uploads_storage_root()},

          # #223: auth-session housekeeping GC. Sibling of Visitors.Reaper
          # / Uploads.Reaper — a THIRD domain (Accounts) gets its OWN
          # periodic sweep rather than folding into an unrelated reaper
          # (CLAUDE.md rule 6 — reuse the verb, not the noun). Same
          # ordering rationale: after Repo (it queries `sessions`) and
          # after Endpoint, when present (so the auth surface is up before
          # the sweep removes idle-expired rows). Bulk `delete_all` over
          # USER sessions past the 7-day idle window that `authenticate/1`
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

  # Endpoint is opt-out via the `:start_endpoint` flag (true everywhere
  # except when a one-shot operator mix task flips it off via
  # `Mix.Tasks.Grappa.Boot.start_app_silent/0` — see that module).
  # Mirrors `bootstrap_child/0` exactly: same shape, same reason (a
  # caller that only needs the Repo-backed supervision tree shouldn't
  # be forced to also take on a side effect it never asked for — here,
  # binding the HTTP port a live release already owns).
  @spec endpoint_child() :: [] | [GrappaWeb.Endpoint]
  defp endpoint_child do
    if Application.get_env(:grappa, :start_endpoint, true) do
      [GrappaWeb.Endpoint]
    else
      []
    end
  end

  # #543 INC-5 — the source-alias ref-count manager. Opt-out via
  # `:start_source_alias_manager` (false in test), mirroring bootstrap_child/0:
  # the manager's own unit tests start a Mox-wired instance under the default
  # name, and the arm gate is injected via `SourceAliasManager.put_test_armed/2`
  # — so the live singleton (which would read ServerSettings + the real adapter
  # at boot) must not also run in the test tree.
  @spec source_alias_manager_child() :: [] | [{Grappa.Net.SourceAliasManager, keyword()}]
  defp source_alias_manager_child do
    if Application.get_env(:grappa, :start_source_alias_manager, true) do
      # #543 INC-6 — inject the live-holder source so the manager's reconcile
      # held set survives its OWN restart. Wired HERE (application.ex deps both
      # Grappa.Net + Grappa.Session) so the manager stays OFF a Grappa.Session
      # dep — a Net→Session edge would be backwards. `live_derived_sources/0`
      # is the pure `Grappa.SourceAliasHolders` Registry read.
      [{Grappa.Net.SourceAliasManager, held_source_fn: &Grappa.Session.live_derived_sources/0}]
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

  # #399: the built cicchetto SPA dist root. Configured via
  # `:grappa, :cic_dist_root` in `config/config.exs` (base default) /
  # `config/runtime.exs` (prod, `CIC_DIST_ROOT`) / `config/test.exs`
  # (fixture bundle). Read at boot only (here + `Grappa.Cic.Bundle.boot/1`);
  # the runtime path reads from `:persistent_term`. Mirrors
  # `uploads_storage_root/0`.
  defp cic_dist_root do
    Application.fetch_env!(:grappa, :cic_dist_root)
  end

  # #324 — the deployment's HTTP host aliases, boot-derived in
  # `config/runtime.exs` from `PHX_HOST` + `EXTRA_CHECK_ORIGINS`.
  # Boot-time read (the CLAUDE.md-designated boundary for
  # `Application.get_env/2`); absent in dev/test without `PHX_HOST` →
  # empty set, so cic admits only its own page origin (pre-#324).
  defp http_host_aliases, do: Application.get_env(:grappa, :http_host_aliases, [])

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

  # #357 — same test-env opt-out shape as the sinks above (read at boot,
  # injected via start_link opts — never a runtime Application.get_env in
  # a callback). Unlike them the reason is NOT sandbox ownership (DbLatency
  # does no Repo work) but determinism: a global handler folding every
  # async test's queries into the shared singleton would make snapshot
  # assertions flaky. Defaults true — prod/dev attach at boot.
  @spec attach_db_latency_telemetry?() :: boolean()
  defp attach_db_latency_telemetry?,
    do: Application.get_env(:grappa, :attach_db_latency_telemetry, true)

  @impl Application
  def config_change(changed, _, removed) do
    GrappaWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
