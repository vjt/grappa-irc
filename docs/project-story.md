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

## S4 — 2026-04-25 — Phase 1 Task 3, the cycle that didn't fight back

The first session that completed the documented dev cycle —
worktree → failing tests → implementation → gate → review → fixes →
merge → push — without a single tooling detour. No worktree compose
duplication, no MIX_ENV-inheritance gotcha, no scaffold collision with
a Docker tag that doesn't exist. The bills S2 and S3 paid up front for
the gastone scaffolding pattern and the `cmd env MIX_ENV=test` workaround
came due in a good way: 13 seconds to a green gate from a worktree on
the Pi, every time, no thought required.

The session itself was almost boring. Wrote 8 failing tests for
`Scrollback.insert/1` + `fetch/4`, implemented the context module,
ci.check passed on the second try (one formatter blank line, one
Credo nit `_first` → `_`). The interesting part was what the tools
caught after — the kind of thing you only notice when the tools are
strict enough.

Code review (the superpowers:code-reviewer agent) flagged two should-fix:
a `defp sample(i, overrides \\ %{})` test helper that violated CLAUDE.md's
no-default-arguments rule, and a `@spec ... pos_integer()` that didn't
match a runtime `max(1, limit)` clamp accepting zero and negatives. The
spec/runtime mismatch is the more interesting one: silent clamping turns
a caller bug ("I passed limit=0") into "fetch returns 1 row when I asked
for none, which I didn't expect," which is the worst class of bug because
it works but not how you think. Tightened to `when is_integer(limit) and
limit > 0` — let it crash, per CLAUDE.md OTP rules. The spec stays honest
because the runtime now enforces it.

Then Dialyzer caught the new `max_page_size/0` helper returning literal
`500` while its `@spec` said `pos_integer()`. The `:underspecs` flag (set
deliberately in mix.exs) flagged it as wider-than-actual. CLAUDE.md says
"Dialyzer warnings are design signals" — the signal here was that a
constant-returning function shouldn't claim a wider type than it returns.
Fixed by tightening the spec to `unquote(@max_limit)`. The kind of
round-trip you want from strict tooling: the review noticed the helper
was useful, dialyzer noticed the helper's spec was sloppy, both fixed in
the same commit.

The unrelated catch this session was a CI bug: `mix docs` in
`.github/workflows/ci.yml` runs in `MIX_ENV=test` (job-level env), but
`ex_doc` is `only: [:dev]` in mix.exs. Would have failed on first push.
vjt spotted it by reading the workflow file, not by watching CI burn —
which is the right way to discover those bugs (the wrong way is the one
where the build is red for an hour while you debug from log fragments).

Single commit `cd829b4` for Task 3 itself: 88 LOC of context + 108 LOC
of tests, 19 total tests, 13s gate. Fast-forward merged to main, pushed.
Phase 1 is now four tasks deep with three more before the first HTTP
surface (Task 4 = Phoenix endpoint + /healthz).

**Law (sub-1):** the value of `:underspecs` is forcing helpers to be
honest about what they return. A `pos_integer()`-returning constant
function is a lie. Either narrow the spec or compute the value.

**Law (sub-2):** "let it crash" applies to spec contracts too. When the
@spec says `pos_integer()`, the runtime must enforce — guard clauses
over silent clamps. Silent clamping turns caller bugs into "works but
not how you think," which is the worst class of bug.

---

## S5 — 2026-04-25 — Phase 1 Task 4, the first HTTP surface

The first port opens. Bandit-backed `Phoenix.Endpoint` joins the
supervision tree last — after `Repo`, `PubSub`, `Registry`,
`SessionSupervisor` — so `/healthz` carries actual semantic weight:
the port answers only when the runtime state it would attest to is
alive. The other ordering would be a lie ("the port is up but the
sessions tree isn't, so any feature you'd hit through this port would
500"), and lying healthchecks are worse than absent ones.

Three deliberate departures from the plan, all small, all worth
noting because they show how plans erode under contact with reality:

The plan included `socket "/socket", GrappaWeb.UserSocket` in the
Endpoint. `UserSocket` doesn't exist until Task 6. Phoenix verifies
modules at `init/1` time, so booting with a non-existent socket
target would crash the supervision tree before /healthz could
answer. Removed it; documented the deferred mount in the moduledoc.

The plan included `use GrappaWeb, :verified_routes_off` in
`ConnCase`. The plan itself called this a hack. There is no such
macro — it would fail to compile. Phase 1 has no `~p"/..."` callers,
so plain `Phoenix.ConnTest` covers everything ConnCase needs. The
plan's instinct (defer verified routes) was right; its execution
(invent a macro that doesn't exist) was wrong. Removed; documented
that `Phoenix.VerifiedRoutes` re-enters when the first verified-route
helper appears.

The plan included `import GrappaWeb.ConnCase` in the using block, to
re-export future helpers. There are no helpers yet. YAGNI; re-add
when the first conn helper lands in Task 5.

These are the kind of tiny plan-to-reality deltas that compound if
you don't surface them. Each one was a 30-second decision; bundled
together in a checkpoint and a story episode, they make the next
session's "what did past-Claude actually do?" reading deterministic.
The plan is a forecast, not a contract.

The code review found five things in five minutes, all polish: a
`@spec` that lied about what its function accepts, a private helper
named `traverse/1` that would collide with the recursive-traversal
pattern CLAUDE.md prescribes for context layers, an Endpoint moduledoc
that wrong-named what `Plug.Parsers` parses (it parses bodies, not
cookies — cookies arrive via `Plug.Conn` core), a `signing_salt:
"rotate-me"` literal that needed an explicit Phase 5 callout, and a
test pattern-match that would accept `"text/plainfoo"` as
`"text/plain"`. None of these was load-bearing for Task 4 functioning;
all five would have rotted if they shipped.

The most interesting one is the `FallbackController` spec. The narrow
spec `:not_found | Ecto.Changeset.t()` doesn't match the moduledoc
claim that the controller "centralises {:error, term} → HTTP
response mapping." Reviewer flagged the dissonance and offered two
fixes: widen the spec, or add a catch-all clause. Per CLAUDE.md "let
it crash," adding a catch-all would hide context bugs at the
boundary — a misspelled error tag would silently 500 with a generic
message instead of crashing loudly. So the right fix was the third
option the reviewer didn't list: tighten the moduledoc instead.
Document that the controller maps the **known** shapes only and
unknowns surface as 500 via `FunctionClauseError`. The spec stays
narrow on purpose so the next person to add a context error tag has
to also touch the spec, which surfaces the new shape in code review.

The other deviation from the plan was operational: deploy is gated on
`grappa.toml` existing, but Bootstrap (the code path that actually
reads it) lands in Task 8. Copying `grappa.toml.example` to
`grappa.toml` would just satisfy a preflight without exercising
anything — and `grappa.toml` is operator state, not a thing Claude
should fill in autonomously. Asked vjt how to proceed; vjt chose to
defer the live deploy until Task 8 wires Bootstrap. The unit test
covers the request path end-to-end via `Phoenix.ConnTest`, which
dispatches through the full Endpoint plug pipeline against the real
router; the only thing the deferred deploy doesn't prove is that
Bandit binds the port and the Pi network stack works. Both fall out
of Task 8.

Two commits on this task: `99ce079` (the Endpoint + Router + healthz)
and `1c5a494` (the five review follow-ups). Fast-forward merged to
main. Phase 1 is now four tasks deep: parser, schema, context,
endpoint. The next three (messages controller, channels, bootstrap)
turn the bouncer into a thing that actually does something at a URL.

**Law (sub-1):** `/healthz` ordering is contract. The port should open
last in the supervision tree, after every component the probe would
semantically attest to. A healthz that answers before its dependencies
are up is worse than no healthz, because it actively misleads the load
balancer.

**Law (sub-2):** when a moduledoc and a `@spec` disagree about what a
function accepts, the moduledoc is usually the one telling the
ambitious lie. The spec is what dialyzer sees and what callers
ultimately depend on. Tighten the moduledoc to match the spec, not
the other way around — unless you're going to add the catch-all
clause that makes the moduledoc true. Pick one; don't ship the
mismatch.

## S6 — 2026-04-25 — the first read resource and a reviewer who was right for the wrong reason

Task 5 was supposed to be small: wire `Grappa.Scrollback.fetch/4`
through to a JSON endpoint. Three tests, one controller, one view,
one route. The plan was 120 lines and had inline serialization in
the controller body — a discrepancy with its own Files list, which
mentioned `messages_json.ex`. The first decision of the session was
which version of the plan to follow. CLAUDE.md says directions over
code, but it also says when a plan conflicts with documented patterns
(here: Phoenix 1.8 `formats: [:json]` is wired precisely so views
handle rendering), fix the plan. The Files list was the right intent;
the body was sloppy. View module won.

Code review surfaced two things — one was a bug, one was a wrong
diagnosis with a right consequence.

The bug: `?limit=banana` silently fell back to the default. Plan
permitted any int, my impl tightened to "positive int only" via
guard, but kept the fallback shape. Reviewer flagged it as a CLAUDE.md
violation ("validate at boundary, reject unknown values"), and they
were right. Worse, the plan had its own bug — `?limit=0` would parse
to `0`, which is truthy in Elixir, which would be passed to
`Scrollback.fetch/4`, which would crash on the `when limit > 0`
guard, which would 500 the request. So the plan was forgiving for
typos AND brittle for caller bugs — worst of both. Correct shape:
distinguish absent (use default) from present-and-unparseable
(return 400). Helpers became three-way:
`{:ok, n} | {:ok, default} | {:error, :bad_request}`. Controller
uses `with`. `FallbackController` got a third clause.

This is the second time a code review caught a *plan* bug rather
than a *code* bug. Last session it was the FallbackController spec
narrowing the moduledoc's claim about "all `{:error, _}` shapes."
This session it was the input-parsing fall-through. The pattern:
plans inherit bugs at the time of their writing, and the only way
to surface them is to compare the implementation against CLAUDE.md
during review, not against the plan. CLAUDE.md is the higher
authority. The plan is one implementation strategy, not a contract.

The wrong diagnosis: reviewer flagged Jason's atom encoding as a
"MUST FIX," claiming `:privmsg` would crash because "Jason does NOT
encode bare atoms by default." That assertion was false. Jason DOES
encode atoms as strings by default — `:foo` becomes `"foo"`.
Verified at REPL before changing any code:
`Jason.encode!(%{kind: :foo}) == ~s|{"kind":"foo"}|`. The actual
evidence was already in the test output: tests passed, which means
the JSON pipeline already round-tripped the atom successfully.

But the *related* point was right. The tests didn't actually assert
the `kind` field in the response body — they only checked `body`.
So the contract was implicit, propped up by the moduledoc and
nothing else. If a future change broke the encoding (or if Jason's
default ever changed), the tests would still pass and the broken
contract would ship. Added the assertion. Now the contract is
load-bearing in CI, not in prose.

Two lessons that didn't quite fit on either side: when working with
a reviewer (human or agent), verify the mechanism before changing
code. The reviewer can be wrong about why something needs fixing
and right about whether something needs fixing. The fix often isn't
what they suggested, but the gap is real. And: tests that don't
assert the field can't catch a regression in the field. "It returns
200" isn't a contract; it's a status code.

Cross-channel isolation — the test that says "fetch for `(azzurra,
#sniffo)` doesn't return rows from `(azzurra, #other)` or
`(freenode, #sniffo)`" — was added on the same pass. Reviewer
flagged it as a SHOULD CONSIDER. It's the canonical "if the
implementation were wrong, would the test catch it?" gap from the
CLAUDE.md testing standards. If `Scrollback.fetch/4` ever drops its
`WHERE` clause, this is the test that should fail first.

Two commits: `6ac4456` (the implementation as planned) and
`01c0a92` (the five review follow-ups). 28 tests on main, ci.check
still ~17s on the Pi. CP01 was rotated to CP02 at the start of this
session — 392 lines was 2× the warn threshold, and reading it cost
context every `/start`. CP02 opened with a frozen-state snapshot at
`09f65a3` and S6 is now its first session.

**Law (sub-1):** when a code reviewer flags a MUST FIX based on
assumed behavior, verify the mechanism before changing code. The
reviewer can be wrong about the cause and right about the gap. The
fix is rarely what they suggested, but the work is still there.

**Law (sub-2):** plans inherit bugs at the time of their writing.
CLAUDE.md is the authority, not the plan. When the implementation
needs to deviate from the plan to satisfy CLAUDE.md, that's the plan
losing — not Claude going off-script. Document the deviation in the
checkpoint with the *why*; do not silently re-implement to match
the plan.
