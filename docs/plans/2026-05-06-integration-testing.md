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
├── compose.yaml            # full testnet (vjt/infra-derived) + grappa + nginx + runner
├── playwright.config.ts    # webkit + iPhone 15 Pro device, Chromium for parity
├── fixtures/
│   ├── ircClient.ts        # node `irc-framework` wrapper — typed PRIVMSG/JOIN/PART verbs
│   ├── grappaApi.ts        # bind_network / create_user via mix-task SSH-into-grappa
│   └── seedData.ts         # default user `vjt`, peer `vjt-peer`, network `bahamut-test`
├── tests/
│   ├── m1-irssi-to-chan-focused.spec.ts
│   ├── m2-irssi-to-chan-defocused.spec.ts
│   ├── m3-cic-to-chan.spec.ts
│   ├── m4-irssi-to-priv-no-window.spec.ts
│   ├── m5-irssi-to-priv-window-open.spec.ts
│   ├── m6-cic-to-priv.spec.ts
│   ├── m7-peer-join-no-bouncer-follow.spec.ts
│   ├── m8-cic-join.spec.ts
│   ├── m9-cic-part-x-click.spec.ts
│   ├── m10-irssi-action.spec.ts
│   ├── m11-irssi-nick.spec.ts
│   ├── m12-passive-events.spec.ts
│   └── bug7-ios-own-msg-visible.spec.ts   # webkit + iPhone 15 — must FAIL on prod
├── package.json            # deps: @playwright/test, irc-framework, typescript
└── README.md               # how to run, how to add a spec, how to debug
```

### Why these technology choices

- **Playwright over Puppeteer/CDP**: native WebKit driver (closest non-
  device approximation of iOS Safari), built-in iPhone device descriptors,
  trace viewer for post-mortem, no manual sleep loops.
- **Node + `irc-framework` over Python pydle**: keeps the runner mono-
  language (TypeScript end-to-end), one Bun/Node process tree, fixtures
  importable directly into specs.
- **Bahamut + services from `vjt/infra`**: the user maintains a testnet
  repo with full Azzurra-shaped services (Bahamut + ChanServ/NickServ/
  OperServ). Adopting it gives us NickServ/SASL fidelity that a vanilla
  IRCd image (Unreal/Inspircd) wouldn't.
- **Tests live in `cicchetto/e2e/`**: Playwright is JS-native; the
  cicchetto repo already has a Bun toolchain. Mix would force a second
  language for trivial reasons.

## Plan (bite-sized, reviewable steps)

### S0 — Adopt vjt/infra testnet (preflight)

- [ ] Read `https://github.com/vjt/infra` README + compose layout
  (orchestrator does this once, posts summary to vjt for confirmation).
- [ ] Decide adoption shape: vendored copy in `cicchetto/e2e/infra/` OR
  git submodule. Submodule = upstream sync wins, but adds a `git submodule
  update --init` step. Vendor = self-contained, drift over time. Recommend
  **submodule** with pinned SHA, doc says "to upgrade testnet, bump SHA".
- [ ] Verify infra compose works standalone: `cd cicchetto/e2e/infra
  && docker compose up`, then `nc localhost 6667` → expect IRC banner
  from Bahamut.
- [ ] Pin a known-good upstream SHA. Document in plan.

**Exit criterion**: `cicchetto/e2e/infra` boots a working IRC testnet
on a deterministic port; `nc localhost 6667` shows a Bahamut welcome.

### S1 — Compose: stitch grappa + nginx + runner into the testnet

- [ ] `cicchetto/e2e/compose.yaml` extends infra's compose-file via
  `include:` directive (Compose v2.20+) — adds `grappa`, `nginx-test`
  (separate from prod nginx so ports don't collide), `playwright-runner`.
- [ ] grappa points at `irc://bahamut-test:6667` via env override
  (no host-DNS dep). Verify TLS verify_none stays on (already prod default).
- [ ] nginx-test serves cicchetto build at `http://cicchetto-test:80`.
- [ ] runner waits on healthchecks (grappa /healthz, bahamut connect,
  nginx 200) before launching tests.
- [ ] `scripts/integration.sh` — wrapper: `docker compose -f
  cicchetto/e2e/compose.yaml up --abort-on-container-exit playwright-runner`
  + tear-down on exit.

**Exit criterion**: `scripts/integration.sh` boots full stack, runs
empty-test-suite, exits 0. `docker compose ps` shows all services healthy.

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

## Open decisions to confirm before S0

1. **vjt/infra adoption shape**: submodule (recommended) vs vendored
   copy. **Default: submodule pinned to a SHA.**
2. **Grappa user seeding mechanism**: `docker exec` into running container
   for `mix grappa.bind_network`, or wire up a dedicated REST endpoint
   `/test/seed` available only in MIX_ENV=test. **Default: docker exec**
   — matches existing operator workflow, no new surface.
3. **Headless browser default per spec**: chromium (fast) with explicit
   webkit opt-in for iOS-shaped specs, or webkit-only (slowest, most
   faithful). **Default: chromium baseline + webkit for M3/M6/BUG7.**
4. **Node vs Bun for the runner**: Bun matches the rest of cicchetto
   tooling but Playwright support on Bun is shaky. **Default: Node 22
   for the runner only (`cicchetto/e2e/package.json`); rest of cicchetto
   stays Bun.**

If any of (1-4) need different defaults, update before S0 starts.

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
