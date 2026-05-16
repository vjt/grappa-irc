# T + M + U cluster arc

**Status**: brainstorm v1 (drafted 2026-05-16, awaiting vjt review).
Implementation NOT started. Three clusters in sequence — `/clear`
between each per vjt's "ensure to clear between each cluster"
directive.

| Cluster | Theme | Buckets | First commit unblocks | Last commit closes |
|---------|-------|---------|----------------------|-------------------|
| **T** — task harness | mix-task simplification + remote-shell access | T-1..T-4 + T-Z | "run any task without thinking about MIX_ENV" | docs sweep |
| **M** — admin API + console | `users.is_admin` + `/admin/*` + cic admin drawer | M-1..M-12 + M-Z | one-click `DELETE /admin/visitors/:id` | per-network cap editor |
| **U** — cap honesty | visitor/user cap split + stop swallowing spawn errors + device-identity-change support | U-0..U-7 + U-Z | error-honesty restored | cap visibility + edit from console |

**Arc order**:
1. **T first** — independently useful, AND unblocks "run a quick admin
   script" pattern that M will lean on. Sub-clusters M-bootstrap-admin
   and U-pre-fix both lean on T's `bin/grappa create-user --admin`
   verb.
2. **M second** — uses T's simplified task harness for the few CLI-only
   workflows that remain (e.g. bootstrapping the first admin user).
   M's first endpoint is `DELETE /admin/visitors/:id` (the verb vjt
   needed today to clear stale `S\`grappa`).
3. **U third** — uses M to PATCH per-network user-cap from the console.
   Without M, operators would still need a mix task to set the cap.
   U includes the "stop swallowing spawn errors" fix (U-0; vjt
   2026-05-16: "ok we have not to swallow the error") AND the
   "device disconnect-then-reconnect-with-different-identity" support
   (vjt 2026-05-16: "we should allow a device to disconnect and
   reconnect with a different identity").

**Cluster-internal `/clear` discipline**: per
`feedback_orchestrator_proactive_clear`, the orchestrator triggers
sibling clear-cycles at ~25% context without waiting for vjt.

---

## Origin evidence

vjt's strategic prompt (verbatim, condensed from 2026-05-16 session
that just closed the I cluster):

> ok wait porco dio if i cant connect the fucking bug here is to
> let me in and not show me the fucking network as at capacity
> porco dio. and further i think that the owners should fucking
> bypass the limit. i mean registered users. let's talk more about
> this
>
> ok so - two different caps one for visitors and one for users i
> think is the right thing to do. and patch connect should return
> error when cap is exceeded.
>
> porco dio we need a management api and then a management console
>
> ok no do not bump cap.
>
> Plan for next items:
> - cluster 1: simplify running tasks. should be fucking simple to
>   run a mix task. we can also have a bin/grappa utility if needed
>   inside the container
> - cluster 2: do the admin surface as we discussed
> - cluster 3: add the per-user and per-visitor limits
> - ensure to clear between each cluster. i'll let orchestrator guide you

Mid-session refinements (2026-05-16):
- "ok we have not to swallow the error" → U-0
- "we should allow a device to disconnect and reconnect with a
  different identity" → U dimension D2
- "ok keep this change in U it's not a problem porco dio it's ok to
  have all U clustered together" → U-0 stays inside U (NOT pre-cluster)

Decisions already made + reflected in this brief (do NOT re-litigate):

| Decision | vjt-picked value | Why this choice |
|----------|------------------|-----------------|
| Auth model for admin endpoints | `users.is_admin BOOLEAN` | Single bit, simplest; no role table; no RBAC matrix |
| Console location | Inside cic, admin-only drawer entry | Reuse existing infra (PubSub events, Channels, layout); no second SPA |
| PATCH /connect spawn-fail DB state | Stay at previous state, return 503 + typed error | DESIGN_NOTES "no silent drops"; `:failed` reserved for terminal IRC failures |
| `max_concurrent_sessions` rename | Rename to `max_concurrent_visitor_sessions` + add `max_concurrent_user_sessions` | "Total consistency or nothing"; not a tuple/flag |
| Default user-cap | 3 (mirror current visitor cap) | Operator bumps via admin surface (M), not at bind-time |

---

# Cluster T — simplify running tasks

**Position**: first. Branch: `cluster/tasks` (worktree from local
main).

## Today's pain (the empirical evidence that motivates this cluster)

Captured live during the 2026-05-16 stale-visitor incident:

1. **`scripts/mix.sh` hardcodes `MIX_ENV=dev`** in
   `_lib.sh:184` (`-e MIX_ENV=dev`). Prod-DB tasks are unreachable
   without `docker compose exec -T -e MIX_ENV=prod -e
   DATABASE_PATH=/app/runtime/grappa_prod.db grappa mix ...` —
   manually built from operator memory each time.
2. **Even with the right env vars set, the oneshot starts a SECOND
   BEAM in the same container** → port 4000 collision with the live
   BEAM. `Boot.start_app_silent` only suppresses `Bootstrap`, NOT
   `Endpoint`, so any task that calls into the app environment
   triggers `:eaddrinuse`.
3. **No way to attach to the LIVE BEAM**. `bin/start.sh` doesn't set
   sname + cookie; `iex -S mix` starts a fresh node. Operator can't
   `:sys.get_state(pid)` on a live Session.Server, can't `:observer`
   the production tree, can't run a one-off `Repo.update` in the same
   process that owns the live Phoenix.PubSub.
4. **`scripts/db.sh` against prod is READONLY** (`db.sh:21` —
   `MODE_ARG="-readonly"` when `env=prod`). Tonight's incident
   required `docker compose exec ... sqlite3 ...` (bypassing the
   helper entirely) to DELETE stale visitor rows — defeats the entire
   purpose of the helper. Operator-recovery is currently impossible
   without raw docker commands.
5. **Mix-task discoverability is poor**. Nine `grappa.*` tasks
   scattered in `lib/mix/tasks/` with no top-level help, no
   `bin/grappa` wrapper, no consistent flag conventions. Tonight a
   `delete_visitor` task was hand-rolled (stashed) because nobody
   remembered whether `reap_visitors` does what we needed.
6. **`bootstrap: no credentials bound` log lie**. When ALL credentials
   exist but ALL are `:parked` (per T32), Bootstrap's
   `Credentials.list_credentials_for_all_users/0` returns empty
   (filters on `connection_state == :connected`) and Bootstrap logs
   "no credentials bound — running web-only" — false. Tonight that
   message hid the fact that vjt's cred existed but was parked.
   Honest log would say "0 credentials in :connected state (N parked,
   M failed) — running web-only".

## Brainstorm dimensions

Each dimension is a question the doc must answer BEFORE we commit
to bucket shapes.

### D1. `bin/grappa` — host-side, container-side, or both?

**Option A (recommended): host-side dispatcher**. `bin/grappa` lives
at repo root, runs on the operator's workstation, dispatches per
subcommand to the right execution mode:

```
bin/grappa <verb> [opts]

verb routing:
  create-user     → mix task (boot a transient node, no live state)
  bind-network    → mix task
  add-server      → mix task
  set-network-caps → mix task
  delete-visitor  → live-BEAM remsh (frees registry slot synchronously)
  unbind-network  → live-BEAM remsh (need running Session.Server to terminate)
  reap-visitors   → live-BEAM remsh (cleanup operates on live state)
  list-sessions   → live-BEAM remsh (Registry.select; no DB)
  open-db         → docker exec sqlite3 (RW; replaces scripts/db.sh)
  shell           → docker exec bash
  remote-shell    → iex --remsh (live BEAM, full attach)
  help            → enumerate verbs + summaries
```

The dispatch table is in `bin/grappa` itself (bash case statement
or small awk routing); each branch calls the right underlying
helper (`docker compose exec`, oneshot, sqlite3, etc.). No new layer
inside the container.

Why host-side wins: operator already has the repo, already has
`docker compose` configured, no new chicken-and-egg "how do I get
into the container to run bin/grappa" problem. Tab-completion via
a tiny `bin/grappa.bash_completion` script (defer).

**Option B (alt): container-side script** at `/app/bin/grappa`.
Operator runs `scripts/shell.sh bin/grappa <verb>`. Forces operator
to enter the container manually, then run another tool — defeats the
"should be fucking simple" goal. Reject.

**Option C: both**. Don't reject in principle, but defer — adds a
second surface to keep in sync. If verifications later show
container-side is useful (e.g. for automation INSIDE the container
that doesn't have access to the host `docker` binary), add it then.

**Resolution**: Option A. Single source of truth at `bin/grappa`,
host-side. Decision T-A1.

### D2. How does a live-state task reach the LIVE BEAM?

The `delete_visitor` example: deleting the visitor row deletes the
DB record but does NOT terminate the live `Session.Server`. The
GenServer crashes at its next dependent-row write (tens of seconds
later), and only THEN does the supervisor observer release the
registry slot. For cap-recovery this latency is unacceptable.

**Option A (recommended): Erlang distribution on the prod node**.
`bin/start.sh` gains `--sname grappa --setcookie $RELEASE_COOKIE`
flags; `bin/grappa remote-shell` (and any verb routed to live-BEAM)
runs `iex --sname admin --setcookie $RELEASE_COOKIE --remsh grappa@<host>`.
Operator gets a real IEx prompt against the live VM, with full
introspection.

Caveats:
- `RELEASE_COOKIE` must be set in container env (already required by
  `bin/start.sh` post-Phase-5; harmless to mirror in dev).
- Distribution opens port 4369 (epmd) + an assigned dist port.
  Container exposes neither externally — `bin/grappa` runs `docker
  exec` into the grappa container to start the remsh client, so dist
  traffic stays inside the container namespace. No host firewall
  change.
- Short-name (`--sname`) sufficient for same-container dist; no FQDN
  resolution needed.

For batch-mode tasks (no interactive REPL), `iex --remsh` accepts
`-e '<expr>'` for one-shot evaluation. `bin/grappa delete-visitor
<uuid>` evaluates a one-line module call against the live node:

```
iex --remsh grappa@... -e 'Grappa.Visitors.delete!("<uuid>")'
```

Visitors.delete! synchronously terminates the live Session.Server
via `DynamicSupervisor.terminate_child/2` BEFORE the DB delete (so
the registry slot frees in the same call). New helper, not the
existing soft `Visitors.delete/1`.

**Option B (alt): admin-HTTP only**. Tasks become curl wrappers
against M cluster endpoints. Rejected for T (admin endpoints don't
exist yet at the start of T); kept in mind for M (the
`DELETE /admin/visitors/:id` endpoint M-3 ships exists in parallel
with the `bin/grappa delete-visitor` verb — both call into the same
`Visitors.delete!/1` helper, one via HTTP + auth, one via remsh).

**Option C (HYBRID — recommended whole-picture)**:
- Boot-time tasks (`create-user`, `bind-network`, `add-server`,
  `set-network-caps`, schema migrations) stay as mix tasks. They
  manipulate config / persistent state. No need for the live BEAM.
- Live-state tasks (`delete-visitor`, `unbind-network` post-T32,
  `reap-visitors` on demand, `list-sessions`) route through remsh.
- `open-db` routes through `docker exec sqlite3 -rw` —
  intentionally NOT readonly when invoked via `bin/grappa` (operator
  is being deliberate; `scripts/db.sh prod` stays readonly for
  ambient safety).
- M's `DELETE /admin/visitors/:id` becomes the second-preferred path
  for the same operation: same `Visitors.delete!/1` helper, exposed
  via admin HTTP for one-click console use.

**Resolution**: Option C. Decision T-A2.

### D3. MIX_ENV detection — drop the override, keep `scripts/mix.sh`

`scripts/_lib.sh:184` forces `MIX_ENV=dev` because dev-only deps
(credo, dialyxir, sobelow) live under the `:dev` env. **But this
breaks every other purpose** — prod tasks need `MIX_ENV=prod` so
they read the right DB path, the right secret key base, the right
log level.

**Fix (vjt 2026-05-16: "mix rename makes sense if mix is used only
in dev. if we can use mix in prod as well no")**: `scripts/mix.sh`
stays — name AND surface. Behavior changes:

- Default behavior: detect `MIX_ENV` from the running container
  (`docker compose exec printenv MIX_ENV`) and use that. Dev box →
  dev; prod box → prod. Operator's workstation auto-DTRT.
- Override flag: `scripts/mix.sh --env=dev <task>` or
  `--env=prod <task>` for explicit choice (rare; dev-deps tasks
  like `credo` / `dialyxir` need `--env=dev` when run against a
  prod-by-default container, since dev deps aren't compiled into
  the prod image).
- `bin/grappa` verbs that need a transient mix-task node delegate
  to `scripts/mix.sh` (same auto-detected env path); live-BEAM verbs
  bypass mix entirely (T-2 remsh).

**Resolution**: keep `scripts/mix.sh`; drop the `MIX_ENV=dev`
hardcode; auto-detect from container env with `--env=` override
flag. Decision T-A3 (revised post-vjt-input 2026-05-16).

### D4. Help + discoverability

`bin/grappa help` enumerates verbs grouped by category (boot-time,
live-state, debug), each with a one-line summary. `bin/grappa <verb>
--help` delegates to the verb's underlying help (mix task moduledoc
or remsh one-liner).

Verb names follow `kebab-case` (Unix convention); underlying mix
tasks stay `Grappa.SnakeCase` per Elixir convention. Mapping table
inside `bin/grappa`.

**Resolution**: Decision T-A4.

### D5. Tests for `bin/grappa` without spinning a real container?

`bin/grappa` is a bash dispatcher. Test via bats-core (bash test
harness) or — simpler — a shell-script unit test that mocks `docker
compose` via PATH stub and asserts the right command was invoked.

For each verb:
- Assert correct underlying command shape (env vars, image, args).
- Assert error path (no container running → meaningful error, not
  bare `docker exec` failure).
- Help text exists for every verb.

ExUnit can also exercise the live-state mix tasks (the underlying
`Visitors.delete!/1` helper, etc.) — already the test idiom for
`Grappa.*` modules.

**Resolution**: bash unit tests for `bin/grappa` dispatch +
existing ExUnit tests for underlying helpers. Decision T-A5.

### D6. The honest `bootstrap: no credentials bound` log message

Today's lie: when N credentials exist but all are `:parked` /
`:failed`, the log says "no credentials bound — running web-only".
Operator reads this as "DB is empty / nobody bound a network" and
chases the wrong root cause.

Honest log:
```
bootstrap: 0 credentials in :connected state (3 parked, 1 failed, 0 unbound) —
running web-only. Use `bin/grappa list-credentials` to inspect.
```

The count comes from a new `Credentials.count_by_state/0`. Bootstrap
calls it once at the unbound-warning branch.

**Resolution**: T-4 (docs sweep bucket) lands this alongside the
CLAUDE.md updates. Decision T-A6.

### D7. Visitor `expires_at` never set — slot leak forever

Visitor schema has `expires_at TEXT NULL` (`visitors.ex`), but
**`Grappa.Visitors.Login` doesn't set it** on creation. Tonight's 4
stale visitors all had `expires_at: NULL`. The `Reaper` 60s sweep
queries `WHERE expires_at < NOW()` — `NULL < X` is `NULL` in
SQLite, which is falsy → reaper NEVER touches NULL rows. Result:
every visitor is permanent until manually deleted.

This is technically scope-creep for T (it's a Visitors bug, not a
task-harness bug), BUT:
- It's a one-line fix (set `expires_at: now + visitor_ttl_default`
  on insert in `Visitors.Login`).
- It's the root cause of why T's recovery story (delete-visitor
  task) needs to exist at all — without this fix we're shoveling
  manually forever.
- The brief says T-3 pops the stashed `delete_visitor` task; while
  we're in Visitors anyway, fix the upstream leak.

**Resolution**: fold into T-3 as "T-3.5 — Visitors.Login sets
expires_at on creation; existing NULL-expires visitors get
backfilled to `now + ttl` via a one-off boot-time sweep". Decision
T-A7. (Backfill rationale: alternative is "delete all NULL-expires
visitors at boot" which is too aggressive; per-session reap on TTL
expiry is the safer default.)

## Buckets

### T-1 — `bin/grappa` host-side dispatcher + help + dev tests

**Failing test first**: `test/bin/grappa_test.bats` (new bats-core
file under `test/bin/`, runner added to `mix test` via
`scripts/test.sh` wrapper):
- `bin/grappa help` lists all verbs grouped (boot-time, live-state,
  debug, dev).
- `bin/grappa unknown-verb` exits non-zero with usage.
- `bin/grappa help <verb>` shows verb-specific help.
- `bin/grappa shell` (mocked `docker compose`) invokes correct
  exec shape.

**Production change**:
1. New `bin/grappa` bash dispatcher.
2. New `bin/grappa.completion.bash` (defer to T-4 if time-bound).
3. `scripts/mix.sh` keeps its name; behavior change:
   - Auto-detect `MIX_ENV` from live container's env (via
     `docker compose exec printenv MIX_ENV`).
   - `--env=dev|prod` override flag for explicit choice.
   - Existing call sites (CI, dev scripts) continue to work via
     auto-detected dev env when run against a dev container.
4. Verb routing table is a single bash function — easy to extend.

**Exit criteria**: `bin/grappa help` prints organized verb list;
bats tests green; `scripts/mix.sh` works against both dev and prod
containers without manual `MIX_ENV=` prefix; explicit `--env=` flag
documented in help output.

**Deploy**: none (operator-side script; no server change).

### T-2 — Erlang distribution on the live BEAM + `bin/grappa remote-shell`

**Failing test first**: bats shape assertions in
`test/bin/grappa_test.bats` cover the docker-compose-exec invocation
shape (interactive vs `--batch -e <expr>`, sname/cookie literal
passthrough, `--remsh grappa@grappa` target). The originally-spec'd
`test/integration/remote_shell_test.exs` was DEFERRED at T-2 impl
time (2026-05-16): both realistic shapes (spawn sibling sname'd BEAM
as a port from the test, OR mutate the ExUnit node's own sname/cookie
globally) test "iex --remsh works upstream" rather than "T-2's
wiring works", which is plumbing — bash dispatcher correctness IS
the unit under test. Bats covers shape; T-Z's manual smoke
(`bin/grappa remote-shell --batch -e 'Process.list() |> length'`)
covers liveness end-to-end.

**Production change**:
1. `bin/start.sh` adds `--sname grappa --setcookie ${RELEASE_COOKIE}`
   to the BEAM start invocation. `RELEASE_COOKIE` env var is already
   required in prod (Phase 5); dev gets a default from
   `compose.yaml`.
2. `bin/grappa remote-shell` (interactive) and `bin/grappa
   remote-shell --batch -e <expr>` (one-shot) routes via `docker
   compose exec grappa iex --sname admin --setcookie $RELEASE_COOKIE
   --remsh grappa@<host>`.
3. Document the security model: distribution is internal to the
   container's network namespace; no host port exposed. Threat model
   = unchanged.

**Cold/Hot**: COLD (`bin/start.sh` is in the image; supervision tree
boot env changes).

**Exit criteria**: integration test green; manual smoke from operator
laptop runs `bin/grappa remote-shell --batch -e 'Process.list()
|> length'`; returns a positive integer; interactive shell shows a
live IEx prompt that can `:sys.get_state(pid)` on a live
`Session.Server`.

**Deploy**: COLD.

### T-3 — Live-state verbs: `delete-visitor` + `reap-visitors` + `list-*` + visitor expires_at fix

**Failing test first**:
1. `test/grappa/visitors/visitors_test.exs` — new test for
   `Visitors.delete!/1`:
   - Synchronously terminates the live Session.Server (assert process
     is `:DOWN` before return).
   - Registry slot freed (assert `Registry.lookup(...) == []`).
   - DB row gone (assert `Repo.get(Visitor, id) == nil`).
   - Idempotent on already-deleted (returns `:ok` not raise).
2. `test/grappa/visitors/login_test.exs` — assert `expires_at` is
   set to `now + visitor_ttl_default` (config-driven; pin in
   `config/config.exs` to 24h; test reads same config).
3. `test/grappa/visitors/reaper_test.exs` — assert backfill: a
   visitor with `expires_at: nil` and `inserted_at: 25h ago` is
   touched by the boot-time backfill OR reaped at the next sweep
   (whichever ships).
4. `test/bin/grappa_test.bats` — assert `bin/grappa delete-visitor
   <uuid>` calls the right remsh shape.

**Production change**:
1. Pop the stashed `lib/mix/tasks/grappa.delete_visitor.ex` (origin:
   2026-05-16 incident). REWRITE per T-A2: it's now a thin wrapper
   that calls `Grappa.Visitors.delete!/1`. NOT a mix task — the verb
   lives in `bin/grappa delete-visitor` routed through T-2's remsh
   (`iex --remsh -e 'Grappa.Visitors.delete!("uuid")'`).
2. New `Visitors.delete!/1` helper:
   ```elixir
   @spec delete!(Ecto.UUID.t()) :: :ok
   def delete!(id) do
     case Registry.lookup(Grappa.SessionRegistry, {:visitor, id, network}) do
       [{pid, _}] -> DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
       [] -> :ok
     end
     # CASCADE deletes visitor_channels, messages, query_windows,
     # push_subscriptions, user_settings, read_cursors per CP32.
     Repo.delete!(%Visitor{id: id})
     :ok
   end
   ```
3. `Visitors.Login.create_visitor/1` sets
   `expires_at: DateTime.add(now, visitor_ttl_default, :second)`
   on the insert changeset. `visitor_ttl_default` is a new config
   key under `:grappa, :visitors, ttl_default: 86_400` (24h).
4. One-off backfill at boot: `Visitors.backfill_expires_at!/0` runs
   once during `Grappa.Bootstrap` start (before visitor spawn loop).
   Sets `expires_at = inserted_at + ttl_default` on any row where
   `expires_at IS NULL`. Logged with row count. Removed in T-Z's
   docs sweep (one-shot migration, kept as documented removal in
   the next CP after T-Z so the deploy seq is clear).
5. `bin/grappa list-sessions`, `bin/grappa list-credentials`,
   `bin/grappa list-visitors` — remsh-routed Registry.select +
   pretty-print.

**Exit criteria**: unit + integration tests green; `bin/grappa
delete-visitor <uuid>` frees the cap slot in <1 second
(measure-and-assert in the integration test); newly created visitors
have `expires_at` populated; reaper drops them at TTL.

**Deploy**: COLD (new migration column-default? no — `expires_at`
already exists, just was never written. No schema change. Hot is
safe for the helper change, COLD for the boot-time backfill because
Bootstrap reads it. Per `feedback_cluster_with_migration_must_cold`
the safer call is COLD.)

### T-4 — Docs sweep: README + CLAUDE.md + DESIGN_NOTES + log-honesty

**Failing test first**: N/A (docs + log message).

**Production change**:
1. **CLAUDE.md** "How to run scripts" section — rewrite to lead with
   `bin/grappa <verb>` as the operator interface; `scripts/*.sh`
   demoted to "developer plumbing" subsection. Document the
   boot-time vs live-state split explicitly.
2. **README.md** Operator quickstart subsection — `bin/grappa help`
   discovery, common verbs, where the docs live.
3. **DESIGN_NOTES.md** — chronological entry: T cluster summary,
   T-A1..T-A7 decisions, lessons learned.
4. **`docs/project-story.md`** — episode (per CLAUDE.md "Project
   story lives on" rule).
5. **`lib/grappa/bootstrap.ex`** log honesty (per T-A6): replace
   "no credentials bound" with state-aware "0 credentials in
   :connected state (N parked, M failed, K unbound)" using
   `Credentials.count_by_state/0`.
6. **`lib/grappa/networks/credentials.ex`** — new public
   `count_by_state/0`. Single SQL query, returns
   `%{connected: N, parked: M, failed: K}`. Exposed for both the
   honest-bootstrap-log path AND `bin/grappa list-credentials`
   summary output.
7. **CLAUDE.md** new rule under Engineering Standards → Code-shape
   rules: "Log honesty — when a fast path skips work, the log
   message must describe the skipped state, not the absence of work.
   `bootstrap: no credentials bound` was a lie when all creds were
   parked (CP3X T cluster, 2026-05-16). Fast paths state what they
   observed, not what they did."

**Exit criteria**: docs read cleanly; new CLAUDE.md rule lands;
log message is honest under all four states (zero rows, all parked,
mixed, all connected).

**Deploy**: HOT (lib + config only; no schema, no supervision-tree
change).

### T-Z — Cluster CLOSE

Mirrors CP33's CLOSE shape (CP33 was the I cluster's closing
checkpoint). Sequence:

1. `cd /Users/mbarnaba/code/grappa/.worktrees/tasks && git fetch
   origin main && git rebase origin/main`
2. Gates: `scripts/check.sh` (full) + `scripts/bun.sh run check` (cic
   untouched, but quick sanity) + `scripts/bun.sh run test` +
   `scripts/integration.sh`.
3. Standalone Dialyzer per `feedback_dialyzer_plt_staleness`:
   `scripts/dialyzer.sh`.
4. Brief vjt with cluster summary (commit shas per bucket,
   deviations from plan).
5. Merge: `git checkout main && git merge --ff-only cluster/tasks`.
6. Per-bucket deploy reminder per `feedback_per_bucket_deploy`
   (deploys happened in-step):
   - T-1: no deploy.
   - T-2: COLD (bin/start.sh change).
   - T-3: COLD (Bootstrap backfill change).
   - T-4: HOT.
   - At T-Z: post-merge preflight check per
     `feedback_deploy_preflight_empty_diff_after_merge` —
     manually inspect for anything that snuck through (mix.lock,
     long_lived_modules, migrations, nginx.conf) before any final
     deploy. None expected (all live cluster-side already).
7. `scripts/healthcheck.sh` returns ok.
8. **Manual smoke from operator workstation** (the actual point of
   the cluster — the user JOURNEY):
   - `bin/grappa help` → list of verbs.
   - `bin/grappa list-visitors` → tonight's incident shape (column:
     id, nick, network, expires_at, inserted_at).
   - `bin/grappa delete-visitor <uuid>` → assert slot freed in real
     time (check cap availability immediately after).
   - `bin/grappa remote-shell --batch -e 'Process.alive?(...)'`.
   - `bin/grappa create-user --name testop --password ... --admin`
     (M cluster needs this verb to bootstrap; T-Z verifies it works
     end-to-end).
   - `bin/grappa open-db` opens an RW sqlite3 shell against prod
     (verify `INSERT` works; rollback the test row).
9. Push origin/main per `feedback_push_autonomy`.
10. Update `project_post_p4_1_arc` — mark T CLOSED, point at M.
11. Write CP3X at `docs/checkpoints/2026-05-XX-cp3X.md`.
12. DESIGN_NOTES entry (lands in T-4, verify final at Z).
13. Story episode (lands in T-4, verify final at Z).
14. CLAUDE.md updates (lands in T-4, verify final at Z).
15. Save memory: `project_t_task_harness_closed`.
16. Worktree cleanup: `git worktree remove .worktrees/tasks`.

**Exit criteria**: vjt can run `bin/grappa delete-visitor <id>`
without thinking about MIX_ENV / DATABASE_PATH / container exec /
worktree-vs-main / port collisions. AND the task actually frees the
live registry slot synchronously (not just deletes the DB row).
AND no future visitor leaks into the DB forever — TTL is set on
creation, reaper sweeps drops them at expiry.

---

# Cluster M — management API + console

**Position**: second. Branch: `cluster/admin` (worktree from local
main, post-T merge).

## Premise

vjt 2026-05-16: "do the admin surface as we discussed." Console-
driven operator workflows for everything currently requiring a mix
task or DB poke. First endpoint is `DELETE /admin/visitors/:id`
(the unblock verb from tonight's incident).

## Decisions already made

- `users.is_admin BOOLEAN` — single bit, defaults `false`. Migration
  adds the column with default + backfill.
- Bootstrap admin user via T's `bin/grappa create-user --admin`
  (T cluster ships this verb).
- Admin endpoints scoped at `/admin/*`. New router pipeline `:admin`
  adds `require_admin/1` plug that fails 403 unless
  `current_subject` is `{:user, %User{is_admin: true}}` (visitors
  ALWAYS fail admin auth).
- Console lives inside cic, admin-only drawer entry visible only
  when `me.is_admin === true`. Reuses Phoenix Channels for live
  state updates on admin-relevant events.

## Brainstorm dimensions

### MD1. Endpoint surface — exhaustive list

Be specific. The console needs:

| Verb + path | What | Backed by |
|-------------|------|-----------|
| `GET /admin/me` | echo current subject + is_admin bit | controller |
| `GET /admin/visitors` | list all visitors (live + DB) | `Visitors.list_all/0` |
| `DELETE /admin/visitors/:id` | terminate + delete | `Visitors.delete!/1` (T-3) |
| `GET /admin/sessions` | live Session.Server inventory per network | `SessionRegistry.select` |
| `DELETE /admin/sessions/:id` | terminate one session | `Session.terminate/1` |
| `POST /admin/sessions/:id/disconnect` | T32 park verb | `SessionOrchestrator.park/2` |
| `GET /admin/networks` | network table + caps + circuit state | `Networks.list_all/0` |
| `PATCH /admin/networks/:slug` | edit caps (visitor + user), reset circuit | `Networks.update_caps/2` |
| `GET /admin/users` | user inventory + is_admin flag | `Users.list_all/0` |
| `PATCH /admin/users/:id` | toggle is_admin, reset password | `Users.update_admin_flags/2` |
| `GET /admin/credentials` | per (user, network) bindings + state | `Credentials.list_all/0` |
| `PATCH /admin/credentials/:user_id/:network_id` | edit autojoin, nick, etc. | `Credentials.update_admin/3` |
| `POST /admin/reaper/run` | force-trigger Visitors.Reaper | `Reaper.run_now/0` |
| `POST /admin/circuit/:network_id/reset` | clear circuit | `NetworkCircuit.reset/1` |
| `DELETE /admin/scrollback/:network_id/:channel` | purge scrollback (extreme; needs confirmation in UI) | `Scrollback.purge/2` |

**Resolution**: ship in 4 waves (M-3 visitor delete; M-4 list-all
visitors + sessions; M-5 network caps + reaper + circuit; M-6 users
+ credentials), each is its own bucket. Decision M-A1.

### MD2. Live state queries — query the BEAM, don't duplicate

Counts of live sessions per network, mailbox depth per process,
memory per process, registry contents — these go through
`:sys.get_state`, `Process.info`, `Registry.select`. Do NOT
duplicate the DB (`sessions` table is bind-time intent; live state
is the BEAM).

Pattern: each `GET /admin/<resource>` controller calls a
`<Resource>.list_all/0` helper that combines DB rows (intent) with
live-process introspection (current state). Return shape includes
both:

```json
{
  "id": "...",
  "subject_kind": "user|visitor",
  "network_slug": "azzurra",
  "db_state": {"connection_state": "connected", "connection_state_reason": null},
  "live_state": {"alive": true, "pid_inspect": "#PID<0.xxx.0>",
                 "memory_bytes": 12345, "message_queue_len": 0,
                 "joined_channels": ["#sbiffo", ...]}
}
```

`live_state` is `null` when the process isn't running (DB
`:connected` but no live pid → flag this prominently in the cic UI,
because that's the U-0 swallow bug showing through).

**Resolution**: Decision M-A2.

### MD3. Real-time events to admin topic

When something admin-relevant happens (spawn rejected, session
crash, cap saturated, reaper sweep), push to
`grappa:admin:events` user-rooted topic so the console doesn't poll.

Existing telemetry events fire on:
- `Admission.capacity_reject` (T31)
- `Session.terminate` (existing)
- Bootstrap completion (existing)
- `NetworkCircuit.open` / `close`

Add a thin `Grappa.AdminEvents` module that subscribes to these
telemetry events + republishes onto `grappa:admin:events` as typed
wire shape (per `Grappa.PubSub.Topic` convention). Cic console
subscribes via Phoenix Channel.

Per `feedback_no_silent_drops_closed`: typed
`%Grappa.AdminEvents.Wire{kind: ...}` struct + wire-edge
exhaustiveness assertions. NO untyped maps.

**Resolution**: Decision M-A3.

### MD4. Console UX — mirror irssi shape

Admin pane lives as a sibling to the existing scrollback shell.
- Drawer entry: "Admin" (visible only when `me.is_admin`).
- Click opens a full-width admin pane (replaces channel content for
  the duration).
- Tabs inside admin pane: Visitors / Sessions / Networks / Users /
  Credentials / Events / Reaper.
- Each tab is a table + action buttons + filters.
- Events tab is a live log (subscribes to `grappa:admin:events`).
- All actions confirm via inline confirm-button transformation
  (button text "Delete" → on click → "Confirm delete?" → on second
  click → fire). NO modals (consistent with existing cic
  modal-discouraged philosophy).

**Resolution**: Decision M-A4.

### MD5. Auth UX

Non-admin users see no drawer entry. Admin users see drawer entry;
clicking opens admin pane. Admin status comes from the `me` envelope
(GET /admin/me) at login; cached in cic state; refetched on
reconnect.

If a logged-in user is demoted to non-admin mid-session: their
existing Phoenix Channel subscription to `grappa:admin:events`
returns `{:error, :not_admin}` on next push attempt → cic drops
admin pane + drawer entry.

**Resolution**: Decision M-A5.

### MD6. Tests

Controller tests:
- Assert 403 for non-admin (visitor + non-admin user).
- Assert 200 for admin user.
- Assert wire shape via `Grappa.AdminEvents.Wire` exhaustiveness.

Integration test for visitor-delete flow:
- Spawn visitor → admin DELETE → assert cap slot freed
  synchronously + DB row gone + live registry entry gone.

Cic vitest:
- Drawer entry hidden when `me.is_admin === false`.
- Admin pane mounts when entry clicked + is_admin === true.
- Events stream renders typed wire shapes (exhaustiveness on `kind`
  union per `feedback_no_silent_drops_closed`).

Playwright e2e (per `feedback_ux_e2e_mandatory`):
- Login as admin → open admin pane → see live visitor list → click
  delete on a test visitor → confirm → assert visitor disappears
  from list within 1 second.

**Resolution**: Decision M-A6.

### MD7. Bootstrap chicken-and-egg

**How does the FIRST admin user get created?** Three options:

- **A (vjt-picked, 2026-05-16)**: `bin/grappa create-user --admin
  --name grappa --password <prompt>` (T cluster ships this verb).
  Operator runs it once at first-time setup. Username is `grappa`
  (vjt-blessed). Works forever afterward via the admin console.
- **B (rejected)**: First user ever created is auto-admin. Footgun
  (forgotten in prod = no admin ever).
- **C (rejected)**: Env var `GRAPPA_ADMIN_BOOTSTRAP_USER=name`
  promotes named user on boot. Hidden side-effect; debugging
  nightmare.

**Resolution**: Option A. Decision M-A7.

## Buckets

### M-1 — Migration: `users.is_admin BOOLEAN DEFAULT FALSE` + Boundary touchups

**Failing test first**: `test/grappa/users/users_test.exs`:
- New users default `is_admin: false`.
- `Users.update_admin_flags/2` toggles the bit.
- Schema migration round-trip (down + up).

**Production change**:
1. Migration `priv/repo/migrations/<ts>_add_is_admin_to_users.exs`:
   `add :is_admin, :boolean, default: false, null: false`.
2. `Grappa.Users.User` schema: `field :is_admin, :boolean, default:
   false`.
3. `Users.update_admin_flags/2` helper (admin-only setter).
4. Boundary touchup: no public-API leak.

**Deploy**: COLD per `feedback_cluster_with_migration_must_cold`.

### M-2 — `:admin` pipeline + `require_admin` plug + GET /admin/me

**Failing test first**: controller test:
- Visitor subject → 403.
- Non-admin user → 403.
- Admin user → 200 + `{id, name, is_admin: true}` body.

**Production change**:
1. New `GrappaWeb.Admin.AuthPlug` — checks `conn.assigns.current_subject`
   for `{:user, %User{is_admin: true}}`.
2. Router pipeline `:admin` mounts `require_admin/1` + JSON.
3. `GrappaWeb.Admin.MeController` with `index/2`.
4. Boundary: `GrappaWeb.Admin` is its own sub-boundary; deps on
   `Grappa.Users` only.

**Deploy**: HOT.

### M-3 — `DELETE /admin/visitors/:id` (the unblock verb)

**Failing test first**: integration:
- Admin DELETE → 204, cap slot free, DB row gone, live registry
  cleared, all within 1s.
- Non-admin → 403.
- Unknown id → 404.

**Production change**:
1. `GrappaWeb.Admin.VisitorsController.delete/2` calls
   `Visitors.delete!/1` (shared with T-3's `bin/grappa
   delete-visitor`).
2. Router entry.

**Deploy**: HOT.

### M-4 — GET /admin/visitors + GET /admin/sessions

**Failing test first**: controller + integration:
- Returns combined DB + live state per MD2.
- `live_state.alive: false` flagged for DB-connected-but-no-pid
  rows (U-0 honesty signal).

**Production change**:
1. `Visitors.list_all/0` + `Sessions.list_all/0` (live BEAM
   introspection + DB join).
2. `Grappa.LiveIntrospection` helper (centralizes
   `Registry.select` + `Process.info` patterns; used by all live-
   state controllers).
3. Wire shape via `*.Wire` modules per CLAUDE.md.

**Deploy**: HOT.

### M-5 — GET/PATCH /admin/networks (caps editable; reaper trigger; circuit reset)

**Failing test first**:
- PATCH updates `max_concurrent_visitor_sessions` (already named
  this way post-U-1, but M-5 lands BEFORE U cluster — see Order
  note below) → cap takes effect on next spawn.
- Reaper trigger returns 202 + count of swept rows.
- Circuit reset clears ETS state.

**Order note**: M-5 ships with the CURRENT
`max_concurrent_sessions` field; U-1 renames to
`max_concurrent_visitor_sessions` + adds
`max_concurrent_user_sessions`. The console field labels update at
U-3 (when cic gains both fields). Until then console shows single
"max sessions" field.

**Production change**:
1. `Networks.update_caps/2`, `Networks.list_all/0`.
2. `Reaper.run_now/0`, `NetworkCircuit.reset/1` admin-callable.
3. Controller wire shapes.

**Deploy**: HOT.

### M-6 — GET/PATCH /admin/users + GET/PATCH /admin/credentials

**Failing test first**:
- PATCH /admin/users/:id toggles is_admin.
- PATCH /admin/credentials/:user_id/:network_id edits autojoin /
  nick / sasl_user (NOT password — separate endpoint).
- Password reset is a SEPARATE endpoint that emits a one-time link
  or temp password (defer to a future cluster — flag in this
  bucket's exit but don't ship).

**Production change**: Controllers + helpers + wire shapes.

**Deploy**: HOT.

### M-7 — cic admin drawer entry + admin pane skeleton + me.is_admin gate

**Failing test first**: cic vitest:
- Drawer entry rendered when `me.is_admin === true`.
- Drawer entry HIDDEN when `me.is_admin === false`.
- Click → admin pane mounts.

**Production change**: Cic changes — drawer.tsx, new
AdminPane.tsx skeleton with tab nav.

**Deploy**: cic bundle.

### M-8 — cic admin pane: Visitors view + delete action

**Failing test first**: vitest + Playwright e2e (per
`feedback_ux_e2e_mandatory`):
- List renders from GET /admin/visitors.
- Click delete → inline confirm → second click → DELETE fires →
  visitor disappears from list.

**Production change**: Cic AdminVisitorsTab.tsx + integration into
AdminPane.

**Deploy**: cic bundle.

### M-9 — cic admin pane: Sessions view + actions

**Failing test first**: vitest + Playwright:
- List shows live session per (subject, network) with
  `live_state.alive` badge.
- Disconnect action calls POST /admin/sessions/:id/disconnect (T32
  park).
- Terminate action calls DELETE /admin/sessions/:id.

**Deploy**: cic bundle.

### M-10 — cic admin pane: Networks view + cap editor

**Failing test first**: vitest + Playwright:
- Cap field is editable inline; save fires PATCH; updated value
  echoes from server (round-trip per `feedback_target_window_ux_rule`
  spirit).
- Reaper trigger button.
- Circuit reset button.

**Production change**: Cic AdminNetworksTab.tsx.

**Deploy**: cic bundle.

### M-11 — Real-time `grappa:admin:events` topic + cic subscribe

**Failing test first**:
- Server-side: `Grappa.AdminEvents` republishes telemetry events
  onto the topic with typed wire shapes.
- Cic vitest: events tab renders typed events; exhaustiveness on
  union per `feedback_no_silent_drops_closed`.
- Integration: spawn rejection emits event; cic sees it within
  100ms.

**Deploy**: HOT + cic bundle.

### M-12 — Docs sweep

**Production change**:
1. **README.md** — "Admin console" subsection; bootstrap step
   (`bin/grappa create-user --admin`).
2. **DESIGN_NOTES.md** — M cluster summary + MD1-MD7 decisions.
3. **`docs/project-story.md`** — episode.
4. **CLAUDE.md** — admin-pipeline pattern noted under Phoenix /
   Ecto patterns (when adding `/admin/*` endpoints, use existing
   `:admin` pipeline; don't bypass).
5. **CLAUDE.md** — new rule under Code-shape rules: "DB state +
   live state are separate sources of truth — every admin resource
   listing must combine both, and `live_state: null` is the U-0
   honesty signal that something diverged. Don't paper over with
   computed-from-DB fields."

**Deploy**: none.

### M-Z — Cluster CLOSE

Same shape as T-Z + I-Z. Smoke checklist focuses on the operator
journey:

1. Login as admin → drawer entry visible.
2. Open Visitors tab → see live list including `S\`grappa`.
3. Click delete on a test visitor → confirm → row disappears within
   1s.
4. Open Networks tab → edit cap from 3 → 5 → save → spawn 5 new
   visitors → all succeed.
5. Open Sessions tab → see vjt's session live; click disconnect
   (T32 park) → cred goes to `:parked`; click reconnect (M-9
   companion) → session re-spawns.
6. Open Events tab → trigger a spawn rejection (cap-saturated) → see
   typed event in real-time.
7. Login as NON-admin user → assert no drawer entry, GET /admin/me
   returns 403.

Save memory: `project_m_admin_console_closed`.

---

# Cluster U — cap honesty + per-subject split + device-identity-change

**Position**: third. Branch: `cluster/cap-honesty` (worktree from
local main, post-M merge).

## Premise

Tonight's incident catalog (2026-05-16, during the I cluster's CORS
hotfix follow-up):

1. **`PATCH /connect` swallowed `:client_cap_exceeded`** —
   `networks_controller.ex:213-215` returns `:ok` on any spawn
   error. Comment at lines 194-197 EXPLICITLY documents the broken
   design: "If admission rejects, the DB row is already `:connected`
   (user intent persisted) ... We log the rejection but still return
   `:ok` to the caller — the transition succeeded from the
   credential perspective."
2. **Single shared cap** for visitors + users → 3 stale visitors
   ate all slots, vjt user couldn't spawn.
3. **DB cred passed to `:connected`** while NO live Session.Server
   existed → all subsequent `POST /messages` → 404 with no signal
   to the operator.
4. **Three caps exist** (not two as the original brief assumed):
   `:network_cap_exceeded`, `:client_cap_exceeded`,
   `{:network_circuit_open, _}`. U brief originally focused on
   `:network_cap`; `:client_cap` is the OTHER swallowed error and
   ALSO needs honest signaling.
5. **No way for a device to disconnect-and-reconnect-with-different-
   identity** (vjt 2026-05-16: "we should allow a device to
   disconnect and reconnect with a different identity"). Current
   `:client_cap_exceeded` is per-(client_id, network_id) — if a
   device is currently bound to subject A and the user logs out + in
   as subject B from the same browser, the OLD session may still
   hold the client_id slot until cleanup completes.
6. **Single `login_probe_timeout_ms` covers TCP+TLS+NICK+RPL_WELCOME**
   (3s in `config/config.exs:66`). Bahamut's rDNS lookup blocks 001
   emit for 5-20s when the resolver is slow, exhausting the 3s
   budget — typed `:timeout` → 504. Tonight's intermittent visitor-
   login failures all rooted here (vjt 2026-05-16: "3s di timeout
   sono troppo pochi e vanno aumentati almeno a 20"). No failover
   either — `Servers.pick_server!/1` returns lowest priority only;
   `irc.azzurra.chat` (priority 10) exists in `network_servers` but
   is never tried. Single point of fragility.

## Decisions already made

- Rename `max_concurrent_sessions` → `max_concurrent_visitor_sessions`
  (column + schema field + every caller; total consistency per
  CLAUDE.md).
- Add `max_concurrent_user_sessions INTEGER NULL DEFAULT 3`. NULL =
  unlimited.
- Backfill: copy old value into both so existing networks keep
  current behavior on the visitor side.
- Two new error atoms: `:visitor_cap_exceeded` + `:user_cap_exceeded`
  (cleanly typed, not `{:cap_exceeded, kind}` tuple).
- PATCH /connect on cap rejection: leave DB row at previous state,
  return 503 + typed error.
- Cic shows banner with localized copy (per
  `feedback_no_localized_strings_server_side`).
- U-0 (stop-swallow fix) is INSIDE U cluster, not pre-cluster
  (vjt 2026-05-16: "ok keep this change in U it's not a problem
  porco dio it's ok to have all U clustered together").

## Brainstorm dimensions

### UD1. Subject-aware admission via `Grappa.Subject.t()`

Post-CP32 (visitor-parity), `Grappa.Subject` is the typed
identity. `Admission.check_network_total/1` splits:

```elixir
@spec check_visitor_cap(network_id, subject) :: :ok | {:error, :visitor_cap_exceeded}
@spec check_user_cap(network_id, subject) :: :ok | {:error, :user_cap_exceeded}

defp check_network_total(network_id, {:visitor, _, _}), do: check_visitor_cap(network_id)
defp check_network_total(network_id, {:user, _, _}), do: check_user_cap(network_id)
```

`count_live_sessions/2` filters Registry keys by shape:
- Visitor count: `Registry.select(SessionRegistry, [{... {:visitor, _, network_id}, ...}])`.
- User count: same with `{:user, _, network_id}`.

**Resolution**: Decision UD1.

### UD2. Audit ALL spawn call sites for swallowed errors

Per `feedback_no_silent_drops_closed` (CP31 class fix): the U-0
swallow is one INSTANCE of a broader class. Audit:

1. `GrappaWeb.NetworksController.spawn_session_after_connect/3` —
   line 213-215. **The known bug.**
2. `Grappa.Bootstrap.spawn_session_for_credential/1` — handles
   spawn errors silently (skip + log). Check: is the "skip and log"
   correct here? At BOOT time, yes — the alternative is "refuse to
   boot if any session fails to spawn". But the log message is
   thin; honest log should distinguish capacity rejection from
   network failure.
3. `Grappa.Visitors.Login` — propagates errors via
   `{:error, error}` return; appears honest. Verify the cic Login
   page renders the typed error.
4. `Grappa.SpawnOrchestrator` (top-level boundary module) — single
   funnel for both Bootstrap and NetworksController. Audit the
   error-shape coming out of `SpawnOrchestrator.spawn/4` —
   verify no error tuples are dropped at the boundary.

**Resolution**: U-2 (audit bucket) lands the fix to ALL spawn sites
where the swallow exists; honest-log fix at boot time. Decision UD2.

### UD3. FallbackController mapping

`:visitor_cap_exceeded`, `:user_cap_exceeded`, `:client_cap_exceeded`
→ 503 + `{error: "...", retry_after?: N}`.

**Why 503 not 429?** This is resource exhaustion, not rate limit
(the user isn't spamming; the network is full). 429 implies "try
again later, you're going too fast". 503 implies "service is at
capacity right now". Different operator action: 503 → "wait for
slot OR ask admin to bump cap"; 429 → "slow down". `Retry-After`
header is the same.

`{:network_circuit_open, retry_after}` → 503 + `Retry-After:
<retry_after>` header (already lands in some paths; verify
consistency).

**Resolution**: Decision UD3.

### UD4. Cap UI in admin console

M-10 already ships a cap editor (single field
`max_concurrent_sessions`). U-3 updates it to TWO fields:
`max_concurrent_visitor_sessions` + `max_concurrent_user_sessions`,
side by side, with help text:
- "Visitor cap — concurrent sessions for anonymous + identified
  visitor subjects on this network."
- "User cap — concurrent sessions for registered users (you).
  NULL = unlimited."

The console live-states tab (M-9) gains per-network counts
"Visitors: N/cap, Users: M/cap" to make capacity visible at a
glance.

**Resolution**: Decision UD4.

### UD5. Device disconnect-then-reconnect-with-different-identity

vjt 2026-05-16: "we should allow a device to disconnect and
reconnect with a different identity."

Today's behavior: `client_cap` is per-(client_id, network_id). If a
browser holds a session as visitor `abc`, and the user logs out +
logs back in as user `xyz`, the client_id may persist (cic's
generated client ID is browser-local) and the new spawn attempt
counts AGAINST the old session's slot. Until the old session is
cleaned up, the new login fails `:client_cap_exceeded`.

**Three sub-problems**:

UD5.A — **Logout MUST terminate live sessions for that subject on
that client_id**. Today logout is "drop the auth cookie" only; the
Session.Server keeps running until QUIT timeout. Fix: logout calls
`Sessions.terminate_for_client_subject/2` synchronously.

UD5.B — **Login from a client that had a previous subject MUST not
count the previous subject against client_cap**. Fix: `Admission.
check_client_cap/1` filters Registry by `{client_id, current_subject}`
NOT by `{client_id, *}`. Different subject on same client = different
counting bucket.

UD5.C — **Visitor `/quit` (T32 nuclear-quit) MUST free the client_id
slot** for that subject. Today /quit terminates the Session.Server
and logs out, so UD5.A's logout fix covers this IF /quit goes
through the logout helper (verify).

**Resolution**: Decision UD5. U-4 ships UD5.A + UD5.B + UD5.C as
one bucket (they're tightly coupled).

### UD6. Visitor expires_at + reaper (cross-ref with T-3)

T-3 already fixes the never-reaped-visitor bug. U cluster doesn't
re-touch this. Cross-reference in the U-Z retro for completeness
but T-3 is the canonical fix.

### UD7. Login probe timeout split — `connect` vs `RPL_WELCOME` vs `wait_for_ready`

vjt 2026-05-16: "3s di timeout sono troppo pochi e vanno aumentati
almeno a 20. e poi tipo avere diversi timeout... connect timeout 3s
può anche andare bene. poi rpl_welcome timeout è un'altra cosa e
dovrebbe essere 30."

**Root cause for tonight's intermittent 504**: single
`:login_probe_timeout_ms` (3s in `config/config.exs:66`) covers the
ENTIRE login flow from TCP `connect` through TLS handshake through
NICK/USER through `RPL_WELCOME` (001). When `raccooncity` rDNS
lookup is slow (Bahamut blocks 001 emit until reverse-PTR
resolves), the 3s budget exhausts before the 001 arrives — typed
`:timeout` error → 504.

`raccooncity.azzurra.chat` is the SOLE configured server for azzurra
(priority 0; `irc.azzurra.chat` at priority 10 exists in
`network_servers` but `Servers.pick_server!/1` only returns lowest
priority — Phase 5 failover is not yet implemented). No headroom.

**Two distinct concerns, two distinct timeouts:**

- **`connect_timeout_ms`** (3s default — keep): TCP `connect` +
  TLS handshake. If the leaf can't even establish a socket in 3s,
  it's down or routing-broken. Fail fast.
- **`rpl_welcome_timeout_ms`** (30s NEW): wait for `RPL_WELCOME`
  (001) after sending NICK/USER. Accommodates Bahamut's rDNS
  blocking (5-20s observed in the wild), ident-lookup wait, and
  remote-cluster propagation delays. 30s is generous but cheap —
  the operator's request is parked in a Phoenix request process,
  not bound to compute.
- **`session_ready_total_timeout_ms`** (computed = connect +
  rpl_welcome + small slop = ~35s): the OUTER `wait_for_ready`
  receive-block budget. Must be at LEAST `connect + rpl_welcome` or
  the inner timeouts can't even fire before the outer one wins —
  the typed error must surface the INNER cause, not the outer.

Today's `:login_probe_timeout_ms` becomes the OUTER bound; two new
config keys carry the inner budgets:

```elixir
config :grappa, :admission,
  # ... existing ...
  login_connect_timeout_ms: 3_000,         # TCP+TLS
  login_rpl_welcome_timeout_ms: 30_000,    # NICK/USER → 001
  login_probe_timeout_ms: 35_000           # outer wait_for_ready bound
```

**Failure-type granularity**: instead of one `:timeout` atom, three
typed errors — `:connect_timeout` (TCP/TLS phase),
`:welcome_timeout` (NICK/USER → 001 phase), `:probe_timeout`
(catchall, should never fire if inner budgets are honored).
FallbackController maps:
- `:connect_timeout` → 503 + Retry-After: 30 ("network reachable
  but handshake failed"; immediately retryable)
- `:welcome_timeout` → 503 + Retry-After: 60 ("network is slow or
  overloaded; wait a minute")
- `:probe_timeout` → 500 (programmer error; alert in logs)

Per `feedback_no_localized_strings_server_side`, cic owns the
human-readable copy; server sends typed atoms.

**Resolution**: Decision UD7. Lands in U-2 as a sub-bucket
(U-2-timeouts), packed in the same audit pass as the rest of
admission. Doesn't need its own bucket — change is one function
in `Visitors.Login.wait_for_ready/5` + three config keys + three
FallbackController clauses. Tests: extend UD8.5 with timeout-typed
assertions per phase.

### UD8. Migration deploy class

New column + rename + backfill → **COLD** per
`feedback_cluster_with_migration_must_cold` (deploy.sh hot path
skips ecto.migrate; new column queries crash).

### UD9. Tests

1. Migration round-trip (up + down + data preserved).
2. Admission split — 6 cases:
   - Visitor at cap, visitor subject → `:visitor_cap_exceeded`.
   - Visitor at cap, user subject → `:ok` (user cap separate).
   - User at cap, user subject → `:user_cap_exceeded`.
   - User at cap, visitor subject → `:ok`.
   - Client at cap, same subject → `:client_cap_exceeded`.
   - Client at cap, DIFFERENT subject → `:ok` (UD5.B).
3. Controller test asserts DB unchanged on spawn fail (NOT
   `:connected`).
4. Cic vitest: banner renders typed error.
5. Playwright e2e (per `feedback_ux_e2e_mandatory`):
   - Fill visitor cap → user /connect → user spawn SUCCEEDS (user
     cap separate).
   - Fill user cap → user /connect → assert banner with copy.
   - Logout as visitor → login as different subject → assert spawn
     succeeds (UD5.B).
6. Bootstrap honest-log: at-startup state where some creds are
   `:connected` and some are `:parked`, assert log line includes
   counts.
7. Timeout-phase typed errors (UD7):
   - Mock TCP-connect hang → `:connect_timeout` after 3s (not 30s,
     not 35s — inner budget wins).
   - Mock NICK/USER sent but no 001 → `:welcome_timeout` after 30s.
   - Outer `:probe_timeout` should not fire when inner timeouts are
     honored; if it does, that's a programming-error assertion.

### UD10. Codify CLAUDE.md rule

Per CP31 / `project_no_silent_drops_closed`:

> **No silent-swallow at controller spawn sites.** Any orchestrator
> that returns ok-or-error must NOT be wrapped in a controller helper
> that throws away the error and returns ok. The general class is
> "DB intent persisted but live state failed" — operator MUST see
> the failure. Examples: `NetworksController.spawn_session_after_connect/3`
> before U-0 swallowed cap-rejection; the fix is the pattern, not
> the specific instance.

Lands in U-6 (docs sweep). Decision UD10.

## Buckets

### U-0 — Stop-swallow fix (NetworksController.spawn_session_after_connect/3)

**Failing test first**: controller test:
- Mock `SpawnOrchestrator.spawn/4` to return
  `{:error, :network_cap_exceeded}` → controller returns 503 +
  typed error body. DB cred stays at PREVIOUS state (not
  `:connected`).
- Same for `:client_cap_exceeded`, `:visitor_cap_exceeded`,
  `:user_cap_exceeded`, `{:network_circuit_open, _}`.
- Success path unchanged.

**Production change**:
1. `NetworksController.apply_transition/5` no longer commits the
   DB transition to `:connected` BEFORE the spawn succeeds.
   Restructure: spawn FIRST, THEN commit DB on success. On spawn
   error, DB rolls back (or never commits — pick the cleaner
   shape).
2. `FallbackController` adds clauses for the three cap atoms +
   circuit-open + `:visitor_cap_exceeded` + `:user_cap_exceeded`
   (placeholder; full set lands in U-2).
3. Update comment at controller.ex:194-197 — document the new
   correct semantics.

**Deploy**: HOT.

### U-1 — Schema: rename + add `max_concurrent_user_sessions` + backfill

**Failing test first**: migration round-trip + helper tests:
- Old `max_concurrent_sessions` value copies into
  `max_concurrent_visitor_sessions`.
- New column `max_concurrent_user_sessions` defaults to 3 (or
  NULL — see Decision below).
- `Networks` schema exposes both fields.

**Decision on default for `max_concurrent_user_sessions`**: 3 (mirror
current visitor cap) per orchestrator brief. NULL semantics
(unlimited) supported but not the default — operator opts in to
unlimited via admin console.

**Production change**:
1. Migration: rename column + add column + backfill.
2. `Grappa.Networks.Network` schema rename + add field.
3. Every reference site updated (full grep + replace; total
   consistency per CLAUDE.md).
4. `Admission` helpers updated to read both fields (but logic
   unchanged in this bucket — split logic lands in U-2).

**Deploy**: COLD per `feedback_cluster_with_migration_must_cold`.

### U-2 — Admission split + subject-aware count + spawn-site audit + timeout split

**Failing test first**: admission unit tests (6 cases per UD9.2)
+ Bootstrap honest-log test + spawn-site audit verification +
3 timeout-phase tests per UD9.7.

**Production change**:
1. `Admission.check_network_total/2` becomes subject-aware (per
   UD1).
2. `Admission.check_client_cap/2` filters by (client_id, subject)
   per UD5.B.
3. Bootstrap honest log (`feedback`-class for log honesty).
4. Audit all spawn sites per UD2; fix ALL silent-swallow paths
   uncovered.
5. **Login probe timeout split** per UD7:
   - `config/config.exs` adds `login_connect_timeout_ms: 3_000`
     + `login_rpl_welcome_timeout_ms: 30_000`; the existing
     `login_probe_timeout_ms` becomes the OUTER bound
     (`30_000 + 3_000 + slop = 35_000`).
   - `Visitors.Login.wait_for_ready/5` distinguishes inner
     `:connect_timeout` from `:welcome_timeout`; outer
     `:probe_timeout` is the catchall (programmer-error assertion).
   - `Session.Client` exposes the phase distinction so the typed
     atom reaches `Visitors.Login`.
6. FallbackController + `auth_controller.ex:339-343` clauses split
   `:timeout` into `:connect_timeout` / `:welcome_timeout` /
   `:probe_timeout` per UD7.

**Deploy**: HOT.

### U-3 — FallbackController + cic banner + admin pane field add

**Failing test first**: controller (UD3 mapping); cic vitest
(banner); admin pane vitest (cap editor splits to two fields).

**Production change**:
1. `FallbackController` exhaustive clauses for all five typed
   errors.
2. Cic banner component reads typed error, localizes copy per
   `feedback_no_localized_strings_server_side`.
3. Cic admin Networks tab gains second cap field.

**Deploy**: HOT + cic bundle.

### U-4 — Device-identity-change (UD5.A + B + C)

**Failing test first**: integration:
- Spawn visitor session → logout → assert Session.Server is `:DOWN`
  before logout returns.
- Login as user from SAME client_id → spawn succeeds even if
  client_cap = 1 was already at 1.
- Visitor /quit → assert client_id slot freed for next login.

**Production change**:
1. `Sessions.terminate_for_client_subject/2` (synchronous).
2. Logout helper calls it BEFORE dropping cookie.
3. `Admission.check_client_cap/2` filters by (client_id, subject)
   (already lands in U-2; verify here).
4. Visitor /quit path routes through logout helper.

**Deploy**: HOT.

### U-5 — Cic admin console: per-network live cap counters

**Failing test first**: cic vitest + Playwright:
- Networks tab shows "Visitors: 1/3, Users: 0/3" per network.
- Counts update in real-time via grappa:admin:events (cap-relevant
  events emit on spawn / terminate).

**Production change**:
1. `Grappa.AdminEvents` extended with `cap_change` typed event
   (kind: `:session_spawned | :session_terminated`, payload:
   network_slug + visitor_count + user_count + caps).
2. Cic Networks tab subscribes; renders counts.

**Deploy**: HOT + cic bundle.

### U-6 — Docs sweep + CLAUDE.md rule

**Production change**:
1. **README.md** — note the two-cap model in the Operator section.
2. **DESIGN_NOTES.md** — U cluster summary + UD1-UD10 decisions +
   the swallow-bug retrospective (with the failing-comment 194-197
   excerpt as a lesson).
3. **`docs/project-story.md`** — episode.
4. **CLAUDE.md** — UD10 rule under Engineering Standards →
   Code-shape rules.

**Deploy**: none.

### U-Z — Cluster CLOSE

Same shape as T-Z + M-Z. Smoke focuses on the cap honesty journey:

1. Login as user → /connect on a cap-saturated network → assert cic
   banner shows "User cap exceeded (3/3). Ask admin to bump." → DB
   stays at previous state.
2. Admin opens console → Networks tab → bumps user cap from 3 to 5
   → user /connect succeeds.
3. Spawn 3 visitors + 1 user simultaneously → assert independent
   caps (visitor cap doesn't block user spawn).
4. Logout as visitor → login as user → assert session spawns even
   though client_id had a visitor slot.
5. Visitor /quit → admin console shows client_id slot freed.
6. Trigger admission rejection → admin console Events tab shows
   typed event with capacity reason.
7. Code-grep verify: NO `{:error, _} -> :ok` patterns anywhere in
   `lib/grappa_web/controllers/`.
8. Timeout phase smoke (UD7): block `:gen_tcp.connect/4` via
   iptables DROP on the azzurra leaf IP from inside the container
   → visitor login → assert `:connect_timeout` typed error after
   ~3s, NOT 504. Unblock; smoke happy-path resumes.

Save memory: `project_u_cap_honesty_closed`.

---

# Cross-cluster discipline (codified)

- **Clear between clusters.** Per vjt: "ensure to clear between
  each cluster. i'll let orchestrator guide you." Each cluster gets
  its own /clear cycle. Orchestrator writes next session's prompt
  body to `/tmp/orchestrate-next.txt` at end-of-cluster before
  clearing.
- **Per-bucket deploy** (per `feedback_per_bucket_deploy`): sibling
  deploys + healthchecks + browser-smokes at each bucket close.
- **Browser smoke for cic-touching buckets** (per
  `feedback_cicchetto_browser_smoke`): real-browser smoke at close,
  via Chrome DevTools against irc.sniffo.org.
- **Reviewer loop** (per `feedback_subagent_driven_development`):
  code-reviewer agent on migration + cross-surface buckets.
- **Gate-tail evidence** (per `feedback_landed_claim_evidence`):
  literal `scripts/check.sh` exit-0 tail in each cluster's
  checkpoint; standalone `scripts/dialyzer.sh` per
  `feedback_dialyzer_plt_staleness`.
- **Local-pre-merge defeats deploy preflight** (per
  `feedback_deploy_preflight_empty_diff_after_merge`): for any
  bucket with a state-shape change or migration, manually inspect
  + pass `--force-cold` defensively.
- **NON-FINDING discipline** (per
  `feedback_mega_cluster_lessons`): when an audit bucket finds
  nothing, document the audit explicitly. Empty result is a
  finding.

---

# Memories that ARE relevant

- `project_image_cluster_closed` — last cluster's CLOSED memory;
  mirror its shape for T/M/U CLOSED memories.
- `project_post_p4_1_arc` — arc state (already updated to mark
  images CLOSED); update again at each of T/M/U close to slot the
  next item.
- `feedback_no_localized_strings_server_side` — banners in cic, not
  server (U-3 cap-exceeded banner).
- `feedback_no_silent_drops_closed` (CP31) — informs U-0 + U-2.
- `feedback_cluster_with_migration_must_cold` — applies to M-1 +
  U-1.
- `feedback_deploy_sh_preflight_field_addition_gap` — applies to
  any state-shape change in long-lived GenServers (M-1, U-1).
- `feedback_landed_claim_evidence` — gate-tail in checkpoints.
- `feedback_dialyzer_plt_staleness` — standalone Dialyzer at close.
- `feedback_subagent_driven_development` — reviewer loop on
  migrations + cross-surface.
- `feedback_per_bucket_deploy` — per-bucket deploy + healthcheck.
- `feedback_cicchetto_browser_smoke` — real-browser smoke at
  cic-touching bucket close.
- `feedback_readme_currency` — README updates land in-step.
- `project_visitor_parity_cluster_closed` — subject parity invariant
  + two-tier identity model (covers U's subject-aware admission).
- `project_t32_disconnect_verb` — T32 park verb + connection_state
  semantics (M-9 disconnect action uses this).
- `project_t31_admission_control` — T31 admission + cap landscape
  (U cluster extends this).
- `project_network_circuit_ets_leak` — known issue; U-Z reviews
  whether U cluster touches the same surface.

---

# Authoritative refs

- `CLAUDE.md` — engineering standards; "Ask before building";
  "Total consistency or nothing"; "No silent drops".
- `lib/grappa_web/controllers/networks_controller.ex` — U-0
  surface (lines 175-216; the broken comment at 194-197).
- `lib/grappa/admission.ex` — U-1/U-2 surface; type definitions
  at 60-71; cap check chain at 88-106.
- `lib/grappa/bootstrap.ex` — T-A6 (honest log surface line 200);
  spawn loop at 187.
- `lib/grappa/networks/credentials.ex` — `list_credentials_for_all_users/0`
  at 295 (T-A6 needs `count_by_state/0` companion); cred state
  transitions at 284+ (M-9 disconnect uses).
- `lib/grappa/visitors/login.ex` — T-3 + T-A7 surface (set
  `expires_at` on insert).
- `lib/grappa/visitors/reaper.ex` — T-3 verifies behavior post-fix.
- `lib/mix/tasks/grappa.delete_visitor.ex` (stashed) — T-3 pops +
  rewrites.
- `scripts/_lib.sh` line 184 — T-A3 drops the MIX_ENV=dev
  override.
- `scripts/db.sh` — T-A2 replaces with `bin/grappa open-db` (RW).
- `scripts/mix.sh` — T-A3 KEEPS the name; behavior changes
  (auto-detect MIX_ENV + `--env=` flag).
- `bin/start.sh` — T-2 adds sname + cookie flags.
- `compose.yaml` — env vars for RELEASE_COOKIE in dev (T-2).
- `infra/snippets/security-headers.conf` — no change.
- `infra/nginx.conf` — no change.
- `scripts/deploy.sh` + `scripts/deploy-cic.sh` — deploy paths;
  COLD for M-1 + U-1 + T-2 + T-3; HOT elsewhere; cic bundle for
  all cic-touching buckets.
- `docs/plans/2026-05-15-images-cluster.md` — predecessor brainstorm
  shape; this doc mirrors it.

---

# Order of operations summary

1. **Today (sibling session post-doc-bless)**: orchestrator clears,
   sibling reads `/tmp/orchestrate-next.txt`, starts T cluster.
2. **T cluster timeline**: T-1 (host script + tests) → T-2 (sname +
   remsh) → T-3 (delete-visitor + expires_at fix) → T-4 (docs sweep
   + honest log) → T-Z. Per-bucket deploys for T-2 (COLD) + T-3
   (COLD) + T-4 (HOT).
3. **Clear**, then **M cluster timeline**: M-1 (migration) → M-2
   (pipeline) → M-3 (delete visitor verb) → M-4..M-6 (list +
   network + user surfaces) → M-7..M-10 (cic admin pane) → M-11
   (events topic) → M-12 (docs) → M-Z. Per-bucket deploys: COLD for
   M-1, HOT for all others, cic bundle for M-7+.
4. **Clear**, then **U cluster timeline**: U-0 (stop swallow) → U-1
   (migration) → U-2 (admission split + audit) → U-3 (controller +
   cic banner + admin pane field) → U-4 (device identity change) →
   U-5 (live counters in console) → U-6 (docs) → U-Z. Per-bucket
   deploys: HOT for U-0, COLD for U-1, HOT for rest, cic bundle for
   U-3 + U-5.

Each cluster ends with `project_<cluster>_closed` memory, CP3X
checkpoint, README + DESIGN_NOTES + project-story episode, and an
update to `project_post_p4_1_arc` pointing at the next cluster.

# Open questions for vjt

All cluster-shape decisions are resolved per the orchestrator brief
+ this session's refinements.

Resolved post-v1:
- **Q-MIX-RENAME** ✅ (vjt 2026-05-16): no rename — `scripts/mix.sh`
  keeps name + becomes prod-capable (auto-detect MIX_ENV +
  `--env=` flag). See T-A3 revision.
- **Q-FIRST-ADMIN** ✅ (vjt 2026-05-16): first admin user named
  `grappa`. Bootstrap via `bin/grappa create-user --admin --name
  grappa --password <prompt>`. Option A per M-A7.

---

# v0 → v1 diff (this is v1)

First version; nothing to diff against.
