# 2026-05-06 — Integration testing pipeline (`cicchetto/e2e/`)

## Why

Manual e2e via CDP+tmux is brittle and stops at desktop Chrome. Bug 7
(iOS Safari: own-msg sent but never appears in DOM until refresh)
demonstrates the cost: 60 minutes of manual repro produced a desktop-
chrome PASS that was a false negative for the actual user-facing fault.

We need a deterministic, reproducible integration harness that:

1. Runs in a single `docker compose up` from a clean checkout.
2. Drives **WebKit** (iOS Safari engine) headless — the cell where the
   user-facing bugs actually live.
3. Has a **synthetic IRC peer** so cicchetto↔peer scenarios are
   primitive function calls, not TUI scraping.
4. Uses the **real upstream IRC daemon family** (Bahamut + services)
   so numeric/CAP/SASL/NickServ behaviour matches Azzurra prod.
5. Can run in CI later with no environment changes.

## Stack

```
cicchetto/e2e/
├── infra/                  # git submodule → vjt/azzurra-testnet @ pinned SHA
├── compose.yaml            # extends infra/compose.yaml + adds grappa, nginx-test, runner
├── playwright.config.ts    # chromium baseline, webkit + iPhone 15 device for iOS-shaped specs
├── fixtures/
│   ├── ircClient.ts        # `irc-framework` wrapper — typed PRIVMSG/JOIN/PART verbs
│   ├── grappaApi.ts        # bind_network / create_user via `docker exec` mix-task
│   └── seedData.ts         # default user `vjt`, peer `vjt-peer`, network `bahamut-test`
├── tests/
│   ├── m1-irssi-to-chan-focused.spec.ts
│   ├── m2-irssi-to-chan-defocused.spec.ts
│   ├── m3-cic-to-chan.spec.ts            # @webkit
│   ├── m4-irssi-to-priv-no-window.spec.ts
│   ├── m5-irssi-to-priv-window-open.spec.ts
│   ├── m6-cic-to-priv.spec.ts            # @webkit
│   ├── m7-peer-join-no-bouncer-follow.spec.ts
│   ├── m8-cic-join.spec.ts
│   ├── m9-cic-part-x-click.spec.ts
│   ├── m10-irssi-action.spec.ts
│   ├── m11-irssi-nick.spec.ts
│   ├── m12-passive-events.spec.ts
│   └── bug7-ios-own-msg-visible.spec.ts   # webkit + iPhone 15 — must FAIL on prod
├── package.json            # node deps: @playwright/test, irc-framework, typescript
└── README.md               # how to run, how to add a spec, how to debug
```

### Why these technology choices

- **Playwright over Puppeteer/CDP**: native WebKit driver (closest non-
  device approximation of iOS Safari), built-in iPhone device descriptors,
  trace viewer for post-mortem, no manual sleep loops.
- **Node 22 + `irc-framework` over Python pydle**: runner stays on
  Playwright's official base image (`mcr.microsoft.com/playwright`),
  which ships Node + browsers (chromium/firefox/webkit) preinstalled.
  Cicchetto-build stays on Bun (separate container) — one toolchain
  per container, no derivation acrobatics. The runner is the only
  e2e/ Node consumer, so this doesn't bring Node back into cicchetto/
  proper.
- **Bahamut + services from `vjt/infra`**: the user maintains a testnet
  repo with full Azzurra-shaped services (Bahamut + ChanServ/NickServ/
  OperServ). Adopting it gives us NickServ/SASL fidelity that a vanilla
  IRCd image (Unreal/Inspircd) wouldn't.
- **Tests live in `cicchetto/e2e/`**: Playwright is JS-native; the
  cicchetto repo already has a Bun toolchain. Mix would force a second
  language for trivial reasons.

## Plan (bite-sized, reviewable steps)

### S0 — Adopt azzurra-testnet (preflight)

- [x] Read `https://github.com/vjt/azzurra-testnet` README + compose
  layout. Plan B scaffold: hub + leaf-v4 + leaf-v6 + services (Bahamut
  + Anope-shape services), one image-built-thrice, hub on host port
  6667/6697.
- [x] Repo prep: `vjt/infra` had `main` empty (README only) with two
  feature branches carrying the actual work. Merged
  `fix/services-binary-path` → `main` (ff, +17 files / 1052 lines),
  pushed, deleted `feat/plan-b-bootstrap` + `fix/services-binary-path`,
  renamed `vjt/infra` → `vjt/azzurra-testnet`.
- [x] Adoption shape: **submodule** at `cicchetto/e2e/infra/`, pinned
  to SHA `21e1c90` (current `main` head).
- [x] Verify standalone boot: `cd cicchetto/e2e/infra && cp
  .env.example .env && docker compose up --build --wait` →
  hub/leaf-v4/leaf-v6/services all `Healthy`. Real registration
  against `localhost:6667` returned RPL_001 + ISUPPORT + MOTD +
  Azzurra NOTICE block ("There are 5 users and 6 invisible on 3
  servers"). Bahamut + S2S links + services proven boot. SHA `21e1c90`
  pinned. (S0 verified 2026-05-06.)

**Exit criterion**: `cicchetto/e2e/infra` boots a working IRC testnet
on a deterministic port; `nc localhost 6667` shows a Bahamut welcome.

### S1 — Compose: stitch grappa + nginx + runner into the testnet

- [x] `cicchetto/e2e/compose.yaml` extends infra's compose-file via
  `include:` directive — adds `grappa-test` (build target), `nginx-test`
  (reuses prod `infra/nginx.conf` via `grappa` network alias on
  grappa-test), `cicchetto-build-test` (oneshot SPA build),
  `playwright-runner` (mcr.microsoft.com/playwright:v1.59.1-jammy).
- [x] grappa-test points at `bahamut-test:6667` (hub network alias on
  the shared `grappa-e2e` bridge); no host-DNS dep.
- [x] nginx-test serves SPA from `runtime/e2e/cicchetto-dist` (host
  bind-mount, mirrors prod `runtime/cicchetto-dist`).
- [x] All deps wired via healthchecks + `service_healthy` /
  `service_completed_successfully` conditions.
- [x] `scripts/integration.sh` — wrapper. Two-phase orchestration:
  `compose up --wait <long-running services>` then `compose run
  --rm playwright-runner`. Splitting boot from run avoids the
  `--abort-on-container-exit` (and `--exit-code-from`) gotcha where
  cert-init's normal exit kills the in-progress build phase.
- [x] Trap-on-EXIT teardown via `compose down -v`. `KEEP_STACK=1`
  opt-out for iterative debug.

Operator-side ergonomics shaken out during S1:

- macOS GID=20 (`staff`) collides with hexpm/elixir's Debian system
  `tty` group at GID 20 → `groupadd -g 20` exits 4. Wrapper exports
  `CONTAINER_UID/GID=$(id -u/-g)` only on Linux; macOS keeps the
  compose default of 1000:1000 because Docker Desktop's bind-mount
  layer translates ownership transparently.
- Bun cache + cicchetto dist live in host bind-mounts under `runtime/`
  (not named volumes) — same shape as `scripts/bun.sh`. Named volume
  is root-owned on first create, fails AccessDenied under the dropped
  UID.
- Runner image's `/work/node_modules` is preserved over the source
  bind-mount via a named volume — without it, the bind hides the
  npm-installed deps and Playwright fails with "Cannot find package
  '@playwright/test'".
- nginx.conf hardcodes `upstream grappa:4000`. Adding `grappa` as a
  network alias on grappa-test lets us reuse the prod nginx.conf
  verbatim (production fidelity, no e2e-specific drift).

**Exit criterion**: `scripts/integration.sh` boots full stack, runs
the smoke spec (chromium, 2 tests: SPA root + /healthz proxy), exits
0. (S1 verified 2026-05-06: `2 passed (6.4s)`.)

### S2 — Fixtures: ircClient + grappaApi + seedData

- [ ] `fixtures/ircClient.ts` — wraps `irc-framework`:
  ```
  const peer = await IrcPeer.connect({host: "bahamut-test", nick: "vjt-peer"});
  await peer.join("#bofh");
  await peer.privmsg("#bofh", "hello");
  await peer.privmsg("vjt-grappa", "DM hello");
  await peer.part("#bofh", "bye");
  await peer.disconnect();
  ```
- [ ] `fixtures/grappaApi.ts` — opens `docker exec` into grappa container
  and runs `mix grappa.create_user` / `mix grappa.bind_network --auth ...`
  to seed. Returns a Bearer token (login via REST against grappa).
- [ ] `fixtures/seedData.ts` — Playwright global setup. Creates user `vjt`
  bound to `bahamut-test` network with autojoin `["#bofh"]`, returns the
  token. Tests start with this baseline.
- [ ] One smoke test `tests/_smoke.spec.ts` — peer connects, joins #bofh,
  sends one privmsg, asserts grappa persisted it via DB query (final
  sanity that the harness wires up correctly).

**Exit criterion**: smoke test green. Harness proven independently of any
specific bug.

### S3 — Port matrix M1-M12 (the work that proves the harness)

For each Mi from the manual matrix already exercised (see CP12 S44):

- [ ] Write `tests/mi-*.spec.ts` using fixtures + page object. Use
  `chromium` browser by default for speed; mark BUG7 spec `@webkit
  @iphone-15-pro`.
- [ ] Each spec opens cicchetto → logs in via fixture token → runs scenario
  → asserts DOM/sidebar/badge state via Playwright locators (no
  `page.evaluate` JS-soup unless absolutely necessary).
- [ ] Use Playwright `expect.poll` for WS-arrival waits (no `sleep N`).

**Exit criterion**: 12 specs, all green on chromium. M3, M6, BUG7 also
run on webkit+iPhone 15 device (BUG7 expected to FAIL pre-fix — it's the
red regression-pin we'll later flip green).

### S4 — `bug7-ios-own-msg-visible.spec.ts` — the iOS regression-pin

- [ ] Webkit + iPhone 15 device. Log in, focus #bofh, type via virtual
  keyboard simulation (Playwright touchscreen + tap on textarea), submit,
  assert msg becomes visible in `.scrollback` viewport within 2s.
- [ ] **First commit lands this spec RED on prod head**. The fact that
  it fails is the documented failure mode. The fix lands as a separate
  commit that flips it green.
- [ ] Add a related spec for cic → DM (M6 webkit variant) — same pattern.

**Exit criterion**: BUG7 spec is RED on `0b0cb33`. Doc'd in plan exit log.

### S5 — Fix BUG 7 (informed by what S4 reveals)

The fix shape can't be designed before S4 runs — webkit+device might
reveal: (a) WS suspend on keyboard show, (b) reactivity glitch, (c) CSS
overflow swallow, (d) something else. S4's failing test + Playwright trace
will pin the actual cause.

- [ ] Implement fix.
- [ ] BUG7 spec flips to GREEN.
- [ ] No regressions in M1-M12.

**Exit criterion**: full suite green on chromium + webkit. Deploy +
manual confirm on real iPhone.

### S6 — CI integration

- [ ] GitHub Actions workflow `.github/workflows/integration.yml`:
  - Runs on PRs touching `lib/**`, `cicchetto/src/**`, `cicchetto/e2e/**`.
  - `docker compose -f cicchetto/e2e/compose.yaml up --abort-on-container-exit`
  - Uploads Playwright traces as artifacts on failure.
- [ ] Add `scripts/integration.sh` to the canonical scripts table in
  CLAUDE.md.

**Exit criterion**: CI runs full suite on PR. Failure surfaces trace
viewer link.

### S7 — Extend coverage (post-MVP)

Once M1-M12 + BUG7 are green and CI-pinned, expand:

- [ ] NickServ identify flow (uses services from vjt/infra).
- [ ] SASL auth happy path + invalid creds.
- [ ] Capacity / admission (T31): spawn N peers, assert N+1 gets
  rejected with the right error.
- [ ] Image upload flow (next cluster).
- [ ] Mentions/away/watchlist (current C8 cluster).
- [ ] Offline / reconnect (kill grappa container mid-session, restart,
  assert client reconnects + replays).

These are tracked separately, not part of this plan's exit criteria.

## Decisions confirmed (2026-05-06, vjt)

1. **Testnet adoption shape**: submodule pinned to a SHA, at
   `cicchetto/e2e/infra/`. Repo lives at
   `git@github.com:vjt/azzurra-testnet.git` (renamed from `vjt/infra` —
   merged-to-main + deleted feature branches before adoption).
   Pinned SHA: `21e1c90` (current `azzurra-testnet@main` as of S0).
   To upgrade testnet: `cd cicchetto/e2e/infra && git fetch && git
   checkout <sha> && cd ../../.. && git add cicchetto/e2e/infra && git
   commit -m "bump testnet SHA"`.
2. **Grappa user seeding mechanism**: `docker exec` into the running
   `grappa` container for `mix grappa.bind_network` / `mix
   grappa.create_user`. Matches existing operator workflow — no new
   `/test/seed` REST surface.
3. **Headless browser default per spec**: chromium baseline + webkit
   opt-in for iOS-shaped specs (M3, M6, BUG7). Most-signal-per-cycle
   default. Webkit-only is too slow for the full matrix.
4. **Runner toolchain**: **Node 22** on the official `mcr.microsoft.com/playwright:v1.x-jammy` base image. Playwright ships Node + browsers (Chromium/Firefox/WebKit) preinstalled — re-deriving Bun on top is gratuitous when only the *runner* needs Node and the rest of cicchetto stays on Bun (separate container). One toolchain per container; no double-derivation.

## Out of scope for this plan

- Replacing or deleting the existing vitest unit tests in `cicchetto/src/`.
- Modifying production Phoenix/Solid code (BUG7 fix is separate from the
  harness work — happens in S5 once the test pins the failure).
- Migrating dev/prod compose layouts. Integration compose is a third,
  separate file under `cicchetto/e2e/`.

## Estimated cost

S0-S2: half a session (harness + smoke).
S3: half a session (12 specs, mechanical).
S4: quarter session (one device-specific spec + first failing trace).
S5: open-ended — depends on what BUG7's actual cause is.
S6: quarter session (CI workflow).

Total: ~2 sessions to land S0-S6 with the full M1-M12 + BUG7 RED→GREEN
pipeline plus CI gate. S7 is incremental from there.
