import Config

config :grappa,
  ecto_repos: [Grappa.Repo],
  generators: [timestamp_type: :utc_datetime_usec]

# Visitor-auth cluster (Phase 4) defaults. W3 `max_visitors_per_ip` is
# the per-source-IP active-visitor cap, read via `Application.compile_env/2`
# from `Grappa.Visitors.Login` — `config/test.exs` overrides it to 2 for
# the cap-exceeded test path.
#
# #211 phase 3 — the compile-time `:visitor_network` slug pin is REMOVED.
# Which networks accept visitors is now the runtime DB flag
# `networks.visitor_enabled` (admin-togglable without a restart); login
# reads it via `Networks.list_visitor_enabled/0`. No config key backs it.
config :grappa, :max_visitors_per_ip, 5

# PWA icon-badge count source (door #1 dependency-inversion seam, 2026-06-21).
# `Grappa.Push.Triggers` resolves this at runtime via
# `Grappa.Push.BadgeSource.impl/0` instead of referencing the
# implementation statically — a static `Push → BadgeCount` edge would close
# the boundary cycle `Push → BadgeCount → Networks → Session → Push`. Tests
# may override with a stub implementing the `count/1` callback.
config :grappa, :badge_source, Grappa.Push.BadgeCount

# Per-message window_counts push source (#267 dependency-inversion seam).
# `Grappa.Session.Server`'s persist arm resolves this at runtime via
# `Grappa.WindowCounts.PushSource.impl/0` instead of referencing the impl
# statically — a static `Session → WindowCounts.Pusher` edge would close the
# boundary cycle `Session → Pusher → ReadCursor → Networks → Session`. Tests
# may override with a stub implementing the `push/1` callback.
config :grappa, :window_counts_push_source, Grappa.WindowCounts.Pusher

# Cluster visitor-auth hotfix: pre-crash throttle for `Grappa.IRC.Client`'s
# `handle_continue({:connect, _})` failure path. Read at compile-time via
# `Application.compile_env/3`; production default is 30_000 ms (~2 restart
# attempts per minute per session). The original 5_000 ms still autokilled
# under multi-session load (3 sessions × 0.2/s = 0.6/s sustained tripped
# azzurra's connection-rate filter), so 30_000 is the floor for safety
# margin even under cluster-restart cycling. `config/test.exs` shrinks
# this to 50 ms so the C2 init-non-blocking test stays snappy. Phase 5
# replaces with proper exponential backoff + per-session health.
config :grappa, :irc_client_connect_failure_sleep_ms, 30_000

# #100 — `Grappa.IRC.Client` liveness watchdog. Detects half-open
# upstream sockets (mobile radio drop / NAT idle-eviction with no FIN)
# that {:tcp_closed}/{:ssl_closed} can't see and that would otherwise
# hang until the ~2h OS TCP keepalive. After `liveness_idle_ms` of
# INBOUND silence the client self-PINGs; if `liveness_timeout_ms` passes
# with still no inbound, it stops with :ping_timeout → the existing
# link-EXIT → Session.Backoff → :transient respawn chain. ANY inbound
# line resets the cycle, so a healthy-but-quiet connection never
# false-triggers. Defaults sit well below the OS keepalive and above
# normal IRC ping cadence. Tests inject per-client overrides via
# start_link opts (`:liveness_idle_ms` / `:liveness_timeout_ms`), so —
# unlike the connect-failure sleep — config/test.exs deliberately does
# NOT shrink these (the 60s default is inert within any test's lifetime).
config :grappa, :irc_client,
  liveness_idle_ms: 60_000,
  liveness_timeout_ms: 30_000

# `Grappa.Session.Backoff` — per-(subject, network_id) exponential
# backoff curve for IRC reconnect after Session.Server crashes. Layer
# ABOVE the IRC.Client per-attempt throttle: failure count survives
# Session.Server's :transient restart so a k-line bouncing the
# bouncer's IP doesn't loop at restart-rate. See the module doc for
# the full curve table. `config/test.exs` shrinks both values so test
# delays don't drag.
#
# #100: cap lowered 30 min → 5 min. A whole-network outage means every
# session retries at most every 5 min (vs 30) — more reconnect traffic
# during a long outage, but faster recovery when upstream returns
# (matches the interactive-bouncer expectation; vjt accepted the
# outage-noise trade in the #100 decision record). At base 5s × 2^(n-1)
# the cap is reached at n=7 (5·64 = 320s > 300s).
config :grappa, :session_backoff,
  base_ms: 5_000,
  cap_ms: 5 * 60 * 1_000

# #100 — sustained-reconnect reset gate. `Session.Server` clears the
# Backoff ladder (Backoff.record_success) only after the connection has
# survived `connection_stable_ms` past 001 RPL_WELCOME, NOT on 001
# itself. Without the gate, an upstream that welcomes then drops seconds
# later resets the ladder to count=1 every cycle → welcome-then-drop
# flapping re-hammers at the 5s base delay forever. The gate is a
# Process.send_after(:connection_stable) that fires only if the Session
# is still alive (a sub-threshold drop crashes the Session, killing the
# timer with it — the ladder keeps climbing). Opts-overridable
# (`:connection_stable_ms`) as a test seam; config/test.exs leaves the
# 60s default intact (inert within existing tests' lifetimes).
config :grappa, :session, connection_stable_ms: 60_000

# #340 — scrollback persist resilience. `Grappa.Scrollback.with_pool_retry/1`
# rides out a transient SQLite write-lock / pool-saturation burst before it
# degrades a row to `{:error, :persist_unavailable}` (never crashing the
# session — the #336 contract). The retry loop runs on a wall-clock BUDGET,
# not a fixed attempt count, so a NORMAL or bursty message is never dropped:
# only a flood that keeps the pool saturated for the whole budget sheds its
# excess. Read via `Application.compile_env/3` in `Grappa.Scrollback`.
#
#   * persist_retry_budget_ms — total wall-clock the loop will spend riding
#     out transient raises before degrading (1.5s: comfortably longer than
#     the ~1s pool-saturation window the #336 incident measured).
#   * persist_backoff_ms — base per-attempt linear backoff (× attempt).
#   * persist_backoff_cap_ms — ceiling per sleep so late attempts don't
#     stretch a single wait past a fifth of a second.
config :grappa, :scrollback,
  persist_retry_budget_ms: 1_500,
  persist_backoff_ms: 25,
  persist_backoff_cap_ms: 200

# T31 admission control. Defaults match the design (CP11 S20 →
# CP11 S21 brainstorm). All values configurable per-env via
# config/runtime.exs at deployment time.
#
#   * default_max_per_ip_per_network — global per-(source_ip,
#     network_id) clone cap (#171). Operator can override per-network via
#     the networks.max_per_ip column.
#   * captcha_provider — module implementing Grappa.Admission.Captcha
#     behaviour. Disabled = always :ok (test/dev/private deployments).
#     Plan 2 adds Turnstile + HCaptcha modules.
#   * captcha_secret — provider's verify-side secret (env var in prod).
#   * captcha_site_key — provider's public site key (env var in prod;
#     Task 13.A). Read at request time by FallbackController so a
#     runtime.exs change picks up at boot without a recompile.
#   * login_probe_timeout_ms — Visitors.Login outer wait_for_ready
#     budget (U-2 UD7: was the single budget pre-U-2; now the OUTER
#     guard for the assertion path — must be >= connect + welcome +
#     slop or the inner timeouts can't fire before the outer one wins).
#   * login_connect_timeout_ms — inner TCP/TLS-connect budget (3s).
#     Fail-fast on a leaf that can't even establish a socket.
#   * login_welcome_timeout_ms — inner NICK/USER → 001 RPL_WELCOME
#     budget (30s). Accommodates Bahamut rDNS / ident-lookup blocking
#     (5-20s observed) + cluster-propagation latency.
#   * network_circuit_threshold / window_ms / cooldown_ms — see
#     Grappa.Admission.NetworkCircuit moduledoc.
config :grappa, :admission,
  default_max_per_ip_per_network: 1,
  captcha_provider: Grappa.Admission.Captcha.Disabled,
  captcha_secret: nil,
  captcha_site_key: nil,
  login_connect_timeout_ms: 3_000,
  login_welcome_timeout_ms: 30_000,
  login_probe_timeout_ms: 35_000,
  network_circuit_threshold: 5,
  network_circuit_window_ms: 60_000,
  network_circuit_cooldown_ms: 5 * 60_000

# #252 — vhost reverse-DNS (PTR) name cache. `Grappa.Net.PtrCache` caches
# each source address's cloak name for the record TTL (clamped to
# [min, max]); the DNS is the source of truth, nothing is persisted. A
# no-PTR address is negatively cached for `negative_ttl_ms` (stable — not
# every address has a name); a transient resolver error backs off for the
# shorter `error_ttl_ms` before retry. Defaults live here so an operator
# can tune without a code change; `Grappa.Net.PtrCache` reads them via
# `Application.compile_env/3`.
config :grappa, :vhost_ptr_cache,
  min_ttl_ms: 60_000,
  max_ttl_ms: 24 * 60 * 60_000,
  negative_ttl_ms: 60 * 60_000,
  error_ttl_ms: 60_000

# Channel directory (#84) — per-(subject, network) snapshot of an
# upstream IRC LIST. ttl_ms is the freshness window the REST resource
# uses to label a snapshot :fresh vs :stale (48h, matching the sliding
# scrollback horizon). refresh_timeout_ms bounds a single LIST refresh
# before it's declared failed; progress_throttle_ms rate-limits the
# directory_progress pings; ingest_batch is the streamed-322 flush size.
config :grappa, Grappa.ChannelDirectory,
  ttl_ms: 48 * 60 * 60 * 1000,
  refresh_timeout_ms: 60_000,
  progress_throttle_ms: 1_000,
  ingest_batch: 200

# Themes (#75). `image_fetcher` is the fetch-by-URL implementation resolved by
# `Grappa.Themes.BackgroundImage` at runtime; prod uses the real Req+SSRF impl,
# tests inject a Mox mock. `daily_quota` (default 5, read via compile_env in
# Grappa.Themes) is the per-user/day save+copy cap. `image_ssrf_resolver`
# (default `Grappa.Net.Ssrf`, read via compile_env in ImageFetcher.Req) is the
# rebind-safe resolver seam — test.exs swaps in a loopback-permitting resolver
# so Bypass is reachable while private ranges stay blocked.
config :grappa, :themes, image_fetcher: Grappa.Themes.ImageFetcher.Req

config :grappa, Grappa.Repo,
  adapter: Ecto.Adapters.SQLite3,
  database: "runtime/grappa_dev.db"

# Phoenix endpoint compile-time config — actual values set per-env.
config :grappa, GrappaWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: GrappaWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Grappa.PubSub

# Note: `session_signing_salt` is NOT set here. Pre-REV-C it was a
# compile-time read (`System.get_env("SECRET_SIGNING_SALT") ||
# "build-time-placeholder-not-prod-safe"`) baked into the endpoint
# module's `@session_options` attribute. That broke `.env`-rotation +
# auto-deploy semantics — the new value never reached the running
# BEAM until a full image rebuild (review H21). H21 moved the prod
# read to `config/runtime.exs` alongside `SECRET_KEY_BASE`; the dev +
# test values still come from `config/{dev,test}.exs`. The Endpoint
# module reads via `Application.fetch_env!/2` at first-request time
# (cached in `:persistent_term`); see `lib/grappa_web/endpoint.ex`
# for the runtime plug shape.

config :phoenix, :json_library, Jason

# Phoenix.Logger redacts these keys from the params it logs on every
# request + every Channels socket connect. Since #95 the WS bearer rides
# the `Sec-WebSocket-Protocol` subprotocol (and #202 dropped the legacy
# `?token=` query-string fallback), so it no longer appears in the
# logged connect params — but keeping `"token"` filtered is cheap
# defense-in-depth (any REST body / future param named `token`), and
# `"password"` still redacts the `/oper` + auth request bodies. Bearer is
# the entire identity in this design; anything that lands in stdout
# persists across container restarts and ships out with any log
# forwarder. Per CLAUDE.md Security: "credentials … never logged."
config :phoenix, :filter_parameters, ["password", "token"]

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [
    # Identity / location: who, where in the IRC topology, what HTTP request.
    :request_id,
    :user,
    :network,
    :channel,
    # Structured debug context: command being processed, error reason,
    # raw bytes that triggered a parse failure, supervision-tree pid,
    # inspect/1 of an unexpected mailbox message that hit a catch-all.
    :command,
    :reason,
    :raw,
    :error,
    :pid,
    :unexpected,
    # Bootstrap summary: how many credentials we enumerated and how
    # many session starts were freshly spawned, skipped (admission
    # cap-tripped or already-running idempotent NO-OP), or failed
    # (M-life-4 tri-counter — see Grappa.Bootstrap moduledoc).
    # `:visitors` is the parallel count for the visitor-respawn pass.
    # U-2 honest-log split (`feedback_log_honesty`): the legacy
    # `:spawned` + `:failed` + `:skipped` triplet expands into a
    # five-bucket honest set so the operator dashboard separates
    # idempotent restart (`already_running`) from capacity-policy
    # rejection (`capacity_rejected`) from upstream failure
    # (`network_failed`) from config-shape failure (`plan_failed`).
    :credentials,
    :visitors,
    :spawned,
    :skipped,
    :failed,
    :already_running,
    :capacity_rejected,
    :network_failed,
    :plan_failed,
    :subject_row_gone,
    # Per-IRC-event context: who/what an event refers to (KICK target,
    # NICK_CHANGE new-nick, MODE arg, etc. — mirrors the Meta.@known_keys
    # allowlist so the same shape that hits the DB also hits the log line.
    # Drift caught at test time by Grappa.Scrollback.MetaTest "known_keys
    # ↔ Logger metadata allowlist").
    :sender,
    :target,
    :new_nick,
    :modes,
    :args,
    # #25: sender's channel-grade glyph (@/%/+) snapshotted onto content
    # rows at persist time so a later MODE change can't retroactively
    # re-prefix them. In the allowlist to satisfy the known_keys↔metadata
    # sync test even though no Logger call carries it today.
    :sender_prefix,
    # Auth context (Phase 2): bearer-token session lifecycle. `session_ref`
    # is a non-reversible SHA-256 handle of the session-id (S9: the raw id
    # IS the bearer token, so it must NEVER hit the log stream) — it rides
    # the revoke + backward-clock lines to correlate a session without
    # leaking a usable credential. `affected` rides the revoke audit log
    # so a typo'd-id revoke is greppable. `socket_id` rides the
    # logout-side `Endpoint.broadcast(socket_id, "disconnect")` path so an
    # operator grep can correlate a logout with the WS lifecycle line that
    # picked up the disconnect.
    :session_ref,
    :affected,
    :authn_failure,
    :socket_id,
    # Client IP, post-RemoteIp plug rewrite (so what you see is the
    # real client, not the docker-bridge nginx IP). Useful for grep-
    # correlating an authn failure or captcha rejection back to the
    # originating address.
    :remote_ip,
    # Visitor identity (Phase 4 — Task 15): visitor_id rides the
    # +r-observed → commit_password log lines so operator can grep
    # the visitor lifecycle across login + first-IDENTIFY.
    :visitor_id,
    # User identity: `user_id` rides the `revoke_sessions_for_user/1`
    # audit line (admin password rotation, S8) — sibling of
    # `visitor_id` on `revoke_sessions_for_visitor/1`.
    :user_id,
    # IRC client (Phase 2 sub-task 2f): SASL handshake numerics
    # (904 / 905 failures, etc.) ride this key so operator log search
    # can grep "sasl" + numeric in a single pass. `:sasl_user` is the
    # SASL identity the failed exchange used (NOT the password — the
    # struct redacts that). `:nick` rides nick-rejection (432/433)
    # log lines to surface the rejected nick directly.
    :numeric,
    :sasl_user,
    :nick,
    # UX-6-B1 (2026-05-20): embedded image uploader reaper failure
    # log lines carry the upload row id + slug so operator can grep
    # per-upload across the reaper + GET surface.
    :upload_id,
    :slug,
    # UX-6-B2 (2026-05-21): admin PUT /settings unknown-key warn line
    # carries the offending key so an admin typo (`globalcap_bytes`)
    # surfaces in the log without dumping the whole body.
    :setting_key,
    # Numeric severity (CP13 server-window cluster): :ok for 1xx/2xx/3xx,
    # :error for 4xx/5xx — rides the :notice persist for routed numerics
    # so log lines are color-greppable. Mirrors Scrollback.Meta.@known_keys
    # (A18 sync rule — meta_test.exs catches drift).
    :severity,
    # CP22 cluster B (channel-client-polish #14) — /who pipeline meta keys.
    # `:who` carries the structured 352 RPL_WHOREPLY payload {nick, modes,
    # user, host, server, hops, realname}; `:who_target` rides the 315 EOF
    # row so log greps can correlate the bundle's start/end without
    # re-parsing the body. Mirrors Scrollback.Meta.@known_keys (A18 sync).
    :who,
    :who_target,
    # CP22 cluster B (channel-client-polish #14) — /names pipeline meta keys.
    # `:names` carries the full `[prefix]nick` token list from a 353
    # RPL_NAMREPLY drained on 366 RPL_ENDOFNAMES; `:names_target` rides
    # both the nick-list row and the EOF terminator so log greps can
    # correlate them. Mirrors Scrollback.Meta.@known_keys (A18 sync).
    :names,
    :names_target,
    # No-silent-drops B6.1 (HIGH-6): EventRouter catch-all persists
    # unknown command verbs as `:notice` rows on $server with FLAT
    # atom-keyed meta — `raw_verb` (string), `raw_sender` (string |
    # nil), `raw_params` ([string]). The pre-B6.1 nested shape
    # (`meta.raw = %{"verb" => ...}`) bypassed both the Meta @known_keys
    # allowlist and this Logger metadata sync. Mirrors
    # Scrollback.Meta.@known_keys (A18 sync; meta_test.exs catches
    # drift).
    :raw_verb,
    :raw_sender,
    :raw_params,
    # Presence-event (join/part/quit) sender user@host — rides the
    # persist meta so cic renders the irssi-style "nick [user@host] has
    # joined/left/quit" line. Parsed from the IRC prefix; both keys
    # present or neither (no half-populated mask). Mirrors
    # Scrollback.Meta.@known_keys (A18 sync; meta_test.exs catches drift).
    :sender_user,
    :sender_host,
    # Nick-mutation tracing (C6 / S13): on RPL_WELCOME reconcile and
    # self-NICK rename, log lines pair `from: old-nick, to: new-nick`
    # so the operator can grep the lifecycle of a nick across a
    # session — the Scrollback rows preserve the moment-of-write
    # nick, but the upstream-driven mutations only land in the log.
    :from,
    :to,
    # Session.Backoff context — observability for the exponential
    # delay applied before a Client respawn. `delay_ms` is the chosen
    # wait window; `failure_count` is the consecutive-failure depth
    # the curve fed off.
    :delay_ms,
    :failure_count,
    # T31 admission — rides admission rejection / circuit transition log
    # lines so operator can grep cap-exceeded events.
    :cap_kind,
    :cap_value,
    :cap_observed,
    :circuit_state,
    :retry_after_seconds,
    # IRC outbound verb (cluster #10 S10): identifies which
    # `Grappa.IRC.Client.send_*` helper rejected an invalid_line at
    # the byte boundary so silent rejections are greppable.
    :verb,
    # Push notifications cluster B2 (2026-05-14) — Push.Sender log
    # keys. `:endpoint` is the vendor push URL (greppable across the
    # send / 410-Gone / dead-endpoint-deleted lifecycle); `:status`
    # is the HTTP status from non-2xx-non-410 vendor responses; `:count`
    # is the deleted-row count from `Push.delete_dead/1`. Mirrors the
    # B6.1 Logger-allowlist sync rule.
    :endpoint,
    :status,
    :count,
    # M-11 admin-events: `:topic` is the PubSub topic that failed (string,
    # e.g. `"grappa:admin:events"`); `:kind` is the typed event-kind atom
    # (`:visitor_deleted`, `:circuit_reset`, etc.) that was about to be
    # broadcast. Surfaces silent-drop class per CLAUDE.md "Log honesty"
    # when AdminEvents fails to fan out to admin sockets.
    :topic,
    :kind,
    # U-5 admin live cap counters (S7 defense-in-depth): the sink-side
    # boundary guard in `Grappa.AdminEvents.handle_cast/2` on the
    # `[:grappa, :session, :lifecycle, _]` clause logs the dropped
    # event's `:subject_kind` (atom inspect — `:user | :visitor` is
    # expected; anything else is a future-shape drop worth investigating)
    # and `:network_id` (integer inspect). Drop is intentionally loud
    # per CLAUDE.md "Don't bake silent fallbacks" — operator log search
    # surfaces unknown shapes before they become production bugs.
    :subject_kind,
    :network_id,
    # #100 liveness watchdog — `Grappa.IRC.Client`'s :liveness_timeout
    # warning logs the configured idle + reply-window budgets so the
    # operator can grep half-open-socket disconnects and confirm the
    # thresholds that tripped. Mirrors the B6.1 Logger-allowlist sync rule.
    :liveness_idle_ms,
    :liveness_timeout_ms,
    # #215 structured session-lifecycle log — `Grappa.SessionLog.emit/3`
    # rides these on the connect / register / +r / disconnect / backoff
    # lines. `:session_id` is the greppable composite
    # `<kind>:<uuid>:<network_id>` (NOT the auth bearer id — that is a
    # secret, see `:session_ref`). `:event` is the closed lifecycle atom
    # (`:connected | :disconnected | …`). `:duration_ms` + `:clean` ride the
    # disconnect line so a 2am grep for a nick surfaces WHY + how long it
    # lasted + whether it was a graceful vs error drop. `:nick`, `:reason`,
    # `:delay_ms`, `:failure_count` pre-exist and are reused.
    :session_id,
    :event,
    :duration_ms,
    :clean
  ]

import_config "#{config_env()}.exs"
