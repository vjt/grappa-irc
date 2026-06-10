# Testing Grappa

The canonical "how to run tests" runbook. Every other doc points here;
this file points back at script comments + CLAUDE.md for rules.

If you find test-running instructions in another doc that contradict
this file, **this file wins**. Open a PR to delete the duplicate.

## The three gates

Grappa has three independent test stacks. They run in different
sandboxes, catch different classes of bugs, and live in different
directories.

| Gate              | Scope                          | Where the source lives           | How to run             |
|-------------------|--------------------------------|----------------------------------|------------------------|
| **Elixir**        | server logic, OTP, REST, channels | `test/grappa/`, `test/grappa_web/` | `scripts/test.sh`      |
| **cic vitest**    | TS unit tests in jsdom         | `cicchetto/src/__tests__/`       | `scripts/bun.sh run test` |
| **e2e Playwright**| full-stack browser flows       | `cicchetto/e2e/tests/`           | `scripts/integration.sh` |

The CI pipeline runs all three on every push to main. Both `ci.yml`
(Elixir + lint + audit + cic) and `integration.yml` (Playwright)
must be green for the commit to count.

## Quick reference

```bash
# Server (Elixir)
scripts/test.sh                          # full suite, --warnings-as-errors
scripts/test.sh test/grappa/foo_test.exs # one file
scripts/test.sh --only integration       # one tag
scripts/test.sh --seed 0                 # deterministic order (debug seed-dependent failures)
scripts/test.sh --cover                  # coverage

# cic (Solid / TS)
scripts/bun.sh run test                  # vitest
scripts/bun.sh run check                 # biome + tsc (lint + typecheck)

# Full CI gate locally
scripts/check.sh                         # mix ci.check + wireTypes drift gate + bats

# Individual gates (faster than check.sh for iteration)
scripts/format.sh --check                # mix format --check-formatted
scripts/credo.sh                         # mix credo --strict
scripts/dialyzer.sh                      # mix dialyzer
scripts/mix.sh --env=dev sobelow --config --exit Medium
scripts/mix.sh --env=dev deps.audit --ignore-advisory-ids GHSA-g2wm-735q-3f56
scripts/mix.sh --env=dev hex.audit
scripts/mix.sh --env=dev doctor

# Bash dispatchers (bin/grappa)
scripts/bats.sh                          # all bats specs under test/bin/
scripts/bats.sh test/bin/grappa_test.bats

# E2E (Playwright + real testnet)
scripts/integration.sh                   # full suite, cold bring-up + tear-down
scripts/integration.sh --grep "UX-6 K"   # one spec or pattern
scripts/integration.sh --project chromium --grep "UX-6 K"  # one project
scripts/integration.sh --project chromium --grep "UX-6 K" --repeat-each 3
KEEP_STACK=1 scripts/integration.sh ...  # leave testnet up after run for iterative debugging
scripts/testnet.sh up|down|status|logs <svc>|probe|shell <svc>
```

`scripts/check.sh` is the canonical pre-commit / pre-merge gate. Run it
clean before claiming LANDED — per `feedback_landed_claim_evidence`,
"LANDED" requires `scripts/check.sh` exit-0 with literal tail evidence,
not "format ✓ credo ✓ dialyzer ✓" hand-waving.

## Architecture: why the scripts exist

The container IS the runtime. **Never run `mix` or `bun` on the host.**
Every script is a thin wrapper around `docker compose run --rm <svc>
<task>` that:

* exports `CONTAINER_UID` / `CONTAINER_GID` from the host operator
  (so bind-mounted writes land with the right ownership — Linux
  hits this hard, Docker Desktop on macOS translates transparently);
* cd's to the **main** repo (worktree-aware via `scripts/_lib.sh`)
  so the docker compose project name + image cache + named volumes
  are shared across all worktrees;
* bind-mounts the **worktree's** source files (`lib`, `test`,
  `config`, `cicchetto/src`, etc.) so the code under test is the
  worktree's, not main's.

This means: from any worktree, `scripts/test.sh` runs the worktree's
Elixir source against the shared `_build`/`deps` cache. PLT, hex
mirror, bun cache survive across worktrees + sessions.

Bash 4+ required (`declare -ag` shebangs to `#!/usr/bin/env bash` so
PATH picks Homebrew bash 5 on macOS). `brew install bash` if missing.

## What each script actually runs

The authoritative source is the comment block at the top of each
`scripts/*.sh`. Two-line summary here:

* **`scripts/test.sh`** → `scripts/mix.sh --env=test test --warnings-as-errors "$@"`. Forces `MIX_ENV=test` (auto-detect would use the live container's env, usually dev/prod, breaking sandbox).
* **`scripts/check.sh`** → `scripts/mix.sh --env=dev ci.check` + `mix grappa.gen_wire_types --check` (wireTypes drift gate) + `scripts/bats.sh`. The `ci.check` alias (in `mix.exs`) chains: compile (warnings as errors), format check, credo, deps.audit, hex.audit, sobelow, doctor, `cmd env MIX_ENV=test mix test --warnings-as-errors`, dialyzer, docs. Mirrors CI exactly.
* **`scripts/bun.sh`** → oneshot `oven/bun:1` against `cicchetto/`. `run test` = vitest. `run check` = biome + tsc. `install`, `add`, etc. forward to bun.
* **`scripts/bats.sh`** → host-side bats v1.9.0 (submodule at `vendor/bats-core`) against `test/bin/`. NOT containerised — bats tests host-side bash dispatchers (`bin/grappa`).
* **`scripts/integration.sh`** → `scripts/testnet.sh up` → `docker compose run --rm playwright-runner npx playwright test "$@"` → trap-on-exit `scripts/testnet.sh down`. `KEEP_STACK=1` opts out of tear-down.
* **`scripts/testnet.sh`** → manages the stack standalone. `up` boots hub + leaves + services + grappa-test + nginx-test + seeder. `down` tears down + wipes `runtime/e2e/`. `probe` connects an oper-up client to leaf4 for `/links` + `/stats l`.

## The e2e stack

`scripts/integration.sh` orchestrates an all-in-one docker compose
stack (`cicchetto/e2e/compose.yaml`):

* **azzurra-testnet** (git submodule at `cicchetto/e2e/infra/`): hub + leaf-v4 + leaf-v6 + services. Bahamut IRCd + Anope-shape services so CAP/SASL/NickServ behave like real Azzurra.
* **grappa-e2e-seeder** (oneshot): runs `mix ecto.migrate` + seeds 3 users (`vjt`, `admin-vjt`, `m9b-test`, `m9b-victim`) + binds them to bahamut-test + seeds 200 scrollback lines on `#bofh`. Idempotent at clean-volume time only — re-seeding a non-fresh volume fails on duplicate user rows.
* **grappa-test**: the bouncer, dev image, source bind-mounted, points at `bahamut-test:6667`.
* **cicchetto-build-test** (oneshot): `bun install --frozen-lockfile && bun run build` into bind-mounted `runtime/e2e/cicchetto-dist/`.
* **nginx-test**: same nginx image + config shape as the Docker full-stack profile (`infra/nginx.conf` — prod proper is the m42 jail's nginx, `infra/freebsd/nginx.conf`); serves SPA dist + reverse-proxies grappa-test:4000.
* **playwright-runner**: official Playwright base, runs `npx playwright test` against `https://nginx-test` from inside the docker network.

Cold bring-up: ~30s. Suite (~190 specs across chromium + webkit-iphone-15
projects): ~3 min.

E2E test outputs land in `cicchetto/e2e/test-results/` (failure
artifacts: screenshot, video, trace.zip) and
`cicchetto/e2e/playwright-report/`. Open a trace with
`npx playwright show-trace <path>/trace.zip`.

## Triaging a failing e2e: cascade vs flake vs real bug

**Iron rule:** when one or more e2e specs fail in CI or in a full local
run, re-run each failing spec **in isolation 3 times** before doing
anything else.

```bash
scripts/integration.sh --project chromium --grep "<failing spec>" --repeat-each 3
```

The decision tree:

```
1. 3/3 ✓ iso  →  CASCADE (test-order state pollution from an upstream spec).
                  Filed as a follow-up bucket. DO NOT change production code.
                  See feedback_cascade_not_load + feedback_ci_cascade_rotating_set.

2. some ✘ + some ✓ →  FLAKE (race condition in the spec itself, OR a real
                       race in production).
                       - If the spec measures geometry / timing without a
                         poll-based wait, the spec is wrong: replace one-shot
                         `expect(x).toBe(y)` with `expect.poll(() => x).toBe(y)`.
                       - If production has a genuine race, fix prod with the
                         smallest possible change.
                       See feedback_recurring_e2e_not_flake.

3. 3/3 ✘ iso →  REAL REGRESSION. Investigate.
                Run `systematic-debugging` skill (Phase 1 root cause first,
                no fixes without it). Read the Playwright trace +
                screenshot + error-context.md in test-results/ before
                touching code.
```

**Common cascade signatures:**

* Same spec set fails across N runs but the SET ROTATES (run A fails
  X+Y, run B fails Y+Z, run C fails X+Z). Test-order state pollution
  by a single upstream poisoner whose damage is non-deterministic.
* Test passes 3/3 iso but fails after specs N-1, N-2, ... in the full
  suite. Bisect the spec roster: `scripts/integration.sh
  --project chromium --grep "<first half>|<failing spec>"` to find the
  offending upstream spec.
* Common poisoners: specs that mutate shared state on the seeded `vjt`
  user (advance read-cursor past head, change autojoin set, leave
  parked channel rows around).

**Common spec flake patterns:**

* boundingBox / scrollTop / clientHeight measured BEFORE the
  signal-driven effect that sets the relevant CSS property fires.
  Fix: `expect.poll(() => page.evaluate(() => ...)).toBeLessThanOrEqual(N)`.
* `await expect(locator).toBeVisible()` without scoping to one
  surface, picks up state from a sibling element re-rendered by
  unrelated traffic.
* Race between `selectChannel(ch, { ownNick })` (waits for JOIN
  scrollback line) and `windowStateByChannel[key] === "joined"`
  (waits for the typed `kind: "joined"` broadcast — separate event).
  If asserting on member-list-mounted state, wait on
  `.shell-members .members-pane` visibility, not the JOIN line.

**Never** `gh run rerun --failed`. First run IS the truth — see
`feedback_no_ci_retries_on_first_failure`. Reproduce locally with
`--repeat-each` instead.

## Test isolation: the global `max_cases: 1` lane

`config :ex_unit, max_cases: 1` in `config/test.exs` is **load-bearing**
for the singleton-class modules (`Grappa.Session.Backoff`,
`Grappa.Admission.NetworkCircuit`, `Grappa.WSPresence`,
`Grappa.AdminEvents`, `GrappaWeb.Admin.AdminChannel`, anything that
spawns supervised pids).

Any new test that touches a singleton-class module **MUST** be
`async: false` AND respect `max_cases: 1`. New singletons MUST add a
`## Test isolation` moduledoc explaining why.

Before adding `config :ex_unit, KEY:` ANYTHING: grep `test/test_helper.exs`
for `ExUnit.start(...)` opts — opts there silently override config. See
`feedback_exunit_start_overrides_config`.

## Test-class gotchas (memory pointers)

These bite during cluster work; check the memory before re-investigating.

* **Minifier mangles identifiers** (`feedback_minifier_mangles_identifiers`) — never verify a cic bundle ships your source change by grepping the minified output for an identifier name. esbuild/vite mangle locals to one letter. Verify via: (a) bundle hash change, (b) sourcemap `sourcesContent` grep, (c) inserting a literal string sentinel that survives minification.
* **Dialyzer PLT staleness** (`feedback_dialyzer_plt_staleness`) — multi-session cluster work: PLT cache hides latent warnings. Run `scripts/dialyzer.sh` standalone before LANDED.
* **check.sh + uncommitted edits = false-pass trap** (`feedback_check_sh_working_tree_trap`) — auto-fix → unstaged → `check.sh` sees the fix → CI sees HEAD without the fix. Verify `git diff --quiet HEAD` after a green check.
* **Bind-mount shadows image-baked artifacts** (`feedback_bind_mount_shadows_image`) — `./:/app` overlays the image's pre-baked `_build`/`deps`. First boot in a fresh container does `mix deps.get` + cold compile.
* **Named volume + UID-drop = root-owned init trap** (`feedback_named_volume_uid_trap`) — fresh named volume is root:root; container `user:` drop hits perm-denied. Use bind-mounts (e2e stack does this for `runtime/e2e/*`).
* **e2e visitor specs must assert members-list presence** (`feedback_e2e_visitor_members_list`) — every visitor / channel-join e2e MUST verify the members list count > 0 AND own nick included post-JOIN. Otherwise a half-failed JOIN ships green.
* **Cicchetto bucket browser smoke** (`feedback_cicchetto_browser_smoke`) — every cic-touching bucket MUST run a real browser smoke at close. jsdom is blind to CSS regressions.
* **UX behavior e2e mandatory** (`feedback_ux_e2e_mandatory`) — every cic UX-behavior change ships with a Playwright e2e. vitest jsdom insufficient.
* **DOM input-event complete set** (`feedback_dom_input_event_complete_set`) — pointerdown does NOT cover wheel rotation per W3C. Audit pointerdown + wheel + touchmove + keydown for input-gate listeners.
* **Bahamut U-line is per-ircd local conf** (`feedback_bahamut_uline_per_ircd`) — `FLAGS_ULINE` requires per-leaf `U:services` line; SVSMODE silently drops at IsULine otherwise. Bites when adding new testnet leaves.
* **Visitor mint e2e 504 from cold-start** (`feedback_visitor_mint_e2e_cold_start`) — `POST /auth/login {identifier: nick}` exceeds `login_probe_timeout_ms` on first IRC connection. Pre-seed at compose time, NOT mint at test time.
* **`docker compose up --wait` fails on oneshot exit** (`feedback_compose_wait_oneshot_exit`) — `--wait` treats oneshot's normal exit as healthcheck fail. Use `compose run --rm` for oneshots.

## When the test stack itself is broken

* **`vendor/bats-core` not found** → `git submodule update --init vendor/bats-core`.
* **`cicchetto/e2e/infra` empty (fresh git worktree — worktrees don't inherit submodules)** → now AUTO-initialised by `scripts/testnet.sh` on first `up`. Manual fallback if the auto-init fails: `git -C <worktree> submodule update --init cicchetto/e2e/infra`.
* **`runtime/e2e/{cicchetto-dist,grappa-runtime}` left ROOT-OWNED → next `testnet up` aborts** (symptoms: cicchetto-dist `AccessDenied`, sqlite `database_open_failed`, `"Pool overlaps with other one on this address space"`). A prior run can write these as uid 0 despite the `--user` drop; a plain `rm` can't clear them. Now AUTO-cleaned: `testnet.sh up`/`down` use `e2e_force_rm` (plain rm → non-interactive `sudo` for root-owned survivors; see `scripts/_lib.sh`). No passwordless sudo → it warns and you run `sudo rm -rf runtime/e2e/* cicchetto/e2e/test-results/*` by hand. **`git worktree remove` blocked** by root-owned `cicchetto/e2e/test-results/*` (Playwright writes failure artifacts as root, intentionally kept) → `sudo rm -rf <worktree-dir>` then `git worktree prune`.
* **`services.hub conflicts with imported resource`** (compose config parse) → docker compose is too old for the `include:` + per-service override pattern. Install **v5.0.2** (the CI pin in `.github/workflows/integration.yml`) into `~/.docker/cli-plugins/docker-compose` — user-local, no sudo. Stock distro plugins (e.g. Debian's 2.26.1) reject it.
* **`checking context: no permission to read .../nginx-certs/nginx.key`** (image build) → running e2e as a NON-root user: `nginx-cert-init` writes the key root-owned 0600, and the classic (non-buildx) builder tars the context as the invoking user. Fixed in-repo via `.dockerignore` exclusions (root + `cicchetto/e2e/`); if it recurs, a new build context is pulling in the cert dir — add it to that context's `.dockerignore`. CI builds as root so never hits this.
* **`Exqlite.Connection ... database is locked`** during `scripts/test.sh` → benign log noise from concurrent test teardown; the test still passes. If it ESCALATES to a failure, check `config/test.exs` pool size + `max_cases`.
* **Bundle hash unchanged after a cic source edit** → not a cache bug (almost certainly). Verify via the sourcemap, then check that `tsc --noEmit` didn't silently fail by running `scripts/bun.sh run check` directly. See `feedback_minifier_mangles_identifiers`.
* **`scripts/check.sh` hangs at the bats step in dev shell** → known sandbox-mode interaction; run gates individually for the duration of the session.
* **`scripts/integration.sh` reports oneshot exit as failure** → likely `--wait` on a oneshot service; see `feedback_compose_wait_oneshot_exit`.

## Cross-references

* **CLAUDE.md** — Testing Standards section: rules (what to assert, what NOT to weaken, mock-at-boundaries, property tests). This file is the HOW; CLAUDE.md is the WHY.
* **Script comment headers** — `scripts/<name>.sh` first 30 lines. Authoritative for flags + behavior; this file may lag.
* **`.github/workflows/ci.yml` + `integration.yml`** — what CI actually runs. Identical to local `scripts/check.sh` + `scripts/integration.sh` modulo cache strategies.
* **Memory** — `feedback_*` memories at `/Users/mbarnaba/.claude/projects/-Users-mbarnaba-code-grappa/memory/`. Each gotcha above links to one.
