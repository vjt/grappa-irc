import Config

config :grappa,
  ecto_repos: [Grappa.Repo],
  generators: [timestamp_type: :utc_datetime_usec]

# Visitor-auth cluster (Phase 4) defaults. `visitor_network` is the
# slug of the upstream IRC network anonymous visitors land on; W3
# `max_visitors_per_ip` is the per-source-IP active-visitor cap. Both
# are read via `Application.compile_env/2` from `Grappa.Visitors.Login`
# and `Grappa.Visitors.Reaper` (Task 22), so they MUST be defined at
# every compile env — `config/test.exs` overrides
# `max_visitors_per_ip` to 2 for the cap-exceeded test path. A `nil`
# `@visitor_network` at compile time narrows `Login.login/2`'s success
# typing to only `:network_unconfigured`, cascading "pattern can never
# match" warnings across `auth_controller.ex`'s error mapper.
config :grappa, :visitor_network, "azzurra"
config :grappa, :max_visitors_per_ip, 5

# PWA icon-badge count source (door #1 dependency-inversion seam, 2026-06-21).
# `Grappa.Push.Triggers` resolves this at runtime via
# `Grappa.Push.BadgeSource.impl/0` instead of referencing the
# implementation statically — a static `Push → BadgeCount` edge would close
# the boundary cycle `Push → BadgeCount → Networks → Session → Push`. Tests
# may override with a stub implementing the `count/1` callback.
config :grappa, :badge_source, Grappa.Push.BadgeCount

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

# `Grappa.Session.Backoff` — per-(subject, network_id) exponential
# backoff curve for IRC reconnect after Session.Server crashes. Layer
# ABOVE the IRC.Client per-attempt throttle: failure count survives
# Session.Server's :transient restart so a k-line bouncing the
# bouncer's IP doesn't loop at restart-rate. See the module doc for
# the full curve table. `config/test.exs` shrinks both values so test
# delays don't drag.
config :grappa, :session_backoff,
  base_ms: 5_000,
  cap_ms: 30 * 60 * 1_000

# T31 admission control. Defaults match the design (CP11 S20 →
# CP11 S21 brainstorm). All values configurable per-env via
# config/runtime.exs at deployment time.
#
#   * default_max_per_client_per_network — global per-(client_id,
#     network_id) cap. Operator can override per-network via the
#     networks.max_per_client column.
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
  default_max_per_client_per_network: 1,
  captcha_provider: Grappa.Admission.Captcha.Disabled,
  captcha_secret: nil,
  captcha_site_key: nil,
  login_connect_timeout_ms: 3_000,
  login_welcome_timeout_ms: 30_000,
  login_probe_timeout_ms: 35_000,
  network_circuit_threshold: 5,
  network_circuit_window_ms: 60_000,
  network_circuit_cooldown_ms: 5 * 60_000

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
# request + every Channels socket connect. The bearer token rides
# `?token=…` on the WS upgrade URL because Phoenix.Socket transports
# params as a query string — without this filter, the `[info] CONNECTED
# TO …` line prints the bearer verbatim. Bearer is the entire identity
# in this design; anything that lands in stdout persists across container
# restarts and ships out with any log forwarder. Per CLAUDE.md Security:
# "credentials … never logged."
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
    # Auth context (Phase 2): bearer-token session lifecycle. `session_id`
    # rides every authn-plug failure and revoke; `affected` rides the
    # revoke audit log so a typo'd-id revoke is greppable. `socket_id`
    # rides the logout-side `Endpoint.broadcast(socket_id, "disconnect")`
    # path (auth_controller.ex broadcast_disconnect/1) so an operator
    # grep can correlate a logout with the WS lifecycle line that picked
    # up the disconnect.
    :session_id,
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
    :network_id
  ]

import_config "#{config_env()}.exs"
