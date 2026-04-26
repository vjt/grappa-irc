# 2j cluster code review — 2026-04-26

Worktree: `/home/vjt/code/IRC/grappa-phase2`, branch `phase2-auth`.
5 commits: `be9c2ff..c5dc39f`. Full delta `git diff main..HEAD`.
All gates green at review-start (378 tests / 6 properties / dialyzer 0
errors / credo strict clean / sobelow clean / boundary clean).

Findings only, no praise. Sorted CRITICAL → HIGH → MEDIUM → LOW.

---

## CRITICAL

### S1. README operator quickstart writes to the WRONG database post-deploy

**File:** `README.md:67-87` (Operator quickstart, "Add an operator account
+ bind a network" section). Causal chain: `scripts/mix.sh` →
`scripts/_lib.sh` lines 42-46, 122-137.

**Category:** Documentation correctness / operator misdirection
**Severity:** CRITICAL

**Description:**
The README walkthrough has the operator run `scripts/deploy.sh` (which
brings up the **prod** container against `runtime/grappa_prod.db`) and
THEN run:

```sh
scripts/mix.sh grappa.create_user --name vjt --password '...'
scripts/mix.sh grappa.bind_network --user vjt --network azzurra ...
docker compose -f compose.prod.yaml restart grappa
```

But `scripts/mix.sh` invokes `in_container_or_oneshot` which defaults
`COMPOSE_FILE=compose.yaml` (dev) unless `GRAPPA_PROD=1` is set. The
running prod container belongs to `compose.prod.yaml`'s project, so
`docker compose -f compose.yaml ps -q grappa` returns empty → fallback
to oneshot → uses `image: grappa:dev` with `MIX_ENV=dev` and
`DATABASE_PATH=/app/runtime/grappa_dev.db` (compose.yaml line 45).

**Net effect:** the operator follows the README to the letter, the user
+ credential rows land in the **dev DB**, the prod container restarts,
Bootstrap reads **prod DB** (empty), logs `no credentials bound`, and
the operator's "deploy" is silently broken. The user goes to log in via
the prod REST surface and gets `:invalid_credentials` because their row
is in the wrong file. There is no error anywhere in the chain to point
them at the cause — it's the most operator-hostile failure mode
imaginable.

**Madonna porca.** This is the single bug worth cursing about in this
cluster: every word of the new operator quickstart is structurally
unrunnable post-deploy.

**Fix:** Pick one of three paths and document it in the README:

1. Add `GRAPPA_PROD=1` to every post-deploy mix invocation:
   ```sh
   GRAPPA_PROD=1 scripts/mix.sh grappa.create_user ...
   ```
   But `scripts/_lib.sh` will then try to oneshot against
   `compose.prod.yaml` whose `target: runtime` image has NO `mix`
   binary (Dockerfile lines 82-111 — runtime stage is debian-slim with
   only the OTP release). This will fail at `docker run … mix …` with
   "executable file not found in $PATH". So this path requires *also*
   adding mix tools back to the runtime image, which defeats the point
   of the slim release.

2. Add a release-eval shape: expose the operator surface as functions
   in `Grappa.Release` (or a new `Grappa.Operator` module), then call
   them via `docker compose -f compose.prod.yaml exec grappa bin/grappa
   eval 'Grappa.Operator.create_user("vjt", "pw")'`. This is the
   idiomatic prod-OTP path and matches how `Grappa.Release.migrate()`
   is already invoked in `scripts/deploy.sh` (line 37). The mix tasks
   stay as the dev-time/test-time shape; release-eval becomes the
   prod-time shape; both call the same `Grappa.Accounts` /
   `Grappa.Networks` context functions.

3. Add a dedicated wrapper `scripts/operator.sh` that conditionally
   shells into the live prod container's release CLI when prod is
   running. README only ever recommends `scripts/operator.sh
   create_user --name vjt ...`, not raw `mix.sh`.

Path 2 is the cleanest — it inherits the migrate path's architectural
shape and surfaces a typed function call instead of an args-parsing
mix task running in a transient sidecar. Whichever path is picked, the
README walkthrough must be re-tested end-to-end against an empty
`runtime/grappa_prod.db` on a fresh clone before being declared
correct.

Also: README line 86 invokes raw `docker compose -f compose.prod.yaml
restart grappa` — CLAUDE.md "What NOT To Do" explicitly forbids raw
`docker compose` ("NEVER raw `docker compose` — use `scripts/*.sh`").
The cleanest fix is to re-run `scripts/deploy.sh` (which already
recreates the container) or add a `scripts/restart.sh`.

---

### S2. README "Roadmap" section contradicts the new "Status" section

**File:** `README.md:27-32` (Status) vs `README.md:237-282` (Roadmap)
**Category:** Documentation correctness / project trajectory
**Severity:** CRITICAL

**Description:**
The new Status (line 29-31) reads:

> Pre-alpha — the server walking skeleton (Phase 1) and most of multi-user
> auth (Phase 2) have landed.

But the Roadmap directly below (lines 237-282) is the **original
Phase-0 spec roadmap** with **every checkbox unticked** in Phase 1 AND
Phase 2:

```
### Phase 0 — spec (you are here)         ← line 240, also wrong
- [x] README
- [x] Server language: Elixir/OTP + Phoenix
- [ ] OpenAPI schema for the REST surface
- [ ] Pick a client framework

### Phase 1 — server walking skeleton
- [ ] Single-user bouncer ...
- [ ] Basic REST ...
[...all Phase 1 + Phase 2 boxes empty...]
```

`docs/checkpoints/2026-04-25-cp07.md:14` and the worktree's CP06 close
both confirm Phase 1 is COMPLETE + LIVE on Pi (line 52: "bouncer up at
http://192.168.53.11:4000, connected to azzurra as `vjt-grappa`").
Phase 2 Sub-tasks 2a through 2j are all merged with green CI per the
checkpoint and the worktree git log. The Roadmap is drift from the
last six weeks of work.

Additional drift in the same Roadmap:
- Line 240: "Phase 0 — spec (you are here)" — six weeks out of date.
- Line 286: "Pre-alpha. Issues welcome for design feedback on this spec;
  code PRs are deferred until Phase 1 lands." Phase 1 has landed.

**Fix:** Sweep the Roadmap to check (`[x]`) every item that's actually
shipped. Move the "you are here" marker. Update the Contributing
section. Or — since this is the third Status iteration this README has
gone through and the Roadmap has been drifting since project init —
extract the per-phase status into the checkpoint or todo and have the
README link out to a single source of truth.

If S1 is the bug worth cursing about, S2 is the bug that made vjt say
"the new Status is ALSO inaccurate" in the review brief — and they
were right.

---

## HIGH

### S3. `Grappa.Accounts.get_user_by_name/1` is dead code with stale rationale

**File:** `lib/grappa/accounts.ex:120-133`
**Category:** Drift / total-consistency violation
**Severity:** HIGH

**Description:**
The `@doc` block reads:

> Used by `Grappa.Bootstrap`, where a TOML user with no DB row should
> be logged + skipped (best-effort boot per Bootstrap's "running
> web-only" doctrine), not crash the supervision tree.

Post-2j there is no TOML, no "user without DB row" scenario, and
Bootstrap does not call this function. `grep -rn "get_user_by_name\b"
lib/ test/` confirms only the bang variant has callers (the three
mix tasks: bind_network, unbind_network, update_network_credential).
The non-bang `get_user_by_name/1` has zero callers post-2j.

CLAUDE.md "Total consistency or nothing": the codebase IS the
instruction set. A future Claude reading `accounts.ex` and grepping
"Bootstrap" will find this stale prose and propagate the wrong mental
model. The function is also explicitly mentioned in the moduledoc
(`accounts.ex:8`) as part of the public surface, which means dropping
it requires a moduledoc edit too.

**Fix:** Either delete `get_user_by_name/1` entirely (and remove from
the moduledoc public-surface list), or rewrite the @doc to describe
the actual Phase 2 use case (probably "future REST surface for user
listing" — but if that's hypothetical, just delete it). The current
"TOML user" prose is unambiguously wrong and survives a 2j review only
because nothing automated catches stale narrative inside @doc blocks.

---

### S4. `docs/todo.md` carries stale "Bootstrap warning split" item that references deleted `Grappa.Config`

**File:** `docs/todo.md:35-41`
**Category:** Drift / total-consistency
**Severity:** HIGH

**Description:**
The "High" tier item reads:

> Phase 5 hardening: Bootstrap warning split (originally A20). S14
> partially fixed via `Config.format_error/1` + per-tag log lines;
> remaining work is operator-facing UX polish ...
> **Note:** `Grappa.Config` is DELETED in Phase 2 sub-task 2j; this
> item moves into Phase 2 Bootstrap rewrite scope (operator-facing
> warning shape on invalid DB state).

The note says "moves into Phase 2 Bootstrap rewrite scope," but 2j(b)
finished the rewrite and did not address the warning UX (it has
exactly two log lines: `bootstrap done` summary + the per-credential
`session start failed`). The item is now either (a) closed-but-not-
deleted or (b) carryover-to-Phase-5 with the wrong scope description.

Per CLAUDE.md "Done items: remove from todo.md, record in checkpoint":
if the warning UX is genuinely landed in 2j, delete the item; if it's
a Phase 5 carryover, rewrite it to describe the post-2j warning
surface (Bootstrap.run/0's warning + per-session error log) without
referencing `Config.format_error/1` (deleted) or "Phase 2 Bootstrap
rewrite scope" (closed).

---

### S5. README first-deploy walkthrough has a bootstrap-order ambiguity

**File:** `README.md:42-65` (First deploy section)
**Category:** Documentation correctness
**Severity:** HIGH

**Description:**
Step 2 has the operator run `scripts/mix.sh phx.gen.secret` and
`scripts/mix.sh grappa.gen_encryption_key` BEFORE `scripts/deploy.sh`.
On a fresh clone with no images built, the first `scripts/mix.sh`
invocation will trigger `in_container_or_oneshot` → fall to oneshot →
`docker compose -f compose.yaml run --rm` → image `grappa:dev` doesn't
exist → `pull_policy: never` (compose.yaml line 23) blocks pull → docker
compose has to build from `Dockerfile` `target: build`.

That build pulls the hexpm/elixir base image, runs apt-get, fetches
hex deps, and compiles them — easily 5-10 minutes on a Pi. There is no
hint in the README that step 2 has this hidden cost. An operator who
expects "generate two strings" to take 10 seconds will think the
process is hung.

The deploy.sh script (line 24) builds `compose.prod.yaml` which targets
the `runtime` stage (lines 82-111 of Dockerfile) — that stage cascades
through `release` → `build`, so the dev image's build artifacts exist
on the host as a side-effect AFTER step 3, not before step 2. Reordering
step 3 before step 2 would mean the secret-gen happens against the
prod release container... which has no `mix` binary either, so that
doesn't work.

**Fix:** Either (a) add a `scripts/build.sh` step that explicitly does
the heavy build, then have the README walkthrough start with
`scripts/build.sh` so step 2's secret-gen is fast, or (b) make
`gen_encryption_key` and `phx.gen.secret` runnable WITHOUT the build
container (they're both pure stateless: gen_encryption_key is 4 lines
of `:crypto.strong_rand_bytes`; phx.gen.secret is similar). A tiny
host-side shell script could do both. (c) Add a one-line warning to
the README: "First mix.sh invocation builds the dev image; expect
~10 minutes on a Pi."

Tied to S1 — the operator-experience here is fragile in multiple ways.

---

### S6. Bootstrap moduledoc misrepresents `start_link` shape

**File:** `lib/grappa/bootstrap.ex:42-48` (moduledoc) vs `:69-70`
(actual signature)
**Category:** API documentation drift
**Severity:** HIGH

**Description:**
The moduledoc says:

> `run/0` is the synchronous, testable function. Production wires
> `start_link/0` (which spawns `run/0` under a `Task.start_link/3`) so
> Bootstrap participates in the supervision tree.

But the actual function is `start_link/1`, not `start_link/0`:

```elixir
@spec start_link(term()) :: {:ok, pid()}
def start_link(_), do: Task.start_link(__MODULE__, :run, [])
```

The arg exists because `use Task` generates a `child_spec/1` that
forwards an arg via `start_link/1`. The supervisor-side code in
`lib/grappa/application.ex:59` writes `[Grappa.Bootstrap]`, which
expands via `child_spec(arg)` where `arg = nil` (no second element in
the child tuple when the entry is a bare module atom).

Since the arg is permanently ignored, the function shape is
type-incorrect. Per CLAUDE.md "State the contract: signature + failure
mode in one sentence before implementing" + "No default arguments via
`\\` ... default arguments create silent degradation paths" — the same
principle says "no silently-ignored arguments either." A future caller
who reads the spec and passes meaningful work in will discover the
silent drop only by reading the function body.

**Fix:** Two clean shapes:

1. Define `start_link/0` AND override `child_spec/1` to produce a
   no-arg start spec: `child_spec(_), do: %{id: __MODULE__, start:
   {__MODULE__, :start_link, []}, restart: :transient}`. Then drop
   `start_link/1` entirely. This is the type-correct shape.

2. If you want to keep `use Task`'s generated child_spec (for
   `restart: :transient` inheritance), at minimum update the moduledoc
   to say `start_link/1` and document that the arg is intentionally
   ignored because the work-source is the DB. This is the minimal fix.

Path 1 is closer to CLAUDE.md's "fix root causes" principle — the
arg is ignored because there's nothing meaningful for it to be.

---

## MEDIUM

### S7. `Grappa.Networks` moduledoc public-surface list is incomplete

**File:** `lib/grappa/networks.ex:7-13`
**Category:** Documentation drift
**Severity:** MEDIUM

**Description:**
The "Public surface" list in the moduledoc reads:

```
* networks: `find_or_create_network/1`, `list_users_for_network/1`
* servers: `add_server/2`, `list_servers/1`
* credentials: `bind_credential/3`, `update_credential/3`,
  `get_credential!/2`, `unbind_credential/2`,
  `list_credentials_for_user/1`
```

Missing public functions actually exported:
- `get_network_by_slug/1` (line 96) — used by REST controllers.
- `get_network!/1` (line 112) — used by Session.Server boot.
- `remove_server/2` (line 174) — used by `mix grappa.remove_server`.
- `list_credentials_for_all_users/0` (line 366) — the **headline new
  function from 2j(a)** that this entire cluster is built around.

The omission is mildly mortifying for the moduledoc of the very
context that 2j was supposed to extend. Future readers grepping the
moduledoc for "what's the public surface" will get the wrong answer.

**Fix:** Add the four missing functions to the moduledoc list.

---

### S8. `Bootstrap.run/0` empty-credentials warning has no test for "DB query crashed and returned []"

**File:** `lib/grappa/bootstrap.ex:79-89`, `test/grappa/bootstrap_test.exs:98-108`
**Category:** Defensive coverage / failure-mode coverage
**Severity:** MEDIUM

**Description:**
`run/0` matches `[]` from `Networks.list_credentials_for_all_users/0`
and logs `bootstrap: no credentials bound — running web-only`. The
spec for `list_credentials_for_all_users/0` is `[Credential.t()]` and
the function is a single `Repo.all/1` call wrapped around a query —
on a real failure (Repo down, schema mismatch, etc.), `Repo.all/1`
raises rather than returning `[]`, so the "silently returns []" path
the brief flagged isn't actually reachable. `:transient` restart
brings Bootstrap back once on a raise; if it raises again the
supervisor escalates to `:permanent` shutdown semantics for the Task.

That's the correct shape, but the empty-DB warning treats two
operationally distinct cases identically:
1. Fresh deploy, operator hasn't run any `mix grappa.bind_network` yet
   → expected, transient.
2. DB FK was working but a manual operator hand-edit dropped every
   credential row → unexpected, alarming.

Both produce the same `running web-only` warning. There's no way for
the operator to tell the two apart from log scrape alone. (1) is the
common case; (2) is rare enough that a separate log line is overkill,
but a single Logger.warning that includes a metric counter (e.g.
`network_credentials_count: 0`) would be greppable into a "freshly
deployed, this is normal" panel.

**Fix (optional, LOW-priority polish):** add a structured field to
the warning. Or document explicitly that "empty DB and missing DB
look identical to the operator; if you got the warning unexpectedly,
shell into the container and `select count(*) from network_credentials`."

---

### S9. The two-counter contract IS correct — the brief's worry is unfounded

**File:** `lib/grappa/bootstrap.ex:35-41`, `lib/grappa/networks/credential.ex:60-62` (FK definition)
**Category:** N/A — verification finding
**Severity:** N/A (non-issue, documented for the reviewer record)

**Description:**
The brief asked whether any pre-2j `:skipped` scenario (operator-action:
"create the user") now silently slides into `:failed` (operator-action:
"investigate the upstream"). Verified the FK is `belongs_to :user, User,
type: :binary_id, primary_key: true` (`credential.ex:61`) — sqlite +
ecto_sqlite3 enforces FK ON for inserts, so a credential cannot exist
without a corresponding user row. The migration
(`priv/repo/migrations/20260426000002_create_networks.exs`) confirms.

Therefore: every credential row Bootstrap reads MUST have a user; the
"user not in DB" scenario is FK-unrepresentable; the only remaining
non-success path is `Session.start_session/2` returning `{:error, _}`
which is genuinely "investigate the upstream" territory (auth failure,
no enabled server, connect refused, etc). The two counters honestly
reflect the two operator actions.

The moduledoc claim is correct as written.

---

### S10. The `Application` Boundary's `Grappa.Bootstrap` dep is justified — non-issue

**File:** `lib/grappa/application.ex:6`
**Category:** N/A — verification finding
**Severity:** N/A (non-issue, documented for the reviewer record)

**Description:**
The brief asked whether `Grappa.Application`'s Boundary listing
`Grappa.Bootstrap` is justified given the supervision-tree-only role.
Verified: `application.ex` references `Grappa.Bootstrap` in two
places — the child list (line 59: `[Grappa.Bootstrap]`) and the
`bootstrap_child/0` spec (line 56). Both are runtime references that
Boundary will reject if the dep isn't declared. The dep is necessary
and minimal.

`Grappa.Bootstrap`'s Boundary deps shrunk from `[Accounts, Config,
Networks, Session]` to `[Networks, Session]` post-2j — Accounts and
Config are no longer reached. Verified by reading the body: `run/0`
calls `Networks.list_credentials_for_all_users/0` and
`Session.start_session/2` only; the structs it pattern-matches
(`Credential`, `Network`) are exported types from `Networks`. Clean.

---

### S11. Migration file count is correct, no orphaned grappa.toml/Config references

**File:** `priv/repo/migrations/`
**Category:** N/A — verification finding
**Severity:** N/A (non-issue, documented for the reviewer record)

**Description:**
6 migrations in order: init, create_users, create_sessions,
create_networks, messages_per_user_iso, messages_network_fk_restrict.
None reference `grappa.toml` or `Grappa.Config`. Clean.

---

### S12. Logger metadata allowlist `:credentials` addition is justified, sweep was thorough

**File:** `config/config.exs:46-49`
**Category:** N/A — verification finding
**Severity:** N/A (non-issue, documented for the reviewer record)

**Description:**
Verified `config :logger, :console, metadata:` includes `:credentials`,
`:started`, `:failed` — all three emitted from `Bootstrap.run/0`'s log
lines (`bootstrap done` line at `bootstrap.ex:95-99`). `:users`,
`:skipped`, `:path` are no longer emitted anywhere in `lib/`
(`grep -rn "skipped\b" config/config.exs lib/ test/` returns the three
hits in unrelated contexts: an autojoin warning, a moduledoc word, a
bind_network usage description). Allowlist is in sync with code.

---

## LOW

### S13. `list_credentials_for_all_users/0` ordering claim mostly oversells `inserted_at` monotonicity

**File:** `lib/grappa/networks.ex:362-375`, `test/grappa/networks_test.exs:380-403`
**Category:** Opinion — docstring overclaim
**Severity:** LOW

**Description:**
The function orders by `[asc: c.inserted_at, asc: c.user_id, asc:
c.network_id]`. The docstring claims this is "deterministic across
reboots — handy when triaging 'this network failed to start, how far
did boot get'."

`inserted_at` is generated by `timestamps(type: :utc_datetime_usec)` →
DateTime.utc_now/0 at insert time, which on a Pi is monotonic at
microsecond granularity for sequential inserts. Composite-key tiebreak
catches the (rare) microsecond-tie case. So determinism IS preserved
in the dev/test/single-host posture this project lives in.

But: "handy when triaging" is the only justification offered, and the
test (`networks_test.exs:380-403`) only asserts non-decreasing order
(`Enum.sort_by(ts, fn {u, n, t} -> {t, u, n} end)`). It does NOT assert
that the order is FK-key-deterministic, only timestamp-then-key
deterministic. Two operators inserting credentials in different orders
on different hosts (Phase 5+ multi-host scenario) would see different
orderings, but that's also true for any timestamp-based sort.

The docstring claim is true for the actual deployment posture (single
sqlite, single host) and weakens only in scenarios out of scope for
this phase. Mark as opinion; no fix recommended unless the project
heads multi-host within Phase 5.

---

### S14. Inline comment in `Networks.unbind_credential/2` documents architectural debt clearly

**File:** `lib/grappa/networks.ex:250-263, 315-326`
**Category:** Opinion — observation
**Severity:** LOW

**Description:**
The duplicated `stop_session_for_unbind/2` private with a copy of
the registry-key tuple is well-documented as a Networks ↔ Session
boundary-cycle workaround. Comment explicitly flags the dep-inversion
needed to fold it back into `Grappa.Session.stop_session/2`. This is
honest architectural-debt declaration, not a bug. Noted only because
the next refactoring pass (post-Phase-2 cleanup) should pick it up
before the duplicated registry-key shape diverges in a subtle way.

---

## Summary

- **2 CRITICAL findings** — both in the README, both about the
  operator-quickstart structurally not being runnable as written
  (S1: wrong DB; S2: contradictory Status vs Roadmap).
- **4 HIGH findings** — three documentation drift (S3, S4, S6 stale
  prose), one usability cliff (S5: hidden multi-minute build).
- **6 MEDIUM/N-A findings** — 3 are non-issues raised by the brief
  (S9, S10, S11, S12 verifications); 1 is a moduledoc completeness
  miss (S7); 1 is a coverage observation (S8).
- **2 LOW findings** — opinion / observation, no fix needed.

**Recommended fix order:**
1. S1 + S2 first — the README is the operator's only door into the
   project, and it's broken in two structurally different ways. Both
   need to be addressed before declaring 2j complete.
2. S6 next — `Bootstrap.start_link/1` is the only code-shape issue
   worth landing in 2j vs deferring to Phase 5.
3. S3 + S4 + S7 — small documentation edits, batch into a single
   `docs: 2j-followup` commit.
4. S5 — README polish, can ride the same fix that addresses S1.
5. S8, S13, S14 — defer; either won't pay off or are explicitly
   documented as known.

The CRITICAL findings are the only things blocking 2j from being
declared complete in good faith. **Porco dio**, the operator UX is
the one place where "looks plausible, doesn't actually work" is the
worst possible failure mode — and right now both the README and the
deployed shape conspire to land the operator's data in the wrong DB
file with no error to point at the cause. That's what makes S1 the
load-bearing finding in this review.
