import Config

# #1770 — shorten the incognito fast-close grace for the dev stack, which is
# also the stack `scripts/integration.sh` boots (`MIX_ENV: dev` in
# `cicchetto/e2e/compose.yaml`). Production's 30s is chosen so a RELOAD gets to
# land its replacement socket before the wipe; an e2e that closes a page and
# asserts the row is gone would otherwise idle out the whole window inside
# Playwright's 30s per-test default.
#
# The divergence is deliberate and it is named here rather than hidden behind
# an env var: dev is where you WANT the behaviour to be observable inside one
# attention span. A developer debugging the reload-protection window itself
# must read `Grappa.Visitors.Reaper`'s `@default_incognito_grace_ms`, which is
# the production number and the single source of it.
config :grappa, :incognito_close_grace_ms, 2_000

config :grappa, Grappa.Repo,
  database: Path.expand("../runtime/grappa_dev.db", __DIR__),
  # #1759c — a MEASUREMENT LEVER, not a behaviour change and not a cure.
  #
  # `config/runtime.exs:187` already reads `POOL_SIZE` this way, but that
  # block is gated on `config_env() == :prod` (`:137`), and the e2e stack
  # runs `MIX_ENV: dev` (`cicchetto/e2e/compose.yaml:61`). So the pool the
  # e2e suite exercises was a literal `5` that nothing could move — and a
  # question of the form "at what N does a `pool_size: 10` pool saturate?"
  # could only have been answered at HALF the production pool and then
  # extrapolated, which is the one move the investigation is not allowed.
  #
  # The default is `5`, and the lever is still the point: it buys the
  # ability to take the SAME reading at two pool sizes, which is what
  # tells "the mechanism is the pool" apart from "the hypothesis is dead".
  #
  # 🔴 What has CHANGED since #1759c wrote the paragraph above: prod no
  # longer runs `10`, it runs this same `5` (see `config/runtime.exs` for
  # the dirty-IO reserve argument). So the "HALF the production pool"
  # objection no longer applies — the e2e stack now exercises the
  # production pool size, not half of it. Read that paragraph as history.
  pool_size: String.to_integer(System.get_env("POOL_SIZE") || "5"),
  # Mirror prod's contention ladder — the WHOLE ladder, not one rung of
  # it — so iex sessions, integration scripts and the e2e stack (which
  # runs `MIX_ENV: dev`) hit the timings prod hits. See the long comment
  # in `config/runtime.exs`: the four numbers only make sense together,
  # and mirroring `busy_timeout` alone is how dev came to sit at 30_000
  # against an inherited 50ms queue target.
  busy_timeout: 300,
  timeout: 15_000,
  queue_target: 1_500,
  queue_interval: 5_000,
  # REV-B / C3 (2026-05-22 codebase review): pin PRAGMAs in lockstep
  # with config/runtime.exs and config/test.exs. See runtime.exs for
  # the full rationale — dep major-version default flip would silently
  # subvert WAL durability or CASCADE FK invariants without a diff.
  synchronous: :normal,
  foreign_keys: :on,
  show_sensitive_data_on_connection_error: true

# UX-6-B1 (2026-05-20): embedded image uploader storage dir. Sibling
# of the sqlite DB under `runtime/` so the existing host bind-mount
# covers both.
config :grappa, :uploads_storage_root, Path.expand("../runtime/uploads_dev", __DIR__)

# M3b — cached peer CTCP AVATAR images. Sibling dir, same runtime/ bind-mount.
config :grappa, :peer_avatars_storage_root, Path.expand("../runtime/peer_avatars_dev", __DIR__)

# issue 2089 — the DCC RECEIVE spool. Third sibling of the two above, same
# runtime/ bind-mount, and it exists for the same reason they do:
# `config/runtime.exs` derives this root INSIDE `if config_env() == :prod`,
# so under :dev nothing sets it and `Application.fetch_env!/2` in
# `Grappa.Application.start/2` raises before a single child starts. That
# kills the e2e harness (grappa-test runs MIX_ENV=dev) and the local docker
# stack alike.
#
# Deliberately NOT the `:cic_dist_root` cure, which was hoisted OUT of the
# prod block instead. That one is CODE: the built SPA is mounted at a path
# only the container knows, so the READ of `CIC_DIST_ROOT` has to happen in
# dev, and `config/config.exs` already supplies an absolute default for the
# hoist's no-clobber arm to leave standing. This is DATA grappa creates
# itself — an empty spool it owns — so there is nothing to discover from
# the environment and no default to preserve; the env var stays prod-only
# exactly as `UPLOADS_STORAGE_ROOT` and the avatar root already are, and
# the two lines above are the pattern this one restores.
config :grappa, :dcc_storage_root, Path.expand("../runtime/dcc_dev", __DIR__)

config :grappa, GrappaWeb.Endpoint,
  http: [ip: {0, 0, 0, 0}, port: 4000],
  check_origin: false,
  debug_errors: true,
  code_reloader: true,
  watchers: [],
  secret_key_base: "dev-secret-key-base-replace-me-in-prod-12345678901234567890123456789012",
  # codebase audit web W10 + cross-infra L7 — was hardcoded "rotate-me"
  # in lib/grappa_web/endpoint.ex; now config-driven so prod env can
  # set it without a recompile (see runtime.exs).
  session_signing_salt: "dev-signing-salt-not-secret-known-to-the-repo"

config :grappa, dev_routes: true

# #171 — per-(source-IP, network) clone cap headroom for dev + e2e.
# Production stays at config.exs's default of 1 (this key deep-merges
# over the base :admission block). The serial Playwright suite drives
# every browser login through ONE shared source IP (the e2e nginx) and
# every direct API login through another (the runner) — many DISTINCT
# seeded subjects per IP. At the production default of 1, user
# `/connect` and visitor logins from the 2nd subject on a shared IP
# would 503 `too_many_sessions`, cascading unrelated specs. 10 matches
# the seeded bahamut-test user-session ceiling, so the per-IP cap is
# never tighter than the network total in e2e. Networks that need a
# tight cap set `max_per_ip` explicitly (the #171 spec); azzurra seeds
# 100 for anon-visitor volume.
config :grappa, :admission, default_max_per_ip_per_network: 10

# #340 — send-throttle headroom for dev + e2e. Production stays at
# config.exs's default (capacity 5, 0.5/s). cic splits a multi-line compose
# into ONE PRIVMSG POST per line, so an e2e that seeds history with a
# 12-line body (e.g. issue173's LONG_BODY) fires a 12-POST burst that the
# production capacity would 429 mid-seed — leaving text in the box and
# cascading unrelated compose/caret specs. The e2e is not the throttle's
# test surface (the 429 wire contract is proven deterministically in
# GrappaWeb.MessagesControllerOutboundTest); dev/e2e drive real users, not
# a flood, so the throttle is effectively off here. Mirror of the
# :admission relaxation above.
# #480 — the oper pair rides the same relaxation. Left at the production
# numbers it would be TIGHTER than the ordinary one here, so an oper'd dev
# session would get less headroom than a plain one: the mirror inverted.
config :grappa, :send_throttle,
  capacity: 1_000,
  refill_per_sec: 1_000,
  oper_capacity: 1_000,
  oper_refill_per_sec: 1_000

# GH #630 — coarse per-subject request budget (see config.exs). Dev/e2e
# headroom is set HIGH enough that a normal user (and every non-flood e2e
# spec's login/seed/compose fan-out) stays comfortably under it, but a
# DELIBERATE flood — the #630 e2e fires hundreds of frames as fast as JS
# can — blows through `capacity` and then past `sever_after` over-budget
# events, exercising the full throttle→429→sever ladder end-to-end. Unlike
# `:send_throttle` (off in dev because the flood ladder isn't its surface),
# #630's e2e IS the acceptance gate, so the budget stays ARMED here — just
# with a burst ceiling no honest interaction reaches.
config :grappa, :request_budget,
  capacity: 200,
  refill_per_sec: 20.0,
  sever_after: 30,
  sever_window_ms: 10_000

# Cloak vault key — non-secret, dev-only. Anyone with the repo has it;
# the dev sqlite file is gitignored. Prod reads from GRAPPA_ENCRYPTION_KEY
# env var (see config/runtime.exs).
config :grappa, Grappa.Vault,
  ciphers: [
    default:
      {Cloak.Ciphers.AES.GCM,
       tag: "AES.GCM.V1", key: Base.decode64!("zHwj0qQ8nqXvDIcSIGlqjOIMtQ8aPnSNqSc8MVhQbkY="), iv_length: 12}
  ]

config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime

# #671 — auto-away debounce, SHORT for the integration env only. The
# cicchetto/e2e stack boots grappa-test under MIX_ENV=dev, so this is
# how "the integration env sets it short" (Session.Server.boot/0 reads
# it into :persistent_term; start_session/3 injects it). Production
# (MIX_ENV=prod) sets no key and keeps the byte-identical 600_000 default.
# The auto-away-on-disconnect e2e drops the client's visibility
# heartbeats, waits out stale_ms (unchanged 60s — foreground push
# suppression must stay fresh), drops the socket, and asserts a peer
# observes AWAY after THIS window — so it must be short but non-zero.
config :grappa, Grappa.Session.Server, auto_away_debounce_ms: 2_000

# Push notifications cluster B5 (2026-05-14) — fixed VAPID keypair
# for dev/e2e. The integration harness (cicchetto/e2e/compose.yaml)
# boots grappa-test under MIX_ENV=dev; without this, Application.
# fetch_env!(:ex_nudge, :vapid_public_key) crashes the
# PushVapidController and any e2e push-trigger spec. Mirrors
# config/test.exs's keypair byte-for-byte so the dev + test surfaces
# share the same fixture (rotating either MUST update the other —
# both are non-secret + dev/test-only). Real ECDSA P-256 pair (NOT
# random bytes — JOSE.JWS rejects malformed keys at sign time, which
# would mask trigger failures behind misleading sign errors).
config :ex_nudge,
  vapid_public_key: "BH4P62bQOEfkSsfjpCyBWnz88Nnlyn2mtwapDEXWswb1cwR9YDE-3E-aBjNhwY2e3ErL410rgSNUBD7nQyPXGSY",
  vapid_private_key: "MIC0fm1A_ZcPF0P3ffUizcNUYwMyU-AklNw2e4aPXGw",
  vapid_subject: "mailto:dev@example.org"
