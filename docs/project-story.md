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

