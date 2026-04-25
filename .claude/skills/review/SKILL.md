---
name: review
description: Dispatch parallel codebase or architecture review agents per docs/reviewing.md
---

Run a full code review. **Requires argument**: `codebase` or `architecture`.
No default. If the user invokes `/review` without an argument, ask which type.

Full protocol at `docs/reviewing.md`.

## Argument: `codebase`

Line-level scan. 5 parallel background agents, one per scope:

| Agent | Scope |
|-------|-------|
| irc/ | `lib/grappa/irc/` (parser, client, message struct) |
| persistence/ | `lib/grappa/scrollback*`, `priv/repo/migrations/` |
| lifecycle/ | `lib/grappa/{application,bootstrap,config,release,repo,session}*`, `lib/grappa/session/` |
| web/ | `lib/grappa_web/` (endpoint, router, controllers, channels) |
| cross-module + infra | Patterns across all modules + `scripts/`, `Dockerfile`, `compose*.yaml`, `config/`, `.env.example`, `grappa.toml.example` |

Each agent MUST read EVERY file in scope + `CLAUDE.md` + the active
checkpoint under `docs/checkpoints/` + `docs/DESIGN_NOTES.md`.

### Agent instructions (include in every agent prompt)

Report PROBLEMS ONLY. No praise. For each finding:

```
### S{N}. Short title
**File:** `path:line`
**Category:** category tag
**Severity:** CRITICAL/HIGH/MEDIUM/LOW
Description.
**Fix:** Concrete suggestion.
```

What to look for (Elixir/Phoenix-specific):
- Dead code (unused functions, aliases, requires, modules, unreachable clauses)
- Default arguments via `\\` — only genuine config defaults are acceptable
  (CLAUDE.md "No default arguments via `\\`")
- Untyped / weakly-typed (`map()` where struct exists, `String.t()` where
  an atom enum exists, missing `@spec`, `:any` types, untyped Logger
  metadata keys not in the allowlist)
- Defensive `try/rescue` without recovery (CLAUDE.md "Let it crash")
- GenServer state misuse (cross-process state, large state blobs that
  should be in Ecto, blocking work in `init/1` without
  `{:continue, _}`)
- Process linkage / supervision strategy mismatches (e.g. permanent
  where transient is right, missing trap_exit when terminate cleanup
  is needed)
- Phoenix/Ecto rule violations (controllers thick with logic that
  belongs in contexts, raw `Repo.insert/2` without changeset, sandbox
  not async, leaky abstractions returning `map()` instead of structs)
- Charset boundary violations (non-UTF-8 in domain, missing
  encode/decode at IRC boundary)
- IRC parser exhaustiveness (non-exhaustive prefix/command pattern
  matches, silent fallthrough where `{:error, atom}` should fire)
- PubSub topic-shape drift (topics not following the
  `grappa:network:{net}/channel:{chan}` convention)
- Logger metadata key abuse (calls with non-allowlisted keys, inline
  interpolation as a workaround instead of extending
  `config/config.exs`)
- Stale patterns contradicting CLAUDE.md or DESIGN_NOTES — **CLAUDE.md
  violations are bugs even when the spec or plan asks for the
  pattern.** The spec can inherit a bug from existing code.

What to IGNORE: style preferences, "could be improved" without
concrete impact, Phase 5+ deferred work explicitly noted in todo.md
or the active checkpoint.

### Cross-module + infra agent additions

The cross-module agent additionally searches the ENTIRE `lib/` for:
- `\\` default arguments in all function signatures
- `Application.get_env/get_env!/fetch_env!` outside `config/` and
  `lib/grappa/application.ex` (the documented exception)
- `String.to_atom/1` (atom DoS) — should be `String.to_existing_atom/1`
  against an allowlist
- Inline string interpolation in `Logger.{info,warning,error,debug}`
  calls where structured-KV metadata would be cleaner
- Bare `catch _, _` / `rescue _` patterns
- Inter-context call rules (Phase 1 Task 10 will enforce via
  `Boundary` annotations — flag obvious violations now)
- Migration drift (`priv/repo/migrations/` order, idempotency,
  schema_migrations consistency)
- Infra: `scripts/*.sh` consistency, `Dockerfile` stages, compose
  files (project-name conflicts, port collisions, env var coverage),
  `.env.example` ↔ `runtime.exs` symmetry

## Argument: `architecture`

Concern-based structural review. 6 parallel background agents, one per CONCERN:

| Agent | Concern |
|-------|---------|
| Abstraction boundaries | Leaky abstractions, contexts reaching into each other's schemas, return types forcing callers to parse |
| Responsibility & cohesion | ONE job per context? God modules, feature envy, misplaced logic (e.g. controller doing IRC parsing) |
| Duplication | Same problem solved differently, copy-paste with tweaks, parallel structures that drift (the wire-shape unification across REST/PubSub/listener is the canonical case to verify) |
| Dependency architecture | Dependency direction (web → contexts → schemas), import cycles, hidden coupling via `Application.put_env`, supervision-tree ordering invariants |
| Type system leverage | Atoms-or-typed-literals (CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped strings"), structs over maps, `@spec` discipline, custom Ecto types over `:map` + key conventions |
| Extension & maintainability | Adding a new IRC kind = touching 15 files? Adding a new context = touching the supervision tree? Config sprawl, test architecture (mirrors lib/ vs outcome-tested) |

Each agent reads files across the ENTIRE codebase following the concern.

### Agent instructions (include in every agent prompt)

Report FINDINGS, not line-level bugs. For each:

```
### A{N}. Short title
**Concern:** which of the 6
**Scope:** modules / files involved
**Problem:** structural issue
**Impact:** what breaks, drifts, or gets harder
**Recommendation:** concrete path forward
```

Severity: CRITICAL (blocks correctness/safety), HIGH (significant maintenance burden), MEDIUM (tech debt), LOW (improvement opportunity).

## After all agents complete

1. Collect all findings from all agents.
2. Deduplicate (cross-module agent may overlap with scope agents).
3. **Trajectory review** (codebase reviews only): read the active
   checkpoint, `docs/todo.md`, `README.md` "Phases" section, and
   `docs/project-story.md`. Write a `## Trajectory` section answering:
   what did we build recently, does it serve the core mission
   (always-on IRC bouncer + REST/WS surface + downstream IRCv3
   listener), what's stalling, any observation items due, risk check,
   and a 2-3 sentence direction recommendation. See
   `docs/reviewing.md` section 3 for the full question list.
4. Compile into a single review document:
   - `docs/reviews/codebase/YYYY-MM-DD-codebase-review.md` for codebase reviews
   - `docs/reviews/architecture/YYYY-MM-DD-architecture-review.md` for architecture reviews
5. Summary table: severity counts by module/concern.
6. Update active checkpoint with review stats.
7. Present top findings + trajectory assessment to the user.
