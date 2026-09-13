import Config

# This file is loaded at runtime (after compile-time config).
# Read environment variables here, NOT in compile-time config files.
#
# ===
# Runtime env-var registry. Every System.get_env(...) read in this
# file MUST appear in:
#   * compose.yaml `environment:` block (so Docker propagates it)
#   * .env.example with a comment describing the value (so operators know)
#   * (when applicable) the CSP allowlist in GrappaWeb.Plugs.SecurityHeaders
#     for any host this env var configures (#485 moved the CSP off nginx
#     into the app — the plug is the single source of truth now)
# Drift in any of these breaks the deploy in a way only real-browser
# e2e catches (per CP11 S22 deploy-time bug post-mortem).
# ENFORCED by test/grappa/config/env_registry_drift_test.exs (#369 X1):
# it DERIVES this registry from the env-var reads below (+ the
# bin/start.sh shell knobs) and pins it against compose.yaml + .env.example
# — no hand-kept manifest to drift.
# ===

# Public hostname the bouncer is reached at via nginx. ONE read, one
# empty-means-unset semantic — every PHX_HOST consumer below derives
# from this binding (review 2026-06-11: three sites previously read
# the env with three different empty-string semantics; `PHX_HOST=""`
# produced a `check_origin: ["//"]` entry).
phx_host =
  case System.get_env("PHX_HOST") do
    empty when empty in [nil, ""] -> nil
    host -> host
  end

# Extra origins accepted by the WebSocket handshake's `check_origin`
# gate alongside the canonical PHX_HOST, AND — with PHX_HOST — the
# source of the deployment's HTTP host-alias set (#324, derived in the
# `if phx_host` block below → Grappa.HttpHosts). Comma-separated, full
# origin form (no trailing slash). Use case: operators reaching the
# bouncer via raw IP or a secondary hostname (LAN testing, dev VLAN
# bindings, a second public vhost) without rewriting nginx + DNS.
# Hoisted OUT of the prod block (all envs) so the alias set is
# derivable in the e2e harness (MIX_ENV=dev). Empty / unset = no extras.
extra_origins =
  case System.get_env("EXTRA_CHECK_ORIGINS") do
    nil -> []
    "" -> []
    raw -> raw |> String.split(",") |> Enum.map(&String.trim/1) |> Enum.reject(&(&1 == ""))
  end

case System.get_env("GRAPPA_PASSKEY_ORIGIN") do
  origin when origin in [nil, ""] -> :ok
  origin -> config :grappa, :passkey_origin, origin
end

# Public-origin URL config — ALL envs, gated on PHX_HOST presence.
# nginx terminates TLS at https://PHX_HOST, so URLs Phoenix generates
# (today: only `UploadsController.public_url/1`, which lands in IRC
# message bodies as `📸 https://host/uploads/<slug>`) must be rooted
# at the PUBLIC origin, not the BEAM's listen socket. The pre-fix
# prod shape (`url: [host: phx_host, port: 80]`, no scheme key)
# minted http:// links onto the https PWA — every pre-fix upload link
# in scrollback history carries that scheme, which is why cic's
# mediaLink classifier matches on host and re-roots the scheme
# (media-link viewer entry, DESIGN_NOTES 2026-06-11).
# Hoisted OUT of the prod block so the e2e harness (MIX_ENV=dev,
# PHX_HOST=nginx-test in cicchetto/e2e/compose.yaml) mints
# origin-faithful URLs too. Local dev: compose.yaml passes
# `PHX_HOST: ${PHX_HOST:-}` — unset keeps the config.exs localhost
# default.
if phx_host do
  config :grappa, GrappaWeb.Endpoint, url: [host: phx_host, scheme: "https", port: 443]

  # #324 — the deployment's HTTP host aliases: every hostname nginx
  # reverse-proxies to this ONE instance (shared /uploads store, e.g.
  # irc.sindro.me + irc.sniffo.org). Derived from the SAME env inputs
  # that build `check_origin` below (PHX_HOST + EXTRA_CHECK_ORIGINS) —
  # single source of truth, no second hand-maintained list. Bare,
  # lowercased hostnames (URI.parse drops scheme / `//` AND port).
  # Deployment aliases that mint uploads are default-port https, whose
  # `new URL().host` in cic is bare too → they match. A non-default-port
  # EXTRA_CHECK_ORIGINS entry (a raw-IP LAN escape hatch) won't match a
  # link on that explicit port — acceptable: it just falls back to the
  # plain anchor (never a WRONG re-root, since the page origin is always
  # admitted and the re-root always targets the page origin). Stashed
  # into `:persistent_term` by `Grappa.HttpHosts.boot/1` at app start and
  # advertised to cic via `ServerSettings.public_view/0`, so cic's
  # media-link classifier opens the in-app viewer for an upload link
  # carrying ANY alias, not just the page origin.
  http_host_aliases =
    [phx_host | Enum.map(extra_origins, fn origin -> URI.parse(origin).host end)]
    |> Enum.reject(&(&1 in [nil, ""]))
    |> Enum.map(&String.downcase/1)
    |> Enum.uniq()

  config :grappa, :http_host_aliases, http_host_aliases
end

# #1945 — every storage root this file derives resolves ABSOLUTELY, or it
# is the operator's own path and says so out loud. NONE of them is left to
# the BEAM's CWD.
#
# The CWD is not a value any operator sets or sees: it is whatever the init
# system left the process in. The v1.5.0 cold deploy on the production jail
# is what that cost — `rc.d/grappa` starts the release with
# `su -m grappa -c '.../bin/grappa daemon'` and NO WorkingDirectory, so the
# CWD is `/`, the unset PEER_AVATARS_STORAGE_ROOT default
# `runtime/peer_avatars` resolved to `/runtime/peer_avatars`, and
# `Grappa.Avatars.Reaper.init/1`'s `File.mkdir_p!` died of eacces INSIDE the
# supervision tree. A boot crash, not a degraded feature.
# `Grappa.Uploads.Reaper.init/1` carries the same bang and escaped only
# because the jail's env file happens to set UPLOADS_STORAGE_ROOT.
#
# The second failure mode is quieter and worse: on the release image
# `WORKDIR /app` is writable by the `grappa` user, so `mkdir_p!` SUCCEEDS
# and the peer-avatar cache lands in the container LAYER, outside the
# `/data` volume, where the documented `pull` + `up -d` upgrade discards it.
# A crash at least tells you.
#
# So an UNSET root takes an absolute default (see each site below), and an
# empty value counts as unset — `System.get_env(x) || default` used to keep
# `""`, because the empty string is truthy, and `File.mkdir_p!("")` is not a
# directory. A value the operator DID set is kept verbatim: a relative one
# under Docker's `WORKDIR /app` is a working configuration `.env.example`
# shipped for a year, and re-anchoring it would silently relocate an
# existing uploads directory. In prod it earns a warning naming the CWD it
# will be read against — same belt-and-braces posture as the captcha
# warning further down — so the resolution stops being invisible.
storage_root = fn var, value, default ->
  case value do
    unset when unset in [nil, ""] ->
      default

    root ->
      if config_env() == :prod and Path.type(root) != :absolute do
        require Logger

        Logger.warning(
          "#{var} is set to a RELATIVE path (#{inspect(root)}) — it resolves against the " <>
            "BEAM's current working directory (#{File.cwd!()}), which the init system chooses, " <>
            "not the operator. Set it to an absolute path."
        )
      end

      root
  end
end

# #399 / #485 — the built cicchetto SPA dist the embedded web server
# self-serves (Plug.Static + SPA history-fallback) AND re-reads to
# broadcast the refresh-banner hash (Grappa.Cic.Bundle). Stashed into
# `:persistent_term` via Grappa.Cic.Bundle.boot/1 at app start (boot
# time only — a change needs a BEAM restart, not a hot reload).
#
# UNSET, this derives NOTHING and leaves `config/config.exs`'s
# `Path.expand("../runtime/cicchetto-dist", __DIR__)` standing (#1945).
# That is the whole no-clobber arm: the dist is CODE, not data, so it gets
# no DATABASE_PATH anchor like the two roots below — a packaged install
# puts it in /usr/share/grappa while the DB is in /var/lib/grappa — and it
# does not need one, because the base config already computes an ABSOLUTE
# path. What this block used to do was overwrite that absolute anchor with
# the relative literal `runtime/cicchetto-dist`, in every env except :test,
# making the effective default strictly worse than the one it replaced.
# The build anchor is a BUILD-TIME expansion, so it is right exactly where
# the release is built in place (the jail's `mix release --overwrite` in
# /home/grappa/grappa, native systemd, Docker) and irrelevant elsewhere,
# since every cross-built package sets CIC_DIST_ROOT explicitly.
#
# The FreeBSD jail is what made this concrete (#526) — rc.d/grappa starts
# the release via `su -m grappa -c '.../bin/grappa daemon'` and sets NO
# WorkingDirectory, so the CWD is NOT the repo root; unset, the relative
# default missed the dist and /admin/cic-bundle-changed returned 204 with
# no banner broadcast. An absolute CIC_DIST_ROOT in grappa.env is still the
# explicit cure and still documented; it is no longer the only thing
# between that deployment and a silent 404.
#
# Broadened from prod-only (its #399 origin) to every env EXCEPT :test so
# the e2e harness serves the SPA too: #485 made the e2e nginx a DUMB proxy,
# so the BEAM — grappa-test, which runs MIX_ENV=dev — is now the ONLY thing
# serving the SPA. With the read prod-gated, `:cic_dist_root` stayed unset
# under MIX_ENV=dev, `Grappa.Cic.Bundle.root/0` fell back to the CWD default
# `runtime/cicchetto-dist` (empty in the container; the dist is mounted at
# CIC_DIST_ROOT=/app/cicchetto-dist), and every browser spec timed out on
# an unserved SPA. Same broadening precedent as `extra_origins` +
# `http_host_aliases` above. Empty / unset = the CWD default (local dev).
#
# :test is EXCLUDED on purpose: `config/test.exs` pins `:cic_dist_root` at
# the committed fixture bundle, and runtime config runs LAST — so setting
# it here would clobber the fixture and SpaServingTest would serve an empty
# dist (the 7-failure regression this exclusion prevents).
if config_env() != :test do
  # `nil` default = "there is no default HERE" — config/config.exs owns it.
  # The var name is written twice on purpose: the second read is the literal
  # `test/grappa/config/env_registry_drift_test.exs` derives the registry
  # from, so hiding it inside the closure would drop the var out of the
  # registry and read as a dead knob in compose.yaml.
  case storage_root.("CIC_DIST_ROOT", System.get_env("CIC_DIST_ROOT"), nil) do
    nil -> :ok
    cic_dist_root -> config :grappa, :cic_dist_root, cic_dist_root
  end
end

if config_env() == :prod do
  database_path =
    System.get_env("DATABASE_PATH") ||
      raise "environment variable DATABASE_PATH is missing"

  # #1945 — the deployment's DATA root, and the anchor every storage default
  # below hangs off: the directory the sqlite database lives in. It is the
  # one absolute path prod already mandates, and it is what those defaults
  # always MEANT — `runtime/uploads` was documented as "the sibling of the
  # sqlite DB", which is exactly this, without borrowing the CWD to say it.
  #
  # Measured against every substrate that ships, the derived default equals
  # the value already in force wherever the old one worked, and differs only
  # where it was broken: compose.yaml (`/app/runtime/grappa_<env>.db` →
  # `/app/runtime/uploads` + `/app/runtime/peer_avatars`, both byte-identical
  # to its own `:-` fallbacks) and the release image (`/data/grappa.db` →
  # `/data/uploads`, byte-identical to the ENV it bakes) are unmoved;
  # `base/deployment.yaml` sets `/data/peer_avatars` BY HAND to dodge the
  # ephemeral relative default, and that hand-written value is what this
  # computes. Pinned by test/grappa/config/storage_roots_config_test.exs so
  # a future divergence is a red gate, not a surprise on someone's volume.
  #
  # A relative DATABASE_PATH would make the anchor relative too, so it is
  # refused rather than propagated: such a deployment is CWD-bound end to
  # end (`Grappa.Repo.init/2` mkdir_p's this same dirname), and no shipped
  # template writes one. This is the explanatory error the eacces was not.
  data_root =
    case Path.type(database_path) do
      :absolute ->
        Path.dirname(database_path)

      _ ->
        raise """
        environment variable DATABASE_PATH is set to a RELATIVE path: #{inspect(database_path)}

        It is resolved against the BEAM's current working directory
        (#{File.cwd!()}), which the init system chooses — the FreeBSD rc.d
        script starts the release with no `cd` at all — and it anchors the
        uploads and peer-avatar directories as well as the database itself.

        Set DATABASE_PATH to an absolute path (e.g. /var/lib/grappa/grappa.db).
        """
    end

  # UX-6-B1 (2026-05-20): embedded image uploader storage dir. Read
  # at boot, stashed in :persistent_term via Grappa.Uploads.boot/1.
  # Defaults to the sibling of the sqlite DB, so the existing bind-mount
  # (or /data volume) covers it without a compose.yaml edit.
  uploads_storage_root =
    storage_root.(
      "UPLOADS_STORAGE_ROOT",
      System.get_env("UPLOADS_STORAGE_ROOT"),
      Path.join(data_root, "uploads")
    )

  config :grappa, :uploads_storage_root, uploads_storage_root

  # #1355 — the WAL's steady-state byte envelope. ONE number, in BYTES,
  # feeding both PRAGMAs below, because both express a byte-shaped intent:
  #
  #   * `journal_size_limit` takes bytes directly.
  #   * `wal_autocheckpoint` takes PAGES, so `Grappa.Repo.init/2` divides this
  #     by the DB file's LIVE `page_size` before the pool opens. NEVER pin a
  #     page count here: `docs/zfs-baseline-2026-07-31.md` moved prod from
  #     `page_size 4096` to `65536`, and the untouched 1000-page default
  #     silently went from ~4 MiB to ~64 MiB.
  #
  # 16 MiB is a TUNING CHOICE, not a measurement, argued between two bounds:
  # SQLite's own default was ~4 MiB here before the page-size change, but a
  # 64 KiB page makes a one-row update dirty 16× more WAL bytes, so pinning
  # 4 MiB would checkpoint far more often in wall-clock terms than this
  # deployment ever did. 16 MiB keeps the checkpoint cadence in the same
  # order as the pre-ZFS one while capping the WAL an order of magnitude
  # below the 168 MiB observed in #1355 — and it is a whole number of pages
  # at both 4096 and 65536, so no rounding either way.
  #
  # Deliberately NOT an env var: it is a tuning constant, not an operator
  # knob, and every env var carries a registry/compose/.env.example tax.
  wal_checkpoint_bytes = 16 * 1024 * 1024

  # M3b — cached peer CTCP AVATAR images. Read at boot, stashed in
  # :persistent_term via Grappa.Avatars.boot/1. Sibling of the uploads
  # dir, its own subdirectory (a separate trust domain — see
  # `Grappa.Avatars` moduledoc). THE #1945 root: this is the one no
  # substrate set, so it is the one that ate the jail's boot and the
  # release image's avatar cache.
  peer_avatars_storage_root =
    storage_root.(
      "PEER_AVATARS_STORAGE_ROOT",
      System.get_env("PEER_AVATARS_STORAGE_ROOT"),
      Path.join(data_root, "peer_avatars")
    )

  config :grappa, :peer_avatars_storage_root, peer_avatars_storage_root

  # NB: `:cic_dist_root` is derived ABOVE, hoisted out of this prod block
  # (all envs except :test) since #485 — see the comment there, which
  # folds in the #526 jail-CWD knowledge that used to live here.

  config :grappa, Grappa.Repo,
    database: database_path,
    # ── The contention ladder ────────────────────────────────────────
    #
    # Four numbers govern one contended write, and they are NOT four
    # independent defaults: each layer is supposed to hand the fault to
    # the layer above it, so they only make sense read together.
    #
    #     busy_timeout          300ms   in-NIF wait for the file lock
    #     busy_retry budget   1_500ms   BEAM-side ride-out (config/config.exs)
    #     queue_target        1_500ms   pool queue tolerance (CoDel drops at 2x)
    #     timeout            15_000ms   the caller's own deadline
    #
    # Before this was chosen as a ladder it ran 30_000 / 1_500 / 50 /
    # 15_000 — inverted at every rung, and only two of the four had ever
    # been chosen at all. What that cost is recorded in DESIGN_NOTES;
    # the short version is that the app-level retry engine could never
    # take a second attempt, and the pool shed requests (each one a lost
    # message) a hundred times sooner than the ride-out above it needed.
    #
    # SQLite is single-writer at the file level, so `pool_size` buys READ
    # concurrency under WAL (`journal_mode: :wal` below) and nothing on
    # the write side — writes serialize at the file lock whatever the
    # pool size is.
    #
    # 5 is a TUNING CHOICE argued between two bounds, not a measurement.
    # UPPER: every exqlite call runs inside a dirty-IO NIF, so the pool
    # is also the number of dirty-IO schedulers the Repo alone can hold —
    # and at the old `10` that equalled the ERTS default dirty-IO count
    # exactly, i.e. a saturated pool could occupy every one of them and
    # stall work with no database in it at all (#1715). That ceiling is
    # NOT hardware-derived: ERTS defaults `+SDio` to 10 whatever the core
    # count (measured: `+S 16:16` still answers 10), and the substrates
    # that exec the release directly set no `+SDio`, so 10 is the floor
    # everywhere and a constant below it needs no `nproc`. 5 leaves half.
    # LOWER: the read fan-out has to fit. NOT MEASURED at any pool size —
    # `config/dev.exs`'s #1759c comment says so outright, and the former
    # claim here that "lower than 10 starves cic's fan-out" carried no
    # measurement either. What IS exercised is 5: the whole e2e stack
    # runs `MIX_ENV: dev`, whose pool has been 5 all along.
    # `Grappa.Repo.check_dirty_io_reserve/2` reports at boot if either
    # side of that relation moves — including via GRAPPA_DIRTY_SCHEDULERS.
    #
    # ⚠️ The reserve is a STALL-TIME argument, not a throughput one, and
    # the difference is measured. At steady state the dirty-IO run queue
    # on prod is non-empty in 1 sample out of 400 at 50ms, maximum depth
    # 1 — the ten threads are nowhere near the bottleneck when the node
    # is healthy. What makes them scarce is a holder PARKED inside the
    # NIF: every exqlite entry point is `ERL_NIF_DIRTY_JOB_IO_BOUND`,
    # reads included, so a stalled writer occupies one of the ten for the
    # whole hold, and three consecutive holders were observed nailing
    # 3/10 during one prod episode. Occupancy DURING a stall is still
    # unmeasured. So this rung buys headroom for the bad minute, and
    # claims nothing about the good hour.
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "5"),
    # The in-NIF wait, and it is deliberately SHORT.
    #
    # exqlite's busy handler sleeps INSIDE a `ERL_NIF_DIRTY_JOB_IO_BOUND`
    # NIF, so every millisecond of `busy_timeout` is a dirty-IO scheduler
    # held by a process doing nothing (#1715 measures what queues behind
    # that: every `persistent_term` write and every module load in the
    # VM, for the length of the wait). The cure is not a longer wait, it
    # is to wait in the BEAM instead — `Grappa.Repo.BusyRetry`, which
    # already exists and was unreachable at the old value.
    #
    # 300ms is a TUNING CHOICE argued between two bounds.
    # UPPER: it must be a fraction of the 1_500ms retry budget or the
    # loop degenerates to a single attempt — `BusyRetry`'s own moduledoc
    # names that as a documented defect (#1421: at 30_000 the first
    # attempt has already overshot the deadline when it returns, so the
    # linear backoff never runs). With `backoff_ms: 25` (x attempt,
    # capped 200) a per-attempt cost of ~300ms yields four to five
    # attempts inside the unchanged budget, so the caller-visible wait
    # stays ~1.5s and no other rung has to move.
    # LOWER: it must exceed a HEALTHY hold or ordinary writes retry for
    # nothing. That distribution is NOT MEASURED, and neither instrument
    # we have can supply it — `LockWatch` reports only holds above its
    # 2_000ms stall threshold (it sees the tail, never the body) and
    # Ecto's per-query telemetry is completion-driven, so it measures the
    # victim rather than the holder. This bound is therefore argued from
    # above and open from below; a slow bulk write (an archive purge, a
    # `NickMigration` sweep) is the case to watch.
    #
    # This also SHRINKS the window in which an insert can outlive its FK
    # parent — the #340 rejection — from one 30_000ms attempt to a
    # ~1_500ms budget, because every retry is synchronous in the caller's
    # own process. Nothing here defers, spools or hands off a write.
    #
    # 🔴 WHAT THIS IS NOT: a cure for the 31s stalls. `busy_timeout`
    # governs who WAITS; the stalls are a single holder's POSSESSION
    # (`LockWatch`'s `held_ms` is measured from inside the transaction
    # fun, so it is possession and not queueing). Shortening the wait
    # bounds the BLAST RADIUS and makes the failure visible sooner; it
    # does not shorten one hold by a millisecond, and #1420's mechanism
    # remains unestablished. Do not read this rung as a fix for it.
    busy_timeout: 300,
    # The caller's own deadline, PINNED at the value that was already in
    # force. Ecto's default is 15_000 (`Ecto.Repo.Supervisor`'s
    # `@defaults`, merged in before `Grappa.Repo.init/2` ever sees the
    # config), so this line changes nothing today — same argument as
    # `synchronous` / `foreign_keys` below (REV-B/C3): a default that is
    # right by accident is one dep major-version flip from moving under
    # prod with no diff. It matters more here because this number is half
    # of a PAIR: the DB-side wait was chosen and the caller-side deadline
    # it should have been chosen against never was, which is how they
    # came to sit at 30_000 against 15_000, the caller giving up first.
    # When it fires DBConnection DESTROYS the connection rather than
    # failing the call (`ConnectionPool.handle_info({:timeout, …})` →
    # `Holder.handle_disconnect/2`), so it is the outer bound of the
    # ladder and nothing below it should ever reach it.
    timeout: 15_000,
    # The pool queue's CoDel tolerance. Unset, DBConnection defaults to
    # 50ms / 2_000ms — never chosen here, and `queue_target` is not a
    # latency knob: it is the threshold that turns burst latency into
    # DROPPED REQUESTS (`ConnectionPool.drop/2` raises the
    # `DBConnection.ConnectionError` that `Session.Persistor` reports as
    # `scrollback row dropped: persistence unavailable` — a message that
    # is neither stored nor delivered). At 50ms the queue began shedding
    # after ~100ms of sustained delay, an order of magnitude before the
    # 1_500ms ride-out above it had finished trying.
    #
    # The constraint that sets it: the queue must not drop a request
    # before the retry ladder above it has had its turn. So it is the
    # retry budget, and CoDel's doubling puts the first drop at ~3s of
    # SUSTAINED saturation — long enough that the ladder completes,
    # short enough that CoDel still does its job of refusing work before
    # it reaches the DB. `queue_interval` is the observation window over
    # which sustained slowness doubles the target; at 5_000 it spans
    # several full ladders before adapting, where the 2_000 default was
    # barely longer than one. `config/test.exs` already had to choose
    # both for CI (5_000 / 30_000) — the defaults were found inadequate
    # once already, in the only env where anyone had looked.
    #
    # NOT MEASURED: the healthy checkout-delay distribution. Both bounds
    # here are argued from the ladder, not from a reading.
    queue_target: 1_500,
    queue_interval: 5_000,
    journal_mode: :wal,
    cache_size: -64_000,
    temp_store: :memory,
    # REV-B / C3 (2026-05-22 codebase review): pin PRAGMAs that today
    # happen to be the correct ecto_sqlite3 defaults — `synchronous:
    # :normal` (correct under WAL — fsync on checkpoint, not every
    # commit) and `foreign_keys: :on` (the visitor-reap CASCADE chain
    # walks 8 tables and silently no-ops without it). Defaults are
    # "right by accident" — a dep major-version flip would silently
    # convert every prod commit into a fsync-deferred best-effort
    # write OR break CASCADE without a migration, log line, or diff.
    # Insurance against future dep upgrades; zero runtime behavior
    # change today.
    synchronous: :normal,
    foreign_keys: :on,
    # #1355, same "defaults are right by accident" class as the two above —
    # except here the default stopped being right the moment the page size
    # changed. `wal_autocheckpoint` was never set (SQLite's 1000 pages), and
    # `journal_size_limit` defaults to -1, meaning a checkpointed WAL is
    # RECYCLED at its high-water mark rather than truncated — which is why
    # prod's `-wal` reached 168 MiB and stayed there. Pinning the limit to
    # the same envelope as the checkpoint threshold means the steady-state
    # WAL is recycled with no truncate churn (it is already at that size),
    # while a burst-grown one comes back down at the next reset.
    wal_checkpoint_bytes: wal_checkpoint_bytes,
    journal_size_limit: wal_checkpoint_bytes

  # Every missing-secret raise routes through here (#862). The per-site
  # messages used to name `scripts/mix.sh …`, which exists in exactly ONE of
  # the four install flavours — and NOT in the release image, where that line
  # was the only guidance a `docker run ghcr.io/vjt/grappa:<tag> start`
  # operator ever saw before the process died. The recipe is substrate-neutral
  # (`openssl` is a hard dependency everywhere: the .deb/.rpm depend on it,
  # the release image apk-installs it, the BEAM links libcrypto anyway) and
  # the placement hints name all four rather than one.
  #
  # Keep the shapes in lockstep with infra/packaging/gen-secrets.sh, the ONE
  # generator the packaged, containerised and deploy.sh paths all run.
  env_placement = """
    .deb / .rpm   /etc/grappa/grappa.env — or `sudo grappa gen-secrets`,
                  which fills every missing secret in one go
    docker image  docker run -e ... — or give the container a WRITABLE
                  /data volume and it generates its own on first boot
    FreeBSD jail  the grappa_env_file named in rc.conf
    from source   .env beside compose.yaml\
  """

  missing_secret = fn var, recipe ->
    raise """
    environment variable #{var} is missing.

    Generate one with:  #{recipe}

    Then set #{var} where this install reads its environment:
    #{env_placement}
    """
  end

  # VAPID is the one secret openssl cannot produce as a one-liner, and the
  # one where a half-answer is worse than none: a public key from one
  # generation and a private key from another is a silently unusable pair.
  missing_vapid = fn var ->
    raise """
    environment variable #{var} is missing (Web Push signing, RFC 8292).

    VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are two halves of ONE P-256
    keypair — generate them together, never one at a time:
      from source   scripts/mix.sh grappa.gen_vapid
      .deb / .rpm   sudo grappa gen-secrets
      docker image  give the container a writable /data volume

    Then set BOTH where this install reads its environment:
    #{env_placement}
    """
  end

  secret_key_base = System.get_env("SECRET_KEY_BASE") || missing_secret.("SECRET_KEY_BASE", "openssl rand -base64 48")

  # T-2: enforce a real RELEASE_COOKIE in prod. The cookie itself is
  # consumed by the BEAM at boot via `-setcookie` (bin/start.sh) — Elixir
  # never reads it. This block exists to enroll RELEASE_COOKIE in the
  # runtime.exs registry (per the comment block at top of file: every
  # System.get_env in compose.yaml MUST appear here) AND to HARD-CRASH
  # the boot when an operator deploys prod without rotating off the dev
  # sentinel. Symptom of a missing check: prod boots happily with a
  # cookie any contributor can find in compose.yaml — same-host operator
  # gate is broken.
  case String.trim(System.get_env("RELEASE_COOKIE") || "") do
    "" ->
      missing_secret.("RELEASE_COOKIE", "openssl rand -hex 32")

    "grappa-dev-cookie-do-not-use-in-prod" ->
      raise """
      RELEASE_COOKIE is set to the compose.yaml dev sentinel — that value is
      public, and it is the same-host operator gate.

      Generate a real one with:  openssl rand -hex 32
      """

    # Operator-rotated value — proceed.
    _ ->
      :ok
  end

  # SECRET_SIGNING_SALT: salt for signing the Plug.Session cookie.
  # Pre-REV-C this was read at COMPILE TIME in config.exs — operator
  # rotation via `.env` + auto-deploy was silently broken (review
  # H21). Runtime read + first-request `:persistent_term` cache in
  # `GrappaWeb.Endpoint` makes rotation a normal COLD-deploy bump
  # like SECRET_KEY_BASE. Phase 5: when an auth surface starts using
  # the cookie (PushVapidController? Future REST auth?) this becomes
  # load-bearing for real.
  secret_signing_salt =
    System.get_env("SECRET_SIGNING_SALT") ||
      missing_secret.("SECRET_SIGNING_SALT", "openssl rand -base64 32")

  config :grappa, GrappaWeb.Endpoint, session_signing_salt: secret_signing_salt

  port = String.to_integer(System.get_env("PORT") || "4000")

  # PHX_HOST is MANDATORY in prod (read once at the top of this file).
  # Both its roles are load-bearing: `url:` roots generated links at
  # the public https origin (a missing value would silently fall back
  # to config.exs `host: "localhost"` and mint dead
  # `http://localhost/uploads/<slug>` links into permanent IRC
  # scrollback bodies), and `check_origin:` below gates every
  # Channels WS handshake. The old `|| "grappa.bad.ass"` fallback was
  # equally broken on the url side, just quieter — raise instead,
  # same contract as DATABASE_PATH / SECRET_KEY_BASE above. The `//`
  # prefix in check_origin matches both http and https so the Phase 5
  # TLS upgrade does not silently break Channels.
  # The one prod variable nothing can generate for you: it is the public
  # hostname clients reach, and grappa cannot know it. Every other missing
  # value has a generator (#862 wired the release image's); this one is the
  # deliberate remaining stop on a bare `docker run`.
  phx_host =
    phx_host ||
      raise """
      environment variable PHX_HOST is missing.

      Set it to the public hostname this bouncer is served at
      (e.g. PHX_HOST=grappa.example.org). Unlike the secrets, it cannot be
      generated — nothing knows your domain but you.

      Where it goes:
      #{env_placement}
      """

  # `extra_origins` (hoisted to the top of this file, all envs) feeds
  # both the WS `check_origin` gate here and the #324 HTTP host-alias
  # set. Production should pin to PHX_HOST only — EXTRA_CHECK_ORIGINS is
  # an escape-hatch (raw IP / secondary vhost), not a default.
  config :grappa, GrappaWeb.Endpoint,
    http: [ip: {0, 0, 0, 0}, port: port],
    check_origin: ["//#{phx_host}" | extra_origins],
    secret_key_base: secret_key_base,
    server: true

  # No `code_reloader` / `reloadable_apps` here, deliberately: Phoenix reads
  # `code_reloader` with `Application.compile_env/3`, so setting it from this
  # file kills every Mix-lane verb (#1692, pinned by
  # test/grappa/config/compile_env_runtime_overlap_test.exs). Prod hot-reload
  # is `Grappa.HotReload`, which needs neither flag.

  # Cloak vault key — base64-encoded 32 bytes. Generate once with
  # `scripts/mix.sh grappa.gen_encryption_key` and back up separately.
  # Losing the key means losing all stored upstream credentials.
  encryption_key =
    System.get_env("GRAPPA_ENCRYPTION_KEY") ||
      missing_secret.(
        "GRAPPA_ENCRYPTION_KEY",
        "openssl rand -base64 32   # BACK IT UP: losing it loses every stored credential"
      )

  config :grappa, Grappa.Vault,
    ciphers: [
      default: {Cloak.Ciphers.AES.GCM, tag: "AES.GCM.V1", key: Base.decode64!(encryption_key), iv_length: 12}
    ]

  # VAPID keypair for Web Push delivery (RFC 8292) — push notifications
  # cluster B2 (2026-05-14). Generated once with
  # `scripts/mix.sh grappa.gen_vapid` and pasted into
  # `compose.override.yaml`'s `grappa` service `environment:` block.
  #
  # `fetch_env!` so missing keys crash Bootstrap loudly rather than
  # silently dropping push delivery — same loud-failure posture as
  # SECRET_KEY_BASE / GRAPPA_ENCRYPTION_KEY above.
  #
  # The keys live in the `:ex_nudge` application environment because
  # that's where the upstream library reads them from at request time
  # (see `ExNudge.VAPID.get_keys/0` + the `k=` header in
  # `ExNudge.send_notification/3`). Routing through the library's
  # namespace avoids keeping a parallel `:grappa, :vapid` mirror that
  # would have to be kept in sync at boot. `Grappa.Push.boot/0` pins
  # the public key from the SAME namespace so the two consumers
  # cannot drift.
  #
  # #1290 moved this from `:web_push_elixir`. The VALUES are
  # untouched: both libraries want base64url-unpadded, both decode to
  # the raw 65-byte point + 32-byte scalar, and both build the same
  # `:ECPrivateKey` record for ES256 — so an existing deployment's
  # `VAPID_*` env vars keep working and no resubscription follows
  # from the namespace move.
  vapid_public_key = System.get_env("VAPID_PUBLIC_KEY") || missing_vapid.("VAPID_PUBLIC_KEY")

  vapid_private_key = System.get_env("VAPID_PRIVATE_KEY") || missing_vapid.("VAPID_PRIVATE_KEY")

  vapid_subject =
    case System.get_env("VAPID_SUBJECT") do
      nil -> "mailto:admin@example.org"
      "" -> "mailto:admin@example.org"
      subject -> subject
    end

  config :ex_nudge,
    vapid_public_key: vapid_public_key,
    vapid_private_key: vapid_private_key,
    vapid_subject: vapid_subject

  config :logger, level: String.to_existing_atom(System.get_env("LOG_LEVEL") || "info")

  # T31 admission captcha — operator-set provider, secret, and public
  # site key. Read at boot by FallbackController + Admission.verify_captcha
  # via Application.get_env (the documented exception, see those modules'
  # docstrings). Default provider is Disabled so a deploy without the env
  # vars boots clean and never emits captcha_required at the boundary.
  captcha_provider =
    case System.get_env("GRAPPA_CAPTCHA_PROVIDER", "disabled") do
      "turnstile" -> Grappa.Admission.Captcha.Turnstile
      "hcaptcha" -> Grappa.Admission.Captcha.HCaptcha
      _ -> Grappa.Admission.Captcha.Disabled
    end

  captcha_site_key = System.get_env("GRAPPA_CAPTCHA_SITE_KEY")
  captcha_secret = System.get_env("GRAPPA_CAPTCHA_SECRET")

  config :grappa, :admission,
    captcha_provider: captcha_provider,
    captcha_secret: captcha_secret,
    captcha_site_key: captcha_site_key

  # Belt-and-braces softer signal: Grappa.Admission.Config.boot/0 will
  # hard-crash on missing secret/site_key for non-Disabled providers,
  # but emitting a Logger.warning here surfaces the misconfiguration at
  # runtime.exs evaluation time — earlier in the boot sequence and
  # before the Application.start cascade — which is friendlier when
  # tailing prod logs after a botched env update.
  if captcha_provider != Grappa.Admission.Captcha.Disabled do
    require Logger

    if is_nil(captcha_secret) or captcha_secret == "" do
      Logger.warning(
        "captcha provider #{inspect(captcha_provider)} configured but GRAPPA_CAPTCHA_SECRET is missing/blank — Admission.Config.boot/0 will refuse to start"
      )
    end

    if is_nil(captcha_site_key) or captcha_site_key == "" do
      Logger.warning(
        "captcha provider #{inspect(captcha_provider)} configured but GRAPPA_CAPTCHA_SITE_KEY is missing/blank — Admission.Config.boot/0 will refuse to start"
      )
    end
  end

  # #1911 — OIDC login against one operator-configured provider. All four
  # vars REQUIRED together, ABSENT together: unset issuer = the door does
  # not exist on this deployment (`Grappa.Auth.Oidc.Config.boot/0` stores
  # nil and every `/auth/oidc/*` route answers 404), which is the normal
  # state of a deploy that has not opted in. Read once at boot by
  # `Grappa.Auth.Oidc.Config.boot/0` via Application.get_env (the
  # documented exception). Kanidm is the reference provider; anything
  # speaking discovery + authorization code + PKCE works.
  #
  # GRAPPA_OIDC_ISSUER       e.g. https://idm.example.com — the discovery
  #                          document and every endpoint come from it
  # GRAPPA_OIDC_CLIENT_ID    the OAuth2 client registered at the provider
  # GRAPPA_OIDC_CLIENT_SECRET
  # GRAPPA_OIDC_REDIRECT_URI the EXACT URL registered at the provider,
  #                          e.g. https://grappa.example.com/auth/oidc/callback
  #                          (never derived from the request — a derived
  #                          redirect lets a Host header choose where the
  #                          code is delivered)
  # GRAPPA_OIDC_SCOPES       optional, default "openid profile email";
  #                          add `groups` when the two gates below are
  #                          used (Kanidm grants the claim via the scope)
  # GRAPPA_OIDC_USERS_GROUP  optional, default off (#1911c): name of the
  #                          provider group whose members may log in; a
  #                          member's first login provisions the account
  #                          (Kanidm: grappa_users, matched bare or as
  #                          the spn grappa_users@realm)
  # GRAPPA_OIDC_ADMINS_GROUP optional, default off (#1911c): provider
  #                          group mapped to is_admin on every login
  #                          (Kanidm: grappa_admins)
  # Full setup walkthrough: docs/oidc-kanidm.md.
  oidc_issuer = System.get_env("GRAPPA_OIDC_ISSUER")

  if oidc_issuer not in [nil, ""] do
    require Logger

    oidc_client_id = System.get_env("GRAPPA_OIDC_CLIENT_ID")
    oidc_client_secret = System.get_env("GRAPPA_OIDC_CLIENT_SECRET")
    oidc_redirect_uri = System.get_env("GRAPPA_OIDC_REDIRECT_URI")
    oidc_scopes = System.get_env("GRAPPA_OIDC_SCOPES")
    oidc_users_group = System.get_env("GRAPPA_OIDC_USERS_GROUP")
    oidc_admins_group = System.get_env("GRAPPA_OIDC_ADMINS_GROUP")

    config :grappa, :oidc,
      issuer: oidc_issuer,
      client_id: oidc_client_id,
      client_secret: oidc_client_secret,
      redirect_uri: oidc_redirect_uri,
      scopes: oidc_scopes,
      users_group: oidc_users_group,
      admins_group: oidc_admins_group

    # Belt-and-braces, same posture as the captcha block above:
    # Config.boot/0 raises on the missing half, but naming the specific
    # var here means the operator tailing the boot sees which one.
    for {var, value} <- [
          {"GRAPPA_OIDC_CLIENT_ID", oidc_client_id},
          {"GRAPPA_OIDC_CLIENT_SECRET", oidc_client_secret},
          {"GRAPPA_OIDC_REDIRECT_URI", oidc_redirect_uri}
        ] do
      if is_nil(value) or value == "" do
        Logger.warning(
          "#{var} is missing/blank while GRAPPA_OIDC_ISSUER is set — Grappa.Auth.Oidc.Config.boot/0 will refuse to start"
        )
      end
    end
  end

  # #543 INC-5 — source-alias platform substrate. Selects the outbound
  # source-binding adapter (`:jail` FreeBSD wrapper / `:linux` AnyIP no-op /
  # `:docker` Disabled). Explicit env, NOT `:os.type` autodetect (a Docker
  # container reports linux yet is not the AnyIP host). Unknown/absent →
  # `:docker` (Disabled → mode 2 refuses to arm), which is the safe default;
  # a non-empty unknown value is surfaced, never silently coerced.
  substrate =
    case System.get_env("GRAPPA_SUBSTRATE") do
      "jail" ->
        :jail

      "linux" ->
        :linux

      "docker" ->
        :docker

      nil ->
        :docker

      "" ->
        :docker

      other ->
        require Logger

        Logger.warning(
          "unknown GRAPPA_SUBSTRATE #{inspect(other)} — source-alias defaulting to :docker (mode 2 disarmed)"
        )

        :docker
    end

  config :grappa, :source_alias, substrate: substrate
end
