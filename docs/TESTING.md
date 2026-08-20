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
scripts/bun.sh run check                 # lock drift + biome + tsc — src AND e2e (#484); all 4 stages, union of failures (#1469)

# Full CI gate locally
scripts/check.sh                         # mix ci.check + wireTypes drift gate + bats

# Individual gates (faster than check.sh for iteration)
scripts/format.sh --check                # mix format --check-formatted
scripts/credo.sh                         # mix credo --strict
scripts/dialyzer.sh                      # mix dialyzer
scripts/mix.sh --env=dev sobelow --config --exit Medium
scripts/mix.sh --env=dev deps.audit      # hard CVE gate — NO ignore list, same as CI
scripts/mix.sh --env=dev hex.audit       # advisory-only (#147); ci.check runs it `|| true`
scripts/mix.sh --env=dev doctor

# Bash dispatchers (bin/grappa)
scripts/bats.sh                          # all bats specs: test/bin/ test/infra/ test/scripts/
scripts/bats.sh test/bin/grappa_test.bats

# Release image — deploy it for real and probe it (#1162).
# Read the number from VERSION rather than hardcoding one: a literal
# here goes stale at the next release and nothing fails when it does.
V=$(cat VERSION)                         # 1.2.0 as of this line
docker pull ghcr.io/vjt/grappa:v$V
GRAPPA_IMAGE=ghcr.io/vjt/grappa:v$V GRAPPA_SMOKE_VERSION=$V \
  scripts/smoke-release-image.sh

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

**NEVER run `docker`, `docker run`, `docker exec`, or `docker compose`
directly — on the host or from an agent.** The agent-security-guardrails
hook prompts on EVERY raw docker invocation, which wedges an unattended
session indefinitely (a ~55-minute stall while vjt was away, 2026-07-14).
ALWAYS go through an allowlisted `scripts/*.sh` wrapper
(`scripts/test.sh`, `scripts/check.sh`, `scripts/bun.sh`,
`scripts/integration.sh`, `scripts/testnet.sh`, `scripts/db.sh`,
`scripts/mix.sh`, …) — never the raw command. If no wrapper covers what
you need, add one (or extend an existing script); do not reach for raw
docker "just this once." This is a hard rule: the wrappers are the ONLY
sanctioned door to the container runtime.

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

**Invoke scripts from the worktree ROOT, not a subdir.** `_lib.sh` sets
`SRC_ROOT="$PWD"` only when the cwd is a git-worktree root (detected by
`lib/` + a `.git` *file*); from anywhere else — including the worktree's
own `cicchetto/` subdir — it falls back to the **main** repo. So
`scripts/bun.sh run test` / `run check` run from `<worktree>/cicchetto`
silently tests / typechecks **main's** source, passes green, and never
touches your worktree changes. The tell: the test COUNT doesn't move when
your new tests should have added to it — or `run check` reports 0 tsc
errors on a type error you KNOW you just introduced (a brand violation, a
new `error TS`), because it's typechecking main, not your branch. Always
`cd <worktree-root>` first; verify a run hit the worktree by checking the
count reflects your additions, or that a deliberate error is actually
caught.

**A red `run check` covers every stage, and says so (#1469).** It used to be
`biome check && tsc --noEmit && tsc --noEmit -p e2e/tsconfig.json`, so a red
told you the FIRST stage failed and nothing about the rest — and formatting,
the cheapest and most frequent failure, sat first. Measured three times in one
day, a cosmetic complaint hid two, then three, genuine type errors for as long
as it lasted. `cicchetto/scripts/check.ts` now runs every stage and exits
non-zero if ANY did, closing with `check summary — N stages ran, M failed`.
Read that line: it is what tells you the red is complete. It also passes
`--max-diagnostics=none`, because biome's default ceiling of 20 truncated the
one real error behind this tree's 59 standing warnings — a red naming no file
at all. `run build` still short-circuits on purpose: there `tsc` is a
precondition for `vite build`, which WRITES `dist/`, so the second stage must
not run when the first is red.

**`scripts/bun.sh run build`/`run check` can FALSE-PASS a type error in a
`src/__tests__/*` file.** `tsc`'s incremental `*.tsbuildinfo` cache (under
`node_modules/.tmp/`) lets a stale build skip re-checking a changed test
file, AND vitest never typechecks (esbuild strips types), so a bad
type-only import (e.g. importing a non-re-exported type) sails through
both gates while the **e2e `cicchetto-build-test`** (clean `oven/bun:1`,
no warm cache) fails the whole suite with `error TS####`. The authoritative
cic type gate is therefore the e2e build, not a worktree `bun run build`.
To get the honest answer locally without the full e2e: `find cicchetto
-name '*.tsbuildinfo' -delete` then re-run `scripts/bun.sh run build`. For
the clean-cache truth, run the full e2e (`scripts/integration.sh`) — its
`cicchetto-build-test` stage is the warm-cache-free build. Do NOT hand-roll
a raw `docker run oven/bun:1 …` to replicate it (that trips the docker
guardrail above); the e2e stage already IS that clean build, through the
wrapper.

**`run check` is the ONLY static gate over `cicchetto/e2e` (#484).**
`scripts/check.sh` runs no cic gates at all, and the Playwright runner
esbuild-strips types without checking them, so before #484 the e2e suite had
no typecheck and no lint anywhere — 26 type errors had accumulated across 18
files, four of them always-false comparisons. `check` is now `biome check &&
tsc --noEmit && tsc --noEmit -p e2e/tsconfig.json`, and biome's
`files.includes` covers `e2e/**`. Both compile through **cicchetto's**
TypeScript (`e2e/package.json` no longer carries one of its own — one repo,
one compiler version, pinned by `cicchetto/bun.lock`). The e2e project's own
deps (`@playwright/test`, `@types/node`, `irc-framework`) come from
`e2e/package.json`; `scripts/bun.sh` installs them on demand exactly as it
does `cicchetto/node_modules`, and the CI job runs `bun install --cwd e2e`
before `bun run check`. To run just the e2e half:
`scripts/bun.sh x tsc --noEmit -p e2e/tsconfig.json`.

**A fresh worktree has no `node_modules`, and the failures that produces
look like your code.** `vitest`, `tsc`, `vite` and `biome` all live in
`cicchetto/node_modules`, which is per-worktree — unlike the bun download
cache at `runtime/bun-cache`, which every worktree shares. Without an
install the first `run test` / `run build` / `run check` dies with
`vitest: command not found` (exit 127 — no toolchain, not a test
failure), and the e2e half of the #484 gate fails with `Cannot find type
definition file for 'node'`, which is an ABSENT TOOLCHAIN reported as a
type error: do not go hunting for the bad import. `scripts/bun.sh`
self-heals both trees, pre-installing on demand for every non-install
verb. Either signature means you invoked something other than the
wrapper, or the install failed earlier in the same run — scroll up.

**A worktree that ran the testnet has an `e2e/node_modules` that exists
and is EMPTY**, because `cicchetto/e2e/compose.yaml` mounts a named volume
at `/work/node_modules` inside the `.:/work` bind and docker materialises
that mount point on the host. Until #1311 the self-heal tested existence
only, so those worktrees skipped the install and hit the `@playwright/test`
signature above; the guard now tests for CONTENT, and absence and
emptiness are one state. If you see the self-heal install on a tree that
looks populated, check whether it holds anything.

**A populated `node_modules` can still be the WRONG one, and `check`'s
first stage is what says so (#1571).** The self-heal above asks whether the
tree has content, never whether that content is what `bun.lock` pins — and
#1571 measured a main checkout whose biome was three minor versions off the
lock, silently cloned into every worktree by the documented `cp -Rc`
procedure. A verdict from an unpinned toolchain is unattributable in both
directions: a rule that only fires on the newer version passes here and
fails in CI, and one that only fires on the older fails here against code
CI would accept. The `lock drift (node_modules vs bun.lock)` stage compares
the two and names every package that disagrees; the cure it prints is
`scripts/bun.sh install --frozen-lockfile`. It exits **3** without printing
any number when one of its own known-answer controls fails, so a zero from
it is never the sound of an instrument that measured nothing.

**Documented limitation: the stage does NOT judge binaries for another
platform, and those CAN be stale.** biome and rolldown ship a JS wrapper
plus one binary package per platform, and `bun install` only resolves the
one matching the platform it runs on. Every gate here runs bun inside a
LINUX container, so on a macOS host the `*-darwin-*` packages are whatever
the last host-side install left — measured 2026-08-20:
`@biomejs/cli-darwin-arm64` at 2.4.13 against a lock pinning 2.5.8, three
months older than its linux siblings, while the container executed the
pinned 2.5.8 from the same tree. No gate reaches them (`bun`, `bunx` and
`biome` are not on the host PATH, and nothing outside the container invokes
them), and no command the project documents can refresh them, so making the
gate red on them would be a red nobody could clear. What CAN reach them is
a direct `cicchetto/node_modules/.bin/<tool>` call or an editor
integration: if you use one, read its version yourself
(`./cicchetto/node_modules/.bin/biome --version`) and do not treat its
verdict as the gate's.

**`scripts/bun.sh run check` counts a biome FORMAT violation as an
ERROR, and hides which file it came from.** `check` starts with `biome
check`: a line biome would reflow (a long `foo({ a, b, c })`
call it wants multiline, say) is enough to exit 1 — and `&&` then skips
`tsc` entirely, so the type gate never runs. The diagnosis is the hard
part, because biome truncates its own output: your file's error can sit
inside "Diagnostics not shown: N" while the listed files are ones you
never touched, and the summary reads only `Found 1 error`. `grep "error
TS"` finds nothing, because it is not a tsc error. `mix format` does not
cover cic, so nothing else catches it first.

So **format before you gate**: after editing any `cicchetto/src/**` or
`cicchetto/e2e/**` file, run `scripts/bun.sh x biome check --write <the files
you touched>` — your files ONLY, never a bare `--write`, which reformats
unrelated files and balloons the diff. To read the real diagnostic instead of the
summary, isolate it: `scripts/bun.sh x biome check <your files>
--max-diagnostics=100`. Do NOT append `--max-diagnostics` to `bun run
check` — the composite script forwards it to `tsc`, which rejects it.

Bash 4+ required (`declare -ag` shebangs to `#!/usr/bin/env bash` so
PATH picks Homebrew bash 5 on macOS). `brew install bash` if missing.

## What each script actually runs

The authoritative source is the comment block at the top of each
`scripts/*.sh`. Two-line summary here:

* **`scripts/test.sh`** → `scripts/mix.sh --env=test test --warnings-as-errors "$@"`. Forces `MIX_ENV=test` (auto-detect would use the live container's env, usually dev/prod, breaking sandbox).
* **`scripts/check.sh`** → `scripts/mix.sh --env=dev ci.check` + `mix grappa.gen_wire_types --check` (wireTypes drift gate) + `scripts/bats.sh`. The `ci.check` alias (in `mix.exs`) chains: compile (warnings as errors), format check, credo, deps.audit, hex.audit, sobelow, `cmd env MIX_ENV=test mix doctor`, `cmd env MIX_ENV=test mix test --warnings-as-errors`, dialyzer, docs. Doctor shells out to `:test` since #621: in `:dev` it counts a module's functions from the source AST but reads doc/spec presence from the beam, so every `Mix.env() == :test`-gated helper is scored as undocumented, and `elixirc_paths` omits `test/support` there. `:test` is a strict superset on both axes, and matches the workflow's single `mix doctor` step. The `ci` workflow runs the same gates — including the wireTypes drift check since #767 — but it re-lists them by hand in YAML rather than invoking this script, so the two lists mirror each other only for as long as someone keeps them in step. A gate added here is not in CI until it is added there too; #767 was one instance of that (the drift gate was local-only, and a stale `wireTypes.ts` survived a merge with CI green).
* **`scripts/bun.sh`** → oneshot `oven/bun:1` against `cicchetto/`. `run test` = vitest. `run check` = the lock-drift stage (#1571) + biome + tsc over `src` AND `e2e`. `install`, `add`, etc. forward to bun.
* **`scripts/bats.sh`** → host-side bats v1.9.0 (submodule at `vendor/bats-core`) against `test/bin/`, `test/infra/` and `test/scripts/`. NOT containerised — bats tests host-side bash (`bin/grappa`, the deploy scripts, the cloud installer). There is no compose involvement in the runner: the container is reached only transitively, when a test exercises a verb that shells out to docker, and those tests stub `docker` on `PATH` rather than touching a real one. So this gate needs no stack up.
* **`scripts/release-image.sh`** → the RELEASE image (`Dockerfile.release`), not the compose dev stack. `build` buildx-loads it locally; `fresh-boot` wipes the scratch volume and bare-runs it with nothing but `PHX_HOST` (the documented one-liner — the point is that everything else must come from the image and the volume); `warm-boot` does the same on the EXISTING volume; `oneshot <args…>` runs a throwaway container against that volume; `logs` / `down [--volume]` clean up. This is the reproduction for #862 and #867, both of which were found by hand-typing docker commands because no wrapper reached this artifact.
* **`scripts/smoke-release-image.sh`** → brings a box up from `$GRAPPA_IMAGE` through the real `infra/docker/get.sh` → `deploy.sh` release path (`GRAPPA_RAW_BASE=file://<checkout>`, so get.sh's mirror list is under test too), then probes it over HTTP and tears everything down. Dedicated container/volume names (`grappa-smoke*`), so it cannot eat an operator box. Requires the image to be present locally — **an unavailable image fails the run, it never skips it**. See "The release-image smoke" below.
* **`scripts/integration.sh`** → `scripts/testnet.sh up` → `docker compose run --rm playwright-runner npx playwright test "$@"` → trap-on-exit `scripts/testnet.sh down`. `KEEP_STACK=1` opts out of tear-down.
* **`scripts/testnet.sh`** → manages the stack standalone. `up` boots hub + leaves + services + grappa-test + nginx-test + seeder. `down` tears down + wipes `runtime/e2e/`. `probe` connects an oper-up client to leaf4 for `/links` + `/stats l`.

**`check.sh` pins the whole run to `MIX_ENV=dev`** because `ci.check`
invokes credo, sobelow and ex_doc, all `only: [:dev, :test]` deps. Exactly
two sub-steps escape the pin with `cmd env MIX_ENV=test`: the test run
(inside an alias a bare `mix test` inherits `:dev`, so the Repo never gets
the Sandbox pool and the run is corrupt) and, since #621, doctor.

**There is exactly ONE doctor run and it lives in the alias — do not add
a second to `scripts/check.sh`.** #75 (a four-red-commits post-mortem)
once added a second one, because the alias's doctor was pinned to `:dev`
and so never scanned `test/support` the way the GitHub job does. That
left two runs, one of them scoring every `Mix.env() == :test` seam as
undocumented. Making the alias's run the `:test` one collapses them into
a single honest run identical to the workflow's single `mix doctor` step
— local equals CI by construction rather than by hand. Re-adding the
second run re-opens both defects.

## The release-image smoke (#1162)

`test/infra/`'s 20+ bats suites cover the deploy **scripts** with `docker`
stubbed on `PATH`: every assertion is about which file a verb writes and
which flags it would pass. That leaves one class completely uncovered —
the deployment that succeeds at every script step and is still broken,
which is exactly #1161 (container up, API answering, env well-formed,
frontend 404 because a variable pointed one directory to the left).

`scripts/smoke-release-image.sh` is the gate for that class. It runs in
`release.yml`'s `smoke` job — on a tag against the **published**
`ghcr.io/<owner>/grappa:v<version>`, and on a `docker_validation` dry-run
against the amd64 image re-exported from that run's build cache (which is
what finally makes the documented "mandatory workflow_dispatch smoke
before a real tag" smoke something). It is also runnable by hand, see the
quick reference.

Three probes, and every assertion has a mutant that kills it — measured,
not asserted. Reproduce any row by deriving a one-line mutant image
`FROM ghcr.io/vjt/grappa:latest` and pointing `GRAPPA_IMAGE` at it:

| Assertion | Mutation that kills it | Observed |
|---|---|---|
| `GET /` is 2xx | `ENV CIC_DIST_ROOT=/app/cicchetto-dist/assets` (#1161 verbatim) | 404 |
| the body parses to a bundle hash | mangle the `<script type="module">` tag in `index.html` | 200, no tag |
| the named chunk arrives as JavaScript | `RUN rm -rf /app/cicchetto-dist/assets` | 200 `text/html` |
| `/api/config` reports the expected version | deploy an older published tag | reports the older version |
| a restart keeps `/data/grappa.env` | drop the `[ ! -f "$secrets_file" ]` guard from the entrypoint | hash changes |

Two of those are worth knowing on their own. **A missing hashed chunk is
served as the SPA shell with 200 and `content-type: text/html`** —
`Plug.Static` misses and the history fallback answers, so a browser gets
HTML where it expects a module and white-screens; status-only assertions
are blind to it. And **the never-rotate probe needs a second container
shape**: under `deploy.sh` every secret rides in from the host env file,
so the entrypoint's first-boot bootstrap (#862) never fires there. Only a
bare `docker run` with just `PHX_HOST` generates them onto `/data`.

What it deliberately does NOT cover: one architecture (whatever the host
runs — the arm64 leg of the manifest is proven by the build, not here);
no IRC at all (no upstream connect, SASL or scrollback — that is
`scripts/integration.sh`'s job, against the SOURCE image); no TLS front
door or real `PHX_HOST`; and the `update` verb (only `install` plus a
bare-run restart).

## The e2e stack

`scripts/integration.sh` orchestrates an all-in-one docker compose
stack (`cicchetto/e2e/compose.yaml`):

* **azzurra-testnet** (git submodule at `cicchetto/e2e/infra/`): hub + leaf-v4 + leaf-v6 + services. Bahamut IRCd + Anope-shape services so CAP/SASL/NickServ behave like real Azzurra. Note `cicchetto/` itself is **not** a submodule — it is a plain subdirectory of this repo; `.gitmodules` lists only `cicchetto/e2e/infra`, `vendor/bats-core` and `frontends/shottino/vendor/libdatachannel`.
* **solanum-test2** (`cicchetto/e2e/infra-solanum/`, #221): a standalone **solanum** ircd — the ircd Libera.Chat runs — backing the second network `azzurra2`. Replaced the second bahamut so integration tests exercise grappa's parser against the real Libera-shaped WHOIS/usermode/WHO-mask surface, not a bahamut mock. Plaintext-only (grappa dials `--no-tls`), standalone (no S2S), built from the solanum tree via meson (pin with `SOLANUM_REF`, default `main`). Keeps the `bahamut-test2` docker-network alias so the azzurra2 seed + the #211 multi-network specs resolve the same hostname unchanged.
* **grappa-e2e-seeder** (oneshot): runs `mix ecto.create` + `ecto.migrate`, then seeds the built-in theme gallery, **ten users**, **four** network binds, 200 scrollback lines on `#bofh` (sender `seed-bot`, on `vjt`'s bind), the three visitor-enabled networks (`azzurra`, `azzurra2`, `azzurra3`) + their servers, and a `bahamut-test` user-cap bump to 10. Bound: `vjt`, `m9b-test`, `m9b-victim` → `bahamut-test`; `wiz-test` → `azzurra-reg` (#349's registration wizard). **Bindless on purpose:** `admin-vjt` (created, then promoted `is_admin` by a `mix run`), `i498-user`, `flood-victim`, `fresh405`, `accr481`, `mute1038` — each of those specs either accretes a network at runtime or asserts the empty-networks state. **That zero-bind property is load-bearing for the readiness gate:** `loginAs` waits on the per-network header (`.sidebar-network-header` desktop / `.bottom-bar-network-header` mobile), which an account with no credential never renders — hence the `noNetworks: true` opt-in, which waits on `.home-pane-registered` instead. Take the default branch on one of the six and you get a 10 s `SHELL_READY_TIMEOUT_MS` timeout rather than a signal. Idempotent at clean-volume time only — re-seeding a non-fresh volume fails on duplicate user rows.
* **grappa-test**: the bouncer, dev image, source bind-mounted, points at `bahamut-test:6667`.
* **cicchetto-build-test** (oneshot): `bun install --frozen-lockfile && bun run build` into bind-mounted `runtime/e2e/cicchetto-dist/`.
* **nginx-test**: a DUMB reverse proxy (`cicchetto/e2e/nginx-test.conf`) that terminates TLS on :443 (so the cic SW + Push get a secure context) and forwards everything to grappa-test:4000. Since #485 it serves nothing itself — grappa-test self-serves the SPA + static + PWA manifest and emits the security headers (`GrappaWeb.Plugs.SecurityHeaders`). It shares the substrate-agnostic proxy snippet (`infra/snippets/locations-api.conf`) with native Linux (`infra/linux/nginx.conf`) + the AWS box (`infra/cloud/first-boot.sh` fetches it), so the CSP + Range parity specs exercise the REAL prod header surface through the proxy. The m42 jail is NOT in that set any more — its nginx was deleted and the host vhost proxies straight to the BEAM.
* **playwright-runner**: official Playwright base, runs `npx playwright test` against `https://nginx-test` from inside the docker network.

Cold bring-up: ~30s, suite ~3 min — both wall-clock figures inherited
from an earlier run, not re-measured. Size of the suite, counted statically on
`cicchetto/e2e/tests/*.spec.ts` (not from a run): **411 spec files**
declaring **755** cases (750 `test(` + 5 `test.skip(`, line-anchored).
That is a floor, not the collected total — 101 of those files build
cases inside a loop, and the two Playwright projects **partition** the
set rather than duplicate it (`chromium` is `grepInvert: /@webkit/`,
`webkit-iphone-15` is `grep: /@webkit/`). For collected counts, read
what a real run reports; the figures quoted in trap 4 below are runtime
numbers and were not re-measured here.

E2E test outputs land in `cicchetto/e2e/test-results/` (failure
artifacts: screenshot, video, trace.zip) and
`cicchetto/e2e/playwright-report/`. Open a trace with
`npx playwright show-trace <path>/trace.zip`.

**A trace's screencast metadata lies about frame size.** Unzipped,
`0-trace.trace` declares the screencast at the DEVICE resolution
(e.g. `1179x1977` for `webkit-iphone-15`) while the JPEGs it points at
are written at the CSS resolution (`391x657`) — off by the device pixel
ratio, and off in the direction that makes a measured pixel look 3×
further along than it is. Measuring a frame against the declared size
flips the conclusion, which is how the #1050 diagnosis went the wrong
way once. Run `sips -g pixelWidth -g pixelHeight <frame>.jpeg` and scale
against THAT before turning a frame pixel into a CSS px.

Those are the BROWSER half. On a non-zero exit `scripts/integration.sh`
also dumps one log file per container to `cicchetto/e2e/container-logs/`
(#702), from inside its EXIT trap — before the tear-down in that same
trap destroys the containers. The service set is derived from
`docker compose ps`, so a service added later is covered without editing
anything. Failure-only: a green run writes nothing. The `integration`
workflow uploads the directory as the `container-logs` artifact
alongside the trace + report, so a CI-only red can be read from the
server side too instead of stopping at the browser.

**Per-spec subject (#1078).** Every spec gets its OWN throwaway user
rather than sharing the seeded `vjt`: the `_specSubject` `auto: true`
fixture (`cicchetto/e2e/fixtures/test.ts`, alongside `_cspGuard` and
`_unrouteGuard`) calls `provisionSpecSubject`
(`cicchetto/e2e/fixtures/specSubject.ts`) → `POST /admin/test/subject`
before the test and `teardownSpecSubject` → `DELETE
/admin/test/subject/:name` after it. The name is `s<first 8 hex of
sha1(titlePath)>` — derived from the test's title, not a counter, so
`--grep` and the full suite provision the same name and a failure log
points back at something. The subject is bound to `bahamut-test`,
autojoins `#spec-w<TEST_PARALLEL_INDEX>` and gets 200 scrollback lines
from `seed-bot`; a teardown whose subject is already gone throws rather
than passing quietly. Both endpoints live in a scope compile-gated to
`:dev`/`:test` (the module + route literally do not exist in the prod
release).

`POST /admin/test/reset-subject` — the older restore-`vjt`-to-baseline
door — is still routed and still called EXPLICITLY by 9 specs via
`resetSubject` (`fixtures/grappaApi.ts`); the router comment says it
goes when the last of them does. It is no longer what runs
automatically after every test. Cascades therefore come from state
outside a per-spec subject's lifetime: the seeded users, the shared
worker channel, testnet-side IRC state.

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
                🔴 EXCEPT when the run printed a #1584 cold-start
                violation: an iso-rerun is the MOST first-in-project a
                spec can be, so for a boot-timing-sensitive spec it
                manufactures the red it is supposed to be diagnosing.
                Read the next section before believing branch 3.
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
* Sidebar / bottom-bar locators matched by `hasText` substring instead
  of exact text resolve to the WRONG row when window names collide
  (`#bofh` ⊂ `#bofh-test`, `peer` ⊂ `peer2`). Match exact text — a
  regex anchor like `/^#bofh$/`, not a substring.

**Never** `gh run rerun --failed`. First run IS the truth — see
`feedback_no_ci_retries_on_first_failure`. Reproduce locally with
`--repeat-each` instead.

## The cold-start census: position in the project is an INPUT (#1584)

`workers: 1`, `fullyParallel: false`, two projects — so **exactly one
test per worker pays the browser launch**, and every later test in that
worker runs against an already-running browser. Which test that is comes
from filename sort order plus *which files the invocation collected*, so
**it changes when you scope a run and it changes when somebody adds an
earlier-sorting spec**, with no edit to the affected spec and no line in
any diff pointing at it.

Measured on #1543: the `@webkit` arm of
`issue310-scroll-to-bottom-btn-cursor.spec.ts` is red 4/4 in that seat
and green 3/3 behind any other `@webkit` test — and a bare open with no
assertions is red in the same seat. In the full suite it passes, dozens
of files deep.

**Every run now prints the value of that input**, green runs included:

```
#1584 cold-start census — the first test each Playwright worker began.
  webkit-iphone-15 / worker 0: bug7-ios-own-msg-visible.spec.ts > ... [undeclared]
```

Read it before reading a result you are about to act on. If your spec is
NOT in that list, it ran warm.

**More rows than projects means workers were restarted.** Playwright
discards a worker after a failed test, so **every red mints a fresh cold
seat for whatever ran next** — measured on the 759-test suite, 4 failures
turned the expected 2 cold seats into 6, and in each case the spec that
inherited the seat was simply the next one in the roster. That is the
cascade mechanism the tree above calls "state pollution", with a second
carrier nobody had named: not shared state, but a cold browser.

**Two tags let a spec declare which side it needs.** Both come from
`e2e/reporters/coldStartLedger.ts` — import the constant, never retype
the string — and both are declared through Playwright's `{ tag }`
option so the title stays greppable:

| tag | means | the run FAILS when |
|---|---|---|
| `@warmstart` | only meaningful behind another test | the invocation promoted it to its worker's head |
| `@coldstart` | only exercised on the worker's first test | anything preceded it in that worker |

The failure is a **run-level** red printed by the reporter, not a test
red: the offending test may well be green, and that green is the
problem. Nothing above the violation block is a product verdict.

A `@warmstart` spec therefore **cannot be run alone** — that is the
point, not a limitation to work around. Run it behind another spec of
the same project (`scripts/integration.sh --project=webkit-iphone-15
tests/bug7-ios-own-msg-visible.spec.ts tests/<yours>.spec.ts`) or in the
full suite. `--repeat-each` does not help: every repeat sits in the same
promoted seat.

🔴 **`@coldstart` cannot be satisfied at CI's position, and that is a
documented limit, not an oversight.** With `workers: 1` only the roster's
first test in each project holds a cold seat, so any spec that genuinely
needs one — anywhere but position 1 — makes the full suite fail by
declaration. **No spec carries the tag today** and none should acquire
one without first moving the contract somewhere the seat is not an
input: for the #1543 case that is a `vitest` pin over the component,
which is what that issue itself concluded. The tag exists so the claim
can be *stated and checked* rather than assumed, and so a run that
believes it has cold coverage finds out it does not.

(The seats a failure mints are not an escape hatch either: they are
minted by whichever test happens to be next after a red, so they are
not a position anybody can ask for.)

Do **not** tag a spec on a hunch. A declaration is a claim that the spec
was measured on both sides of the input; an unmeasured one is a guess
wearing a gate's clothes, and it will red somebody else's run.

## Five e2e gate traps that fake a green (or a red)

These five each make a broken run *look* fine — or a fine run look
broken. All bite the **local e2e loop** specifically; each was paid for
the hard way on 2026-07-27.

1. **`KEEP_STACK=1` reuses the OLD cic bundle — your fix isn't in it.**
   The e2e stack serves a **pre-built** dist (`runtime/e2e/cicchetto-dist/`,
   written once by the `cicchetto-build-test` oneshot as
   `bun run build`), NOT the live `cicchetto/src`. A cic source fix is
   therefore invisible until that bundle is rebuilt. `KEEP_STACK=1` skips
   tear-down AND the rebuild, so every rerun keeps exercising the
   **stale** dist and the fix looks dead. After ANY cic edit, drop
   `KEEP_STACK` (or otherwise force the `cicchetto-build-test` oneshot to
   re-run) so the served bundle contains your change. The tell: the
   failing assertion is byte-identical across reruns even though you
   changed the source. Same class as `feedback_hot_reload_bypasses_cic_bundle`
   (a BEAM reload never rebuilds cic either).

2. **`--repeat-each N` runs on ONE persistent stack — churn accumulates
   upstream.** `--repeat-each` does not get a fresh testnet per
   iteration; all N iterations share the single booted stack (one
   `integration.sh` invocation = one `testnet up` … `down`). Reconnect /
   session churn piles up across iterations and can knock over a spec
   **earlier in the roster** than the one you are bisecting — so you
   "reproduce" a failure that is really your own rerun pollution, not the
   bug under investigation. When `--repeat-each` starts failing a
   *different* spec than your target, tear the stack down and re-run
   clean before trusting the result. See `feedback_recurring_e2e_not_flake`
   + `feedback_cascade_poisoner_pattern`.

3. **Read the Playwright SUMMARY, never the exit code — and run the long
   gates DETACHED.** A Playwright run exited **rc 0 with a red test**
   today: the process return code is not a truthful pass/fail signal.
   Gate LANDED on the parsed summary line (`N passed`, `M failed`), never
   on `$?`. Twin rule for the long gates (`integration.sh`,
   `check.sh`): run them **detached** — `nohup … &` then `disown`, from
   the **worktree ROOT** — and read the log. A foreground long gate can
   be reaped by the harness mid-run, and the reap looks exactly like
   infra death; the tell is a **missing rc / no summary line** (the run
   was killed), NOT a red result. Sibling of
   `feedback_bg_task_exit_code_masked_by_chain` (an `exit 0` that is
   really a trailing `echo`); evidence bar is `feedback_landed_claim_evidence`.

4. **`--project chromium` is NOT the ship gate — it drops every
   `@webkit` spec.** The suite partitions across two Playwright projects;
   `webkit-iphone-15` carries the `@webkit`-tagged specs that chromium
   never collects (~419 tests chromium-only vs ~526+ for the full
   two-project run). `--project chromium` is an **iso-rerun tool**, not a
   green light. Before claiming a green e2e, **reconcile the collected
   COUNT against the baseline** — a run that collected 419 when the
   baseline is 526+ silently skipped 100+ specs. "N ≥ 1 collected" is a
   smoke check that Playwright found *something*, NOT a check that it
   collected the *right* set. See `feedback_e2e_user_class_parity_matrix`
   + `feedback_playwright_webkit_not_ios_scroll`.

5. **A fresh worktree's `cicchetto/e2e/infra` submodule is EMPTY — and
   the repair everyone reaches for (rsync) POISONS git.** Worktrees
   don't inherit submodule checkouts, so `cicchetto/e2e/infra` is empty
   on first `up`. The tell is an abort **during submodule init**: no
   tests run, no summary, exit 1, and a log tail naming
   `azzurra-testnet.git`. That is an INFRA bootstrap failure, **not a
   test red** — triaging it as a regression sends you hunting something
   that does not exist.

   **The scripts already handle it.** `scripts/testnet.sh` guards on
   `[ ! -d "$E2E_DIR/infra/bahamut" ]` and auto-inits inside that block;
   `scripts/bats.sh` does the same for `vendor/bats-core`. (Cited by the
   guard's own text, not by line number — the numbers this paragraph
   used to carry were all three stale.) Both pass
   `-c protocol.file.allow=always` (#592, PR #616, merged 2026-08-01),
   which is REQUIRED and not cosmetic: a worktree clones the submodule
   from the superproject's **local module store** over `file://`, and
   the CVE-2022-39253 mitigation blocks that transport by default. The
   clone never touches the network, so **SSH is not involved and nothing
   hangs**. Measured on a genuinely fresh worktree at `4f92701d`:
   offline, rc 0, seconds. The manual equivalent, from the worktree
   ROOT:

   ```bash
   git -c protocol.file.allow=always submodule update --init cicchetto/e2e/infra
   ```

   `git submodule status` says which state you are in: a **leading
   space** = initialized, a leading `-` = still uninit.

   ⛔ **Do NOT `rsync` the checked-out submodule from the main
   checkout** (this runbook advised exactly that until 2026-08-04; it
   was wrong). rsync copies main's `.git` **pointer file**, whose
   *relative* gitdir `../../../.git/modules/cicchetto/e2e/infra`
   resolves to `<worktree>/.git/modules/…` — but a linked worktree's
   `.git` is a **file**, not a directory, so that path is literally `Not
   a directory`. Every superproject git command then dies `fatal: not a
   git repository`, exit 128, **including plain `git status`**. A
   worktree's real pointer targets its OWN module dir
   (`.git/worktrees/<name>/modules/cicchetto/e2e/infra`) — a different
   path entirely, so main's pointer can never be right here. The testnet
   still runs; only git is poisoned. And `submodule update --init`
   **cannot repair it** ("could not get a repository handle") — it only
   works on an EMPTY infra dir. **So: init FIRST, never
   rsync-then-init.**

   Already in the hole? `git status --ignore-submodules=all` reads clean
   at rc 0, and `git add` + `git commit` both work — the breakage is
   cosmetic for committing your own files, so you can still ship. Do NOT
   `rm` the pointer (leaves the submodule detached) and do NOT
   hand-write an absolute `gitdir:`. Escalate rather than improvise
   git-state surgery.

## Writing a bats assertion: never a bare `!` (#745)

Bash suppresses `errexit` for a command whose status is inverted with
`!`, and a bats body runs under `set -e`. So this assertion is a no-op
unless it happens to be the last line of the test:

```bash
! grep -q "should not be here" "$LOG"     # DEAD mid-test — reports ok
```

The same applies anywhere a command can begin, not just at the start of a
line: `a && ! b`, `a; ! b`, `a || ! b` and `{ ! b; }` are equally dead.

Measured on the vendored bats 1.9.0: a mid-test `! true` reports `ok`;
the identical line written last reports `not ok`. It cost the suites 23
assertions that could not fail and 57 more that were live only by the
accident of line order.

Use `refute` (`test/bats_helpers.bash`, `load ../bats_helpers`). A
function call is an ordinary command, so errexit applies anywhere in the
body, and it prints what unexpectedly succeeded:

```bash
refute grep -q "should not be here" "$LOG"
refute grep -q 'partial-release' <<<"$output"   # was a pipeline
```

`test/scripts/bats_assertion_style_test.bats` fails the gate if a bare
one reappears in any of those positions. `if ! cmd`, `while ! cmd` and `[ ! -f x ]` are all fine
and are not flagged — the first two are condition contexts, and in the
third the `!` belongs to the test builtin, whose own non-zero return
still trips errexit.

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

## Running two gates at once: `GRAPPA_CACHE_ID` (#1263)

`_build`, `deps` and `priv/plts` are shared by every worktree on a host
(`scripts/_lib.sh` resolves `REPO_ROOT` through `--git-common-dir`), so
two concurrent `mix` runs contaminate each other — the class where a red
names a file your branch never touched. Prefix a gate with a cache id and
it gets its own triplet, plus a matching `MIX_TEST_PARTITION` so the two
runs do not share `runtime/grappa_test.db`:

```sh
GRAPPA_CACHE_ID=w2 scripts/mix.sh deps.get   # once per id — a fresh id is cold
GRAPPA_CACHE_ID=w2 scripts/check.sh
```

Unset, everything behaves exactly as before. Full operator notes, the
first-run cost and what the knob does **not** isolate (the docker stack:
compose project + ports, so `integration.sh` and e2e are still
single-occupancy) are in `docs/OPERATIONS.md`.

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
* **Static peer NICKs must be per-run-unique** — Bahamut holds a ghosted nick for a linger window after disconnect, so a hard-coded peer nick hits `433 nick in use` on rapid e2e reruns. Generate a fresh nick per run (or per spec) for any peer that connects to the testnet; don't reuse a literal.
* **Drive Solid pointer/touch gestures IN-PAGE, not via `locator.dispatchEvent`** (#172, #123, #79) — Solid delegates `onPointerDown`/`onClick`/`onMouseDown` to a single **document-level** listener, so a synthetic event must bubble to `document` to reach the handler. Playwright's `locator.dispatchEvent("pointerdown", {...})` did NOT trigger the handler (the #172 hold-close gate never fired → the window silently never closed → a `toHaveCount(0)` timeout that looked like a product bug but was a test-driver bug). The working pattern is to construct + dispatch the event INSIDE `page.evaluate` / `locator.evaluate`: `el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" }))` (see `cicchetto/e2e/fixtures/cicchettoPage.ts` `holdClosePress`/`quickTapClose`, and the `TouchEvent` twin in `issue123-compose-swipe-velocity.spec.ts` `synthSwipe` + `issue79-ios-select-keyboard-open.spec.ts`). For a **hold** gesture whose confirm fires on an in-page `setTimeout` while the pointer is down: dispatch `pointerdown` in-page, then `page.waitForTimeout(> threshold)` on the JS side — do NOT dispatch a trailing `pointerup`, since the confirm has already unmounted the element and a `locator`-level dispatch on it would auto-wait to timeout. `pointerType` MUST be `"touch"`/`"pen"` for a touch-gated gesture — `"mouse"` (the default) takes the instant fast-path and silently skips the gate under test.
* **Playwright cannot drive the on-device soft keyboard** — the `webkit-iphone-15` project has no OS keyboard, so it CANNOT reproduce real iOS keyboard occlusion / scroll physics. A mobile-keyboard spec guarantees the **layout/scroll-anchor CONTRACT**, it does NOT reproduce the device bug (issue #66 was filed against this surface yet was not-reproducible on real iOS + Android — the full `--viewport-height` infra predated the report by a month; the spec landed as a regression guard, see `cicchetto/e2e/tests/issue66-keyboard-overlap.spec.ts`). To **simulate** the keyboard in a spec: stub `window.visualViewport.height` to the shrunk px AND `dispatchEvent(new Event("resize"))` on it — the production `installViewportHeightTracker` resize listener then writes the shrunk `--viewport-height`/`--vh` from the stub, and `ScrollbackPane`'s `scrollToActivation` re-anchor fires off the same event (both facets run as on device). **NEVER** `setProperty("--viewport-height", …)` and THEN dispatch `resize`: the tracker's own listener immediately clobbers the inline var back to the real (full) `vv.height`, silently un-shrinking the viewport mid-test.

## When the test stack itself is broken

* **`vendor/bats-core` not found** → `scripts/bats.sh` auto-inits it. By hand: `git -c protocol.file.allow=always submodule update --init vendor/bats-core` — the flag is REQUIRED in a worktree (see trap 5).
* **`cicchetto/e2e/infra` empty (fresh git worktree — worktrees don't inherit submodules)** → nothing to do: `scripts/testnet.sh` auto-inits it **offline** from the local module store. By hand, from the worktree ROOT: `git -c protocol.file.allow=always submodule update --init cicchetto/e2e/infra`. **Never rsync it from the main checkout** — that poisons superproject git; see trap 5 in "Five e2e gate traps that fake a green (or a red)".
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
