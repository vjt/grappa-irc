# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

**Phase 2 + Phase 3 walking skeleton LIVE; CP10 review-fix campaign
correctness clusters CLOSED.** Bouncer + cicchetto PWA live at
`http://grappa.bad.ass` (192.168.53.11 → nginx → grappa:4000). iPhone
install + login + scrollback + send round-trip operator-verified
2026-04-27 (CP09 S3). CP10 codebase review (2026-04-27) → eight
clusters closed: C1 (vite-plugin-pwa SW), C2 (init/1 →
handle_continue), C3 (MessageKind widen + exhaustive switch), C4
(post-Phase-2 hygiene close-out), C5 (security correctness — S14
probing-oracle plug + S18 socket token-rotation reconnect), C6
(IRC-state correctness — S5 + S6 + S7 + S13), C7 (channel-lifecycle
correctness — collapsed to A1 cicchetto identity-scoped state
cleanup; S17 verified resolved upstream), C8 (omnibus housekeeping —
S29 dead key + LOW catalogue sweep + this todo sweep).

**D1/A2 CLOSED 2026-04-27 (CP10 S12).** Networks god-context split
into Networks (slug CRUD) + Networks.Servers + Networks.Credentials +
Networks.SessionPlan; verb-keyed sub-modules under one Boundary
umbrella; production verified.

**D2/A3 CLOSED 2026-04-27 (CP10 S13).** IRC.Client god-module split
into Client (transport + line dispatch + send_* helpers, 334 lines)
+ AuthFSM (pure CAP/SASL/PASS state machine, 343 lines). Pure-FSM
extraction shape — `step(state, msg) :: {:cont|:stop, state,
[iodata]}`, host GenServer does I/O — second application of the
verb-keyed sub-context principle (DESIGN_NOTES corollary entry).
Production verified at `http://grappa.bad.ass`.

**Next — D3 architectural HIGH (pre-Phase-4, ~half-session):**
- D3 / A4 cicchetto/lib/networks.ts god-module split (9 concerns).
  Same verb-keyed pattern; client-side mirror of A2. Bumps bundle
  hash → browser-shell verify required after deploy.

After D3: Phase 4 brainstorm (irssi-shape UI) on clean modules.

**Phase 4 brainstorm (after D1):** irssi-shape UI redesign. Per
`superpowers:brainstorming` skill — run a brainstorm BEFORE any
creative work to align on scope + non-goals + visual model.
- Keyboard-first layout (Ctrl-N / Ctrl-P / Alt-1..9 channel switching).
- Theme system (single global theme, irssi-shape colour palette).
- Nick list + mode indicators + topic bar + presence per channel.
- Mobile ergonomics (tap targets, swipe-to-switch, full-screen compose).
- Voice I/O optional drop-in (Vosk/piper, ≤200 KB gzip ex-model).
See README "Roadmap" + DESIGN_NOTES "Mobile is an ergonomics layer
on irssi-shape, not a different shape."

**D-cluster triage backlog (test-suite flakes surfaced during the
correctness campaign — defer to a dedicated investigation pass, not
fixed in C8):**
- `Grappa.BootstrapTest:80` — `on_exit` hits
  `GenServer.call(Grappa.SessionSupervisor, …, :infinity)` with
  `{:EXIT, no process: …}` because `SessionSupervisor` exhausted
  `max_restarts: 3` in <100ms during parallel async tests crashing
  sessions. Same shape as the C2 cluster's "test-side discipline"
  warning (C7 S17 verification reproduced ~1-in-15 under
  suite parallelism). Investigation route: widen
  `SessionSupervisor.max_restarts` for the test environment, OR
  add a per-test session-spawn isolation flag.
- `Grappa.Networks.WireTest` — `network_to_json/1` and
  `credential_to_json/1` Jason-encodable tests fail intermittently
  on sqlite "Database busy" during setup under `max_cases: 2`
  write-heavy parallelism. Documented since CP08 carryover; the
  C7 verification re-confirmed it's still live.
- `Grappa.AccountsTest:20` — `create_user/1 rejects a duplicate
  name` — likely also sqlite contention. Same investigation
  shape as WireTest (sqlite WAL-mode in test, sandbox shared-mode
  review).
- All three are pre-existing test-infra issues. Fix campaign for them
  is its own cluster (D-cluster naming) sized larger than housekeeping.

## High

- (S17 channel-test flake RESOLVED-UPSTREAM in C7 verification —
  15 consecutive runs zero failures; the C2 cluster's stop_session
  race fix almost certainly closed it.)

- Phase 5 hardening: Session.Server should `terminate/2` cleanly —
  send QUIT to upstream + close socket. Currently :normal exit kills
  IRC.Client via link, which silently dies; OK for prod but emits
  ugly `tcp_closed terminating` test-stdout noise.
- Phase 5 hardening: TLS `verify: :verify_none` posture (`lib/grappa/irc/client.ex`)
  → CA chain verification with proper bundle. Document operator's
  TLS-trust-store config strategy. Independent of Phase 2 auth work.
- Phase 5 hardening (NEW from S20 Phase 2 plan): post-registration
  `+r` umode check on Session connect. If after `001 RPL_WELCOME`
  the client did NOT receive `+r` (or equivalent network-specific
  registered-user umode), fall back to explicit `PRIVMSG NickServ
  :IDENTIFY <pwd>` retry. Catches PASS-not-bound-to-services edge
  cases and lost-PASS races where `auth_method='auto'` chose the
  PASS path but the network silently didn't forward it.
- Phase 5 hardening (NEW from S20 Phase 2 plan): NickServ NOTICE
  reply parsing (success/failure detection per network
  Anope/Atheme/etc), nick-collision recovery (GHOST/RECOVER dance
  when our nick is already in use). Shared correlation machinery
  with NickServ REGISTER proxy below.
- Phase 5 hardening (NEW from S20 Phase 2 plan): NickServ REGISTER
  proxy as REST endpoint. Async request → wait for NickServ NOTICE
  reply → translate to HTTP response. Same correlation machinery as
  reply parsing above. Phase 2 manual workaround: operator runs
  `/msg NickServ REGISTER pass email` from any IRC client once,
  captures resulting password, drops into grappa via `mix
  grappa.bind_network`.
- Phase 5 hardening (NEW from S20 Phase 2 plan): multi-server
  failover logic. Phase 2 schema includes `network_servers` (irssi
  shape: priority + enabled), but Phase 2 logic only uses first.
  Phase 5 adds: try server 0 → on connect fail try server 1 → ...
  → exponential backoff → reset on success.
- Phase 5 hardening (NEW from S20 Phase 2 plan): HSM-keyed
  Cloak.Vault. Operator escape from "env on disk" key storage.
  Cloak.Vault supports custom key sources (yubico-hsm, TPM, AWS
  KMS, etc.) — configurable swap, no code change in Grappa.
  Document operator's hardening path in README.
- Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER C1):
  service worker requires a "secure context" (HTTPS or localhost).
  `http://grappa.bad.ass` is neither — iOS Safari silently fails SW
  registration; the catch in `cicchetto/src/main.tsx:44` logs to
  console. Add-to-Home-Screen still works (manifest-driven), but the
  offline shell cache won't function until Phase 5 TLS rollout. Be
  honest about this in the operator runbook.
- Phase 5 hardening (NEW from S22 Phase 3 review BONUS, B2 followup):
  move bearer token off the WS query string. Currently rides
  `?token=…` on the upgrade URL because Phoenix.Socket transports
  `params` as a query string. Phase 3 fix redacts via Phoenix
  `:filter_parameters` + nginx `access_log off` on `/socket`, but the
  bearer is still visible to anyone who can see the URL pre-redaction
  (browser devtools, on-path observers, BURP-like proxies during
  pen-test). Move to either `Sec-WebSocket-Protocol` or a post-connect
  `phx_join` payload — needs a phoenix.js + UserSocket protocol
  change, bigger than walking-skeleton scope.
- Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER C5):
  `loadMore` in `cicchetto/src/lib/networks.ts` has no concurrency
  guard. A scroll-up that fires `loadMore` twice before the first
  response lands sends two REST requests with the same `before=`
  cursor. Dedupe-by-id keeps the result correct, but it's wasteful.
  A per-key in-flight Set + early-return on hit is a few lines.
- Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER C6): no
  accessibility pass yet. Buttons are buttons + ARIA `role="alert"`
  on errors is reasonable baseline, but the channel sidebar uses
  raw `<ul><li><button>` with no tree semantics — on iOS VoiceOver
  the network → channel hierarchy doesn't read as a tree. Phase 5
  accessibility audit covers this + tap-target sizing + focus-state
  contrast (web.dev a11y guidelines).
- Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER C4 — also
  closed by 8a but worth a tracking item): when adding new WS
  subprotocols or alternate Channel transports, inherit the
  `check_origin` allowlist; if a future feature needs a different
  host, it lands as a separate Phoenix.Endpoint, not as a relaxation
  in `runtime.exs`.

## Medium

- Set up GitHub repo `vjt/grappa-irc` with CI secrets (codecov token if
  desired, no other secrets required for Phase 1).
- Decide PWA framework (Svelte vs SolidJS vs lit-html) — Phase 3 prep.
  Bundle-size budget ≤200 KB gzip before optional Vosk/piper.
- Open a tracking issue or doc for Phase 6 IRCv3 listener — collect
  IRCv3 specs we'll need (`CAP LS 302`, `CHATHISTORY`, `server-time`,
  `batch`, `labeled-response`, SASL mechanisms). Reuse parser from
  Phase 1.
- Supply-chain hardening (NEW from S22 Phase 3 review CONSIDER C2):
  `oven/bun:1` and `nginx:alpine` (used by `scripts/bun.sh` and
  `compose.prod.yaml`) are moving major tags. Pin to digests
  (`oven/bun:1@sha256:…`) for reproducible builds. CLAUDE.md
  doesn't currently mandate this — log here for the next time supply-
  chain hygiene comes up across the repo.

## Low / Observation

- Investigate `mix release` size on Debian-slim runtime image. If it's
  obnoxiously big, evaluate Alpine + musl rebuild of `ecto_sqlite3`
  NIFs.
- `Grappa.version/0` (`lib/grappa.ex:28`) has zero callers. Either
  wire it into `/healthz` JSON response (one-line change in
  `HealthController`) or drop the function. Surfaced by S19 Task 10
  code review as L4. Empty `Grappa` boundary annotation is
  independently justified.
- Sqlite "Database busy" intermittent test flake — hit once during S19
  ci.check on a re-run. 3 tests (`Repo` / `Scrollback` / `Wire`)
  simultaneously failed inserts with `Exqlite.Error: Database busy`.
  Likely contention between `async: true` Repo writes and the live Pi
  container also writing to `runtime/grappa_dev.db`. Distinct from the
  channel test flake at `grappa_channel_test.exs:76`.
- Telemetry → Prometheus exporter (PromEx). Phase 5 hardening.
- Reconnect/backoff policy when upstream IRC drops. Phase 5.
- Scrollback eviction policy — by row count, by age, or both. Phase 5.
- Perf nit (NEW from S22 Phase 3 review CONSIDER C3): nginx upstream
  `keepalive 32` in `infra/nginx.conf` is dead weight without
  `proxy_set_header Connection "";` on the API allowlist `location`
  block. Without clearing the Connection header on the upstream side,
  nginx forwards the client's `Connection: close` and the keepalive
  pool never warms. Pure perf — measurable only under sustained load,
  which Phase 3 doesn't have.

---

## Notes

- Phase 0 (spec) is complete. README + DESIGN_NOTES + walking-skeleton
  plan all in main.
- Phase 1 tasks all have TDD steps with failing-test-first discipline
  in `docs/plans/2026-04-25-walking-skeleton.md`.
- The Italian Hackers' Embassy / Azzurra context is the longer story.
  See `docs/project-story.md` for the narrative thread that survives
  individual sessions.
