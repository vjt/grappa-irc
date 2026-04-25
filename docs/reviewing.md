# Reviewing

Three review dimensions in one document. Run together, produce one
review file. Actionable findings only — not style nits. Check
`CLAUDE.md` and `docs/DESIGN_NOTES.md` before flagging — some
patterns are deliberate and the rationale is documented.

**Trigger:** Enforced by `/start`. Codebase review due when ≥ 12
sessions since last review OR > 2 weeks. Must run before new feature
work. Bug fixes and deploy fixes are exempt.

**Output:**
- Codebase review: `docs/reviews/codebase/YYYY-MM-DD-codebase-review.md`
- Architecture review: `docs/reviews/architecture/YYYY-MM-DD-architecture-review.md`

---

## 1. Line-Level Code Review

**What:** File-by-file scan for concrete bugs, type errors, violations.

### Dispatch

5 parallel background agents, one per scope:

| Agent | Scope |
|-------|-------|
| irc/ | `lib/grappa/irc/` (parser, client, message struct) + IRC test helpers |
| persistence/ | `lib/grappa/scrollback*` + `priv/repo/migrations/` |
| lifecycle/ | `lib/grappa/{application,bootstrap,config,release,repo,session}*` + `lib/grappa/session/` |
| web/ | `lib/grappa_web/` (endpoint, router, controllers, channels) |
| cross-module + infra | Patterns across ALL modules + `scripts/`, `Dockerfile`, `compose*.yaml`, `config/`, `.env.example`, `grappa.toml.example` |

Each agent reads EVERY file in scope + `CLAUDE.md` + the active
checkpoint under `docs/checkpoints/` + `docs/DESIGN_NOTES.md`.

### What to report

PROBLEMS ONLY. No praise, no "looks good." For each finding:

```
### S1. Short title
**Module:** scope | **File:** `path:line`
**Category:** category tag
Description of the problem and why it matters.
**Fix:** Concrete suggestion.
```

Severity headers: `## CRITICAL`, `## HIGH`, `## MEDIUM`, `## LOW`.

### What agents look for

- **Type safety violations** — missing `@spec`, untyped strings where
  atoms-in-allowlist exist, `:map` columns that should be custom
  Ecto types, untyped Logger metadata keys.
- **Logic bugs** — wrong conditions, missing pattern-match clauses,
  off-by-one, malformed-input handling that violates RFC 2812 or the
  charset boundary.
- **CLAUDE.md violations** — default arguments via `\\`, leaky
  abstractions, swallowed exceptions, mutable application state.
  **CLAUDE.md violations are bugs even when the spec or plan asks
  for the pattern.** The spec can inherit a bug from existing code.
- **Unused code / dead code / stale aliases / orphaned tests.**
- **Missing error handling at system boundaries** — IRC parser,
  REST controller params, TOML config loader.
- **Inconsistencies with documented patterns** — wire-shape
  divergence (REST vs PubSub vs Channel), PubSub topic naming, logger
  metadata key abuse (inline interpolation when extending the
  allowlist is the documented path per
  `~/.claude/projects/-srv-grappa/memory/project_logging_format.md`).
- **OTP misuse** — wrong restart strategy, oversized GenServer state,
  blocking work in `init/1`, missing `trap_exit` when `terminate/2`
  cleanup is intended.
- **Phoenix/Ecto rule violations** — thick controllers, raw
  `Repo.insert/2` without changeset, missing `FallbackController`
  for `{:error, _}` returns, sandbox not `async: true` without
  documented reason.
- **Charset boundary violations** — non-UTF-8 in domain code, missing
  encode/decode at the IRC byte boundary, `String.length/1` used for
  IRC framing limits (should be `byte_size/1`).
- **Security issues** — `String.to_atom/1` (atom DoS),
  unauthenticated DDL via raw SQL, secrets in compile-time config.

### What agents ignore

- Style preferences.
- Things that "could be improved" but aren't bugs.
- Pre-existing issues already documented in `docs/todo.md`.
- Phase 5+ deferred items explicitly noted in todo.md or the active
  checkpoint.
- Test files for the line-level scope agents (cross-module agent
  covers test patterns).

---

## 2. Architecture Review

**What:** Concern-based analysis across the entire codebase. Not
"is this line correct?" but "is this module structured right?"
**When:** After major refactors, when the codebase feels mature
enough to question structure. Less frequent than line-level reviews.
**Output:** `docs/reviews/architecture/YYYY-MM-DD-architecture-review.md`

### Dispatch

6 parallel background agents, one per CONCERN (not per directory):

| Agent | Concern |
|-------|---------|
| Abstraction boundaries | Leaky abstractions, contexts reaching into each other's schemas, return types that force callers to parse |
| Responsibility & cohesion | Does each context have ONE job? God modules, feature envy, misplaced logic (controller doing IRC parsing, schema doing PubSub broadcast) |
| Duplication | Same problem solved differently, copy-pasted code with tweaks, parallel structures that drift. The wire-shape unification across REST/PubSub/Channel/Phase-6 listener is the canonical case to verify. |
| Dependency architecture | Dependency direction (web → contexts → schemas), import cycles, hidden coupling via `Application.put_env`, supervision-tree ordering invariants documented in `application.ex` |
| Type system leverage | Atoms-or-typed-literals (CLAUDE.md "never untyped strings"), structs over maps in domain returns, custom Ecto types over `:map + caller-side key conventions`, `@spec` discipline (Dialyxir `:underspecs` is the gate) |
| Extension & maintainability | Adding a new IRC kind = touching 15 files? Adding a new context = touching the supervision tree? Config sprawl, test architecture (lib/ mirror vs outcome-tested) |

Each agent reads files across the ENTIRE codebase as needed — they
follow the concern, not a directory boundary.

### What to report

FINDINGS, not line-level bugs. For each:

```
### A1. Short title
**Concern:** which of the 6 concerns
**Scope:** which modules / files are involved
**Problem:** what's wrong at the structural level
**Impact:** what breaks, drifts, or gets harder over time
**Recommendation:** concrete path forward (not "refactor somehow")
```

Severity: `## CRITICAL` (blocks correctness or safety),
`## HIGH` (significant maintenance burden), `## MEDIUM` (tech debt),
`## LOW` (improvement opportunity).

### What agents look for

- **Abstraction leaks:** context A returns raw `map()` that callers
  must pattern-match on; schema B's internal fields exposed through
  a wire payload; the IRC parser leaking byte-shape into the domain.
- **Responsibility violations:** business logic in controllers,
  display/wire shape in schemas, IRC framing in Session.Server,
  upstream connection state in the Bootstrap Task.
- **Duplicated patterns:** two places building wire shapes
  differently for the same domain entity; two places parsing IRC
  prefixes; the test harness duplicating logic that should live in
  `Grappa.IRCServer` or `Grappa.DataCase`.
- **Dependency violations:** schemas importing from contexts,
  contexts importing from `GrappaWeb`, the `IRC.Parser` reaching
  into Scrollback, supervision tree ordering invariants that are
  load-bearing but not documented.
- **Underused type system:** `String.t()` where an atom enum exists
  (e.g. anywhere a closed set of IRC commands appears), `:map`
  columns with caller-side key conventions instead of custom Ecto
  types (the `Grappa.Scrollback.Meta` pattern is the reference), `nil`
  fields that are never actually nil in practice.
- **Extensibility pain points:** adding a new IRC event kind
  requires changes in N files where N > 3; adding a new metadata
  key requires extending an allowlist in M places; a new HTTP route
  requires controller + JSON view + channel + test scaffolding all
  in parallel without shared shape.

### What agents ignore

- Individual bugs (that's the line-level review).
- Performance (unless architecturally caused).
- Test coverage numbers.
- Documentation quality.

---

## 3. Trajectory Review

**What:** Step back and ask "are we building the right thing?" Not
code quality, not architecture — direction.
**Who:** The main session (not dispatched agents). Requires judgment
about the project as a whole, informed by recent checkpoint history.

### Process

After the line-level and architecture agents report back, read:
- The active checkpoint (recent sessions)
- `docs/todo.md` (backlog and priorities)
- `docs/project-evolution.md` (phase plan + intent)
- `docs/project-story.md` (narrative thread across sessions)
- Recent observation items in todo (are they being evaluated?)

### Questions to answer

Write a `## Trajectory` section at the end of the review:

1. **What did we build in the last N sessions?** One-sentence
   summary of each session's main work. Is there a theme or is it
   scattered?
2. **Does recent work serve the core mission?** (Always-on IRC
   bouncer + REST/WS API + browser PWA + downstream IRCv3 listener
   facade.) Infrastructure is necessary but should serve the
   product, not become the product.
3. **What's stalling?** Items that have been in todo for 2+ weeks
   without progress. Are they blocked, deprioritized, or forgotten?
4. **Observation items** — any that are due for evaluation? Flag them.
5. **Risk check** — anything we're ignoring that could bite us?
   Production gaps, untested paths, assumptions we haven't validated,
   security postures temporarily relaxed (e.g. `verify: :verify_none`)
   that need a Phase-5 hardening reminder.
6. **Recommendation** — 2-3 sentence opinion on what matters most
   right now. Not a todo list — a direction.

### Tone

Honest, not diplomatic. If we've been yak-shaving for a week, say
so. If the infrastructure work was necessary, say that too. The
point is to surface the pattern, not judge it.
