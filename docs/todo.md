# Todo

The pending-work backlog. **Only what's TODO. Done work lives in the
active checkpoint, not here.** No archives, no LANDED blocks, no
"closed" observations. If you find any in this file, delete on sight.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

**E2E-ROBUSTNESS cluster** — chromium suite pollution audit (filed
2026-05-25 post-BUGHUNT-3). Goals: (a) make integration suite
reliable (zero rotating-victim flakes across N runs); (b) speed it
up (current ~10min per project, single-shot iso ~7s × N = ouch).

**Evidence**: this session 5× iso m2 main = 5/5 ✓, but full chromium
2 runs in a row produced rotating 3-4 victim shapes:
- run 1: m2:51, scroll-225, ux-5-bs:88 (3 ✘)
- run 2: cp15-b6:32, m2:51, scroll-225, ux-5-bs:88 (4 ✘)

All 3 of (m2, scroll-225, ux-5-bs:88) pass clean in iso 3-5× on
post-D `515920d`. Same as pre-D iso pass-rate (varies). Pattern matches
`feedback_ci_cascade_rotating_set` + `feedback_recurring_e2e_not_flake`:
rotating victims across the same UI surface = upstream state
pollution, NOT product regression.

**Buckets** (preliminary, scoped at cluster open):
- **A (audit)**: catalog WHICH specs run in chromium lex order ≪ each
  victim. Lex-position pairs (poisoner→victim). Tooling for
  reproducible bisect (single-spec iso vs paired iso). 1-day spike.
- **B (localStorage)**: ux-5-bs:88 victim of ux-5-bs:41 persisted
  sidebar/members width. Either (i) test-side cleanup in
  `afterEach` to reset localStorage, or (ii) prod-side per-tab
  ephemeral state with explicit "reset" verb. Decide after audit.
- **C (Bahamut /invite rate-limit)**: p0e victim of b0+b2 if both
  ran recently. Either (i) cooldown timestamp helper before each
  /invite, or (ii) distinct test-network slug per spec (probably
  overkill — already per-channel-name distinct).
- **D (WS subscribe-vs-broadcast race)**: m2 + similar — peer events
  arrive before per-channel topic ack. cic needs a `__cic_channelReady`
  set parallel to `__cic_dmListenerReady` for the channels-loop. Test
  helper `waitForChannelReady(slug, channel)` analogous to
  `waitForDmListenerReady`. Server-side: investigate whether
  `phx.join().receive("ok")` is the right gate or whether the
  per-channel topic subscription has a separate ack.
- **E (speed)**: parallelize chromium project per spec-file group;
  warm grappa BEAM across iso runs (currently each iso = full
  testnet bringup + grappa cold boot ~2min); cache cic build across
  unchanged-source runs.
- **Z (close)**: docs sweep, new feedback memories, todo
  reconcile. Verify chromium full N×5 ✓ in a row.

**Caveat**: per `feedback_recurring_e2e_not_flake`, observing
flakes 1× ≠ pursuing. Cluster opens only when full chromium run
shows ≥2 rotating victims across 3 consecutive runs (criteria met
this session).

---

(BUGHUNT-3 fully closed; bastille proper is BLOCKED on
E2E-ROBUSTNESS — porting to FreeBSD on a leaky CI substrate
multiplies the debugging surface.)

---

★ **POST-UX-8 ROADMAP — canonical source of truth (vjt 2026-05-22, UX-8 + codegen + BUGHUNT-1 + BUGHUNT-2 CLOSED 2026-05-24):**

After UX-8 (scroll cluster) + codegen + BUGHUNT-1 pre-bastille
bug-hunt CLOSED, work proceeds in this order. Do NOT skip ahead.

1. **Bastille deploy workstream** — GitHub issue #8 (`GH_CONFIG_DIR=./.gh
   gh issue view 8`). FreeBSD bastille jail target prod runtime; current
   deploy is docker-compose. Likely parallel target
   (`scripts/deploy-bastille.sh` sibling to `scripts/deploy.sh`), not a
   Docker→Bastille rewrite. Verify scope from #8 before assuming.

**Why this order (load-bearing):**
- Codegen-before-bastille (CLOSED 2026-05-24): cic↔server boundary was
  the highest-risk drift surface per 2026-05-22 review. CP46 closed it
  structurally via mix-task + drift gate + cic-side TS assert.
- BUGHUNT-1-before-bastille (CLOSED 2026-05-24): two known user-visible
  regressions (long-msg silent truncation + cic mobile archive empty
  on first open) closed in CP47 so the new prod runtime doesn't
  inherit them.
- Bastille-last: prod-runtime migration on a green-suite +
  structurally-typed-boundary + no-known-regressions substrate, not
  during cleanup.

**Lineage** (verbatim vjt words preserved):
- 2026-05-22 mid-REV-E: "after review is done, fix all the flakes and
  do the codegens before proceeding with bastille deploy"
- 2026-05-22 evening: "we still have scrolling issues when switching
  channels, and we need to implement read cursor update on scroll. when
  is the best moment?" → "it's ok fix the flakes first"
- 2026-05-24 night: UX-8 scroll cluster CLOSED — (a) double-rAF +
  scrollIntoView + spec marker-tolerance, (b) scroll-settle cursor
  with forward-only gate, (d) 3-scenario e2e + sentinel marker-aware.

Memory pointer (single source of truth lives HERE, not in memory):
`project_post_rev_roadmap.md` is a one-liner pointer to this section.

---

## Carry-forwards from REV cluster (open)

- **REV-J.5 (M1+M5)** anonymous-volumes refactor — Dockerfile UID
  prep prerequisite. Standalone bucket between flakes and codegen
  if bandwidth permits, else future infra-polish cluster.
- **REV-K LOW-3 cosmetic** — `info` field duplicates `error` key
  in ChannelPushError extractor. Trivial dedup; not blocking.
- **compose.ts:601 ChannelPushError branching consumer** — wire to
  handle the typed class symmetrically with `ApiError`.
  Bucket-sized polish.
- **`_build/prod` cleanup procedure** still undocumented in operator
  runbook (REV-C/D carry-forward; HOT path means it stopped recurring,
  not that it's solved). Future infra-polish target.
- **27-item LOW set** — opportunistic. Notable themes per
  2026-05-22 review § "LOW findings": dead-code clauses in
  `Identifier.services_sender?`, empty-reason `send_away/2` accepting
  `AWAY :\r\n`, `Push.subscription.id` as `string` vs branded UUID,
  `linkify` regex `\S+` unbounded, `image-upload.ts` localStorage vs
  `token()` signal, `bin/start.sh` env-fiddling, `register-dns.sh`
  placement.
- **`feedback_deploy_preflight_empty_diff_after_merge` recurrence
  (REV-I)** — script-level fix candidate: detect same-SHA + recent
  merge-commit + demand explicit flag. Wider than any single REV
  bucket; future-bucket target.
- **`apply/3` test pattern for Elixir 1.19 set-theoretic type checker
  (REV-H)** — earns a feedback memory if it bites a 3rd time.
- **SolidJS function-ref gotcha (REV-G)** — `feedback_solidjs_for_ref_leak`
  memory needs update: function-refs are mount-only; on unmount NOT
  auto-called with `undefined` (that's React's contract). Fix recipe
  needs `createSignal` function-ref **plus** explicit
  `onCleanup(() => setRef(undefined))`.
- **AwayState reconnect re-issue (REV-F)** — operator must re-issue
  `/away` post-reconnect because Session crash wipes AwayState.
  UX-8 follow-up could surface "your AWAY was lost on reconnect"
  hint via the cic channel.
- **CTCP `apply_effects {:reply, line}` runtime regression test
  (REV-E/F)** — current test is source-grep workaround because
  `IRC.Client` recv-loop (`:prim_inet.setopts(nil, ...)`) crashes
  post-socket-nil. Separate silent-swallow class (`handle_info
  {:tcp, _, _}` post-socket-nil). Future-bucket candidate.
- **MED-2 carry-forward from REV-B** — `validate_target_name/1` runs
  on pre-canonical `target` in ArchiveController. Bytes-equivalent
  today; minor drift risk.
- **REV-D reviewer LOW-1** — H14 narrow-window test name vs.
  behavior. Two-line rescue, both nil-get + rescue paths return same
  typed error.
- **REV-E reviewer LOW-2** — `maybe_log_send_failure/2` takes
  `String.t()` label, could be atom for CLAUDE.md closed-set preference.
- **REV-F reviewer LOW-1 + LOW-2** — labeled-response-only NAK
  symmetry test + `maybe_send_cap_end/1` 5-element vertical phase-list
  style nit.

---

## High

Phase 5 hardening (collected across multiple plans; ship together when
Phase 5 cluster opens):

- **Session.Server `terminate/2` cleanup** — send QUIT to upstream +
  close socket. Currently `:normal` exit kills `IRC.Client` via link,
  which silently dies. OK for prod but emits ugly `tcp_closed
  terminating` test-stdout noise.
- **TLS `verify: :verify_none` → CA chain verification.** Replace the
  Phase 1 expedient in `lib/grappa/irc/client.ex`. Document
  operator's TLS-trust-store config strategy.
- **Post-registration `+r` umode fallback.** If after `001 RPL_WELCOME`
  client didn't receive `+r` (or network-specific registered-user
  umode), fall back to explicit `PRIVMSG NickServ :IDENTIFY <pwd>`
  retry. Catches PASS-not-bound-to-services + lost-PASS races.
- **NickServ NOTICE reply parsing** (success/failure per network:
  Anope/Atheme/etc), nick-collision recovery (GHOST/RECOVER when our
  nick is in use). Shared correlation machinery with REGISTER proxy.
- **NickServ REGISTER proxy as REST endpoint.** Async request → wait
  for NickServ NOTICE reply → translate to HTTP response. Phase 2
  manual workaround: operator runs `/msg NickServ REGISTER pass email`
  from any IRC client once, captures password, drops into grappa via
  `mix grappa.bind_network`.
- **Multi-server failover logic.** Phase 2 schema includes
  `network_servers` (irssi shape: priority + enabled), but Phase 2
  only uses first. Phase 5: try server 0 → on connect fail try server
  1 → ... → exponential backoff → reset on success.
- **HSM-keyed Cloak.Vault.** Operator escape from "env on disk" key
  storage. Cloak.Vault supports yubico-hsm, TPM, AWS KMS — configurable
  swap, no code change in Grappa. Document operator hardening path
  in README.
- **Service worker requires secure context (HTTPS or localhost).**
  `http://grappa.bad.ass` is neither — iOS Safari silently fails SW
  registration; catch in `cicchetto/src/main.tsx:44` logs to console.
  Offline shell cache won't function until Phase 5 TLS rollout.
- **Move bearer token off WS query string.** Currently rides
  `?token=…` on the upgrade URL. Phase 3 redacts via
  `:filter_parameters` + nginx `access_log off`, but bearer still
  visible to anyone who can see URL pre-redaction. Move to
  `Sec-WebSocket-Protocol` or post-connect `phx_join` payload —
  needs phoenix.js + UserSocket protocol change.
- **Accessibility pass.** Channel sidebar uses raw `<ul><li><button>`
  with no tree semantics — iOS VoiceOver doesn't read network →
  channel hierarchy as a tree. Phase 5 a11y audit covers this +
  tap-target sizing + focus-state contrast (web.dev a11y guidelines).
- **WS subprotocol allowlist inheritance.** When adding new WS
  subprotocols or alternate Channel transports, inherit `check_origin`
  allowlist; new feature with different host = separate
  Phoenix.Endpoint, not relaxation in `runtime.exs`.
- **Rotate `GrappaWeb.Endpoint.@session_options.signing_salt`.**
  Lift to `runtime.exs` config alongside `secret_key_base` so it's
  rotatable without recompile. No code path signs cookies today;
  rotate before any cookie surface lands.

## Medium

- Open tracking issue / doc for **Phase 6 IRCv3 listener** — collect
  specs needed (`CAP LS 302`, `CHATHISTORY`, `server-time`, `batch`,
  `labeled-response`, SASL mechanisms). Reuse parser from Phase 1.
- **Supply-chain hardening** — `oven/bun:1` and `nginx:alpine`
  (used by `scripts/bun.sh` and `compose.prod.yaml`) are moving major
  tags. Pin to digests (`oven/bun:1@sha256:…`) for reproducible
  builds.

## Low / Observation

- Investigate `mix release` size on Debian-slim runtime image. If
  obnoxiously big, evaluate Alpine + musl rebuild of `ecto_sqlite3`
  NIFs.
- `Grappa.version/0` (`lib/grappa.ex:28`) has zero callers. Either
  wire into `/healthz` JSON response (one-line change in
  `HealthController`) or drop the function.
- Sqlite "Database busy" intermittent test flake — `Repo` /
  `Scrollback` / `Wire` occasionally fail inserts with
  `Exqlite.Error: Database busy`. Contention between `async: true`
  Repo writes and live container also writing to
  `runtime/grappa_dev.db`. Mostly benign noise during ci.check;
  not flaky on CI (which uses fresh DB).
- Telemetry → Prometheus exporter (PromEx). Phase 5 hardening.
- Reconnect/backoff policy when upstream IRC drops. Phase 5.
- Scrollback eviction policy — by row count, by age, or both. Phase 5.
- **nginx `keepalive 32` is dead weight** without `proxy_set_header
  Connection "";` on API allowlist `location` block. Without clearing
  the Connection header on upstream side, nginx forwards client's
  `Connection: close` and keepalive pool never warms. Pure perf,
  measurable only under sustained load.

---

## Wishlist (vjt 2026-05-03 #sniffo banter w/ nextime)

- **Addressed-messages highlight on return-from-away.** When user
  reconnects/returns, surface messages that mentioned them (or DMs)
  prominently — not just "unread count." Needs last-seen marker
  per channel + server-computed "things addressed to you while away"
  list that cicchetto renders as top section before scrollback proper.
  Phase 4/5 cicchetto UX.
- **Auto-away management.** Client emits idle/active hints (focus,
  tab visibility, lock screen if available); server flips presence
  and AWAY status without user intervention. No `/away` typing.
  Combine with addressed-on-return above. Phase 4 cicchetto + small
  server hook.
