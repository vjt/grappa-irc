# Todo

The pending-work backlog. **Only what's TODO. Done work lives in the
active checkpoint, not here.** No archives, no LANDED blocks, no
"closed" observations. If you find any in this file, delete on sight.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

- **Next-session scope (vjt 2026-06-11)**: e2e CSP parity (High entry
  below) + dogfood asks + **PWA home-screen icon notification badge**
  (NEW: Badging API `navigator.setAppBadge`, iOS 16.4+ standalone;
  derive count from server-owned read cursors — design questions in
  /tmp/orchestrate-next.txt brief: mentions vs unread, WS vs SW-push
  update path, clear trigger) + **#9 validation via deliberate cold
  window at session end** (vjt ordered the restart; sessions reset
  accepted).
- **Codebase review gate: DUE, explicitly deferred by vjt 2026-06-11**
  (token cost). Re-flag each session; vjt decides when it runs.

---

★ **POST-BASTILLE ROADMAP — canonical source of truth (vjt 2026-05-27):**

1. **Voice TTS+STT (Web Speech API on-device)** — per-channel TTS +
   STT toggle via the browser's Web Speech API. On-device, no
   third-party round-trip; Vosk/piper WASM offline path stays as
   the long-tail fallback for browsers without Web Speech support.
2. **UI polish cluster** — its own multi-bucket effort, mobile-first.
   Responsive breakpoints beyond the single 768px line, touch-target
   sizing, sidebar ergonomics, input bar density, scroll behavior.
3. **PUBLIC OPEN** — the milestone where grappa stops being a
   single-operator setup and becomes a self-hostable bouncer anyone
   can deploy. Pre-conditions: every cluster above CLOSED, Phase 5
   hardening done (TLS verification, eviction policy, NickServ
   proxy), self-hoster docs, OpenAPI schema published.

Memory pointer: `project_post_rev_roadmap.md` is a one-liner pointer
to this section.

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
- **27-item LOW set** — opportunistic. Notable themes per
  2026-05-22 review § "LOW findings": dead-code clauses in
  `Identifier.services_sender?`, empty-reason `send_away/2` accepting
  `AWAY :\r\n`, `Push.subscription.id` as `string` vs branded UUID,
  `linkify` regex `\S+` unbounded, `uploadHost.ts` (ex
  `image-upload.ts`) localStorage vs `token()` signal,
  `bin/start.sh` env-fiddling, `register-dns.sh` placement.
- **Deploy decision-lib extraction + docker parity → issue #51**
  (subsumes the REV-I
  `feedback_deploy_preflight_empty_diff_after_merge` same-SHA-guard
  port): extract the bats-pinned jail decision logic (mode/verdict
  dispatch, marker lifecycle, re-exec guard, reload honesty check)
  into a shared POSIX-sh lib sourced by both orchestrators; docker's
  three gaps (no marker, unchecked reload, no re-exec guard) close as
  a side effect. Restart/build verbs stay substrate-specific. Full
  spec + sequencing in the issue — AFTER the codebase review and a
  jail-deploy soak period. Local dev stack only, nothing production.
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

- **e2e nginx-test must carry the prod CSP** (2026-06-10) — the
  `security-headers.conf` snippet is absent from
  `cicchetto/e2e/nginx-test.conf`, so 223 green e2e specs never saw
  the missing `media-src blob:` that broke EVERY prod video upload
  (the duration probe's blob: <video> load was CSP-blocked; fixed in
  `6f3327c`). Include the snippet in the e2e nginx config and run the
  full suite — first run under CSP may surface more latent blocks,
  which is exactly the point. Same lesson as the nginx route
  allowlist parity rule in CLAUDE.md. While in there: add one e2e
  spec doing a ranged fetch of an uploaded file through nginx
  asserting 206 + content-range (2026-06-10 Range support landed
  controller-side; ConnTest can't see a proxy-layer Range strip —
  same prod-only blind spot as the CSP).

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
- **Verify iOS Safari SW registration on prod (TLS blocker resolved).**
  Service workers need a secure context; prod has been HTTPS-live since
  the 2026-05-27 bastille deploy (irc.sniffo.org / irc.sindro.me), so the
  old "won't function until Phase 5 TLS rollout" blocker is GONE. Remaining
  work is just confirming iOS Safari actually registers the SW on prod
  (the `cicchetto/src/main.tsx:44` console catch fires only on bare-http
  dev hosts, not a deliverable). Downgraded from blocker to a one-time
  prod check.
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
  (used by `scripts/bun.sh` and `compose.yaml`'s `--profile prod`
  nginx service) are moving major tags. Pin to digests
  (`oven/bun:1@sha256:…`) for reproducible builds.
- **Visitor nick collision pre-check** — a visitor login with a nick
  already held by a logged-in user on the same network creates a
  Session.Server that fails forever on upstream 433. The
  `refresh_plan` init gate (cp51 S2 + S3) recovers cleanly once
  the operator deletes the row, but the user-facing UX is "session
  fails silently, contact operator." A `POST /auth/login` pre-check
  that queries the live Registry for collision-and-rejects would
  prevent the class entirely. Smaller bucket.
- **De-compile-pin `:visitor_network`** (vjt 2026-06-04) — it's
  `Application.compile_env!(:grappa, :visitor_network)` in
  `lib/grappa/visitors/login.ex` (hardcoded `"azzurra"` in
  `config/config.exs`). Should be a runtime/env decision
  (`GRAPPA_VISITOR_NETWORK` in `config/runtime.exs`), not baked at
  compile time — changing the visitor network currently needs a cold
  rebuild. **Tracking: issue #42.** Surfaced while moving vjt to a
  dedicated-source network (CP54 2026-06-04, DESIGN_NOTES).
- **`unbind` can't detach the last user from a visitor-only network**
  (2026-06-04) — `Credentials.unbind_credential/2` hits the
  cascade-on-empty path and rolls back `:scrollback_present` when the
  network still has (visitor) scrollback but no other user-credential.
  Either teach the last-user check that visitor presence counts, or add
  a "detach user, keep network" verb. Worked around in prod with a
  direct credential-row delete. See DESIGN_NOTES 2026-06-04.

## Low / Observation

- **ICC_Profile strip-whitelist candidate** (#39 round 2 residual,
  2026-06-11) — iPhones shoot Display P3; `-all=` strips the ICC
  profile so wide-gamut photos render slightly washed. Same
  presentation-critical class as Orientation (now whitelisted), but
  the entry stays OUT of `@kept_tags` until a P3-profiled committed
  fixture pins both directions — an untested whitelist entry is a
  privacy hole nobody pinned. Needs a source .icc to build the
  fixture (generate.sh can't fabricate one from nothing).
- **Mint upload URLs with a type extension** (`/uploads/<slug>.<ext>`,
  media-viewer residual 2026-06-11) — the in-app viewer's image/video
  signal currently lives in message TEXT (the 📸/🎬 prefix read from
  the linkify segment preceding the URL within one mIRC run); a body
  interleaving control codes between emoji and URL (colorizing relay
  bridge) splits runs and the link falls back to the plain anchor.
  cic's own mints are always plain, so today's surface is zero. The
  durable fix is server-side: encode the type in the URL itself, and
  the emoji sniff becomes the historical fallback. DESIGN_NOTES
  2026-06-11.
- **Modal chrome CSS dedup** — `.media-viewer-backdrop` is the FOURTH
  fixed/inset:0 dim backdrop block in default.css (after
  image-upload, archive, context-menu) and `.media-viewer-close`
  property-duplicates `.archive-modal-close`. A shared
  `.modal-backdrop`/`.modal-close` base class would name the pattern;
  theme-wide refactor, ride a UI-polish bucket.
- **e2e upload-journey helper dedup** (2026-06-11 review finding) —
  the picker → privacy-modal → waitForResponse(POST /api/uploads) →
  201 journey now has FOUR copies across spec files
  (media-link-modal-viewer `uploadPngAndGetLink`, uploads2-video-doc
  `uploadViaPicker`, ux-6-b-embedded-upload inline, i2b-litterbox
  inline) and they have already drifted (timeout params). Hoist one
  parameterized helper into `e2e/fixtures/` and migrate all four —
  natural pairing with the e2e-CSP-parity session (todo High), which
  touches the same suite.
- **iOS device dogfood: media-link viewer ROUND 2** (2026-06-11,
  post-dogfood fixes) — round 1 found "open in browser" navigating the
  PWA + no spinner; both fixed (escape = x-safari-https handoff on
  plain click, iOS 17+). Re-verify on device: (a) tap 📸/🎬 link →
  viewer opens in-app, spinner while loading, media renders; (b) "open
  in browser" → REAL Safari opens (not in-place navigation, not the
  in-app browser sheet); (c) long-press "open in browser" → Copy Link
  yields the live https URL (not x-safari-); (d) tap a 📄 doc upload
  link → also hands off to Safari instead of navigating the PWA. None
  of this is emulatable; device dogfood is final verification.
- **iOS device dogfood: text selection** (Dispatch-1 follow-up,
  shipped 2026-06-11, bundle `BhVMIcil`) — long-press select in
  scrollback incl. a SHORT channel (non-overflowing `.scrollback`
  carries `touch-action: none`; emulation can't answer whether WebKit
  starts long-press selection inside it) + selection inside the
  compose box. DESIGN_NOTES 2026-06-11.
- **Android keyboard-preserve observation** — keepKeyboard gate is
  iOS-only since 2026-06-11 (Android behavior was never validated).
  If Android PWA dogfood shows the on-screen keyboard dropping on
  chrome taps while composing, widen the `isIos()` gate by one clause.
- **Remove m42 fail2ban `/read-cursor` 400-exemption** (post-#44) — the
  cic positive-int guard landed + deployed (cp58, bundle `BF6Dside`).
  Once prod access logs show `/read-cursor` 400s at zero (clients on the
  new bundle), drop the CP55 `http-400` jail exemption for
  `/read-cursor\b` on the m42 host. Checked 2026-06-09 (deploy day):
  log is `irc.openssl.it-access.log`, 400s from 6 distinct client IPs,
  last 07/Jun — too early to drop (a stale-bundle PWA bursts ~31×400
  vs maxretry 8 → bans a legit user). Recheck ≥2026-06-16.
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
- **Captcha-enabled-on-prod discrepancy** (2026-06-08, CP55) — prod
  `grappa.env` has NO `GRAPPA_CAPTCHA_*` → provider should be
  `disabled` → no widget. Yet vjt saw the captcha widget (and its CSP
  inline-script block) on prod. Confirm where the provider is actually
  switched on, or whether it was a stale client state. The CSP fix
  (sha256 in script-src, CP55) is correct regardless.

---

## Wishlist (vjt 2026-05-03 #sniffo banter w/ nextime)

- **Addressed-messages highlight on return-from-away.** When user
  reconnects/returns, surface messages that mentioned them (or DMs)
  prominently — not just "unread count." Needs last-seen marker
  per channel + server-computed "things addressed to you while away"
  list that cicchetto renders as top section before scrollback proper.
  Phase 4/5 cicchetto UX. (Its sibling wishlist item, auto-away, is
  long shipped — `WSPresence` + cic visibility hints.)
