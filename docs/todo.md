# Todo

The pending-work backlog. **Only what's TODO. Done work lives in the
active checkpoint, not here.** No archives, no LANDED blocks, no
"closed" observations. If you find any in this file, delete on sight.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

### UX-8 scroll cluster (next, after GREEN-CI-3 close)

GREEN-CI-3 Tier 1 CLOSED 2026-05-23 at `4afa4e1`. Final CI state:
integration 183/184 + ci exit-0. The 1 remaining integration failure
is `scroll-on-window-switch:141` — a **REAL prod scroll regression**
vjt dogfood-confirmed (channel → empty query → channel-back leaves
~66px gap instead of 0). The spec is correctly detecting the bug
intermittently (passes 1st run on fresh stack, fails on consecutive
re-runs depending on cic state). NO spec-side `afterEach` added —
masking the spec would hide the prod bug. UX-8 fixes the root cause
and the spec turns green naturally.

**UX-8 scope (per locked roadmap):**
- (a) channel-switch scroll position interference — `scroll-on-window-
  switch:141` is the sentinel. UX-6-M folds in if vjt repro arrives.
- (b) read-cursor update on scroll = NEW server contract.
  `Grappa.ReadCursor.set/4` currently fires on focus-leave + browser-
  blur only; adding scroll = new settle-event class with throttling
  spec.

**GREEN-CI-3 Tier 2/3 deferred** — captured in the plan's appendix
(`docs/plans/2026-05-23-green-ci-3-e2e-hardening.md`). Future
cluster pickup; not in UX-8 scope.

After UX-8: wireTypes.ts codegen, then Bastille deploy. ★ roadmap
block below has full lineage.

---

★ **POST-FLAKES ROADMAP — canonical source of truth (vjt 2026-05-22, GREEN-CI-3 CLOSED 2026-05-23):**

After FLAKES-Z + GREEN-CI batches 1+2 + GREEN-CI-3 Tier 1 LANDED,
work proceeds in this order. Do NOT skip ahead.

1. **UX-8 scroll cluster** — (a) channel-switch scroll position
   interference (sentinel: `scroll-on-window-switch:141` — vjt
   dogfood-confirmed real prod regression 2026-05-23); UX-6-M folds
   in if vjt repro arrives; (b) read-cursor update on scroll = NEW
   server contract. `Grappa.ReadCursor.set/4` currently fires on
   focus-leave + browser-blur only; adding scroll = new settle-event
   class with throttling spec.
   (Naming note: UX-7-A..F was the baseline-e2e-fails cluster, already
   CLOSED. This is a fresh cluster, hence UX-8.)
2. **wireTypes.ts codegen** — generate `cicchetto/src/lib/wireTypes.ts`
   from server-side `Grappa.*.Wire` typespecs. Closes
   C1+C2+H1-H4+H6+M19+M20 STRUCTURALLY (compile-time guarantee, not
   vigilance), supersedes REV-A/H/K hand-edits. See 2026-05-22 codebase
   review § "Direction recommendation".
3. **Bastille deploy workstream** — GitHub issue #8 (`GH_CONFIG_DIR=./.gh
   gh issue view 8`). FreeBSD bastille jail target prod runtime; current
   deploy is docker-compose. Likely parallel target
   (`scripts/deploy-bastille.sh` sibling to `scripts/deploy.sh`), not a
   Docker→Bastille rewrite. Verify scope from #8 before assuming.

**Why this order (load-bearing):**
- FLAKES-first: noisy e2e blocks confidence in every later wave.
- UX-8-before-codegen: read-cursor-on-scroll changes the server
  contract; codegen captures the final wire shape in one pass not two.
- Codegen-before-bastille: cic↔server boundary is the highest-risk
  drift surface per 2026-05-22 review.
- Bastille-last: prod-runtime migration on a green-suite + structurally-
  typed-boundary substrate, not during cleanup.

**Lineage** (verbatim vjt words preserved):
- 2026-05-22 mid-REV-E: "after review is done, fix all the flakes and
  do the codegens before proceeding with bastille deploy"
- 2026-05-22 evening: "we still have scrolling issues when switching
  channels, and we need to implement read cursor update on scroll. when
  is the best moment?" → "it's ok fix the flakes first"

Memory pointer (single source of truth lives HERE, not in memory):
`project_post_rev_roadmap.md` is a one-liner pointer to this section.

---

## Pre-bastille bug-hunt (vjt 2026-05-24, dogfood, BEFORE bastille deploy)

Two bugs surfaced during UX-8 cluster execution. **Address after UX-8
+ codegen, before bastille deploy** (these are user-visible regressions
prod traffic should not see in a new runtime substrate).

1. **Long-message auto-split (SERVER-SIDE)** — when cic POSTs a
   PRIVMSG larger than the IRC server's max line length, the message
   gets truncated silently. Need to split into multiple PRIVMSGs on
   the bouncer side and send sequentially.
   - **Location**: `Grappa.IRC.Client` or wherever PRIVMSG bytes
     hit the wire to upstream. Split MUST happen in grappa, NOT in
     cicchetto (per CLAUDE.md "one parser, on the server" — payload
     framing is server's job).
   - **Spec considerations**: per-network max-line-length (RPL_ISUPPORT
     LINELEN if present, else 512 default minus prefix/header).
     UTF-8 awareness: split on grapheme boundary not byte. Preserve
     CTCP framing if body is `\x01ACTION ...\x01` (split inside the
     action text, NOT inside the framing bytes). Scrollback
     persistence: each fragment is its own message row (consistent
     with what upstream sees + with what cic renders).
   - **Sentinel test**: server-side spec generating a message body of
     N bytes where N > LINELEN, assert N fragments emitted upstream
     + N rows in scrollback.

2. **Archive window shows empty on first open (CIC, MOBILE ONLY)** —
   first open of the Archive window in cic shows empty list. After
   archiving a fresh window, all archived contents appear. Desktop
   not yet checked; mobile-only confirmed.
   - **Suspected location**: `cicchetto/src/lib/archiveStore.ts` or
     wherever Archive view subscribes/seeds. Likely a SolidJS reactivity
     gap on first-mount (signal not initialized until first write event
     lands).
   - **Repro path**: fresh PWA install on iOS, open Archive window
     immediately (no prior archive action) → empty. Trigger archive on
     any window → Archive view repopulates with full list.
   - **Hypothesis**: store does an initial fetch but the rendered
     `<For>` is bound to a signal that hasn't been set yet (undefined
     vs empty array distinction). Or: the listener for `archived` events
     is wired AFTER the initial REST seed, so seed lands during a
     listener-not-yet-armed window. Standard cic re-render bug class —
     see `feedback_home_pane_ws_rerender_bug` for sibling pattern.
   - **Verify on desktop**: vjt explicitly noted "desktop I didn't
     check" — first step is reproducing on desktop to confirm
     mobile-only vs cross-platform. If desktop also broken, root cause
     is in the store; if mobile-only, focus on touch/PWA cold-start
     timing (e.g. viewport-resize racing the seed).

These slot in **between codegen and bastille**: don't deploy a fresh
prod-runtime substrate with known user-visible regressions.

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

- Set up GitHub repo `vjt/grappa-irc` with CI secrets (codecov token
  if desired, no other secrets required for Phase 1).
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
- Sqlite "Database busy" intermittent test flake — hit once during
  S19 ci.check. 3 tests (`Repo` / `Scrollback` / `Wire`) simultaneously
  failed inserts with `Exqlite.Error: Database busy`. Likely contention
  between `async: true` Repo writes and live container also writing
  to `runtime/grappa_dev.db`.
- Telemetry → Prometheus exporter (PromEx). Phase 5 hardening.
- Reconnect/backoff policy when upstream IRC drops. Phase 5.
- Scrollback eviction policy — by row count, by age, or both. Phase 5.
- **nginx `keepalive 32` is dead weight** without `proxy_set_header
  Connection "";` on API allowlist `location` block. Without clearing
  the Connection header on upstream side, nginx forwards client's
  `Connection: close` and keepalive pool never warms. Pure perf,
  measurable only under sustained load.

---

## Notes

- Phase 0 (spec) complete. README + DESIGN_NOTES + walking-skeleton
  plan all in main.
- Phase 1 tasks have TDD steps with failing-test-first discipline in
  `docs/plans/2026-04-25-walking-skeleton.md`.
- Italian Hackers' Embassy / Azzurra context: `docs/project-story.md`
  for narrative thread surviving individual sessions.

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
