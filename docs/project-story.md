# grappa — project story

The narrative history of the codebase. One episode per significant
session: what happened, what went wrong, what right call we made and
why. The story is written in the human voice, not the AI's.

If a session has no obvious drama, find the small thing — the
assumption that turned out wrong, the pattern we settled on, the
moment the plan met reality. Routine sessions still get an episode,
because the project's institutional memory is built from them.

Format per episode:
- **`## Sn — {date} — {one-line title}`** (n = sequential session number)
- 2-5 paragraphs of prose
- (optional) **Law:** a one-line generalization that goes into
  `docs/claude-lessons.md` if applicable

---

## S1 — 2026-04-24/25 — picking the language for real

The first session. The README was already written; the spec was
already there. The walking-skeleton plan was drafted in Rust because
Rust felt like the obvious systems language for someone with a
suxserv/Bahamut background and a preference for static binaries.

Then we actually pressure-tested it.

The conversation went through three rounds of "wait, what about" — first
Elixir/OTP because the architecture (one supervised process per user,
fault-isolated, always-on) is BEAM's textbook example; then back to
Rust because the `irc` crate exists and Claude generates Rust ~15-20%
better on first pass; then back to Elixir for keeps once we asked the
right question: which factors actually matter for this project.

The decisive ones: **Phoenix Channels has no Rust equivalent** — not
"a worse one," none — and the client-experience cost of building it from
scratch (~1500 LOC server + ~800 LOC TS client + months of mobile-network
polish) was real. **Phase 6 IRCv3 listener** is materially easier in
Elixir because binary pattern matching is what Erlang was built for at
Ericsson. **BEAM's 35-year backwards-compat track record** is the only
real evidence base for "live on for 20 years."

What got rejected and recorded: hot code reload was specifically NOT
the deciding factor — reconnect-on-deploy is acceptable, and trying to
preserve TLS+IRC connection state across upgrades is research-project
territory in Rust. We picked Elixir on architecture, Channels, Phase 6,
and longevity, with the LLM-codegen quality gap explicitly acknowledged
and mitigated by rigid CI tooling (Dialyzer + Credo strict + Sobelow +
mix_audit + doctor + Boundary, every gate mandatory).

Two commits before the pivot: one snapshotting the Rust-era artifacts
as the historical record, one flipping the entire spec to Elixir
cleanly without superseded-annotations cohabiting confusingly. Then
Docker + scripts + mix scaffold + CLAUDE.md.

**Law:** when a language choice question reopens, ask which goals
actually weigh. The first answer is usually the loudest, not the truest.
Pressure-test against the spec's named priorities before committing.

---

## S2 — 2026-04-25 — Phase 1 Task 1, and what the plan didn't know

The first session that actually wrote Elixir. The plan said: TOML
loader, four tests, `reduce_while` over a list of users. Looked
copy-paste straightforward.

Then we tried to build the container and the scaffold collapsed. The
Dockerfile from S1 had been written without checking that the image
tags actually existed — `hexpm/elixir:1.19.5-erlang-28.0-*` was never
published (28.5 was the GA), and `bookworm-20251023-slim` was a date
that never made it to Docker Hub. Ten minutes later, with corrected
tags and a one-shot bootstrap of `mix.lock`, the build was clean.
Lesson: scaffolds written without smoke-testing are speculation.

Then ci.check turned up four orthogonal tooling drift bugs at once.
The `test` alias eagerly ran `ecto.create+migrate` with no `Repo`
module to point at. `mix test --cover` blew up because aliases run in
the invoking env (dev) and excoveralls is `:test`-only. Sobelow
hard-stopped on `Config.HTTPS` even though Phase 5 is when HTTPS lands
per the project plan. ExDoc warned about a missing LICENSE link
because the file existed but wasn't in `extras`. None of these are
the "real" task — they're the cost of a scaffold meeting reality for
the first time. The fix was a single commit titled `ci: stabilize
ci.check on the Phase 1 codebase` that listed all five and explained
each.

Task 1 itself almost shipped wrong. The plan's `load/1` `else` clause
pattern-matched `%File.Error{}` and a 3-tuple `{:invalid_toml, _, _}`
— and Dialyzer killed both. `File.read/1` returns `{:error, posix()}`
(an atom). `Toml.decode/1` returns a 2-tuple. The plan was authored
without consulting the actual return types. CLAUDE.md says "Dialyzer
warnings are design signals" and that turned out to be the rule of the
day: the warnings weren't pedantry, they were the plan being wrong
about reality.

The "rejects missing required fields" test had its own bug. The author
wrote `[[users]]` with no body, expecting a user-without-name. The
TOML library decodes that as `users: []` — empty list — so the
validation path under test was never reached. The test passed for the
wrong reason. Rewriting it to `[[users]]\nnickname="x"` actually
exercised the missing-name path, and a separate test caught the
empty-array case (also a malformed Phase-1 config). Two tests now,
each testing what its name promises.

The third deviation is the one worth keeping. The plan used
`Enum.reduce_while` with a `{:ok, acc}` accumulator and a pipe-to-case
unwrap at the end — the kind of code that compiles but smells. Credo
flagged the pipe-to-case. Rewritten as a three-clause recursive
`traverse/2,3`: tail-recursive, no accumulator wrapping, reusable for
both `build_users` and `build_networks`. The user (vjt) caught the
pattern and asked for a CLAUDE.md rule: prefer recursive pattern match
over `reduce_while` for collect-or-bail traversal. Rule landed in the
same commit as the loader.

Five commits on main, all gates green, prod secrets in `.env`. The
shape of the codebase is starting to exist.

**Law:** plans don't survive contact with the type system. Every
spec-shaped function signature should be re-validated against the real
return types of the callees before being copy-pasted into code. The
plan is a hypothesis; Dialyzer is the experiment.

---

## S3 — 2026-04-25 — Phase 1 Task 2, and the question of how to keep things

The session started before the code did. vjt asked "before we commit
on sqlite — is it the right choice?" and the next forty minutes were
a design pressure-test: per-user `.db` files vs a single shared sqlite,
then "what about MySQL?", then "what's the cost of Ecto multi-DB
plumbing?". Per-user has real ergonomic wins for ops (delete user =
`rm` one file, export = file copy, encryption-at-rest per file) but
the plumbing cost is ~150 LOC infra one-time + every public context
fn forever gaining a `user_id` first arg + `with_user_repo` wrapper
+ a silent-bug class where forgetting `put_dynamic_repo` lands writes
in the wrong user's DB. The decisive argument wasn't performance
(write rate at scale is two orders of magnitude under sqlite WAL's
ceiling); it was **coherence** — CLAUDE.md says "the codebase IS the
instruction set, whatever patterns exist Claude will propagate." Half
the codebase with `user_id`-first args and half without = drift.
Single Repo = one pattern, zero drift surface. Locked in DESIGN_NOTES
with the full alternatives table and the flip-condition (multi-tenant
adversarial isolation) so future-vjt can find the rationale.

Then the worktree problem hit. Created a worktree at
`~/code/IRC/grappa-task2`, ran `scripts/check.sh`, and watched
docker compose build a parallel `grappa-task2` project from scratch
— new image, new named volumes, new dialyzer PLT (492 modules,
~5 minutes on the Pi). Killed it. vjt: "no way to rebuild an entire
compose for each worktree. gastone already solved this." Yes it did.
`/srv/gastone/scripts/_lib.sh` resolves SRC_ROOT from worktree PWD
and REPO_ROOT from `git rev-parse --git-common-dir`, then `cd
REPO_ROOT` so docker compose always uses the main project's name +
image + named volumes. Editable surfaces bind-mounted via `-v
SRC_ROOT/lib:/app/lib:ro` overrides on top of compose.yaml's `./:/app`.
Ported the pattern; first run-from-worktree dropped from 5+ minutes
to 11 seconds. The PLT cache, the deps cache, the build cache — all
shared across worktrees automatically because they live in named
volumes scoped to the (single) main compose project.

Then the plan caught a bug in itself. The Task 2 plan had `field :kind,
:string + validate_inclusion` for the message kind enum — pre-coding
review against CLAUDE.md's "atoms or @type literal — never untyped
strings for closed sets" caught it; rewrote to `Ecto.Enum, values:
[:privmsg, :notice, :action]`. Then *I* added a CHECK constraint to
the migration on the theory of "belt + suspenders, what could go wrong"
— and ran into `SQLite3 does not support ALTER TABLE ADD CONSTRAINT.`
The Ecto migration DSL doesn't expose inline column CHECK clauses for
the sqlite adapter. Worked around it by dropping the constraint
entirely: CLAUDE.md already forbids raw SQL DDL bypasses, so the
backstop was for a code path that's not allowed to exist. Updated the
plan in main to match shipped reality so the next person reading it
gets the right thing.

The code review caught more than I expected. A test named "rejects a
string kind (only atoms accepted)" whose body asserted the **opposite**
(Ecto.Enum casts strings to atoms — the test was right, the name was
lying). Schema gap for Phase 6: `msgid` from the IRCv3 `message-tags`
cap isn't in the messages table; the auto-increment `id` covers Phase
1 pagination but isn't the cross-system identifier the future
CHATHISTORY listener will need. Documented the deferral inline in the
schema moduledoc so the omission reads as intent. Missing FK from
`messages.network_id` to `networks.id` — looks like an oversight,
turned out to be intentional (scrollback is operator-archival, not
lifecycle-bound), annotated in the migration source. Plus a few nits
about redundant aliases and belt-and-suspenders test discovery filters.

Eight commits, all on origin/main, all gates green in 14 seconds on
the Pi. Three lessons stuck:

**Law (sub-1):** when the existing answer feels obvious, ask why.
sqlite was already locked in the spec; the per-user pressure-test
took thirty minutes and made the choice **better justified**, not
different. The flip-condition is named so future-vjt doesn't have to
re-derive it.

**Law (sub-2):** scaffolding pays interest. Five minutes vs eleven
seconds for `ci.check` from a worktree compounds across hundreds of
runs. The gastone pattern was already there — porting it was 60 lines
of bash + one CLAUDE.md update. The cost of NOT doing it would have
been "Claude will create one worktree, hate the build time, and stop
using worktrees." Tooling shapes behavior.

**Law (sub-3):** code review is the cheapest insurance. The
test-name-lying-about-its-body bug would have shipped without the
review, taught future readers that Ecto.Enum rejects strings (it
doesn't), and propagated as the canonical example of how to test
Ecto.Enum. Two minutes of review caught it; six months from now it
would have cost a session of head-scratching.

---
