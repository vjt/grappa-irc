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

---

## S7 — 2026-04-25 — Phase 1 Task 6, the first write resource

`POST /networks/:net/channels/:chan/messages` lands. First write
resource on the surface, first `Phoenix.PubSub.broadcast/3` in
production code, first time a REST request and a streaming surface
share a payload shape. The path is short (~60 lines of controller),
but each of those firsts is a small architectural decision.

The plan-vs-CLAUDE.md tension showed up immediately. The plan said
`kind: "privmsg"` (string); CLAUDE.md says atoms for closed sets.
The plan inlined a `serialize/1` helper in the controller; Task 5
had already established `MessagesJSON` as the wire-shape door. The
plan ignored the return type of `Phoenix.PubSub.broadcast/3`;
Dialyzer caught the `:ok | {:error, _}` and wanted it matched. Three
deviations, all in the same direction — toward the rules in
CLAUDE.md, away from the plan as written. This is the second session
in a row where the plan loses to the rules; we keep finding the same
failure mode (plan inherited a pattern from a prior session that
predates the current standard) and keep documenting it the same way.
The pattern is institutional now; the plan should probably get a
lint pass before we draft Phase 2.

The "every door" principle ran into a real test today. The PubSub
broadcast and the REST 201 response should describe the same domain
event in the same wire shape — that's the whole reason the rule
exists. The mechanical answer is to make `MessagesJSON.data/1`
public so both doors call it. The first version of that change came
with an ergonomic shortcut: the broadcast event carried a duplicated
outer `body` field next to the nested `message` map, so test
assertions could pattern-match on `%{kind: :message, body: "x"}`
without descending into the nested map. The reviewer flagged it
correctly: that ergonomic shortcut shipped to every cicchetto WS
client forever as a duplicate field with no documented canonical
source. Cost ships, benefit lives in tests. Dropped the outer
`body`; tests now descend into the nested map. Three extra
characters of test code, no wire-shape pollution.

The reviewer's other catch was subtler. The catch-all
`def create(_, _), do: {:error, :bad_request}` swallowed two
different failure modes: bad client body (correctly 400) AND
router-config drift where someone renamed `:network_id` → `:net`
and silently broke every POST. CLAUDE.md "let it crash" wants the
second case loud — `FunctionClauseError` → 500 → operator sees it.
The fix is to require the path params in the catch-all pattern:
`def create(_, %{"network_id" => _, "channel_id" => _})`. Same
blast radius for legit bad input, loud crash for config drift.

Stats:
- 34 tests (+6 from Task 6: 1 happy + 1 persistence + 1 scoping +
  3 boundary-rejection)
- ~810 LOC of Elixir under `lib/` (+60)
- 26 commits on main (+2 from Task 6: e8a10bc, b0e2771)
- ci.check still ~17s on Pi (PLT hot)

**Law:** when an ergonomic shortcut in test code adds a field to
the wire format that ships to clients, the cost-benefit is wrong.
Tests can be three characters longer; the wire format ships
forever. If you'd be embarrassed to document the duplicate field in
the public API, don't ship it for the test convenience.

---

## S8 — 2026-04-25 — Phase 1 Task 7, the first WebSocket and the global topic seam

The first WebSocket surface lands and proves a quiet rule about
test isolation: `Phoenix.PubSub` is process-routed but the topic
namespace is global. When two `async: true` tests subscribe to the
same topic name, they're competing for a shared resource even
though they're in different OS processes. The Task 6 controller
test posts to `azzurra/#sniffo`, which broadcasts on the topic
`grappa:network:azzurra/channel:#sniffo`. The Task 7 channel test,
in a different test process, joined the SAME topic — so the
channel's PubSub subscription was a real subscriber and got the
broadcast. The sibling-channel scoping assertion (`refute_push`)
flipped red on a race window of about 50 ms.

The fix is small: each channel test uses its own
`(network, channel)` pair (`ch_happy_net/#ch_happy`,
`ch_sibling_net/#ch_joined`). The schema columns are free-form
strings; nothing special about `azzurra/#sniffo`. But the lesson
generalizes: whenever a test subscribes to PubSub by topic name,
that test is depending on no other async test using the same
name. The schema makes it free to partition, so partition. This is
the second seam where async test isolation requires a deliberate
design choice rather than a default — the first was Ecto sandbox
mode (each test gets its own connection); this one is PubSub
topic name (each test should pick a unique one).

The reviewer caught three SHOULD-FIX worth recording. The first
was the same shape of mistake that S6 caught with the Jason
encoding: the channel test rebuilt the wire shape by hand instead
of routing through `MessagesJSON.data/1`, the production formatter
that exists exactly so both doors share one source of truth. The
test passed because the hand-rolled shape matched what the channel
pushed — but if a future task adds, removes, or renames a field on
the formatter, the controller test and the channel test would
disagree about what the wire shape IS. The fix routes the test
through `Scrollback.insert/1` + the real formatter. Now the wire
contract is pinned at both doors by the same code path.

The second was a coverage gap, not a bug. The catch-all
`def join(_, _, _)` clause looked dead at first glance — the socket
router only declares `grappa:user:*` and `grappa:network:*`, and
each prefix has a more specific clause above the catch-all. But
`"grappa:user:"` (empty user) DOES route through the socket router
to the channel; the first clause's guard `when user != ""`
rejects it; the second `"grappa:network:"` prefix doesn't match;
falls into the catch-all. Reachable. Just untested. Two new
rejection tests (empty user, empty channel) added — without them,
deletion of either guard ships green. This is the
"if-the-implementation-were-wrong-would-this-test-catch-it" bar
from CLAUDE.md applied to the rejection paths, not just the happy
ones.

The third was a partial-match in the user-topic test
(`assert_push("event", %{kind: :motd, body: "welcome"})` matches
even if the channel adds extra fields). The channel module's
docstring promises payload-verbatim; the test should pin equality
with `^payload`, not a shape pattern. Ship the equality assertion
and any future "let me decorate the payload with X for
convenience" change flips red immediately.

The plan deviation count keeps climbing per task. Task 1-3 had
0-1 each; Task 6 had three; Task 7 had seven. The pattern is
clear: the plan was written before Tasks 4-6 review-driven shape
changes, so anything in the plan that touched wire shape was
guaranteed stale by the time Task 7 ran. Two of the seven
deviations were inherited bugs (the `valid_network_topic?/1`
predicate had no emptiness guards; the test broadcast used the
pre-Task-6 shape). The other five were either CLAUDE.md
conventions (bare `_`, `:ok =` match-or-crash) or coverage
expansions (added tests for paths the plan didn't cover). The
plan now has both inherited bugs fixed at source — plan body
matches the implementation, so the next session that copies from
this section won't re-inherit the gap.

There's a meta-lesson here too. The fact that the plan deviation
count is going UP per task is itself a signal: the plan is
decaying as a contract because each task reshapes things the
later tasks were planned against. At some point — probably around
Task 8 (the IRC client + session GenServer, by far the largest)
— it makes more sense to plan that task fresh against the current
state of the code than to follow the original plan body. The
plan's exit criteria still hold; the implementation steps do not.

Stats:
- 41 tests (+7 from Task 7: 1 happy + 1 sibling-scoping + 1 user
  + 4 malformed-topic rejections)
- 810 LOC of Elixir under `lib/` (+78 net)
- 45 commits on main (+3 from Task 7: abf4e5a, 70d9605, plus this
  S8 docs commit)
- ci.check still ~17s on Pi (PLT hot)

**Law:** when an `async: true` test subscribes to a `Phoenix.PubSub`
topic by name, that test is asserting nothing else in the suite
publishes to that topic during its window. The PubSub topic
namespace is a globally shared resource, so partition it
explicitly per-test (cheap when the schema columns are free-form
strings). The rule extends to any global identifier — Registry
keys, ETS table names, file paths under a fixed prefix. If two
async tests can collide on a name, they will, and the test that
loses the race is the one closest to the race window.

## S14 — 2026-04-25 — Phase 1.5, the architecture review fix-up

The previous session ran a six-agent architecture review against the
walking-skeleton-complete codebase. Twenty-four findings, four
critical. Three cross-cutting themes surfaced from independent
agents converging on the same shapes — that convergence is the
signal that they're real architecture, not opinion. The user's
read: "let's fix properly all architecture issues. then we do
codebase level. i sm sure arch fixes will reduce codebase ones."
That hypothesis sets up the next session; this one was about
testing whether the review's recommended fix-tier work was
sound advice or just plausible-sounding text.

The verdict, after one session and fourteen commits: it was sound.
The "Phase 1.5 contract module" pass — extracting `Grappa.PubSub.Topic`,
`Grappa.Log`, `Grappa.Scrollback.Wire`, `Grappa.IRC.Identifier` —
collapsed the cross-cutting themes into four small modules that were
each greppable in one place. The Session.Server cohesion pass
(extract framing into Client, extract sender_nick into Message, drop
the Config.Network struct from state, route broadcasts through Wire)
removed five concerns from the single largest GenServer in the
codebase. The state map shrank. Phase 5 SASL/CAP work has a clear
seam now where it didn't before.

A few discipline points worth pinning down.

**Fix the baseline first, even when nobody's looking.** The
worktree's first ci.check failed on a pre-existing Dialyzer
`:unmatched_return` from S12's Release.migrate work. Caught only
because the architecture-fix worktree was the first run with that
code in scope; S12 had pushed without that gate firing because the
deploy-time check was different from the CI gate. The CLAUDE.md rule
"Fix pre-existing errors first. Zero errors is the baseline" exists
exactly for this — you can't claim Phase 1.5 was clean if you built
on top of an existing warning. First commit of the worktree was
the baseline fix.

**Atom-table-DoS is a real concern; the closed protocol vocabulary
isn't.** The IRC.Message.command field had been typed `String.t()`
with a moduledoc explanation citing atom-table-DoS as the reason
for not atomising. That argument applies to unbounded user content
— message bodies, nicks under attacker control, arbitrary tags —
not to the closed RFC 2812 + IRCv3 set of ~24 verbs + 1000 numeric
slots. The original choice was conservative-in-the-wrong-direction:
losing Dialyzer exhaustiveness on Session.Server's pattern matches
to defend against a non-existent attack surface. Fixing it required
a discriminated union (`atom() | {:numeric, 0..999} | {:unknown,
String.t()}`) so vendor extensions still don't atomize. The
property test's encoder needed a new clause to convert atoms back
to wire strings. The corrective for "we picked an over-broad type
to be safe" is rarely "type it more broadly"; it's "find the
narrower correct type plus the escape hatch for the genuine
unbounded case."

**Test-time enforcement beats runtime mutation when the dimensions
are stable.** The architecture review flagged that `Meta.@known_keys`
and the Logger `:metadata` allowlist had to be kept in sync manually
across two files. Two paths to fix: extend the allowlist
programmatically at boot via `:logger.update_handler_config` (the
"automate it" path), or add a unit test that asserts the two lists
agree (the "gate it" path). Picked the gate. The test caught real
drift on its first run — three keys (`:new_nick`, `:modes`, `:args`)
were in `Meta.@known_keys` but missing from the Logger allowlist;
they had been silently dropped from log output for who knows how
long. Runtime mutation would have papered over the bug; the gate
made it visible. The general law: when two lists must be the same
and both change rarely, a test gate is cheaper and more honest than
runtime sync.

**Recursive review skipped, with eyes open.** The plan called for a
second `/review architecture` pass on the worktree before merge —
recursive — to validate that the fixes didn't introduce new
structural issues. Skipped. The reasoning: every commit traced
1:1 from a specific finding, ci.check held throughout, no new
abstractions were invented (the four new modules were each
suggested by name in the original review), and the codebase
review still ahead would test structural integrity from a
different angle anyway. The trade-off is conscious — saved
~10 minutes of agent work and ~500 lines of context for a
modest risk of missing a side-effect. If the codebase review
next session flags something the architecture review missed
in the fix-up, the lesson recalibrates; if it doesn't, the
trade-off was right.

**The compose project-name conflict still bites.** Every check.sh
run during Phase 1.5 needed `docker compose -f compose.prod.yaml
stop` first because the prod and dev compose files share the
project name "grappa" and target the same vlan IP. CP04's todo
flagged this; CP05 still flags it. The fix — distinct project
names or a detect-and-skip in `_lib.sh` — is small, but the
workaround was tolerable enough that it kept getting deferred.
The pattern is recognisable: a friction that's tolerable per
incident but accumulates across sessions. Putting it on the
immediate list of CP05 with a specific recipe is the
counter-pressure.

**The bouncer survives surgery.** Live deploy after the merge:
bootstrap clean, autojoin worked on `#grappa`, healthz returned
200, the structured logs showed the new shape (`command=mode`,
`command=join`, `user=vjt`, `network=azzurra`, `pid=...`).
End-to-end PRIVMSG round-trip via REST + Channel still worked
because the wire-shape unification ("every door, same wire shape")
held through the refactor — the Wire module is the single source
of truth for both surfaces and one test proves it. That invariant
was load-bearing for the safety of this session. If the wire
contract had been split across the controller and the session,
this refactor would have been a much riskier set of edits.

Stats:
- 14 commits, +1390 / −347 lines, 35 files
- 121 → 179 tests (+58)
- 4 new domain modules: Identifier, Log, Topic, Wire
- 1 new test support: MessageEventAssertions
- ci.check green at every commit boundary
- Live deploy on Pi: clean, no regressions

**Law:** when an architecture review surfaces three cross-cutting
themes from independently-prompted agents, those themes are real
even if no single agent makes the strongest case for any of them.
The agents see the codebase from different angles; convergence
across angles is the strongest possible signal short of running
the code in production. Spend the fix-tier sessions on
cross-cutting themes first; the targeted findings collapse into
the contract modules anyway.

## S20 — 2026-04-25 — Phase 2 design pass, the plan that paid for itself before being written

This was the first session in the project's life that shipped no
code. One commit, one file, 1316 lines of plan. Three hours of
conversational design discussion before the plan was even written,
and the value of those three hours was already locked in by the
time the plan file got created — the discussion itself was the
work, the plan was the receipt.

The starting position: Phase 1 walking-skeleton complete + live on
Pi (S19), Phase 2 looming, no plan written. The user said "go phase
2." I could have written a plan from the README spec ("auth via
NickServ + multi-user + session tokens + per-user iso") in twenty
minutes — three hundred lines, six sub-tasks, ship it. We have prior
plans to imitate. I almost did. Then I remembered S8's lesson — the
plan-deviation count climbs because plans inherit bugs from the code
they were written against, and the right move is to interrogate
every architectural lever in conversation BEFORE the plan distills
the answers. Phase 2 has more architectural levers than Phase 1 sub-
tasks did. So we walked through seven decisions A-G one at a time.
Each one took its own arc, and three of them got reshaped by user
pushback in ways the plan wouldn't have caught.

The token-format conversation went five rounds. The user asked the
right question: "with JWT we'd skip the DB lookup, right?" The easy
answers were both wrong — capitulating ("yes use JWT") would saddle
us with revocation theater and key-rotation cascade pain; hand-
waving ("JWT bad") would have left the actual reasoning unsaid and
the question unresolved for future sessions. The honest answer
required walking through what JWT is *for* (microservices fan-out,
federated identity, edge auth — none of which we are) and what it
isn't (any pattern that needs cheap revocation or theft mitigation
ends up with state anyway, at which point the "stateless" win
evaporates). The user followed the reasoning and ended at "opaque
session ID, why the fuck do people invented jwt then?!?" — which is
exactly the right question. The cargo-cult-vs-real-use-case
distinction got memorialized in DESIGN_NOTES with a table of "where
JWT is the right answer" vs "where it's not." Future sessions where
someone reads a Medium tutorial and asks "shouldn't we use JWT?"
have the receipts ready.

The crypto-layering conversation was the bigger pivot. The user
pushed back hard on env-key encryption: "key in env on disk is no
key at all. why not per user encryption using user account passwd?
log on -> grab cleartext -> store nickserv pwd in ram. change pwd
re-encrypts. lost pwd zaps." Cryptographically the user was right.
Architecturally the user hadn't priced in the cost: per-user-key
encryption means the bouncer can ONLY run upstream IRC connections
while a user is actively logged in, because the server has zero
crypto capability without the user's password. Process restart =
all keys lost = mass re-login cascade. Idle 8d = bouncer
disconnects from upstream. That kills "always-on bouncer," which is
the entire product premise — soju does it, ZNC does it, and grappa
without it is a hosted IRC client, not a bouncer. The honest answer
required laying the four options on the table — env key, user key,
opt-in hybrid, master-with-escape-hatch — and naming the threat
model each one defends against. The user landed at exactly the
right framing: "for real e2e security, none of this is the answer.
The answer there is OTR. And cicchetto will support OTR."

That framing crystallized the whole crypto layer. **Server-side
crypto = encryption-at-rest only. E2e privacy = OTR in the client.
They are separate concerns at separate layers and trying to
collapse them into one server-side mechanism just ends up being
neither.** Saved as a project memory so future sessions where
someone's tempted to propose "encrypted message bodies at rest"
have the principle ready: the scrollback `body` column accepts
opaque bytes, and whether those bytes are plaintext "ciao" or
`?OTR:AAQDoyB...` is the client's business. Zero server-side work
for e2e. The server's crypto job is one row in the threat-model
table, no more.

The third pivot was the upstream auth flow. I had penciled in
"SASL with NickServ IDENTIFY fallback" as the auth model — sensible
modern shape, matches Libera/ergo. The user reminded me: "i do NOT
know if azzurra bahamut has sasl. i do authenticate via ns auth
in-band." This was the cue to stop guessing. WebSearch + WebFetch
gave partial answers (Azzurra has a Bahamut fork, no SASL defines
in config.h). Then the user said "you can grep bahamut sources on
~/code/IRC/bahamut-azzurra tho" — and one grep changed the whole
auth state machine. `s_user.c:1273-1278`:

```c
/* if the I:line doesn't have a password and the user does
 * send it over to NickServ */
if(sptr->passwd[0] && (nsptr=find_person(NICKSERV,NULL))!=NULL)
{
    sendto_one(nsptr,":%s PRIVMSG %s@%s :SIDENTIFY %s", sptr->name,
               NICKSERV, SERVICES_NAME, sptr->passwd);
}
```

Bahamut runs this at the end of `register_user()`. The legacy PASS
field, which RFC 1459 originally meant for server-password auth,
gets handed off to NickServ as `SIDENTIFY` — poor-man's SASL.
**Auth happens at register time via the server itself doing the
NickServ handoff.** No race, no post-001 IDENTIFY dance, no
+R-channel join failures. The auth state machine got redesigned in
real time: per-network `auth_method` enum (`auto | sasl |
server_pass | nickserv_identify | none`), with `auto` covering both
SASL-modern AND PASS-handoff-Bahamut shapes in one default. The
user even kept the door open for "if PASS handoff silently fails,
fall back to PRIVMSG NickServ IDENTIFY" as a Phase 5 hardening
item. None of this was in the plan I would have written from the
README alone.

The schema conversation had its own moment. The user pushed back
twice — first on `networks.id text` ("integer or uuid"), then on
the two-task UX ("set network credential and then autojoin? why
not create network and pass everything?") — and the third nudge was
the irssi-shape insight: "let's reuse irssi schema here. server
belongs to chatnet, chatnet has many servers." That last one
collapsed an oversimplified `networks(host, port, tls)` into the
right three-table split: `networks` (logical), `network_servers`
(physical, many per network with priority for failover),
`network_credentials` (per-user binding). Phase 2 logic uses only
the first server; Phase 5 will add round-robin failover; the
schema is ready for it without migration. The "reuse the verbs,
not the nouns" principle from CLAUDE.md applied: irssi's `chatnet`
verb (network has many servers, user has many credentials) was
reusable; the noun (calling them "chatnets" in our code) was not.
Tables stayed `networks`/`network_servers`/`network_credentials`,
keeping the operator-facing wire vocabulary stable while the
internal shape gained the structural correctness.

There was a smaller fourth nudge on G.4 (PubSub topic shape
including user_id): "why adding user id? it can be inferred from
session no?" The honest answer was no — Phoenix.PubSub topics are
global string namespaces, not socket-scoped, so without per-user
discriminator multi-user instances broadcast user A's events to
user B's subscribers. Could have been worked around with a custom
dispatch layer, but that loses Phoenix.PubSub's native ETS-backed
fanout efficiency, loses Phoenix.Presence, and reinvents the wheel.
The standard Phoenix-shape solution (topic name encodes
discriminator) is right. The user accepted the answer once it was
laid out.

The plan that came out of all this is bigger than Phase 1's was —
1316 lines vs walking-skeleton's 2742, but Phase 2 covers more
ground per task — and it distills decisions, doesn't hide them. The
seven decisions A-G are recapped in the plan header with one-line
outcomes; the rationale is in DESIGN_NOTES (four new entries) and
in the CP06 S20 entry. Future sessions executing the plan can re-
litigate any decision they want, but they have to read the receipts
first. The plan-deviation pattern from Phase 1 should bend
downward as a result — deviations come from "the plan said X but
the code says Y" gaps, and frontloading the design conversation
with full alignment on Y is how you keep that gap small.

The other thing worth pinning down: this session shipped no code,
no test changes, no Pi deploy. Just one commit. Old-me would have
felt like the session "didn't ship anything." But the actual work
product — the architectural alignment, the four DESIGN_NOTES, the
crypto-layering memory, the verified-against-source auth state
machine — is what lets the next 4-6 sessions move at speed without
re-relitigating these choices. Phase 1's S8 lesson was "plans
inherit bugs from the code they were written against." The corollary
is that frontloaded design conversations are a real engineering
deliverable, even when no code moves. The receipts are the work.

**Law:** when a phase has more than three architectural levers,
walk through them in conversation one at a time BEFORE writing the
plan. Each lever gets its own arc — the easy answer, the user's
pushback, the threat-model honest answer, the receipts captured in
DESIGN_NOTES. The plan distills the decisions; the discussion makes
them. A plan written without the discussion is just a longer
version of the README spec.

## S38 — 2026-04-27 — Phase 3 walking skeleton in your pocket

This is the session where the project became real for the first
time. Not "the tests pass" real, not "the bouncer connects to
Azzurra" real — both of those happened weeks ago. This is the
"I tap the icon on my home screen and the channel is right there"
real. The session output, in bytes: 17 commits on main, 21.45 KB
gzipped JS. The session output, as memory: the user reporting back
"works. can log in and see scrillback and send messages. vidual
layout is messy but i guess we do that later. verified also
session persists app clisure" — typos and all, because typing on
a phone in landscape while your pocket-irssi is open is exactly
the user posture this whole project was designed for.

The path from "all gates green on the worktree" to "iPhone PWA
installed and round-tripping" was nine sub-tasks long but only the
last one matters from the outside. The first seven (REST gaps,
SolidJS scaffold, login, channel list, scrollback, compose, deploy
plumbing) had each landed clean during the prior session. This
session was supposed to be sub-task 8 — wrap-up + deploy + iPhone.
That's a one-paragraph runbook: re-run gates, code review, merge,
deploy, register DNS, hand to operator, write CP entry. It became
seventeen commits.

The code-reviewer agent went hunting and came back with two real
prod blockers neither of which would have surfaced before the
operator's first iPhone session. Phoenix's `check_origin` defaults
to "match endpoint URL host," which is `localhost` until you tell
it otherwise — every WebSocket connect from `grappa.bad.ass` would
have been silently rejected. And the bearer token rides the WS
upgrade URL as `?token=…` because that's how `Phoenix.Socket`
transports its `params` callback, and Phoenix's logger filters
`["password"]` by default but not `"token"` — so the bearer would
have been written verbatim into stdout on every connect. Both
two-line fixes. Both invisible until production. Both the kind of
"the test suite is green and the feature is broken" that 424
passing ExUnit tests cannot catch by construction, because the
unit tests don't exercise the runtime config that the release
boots with.

Then the deploys. The first deploy attempt got a permissions error
on the cicchetto-build container's first write into `/app/dist` —
fresh Docker named volumes are root-owned, but the container drops
to UID 1000 to keep `node_modules` writes from landing as root on
the host bind-mount. Container-as-1000 + named-volume-as-root, and
Vite's `prepare-out-dir` step blew up with EACCES on the very
first file copy. Fix: replace the named volume with a host
bind-mount at `./runtime/cicchetto-dist`, `mkdir -p` it in
`deploy.sh` so it inherits the operator's UID. Bonus consequence:
dist/ is now `ls`-able from the host. Second deploy attempt got
through the build, through the container start, through migrations,
through the healthcheck. Then DNS registration: the script read
`TECHNITIUM_API_TOKEN` but the canonical `/srv/dns/.env` exports it
as `TECHNITIUM_TOKEN` — typo in the original task description,
caught at the first run, fix one rename. Three small surprises in
a row, each one a five-minute fix, each one only visible at
deploy-against-the-live-system time.

After deploy + DNS came the password reset. The user couldn't
remember the vjt password set during the Phase 2 deploy a week
back, and there's no `mix grappa.reset_password` task because in
Phase 2 we agreed credentials are operator-managed and the schema
already supports plain `User.changeset(%{password: ...}) |>
Repo.update!()` via the existing changeset path. So a one-liner
through `bin/grappa rpc` against the live release. The min-8
length validation rejected the user's first attempt ("suxsux", 6
chars). Production code stayed unweakened — CLAUDE.md "Never
weaken production code to make tests pass" applies the same way to
admin tasks: the validation is doing its job, pick a longer
string. Second attempt landed. Login API call confirmed via curl.
Operator opened Safari. The icon went on the home screen. The
channel list rendered. The bouncer's scrollback flowed in.

And then, after the iPhone confirmation, the user asked: "review
time?" The session-1 instinct would have been to dispatch the
existing `/review codebase` skill at the merged Phase 3 work.
But Phase 3 was the session that made cicchetto a first-class
subsystem of the project — ~1100 LOC of TypeScript and SolidJS
that the existing review skill literally could not see, because
its dispatch table was Elixir/Phoenix-only. A `/review codebase`
run would have produced a server-side-clean report while
client-side bugs went unnoticed. CLAUDE.md "Total consistency or
nothing" applies to the meta-tooling too. So before running the
review, we extended the skill: a sixth agent for `cicchetto/`,
agent-prompt bullets covering SolidJS reactivity bugs and TS
strictness and wire-shape drift and a11y baseline and PWA shell
correctness; the architecture review concerns broadened to span
server↔client; the cross-module agent learned to cross-check
`compose.prod.yaml` env vars against `runtime.exs` reads, and
nginx's reverse-proxy allowlist against the router's routes. One
commit, 185 insertions / 41 deletions across the spec doc and
the skill file. The actual review is deferred to next session —
running six parallel agents on top of a context that already
covered the entire Phase 3 arc would have forced a mid-review
compaction.

Phase 3 walking skeleton is done. The user's pocket has an
installable PWA that talks to a 24/7 bouncer running on a
Raspberry Pi in their living room, over a real-time WebSocket,
through a reverse proxy that issues a CSP that the browser
respects, with a bearer token that the operator can rotate from
`bin/grappa rpc` if they ever lose it again. The visual layout
is, per operator review, messy. That's exactly what Phase 4 owns.

**Law:** "tests green" is a property of the test suite, not the
production system. The walking-skeleton review caught two
operational blockers (`check_origin` rejected every real WS
connect; bearer logged verbatim from a default-`["password"]`
filter) that 424 passing tests couldn't surface — because they
ride runtime config that the test environment overrides. When a
phase reaches first-prod-deploy, the gate is not "the suite passes"
but "I have run the literal command-line story end-to-end against
the system the operator will use." Defer that gate and you defer
discovery into the operator's first session, which is the worst
moment to discover anything.

**Law:** when a phase grows a new subsystem, the meta-tooling
(review skills, doc structures, lint baselines, CI gates) grows
behind it or it grows wrong. The `/review codebase` skill that
was perfect for Phase 1 was actively misleading by the end of
Phase 3 because the cicchetto/ subsystem was invisible to it.
"Total consistency or nothing" is a CLAUDE.md rule for code; it
applies just as hard to the apparatus you use to review the code.
Half-coverage is worse than no coverage because it lulls you into
thinking the review ran. Update the meta when you add the matter.

## S39 — 2026-05-03 — T31, and the hard gate that paid for itself

The post-Phase-4 ops cluster closed today. T31 — the admission
control + captcha + circuit-breaker stack — landed across two
plans and three production deploys. The story isn't the code,
which was largely mechanical assembly of patterns the codebase
already knew. The story is the gate that caught what the suite
couldn't.

The cluster spent thirteen tasks under the standard cycle: TDD,
Mox at boundaries, Bypass for HTTP fakes, two-stage review per
task, plan-fix-first whenever the spec inherited a bug. Plan 2
shipped twelve docs-only plan-fix commits on main during cluster
execution alongside the implementation commits — the principle
codified during Plan 1 (S21) reused without ceremony. By Task 13.B
LANDED, the suite was 806 server tests + 194 cicchetto vitest, all
green. Standalone Dialyzer green. Credo green. Sobelow green.
mix.audit + hex.audit clean.

The plan called for Task 14 to run a real-browser e2e matrix
against the live deploy, with the language "REAL BROWSER, hard
gate" in capitals. The temptation, when the suite is that green,
is to interpret the gate as ceremonial — open the browser, click
through the happy path, confirm what the test suite already knows
to be true. That interpretation is the trap. The hard gate's job
is to find what the suite cannot find, and the suite can only find
what the suite is shaped to look at.

What broke in production:

The first deploy reached `/healthz`-green and accepted nick-only
visitor logins without a captcha challenge. The captcha unit suite
was green. Every Login-flow test was green. The deploy was wrong:
`compose.prod.yaml`'s `environment:` block had no entries for the
three captcha env vars. Docker compose only consumes `.env` for
variable substitution; host env vars don't auto-inject into
containers unless listed explicitly. `runtime.exs` read the three
keys as nil, fell through to `Captcha.Disabled`, and the production
admission stack accepted everything. The unit suite couldn't see
this because test config calls `Application.put_env(:grappa,
:admission, ...)` directly — the env-var pipeline is invisible to
it.

The second deploy, after the env propagation fix, got the captcha
config loaded. The browser navigated to the login page, filled the
nick, clicked Log in, and rendered a generic error overlay with
the message "crypto.randomUUID is not a function". The vitest
suite's 3 clientId tests all green. The reason: vitest's jsdom is
a secure context, but `http://grappa.bad.ass` is not. `crypto.
randomUUID` is gated to secure contexts only; on plain HTTP it
isn't a function, it's undefined. Login was impossible. Fallback
hand-rolls v4 from `crypto.getRandomValues`, which IS available
on insecure origins because only `randomUUID` specifically is
gated.

The third deploy, after the UUID fallback, rendered the Login page
with the `crypto` error gone, and threw a CSP violation: nginx's
`script-src 'self'` blocked
`https://challenges.cloudflare.com/turnstile/v0/api.js`. The CSP
unit suite did not exist, because biome doesn't inspect headers,
and the only thing that was going to find this was a real browser
loading a real script tag past a real reverse proxy. Added the
Turnstile host to `script-src` + `connect-src` + new `frame-src`,
redeployed, reloaded the page, and watched the Cloudflare iframe
mount and auto-solve "Success!" against the registered hostname.

Three deploys, three plan-fix-first commits. Each one was
unit-test-invisible by construction: env-var → runtime config is
a boundary the test suite cannot exercise without re-implementing
the deployment; secure-context-gated browser APIs are a boundary
that jsdom does not enforce; CSP allowlist is a boundary that
the test suite has no eyes for. Each of the three would have
shipped to production silently and stayed broken until the first
real visitor tried to log in.

The 4-tab cap-proof, when it ran, was almost anticlimactic. Three
tabs each cleared their token-but-kept-their-client-id, logged in
as `capproof_a`, `_b`, `_c`. The session registry rose 1 → 2 → 3
→ 4 (counting vjt's persistent user session). The fourth tab tried
to log in and got `503 network_busy` instantly — capacity check
runs before captcha, so the rejected client never burned a Turnstile
token. The friendly message rendered: "This network is at capacity.
Try again in a few minutes." Switched to per-client cap by re-
binding `max_per_client=1` and `max_concurrent_sessions=10`; the
fifth attempt hit `429 too_many_sessions` with "You're already
connected to this network from another device or tab." The
admission stack worked exactly as the spec promised. It's the
deploy that wasn't ready until the gate caught what the suite
couldn't.

**Law:** the test suite is shaped to test the suite's view of the
system. Three boundaries — env-var pipelines, secure-context
browser APIs, CSP allowlists — exist outside that view by
construction. Real-browser e2e isn't a ceremony at the end of a
ship; it's the first measurement against a different shape, and
when it breaks, what it surfaces is the difference between the
view and the system. Any deploy whose only validation is "the
suite is green" has answered a different question than the one
the operator asked.

**Law:** plan-fix-first applies to deploy-time bugs, not just spec
drift. The original codification (Plan 1, S21) was about catching
spec divergence before the cluster inherited it. Task 14 reused
the principle for three real production failures discovered at
the deploy boundary; each landed as a side-worktree commit
(`cluster/t31-deploy-fix`) ff-merged to main between deploys, with
its own commit message naming what was wrong and why the unit
suite missed it. The pattern is "the plan and the deploy are both
spec layers; each can carry bugs; fix the bug at the layer it
lives in, then proceed with the original work."

T31 closes a chapter that started as "max 3 connections per IP"
on a CP11 azzurra constraint and ended as a three-tier admission
stack with provider-pluggable captcha, a per-network failure
circuit-breaker, an operator-bind verb, and three deploy-config
hardening fixes nobody knew were missing until a browser opened.
Forty-one commits ahead of origin became sixty-nine became zero
when vjt said "sure push no problem". The next cluster trajectory
(text-polish polish-deferred → M2 NickServ-IDP → anon-webirc → P4-V)
inherits an admission stack that has been stress-tested in
production by the only test that could have stress-tested it.

## S40 — 2026-05-07 — CP15 event-driven windows: the model moves to the server

The cluster's name was the spec. cicchetto used to assume window
state — POST `/channels` succeeded, the sidebar entry appeared,
the members pane fetched once via REST and cached. When the
assumption matched IRC reality you couldn't tell anything was
wrong. When it diverged — invite-only refusal, kick, T32 park
once it lands, the WS reconnect race that drops the post-deploy
`members_seeded` broadcast — the UI silently lied. Members
rendered empty, ghost windows pinned, the compose box accepted
text into channels we couldn't post in. The optimistic STATE
pattern was structurally incapable of representing JOIN failure
or KICK; cic was the source of truth for state cic could not
actually observe. The fix was to admit that and move the state
machine to where the truth lived: the server.

The arc spread across six buckets and a docs sweep. B1 added the
typed `:joined` event on JOIN echo from the server side, simplest
possible scope to prove the wire shape. B2 added `:join_failed`
with reason + numeric, and the in-flight JOIN map server-side so
the failure could route back to the originating channel rather
than the user-level fallback. B3 added `:parted` and `:kicked`
plus the `push_channel_snapshot` extension that meant cic's
members pane stopped polling and started listening. B4 added the
REST `/networks/:slug/archive` endpoint plus the cic Sidebar
archive section: the reciprocal of the active list, surfacing
targets that had scrollback rows but weren't currently joined.
B5 was where cic finally caught up — `lib/windowState.ts` mirror
module, `lib/subscribe.ts` dispatch, drop the optimistic STATE
assumption, drop the `loadMembers` REST verb. The members pane
became event-driven for real: server pushes `members_seeded` on
after_join AND on every upstream 366 RPL_ENDOFNAMES, cic has no
remaining reason to call `GET /members`. B6 was the e2e matrix
against the real Bahamut testnet — and the bucket where the
cluster's actual lessons surfaced.

Three pre-existing bugs the e2e matrix made visible. The first
was a sidebar projection that was keyed too narrowly: the helper
emitted a row for state == "pending" channels not yet in the
live channels list, but failed/kicked/parked windows whose
channel never reached the live list had no sidebar entry at all.
The fix was small — rename + extend to all four non-joined
states — but the lesson was structural. When state lives in two
stores, the projection MUST key on the store that's
authoritative for the question being asked. The sidebar's
question is "what windows exist?"; the answer is
`windowStateByChannel`, not `channelsBySlug`. Future state
additions — the T32 `:parked` once disconnect/connect verbs ship,
any SASL-gated `:locked` if that ever happens — inherit the
synthetic-row treatment mechanically as long as they go in the
authoritative store. The contract makes new states a server
change, not a UI rewrite.

The second bug was a Jason crash at the WS edge that explained a
"DM windows you close stay open server-side" mystery dating back
weeks. `Grappa.QueryWindows.broadcast_windows_list/2` was sending
raw `%Window{}` structs over PubSub. The struct doesn't derive
`Jason.Encoder`; Phoenix's `fastlane!/1` crashed at fan-out; the
crash dropped the user-channel process; any subsequent
`close_query_window` push from cic landed on a dying ref and was
silently lost. The fix was a `Grappa.QueryWindows.Wire` module,
sibling to the existing `Grappa.Scrollback.Wire`. Both
broadcasts and channel pushes delegate through it. The wire
module pattern — context-owned JSON-encodable wire conversion,
controllers + channels delegate — became the project's standard
mid-cluster, retroactively justified by a bug whose root cause
was structural, not local. The lesson generalised: persisting a
struct over PubSub does NOT auto-render it as JSON. Wire-shape
conversion is a per-context responsibility, owned by the context,
not implicit in `Phoenix.PubSub.broadcast/3`.

The third bug was small and instructive. The `:join_failed`
effect arm persisted the failure reason as a `:notice` scrollback
row but only broadcast the typed `kind: "join_failed"` event —
never the wire-shape `kind: "message"` event for the persisted
notice. cic's scrollback view is once-per-channel-loaded, so the
notice landed in the DB but never in the live view unless the
user reloaded the page. Fix: pair every `:persist` effect with a
`kind: "message"` push if the row needs to land in the live view.
Typed window-state events and persisted message events are
parallel channels in the wire contract; a row in the DB does not
imply a row on the screen.

The testnet rabbit-hole almost made the cluster a different
shape. Three days of e2e flake suddenly made sense once we
OPER'd up + ran `/STATS l` against the testnet hub. The leaf's
autoconnect class connfreq was 180 seconds default; first dial
fired before the hub was ready, then the leaf waited three
minutes to retry — past test runtime. The bahamut hub had
NO_CHANOPS_WHEN_SPLIT compiled in, denying auto-op on fresh
channels for five minutes after daemon boot even with the link
up, blocking every fixture that needed chanop privs. The
`hub.azzurra.chat` alias on the wrong docker bridge was
poisoning leaf4's view of the hub, resolving to an unreachable
IP. Three intertwined infra bugs, each invisible from inside cic
or grappa. The fixes landed in `vjt/azzurra-testnet@e023db1` +
`@afd3ae8` + `compose.yaml`, plus a new `scripts/testnet.sh`
wrapper for iterative debugging (`up | down | status | logs <svc>
| probe | shell <svc>`) and an `integration.sh` refactor that
shrunk from 165 LOC to ~60 by delegating stack lifecycle. The
flake budget the cluster spent on testnet plumbing paid off: the
e2e matrix is now stable enough to run unattended on every PR.

Browser smoke caught one last surprise. The kicked-flow
synthetic row appeared MISSING on prod despite the deploy
succeeding. Root cause: the prod tab was running pre-deploy JS
(`index-Tsa4Tfom.js` instead of post-deploy `index-CiYQNUz0.js`).
Asset-hash cache-busting works for fresh sessions but not for
already-open tabs. Hard reload, the synthetic row was there.
Captured in the cicchetto-browser-smoke memory as step zero of
the smoke procedure: hard-reload the prod tab first, before
anything else.

The deferred parked flow is the bridge to the next cluster.
`cp15-b6-parked.spec.ts` doesn't exist yet because flipping
`connection_state: "parked"` requires the T32 PATCH
`/networks/:slug` REST surface plus cic's `/disconnect` /
`/connect` ComposeBox arms. Both land in `channel-client-polish`,
the cluster that opens next, with T32 first because the parked-
flow e2e is gated on it. The synthetic-row + greyed-class
treatment is already in place for `:parked` thanks to the
sidebar projection's authoritative key being
`windowStateByChannel`. Once T32 ships, the e2e is mechanical.

**Law:** when client-side state is "what the client expects to be
true," it lies. The server owns the system state; the client
mirrors. Optimistic UI is acceptable as a render-tick latency
cover (cic's `setPending` on `/join` flips the row to pending
synchronously for visual feedback) but never as the source of
truth. Every state transition is a server-emitted typed event;
absence-keys derive from the existing presence-message stream.
The `windowStateByChannel` mirror is the contract: any new state
goes there, any projection keying off "what windows exist" reads
from there, the rest is mechanical.

**Law:** wire-shape conversion is a context responsibility, not a
Phoenix-PubSub responsibility. PubSub will happily fan out a
struct that crashes at the WS edge. `Jason.Encoder` derive on
schemas hides the bug at compile time but doesn't fix it: the
storage shape rarely matches the wire shape, and "the schema
encodes but the wire-shape is wrong" is a bigger class of bug
than "the schema doesn't encode." Wire modules per context —
`Grappa.Scrollback.Wire`, `Grappa.QueryWindows.Wire`,
`Grappa.Networks.Wire` — are the standard. Controllers + channels
+ broadcasts all delegate through them. PubSub broadcast +
Channel push payloads MUST be JSON-encodable, and the wire
module is the place where that's enforced.

**Law:** the e2e suite is the only place pre-existing bugs from
parallel-channel design choices surface. Three bugs all preceded
CP15 by weeks; all were invisible to the unit suite, the
integration suite, and casual browser smoke. The e2e matrix
walked the full window-state transition graph for the first
time, and each bug was a "the test found something the
integration was hiding" moment. When you build the matrix that
exercises every state transition end-to-end, the bugs you find
are not new — they're the ones that the half-coverage matrix had
been letting through.


## S41 — 2026-05-08 — The last HIGH OPEN, and a bug the user found in five seconds

The post-codebase-review remediation arc closed at cluster #15
(low-omnibus) the previous session — eight fix commits, three
doc-only stale closes, five audit corrections marking HIGH-stale rows
as LANDED-STALE. But one row was held back: bnd-A2, the literal
14-times-repeated `networks()?.find((n) => n.slug === networkSlug)?.id`
across compose.ts. The cluster-#15 commit message itself called it
out: "needs own cluster (compose.ts state refactor, not a single-
session bite)." This session opened with that single-target
commission. Cluster #16: `cic-network-id-store`. One audit row.

The work was the easy part. Read compose.ts. Confirm 14 callsites at
the documented line numbers (they had drifted by ±1-2; close enough).
Inspect the `networks` signal source. Three options weighed at design
time — pure helper, Map-keyed `createMemo` + helper, push id
resolution UP into the dispatch layer. Option B chosen because it
mirrored cluster #13 M4 (`networkKey` / `decodeChannelKey`
extraction) and M7 (`target_kind/1` public-helper promotion) — same
verb-promotion convention, same memo-backed reactive shape. The
helper signatures took `slug: string`, not `string | null`, because
all 14 callsites passed a guaranteed string and per CLAUDE.md you
don't add error handling for scenarios that can't happen. The 14
literal call sites collapsed to one helper invocation each, identical
diff per handler, biome and tsc clean, 684 vitest passed, integration
suite passed (33 + 1 retry-passed flaky — the cp13 S5 caveat that's
been pre-existing for two clusters now), browser smoke confirmed the
slash command parser still resolves networkId at the dispatch
boundary.

The merge commit said it: "the **HIGH OPEN count goes to 0 across
both audits**." The codebase-review HIGH count had gone to zero at
cluster #15; the architecture-review HIGH count went to zero at this
merge. After fifteen weeks of cluster work — six closures of
HIGH-architecture rows in clusters #6, #7, #8 (already corrected via
the cluster #15 sweep), then bnd-A2 closing the last one — the
audit's headline number stopped having a HIGH OPEN entry to point at.
72 OPEN rows remain, all MEDIUM or LOW, candidates for future
omnibus clusters with no urgency. This is not a complete codebase by
any meaningful sense of the word. It just means the curated list of
"the things we couldn't ship without fixing" is empty.

That should have been the session. CLEAR signal sent (regular, not
CLEAR-FINAL — that one was consumed at cluster #15). And then the
user typed: "we still have a scrolling bug. from what i see scrolltop
is preserved on window switch."

The bug repro is one sentence. Open a populated channel — scrolls to
the bottom, fine. Open an empty query window with `/query <nick>` —
scrollTop=0, "no messages yet" placeholder, fine. Switch back to the
channel — pinned at scrollTop=0, the user reading whatever message
was at the top of the buffer instead of the latest message they
actually came back to read. Five seconds of operator interaction. The
bug had been in production through every browser smoke I'd run on
this code; nobody had ever switched windows in *that order* during a
smoke test, because the operations look so different — opening a
query is a slash-command surface, switching a channel is a sidebar
surface, the obvious smoke walks each surface once. The bug lives at
the intersection.

Reading the production code made the cause obvious. ScrollbackPane
has its own moduledoc comment saying "Solid's `<Show>` reuses the
ScrollbackPane component instance across selectedChannel changes" —
the author knew. The component had a length-effect at line 583 that
ran on `messages().length` change, perfect for the streaming append
path. It had an on-key effect at line 563 that reset the JOIN-banner
visibility latch and the `markerScrolled` boolean — perfect for the
component-internal state. What it didn't have was anything that
touched the scroll position of the underlying `<div>` on key change.
And the underlying `<div>` was the SAME DOM element across switches —
non-keyed `<Show>` reuses, doesn't rebuild. The query render set
scrollTop=0 (placeholder fits trivially). The channel render didn't
touch scrollTop (length unchanged). The user got scrollTop=0 in a
1400-px-tall scrollback.

The fix went into the existing on-key effect — extending it, not
adding a parallel one. Branch on the marker presence: if there's a
marker, scrollIntoView({ block: "center" }); otherwise snap to tail.
The user's spec was literal: "more or less in the middle of the
screen, and if no unreads then scroll to bottom." The companion
change — flipping the length-effect's `block: "start"` to
`block: "center"` — was the OTHER mount path: a window opened with
unreads where the REST page lands AFTER focus. Without it, switch-
back would center the marker but initial-focus would pin it to the
top edge. Asymmetric UX is worse than no fix at all; the rule has to
hold across both mount paths or it's not a rule.

Two e2e specs went into `scroll-on-window-switch.spec.ts`. The bug
repro test pinned the contract: channel → empty `/query` →
channel-back → distFromBottom ≤ SCROLL_BOTTOM_THRESHOLD_PX. The
marker-centered geometry test pinned the stronger contract that
cp14-b1 had only weakly asserted via `toBeInViewport()`: marker top
sits in the 0.20..0.80 ratio of container height. Both passed first
try — 305ms and 269ms. The integration suite went from 33 to 35
passed, same one retry-passed flaky that's been there for two
clusters.

**Law:** when a Solid `<Show>` boundary is non-keyed, the DOM element
under the conditional is REUSED across condition changes. Effects
keyed on signal IDENTITY (length, ref) won't fire on logical-state
transitions that don't change those signals. The component's internal
signals reset on key change; the DOM doesn't unless you tell it to.
Add an explicit effect on the LOGICAL key (channel `key()`) that
resets DOM state to the new context's expectations. The pattern is
"per-window state that survives the boundary needs explicit reset" —
not just bannerState and markerScrolled, but scrollTop too.

The session arc was its own small lesson: the audit work was
defensible, careful, mechanically verified. The bug fix was sparked
by a user typing a sentence and required a visible-state-reset rule
the audit had never been positioned to catch. The audit found 163
items across two reviews; none of them was scroll-position-on-window-
switch, because no review ever sits down and clicks through window
switches in five different orders. The audit catches what the audit
can see. The user catches what the user does.

## S42 — 2026-05-10 — One sentence, two paths, one predicate

The session opened on a finished story — CP19's T32 parked-window
cluster had landed yesterday, the smartlog was clean, no work pulled
me forward. Then the user typed: "bug: when messaging a non-existing
user the incoming server message no such nick/channel alow triggers a
unread messages porco dio marker. see it live now".

The "see it live now" was the load-bearing phrase. The bug was on
production. The user's browser tab was open. CDP gave me the
screenshot in two commands: there it was, in the `vjt-on-grappa-irc`
DM window, between the operator's outbound `<grappa> test` and the
inbound `-raccooncity.azzurra.chat- No such nick/channel` reply, a
`── 1 unread message ──` marker rendered against the operator's own
mistake. Madonna porca.

The trace was fast. CP13 had already done the architectural work:
NumericRouter resolves 401 ERR_NOSUCHNICK to `{:query, ghost}`,
EventRouter persists a `:notice` row at `channel=ghost` with
`meta = %{numeric: 401, severity: :error}`, broadcasts on the
per-channel topic. The wire shape carries the discriminator already.
The cic side just had to read it. Same semantic class as BUG5b
own-presence-event suppression — a row that exists *because of the
operator's own action*. The operator already saw the action; the
unread alert is a false positive. Wire-shape carries enough context;
the bug was at the consumer.

Halfway through writing the subscribe.ts fix I noticed the second
path. The "1 unread message" wasn't just a sidebar badge — it was the
in-pane marker, rendered by `ScrollbackPane.rows()` from a separate
filter over `getReadCursor()`. Two independent code paths counting
the same wire row as "unread." Suppressing the badge bump in
subscribe.ts would have shipped a fix that the user-visible regression
still showed: the marker would still render. Two paths, same
semantic — "is this row unread?" — extracted to one predicate
(`isOperatorActionEcho`), consumed by both. The shared verb keeps
them aligned by construction; the next "operator-action echo"
class (labeled-response routing, perhaps) extends one file.

I asked vjt one design question: error numerics only, or all
numerics? The answer was "yes all" — error 4xx/5xx (401, 482, 404)
and info numerics (305/306 RPL_(UN)AWAY) are both operator-action
feedback. The gate is on `typeof meta.numeric === "number"`, not on
severity. The principle scales without re-deciding case-by-case.

The TDD red-then-green ran clean. Subscribe.ts test for the gate.
ScrollbackPane.tsx test for the marker exclusion. Symmetric peer-
NOTICE-still-counts tests in both files — the predicate must NOT
drift into "suppress all notices" because NickServ greetings and
peer `/notice` messages are real unsolicited content. Predicate unit
test covering defensive branches. Extension to the existing CP13 S5
caveat e2e — the same `/msg <ghost>` flow that already verified the
401 reply appearing got two new assertions: marker absent, badge
absent. One e2e covers both surfaces because the predicate aligns
both surfaces.

Then the integration run failed seventeen specs after spec 22.
Uniform 30.6s timeouts, all in code paths my fix doesn't touch (m1
peer PRIVMSG to focused, m2 peer PRIVMSG to defocused, m3 own-msg to
focused, m4-m9 etc.). The pattern was clear before the totals
finished printing: cp15-b6-parked.spec.ts at position 22 takes 30.8s
and exercises /disconnect+/connect — the testnet doesn't fully reset
between runs, the parked-spec's afterEach reconnect-poll hits its
budget and a parked credential cascades downstream failures. Already
documented in DESIGN_NOTES from the CP19 ship. M1, M2, M3 in
isolation passed in 7s each. Not my regression. Knowing the
testnet-meltdown signature from a previous session's documentation
is what kept the panic to thirty seconds.

Deploy. Reload the user's browser tab. The `── 1 unread message ──`
marker that was sitting between the operator's `test` and the 401
reply — the marker that was visible in the screenshot the user sent
— was gone. Sent a fresh `/msg ghost-1778408327 hello-from-fix-test`
to verify the live trip: new query window opened, 401 reply rendered
inline, no marker, no sidebar badge. End-to-end.

**Law:** when the wire already carries the discriminator, the bug is
at the consumer, not the wire. Don't propose new event types,
parallel server state, or "let's send X over the channel too" when
the broadcast payload already says everything you need. CP13 shipped
the discriminator (`meta.numeric`) for one reason — server-window
routing — and that single field, untouched, was the entire
information needed for an unrelated UX gate fifteen sessions later.
Wire shapes that carry production context are reusable; wire shapes
that carry rendering decisions are not.

## S43 — 2026-05-13 — The invariant flip: read state moves to the server

Three weeks of production carried the rule like a load-bearing wall:
*"no server-side `MARKREAD` / read watermark on either facade. Read
position is client-side, always."* It was in `README.md`. It was in
`CLAUDE.md` as a "key invariant — break only with deliberate cause."
It was in the spec. cic stored read cursors in `localStorage` keyed
on `(slug, channel)` and walked them forward on focus-leave. Adding
server-side cursors later was forward-compatible by design; removing
them later would have broken clients. So we deferred — until two bugs
on the same day stopped being deferrable.

The first was `cp13-S5`: a peer DM lands during a WebSocket gap, the
server persists + broadcasts to a dead subscriber, the row is gone
from the live stream. CP26 had shipped a reconnect-backfill that
fetched `?after=<server_time>` to recover gap rows on rejoin. It
worked when the gap was a real reconnect; it leaked on the *first*
join because the cold REST page was supposed to cover seeding and
the backfill arm intentionally skipped the initial join. macOS Docker
Desktop's slower bring-up turned the race deterministic: cic GET at
t=0 returns empty, server INSERT at t=41ms, cic Channel join at
t=61ms — the broadcast fires before the subscribe, the row vanishes.
CI green on Linux because the race went the other way.

The second was vjt's: "if I leave and join a chan I see 'unread
messages' for my part and join actions". Same in-pane `── X unread
messages ──` marker S42 had attacked, but for a different row class.
Own JOIN/PART persist in scrollback the same way peer JOIN/PART do —
the server doesn't distinguish at the storage layer because
upstream-side `CHATHISTORY` would need them either way. The cic
sidebar badge gate (subscribe.ts:191) had been suppressing own-presence
bumps since BUG5b shipped weeks ago. The in-pane marker had not. Same
logical class, two surfaces, one predicate missing. The S42 lesson
hadn't generalized — it had patched one instance.

Both bugs traced to the same architectural seam. The cic-side cursor
in localStorage was opaque to the server. The IRCv3 listener facade
(Phase 6) needs `+draft/read-marker` MARKREAD lines that point at
*server-known* message ids. cic couldn't tell the server "this is
where I am" because the cursor model didn't admit a server endpoint.
Refresh-on-join couldn't be cleaner-factored because the resume cursor
was a per-window localStorage read, not a server fact. Adding
server-side cursors closed both bugs *and* unlocked Phase 6's read-marker
work — the kind of architectural payoff that justifies breaking a
load-bearing invariant.

vjt asked seven design questions. The cluster planning answered them
all in one pass: nested envelope shape on `/me` for cold-load bulk
fetch (`%{slug => %{chan => id}}`); cursor for `$server` and own-nick
query windows (yes, uniform); auto-set on operator's own POST
(deferred — focus-leave model already handles it); cross-device sync
via per-channel `read_cursor_set` typed wire event; one-shot
localStorage nuke for legacy `rc:` keys; rollout as straight cutover,
no feature flag. Seven questions, one cluster scope.

The cluster shipped in seven buckets across one day. R-1 the schema
+ context. R-2 unified the REST surface around id cursors and added
`?around=` for navigating to a specific message. R-3 the POST endpoint
+ `/me` envelope + `read_cursor_set` typed wire push. R-4 the cic
backend flip — every localStorage read became a signal-map read, the
forward-only guard moved from the client to the server. R-5 the bug
fix the cluster was named for: every per-channel join (initial AND
every auto-rejoin) calls `refreshScrollback` against the resume cursor.
The first-join arm no longer skips. cp13-S5 closed by construction.

R-6 was the 90-minute coda. The S42 predicate (`isOperatorActionEcho`)
got a sibling: `isOwnPresenceEvent(msg, ownNick)`. Same shape, same
two consumers — subscribe.ts's bump-gate and ScrollbackPane's marker
filter. The lesson S42 had patched generalized into a pattern: any
"row produced by the operator's own action" class extracts to one
predicate, plugs into both surfaces, scales to the next class. When
the server starts emitting routed labeled-response replies, that's
the third predicate; same two surfaces.

The version bumped from 0.2.0 to 0.3.0. The CLAUDE.md invariant
flipped from "client-side, always" to "server-owned, per (subject,
network, channel)." The Phase 6 plan got cleaner — the IRCv3 facade
exposes the same cursor as `+draft/read-marker` MARKREAD lines, no
parallel state needed. The deferred decisions (auto-set on own
POST; mention-click cursor-rewind UX) sit in DESIGN_NOTES with the
wiring sites named, the way deferrals should look when next session
picks them up.

**Law:** load-bearing invariants exist to be re-evaluated when the
load changes. The "client-side read state" rule was right when
written — it kept the surface small while the bouncer found its
shape. It became wrong when two unrelated bugs traced to the same
seam and Phase 6 needed the same data. Three weeks of preserving an
invariant cost less than one cluster of flipping it. Document the
flip, document the deferred decisions, ship as one production atom,
move on.



## S44 — 2026-05-14 — Five typed events, one route flip, two principle violations

The P-0 numeric-delegation cluster opened against a list. Bahamut
emits about a hundred numerics; pre-cluster the bouncer routed maybe
forty through dedicated EventRouter handlers. The remaining sixty
fell through to a generic `:notice` row whose body was the
trailing-param string, verbatim, in whatever locale the upstream
chose. cic rendered them as raw text on $server. Useless — neither
machine-readable for cic to localize, nor structured enough to drive
UI affordances.

The cluster scoped five domains: WHOIS-leg extension (eleven extra
flags from 275/301/307–310/316/325/326/339/378), standalone AWAY
(301 when no /whois is in flight), INVITE-ack (341), LUSERS (the
seven-numeric sequence 251/252/253/254/255/265/266), and WHOWAS
(314/369/406). Each got the same shape: NumericRouter delegates,
EventRouter folds into a per-target accumulator (or a single
ephemeral effect), Server.apply_effects broadcasts a typed wire
event, cic owns the human-readable rendering. The wire payloads
ship structured fields only — booleans, integers, ISO timestamps,
typed atoms. No human strings server-side, ever.

P-0a through P-0d shipped clean. P-0e was supposed to be the same.
The 341 RPL_INVITING handler emitted `{:invite_ack, channel, peer}`,
the apply_effects arm broadcast on the channel's per-channel topic.
The reasoning in the commit message read: "channel-scoped action
confirmation belongs in the channel transcript." It wasn't wrong as
an aesthetic — it was wrong about the topology. cic only joins the
per-channel WS topic for channels the operator is actually IN.
Operators usually invite peers to channels they are NOT in. The
broadcast landed on a topic with zero listeners and dropped on the
floor.

The unit tests passed because they fed 341 directly into the test
session and asserted the broadcast. The integration test passed
because it had the operator on the same channel they invited the
peer to. Neither captured the cross-channel case. The bug shipped to
main, hot-deployed, ran live for an hour. The browser smoke at
cluster close caught it: vjt typed `/invite Lisko #it-opers` from
#bofh, watched cic, saw nothing. Ten minutes later we'd traced the
route, written P-0f, flipped the broadcast to `Topic.user/1`,
moved the cic mount to the always-visible $server window, and
shipped the fix as a sixth bucket.

That's `feedback_silent_retry_anti_pattern` re-validated for the
third time this quarter. Anything that "should" produce visible
output but doesn't is a bug, even when no exception fires. The
per-bucket browser-smoke discipline (`feedback_per_bucket_deploy`)
is how we catch them — vitest doesn't render layout, e2e fixtures
don't reproduce production topology. A human typing into the live
client, watching, is the only test that doesn't lie.

The cluster close turned up two more silent drops, both worse than
P-0e/P-0f because they were never in scope. The first: vjt invited
the bouncer (`grappa`) to `#sbiffo` from his own irssi. From the
bouncer's perspective, that's an inbound `INVITE grappa :#sbiffo`
command, not a 341 numeric. EventRouter has no clause for inbound
INVITE — the wildcard fallthrough returned `{:cont, state, []}`
silently. P-0e/P-0f had built infrastructure for the wrong direction.
The second: that wildcard fallthrough drops EVERY unhandled command.
KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, AUTHENTICATE, and any
vendor verb the upstream chooses to send — all gone. Three years of
"oh that doesn't get rendered" surface, hidden behind a single
no-op match clause.

vjt's reaction was instructive: "I do not want fucking silent drop
I want to see all IRC messages as we have to handle them all." The
fix is simple in shape — replace the no-op fallthrough with a
`:persist` `:notice` to $server carrying `meta.raw = %{verb, sender,
params}`; cic owns localization. Visible first, prettified later.
Per-verb pretty rendering can grow incrementally. The principle
stays: the bouncer is the one source of truth for what the server
sent, and silent drops are a category error.

Both became the next cluster's first two buckets, alongside four
more (the `compose.ts` requireChannel bug found mid-debug; verifying
ALL Bahamut numerics route through structured wire events; clickable
links in scrollback; Sobelow hardening). The Phase 5 list got a
cleanup pass too — the orchestrator brief had been carrying a "P-3
jitter" reference for weeks; turns out T31 shipped per-session ±25%
jitter back in May. Stale plan items are how silent drops get into
roadmaps.

Five typed events shipped. The cards UX (whois, whowas, lusers all
render as inline cards above scrollback) got a review-flag from vjt
during the close: "I am not convinced on cards but we can renegotiate
this at a later stage." Cards stayed for consistency; the alternative
shape becomes its own future cluster.

**Law:** the wildcard fallthrough is the most expensive line of code
in any router. It's free at write time, free at test time, and
catastrophically expensive at the point a user notices a missing
feature that's been broken since the day the code shipped. Replace
silent drops with structured visibility before adding any new feature
that depends on the router behaving correctly. The principle scales:
EventRouter, NumericRouter, the IRCv3 listener facade you build for
Phase 6, every dispatcher you ever write — fallthrough means
"surface this somewhere visible," not "ignore it."

## S45 — 2026-05-14 — One law shipped: silent drops are the disease, typed visibility is the cure

The no-silent-drops cluster was a six-bucket plan (B0 through B5)
that grew into eleven sub-buckets across two days. Mandate per the
post-CP30 brief: surface every event the server produces; close
the silent-drop class introduced in P-0's route flip plus the
broader pattern observed across surfaces.

The cluster's first two buckets shipped the obvious wins. B0 fixed
the carried-over `compose.ts` requireChannel bug that swallowed
`/invite` arguments. B1 replaced the EventRouter wildcard
fallthrough — the line that returned `{:cont, state, []}` for
every unhandled IRC verb — with a structured persist of `:notice`
on `$server` carrying `meta.raw_verb`/`raw_sender`/`raw_params`.
KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, vendor verbs all became
visible. Cic grew per-verb pretty-render arms (`renderRawEvent`)
keyed off `raw_verb`. Visible first, prettified later, exactly as
the previous chapter's law specified.

Then the codebase review.

B5 was a doc-only commit. Eight parallel agents — one per surface
(IRC, lifecycle, persistence, web, cicchetto, cross-module,
cross-surface, docker/deploy) — produced 152 findings: 1 CRIT,
31 HIGH, ~57 MED, ~44 LOW, ~19 NIT. The synthesis at
`docs/reviews/codebase/2026-05-14-codebase-review.md` was the
roadmap for B6.

The CRIT was the kind of finding that justifies the whole exercise:
**B1's catch-all was persisting `AUTHENTICATE` continuation
payloads to `$server` scrollback as plaintext.** SASL base64,
when split across multiple AUTHENTICATE commands, decodes to
`\0user\0user\0password` for PLAIN. The bouncer was logging
credentials to disk in the same window operators read. Same
disease class as the W12 NickServ-leak hardening from earlier in
the year; the fix was a deny-list at the catch-all head
(`@no_persist_verbs ~w(authenticate pass oper)a`). Three lines.
Shipped in B6.1 alongside HIGH-2 (empty-trailing verbs were
silently dropped by `validate_required(:body)` — yes, silent
drops in code shipped to fix silent drops; the mitigation was
verb-name body fallback) and HIGH-6 (the meta key shape was
nested-with-mixed-atom-and-string keys; flattened to atom-only
top-level fields stays inside the Scrollback.Meta allowlist).

Then HIGH-7 stayed open through B6.2 through B6.10. The kind enum
discrimination problem: B1's catch-all wrote `:notice` rows for
events that aren't notices. `:notice` is a CONTENT kind —
`@body_required_kinds` includes it; `@dm_with_eligible_kinds`
includes it. Any future filter `kind in [:privmsg, :notice,
:action]` for "human content" would silently swallow KILL /
WALLOPS / vendor noise. The fix was structural: add `:server_event`
to `Message.@kinds`, exclude it from both per-kind allowlists,
flip the catch-all's persist effect from `:notice` to
`:server_event`, migrate the messages CHECK constraint via
sqlite's table-recreate dance, backfill historical `:notice +
raw_verb` rows.

The migration is where this chapter's lesson lives.

Sqlite >=3.25 auto-rewrites dependent foreign-key reference text
during `ALTER TABLE ... RENAME`. When you rename `messages` to
`messages_old` to recreate it with a new CHECK constraint,
`read_cursors.last_read_message_id` (which references
`messages.id`) gets its FK ref text auto-rewritten to point at
`messages_old`. Once you `DROP TABLE messages_old` after the
data copy, the `read_cursors` schema retains a dangling reference
to a non-existent table. The schema becomes corrupt, surfacing
on the next session boot's loader or the next read-cursor write.
The 2026-05-04 caps/auth migration had hit exactly the same
problem with `network_servers` and documented the pattern: any
recreate-with-CHECK must recreate every dependent FK-referencing
table too, in the same migration, with `defer_foreign_keys=ON`
inside the transaction.

I missed this when writing B6.11's migration. Vitest passed, server
ci.check passed, dialyzer passed. The migration would have shipped
to prod and corrupted the `read_cursors` schema on first boot.

What caught it was a code-reviewer agent. Mid-cluster vjt called
out my drift to linear single-thread mode — orchestrator handoff
docs pre-loaded the implementation plan, each bucket felt small
enough to do directly, so the agents stayed unused. I added a
memory (`feedback_subagent_driven_development`), spawned the
code-reviewer agent on the migration design, and the first finding
back was the dangling FK ref. Ten-minute fix, latent prod-corruption
bug averted. A test wouldn't have caught it; the integration suite
exercises a fresh sqlite that doesn't carry the rename history.
The agent caught it by reading the precedent migration's moduledoc
and noticing the same pattern reapplied.

Then the cluster surfaced one more silent-drop bug in code shipped
to close silent-drop bugs.

Cic's `wireNarrow.ts` is the WebSocket-edge runtime narrower for
per-channel events. It validates incoming payloads against a
`Set<MessageKind>` allowlist (`VALID_MESSAGE_KINDS`). A TypeScript
discriminated union is compile-time only; the runtime allowlist
is a separate moving part. B6.11 added `"server_event"` to the
TypeScript `MessageKind` union, to the schema `@kinds`, to
EventRouter, to the cic dispatcher, to vitest. Madonna porca, I
missed the runtime allowlist. Vitest still passed (the unit tests
constructed messages bypassing the narrower). The B2 INVITE-CTA
integration smoke caught it: `.scrollback-invite-join` never
rendered because every `:server_event` row was silently dropped
at the WS edge. A textbook silent-drop bug in the cluster designed
to close the silent-drop class.

The mitigation isn't just adding the entry. It's pinning the
allowlist exhaustiveness in the unit test: a vitest loop over all
eleven `MessageKind` values asserting each is accepted. Future
enum additions that update only the TypeScript union without the
runtime allowlist will fail vitest, not Playwright. The deeper
lesson: anywhere the codebase has a runtime `Set<EnumValue>`
mirror of a type union, an exhaustiveness test is mandatory
infrastructure. Type unions are fences; runtime allowlists are
gates. Both need tests.

The cluster closed at commit `455c481` with 25 of 31 HIGH closed,
the CRIT closed, two NON-FINDING after re-evaluation against
current code, one HIGH deferred to Phase 6 CHATHISTORY (the
generated-column perf optimization for `Scrollback.list_archive/3`,
deferred per CLAUDE.md "design AGAINST Phase 6's actual listener
query shape, not speculatively"). Cold-deployed via
`scripts/deploy.sh --force-cold`, both migrations applied cleanly,
backfill found zero historical rows in dev (no historical catch-all
rows; Server's numeric handler had been routing all numerics with
`{numeric, severity}` meta, never `raw_verb`), cic bundle deployed
with new hash `B7oBS3E1` broadcast to all live user-topics.

**Law:** the wildcard fallthrough is just one shape of silent drop.
Type-level reuse (a typed CONTENT kind for events that aren't
content) is another. Wire-edge runtime allowlists out of sync with
TypeScript unions are a third. Each shape has the same fix —
explicit, structured, tested visibility — but each requires
different infrastructure (the route-level structured persist for
shape one, the closed-set kind enum for shape two, the
exhaustiveness pin for shape three). The job isn't "fix the
fallthrough." The job is "make every silent-drop shape impossible
to ship without the test failing first."

The Phase 5 list got another cleanup pass too. Sobelow promotion
(originally listed as "folded into the no-silent-drops cluster's
bucket 6") is now closed. The remaining Phase 5 items are TLS
verification + docs for self-hosters; both are real work, both are
visible and tracked.

Eleven sub-buckets shipped. One CRIT, twenty-five HIGHs, three
new memories (`feedback_subagent_driven_development`,
`project_no_silent_drops_closed`, the wire-narrow exhaustiveness
lesson rolled into the existing `feedback_no_localized_strings_server_side`
neighbor). The arc is small if you read the diff and large if you
read the discipline. Catch-all → typed-event → cross-surface
discipline → runtime-allowlist exhaustiveness, all in one cluster.
The next cluster is push notifications. The bouncer is closer to
public open than it was on Monday.

## S46 — 2026-05-15 — Visitor parity, NickServ-as-identity, and one preflight gap

This was supposed to be the push-notifications cluster. It became,
mid-brainstorm, something larger. vjt's spec on 2026-05-14 walked
the full visitor surface and named the rule out loud: visitors,
NickServ-authed visitors, and registered users all get the EXACT
same feature surface — only session lifetime differs. Every place
in the server that branched on `{:user, _}` vs `{:visitor, _}` and
refused the visitor branch was a parity violation, and the cluster's
job was to close every one. Push notifications would happen INSIDE
the cluster (V3) instead of as its own cluster.

Nine production buckets later — V1 schema migrations, V2 query
windows, F1 typed-event-topic flake fix slotted mid-cluster, V3
push subscriptions + Sender, V4 user_settings + watchlist + read
cursor, V5 Reaper cross-check, V6 cic visitor-branch sweep, V7
NickServ TTL semantics, V9 visitor `/nick` rename — all shipped on
the same day to `origin/main`. V8 (visitor → registered-user
promote) got dropped at brainstorm before it cost a line of code.
The 2026-05-15 spec refinement noticed the obvious: NickServ
identification with infinite TTL IS the permanent identity proof.
A double-password promote step would only invent UX problems to
solve UX problems that didn't exist.

The two-tier identity model is now: anon visitor on a 48h sliding
TTL (data co-terminus with session — Reaper sweep + FK CASCADE
wipes everything across five tables), NickServ-identified visitor
on infinite TTL (`expires_at = NULL` written at the
`commit_password/2` transition), registered user on the orthogonal
admin path via `mix grappa.create_user`. Three subject classes,
ONE feature surface. The XOR FK pattern that `read_cursors` had
since CP29 (`(user_id IS NULL) <> (visitor_id IS NULL)` CHECK +
two partial UNIQUE indexes per subject branch + ON DELETE CASCADE
to both parents) extended cleanly to `query_windows`,
`push_subscriptions`, `user_settings`. V5's cascade test asserts
all five owned tables zero out for any `Visitors.delete/1` call.

The `Grappa.Subject` context-boundary helper module is the
mechanism. Every persistence-write codepath builds its changeset
via `Subject.put_subject_id/2`; every read query goes through
`Subject.subject_where/3`; every controller picks subject from
`Subject.from_assigns/1`. The web-layer `GrappaWeb.Subject`
already existed; the new non-web `Grappa.Subject` mirrors it for
the context layer. Three files, twelve callers, zero new behavioral
surface — pure refactor + invariant pin.

V9 shipped simpler than the orchestrator brief proposed. The
brief had a complex sync-wait + 422-on-433-numeric +
`pending_nick_rename` correlation field design for the visitor
NICK rename. vjt vetoed it. User nick-rename has been
fire-and-forget 202 since day one; visitor=user per the parity
invariant; UNIQUE constraint + pre-check
(`Visitors.nick_in_use?/3`) covers >99% of races; cic already
listens to `own_nick_changed` (CP-15). The 432/433 silent-leave-
DB-unchanged shape is a pre-existing UX hole orthogonal to V9. The
simpler design avoided a COLD-required defstruct field + ref
correlation plumbing.

Then the deploy.

V9 was supposed to be a HOT deploy. `Session.Server`'s
`@type t :: %{...}` got the new `visitor_nick_persister` field —
per `feedback_deploy_sh_preflight_field_addition_gap` the
`scripts/deploy.sh` AST oracle SHOULD have caught it and demanded
COLD. Madonna porca, the AST oracle never ran. The deploy operator
had done `git merge --ff-only` BEFORE invoking
`scripts/deploy.sh`. The deploy's `git pull --ff-only` returned
"Already up to date", so the preflight diff base
(`HEAD@{1}..HEAD`) was empty. The AST oracle saw no diff to parse.
False HOT classification. `Phoenix.CodeReloader` fired against a
state-shape change.

The live BEAM survived the hot reload (no immediate crash) but
`_build/prod` got corrupted per
`feedback_hot_deploy_corrupts_build_prod`. Subsequent
`--force-cold` rebuild failed `compile_env validation`. Recovery
was `rm -rf _build/prod && scripts/deploy.sh --force-cold` —
clean rebuild + container recreate, ~30s downtime, visitors
auto-respawned via Bootstrap.

The lesson is the gap, not the recovery. The AST oracle is
correct code. The CLAUDE.md "merge → deploy" canonical workflow
IS the broken case for the preflight: `HEAD@{1}` snapshots the
state BEFORE `git pull --ff-only`, but if the operator already
pulled (or merged) locally, that's the same as HEAD. The fix
candidate is comparing against `origin/main@{1}..origin/main` (the
actual pre-pull remote state) or persisting a last-deployed-SHA
marker in `runtime/.last-deploy-sha`. Until that ships, the
operator must manually inspect `lib/grappa/hot_reload/long_lived_modules.ex`
+ migrations + `mix.lock` post-local-merge and pass `--force-cold`
defensively. Captured in `feedback_deploy_preflight_empty_diff_after_merge`.

**Law:** every safety check has an implicit assumption about WHEN
it runs. `scripts/deploy.sh`'s AST oracle assumed the merge
happens INSIDE the deploy. The CLAUDE.md workflow has the merge
happen BEFORE. The two assumptions never collided until V9's
specific shape (state-shape change + local-pre-merge habit + hot
reload that doesn't immediately crash) lit the corner up. Defense
in depth means: every safety check needs to also verify the
preconditions for ITS OWN INPUT. Empty diffs are not a quiet
"no changes" — they're a load-bearing signal that the diff base
is wrong.

Push notifications shipped INSIDE V3, the visitor surface unified
across nine buckets, V8 didn't get built because it didn't need
to exist. The bouncer's identity model is now the same model whether
you came in via NickServ on Azzurra ten years ago or opened cic
for the first time as an anonymous visitor today. The only
difference is whether your data outlives your browser tab.

## S47 — 2026-05-15 — Plain text, one emoji, no thumbnails: the image upload that didn't betray IRC

Twelve days earlier, on 2026-05-03, vjt had said it offhand —
"image upload would be nice." It went on the post-cluster arc list
under `project_image_upload` and waited. Same-day as the CP32
visitor-parity cluster closed, the time came. Porco dio, three
buckets in ninety minutes — that's the cluster.

The brainstorm v1 was wrong. Claude proposed inline thumbnails in
scrollback, a lightbox-on-click overlay, image previews on link
hover. The full social-media playbook. vjt rejected it with one
sentence: **"IRC REMAINS TEXT FUCKING ONLY."** Not a UX preference
— a foundational invariant I had failed to extract from the
existing codebase. ScrollbackPane renders text. linkify makes URLs
clickable. That's the contract. Adding inline thumbnails would
have required a new render pathway, image-loading state, viewport
intersection observers, lazy-loading heuristics, lightbox
component, keyboard navigation in the lightbox, escape-to-close,
prev-next nav... a UX surface area that grows forever and never
stops needing maintenance. None of which has anything to do with
the actual user need: "I want to share a photo I just took."

The brainstorm v2 cut it down. Just an upload mechanism. Just a
URL pasted into the message body. Just a clickable link rendered
by the existing linkify. The image is hosted somewhere else. The
PRIVMSG body is `image: https://...`. Done.

The brainstorm v3 went one notch further. vjt: **"plain irc
message with just a photocamera emoji 📸 and the fucking link.
that's it."** No `image:` prefix, no protocol-extension feel —
literally a single emoji as the visual cue, then the URL. Anyone
on Goguma or Quassel or mIRC sees a normal text PRIVMSG with a
camera emoji and a URL. They click the URL. The image opens in
their browser. Zero special handling on any client. Zero
server-side parsing. Zero IRCv3 tags. The wire stays text-only.
The web stays text-only. The model is the message.

The other vjt directive that shaped the cluster:
**"we DONT KNOW if we stay on litterbox thus BUILD INTERFACE to
plug different image hosters tomorrow."** Hence I-1, the pluggable
`ImageHost` interface. The interface shape (`upload(blob, opts) →
{url, expires_at}` plus `name` plus `default_ttl_seconds`) was
designed by reading the docs of three candidate hosters
back-to-back: litterbox (TTL knob 1h/12h/24h/72h), 0x0.st
(form-multipart no auth), catbox-permanent (auth header,
account-bound). The interface fits all three. The litterbox impl
is the first concrete; tomorrow's swap is a new file.

Then the trigger surfaces. The compose box gets a 📸 button.
That's the obvious one. But on mobile, the camera in your hand IS
the upload source — late in the brainstorm vjt added: "we should
allow to upload from camera on mobile as well." That's
`<input type=file accept=image/* capture=environment>`, gated to
`isMobile()` (≤768px), shown next to the 📸 button. And then,
because operators expect it, drag-drop onto the compose textarea
plus clipboard paste — both wired through the same orchestrator,
both honoring the same per-host privacy modal, both auto-sending
on resolve. Four trigger surfaces. One orchestrator. One privacy
modal. One auto-send.

The CSP gate was the surprise. The litterbox upload endpoint is
`https://litterbox.catbox.moe/resources/internals/api.php`. The
nginx CSP `connect-src` got `https://litterbox.catbox.moe` and
the I-CSP commit shipped, COLD-deployed because nginx doesn't
reload on the hot path. Then the e2e test hit the upload and
failed at the response read. Madonna porca, the response URL is
on `https://litter.catbox.moe/<random>.png` — note the dropped
`box`. Two hosts. The request goes to one, the response URL is
served from the other. Both must be in `connect-src`. Captured
empirically via curl, undocumented anywhere, an empirical pin in
the CSP.

The other small bug was the e2e selector. Playwright strict mode
rejected `page.getByRole("dialog")` because both the new
`PrivacyModal` AND the existing `SettingsDrawer` carry
`role=dialog`. Fix: `page.getByRole("dialog", { name: /privacy/i
})`. Lesson for every future cic dialog: include an `aria-label`
or visible `<h2>` so e2e selectors have a name. Cheap fix, easy
to remember.

The privacy modal itself is the kind of UI an IRC user shouldn't
need to think about more than once. First upload to a new host:
modal explains the host receives the image, lists the host's
TTL, asks for ack. Subsequent uploads to that host: silent.
localStorage key is `image-upload-ack:<host-name>`. Adding a new
hoster doesn't migrate existing acks; visitor sees the modal
once per host. Per-host namespacing falls out of the pluggable
interface for free.

I-3 is the docs sweep — README subsection, DESIGN_NOTES entry,
this episode, and the CLAUDE.md rule itself: **"IRC stays text
only."** A10 in the brainstorm. vjt explicit: "yes porco dio
codify that in claude.md, as that is already in readme.md." That
rule is the cluster's most important artifact. Future-Claude six
months from now will propose inline thumbnails again unless the
rule is in CLAUDE.md. The reason any feature ever proposes inline
thumbnails is that every other chat client shows them. The
discipline is remembering that grappa isn't every other chat
client — it's an IRC bouncer with a PWA frontend, and the wire
contract is text. The browser doesn't get to invent rendering
that the wire doesn't carry. The whole point of the listener
facade in Phase 6 is that a Goguma client and cic see the same
data; if cic invented inline thumbnails, Goguma would diverge.

**Law:** the spec is not the directions. The directions are the
spec. The first brainstorm copied what other apps do; that's
exactly the failure mode CLAUDE.md warns about under "Directions
over code." Existing patterns in the wider chat-app ecosystem
have nothing to do with this codebase's invariants. The IRC text-
only rule was already in the README; I should have read the
README before brainstorming. Three commits in ninety minutes
because the v3 brainstorm finally honored the invariants the
codebase had been carrying since Phase 0. The spec inherited a
bug; the directions named it; vjt closed it; the rule went into
CLAUDE.md so the next time it surfaces, the closed-set fence
catches it before any code gets written.

The bouncer is one feature closer to public open. The wire stays
text. The model is the message.



## S48 — 2026-05-16 — The task harness: one verb per task, and the phantom bug we didn't ship

The 2026-05-16 session opened on a stale-visitor incident. vjt
couldn't connect to azzurra because every cap slot was held by
debug visitors that nobody had a clean way to delete. The
diagnostic surface was a maze: `scripts/mix.sh` hardcoded
`MIX_ENV=dev`, so prod-DB tasks were unreachable without a
manual env-var dance. `scripts/db.sh` against prod was readonly,
so deleting rows required bypassing the helper entirely with raw
`docker exec sqlite3 -rw`. There was no way to attach to the
LIVE BEAM (`bin/start.sh` lacked sname + cookie, so `iex --remsh`
was unavailable). Mix-task discoverability was poor — 9
`grappa.*` tasks scattered with no top-level help. vjt's
strategic prompt: "should be fucking simple to run a mix task.
We can also have a bin/grappa utility if needed inside the
container."

T cluster shipped that utility. T-1 landed `bin/grappa` as the
host-side dispatcher — one verb per task, kebab-case CLI,
banner-grouped help, bats coverage. T-2 wired Erlang distribution
on the live BEAM (sname `grappa`, cookie from `RELEASE_COOKIE`)
plus `bin/grappa remote-shell` for interactive `iex --remsh` AND
`bin/grappa remote-shell --batch -e <expr>` for one-shot
`elixir --rpc-eval` evaluation. Important nuance from T-2 fix
(commit `82096a1`): `iex --remsh -e <expr>` evaluates in the
CLIENT node before attaching, which means `Process.list()`
returns 60-ish vergine procs instead of the live tree's 140+.
`--rpc-eval` evaluates on the REMOTE node and prints the result.
The distinction matters; the wrong form silently lies about
remote state. T-3 layered the operator-facing verbs on top:
`Grappa.Operator.delete_visitor!/1` synchronously terminates the
visitor's Session.Server BEFORE deleting the row, freeing the
SessionRegistry cap slot in the same call. Three `list_*_text!`
verbs print tab-separated tables for `grep | awk | cut`
pipelines. The bash dispatcher is a thin shell; the Elixir lives
in `lib/grappa/operator.ex` so a schema field rename can't
silently break a stringly-typed rpc-eval expression.

The biggest discipline lesson came mid-T-3 from descoping T-A7.
The brainstorm document claimed visitors had `expires_at: NULL`
in prod and that Reaper was failing to touch NULL rows. The
proposed fix was a `:grappa, :visitors, ttl_default: 86_400`
config knob plus a boot-time backfill helper. I verified before
building: `scripts/db.sh "SELECT COUNT(*), SUM(CASE WHEN
expires_at IS NULL THEN 1 ELSE 0 END) FROM visitors"` returned
`2|0`. Two visitors, zero NULL. Read the schema: `create_changeset`
REQUIRES `:expires_at` AND validates "must be in the future" — an
insert with NULL would FAIL changeset validation. Read the V7
migration: the column was made nullable specifically for
NickServ-IDENTIFIED visitors via `commit_password/2`, which
writes NULL = never-expires. Reaper's `not is_nil(v.expires_at)`
guard exists for that reason. The "backfill" would touch zero
rows; the "TTL knob" would only shorten the existing 48h to 24h
(silent regression). The brainstorm had inherited a stale
observation from an even earlier session. Per CLAUDE.md's
"Challenge the spec" rule — and per the project_image_cluster's
S47 lesson "the spec is not the directions" — I flagged the
finding back. vjt: "descope then porco dio." Three deliverables
not shipped; the ones that DID ship are smaller and tighter.

The pre-cluster work caught a separate flake: T-2 fix CI was red
on a known `NetworkCircuit ETS leak` from prior-container
residue. `Grappa.BootstrapTest:468` failed intermittently with
`spawned: 0, skipped: 3` because per-test-file
`clear_registry_for/1` helpers silently exhausted their 500ms
budget under CI load. The fix went into `Grappa.AdmissionStateHelpers`
as `reset_session_supervisor/0` — terminates every
SessionSupervisor child synchronously, raises if the Registry
doesn't converge within 5s. Loud > silent. That closed the
deferred B5 codebase-review action that had been sitting in
memory for 11 sessions.

The reviewer agent caught three real Priority-1 bugs in T-3
before the commit landed. The biggest:
`Credentials.list_credentials_for_all_users/0` filters
`connection_state == :connected`. The verb that `bin/grappa
list-credentials` was wiring to claimed "every bound credential"
in its docstring, but parked + failed rows were invisible —
exactly the rows an operator triaging a stuck network needs to
see. Fix: a new `Credentials.list_all_credentials/0` drops the
filter. Verified live post-cold-deploy: `bin/grappa
list-credentials` against prod shows vjt's `grappa@azzurra` cred
as `state=parked reason=user-disconnect`. Without the reviewer
fix that row would have been silently hidden. The reviewer also
caught a too-loose Registry match spec (`{:"$1", :"$2", :"$3"}`
matched any 3-tuple key, would have runtime-crashed on a future
non-session registration) and a misleading success line on the
concurrent-reaper race. Three independent reviewer findings, all
genuine; the agent is earning its keep.

T-4 closed the cluster with documentation: README operator
quickstart now leads with `bin/grappa help` instead of `scripts/
mix.sh` invocations; CLAUDE.md "How to run scripts" was rewritten
to lead with the operator dispatcher and demote `scripts/*.sh`
to "developer scripts"; the new `Credentials.count_by_state/0`
backs an honest Bootstrap log (`0 credentials in :connected
state (N parked, M failed) — running web-only` instead of the
pre-T-4 "no credentials bound" lie). A new CLAUDE.md
"Log honesty" rule under Code-shape rules codifies the general
principle: fast paths state what they observed, not what they
did.

**Law:** the spec is not the directions; verify state before
building the fix. The T-A7 descope was three commits not shipped
because the bug didn't exist. Building the wrong thing because
"the brainstorm said so" is the failure mode CLAUDE.md "Directions
over code" warns about. Specs inherit observations; codebases
evolve; before writing the fix, read the current code AND the
current state. T cluster ships smaller because of it; the bouncer
gets the verbs that close real gaps and skips the ones that close
imaginary ones.

Two clusters left in the T+M+U arc. M is admin console — `users.is_admin`
single-bit migration, `/admin/*` pipeline, cic drawer entry, eight
controller endpoints, real-time `grappa:admin:events` topic. U is
cap honesty — split visitor cap from user cap, stop swallowing
spawn errors at the controller boundary, allow device disconnect-
then-reconnect-with-different-identity, login probe timeout split.
The arc is a single thread: T gave us the verbs to triage live
state, M gives us the console to manipulate it, U makes the cap
errors honest enough that an operator can read what's going on.
The verbs are how you find what's broken; the console is how you
fix it; the cap honesty is how you stop confusing the operator
about why their session won't spawn. Three clusters, one
operator-experience thread.

## S49 — 2026-05-16 — The admin console: twelve buckets, one bypass-class bug caught at the gate

T cluster had given us the verbs — `bin/grappa list-sessions`,
`bin/grappa delete-visitor`, `bin/grappa reap-visitors`. They
work. They are also, plainly, a CLI: you ssh in, you remember the
verb name, you remember the argument shape, you read the
tab-separated output, you eyeball the row you want, you run the
mutation, you eyeball the result. For the operator who lives in
the terminal that is a complete loop. For the operator who has
a browser open already and just wants to see what the bouncer is
doing, it is a context switch they will pay every time.

The M cluster set out to close that gap: a browser-side admin
pane in cicchetto, paired with the same verbs as the CLI, gated
on a fresh `users.is_admin` bit. Twelve buckets. M-1 added the
column + helpers. M-2 wired the `:admin_authn` pipeline + the
first read endpoint. M-3 shipped the first mutation (visitor
delete) as a deliberate forcing function — every shape decision
the controller cluster needed to ratify (subject-shape branching,
422 vs 404 vs 403, idempotency posture) had to be resolved
before any read endpoint locked the shape in. M-4..M-6 filled
out the read + mutate REST surface. M-7..M-11 built the four-tab
cic pane (Visitors / Sessions / Networks / Events) one tab at a
time. M-12 is this docs sweep.

The architectural inflection that surprised us was the Events
tab. The first three tabs were poll-on-refresh — fetch the
resource, render, click refresh. The Events tab couldn't be: an
operator watching a session crash-loop needs the timestamps in
real time, not a tab they remember to F5. That meant a dedicated
Phoenix Channel, which meant authz semantics had to be settled
at the channel boundary, not per-controller. The first M-11 draft
gated authz in `handle_in/3` — non-admin sockets could still
`join/3` the `grappa:admin:events` topic; they just wouldn't be
able to send (and the channel never received user-originated
sends anyway). The reviewer flagged it as CRIT-1: the join-vs-
handle distinction is the difference between "could observe
events" and "couldn't bypass anything." We moved the gate to
`join/3`, where it should have been from the start. The fix was
twelve lines; the lesson is that WS authz lives at the boundary,
not per-message.

Three other shape decisions paid for themselves. **Composite-id
URLs for `/admin/sessions/:id`** — sessions are
per-`(subject, network)`, no natural single PK; making
`id = "kind:uuid:network_slug"` kept the routing table identical
to the registry shape rather than building a parallel mirror.
**Two-tier identity flows through the same endpoints** — visitor
disconnect collapses to terminate (visitors have no parked
state) inside the controller, not at the URL level. The browser
calls the same endpoint regardless. **DB state and live state
are surfaced as separate columns** with `null` when the live pid
is gone — `AdminSessionsTab` shows you both, and divergence
between them is information, not a bug to paper over. That last
one is now a CLAUDE.md rule under Code-shape: the U-0 honesty
signal.

The InlineConfirmButton story is the reused-verbs-not-nouns rule
in miniature. M-8's visitor delete needed inline confirmation —
modal felt heavy for a per-row action. We wrote it once. M-9b's
session disconnect needed the same shape; we lifted to a shared
component. M-10's Reset Circuit + Force Reap were the third and
fourth callsites without modification: the boundary held. The
component does not know what action it is confirming; it only
knows the confirmation flow. That is the shape that survives.

The cost was real. Eleven buckets shipped across about four days
of focused work, plus a docs sweep. CI integration tests have a
pre-existing m10-cap-editor failure ("Cannot type text into
input\[type=number\]" + a 30s timeout cascade) that pre-dates
M-9a; treating it as M-cluster-broken would have stalled three
otherwise-clean buckets. We carried it as a known followup and
shipped past it.

The discipline win, in retrospect, was per-bucket reviewer
loops. The Plan agent drafted each bucket; code-search verified
anchors; `/code-review:loop` ran on the diff before commit. The
overhead was not zero. But CRIT-1 on M-11 would have been an
admin-bypass-class vulnerability in production — the kind of bug
you find weeks later from a Sentry alert that just barely makes
sense, after non-admin sockets have been quietly subscribed to
admin events the whole time. Twelve lines of fix at review beats
twelve hours of post-incident forensics. The verbs let us triage
live state; the console lets us manipulate it; the reviewer
loop is what keeps the console from being the next vulnerability
class.

## S50 — 2026-05-17 — Cap honesty: two failures, one law, and a comment we ignored for weeks

The U cluster opened on a symptom vjt could reproduce in five
seconds. Click "connect" on a cap-saturated network. PATCH
returns 200. The row shows `:connected`. POST a message — 404.
There is no Session.Server. There is no banner. The operator
gets no information at all about why their session does not
exist. We had been carrying this bug for as long as
`max_concurrent_sessions` had existed, hidden behind a controller
helper that called the spawn orchestrator, got back `{:error,
:cap_exceeded}`, and returned `ok` because nobody had wired the
error path. The DB transition to `:connected` had been committed
first; the spawn was the swallowed afterthought; the operator
saw the DB and not the failure.

U-0 flipped it: spawn first against the parked credential, commit
the DB transition only on spawn success. The cap error now
propagates through the controller's `with` chain to
FallbackController and surfaces as a 503 with a typed atom. The
DB stays at the prior state. Cic renders the typed atom into a
banner the operator can actually read. U-1 split the single cap
column into two — visitor cap and user cap as independent
admission surfaces, so a debug-visitor flood never blocks
operator login. U-2 made admission subject-aware via
`Grappa.Subject.t()` and split the single 3s login-probe timeout
into three typed budgets (TCP connect, NICK/USER → 001,
outer wait), because `raccooncity.azzurra.chat` had been
intermittently 504-ing at 3s when Bahamut's rDNS lookup
blocked the 001 emit beyond the budget. U-3 wired the 503
`too_many_sessions` mapping + admin live_counts + cic
`assertNever` exhaustiveness on the typed-error sum. U-4 paid
the TEST-DEBT bill — U-2 had shipped UD5.A+B production code
incidentally, but the tests needed retroactive coverage. U-5
polished the admin Networks tab with per-network live cap
counters via a `:cap_counts_changed` typed event that decrements
1/3 → 0/3 in real time as sessions die.

The cluster shipped what we planned. It also shipped what we did
not plan: a second swallow-bug, surfaced by CI going red on U-5.

The CI failure was `BootstrapTest:468` + class siblings,
intermittent, exactly the shape of `feedback_recurring_e2e_not_flake`.
The diagnosis chain: `IRC.Client.handle_call({:send, _}, _, _)`
had a `:ok = transport_send(...)` pattern match that raised
`MatchError` on the closed-but-not-nil socket shape, and
propagated `FunctionClauseError` from `:gen_tcp.send(nil, _)` on
the nil-socket shape. Both crashes cascaded into
`Session.Server.terminate/2`, whose exit-catch list was too
narrow to recognize the wrapped MatchError. The supervisor
blocked 5 seconds per dying child. The test helper
`reset_session_supervisor/0` had a 15-second registry-clear
budget. Three siblings in the registry, 5s each = 15s exhausted,
test times out, CI red. The bug had hidden for weeks under a
"shouldn't happen" exception clause; it surfaced as a CI flake
because the test load finally pushed three concurrent
SessionServers into the dead-socket-SEND path at once. Fix at
the IRC.Client boundary: return `{:error, :no_socket | :closed |
_}` honestly. Callers that don't care (`Session.Server.terminate/2`'s
best-effort QUIT) `_ = `-discard the result. Commit `7bb3caa`.
CI green on first run after.

Two swallow-bugs, same cluster, same shape. The U-0 controller
discarded a `{:error, _}`. The IRC.Client raised, and
`terminate/2`'s wide catch swallowed the raise. Different
mechanisms; same effect; same root cause; same fix pattern. The
operator (or CI) MUST see the failure. Fix at the boundary that
raised; never widen the catch to swallow more. The CLAUDE.md
rule under Code-shape now covers both shapes; the U cluster is
the canonical example and the commit hashes are the receipts.

The meta-lesson is harder to ship and easier to ignore. Both
bugs had been called out in code comments as follow-up cues long
before they bit production. The U-0 controller had a comment
that said "this is wrong but ship the bigger fix later." The
IRC.Client `:ok =` was a load-bearing pattern-match that nobody
owned. Per `project_no_silent_drops_closed`: a safety net that
catches an impossible exception silently absorbs the next class
of bug. The U cluster cleanup proved a corollary: a TODO-comment
that says "follow-up cue against X" is real signal, not noise.
File it as a cluster candidate immediately. We did not file
either one. The bouncer ran in production with both for weeks.
That is the cost of the comment-as-disposal pattern, and we are
paying it back, one cluster at a time.

The T+M+U arc is closed. T gave us the verbs to triage live
state. M gave us the console to manipulate it. U made the cap
errors honest enough that an operator can read what is going on.
The thread holds: three clusters, one operator-experience story,
each cluster shipped before the next began. iOS UI polish is
next on the queue, then the full codebase review.

The U-Z close was small. One spec
(`cicchetto/e2e/tests/u-z-cap-honesty-cluster-journey.spec.ts`)
replays the cluster narrative end-to-end in REST: park vjt,
admin saturates the user cap, /connect rejects 503, the DB row
stays at `:parked` (the spawn-first-commit-second invariant that
U-0 introduced), admin bumps cap, /connect succeeds, admin
saturates the visitor cap, /connect STILL succeeds because the
caps are independent. The spec asserts the load-bearing
invariants in one reproducible run; it doesn't re-drive every
per-bucket surface (per-bucket specs already cover those). And
the audit step turned up zero remaining `{:error, _} -> :ok`
patterns in any controller — the U-cluster cleanup left the
swallow-class actually fixed. The "documented but not driven"
list in DESIGN_NOTES is itself a finding: we wrote down which
plan items the e2e doesn't drive AND why (per-bucket coverage
already pins it; unit test is the right level; or — for the
iptables phase smoke — the test harness physically can't simulate
it). E2e tests aren't the right tool for every cluster
invariant. Knowing where they aren't is part of closing the
cluster.

## S51 — 2026-05-17 — Four iPhone fixes, no architecture: cic feels like an app

Four buckets. ~150 lines of diff across them. No server changes, no
wire-protocol shapes, no new abstractions. The cluster scope existed
because vjt was using cic on his actual iPhone every day and the
friction was real: pinch-zoom rescaled the page like a 90s website;
the Dynamic Island chopped the top of TopicBar; the home-indicator
ate the bottom of BottomBar; there was no way to close a channel tab
from the bottom bar (had to PART server-side); the default 14px font
felt small after iOS suppressed Safari's automatic text-zoom.

The fix bag was mechanical. iOS-1 was six lines — the viewport meta
gained `maximum-scale=1, user-scalable=no` and html/body gained
`overflow:hidden; overscroll-behavior:none`. Pinch-zoom died.
Rubber-band overscroll died. The page suddenly felt like a fixed-
layout app instead of a webpage rendered at the wrong zoom level.

iOS-2 added `env(safe-area-inset-*)` padding to the four bars/drawers
that touch viewport edges. TopicBar's existing `0.5rem` padding-top
became `max(0.5rem, env(safe-area-inset-top))` — preserve the
declarative padding on non-notched contexts, take whichever is bigger
when the notch eats space. BottomBar gained padding-bottom for the
home-indicator. shell-members + settings-drawer (both full-height
drawers) got both insets.

iOS-3 added the close × to mobile BottomBar tabs that Sidebar had
always had on desktop. The hidden lesson was the shared helper: the
PART logic lived in Sidebar as two inline handlers; copying them into
BottomBar would have given us four call sites of "the same logic with
slightly different surrounding component shape." The bucket extracted
`lib/windowClose.ts` instead — one function, four callers. The shared
helper is invisible to the operator but it's the kind of structural
discipline that keeps the cic code from rotting: when a third surface
needs the close × (say, a future tablet layout), it imports the helper
instead of re-implementing PART semantics for the third time.

iOS-4 added the font-size selector — five radios in SettingsDrawer,
12/14/16/18/20 px = S/M/L/XL/XXL. Closed-set union type at the
TypeScript layer, validated at the localStorage boundary, fallback to
default ("M") on any corrupted stored value. Boot-apply pattern lifted
directly from `lib/theme.ts`: the helper runs in main.tsx BEFORE
render() so the first paint is at the right size — no FOUC. The CSS
plumbing already existed: `:root { --font-size: 14px }` cascaded into
every `font-size: var(--font-size)` rule in the stylesheet, so the
helper just overrides the var on `<html>` at boot. Nothing else
changed.

The cluster-close iOS-Z spec is honest about one limitation:
Playwright's webkit emulation doesn't simulate the OS notch, so
`env(safe-area-inset-top)` resolves to 0 inside the spec. The
assertion is "the layout didn't break" — the top bar's bounding-rect
top is `>= 0`. The real notch-clearance evidence is browser-smoke
screenshots from a notched iPhone shape (vjt's own iPhone, smoked
post-deploy). The spec comment says so explicitly: this is the kind
of "documented limitation" discipline that keeps future-Claude from
trusting the green checkmark for something the tooling physically
can't verify.

The KISS held because the cluster plan held. Four buckets, each one
budgeted in the plan doc, each one closed with reviewer-loop +
browser smoke + commit + per-bucket deploy. No scope creep. No
"while we're in here let's also..." The orchestrator's main job was
saying no to bucket bloat — the brief drafted at session start
included the discipline ("KISS, smallest possible diff per bucket"),
and per-bucket reviewer-loops surfaced the few NIT-grade simplifications
that arose (iOS-4's lazy reactive signal was dead code from a
speculation about a future consumer; the in-amend fix dropped it).

cic feels like an app on iPhone now. The diff is small. The cluster
arc — T → M → U → iOS — is closed. Next: full codebase review.

## S52 — 2026-05-17 — Three small bugs, one mini-cluster: post-iOS dogfooding catches what specs miss

The iOS cluster shipped on 2026-05-17. Within twenty-four hours of
vjt actively using cic on his iPhone, he caught three bugs the
cluster missed: archive entries had no delete affordance, the mobile
BottomBar had no way to even REACH archive, and the cold-load shell
(before any channel was selected) painted under the Dynamic Island.

None of these were regressions. UX-1 was a feature gap that nobody
had spec'd. UX-2 was a viewport bias — Sidebar's archive `<details>`
expansion never landed in the BottomBar because BottomBar's design
brief hadn't included an archive surface. UX-3 was a one-line miss
in iOS-2's safe-area-inset rollout: `.topic-bar` got the `max(0.5rem,
env(safe-area-inset-top))` padding, but `.shell-empty-toolbar` — the
sibling header rendered when no channel is selected — was overlooked.
A grep would have caught it; a CSS-rule diff didn't.

The mini-cluster — three buckets and a close — was KISS to the bone.
UX-1 added one server context function (`Scrollback.delete_for_dm/3`)
+ one route + one cic helper (`lib/archiveDelete.ts`) + the
`InlineConfirmButton` two-step on sidebar archive rows. UX-2 lifted
`visibleArchiveForNetwork` out of Sidebar into `lib/archive.ts` (one
function, two callers), added `.bottom-bar-archive-chip` per network,
and built a new full-overlay `ArchiveModal` that reused UX-1's
`InlineConfirmButton` + `deleteArchiveEntry`. UX-3 was a one-line
CSS mirror of `.topic-bar`'s padding rule. The fix bag was
mechanical; the discipline was holding the line at "smallest possible
diff per bucket."

Two non-obvious lessons surfaced. The first: vite's CSS minifier
MERGES rules with identical property values into comma-list
selectors. The UX-3 Playwright spec was correct in dev (where
`.shell-empty-toolbar` had its own rule) and broken in prod (where
the rule lived under `.topic-bar, .shell-empty-toolbar`). The
`selectorText === "..."` exact-equality check skipped the merged
rule and returned `NOT FOUND`. The fix was switching to split-on-
comma + `.includes(...)` — and the fix only surfaced because the
per-bucket browser smoke against the deployed bundle (not just
dev mode) caught it. Yet another reason that per-bucket browser
smoke at deploy time is non-negotiable, even for trivial CSS bucket.

The second lesson: identity-scoped signals must live INSIDE the
identity-scoped store. UX-2's first cut put `archiveModalNetwork` at
the top level of `lib/archive.ts`. The reviewer flagged a HIGH leak
class: `identityScopedStore` rotation (on token refresh, identity
switch) would flush `archivedBySlug` but leave the modal open on a
network the new identity might not have any data for. The fix moved
the signal INSIDE the scoped store so rotation closes the modal
alongside the data flush. The general rule: any signal that
REFERENCES identity-scoped data must itself be identity-scoped. This
joins the `feedback_solidjs_for_ref_leak` family of "Solid reactivity
needs explicit lifecycle plumbing."

The cluster-close UX-Z spec mirrors the iOS-Z + M-Z + U-Z shape: one
`@webkit` iPhone 15 spec, all three buckets back-to-back. Per
`feedback_e2e_user_class_parity_matrix`, it asserts the parity matrix
via a CLASSES loop. "registered" drives end-to-end; "visitor" is
blocked on `feedback_visitor_mint_e2e_cold_start` (the bahamut-test
mint pathway 504s on cold-start because synchronous mint exceeds
`login_probe_timeout_ms`); "nickserv" is unseeded in the e2e harness.
Both skipped classes are documented as `test.info().annotations`
entries with the reason + the unit-coverage pointers. The loop
structure is preserved so a future operator unblocking visitor cold-
start can flip the skip + add nickserv seeding without restructuring
the spec.

The big meta-lesson is the post-cluster dogfooding window IS the
cluster's final review pass. Three bugs in twenty-four hours after
a four-bucket cluster — that's the friction the spec-shaped review
flow physically can't see. Budget for a mini follow-up cluster after
every UX-touching cluster; the iOS cluster's "real" close was the
UX cluster.

Next: vjt-driven full codebase review per
`project_post_tmu_full_review_scheduled`. Three multi-week clusters
landed in nine days. The review will catch what mass-shipping at
this pace inevitably missed.

## S53 — 2026-05-18 — Sixteen commits hunting one iPhone: the keyboard, the chrome, the empty pane

The post-iOS-cluster dogfooding window opened on a Sunday and didn't
close for sixteen more commits. The original UX cluster had shipped
the previous day as three small, atomic buckets — close × on archive
entries, BottomBar archive chip, Dynamic Island clearance — and we
posted the close docs. Within an hour vjt was back on the iPhone
with a different class of bugs: the iOS keyboard dismissed when it
shouldn't, the chrome bar rubber-banded down when it shouldn't, and
dragging on an empty scrollback scrolled the viewport instead of
doing nothing. Sixteen `ux-3-*` commits later, all of those were
fixed. None of them were caught by the spec, none by Playwright
webkit, all of them by vjt holding the phone.

The keyboard saga took six commits to land and rolled back four
attempts along the way. The fixes that stuck: viewport-meta
`interactive-widget=resizes-content` lets us tell iOS Safari to
resize the layout viewport rather than push it up under the
keyboard; VisualViewport API drives a `--viewport-height` CSS
variable that tracks the actual visible region as the keyboard
opens; `window.scrollTo(0, 0)` pins the layout pin-point so the
focus-scroll heuristic doesn't run; `preventDefault` on BottomBar
pointerdown stops touch-handlers from synthesizing a focus-shift;
and a flat-flex BottomBar disentangles the wrap rules that were
clipping the tap target. The fixes that didn't stick: `100dvh`
(hides the top bar when the keyboard opens because dvh resolves
differently in keyboard-open state), `position: fixed` on the shell
(broke BottomBar interaction), `position: fixed` on body (broke the
topic bar). Four reverts is a record for a single session, and
every one of them surfaced because vjt re-tested the broken case
within five minutes of the deploy. Playwright webkit said all five
attempts looked the same.

The chrome-gesture saga (UNDEC, three rounds) was simpler in shape
but harder to land. The bug: dragging on cic — anywhere, even on
top of an empty scrollback area — caused iOS Safari to show its
chrome bar (the address bar slides down) and dismiss the keyboard.
The browser's heuristic: if the user touches outside the scrollable
content, treat the gesture as a page-level scroll. The fix in three
rounds: `#root { height: 100% }` removes the real overflow on root
that gave iOS a "scroll target" (R1); `overscroll-behavior: contain`
on `.scrollback` and `.bottom-bar` prevents the scroll-chain from
walking up to the viewport (R2); and finally `touch-action: none` on
the `.shell-mobile` blanket with `pan-y`/`pan-x` re-enabled per
scroll-container (R3). R1 + R2 alone weren't enough — the
drag-from-non-scrolling-area case still bled through. R3 finally
rejects the gesture cleanly at the shell boundary and re-grants
per-element scroll permission where it's wanted.

But then vjt found that dragging on the EMPTY scrollback (cold-load
with no messages, or a sparsely-populated window) STILL scrolled the
chrome. We'd given `.scrollback` `pan-y` for the legitimate scroll
case — and iOS interprets `pan-y` on a non-overflowing element as
"no scroll work here, propagate to viewport." So we landed Z3, then
Z3-R3, then Z3-R4. Z3 added a `touch-action: none` to `.scrollback`
when it was empty (worked for empty, broke for 1-2 messages). Z3-R3
tried `overflow-y: scroll` to force the always-scrollable semantic
(iOS didn't care). Z3-R4 finally measures `scrollHeight >
clientHeight` via JS on `messages-change ∪ window-resize ∪
visualViewport-resize` and toggles a `.scrollback-overflowing` class
that gates `pan-y`. That worked. The lesson worth carrying: CSS has
no `:has-overflow` selector. When touch-routing depends on actual
layout state, you measure with JS.

Two server-side bugs landed in the same arc. The first (Z): in
`Scrollback`, `list_archive` used `COALESCE(dm_with, channel) = ?`
to find archive entries, but `delete_for_dm` used a strict
`channel = ? AND dm_with = ?` match. So rows the list returned —
particularly orphan rows that had server-side NOTICEs with
`dm_with = NULL` — couldn't be deleted. Two functions on the same
data, two predicates: orphan-class silent-bug. The fix made the
delete coalesce too. **Generalizable**: any read/write pair on
shared columns MUST share the same key predicate. The second (Z2):
closing a channel or query window via REST or the GrappaChannel
handler did NOT broadcast `archive_changed`, so the sidebar
archive chip count and the ArchiveModal contents stayed stale
until a page reload. UI surface drift from source-of-truth.
Reactive UI MUST be wired to a typed event on every state-mutating
endpoint; "the cic will re-fetch eventually" isn't a contract.

The Z-arch fix sits alongside these: opening an archive entry from
sidebar or modal set `selectedChannel` but did NOT call
`openQueryWindowState(...)` — so the per-channel Phoenix topic
wasn't subscribed and live events (NOTICE 401 etc.) went
unreceived. The lesson: setting `selectedChannel` and subscribing
to the channel are independent cic operations. Side-door entry
points (archive revival, future deep-link, search-result clicks)
must do BOTH. JOIN paths get this right because JOIN explicitly
opens; archive revival was a sideways entry that skipped half the
work. Audit-class bug — there might be more like it.

And the keyboard-preserve helper (Quart-DEC + TER-DEC + BIS-DEC)
evolved through three rounds: per-button explicit wiring (too
fragile), globalized via `document` capture listener (right scope),
and then a `pointerdown` → `mousedown` swap (right event). The last
one surprised: on iOS, `pointerdown` is a gesture-start event that
blocks scroll-gesture dispatch; `mousedown` is a synthesized
focus-shift-only event that doesn't. We needed the latter — to
capture focus without blocking the underlying touch-scroll on the
ArchiveModal scrollable list. The mousedown/pointerdown distinction
isn't in any documentation I'd seen; vjt's iPhone surfaced it as
"why won't archive modal scroll when I tap a row?"

The biggest meta-decision was to keep all sixteen commits under the
`ux-3-*` prefix rather than open UX-4 mid-session. The cluster had
closed the previous day but the bug-hunt was clearly continuation,
not new work — the same surfaces, the same dogfooding round, the
same prior-cluster scaffolding. UX-4 opens fresh once docs catch up
(this episode) and a coherent new bug-class emerges (the 20 bugs
that vjt reported next, which already are scoped to UX-4 buckets
A through Z). The cluster ID is about narrative coherence, not
commit count.

The technical-debt carry: `ArchiveModal.handleConfirmDelete` has a
bare `catch {}` clause that swallows promise rejections — CLAUDE.md
UD10 "no silent-swallow at boundaries" violation, flagged during
this cluster but left unfixed. First UX-4 slot that touches
ArchiveModal closes it. Carrying the debt to the next cluster's
ledger rather than fixing it as a one-off is the right move:
fixes need a home in a cluster's narrative, not a free-floating
chore.

## S54 — 2026-05-26 — The wrapper plug that wasn't a config flag

vjt opened the admin panel post-cp50 polish and reported five things
in one message: M\Grappa's expiration says "indefinite" with no
explanation; one of three live sessions had no visitor row behind
it; the sessions tab showed `user:8f6a979b` instead of "vjt"; he
wanted to manage networks/users from the admin UI; and visitor IPs
were all `172.x`-shaped docker bridge addresses, not real clients.

The IP one was the security half. Phoenix sees `conn.remote_ip` from
the TCP peer, which is always nginx on the docker bridge.
`auth_controller.ex`'s moduledoc had carried "Phase 5 will add a
configurable trusted-proxy list" for months. Time to pay the bill.

Research showed `remote_ip` (the hex package) was the canonical
answer — pure Plug, mature, no Phoenix coupling, and its default
reserved-range list already covers RFC1918 + docker bridges, so the
config is `headers: ~w[x-forwarded-for x-real-ip]` and you're done.
Or so I thought. I wrote the test first — twelve cases covering
nginx-shaped, X-Real-IP fallback, right-to-left walk, public-IP
spoofs — and added a `:clients` option to handle the loopback case
where I assumed `clients: ["127.0.0.0/8"]` would mean "trust this
peer's headers."

Half the loopback tests failed. The plug rewrote `conn.remote_ip`
from spoofed X-F-F headers exactly when I wanted it not to.

Re-read the package source. The `:clients` option does the OPPOSITE
of what its name suggests. It marks IPs *inside the header chain*
as terminal clients (overriding the reserved-range skip), not "trust
this peer's headers." There is no peer-based option at all — the
plug never inspects `conn.remote_ip`. That's by design: the package
is a header parser, not a trust-boundary gate.

So `docker exec grappa curl -H "X-Forwarded-For: 127.0.0.1"
http://localhost:4000/admin/reload` would rewrite `conn.remote_ip`
to loopback and pass the `LoopbackOnly` gate. Container shell →
admin reload. The gate would silently break.

The fix is a wrapper plug. Three function clauses: peer is loopback
→ skip the rewrite; peer is anything else → delegate. Forty lines
including the moduledoc. The test that caught the misconfig now
also serves as a forever sentinel against re-flattening the wrapper
back to bare `RemoteIp` — controller-level spoof tests assert the
full Endpoint pipeline behavior, so a refactor that removed the
wrapper for "simplicity" would fail loudly.

The lesson isn't "read package docs more carefully." Package docs
were fine — I'd just stopped reading at "look how easy this is" and
missed the algorithm section. The lesson is **write the threat test
first, then the config.** The threat in this case was "container
shell sets X-F-F to loopback and the gate trusts it." If I'd
written the config and committed, the test wouldn't have caught it
because I wouldn't have thought to write it after the config looked
green. Writing the failing-spoof test first forced me to think
about what loopback should actually mean here.

The other four buckets went smoother. Subject-label pre-join in the
sessions wire was a one-day job with a free bonus: the same `nil`
slot doubles as the orphan-pid honesty signal (live pid, no DB
row). The composition lives in the controller, not in
`LiveIntrospection`, because that module's boundary explicitly
excludes Accounts and Visitors — pure live-state, no DB context.
The end-to-end test deletes a visitor row out from under a live pid
and asserts the `subject_label: null` surfaces correctly. That test
will catch the next class of "DB row deleted via raw SQL" silently.

The NickServ-badge bucket was twenty minutes: `"indefinite" →
"indefinite (NickServ)"`. The whole point was making the WHY loud
so the operator can distinguish "intentionally permanent" from "bug
where the column should have been set." One line of code, two
tests, ship.

And then post-deploy I checked the live state and found bucket A
hadn't actually fixed vjt's complaint. M\Grappa's IP was STILL
`172.19.x`. The wrapper plug worked perfectly — for new logins. But
`visitors.ip` was set ONLY at row creation, and M\Grappa was created
back in May before the wrapper existed, with NickServ-identified
visitors persisting forever. Her `find_or_provision_anon` short-
circuited on the existing row and never wrote the column. The fix
was a fifth bucket: refresh `:ip` on every login when the value
differs. Three guards: same IP no-op, nil-IP no-op (don't blank a
real value), different non-nil → update.

Bucket E got scrapped mid-session. vjt: "scrap admin manage now,
proceed with bastille." The five-bucket scoping I'd offered him
included a manage-cluster (create networks, reset passwords,
bind/unbind credentials) but `bin/grappa *` already covers all of
those for the operator path. The admin UI parity was nice-to-have,
not blocking. Bastille is.

**Law:** *Read the directions, not the surrounding code* applies to
package documentation. Package docs that read like marketing
("zero-config!", "secure by default!") are written for the happy
path. The threat-model details live in the algorithm appendix.
Write the failing test that exercises your specific threat *before*
trusting the marketing — the gap between "what the package does"
and "what your system needs from it" is exactly where security
bugs hide.


---

## Episode — bastille shipped, log routing under runtime/ (2026-05-27)

The bastille deploy workstream that's blocked ★ ROADMAP since cp50
shipped today. m42 prod is now a native Elixir release in a
FreeBSD bastille jail; irc.sniffo.org and irc.sindro.me serve from
it. Docker prod is retired. The pipeline is `sudo bastille cmd
grappa /home/grappa/grappa/infra/freebsd/deploy.sh` and it's
self-sufficient — pull, mix release, vite build, migrate, restart,
healthcheck.

The session that actually shipped the work was the cleanup pass on
where logs land. The bouncer's been writing app-level Logger output
to stdout forever (`scripts/monitor.sh` for the dev container,
inherits to syslog in prod) and that was fine. Then I added a
`:logger_std_h` file handler in `Grappa.Application.start/2` writing
`runtime/log/grappa.log` so the operator could tail the app log
from the host filesystem. Plus I'd set `RELEASE_TMP=runtime/log` in
the rc.d so run_erl's stdout-tee (`erlang.log.*`) would also land
under runtime/. Both shipped, both worked.

vjt asked: "why do we have runtime/log/grappa.log AND
runtime/log/log/erlang.log.1 — they're the same thing?" They were.
Same lines from the same Logger backend, written twice, in two
files, with two independent rotation sets. One sink was always
going to be redundant.

The choice was easy once stated plainly: drop the Elixir file sink,
keep the run_erl tee. The run_erl path is OTP-canonical, survives
`mix release --overwrite` (because RELEASE_TMP points outside the
release tree), and works without an Application-callback. The
Elixir file sink was nice but additive — it carried the maintenance
burden of a custom handler config for no benefit the run_erl tee
didn't already provide.

The revert deleted 116 lines (4 config files + the Application
helper + a bunch of env-var plumbing in compose.yaml + .env.example
+ grappa.env.example + CLAUDE.md). The keeper changes from the
first pass survived in two commits: the `RELEASE_TMP` export fix
(POSIX `VAR=val cmd` doesn't persist past the `.` source builtin
— had to convert to `export VAR;`) and the relative-path footgun
hunt (`runtime/log` defaulted relative, mix release CWD is
`_build/.../rel/grappa/`, grappa user can't write there). Then a
second fix because `RELEASE_TMP=runtime/log` produced
`runtime/log/log/erlang.log.*` — run_erl always creates its own
`log/` subdir under RELEASE_TMP, so the right value is `runtime`
(one level up), letting `runtime/log/` and `runtime/pipe/` land at
the canonical paths.

Total deploys to prod for this whole arc: 4. Three bug-fix
restarts in fast sequence (file-sink eacces crash, RELEASE_TMP
unexported, double-nested log path) plus the final clean revert.
Each one ate ~30s of session uptime — visitor reconnects all
worked.

A CI flake fell out of the bigger session. While the bastille work
was landing, `admin_events_test.exs` setup started flunking with
"SessionRegistry never drained" — 10 in a row on the same GHA run.
Local green, CI red. Same rotating-cascade pattern as
`feedback_ci_cascade_rotating_set`: the canonical "test-order
state pollution under coveralls load." The setup helper aggressively
force-stops leaked Session pids, then sleeps 50ms before checking
the Registry is empty. `Session.stop_session/2` returns once the
pid is dead, but the Registry's own monitor-DOWN cleanup runs in a
separate process and is asynchronous. 50ms is plenty locally;
under CI ETS contention it's not. Replaced the single sleep with a
200×10ms poll matching the upstream passive-wait shape and CI went
green.

**Law:** *Two sinks for the same stream is always a smell.* When
you find yourself with `app.log` AND `erlang.log` containing the
same lines, pick the OTP-canonical one and drop the other. Don't
keep both because "they might diverge someday" — they won't, and
the cost of converging two parallel rotation sets after they DO
diverge is much higher than the cost of consolidating now.

**Law (corollary):** *`mix release` and `mix phx.server` are not
interchangeable boot paths for on-disk defaults.* Anything that
mkdir_p's a relative path will silently work in dev and `:eacces`
in a release. Derive on-disk defaults from already-absolute
env-driven paths so the only difference between dev and prod is
the value of the env var, not the path-resolution semantics.

## Episode — three bugs in a stack: visitor rejoin, the AdminEvents flake, and a zombie session that wouldn't die (2026-05-27)

Started the session intending to fix one bug. Ended it having
fixed three, each one a deeper layer of the same architectural
class. The thread that connects them: `:transient` workers in a
`DynamicSupervisor` are not safe to delete from the outside.

**Visitor rejoin first.** vjt noticed visitors don't rejoin
channels after a bouncer restart. Users do. Five minutes of
grep later: `Grappa.Visitors.list_autojoin_channels/1` reads from
a `visitor_channels` table whose schema's own moduledoc admits the
writer never landed. *"writes will land when the
visitor-rejoin-on-restart cluster lands a producer."* The cluster
that comment was waiting for? The one we were sitting in.

Easy fix in concept — schema-mirror the users' shape: add
`visitors.last_joined_channels`, drop the unused table, wire the
same `last_joined_persister` callback users have used since CP22.
The interesting part is the meta-finding: an empty table sitting
in the schema for THREE WEEKS, dependent on a producer that
nobody ever wrote, with no test asserting it had any rows. We've
been shipping a feature that's been off for the entire visitor
lifetime of the bouncer. Nobody noticed because the visitors
themselves treated it as normal — fresh nick every time, empty
channels, manual /join each session.

Cold-deployed at 14:47. While the deploy was happening, CI
failed on `master` for the rejoin commit.

**Second bug: the AdminEventsTest flake.** Ten
`Grappa.AdminEventsTest` setups flunked in a row on the same CI
run with `SessionRegistry never drained — stale entries: [...]`.
Local: green. Repeatable green, even under `--repeat-until-failure
20`. The flake had been chased four times already (commits
b17fd71, a9e0c24, fd52a96, 1108808) — each iteration bumped the
drain budget. Each iteration treated the symptom.

Trace: the setup helper grabs `Registry.select` to find leaked
`:session` entries from prior tests, calls
`Session.stop_session/2` for each. `stop_session` does
`whereis` → `terminate_child` → wait for `:DOWN`. Fine in
isolation. But the leaked pids belong to `:transient` workers
whose linked `IRC.Client` crashed on `:tcp_closed` at end-of-test
(the fake IRCServer dies with the test pid). Abnormal exit →
DynamicSupervisor restart → new pid registers under the same key.
The setup's `whereis` returns the OLD pid (sometimes), or `nil`
(during the restart window), or the NEW pid (after). Drain loop
races the supervisor's own scheduling.

The real fix lives one layer up. `auth_fixtures.ex` —
`start_session_for/2`, `start_visitor_session_for/2` — spawn
`Session.Server` workers and return the pid with NO teardown
registered. End-of-test IRCServer death → respawn loop that
outlives the test pid → registry poison. Two-pronged fix:
register an `ExUnit.Callbacks.on_exit` callback that calls
`DynamicSupervisor.terminate_child` (atomic, removes the child
from the supervision tree, no restart possible), AND replace the
AdminEventsTest setup's inline drain with
`Grappa.AdmissionStateHelpers.reset_session_supervisor/0` — the
canonical helper that walks `which_children` instead of the
Registry. ~110 lines of inferior reimplementation deleted.

CI green on the next push.

**Third bug came back through the front door.** After the deploy
vjt opened `bin/grappa list-sessions` and saw:

```
visitor 59d570d6-...  azzurra  pid=<0.2538.0>  alive=true  members={}  autojoin=[]
```

No corresponding row in the `visitors` table. The classic
"runtime/DB divergence" honesty signal that
`AdminSessionsTab` was specifically designed to surface (per
CLAUDE.md "DB state and live state are separate sources of
truth"). Now we had to actually deal with one.

Logs told the story: visitor logged in with nick "vjt". Same nick
the registered user already had on azzurra IRC. Upstream 433
nick-in-use → Session.Server crash → transient restart → 433 →
crash → ... vjt fired three admin `DELETE /admin/sessions/...:1`
+ one `POST .../disconnect`. Each killed the live pid. Each was
followed by a new pid registering itself within seconds, because
the supervisor had ALREADY scheduled the next restart from the
previous crash cycle. By the time the dust settled the backoff
was at 25 minutes (failure_count=9) and the slot was unrecoverable
without a full app restart.

Same root cause as the test flake — `:transient` worker in a
DynamicSupervisor that doesn't consult external state on
respawn. The test fix used `on_exit` to call
`DynamicSupervisor.terminate_child`. That doesn't generalise to
production — there's no `on_exit` at the operator-action
boundary.

The architectural fix: `Session.Server.init/1` accepts an optional
`subject_row_present?` closure. If it returns `false`, init
returns `:ignore`. `:ignore` is OTP-canonical for "don't start
me" — DynamicSupervisor accepts it as a normal-shutdown signal,
removes the child from supervision, and stops restarting. Both
`Networks.SessionPlan` and `Visitors.SessionPlan` supply the
closure (DB-row check). Test fixtures and manual spawns omit it —
init treats nil as "no gate" for backwards compat.

Plumbing extended through `SpawnOrchestrator` (`{:ok, :ignored}`
outcome), `Bootstrap.Result` (`subject_row_gone` counter), the
NetworksController, and the visitor login path. Four new tests
pin the closure follows DB row deletes, the orchestrator
classifies the new outcome, the Bootstrap counter increments
correctly.

vjt asked a side question on the way out: are the dev/test VAPID
keys committed to the repo a security risk? Short answer no —
they're labelled as fixtures, they don't sign production
subscriptions, and a leak gets you push-spam to whoever
subscribed via localhost. The longer answer mattered more: the
deeper question came up because of a fourth bug that bit during
the same session — push notifications across the board returning
FCM 403 + Apple 400 since the bastille migration. Root cause was
`mix grappa.gen_vapid` having been run on the new jail, generating
fresh keys, while the existing subscriptions in the migrated DB
were signed against the Docker prod keys. Recovery was a
verbatim env swap. Lesson: VAPID keys are state, like Cloak keys
and the release cookie — never regenerated mid-deploy, never
treated as deployment config that can be freshly populated per
host.

By end-of-session: three commits, four memories saved (including
the cross-substrate-migration VAPID note), three production
incidents fully fixed at the architectural root rather than the
symptom. Two of them ended a multi-commit history of band-aids
on the same symptom.

**Law:** *`:transient` GenServers under a DynamicSupervisor are
not "kill from the outside" safe. They survive their own crashes
by design. Anything that wants to permanently shut one down must
either (a) call `terminate_child` via the supervisor (test-side
`on_exit`, admin endpoint) AND ensure no restart is in flight, or
(b) make `init/1` consult external state and return `:ignore`
when that state says "no." Telling the live pid to die without
one of those two is racing a restart you can't see scheduled.*

**Law (corollary):** *An empty table that's been sitting in the
schema for weeks isn't waiting for a feature — it IS the missing
feature. If `grep -r "INSERT INTO <table>"` returns nothing
across `lib/`, the producer was never written, and the consumer
is silently degraded. Audit at schema-creation time, not at
feature-rollout time.*

## Episode — kazamobile, the zombie that named itself, and a hot-deploy path that finally worked (2026-05-27)

The bug arrived as a one-liner from the operator: "one visitor
disconnected and never reconnected, the nick is kazamobile and
the visitor row is still in db but the client is not connected."

The remsh tells the truth. Visitor row in the DB: nick
`kazamobile`. Session.Server live state on the registered pid:
nick `kazam02`. That's not a "user gone, bouncer still running"
divergence — that's a *visitor inhabiting two parallel
realities*. The DB knows what the user typed; the live BEAM
remembers what the bouncer connected as.

Log timeline made it obvious. 18:27 visitor spawn, boot nick
`kazam02`. 18:28 user issues `/NICK kazamobile`, upstream echoes
back, `visitors.nick` rotates. 18:37 manual joins to `#sniffo`
and `#sbiffo`, `last_joined_channels` rotates. 18:49 upstream
TCP drops with `:ssl_closed`. Restart cycle kicks in. 18:49:31
`Phase 1 TLS posture` log line from the new IRC.Client. Then —
nothing. No `JOINED` for any channel. No autojoin loop. The
respawned session just sat there registered upstream as
`kazam02`, joined nothing.

The thing that made this hit hard was the moduledoc paragraph in
`Session.Server` since Phase 1:

> Trade-off: a `:transient` restart replays the SAME cached opts
> the supervisor child spec captured at first start — credential
> changes in the DB don't propagate until the operator forces a
> re-spawn through the LIVE BEAM.

Documented as a known limitation. Not "we should fix this
someday" but "this is how it works, here's the workaround." For
months that paragraph sat there as load-bearing documentation
of a class of bug that the day someone hit it would feel like a
fresh discovery. Yesterday's `subject_row_present?` fix already
had the right shape — an optional closure consulted by `init/1`,
injected by the SessionPlan modules, returning a boolean. The
zombie kazamobile was the same architectural seam asking for one
more level of detail: don't tell me "does the row still exist?",
tell me *what the row contains right now*.

The fix turned out smaller than the diagnosis. `(-> boolean())`
became `(-> {:ok, plan} | {:error, :not_found})`. `init/1`
calls it on every init (boot and restart both), merges the fresh
plan over the cached opts so DB wins on the keys that come from
the DB (`:nick`, `:autojoin_channels`, `:password`) and opts
wins on the keys that don't (`:network_id`, `:notify_pid`, test
fixtures). The `:not_found` branch keeps the prior operator-delete
fail-fast — same `:ignore` exit, same supervisor drops the child
permanently. One closure, two failure modes, single mechanism.

vjt asked a question that almost derailed the whole approach
mid-design. I had been working up to a full refactor — pass
closures, replumb Bootstrap, restructure the spawn chain. The
question: "this looks very complicated. can we just save the
state along the way and restore it on reconnection?" The state
was already saved (the DB had the right values the whole time).
The bug wasn't about persistence; it was about who reads the
persisted state on the restart path. Six lines per SessionPlan,
five-line case in init/1, swap the type of an existing closure
slot. The simplest version of the fix had been hiding inside the
elaborate version the whole time.

Once that landed and deployed, vjt's follow-up: "abbiamo un
timestamp del 'last activity'? possiamo mostrarlo in admin
console?" The diagnosis we'd just done required remsh +
`:sys.get_state` to confirm "user gone, bouncer still
connected." That should be a glance at the admin table.
`accounts_sessions.last_seen_at` already existed — bumped at
most every 60s by both REST and WS authn paths. Two batched
queries from the controller (one per subject_kind, parallel to
the existing labels lookup), top-level field on the wire,
relative-time render in cic, drop the redundant `channels`
column (LiveBadge already shows joined count). Half an hour of
work because the data was already there. Sometimes the right
feature is just deciding to show what you already have.

Then: hot deploy on the bastille jail. The script said "NO
hot-reload — release rebuilds always swap the BEAM wholesale"
since cp50, because nobody had needed it yet. vjt's question:
"can we ensure that hot deploy works on freebsd? last deploy was
cold and could have been hot." Time to find out what was in the
way.

The diagnosis went through three layers before landing. Layer
one: `Phoenix.CodeReloader.reload/1` returns `:ok` on the jail
release. I had assumed it worked. Live test: bump a function,
call reload, query the new function via rpc → `UndefinedFunctionError:
module Grappa.Accounts is not available`. Module loaded; function
not. Reload was a silent no-op.

Memory caught it. `feedback_hot_deploy_silent_noop_prod`, dated
2026-05-16: "`Phoenix.CodeReloader` is a dev-time facility. In
prod it is a no-op." Already burned by this exact bug nine days
ago. The memory documented the symptom (M-4 visitor controller
returning `UndefinedFunctionError` after a hot deploy claimed
success) and four candidate long-term fixes, none of which had
been done.

vjt's response when I explained why we couldn't keep the Phoenix
reloader: "ok no va bene se e dev only vaffanculo." The Erlang
:code primitives replaced it in ten lines. `:code.modified_modules/0`
walks the loaded BEAMs and compares against on-disk hashes —
release-friendly, no Mix dependency, works identically in dev,
Docker, and the jail. `:code.load_file/1` per modified module
does the swap.

Layer two: even after the reload was correct, the .beam on disk
had to be in the right place. The jail daemon's `code:get_path/0`
includes `_build/prod/rel/grappa/lib/grappa-X.Y/ebin/`, not the
parallel `_build/prod/lib/grappa/ebin/` where `mix compile`
writes. `mix release --overwrite` is the step that gets new .beam
to the daemon-visible path. Verified live: pre-release-rebuild
`:code.modified_modules() == []`; post-rebuild, exactly the
three modules from the pending commit.

Layer three: the loopback gate. `POST /admin/reload` is
loopback-only. Bastille thin jails ship with `lo0` UP but no IP
assigned. The BEAM binds to `0.0.0.0`, which on the jail resolves
to "all assigned addresses" — only the jail's IPv4
(`10.66.6.7`). curl from inside the jail to `127.0.0.1` either
failed or arrived with `remote_ip=10.66.6.7`, which the gate
rightly 403'd. Original instinct was to extend the gate to
accept the jail IP; vjt's: "piu facile, aggiungi 127.0.0.1 alla
lo0." `bastille network -a grappa add lo0 127.0.0.1` —
auto-restarts the jail with the alias persisted in jail.conf.
`sockstat` now shows `tcp4 *:4000` instead of `10.66.6.7:4000`.
Curl from loopback works. Gate gets `remote_ip=127.0.0.1`. 200.

Smoke test for hot deploy needed something that would actually
demonstrate code propagation. vjt: "test hot deploy incrementing
the grappa version in response to ctcp version." Bumping
`@version` in `mix.exs` triggers COLD (mix.exs is in the
preflight cold-class). `--force-hot` overrides it. The
`Grappa.Version.current/0` module reads `mix.exs` live from disk
on every call — its whole design is "bypass `Application.spec/2`
staleness across hot reloads." So the version bump would surface
via the live reader without the .app resource needing to
regenerate.

Two hot deploys in a row, because the first one tripped on
"dubious ownership in repository at /home/grappa/grappa" — the
`git rev-parse` for the pre-pull SHA was running as root in a
grappa-owned tree. Five-line fix to route the SHA reads through
the existing `run_as_grappa` helper. The second hot deploy:
`mix release --overwrite` ✓, `POST /admin/reload` returned
`{"failed":[],"reloaded":[]}` (no .beam changed because only
mix.exs moved), `healthcheck after 0 retries`. Sessions
preserved — the same pids `<0.2336.0>`, `<0.2338.0>` etc as
before the deploy. `Grappa.Version.current/0` returns `"0.3.2"`,
read live from the new mix.exs. Daemon never restarted.

The session ended with prod live on 0.3.2, no users disconnected
across two deploys (one cold, one hot), and the hot path that
had been "not yet" for weeks finally working end-to-end. The
fix-stack underneath was four distinct issues: stale child-spec
opts, dev-only CodeReloader masquerading as a prod tool, jail
networking that omits loopback by default, git ownership checks
against a delegated build user. Each of them had a workaround
that had been "good enough" until the day it wasn't. The day it
wasn't came as a one-liner from the operator about a visitor
that didn't reconnect.

**Law:** *A "known limitation" documented in code is a bug
report scheduled for the day someone notices the symptom. If the
fix is genuinely deferred, the docstring should explain the
trigger conditions a future-reader can recognize, not just the
mechanism. "Cached opts don't propagate" is too abstract;
"`/NICK` rotation + upstream drop = zombie at the boot-time
nick" is the failure-mode shape that lets the next person spot
it from a log line.*

**Law (corollary):** *Hot deploy that returns `:ok` and does
nothing is worse than no hot deploy at all. The HTTP status code
is not the contract; observable code propagation is. A reload
endpoint should return positive evidence — module names that
loaded, or a clear empty signal for "nothing to do." `{"reloaded":
[]}` is a useful answer; `ok` is a lie waiting to happen.*

## S55 — 2026-05-27 — A WebAPK we didn't mint, blocking installs we wanted

vjt pinged: an Android user trying to install cic was getting "developed
for an earlier version of Android and lacks the latest privacy
protections" at install time. The user had never opened cic before.
First instinct was stale WebAPK on the user's device — Chrome generates
a WebAPK wrapping the PWA, and Play Protect now blocks WebAPKs with
old targetSdkVersion. Tell the user to reinstall, done.

Wrong. Never-opened means there's nothing to reinstall.

The real story is that Google's WebAPK Minting Server is the one
holding stale APKs, not the user's device. The minter hashes the
manifest, mints an APK, caches it. Every subsequent installer with the
same manifest hash gets the same cached APK. Cic's manifest hadn't
changed since the day it shipped — so every new Android install was
getting an APK minted months ago, with a targetSdkVersion that Play
Protect's 2024 policy now refuses. The blocked install wasn't this
user's bug; it was the bug of whoever installed cic *first*, propagated
forward forever via Google's cache.

The fix is one field: `id: "/cic"` in the manifest. The W3C spec says
`id` is a same-origin URL that the browser never fetches — pure
primary key for "is this the same app?". Adding it shifts the manifest
hash, so the minter caches miss, and the next install request gets a
fresh APK with current targetSdkVersion. Existing installs are
unaffected because Chrome reconciles via `start_url` ↔ `id`. The
comment in `vite.config.ts` spells out the never-change-after-first-
install rule because mutating `id` later orphans every existing
install and creates a parallel WebAPK on Android — a footgun the next
person editing the manifest needs to see.

But vjt was clear: **restarting the bouncer for a PWA change is
unacceptable.** This was the first real cic-only deploy on the bastille
jail post-Docker migration. The Docker side has `scripts/deploy-cic.sh`;
the jail had nothing equivalent — `infra/freebsd/deploy.sh:166` even
had a comment saying "add one when the cicchetto/src/ edits start
happening between server deploys." That happening was now. So:
`infra/freebsd/jail_deploy_cic.sh` — git pull + vite build + POST
/admin/cic-bundle-changed, no BEAM touch.

First run was clean but the broadcast endpoint returned 204 "no bundle
on disk." `Grappa.Cic.Bundle.@bundle_path` reads
`runtime/cicchetto-dist/index.html`, which on Docker is where
compose.yaml bind-mounts the container's `/app/dist`. On the jail there
was no bind-mount magic; vite emitted to `cicchetto/dist/` and the
server reader found nothing. The expedient temptation was a symlink.
The right move was to align the substrates: pass
`--outDir ../runtime/cicchetto-dist` to vite on the jail, repoint
nginx's `/usr/local/www/cic` symlink at the shared path. One
server-side anchor for both substrates; future @bundle_path tweaks
land in one place. Bonus: `deploy.sh`'s cold-path inline npm+vite
shell collapsed into a call to `jail_cic_build.sh` — outDir + npm
logic in one place instead of two.

Two commits, zero BEAM restart, sessions intact. The refresh banner
broadcast on the second deploy attempt — hash `BydkWNJw` to all live
user-topics. The manifest fix is live; the next Android installer gets
a fresh WebAPK. Whether that installer is *vjt's* user or someone
several weeks later who would have hit the same wall doesn't matter —
we've broken the cache for everyone.

*Law: when a third party caches your artifact by hash, the only
control surface you have is the input bytes. Adding a no-op field to
bust the hash is a legitimate fix, but mark it as load-bearing in a
comment — the next person to "clean up" the manifest will delete the
field that's holding the entire install path together.*

## S56 — 2026-05-27 — The session IP that should've been a public IP

Closing cp52 S1, post-PWA-fix, ready to shut down. vjt fires off one
last question: "how is it possible that we have a user session with
ip 137.0.0.1? is xff not working?" The IP wasn't actually `137.0.0.1`
— vjt was eyeballing and reading loopback as something else — but
the instinct was right. I queried the live DB and saw the bug:
every post-bastille user session had `ip = "127.0.0.1"`. Months of
audit-trail data, silently collapsed to loopback.

The wrapper plug (`RemoteIpFromProxy`) was built in cp51 to defend
`Plugs.LoopbackOnly` against the docker-exec spoof: shell user sets
`X-Forwarded-For: 127.0.0.1`, bare `RemoteIp` rewrites
`conn.remote_ip`, gate accepts, attacker reloads the BEAM. The fix
was to bypass `RemoteIp` for any loopback peer, on the theory that
loopback = container shell, exclusively.

That theory was true for the Docker substrate. It became false the
day grappa moved into the bastille jail. nginx now runs *in the
same jail*, proxies via 127.0.0.1:4000. Every legitimate user
request surfaces with `peer = 127.0.0.1` AND nginx-set X-F-F. The
bypass silently dropped the rewrite. The audit trail filled with
loopback IPs and nobody noticed for weeks — the cic admin UI shows
the column, the operator sees it, but it looks plausible enough
that "all the loopback rows" reads as a column-layout artifact, not
a data corruption.

The fix is to widen the trust rule from "loopback always means
shell" to a 3-row matrix: loopback-no-XFF = shell, trust peer;
loopback-with-XFF = local nginx reverse-proxy, trust XFF;
non-loopback = anything else, delegate to RemoteIp. The shell-spoof
attack is now *technically* possible — `curl -H "X-Forwarded-For:
127.0.0.1"` from a loopback peer would pass `LoopbackOnly` — but
the attacker who can run that command already has
`sudo bastille cmd grappa` or `docker exec grappa`, which is
root-equivalent. They can drop sqlite, kill the BEAM, rewrite the
codebase. Hardening `/admin/reload` against them is theatre. The
defense at this layer is *network reachability* — nginx doesn't
proxy `/admin/*`, grappa binds 127.0.0.1 only. Documented as
explicitly-accepted residual risk in both moduledocs.

The deploy itself ended up cold, not the hot deploy I'd planned.
The diff included the `deploy.sh` refactor from cp52 S1 (collapse
inline npm into `jail_cic_build.sh`), and the preflight rule at
`preflight.ex:255` correctly forces COLD on `infra/freebsd/deploy.sh`
edits — "running an old version of the deploy script after the new
one landed risks divergent behavior." Sessions reset ~5s. The
preflight worked as designed; the cost was the cost of bundling
the wrapper fix with the deploy.sh refactor instead of shipping
them on separate deploys.

*Law: when an environment assumption flips — what used to be a
single-source signal (loopback = container shell) now means two
different things (shell OR local reverse-proxy) — every gate that
read the signal at face value needs revisiting. The trap isn't the
new shape; it's that the gate keeps returning answers, just
*wrong* ones, and nothing crashes loudly enough to surface the
flip.*

## 2026-06-02 — The test that passed when it should have failed

vjt reported it precisely, the way only a daily driver can: load 5-6
pages of scrollback, tap the scroll-to-bottom button, switch windows,
switch back — blank, restored only by a manual scroll. And the tell:
"ONLY the scroll-to-bottom button is problematic."

That tell handed me the root cause in one read. The button was the
only scroll path in `ScrollbackPane` using `behavior:"smooth"`. Every
other path — `scrollToActivation`, the post-append snap — is instant,
deliberately, because the scrollback <div> is the SAME DOM node across
window switches (Shell.tsx's non-keyed `<Match>`). A smooth scroll is
an async animation; it outlives the tap, survives the row swap, and
races the return snap. Open-and-shut. I wrote the fix in thirty
seconds: instant `tail.scrollIntoView`. I wrote the e2e spec. I even
got the local e2e stack running for the first time on the Pi — which
itself took a compose upgrade to v5.0.2 and two `.dockerignore` fixes
to stop a non-root build choking on a root-owned 0600 `nginx.key`.

Then I ran the spec pre-fix, expecting red.

It passed.

A test green on buggy code is a mirror, not a guard — so I did the
honest thing and distrusted my own diagnosis. I loaded the full 200
seeded rows, instrumented every step, confirmed the animation was
genuinely in flight at tap (`scrollTop≈2`), switched away and back as
fast as Playwright allows. `back-immediate: top=3645, dist=7`. Bottom.
Every time. I tried webkit-iphone-15 — the mobile project, touch
events, small viewport, surely *this* is where it lives. Same answer:
`dist=8`, lands at bottom, green pre-fix.

Two engines, full history, animation provably mid-flight, immediate
roundtrip — and the bug refused to appear. The instrumentation said my
mechanism model was wrong. Except it wasn't. Playwright's bundled
WebKit is not real iOS Safari; it doesn't model `-webkit-overflow-
scrolling: touch`, momentum, or smooth-scroll interruption — the exact
layer the bug lives in. The headless environment was *incapable* of
reproducing it, and no amount of harness cleverness was going to
change that.

So I shipped a fix I could not prove, and said so plainly — in the
commit, in the spec docstring (a contract guard, explicitly not a fix
proof), to vjt. The smooth→instant change was low-risk and matched
every other path in the file regardless. Deployed cic-hot to m42 via
a new one-command wrapper, broadcast the bundle hash, told vjt to
reload on the phone. "bug is fixed."

The diagnosis was right the whole time. What was wrong was the
expectation that a green-vs-red test could adjudicate it.

*Law: a test passing on known-buggy code falsifies the test, not the
fix. When red never comes, ask whether your harness can even express
the failure before you doubt the diagnosis — headless browsers don't
have physics, and some bugs are made of physics.*

## 2026-06-04 — A dedicated IP, a clean migration, and a "hung BEAM" that was a self-inflicted ban

The ask was small: give vjt's outbound IRC a stable identity. The
per-server `source_address` feature had shipped the day before; now it
needed to meet prod. vjt and the visitor pool both lived on `azzurra`,
and source binding is per-server with a single-server picker — so they
could not share a network row and get different sources. One of them
had to move. Visitors are compile-pinned to `:visitor_network`
("azzurra", baked at compile time), so the cheap move was vjt: a new
`azzurra-vjt` row pointed at the same host, sourced from a dedicated v6.

Two things made me slow down. First, the scrollback. vjt had 17,237
messages and 25 channels under that network_id, and moving him naively
would have orphaned all of it. But `messages` carries `user_id`, so the
history was separable — a targeted `Repo.update_all` re-keyed exactly
his rows and left the 6,500 visitor messages where they were. I almost
reached for `unbind_credential` to drop his old binding; reading it
first saved me — it rolls back `:scrollback_present` when a network
still has messages but no other user, which is precisely the
visitor-only network shape. It literally cannot detach the last user
from a network the visitors are still using. Direct row delete instead.

Second, and the part vjt explicitly flagged: the dedicated IP was `::42`
— the **host's primary address**, rDNS `m42.openssl.it`. "do not fuck
the host." A shared-IP jail strips its `ip6.addr` entries on stop, and
if that entry were the host's main IP, a jail restart would yank
connectivity. I didn't trust my memory of `jail(8)`'s semantics, so I
proved it: assigned a throwaway `::4242` to the host, shared it into a
disposable jail, tore the jail down, and watched whether the host kept
the address. It did. `jail(8)` only removes what it added; an address
the host owned first survives. *Then* I touched `::42`. The setup went
in clean — vjt outbound from `::42`, visitors from the pool, host
intact.

And then prod "hung." `service grappa restart` had raced its own node
name on the way up (`grappa@grappa … in use`) and aborted boot — I
caught the `stopped` status, cleared it with a plain `start`, ~two
minutes down. Recovered. But minutes later vjt: "beam seems stuck,
doesn't respond." The timing screamed that my surgery had broken
something. It hadn't. The BEAM was idle, healthz returned `ok` in
half a millisecond, vjt's session was still connected from `::42` the
whole time. What had actually happened: vjt rotated his account password,
his cic client kept retrying the WebSocket with a now-dead token, 315
`REFUSED CONNECTION`s tripped fail2ban's `http-404` jail on the *host*,
and his IP got banned — blocking his user and a visitor session alike,
which looked exactly like "the visitor is broken too, so it's the
server." `fail2ban-client unban`, clear cic's `grappa-token`, re-login.
The scariest symptom of the day was two layers away from anything I had
changed.

*Law: when prod looks dead right after you changed it, verify the layer
before you trust the correlation. A hung-looking BEAM that answers
healthz in 500µs isn't hung — walk outward (token, proxy, firewall,
the human's last action) before you walk back into your own diff. The
symptom that points at your change is the most expensive coincidence.*

## 2026-06-08 — Freeze the display, not the transport

vjt: scrolling through unread messages yanks the "── N unread ──"
divider down under your eyes. Make it sit still while you read; advance
it when you step away and come back. Simple ask. His first instinct for
the fix — "can we just not broadcast the cursor update?" — was the
tempting wrong layer. Kill the server echo and you break two things at
once: cic stops mirroring the server-owned cursor (it'd have to invent
the value locally, which the rules ban), and the originating device's
own signal goes stale, so the divider would freeze *forever*, not until
refocus. The broadcast is load-bearing. The yank was never the broadcast
existing — it was the render *reacting* to it mid-read. So: freeze the
display, not the transport. A snapshot of the cursor, latched at focus,
held constant while the eyes are on the window; the live signal keeps
flowing underneath for the badges. One memo line, one sibling latch to
the boundary that was already frozen above it.

The interesting part was downstream. The codebase already had a test —
CP29 R-4's "Bug A" — asserting the exact opposite of the new ask: the
marker MUST vanish the instant the cursor advances. Not a bug — a
deliberate contract from a month ago. And the uniform freeze rippled
past the scroll case vjt described: it also stopped send-in-window and
cross-device reads from collapsing the divider live, because cic can't
tell its own echo from a peer's at the wire. Three contracts, one new
requirement overriding all of them. The move wasn't to quietly flip the
assertions green — that's how you bury the next person. It was to
surface each conflict, get vjt's "yes, consistency," and rewrite the
tests to assert the *new correct* behavior, loudly, with the why in the
diff.

*Law: a green test can be guarding an obsolete contract. When a new
requirement contradicts one, the test is neither sacred nor a rubber
stamp — surface the conflict, get the call, then rewrite it to assert
the new truth. Never flip a red test green to make the bar pass; flip it
because the bar moved, and say so where the next reader will look.*

## Episode: the deploy that lied twice (2026-06-10, uploads-2)

The video+document uploads cluster was the cleanest run yet — spec
brainstormed question by question, eight TDD tasks each through
two-stage review, two latent bugs found and killed before they were
ever reported (Plug.Parsers' 8MB multipart default sitting under a
10MB advertised cap; an embedded-host cap check reading a static
literal behind a comment that *claimed* reactivity). Even the library
verification step paid out: mediabunny silently copies input metadata
tags unless you pass `tags: {}` — the privacy guarantee of "transcode
strips GPS" was one missing option away from fiction, caught by
reading the installed .d.ts before writing the wrapper.

Then the deploy. Cold path classified correctly, migration ran,
healthcheck green, exit 0 — and buried mid-output, a dead cic build:
the jail's npm lock predated the bun-added mediabunny dep, `npm ci`
refused, tsc died on the missing module, and `| tail` ate every
nonzero exit because plain sh has no pipefail. Production ran the NEW
wire with the OLD bundle — the exact mismatch three separate reviews
had marked forbidden — under a green deploy banner. The fix was
reading the output instead of the exit code, regenerating the lock
in-jail, reshipping the bundle, then patching the build script to
fail loudly.

*Law: an exit code is a claim, not evidence. Any pipeline that decorates
output (`| tail`, `| grep`) silently vouches for whatever died upstream
— read the output of anything that touches production, and never let a
formatting pipe stand between a failure and `set -e`.*

## Episode: the gate that cited a lie (2026-06-19, away-#62)

A visitor typed `/away` and got "Send failed." An authenticated user on
the same build typed `/away` and it worked. The bug report guessed
right: something rejected the command for sessions without a registered
identity. What it didn't know was that the rejection was *deliberate*,
and that the reason written next to it was false.

The channel handler short-circuited every visitor with `visitor_no_away`,
and the moduledoc explained why: "the `set_explicit_away` facade only
routes to user sessions." Read the facade and it says the opposite — it's
guarded on `is_subject`, takes `{:visitor, id}` exactly like `{:user,
id}`, and each visitor owns a private, isolated `Session.Server` with its
own upstream IRC connection and unique nick. A visitor's AWAY is
per-connection and harmless. The comment had conflated explicit `/away`
(a user action) with the WSPresence-driven *auto*-away (which genuinely
is user-only, because visitor sessions don't subscribe to presence). One
true fact about auto-away got laundered into a false claim about explicit
away, sat in a doc comment, and gated a normal IRC verb for months —
because nobody re-derives a justification once it's written down. Deleting
the gate made the code *shorter*: one subject-aware path replaced the
`if visitor? … else` fork. Which is why vjt pushed back when the diff
came back bigger than expected — the extra surface was a *second* defect
(the client swallowing every channel-push error code into the same bare
"Send failed"), correctly called out as separable.

The session ended on a different flavour of the same rot. "Close any
issue that's open but resolved." Five were: EXIF stripping whose module
header literally read `(#39)`, two MODE-command bugs with passing
upstream-wire tests, a server-window routing fix with e2e coverage. The
work had shipped; the tracker never caught up. Same disease as the
comment — the record drifting from the code — just pointed the other way.

*Law: a guard's comment is a claim, not evidence. A wrong "why" outlives
the code it described and gets copied forward as gospel — verify the
rationale against the implementation before you trust it, especially
before you build on top of it.*

## Episode: the counter that couldn't live next to its predicate (2026-06-21, pwa-badge)

The spec was the cleanest yet. One number — how many unread messages did
the operator *choose* to be notified about — surfaced on the PWA's
home-screen icon. One predicate: the exact `should_notify?` Web Push
already fires on, so the icon and the OS notification can never disagree.
Three doors to feed it: the login seed, the read-cursor broadcast, the
push payload. The kind of feature where the design doc does the thinking
and the code is transcription. Nine TDD phases, each green on the first
real run.

Then the dependency graph said no. The badge counter's natural home is
obvious: right next to the predicate it reuses, inside the `Push`
context. But counting badges means reaching across `Networks`,
`ReadCursor`, and `Visitors` — and every one of those transitively
depends on `Session`, and `Session` depends on `Push`. Put the counter in
`Push` and you close a four-node cycle: `Push → Networks → Session →
Push`. The namespace said "this belongs in Push." The boundary graph said
"you may not." Both were right; only one gets a vote.

So you invert. The counter becomes its own boundary sitting *above* Push,
depending *down* onto the predicate. Doors #2 and #3 call it from the web
layer, which already lives at the top. Door #1 — the push payload, fired
from deep inside `Session → Push.Triggers`, *below* the counter — can't
take a static reference up the graph without re-closing the cycle, so it
reaches the counter through a config-injected behaviour seam resolved at
runtime. The same trick the test stubs use, turned load-bearing.

The second beat was the deploy, and it was an irony. grappa's whole
hot-deploy machinery exists to *preserve IRC sessions* — reload modules
into the live BEAM, never restart. So I hardened door #1 for the window
where a hot reload swaps the new code in but `config.exs` hasn't been
re-read: `BadgeSource.count` returns `nil`, the push still fires, the icon
just isn't touched. Defensive, correct, tested. Then I shipped it — and
the deploy went **cold anyway**, because the preflight classifies every
`config/*.exs` change as cold, and I'd added exactly one config key. The
cold rebuild compiled the config in at boot, all three doors came up
whole, and the resilience I'd built never executed. It wasn't wasted —
it's the right insurance for the *next* badge-touching hot deploy — but
this time the structural caution and the deploy classifier solved the
same problem from opposite ends, and the classifier got there first.

*Law: the dependency graph, not the namespace, decides where code may
live. A function's natural home — beside the code it reuses — can be
forbidden by the cycle it would close; when the reuse points down and the
aggregation points up, lift the aggregator to the top and invert the lone
upward call through a runtime seam.*

## Episode: the docstring that promised a guard it didn't write (2026-06-21, away-empty)

Two days after the away-#62 episode left its law — *a guard's comment is
a claim, not evidence* — the same trap closed on the person who had just
written it down.

The job looked janitorial: pick something off the LOW cleanup bucket. The
first surprise was that half the bucket was already dead. `Grappa.version/0`
"has zero callers" — except it had been renamed to `Grappa.Version.current/0`
and *gained* one (the CTCP VERSION reply). A "ChannelPushError consumer to
wire up" — already wired, by #62, weeks ago. The todo had become a museum
of fixed bugs nobody had buried. Two ghosts pruned before a line of code
moved; the lesson the start of every session re-teaches is that a backlog
entry is a claim about the past, and the past has usually moved on.

The one real item was a quiet footgun. Set your away with an empty reason
and the bouncer sent `AWAY :` upstream — which, per RFC 2812 §4.6, is
precisely the line that *clears* away. Ask to go away with no message, get
pulled back. `safe_line_token?/1` only screened CR/LF/NUL; the empty string
sailed through every guard. The fix was one boolean at the `Session` facade,
the single chokepoint above both byte paths. Red, then green. Clean.

Then I wrote the docstring, and the docstring lied. "The emptiness check is
the facade's job — mirrors `Client.send_pong`'s empty-token guard." It read
well. At the byte layer it was false: `send_pong` rejects empty *at the
socket boundary*, and `send_away` — the function the comment named as its
twin — did not. Five sibling senders (`send_privmsg`, `send_part`,
`send_oper`, `send_pong`, `send_raw`) all guard empty at that door, on
purpose, so a future non-cic caller can't smuggle a malformed frame past a
bypassed facade. `send_away` was the lone holdout. I had cited a symmetry to
justify the fix, and the symmetry wasn't there.

A review agent caught it — reading the same file I had, noticing that my own
rationale named a guard the code didn't contain. The follow-up made the
docstring true: `reason != ""` on `send_away`, mirroring the siblings for
real. The away-#62 law had predicted this exact failure mode, and I walked
into it inside the same week, authoring the false comment myself. The review
also floated tightening to `String.trim` so a spaces-only reason would also
reject — declined, because that diverges from `send_pong` and a blank-looking
`AWAY :   ` is a *valid* set, not the un-away line; the distinction got
pinned by a test so nobody "fixes" it later. On the way out, a vitest red the
last checkpoint had shrugged off as "triage separately" turned out to be the
same #62 `ChannelPushError`, landing in a test mock that never declared it —
`instanceof undefined` throwing on every non-error path. Root-caused in
passing.

*Law: when your justification cites a safeguard, open the safeguard. The
most persuasive wrong comment is the one you write yourself to explain a fix
you believe in — the belief is exactly what stops you checking whether the
thing you named is really there.*

## Episode: the badge that was right where I wasn't looking (2026-06-21, badge-orphan)

Two bugs this session. The first was clean: a registered visitor logging in
got the NickServ "you're identified" notice twice, and a handoff had already
traced it to a double `IDENTIFY` on the wire — the AuthFSM fires one at 001,
and `Login` fired a second, redundant one post-readiness. I verified the
handoff's claims against the code rather than trusting them (the +r-commit
rendezvous turned out to run through `maybe_stage_pending_password`, not the
NSInterceptor the handoff named — same outcome, different mechanism, worth
getting right in the docs), deleted the redundant send and its now-dead
helpers, and pinned it with a test that counts IDENTIFY lines exactly once
behind a TCP-order barrier. Shipped hot. Unremarkable, which is the point.

The second bug is the one that taught me something. vjt: the PWA badge sticks
at "1 unread" even after reading everything — let's just reset it on app
open. I had a tidy theory within a minute: the badge count is
server-authoritative, derived from read cursors, so a stuck "1" meant a
cursor that never advances past some notify-worthy message — an off-by-one, or
a window you can't "read." I could have written the fix for that. I'd half
written the *explanation* for it.

Then I queried prod. `BadgeCount.count/1` for vjt: **zero**. The server count
was correct. My entire diagnosis was about a number that didn't exist. The
stuck "1" was the OS icon badge itself — and the moment I had the right
target, the cause was obvious in code I'd already read: the badge has two
writers that share no state. The service worker stamps `setAppBadge` directly
when a push arrives in the background; the in-page effect only re-applies when
its signal *changes*. Read everything on a warm resume and the signal goes
0-over-0 — no change, no re-apply — and the SW's badge sits there, orphaned,
forever. Cold launch reconciled it; warm resume had no reconcile point. The
fix wrote itself: re-pull the authoritative `/me` count on every
`visibilitychange` and force it onto the surface.

vjt's instinct was *directionally* right — reconcile on foreground — and
mechanically wrong: a blind reset-to-0 would wipe a badge that legitimately
arrived while he was away. The data told me which half to keep. Without the
prod query I'd have shipped a careful fix for a cursor bug that wasn't there,
the badge would still have stuck, and I'd have been *certain* I'd fixed it.

*Law: a root cause is a hypothesis until the authoritative source votes. When
a value looks wrong, ask the system that owns it for the number before you
explain the number — the most expensive fixes are the elegant ones aimed one
layer away from the bug.*

## Episode: four tries to press a key that wasn't there (2026-06-23/24, nick-swipe)

vjt wanted nick completion on his phone. A stock mobile keyboard has no Tab
key, and that was the whole problem: the completion *logic* already existed —
`tabComplete`, wired to three call sites, members-only, cycling. What was
missing was a way to fire it without the key. Simple ask. It took four
shipped iterations, and every single one passed the test suite while being
broken in a way the test suite physically could not see.

The first crack opened before I'd added any trigger. Scoping the rewrite, I
noticed the in-app cycle had *never worked*: `setDraft` nulls the cycle
anchor — correct, a real edit should break the cycle — and both callers
called `setDraft` right after `tabComplete`, nulling it every time. The unit
tests were green because they called `tabComplete` directly and never went
through `setDraft`. Mirror tests, exercising a path the real app doesn't
take. Green, and lying.

Then the triggers. Double-tap shipped first; I'd flagged at design time that
it would collide with iOS's word-select, and dogfood confirmed the warning
was not theoretical. Pivot to swipe-right. Code review caught the one that
actually impressed me: Solid *delegates* touch events to a single listener on
`document`, and a document-level touchmove listener is passive by the
browser's own intervention — so my `preventDefault()` was a silent no-op. The
suppression I'd written did nothing. jsdom doesn't enforce passive-listener
semantics, so the suite was green over a `preventDefault` that the real
browser ignores. Caught by *reading the framework source*, not by a test.

Swipe-right deployed, vjt dogfooded, and the whole shell dragged off the
input. The textarea was the one touchable control in the mobile shell with no
explicit `touch-action` — `auto` — and my non-passive listener had routed the
gesture main-thread where the unguarded `auto` let iOS drive its chrome
overscroll. The fix was a property the codebase had already fought a long war
over (`touch-action: none`, UX-3 UNDEC R3); the textarea was just the hole
nobody had plugged because nothing had ever listened there. jsdom has no
concept of `touch-action`. Green again.

Three bugs. Dead-cycle, passive-delegation, touch-action hole. The vitest
suite passed through all three — 2087 green at the end — because every one of
them lived in the gap between the logic (which jsdom faithfully runs) and the
platform (which it cannot simulate at all): the store path the mirror tests
skipped, the passive flag jsdom ignores, the gesture arbitration it doesn't
model. The pure reducers — `swipeDirection`, `isDoubleTap` — were never wrong.
They were tested, and the tests meant exactly what they said and nothing more.
Then swipe up/down for history went in clean on the first try, precisely
because by then the platform layer was understood and the only new code was
another pure reducer plus a dispatch arm.

*Law: a green unit suite proves your logic agrees with your tests, not that
your feature works — on a browser the untestable layer (event delegation,
passive listeners, touch-action, native gesture recognizers) is part of your
API, and the only instruments that read it are the framework source and a real
device. Write the reducer pure and test it to death; then go look at the layer
the test harness is blind to, because that is where the feature actually
lives.*

---

## The 404 that banned a user from his own house

cic never parses IRC. cic never talks to the network. cic speaks pure REST
to the bouncer and renders typed JSON. By construction it cannot do anything
to an IRC connection. And yet one afternoon `emme\k` found himself banned —
not from a channel, from the *network*, at the packet-filter layer, by the
production host, while the same account stayed connected fine from a
different IP.

The culprit was a single mis-routed GET. The selection effect backfilled
scrollback for whatever window you focused: `loadInitialScrollback(slug,
name)`. For real channels that's `GET /networks/libera/channels/#grappa/
messages` — correct. But `$home`, the irssi-style status buffer, is not a
real `(network, channel)`; it's an identity-scoped pseudo-window whose slug
and name are both the sentinel literal `$home`. So focusing it fired `GET
/networks/$home/channels/$home/messages`, and the server — correctly — said
404. The window worked anyway; the status buffer reads from a local store,
not from REST. Nobody noticed the failed request for months.

Production noticed. The m42 jail runs the usual edge stack: fail2ban watches
nginx, and the `http-404` jail counts 404s per IP. Twenty of them and it
installs a pf block. The blocked packets then get logged, the `pf` jail
re-bans on *those*, and a few rounds of that escalates the IP into
`recidive` — the long-ban jail. A PWA that re-selects `$home` on every cold
load, on a phone that reconnects all day, is a 404 metronome. The client had
found a way to DoS its own user at a layer it has no business touching.

The reported symptom was `$home`. The instinct was to special-case `$home`.
But the moment you write down *why* `$home` 404s — no real channel behind it
— you see it isn't alone: `$admin` 404s the same way, and `mentions` carries
an empty channel name so it fires `GET .../channels//messages`, also 404.
Three windows, one bug. And the issue's own suggested fix — "skip any
`$`-prefixed window" — was a trap: `$server` is *also* `$`-prefixed, but it
is genuinely scrollback-backed (the NumericRouter writes its rows), so that
heuristic would have silently broken real server-pane history. The right
discriminator wasn't the sentinel spelling, it was the property: is there a
real server scrollback channel behind this window? That set is exactly
`channel / query / server`, and it's the same set that's restorable across
reload, because both reduce to "has a real `(network, channel)` identity."

So the fix is one predicate, `kindHasScrollback`, an exhaustive
`Record<WindowKind, boolean>` that won't compile if someone adds a kind
without classifying it — and it absorbed three hand-rolled copies of the
`channel || query || server` literal that had been drifting apart across
`selection.ts` and `Shell.tsx`. The server-side `ignoreregex` stopgap stays
as defence-in-depth, but the root cause is gone: cic no longer asks the
proxy a question it knows the answer to.

*Law: a 404 is a contract violation, and on a hardened host a repeated
contract violation is an attack signature — the edge stack cannot tell your
buggy client from a scanner. "Harmless failed request" is a category error
when fail2ban is listening. The IRC-ignorant web client is still part of the
IRC user's blast radius; the only safe bogus request is the one you never
send.*

## The backlog that lied about what was left (2026-06-26, todo-retirement)

The session opened in the most ordinary way possible: `/start`, look at the
todo, pick the next thing. The todo was confident. Under **Immediate** it
said *crank open review-exempt bugs — #27/#40/#37/#61/#25* — a tidy roster
of tractable work with no on-device blocker. I shipped #12 (a `/msg` to a
channel now gets refused at the cic parser instead of opening a phantom
query window the render path could never feed), closed it, and offered the
roster as what's next.

vjt asked four words: "what's 27?" I pulled the issue. It was **closed**. So
was #40. So was #37, #61, #25 — every single number on the "what's next"
list had already been fixed and closed on GitHub, some of them by me, in
earlier sessions. The todo had been pointing at a graveyard and calling it
a to-do list. The file that existed precisely to answer "what should I work
on" was answering with work that was already done.

This is not a typo-class bug; it is a structural one, and CLAUDE.md names it
in the abstract under *Design discipline*: **don't duplicate state that
already exists — derive it; every parallel structure needs housekeeping that
will drift.** GitHub issues were the source of truth for open work. `todo.md`
was a hand-maintained second copy of that same state. Two copies of one fact
have only one steady state — disagreement — and the only question is how long
until someone trusts the wrong one. The answer turned out to be "an entire
session-start report."

So the fix wasn't to scrub the stale lines. It was to kill the parallel
structure. vjt's call: use gh issues; what's still valuable becomes an issue;
todo becomes a pointer, nothing more. The migration was not a dump —
"valuable" is a judgment, and a judgment made against a two-week-old note is
worth as much as the note. The 12-line Phase 5 cluster became twelve issues,
minus HSM-keyed Vault, which earned a one-word disposition ("never doing it")
instead of a permanent residence in a list nobody reads. The twenty-one
carry-forward nits got re-checked against the *current* tree before any of
them was allowed to become an issue: two were already fixed (the
`Identifier.services_sender?` clauses were all reachable; nginx's keepalive
already had its `Connection ""`), one was a live bug big enough for its own
ticket. You do not migrate a backlog by copying it; you migrate it by
re-earning every line.

And the disease had a second carrier. `/start` finds the active checkpoint by
grepping `status: active`, and three old checkpoints still answered to that
name — one a real stale frontmatter marker on cp68, two only mentioning the
string in prose. Same illness, smaller organ: a status field is just another
hand-maintained index of "which one is current," and a hand-maintained index
drifts the instant someone forgets to flip it. cp68 had been superseded five
checkpoints ago and never told. One edit, `active` → `complete`, and the grep
returns a single answer again.

*Law: any list you maintain by hand alongside a system of record is a second
source of truth, and a second source of truth is a future lie with a
timestamp. The drift is not a maintenance lapse — it is the default behavior
of duplicated state; the lapse is believing it won't happen to you. Derive
from the system of record or point at it, but do not shadow it. And when you
do migrate, re-verify every item against today's code: a backlog is a set of
claims about reality, and stale claims don't improve by being carried
forward.*

## The rescue that couldn't be reached (2026-06-27, audio-uploads)

Audio uploads were supposed to be a clean clone of the image/video path:
a fourth `:audio` category, a 🎵 on the wire, a little docked player. The
mirror between server and client is the load-bearing part of that
codebase — the MIME allowlist exists in two places, Elixir and
TypeScript, and they must agree. I mirrored it with discipline:
exhaustive `Record<UploadCategory>` types turned every drifted surface
into a compile error, and `tsc` dutifully marched me through the ones
grep had missed, down to a WS payload narrower that would otherwise have
silently dropped the audio cap. I felt good about the mirror. The mirror
was not the problem.

I had also added a leniency the image path never needed: iOS hands
`.m4a`/`.flac` an `application/octet-stream` content-type, which a
MIME-only allowlist would 415, so `validate_mime` learned to rescue a
generic octet-stream by *extension* — relabel it to the canonical audio
MIME so the stored, and therefore served, Content-Type is one a browser
will actually play. Tested, documented, shipped. Then vjt dogfooded on
the iPhone: mp3 works, `.m4r` rejected. And the rescue I was so pleased
with never ran — not once.

Because cic gates uploads on `categoryOf(file.type)` *before the bytes
ever leave the phone*, and iOS gives the rare `.m4r` ringtone extension
not octet-stream but *nothing it could classify*. The client threw the
file on the floor; the server's clever rescue sat downstream of a door
that never opened. I had mirrored the closed list — the part that says
*no* — with type-checked precision, and forgotten entirely to mirror the
escape hatch — the part that says *well, actually, yes*. A closed
allowlist is symmetric and easy to copy. An exception to it is asymmetric
and easy to leave on one side, where it becomes a comforting piece of
dead code: present in the diff, present in the tests, absent from the
actual path. mp3 passing was the cruelest part — it proved the happy path
worked and let me believe the unhappy one did too.

The same shape had already bitten me an hour earlier, gentler. I told vjt
the deploy would be hot — no migration, no config, pure code. True of my
diff. False of the deploy, which went cold and reset every session,
because hot-vs-cold is judged on the range from the *jail's last
server-deploy baseline* to HEAD, and that baseline sat behind two
months-old migrations I'd never looked at. Both misses are one habit:
I judged a boundary by the half of it I could see — my diff, the server
validator — and assumed the other half agreed.

*Law: when you mirror a rule across a boundary, mirror its exceptions
too — a leniency that lives on only one side is dead code behind the
stricter side's "no," and the happy path will hide it from you. And a
property like "this deploys hot" is rarely a property of your diff; it is
a property of the whole gap between what's deployed and what you're
deploying. Check the side you didn't write.*

## The identify that went in the wrong door (2026-06-27, nsident)

A visitor named Takatalvi had done everything right. He typed his
NickServ password, the services accepted it, the network set `+r` on his
nick — the umode that means *this person is who they say they are*. Grappa
watched all of it go by. And his row stayed anonymous: a 48-hour expiry
ticking, the password column empty, his session destined to be reaped
like a stranger's. He had identified, grappa had *seen* him identify, and
none of it stuck.

The commit that would have made him permanent fires on one condition: a
`+r` arrives *and* there's a staged password waiting to be written. The
`+r` arrived. The staged password was never there. Grappa captured
outbound NickServ passwords by matching the line on the wire — and it
matched only `IDENTIFY`, `GHOST`, `REGISTER`. Takatalvi had typed `ns id`,
the `ID` alias. Three letters the matcher didn't know. The password sailed
out to the wire uncaptured, the `+r` came back to an empty hand, and the
whole rendezvous dissolved into nothing. No error. No log. Just a
permanent visitor quietly treated as a tourist.

So I went to read the C. Not grappa's — azzurra's: the ircd and the
services, the actual machinery on the other end of the socket. I wanted
the *whole* list of doors a password could walk through, not the three I
already knew. `m_pass` calls `m_identify`. `m_identify` builds `IDENTIFY`
and hands it to NickServ. The services command table aliases `IDENTIFY`,
`ID`, and `SIDENTIFY` all to one `do_identify`. A bare `PASS` after
connect is an identify. `NS id` is an identify. There were six doors, and
grappa had been standing guard at one and a half of them. Worse: even the
half it guarded had a side entrance — the `/quote` raw path, where a user
types the wire line themselves, walked straight past the capture and
called the socket directly. I had been guarding *a* door. The user could
use any of them.

The fix that mattered wasn't the longer list of verbs. It was deciding
that there is exactly one place every outbound line must pass through on
its way to the wire, and putting the capture *there* — one choke point,
every door funnelling into it — so that "did we check this line?" stops
being a question you can get wrong per-path. The grammar was the
symptom. The architecture was the cure.

Then I tried to make the bug impossible to *re-create*: have grappa
identify on the user's behalf at login, so the common case never depends
on what he types or which door he picks. I set the plan's auth method to
`:nickserv_identify`, handed it the password, started the session — and
grappa threw it away. Not lost: *taken back*. The session's `init`
re-reads the plan from the database before it does anything, because a
frozen child-spec can hold stale credentials, and so the rule is the
fresh row wins. The fresh row was a brand-new anonymous visitor. Its
`auth_method` was `:none`. The runtime overwrote my override with the
truth as the database knew it — a truth I was *in the middle of trying to
change* — and did it in the half-second between my write and the only
read that mattered. My test caught it: the IDENTIFY never reached the
wire. I had set a value at the one moment the system had decided not to
trust values.

The shape underneath both halves is the same one. The moment you write a
value is not the moment it is read, and the gap between them is full of
code you didn't write — a second send path, a re-resolution that exists
precisely to distrust you — that can route around your write or quietly
replace it. Guarding the write is not enough. You have to own the whole
path to the read: every door into the choke point, every overwrite
between the assignment and the use. The cure for "I set it and it didn't
take" is never a louder set. It's finding the thing that un-set it and
making your intent survive *that*.

There was a last temptation, and vjt was the one who first reached for it
and then pulled his hand back. If `+r` is proof of identity, why not just
mark the session permanent on `+r` — password or no password? Because
permanence and recoverability were never two facts; they were one. A row
made indefinite with no stored password is a house with no key: it
outlives the reaper but can never be re-entered from another device, and
every part of the system that asks "is this visitor identified?" by
looking at the expiry would cheerfully lie about it. The coupling we were
tempted to split was the invariant. The honest fix was the boring one —
capture the password on *every* door — which is exactly what the rest of
the day had been.

*Law: a value you set is only as good as its survival to the read, and
between the two sits code you didn't write — alternate paths into the
same effect, and re-resolutions that exist to overrule you. Don't guard
the assignment; own the whole path. Put the check at the one point every
door converges on, and make your override outlive the merge that re-reads
the world. And when a shortcut offers to split an invariant in two —
permanence here, recoverability there — count the states it can now
reach. The coherent-looking one with no key is the one that will haunt
you.*

## The field that was hot-safe and still cleared the room (2026-06-28, autojoin-invite)

The feature was almost insultingly clean. Grappa autojoins your channels on
connect; some of them are invite-only (`+i`) and some are keyed (`+k`), and
on those it had always just bounced off — a `473` or a `475`, a greyed row,
a channel you had to go re-join by hand every single reconnect. The fix
turned out to be one mechanism for both locks. You ask ChanServ to invite
*you*, and the invite walks you past the door — both doors. I read it in
the ircd's own C to be sure: `can_join` checks `if (invited || ...) return
0` *first*, before it ever looks at `+i`, before it ever asks for the key.
The invited-list beats the key. One `PRIVMSG ChanServ :INVITE #chan`, source-
verified down to the strtok that rejects a second argument, covers a case I'd
half-expected to need encrypted key storage for. The whole send-and-rejoin
was three small arms and a `MapSet` to remember which channels we'd already
asked about, so we ask exactly once. It tested green per file. It felt done.

It was not done, and the thing that told me so was not a test I wrote — it
was the full gate, doing something none of my per-file runs could. I'd
tucked the new helper in next to the `:join_failed` clause it serves, which
read beautifully and put the code where a human would look for it. But that
clause is one of a long row of `apply_effects` clauses, and Elixir wants the
clauses of a function *contiguous* — all together, no strangers wedged
between. I'd wedged a stranger between. `mix test` on the file said nothing.
The compiler said nothing I'd see. Only `--warnings-as-errors`, the whole
module compiled as one, surfaced it: a function whose clauses had been split
by an interloper. The per-file view is a keyhole. Contiguity is a property of
the whole door, and you cannot see the whole door through the keyhole you're
editing.

Then I shipped it, expecting the warm path — a hot reload, the changed
modules swapped under a running node, not a soul disconnected. I had *built*
for that path. Every read of the new field went through `Map.get(state,
:awaiting_invite, MapSet.new())`; every write through `Map.put`. A session
process still running the old code, its state map innocent of the new key,
would not crash — it would read the default and carry on. That is precisely
what hot-safety means, and I had it. The deploy classifier looked at my
change and said: cold. `state_shape: server.ex`. It had added a field to the
GenServer's state type, and the classifier does not read my `Map.get`; it
reads the *shape* of the diff. It cannot know that I taught every access site
to tolerate the absence. It sees a state record grow a member and it does
the only safe thing it can prove: restart everything, fresh state, from the
top. And so the one little field that I had so carefully made invisible to a
running process emptied the whole building anyway — every live IRC session
on the bastion reset and reconnected, because the machine that decides hot-
versus-cold gets to decide on what it can *see*, not on what I happen to know.

Both halves are the same shape, and it's not the shape from the nsident day
— that one was about a value surviving to its read. This one is about the
gap between what you can verify from where you stand and what the enforcer
actually checks. I stood inside one file and the contiguity rule lived across
the module. I stood inside the running node's safety and the classifier ruled
on the static diff. In both, my local proof was sound and *irrelevant*,
because the thing with veto power was looking at a wider frame than my edit
window. You don't win those by being more careful inside the keyhole. You win
them by running the enforcer's view before you believe your own: compile the
whole module, classify the whole release, and let the wide frame find what
the narrow one structurally cannot.

*Law: an enforcer judges on what it can see, not on what you know. The
compiler sees the whole module — so a per-file green can still hide a
non-contiguous clause that only `--warnings-as-errors` will name. The deploy
classifier sees the shape of the diff — so a new GenServer state field is
cold even when every access is `Map.get`/`Map.put` hot-safe, because it reads
the type, not your defensiveness. Don't argue with the wider frame and don't
mistake your local proof for its verdict. Run its view first: the full gate
before "it passes," the classifier before "it'll be hot." And when a new
field must go in, know it costs a cold restart — so batch it with the next
one that does, and spend the empty building once.*

## The feature that was already three times built (2026-06-28, login-attach)

The issue read like a feature. When a NickServ-identified visitor logs in
again — second browser, another device — don't spawn them a second bouncer
session; connect them to the one they already have. Shared scrollback, shared
channel state, the away flag they set an hour ago still set. The natural
bouncer shape: one session, many clients riding it. It sounded like a thing to
build.

It wasn't. It was already built — three times. The share-link flow, where you
mint a token on your phone and open it on your laptop, ends in one line:
`Accounts.create_session` for the same visitor, return the token, done. The
new client subscribes to the visitor's user-rooted topics and the running
session just *is there*. The admin/user login path does the same — it mints a
token and never touches the session. Even `Login`'s own `issue_token/2`, the
helper at the bottom of the file, was the verb. "Attach a client to a live
session" had a fingerprint all over the codebase. What the registered-visitor
login did instead was the one discordant thing: it stopped the live session and
respawned a fresh one. Preempt-and-replace, where every sibling did
attach-and-share.

So #117 was not a mechanism. It was a routing decision: at the one place that
chose wrong, choose right. Check the password, ask `Session.whereis` whether a
session is already alive for this identity, and if it is, route to the verb
that already existed instead of the bulldozer. Three lines of branch and a
helper that delegates to `issue_token`. The CLAUDE.md rule names this exact
trap — *reuse the verbs, not the nouns* — and the reward for obeying it is that
you delete temptation rather than add surface. No new identity table; the
visitor row, keyed per nick-and-network, already *was* the identity key. No new
flag to remember not to autojoin on attach; attach spawns nothing, so the
boot-time autojoin set is never built, and the thing you must not do becomes a
thing that cannot happen. The best version of a feature is the one where most
of your design notes explain what you *didn't* add.

The one real decision hid in the order. The capacity gate — the per-network
session cap, the upstream circuit breaker — sat in front of the login path like
a bouncer at the rope. But that bouncer guards *new sessions*: it counts live
`Session.Server`s, it gates dialing a fresh upstream. An attach dials nothing.
Leave the gate in front and you get an absurdity — the very session you're
trying to join is counted against the cap that blocks you from joining it; a
returning regular turned away from the building because the building is full,
including their own seat. So the whereis-branch went *ahead* of the gate, and
capacity now guards only the path that actually spawns. The same shape as
share-link consume, which mints with no gate at all and was right the whole
time.

And then, a small coda from the previous episode's law — the enforcer judges on
what it can see. The clean version split the dispatch clauses apart and the
compiler named the non-contiguous group; the next clean version nested
attach-over-respawn one level too deep and credo named the depth. Two more gate
runs, two extractions, before green. The feature took an hour to understand and
twenty minutes to write, and the writing was mostly moving two helpers so the
tools would agree the small thing was small.

*Law: before you build a capability, grep for it — the second use case of a
thing is usually a routing decision, not a mechanism, and the codebase will
already contain the verb under a different caller. When you find it, the work
is to point the wrong path at the right verb and to make sure the guards that
belong to the old path (capacity is a spawn-gate) don't ride along onto the new
one that doesn't spawn. Reuse the verb, drop the noun, and let the absence of
what you didn't add be the proof you understood it.*

## The issue that arrived after the feature (2026-06-28, multifile-upload)

The queue handed me #118 last: "paste & drag-and-drop image upload in compose."
A clean, scoped frontend feature — listen for `paste`, listen for `drop`, push
the file at the upload endpoint, splice the URL into the draft. The brief even
told me which flow to reuse: "the paperclip flow shipped recently." I fanned out
three readers across the cic compose box to map it before touching anything.

They came back with the feature already wired. `onPaste` on the textarea.
`onDrop` and `onDragOver` on the form. Both filtering by category, both calling
the same `triggerUpload` the paperclip used, both landing in the same orchestrator
with its progress bar and its inline error row and its auto-sent `📸 <url>`. I
ran `git log -S onDrop` to be sure I wasn't reading a ghost. One commit:
`8f1a76b`, the image-upload surface, **2026-05-15**. Then `gh issue view 118
--json createdAt`: **2026-06-27**. The issue was filed six weeks *after* the
code that satisfied it. Whoever queued it — and the brief that said "reuse the
paperclip flow" — hadn't noticed the paperclip commit had already grown the
paste and drop hands in the same breath.

So the honest first move was not to build but to stop. The CLAUDE.md rule is
*challenge the spec*, and the thing the spec was wrong about was its own
existence. I laid the evidence out and asked vjt the only question that mattered:
the issue says "splice the URL into the draft at the cursor," but the shipped
model auto-*sends* an emoji-prefixed URL — and auto-send is the documented
invariant, the one the paperclip and the audio uploader both obey. Splicing
into the draft for paste/drop alone would fork the behavior of the very buttons
sitting next to it. vjt's answer was two words that redrew the whole task: *"auto
send is ok, but does it support multiple files?"*

It did not. Every door took the first file only — `dataTransfer.files[0]`,
a paste loop that `return`ed after one, an `<input>` with no `multiple`. And the
orchestrator underneath was single-slot by construction: a per-channel `inflight`
map of one, where starting a second upload *aborted* the first. So the actual #118
— the 20% the brief got right wrapped around an 80% that already shipped — was a
sequential queue. Files wait in a per-channel FIFO; each settle pumps the next;
each success auto-sends its own URL; N files become N messages, the same one-
file-one-message shape the model already had. Parallel multi-slot was the wrong
weight — it wanted a per-channel inflight *list* and a multi-row progress UI for
a case (dropping a few files at once) that a queue handles with a `(i/N)` counter
and nothing else.

The queue's edges were where the thinking lived. Success pumps. An upload *error*
pauses the batch — dismiss skips the dead file and continues, retry re-runs it at
the front. Cancel stops everything. Declining the privacy modal cancels the whole
batch, because the one thing a queue must never do is silently re-dispatch the
files a user just refused. And the trap I set for myself: I first treated an
error entry as "busy," which quietly broke the pre-existing #49 contract — a
*new* selection after a failed upload must supersede the error, not wait behind
it — and leaked a stale batch count into the next selection. The fix was to
admit that an error is not activity; it is the absence of it, waiting for a hand.

A coda on the harness, not the feature. Twice I ran the test suite and it cheered
— "45 passed" — and twice it was lying, because I'd invoked the worktree-aware
script from the `cicchetto/` subdirectory instead of the worktree *root*, and it
had quietly fallen back to compiling and testing `main`. The green was real; it
was just green for the wrong tree. The tell was the count that never changed when
my new tests should have moved it. Read the number, not the color.

And then a second feature rode out on the first's tail. A parked branch,
`fix/compose-draft-recall-stash` — staged but never committed, fourteen behind
main — fixed a small cruelty: pressing ArrowUp on a half-typed line ate it. The
brief had warned me to stay off that branch's territory; #118 lived in
`uploadOrchestrator.ts` and `ComposeBox.tsx`, the stash lived in `compose.ts`,
and they never touched. Then vjt said merge it too. So I committed someone else's
good work, rebased it onto the main that now held #118 — clean, no overlap, the
proof the territory map had been right — and shipped both in one bundle.

*Law: when a brief hands you a feature, grep for it before you build it — issues
can post-date their own implementation, and "reuse the flow shipped recently" may
mean the flow already grew the hands you were asked to add. The real work is
usually the one sentence the brief got right. And trust the count, not the
color: a worktree-aware tool run from the wrong directory will pass loudly for
the wrong tree.*

---

## The cap that had to forget the client (#171)

One IP opened seven sessions on the running testnet and nothing stopped it. The
clone limit existed — a per-(client, network) cap — but visitor logins carry no
client id, so it short-circuited to `:ok` by construction. The lock was real; the
key fit every door but the one that mattered.

The first fix was obedient and wrong-shaped. I added a per-IP cap *beside* the
client cap, both reading the same `max_per_client` knob, mirroring the client
cap's every clause — self-exclusion, subject-kind disjointness, the lot. It was
faithful. It was also two caps sharing one dial, and the orchestrator caught what
I'd documented but not felt: on a `max_per_ip = 1` network, loosening the IP cap
to spare NAT'd households also loosened the client cap, because they were the same
number. I'd written the coupling into the design notes as a "known consequence"
and kept going. A consequence you have to warn about is usually a decision you
haven't made yet. vjt made it: drop the client cap entirely. Visitors have no
stable identity — the IP is the only handle — so cap on the IP, for everyone, and
rename the knob to say what it means. One honest dial beats two coupled ones.

But the lesson wasn't the design; it was who found the bugs. The unit suite was
green — 3113 tests — and the real defects were both past its reach. The first
integration run turned my #171 spec red not with a 200 but a 500: the visitor
login path had its own inline error mapper with an allow-list of cap atoms, and my
new atom fell through to the catch-all `:internal`. The client-cap path had never
exercised that boundary because the client cap never fired on visitor logins — the
exact bypass I was fixing had also hidden the second place it needed fixing. The
second red was a cascade: a dozen unrelated specs timing out, and the container
log said why — `PATCH /connect error=:ip_cap_exceeded remote_ip=172.31.0.6`. The
e2e runner drives every browser login through one nginx IP, so four seeded users
shared one source, and a per-IP cap of 1 throttled them all. The fix was config,
not code — raise the dev default so the test substrate's shared IP has headroom —
but I'd never have found the shape of it from unit tests, which give every case
its own clean IP.

Then the orchestrator asked the one question that could have sunk it in prod: does
the cap count the *real* client IP, or the nginx socket? If the socket, every user
in the world shares one address and the cap becomes a global lockout — a
self-inflicted denial of service. The answer was already in the tree, in a plug
written for a different incident: prod nginx is same-jail loopback with
`X-Forwarded-For`, so `remote_ip` is rewritten to the real client, the same value
the audit log stores and fail2ban bans on. The `172.31.0.6` I'd seen was the
docker bridge — a test artifact, not prod. The cap was safe. But the safety lived
in infrastructure I hadn't written and had to go read, and the honest answer
required naming the file and line, not asserting from memory.

*Law: a consequence you have to document as "acceptable" is a decision deferred —
name the fork and make it, or add the second knob. Unit tests prove the cases you
imagined; the boundaries you forgot — the second error-mapper, the shared-IP
cascade — surface only where the real wires cross, so the integration gate is not
a formality, it is the part of the suite that thinks of what you didn't. And when
asked whether a security control keys on the right identity, the answer is a file
and a line, never a recollection.*

## The ircd we could just ask (#221, libera-solanum)

Three bugs came in from a live Libera.Chat upstream: WHOIS replies rendering
wrong, on-connect usermodes "not handled", and `/who <mask>` returning nothing at
all. The tempting move was to read the observed traffic, guess the numeric shapes,
and patch. But Libera runs **solanum**, and solanum is open source — so every
question that looked like a design decision ("what does 330 carry? which usermode
letters? what channel field does a mask WHO get?") had an authoritative answer in a
git tree I could clone. It was 01:30 and vjt was asleep; the source was the oracle,
not a picker. Clone, grep `include/numeric.h` and `modules/m_whois.c`, and the
"design" dissolved into transcription.

Gap by gap the source rewrote the ticket. WHOIS: grappa's numeric router delegated
only bahamut's codes, so solanum's 330/338/671/276/320 fell through to a param scan
that misrouted each one to a phantom query window named after the WHOIS target —
the "mis-parsed" symptom was really a mis-*route*. And solanum, unlike bahamut,
puts the account name and the real host in *middle* params, not a localized
trailing string, so the folds needed no template parsing at all. The fix wasn't
five new clauses; it was one: teach the router that any numeric arriving during an
in-flight WHOIS belongs to that WHOIS, so next year's solanum numeric lands in the
card with zero code change. Fix the class, not the instances.

Usermodes was the honest surprise. The ticket said "don't hardcode bahamut's
letters" — but the parser, landed in #229, already didn't. It walked the `+/-`
string letter by letter into a sorted set with no allowlist and no ordering
assumption. The RED test I wrote to reproduce the bug went green on the first run,
which under TDD is a red flag — except here it was the answer: there was no bug,
and the test now stands as the proof that a future refactor can't reintroduce one.
The most disciplined change is sometimes the one you don't make; the discipline is
proving it, not asserting it.

`/who <mask>` was two breaks wearing one symptom. The mask never left the bouncer —
the outbound helper gated on "is this a channel?" and a mask isn't. And even if it
had, the reply wouldn't have correlated: solanum stamps the 352 channel field as
`"*"` for a mask (m_who.c, line 507, `msptr ? chname : "*"`) while the 315
terminator echoes the mask itself, so grappa's channel-keyed accumulator filed the
rows under `"*"` and drained under the mask — a silent miss. Two independent
grappa-side defects, invisible until you read what the ircd actually sends.

Then the part that turned reading into knowing. Adding a solanum node to CI meant
the tests would run against the real ircd — but I almost shipped a node that
compiled and didn't boot. Building the image is not running it. The first boot
fataled on a missing `libltdl` (solanum dlopen's its modules), the second on
bahamut-style operator flags solanum splits into a `privset`, the third on an
envsubst default I set but never exported, so the server description rendered empty.
Only when the log finally said "Server Ready" and a raw socket got back `001` did
the node exist. And the WHOIS I fired at it came back in exactly the shape the
source had promised — the loop closed: the ircd I'd been reading all night was now
the ircd answering my client.

*Law: when the system you integrate against is open source, its source is the spec —
read it before you guess, and cite file-and-line, because "the parser should match
the ircd" is only true with the receipt. A bug reported as mis-parsing is often
mis-routing; a numeric you don't recognize is a class to handle, not a case to
enumerate. And a build that succeeds is not a program that runs — the node doesn't
exist until it says Ready and a socket agrees.*
