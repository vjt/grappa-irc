---
name: review
description: Dispatch parallel codebase or architecture review agents per docs/reviewing.md
---

Run a full code review. **Requires argument**: `codebase` or `architecture`.
No default. If the user invokes `/review` without an argument, ask which type.

Full protocol at `docs/reviewing.md`.

## Argument: `codebase`

Line-level scan. 6 parallel background agents, one per scope:

| Agent | Scope |
|-------|-------|
| irc/ | `lib/grappa/irc/` (parser, client, message struct) |
| persistence/ | `lib/grappa/scrollback*`, `priv/repo/migrations/` |
| lifecycle/ | `lib/grappa/{application,bootstrap,config,release,repo,session}*`, `lib/grappa/session/` |
| web/ | `lib/grappa_web/` (endpoint, router, controllers, channels) |
| cicchetto/ | `cicchetto/src/**`, `cicchetto/{tsconfig.json,vite.config.ts,vitest.config.ts,biome.json,package.json,index.html}`, `cicchetto/public/{manifest.json,sw.js,icon*}` |
| cross-module + infra | Patterns across all server modules + `scripts/`, `Dockerfile`, `compose*.yaml`, `config/`, `infra/nginx.conf`, `.env.example`, `grappa.toml.example`, `cicchetto/biome.json`, `cicchetto/vite.config.ts`, `cicchetto/package.json` ↔ `cicchetto/bun.lock` sync, `scripts/bun.sh` |

Each agent MUST read EVERY file in scope + `CLAUDE.md` + the active
checkpoint under `docs/checkpoints/` + `docs/DESIGN_NOTES.md`. The
cicchetto/ agent additionally reads its server-side wire-shape
counterparts (`lib/grappa/{accounts,networks,scrollback}/wire.ex`,
`lib/grappa_web/controllers/*_json.ex`) so wire-shape drift is caught
against the source of truth.

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

What to look for (server-side: irc/, persistence/, lifecycle/, web/, cross-module agents):
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

What the cicchetto/ agent looks for (TypeScript/SolidJS/PWA-specific):
- SolidJS reactivity bugs: `setSignal` inside a tracked scope (effect
  loops), `createResource` source signal that never invalidates,
  `untrack` covering up missing reactivity, `createRoot` ownership
  leaks (effects outliving their owner), `on(...)` defer-flag misuse,
  module-singleton-signal double-init under `vi.resetModules`.
- TypeScript strictness: `any`, `as` casts that bypass exhaustiveness,
  missing `unknown` narrowing on `JSON.parse`/`fetch` body reads,
  optional-chain holes, non-exhaustive switch on closed unions
  (`MessageKind` is the canonical case), `noUncheckedIndexedAccess`
  violations, `@ts-ignore` / `@ts-expect-error` without a comment.
- Wire-shape drift: every `cicchetto/src/lib/api.ts` type must mirror
  `Grappa.{Accounts,Networks,Scrollback}.Wire` + `GrappaWeb.*JSON`.
  Missing fields, mismatched optionality, type narrower than server,
  PubSub event payload shape divergence vs `GrappaWeb.GrappaChannel`.
- XSS / token leakage / CSP-incompatible patterns: `innerHTML`,
  `dangerouslySetInnerHTML`-equivalent, `eval`, inline `<script>`
  injected at runtime, token in URL bar / `window.history`, leaked
  through `console.log` of full request objects, third-party script
  loads the nginx CSP rejects.
- A11y baseline: semantic HTML, ARIA roles/labels, keyboard
  reachability, visible focus, tap targets ≥44pt on iOS, color
  contrast on dark backgrounds, `lang` attribute, form-label
  association.
- Test quality: outcome assertions vs implementation details,
  module-boundary mocks (`vi.mock` on `../lib/api`/`../lib/socket`
  not internal helpers), no buggy-behavior pinning, realistic mock
  data, production code paths called rather than re-implemented,
  `vi.resetModules()` between cases for module-singleton signals.
- PWA shell correctness: `manifest.json` required fields (name,
  start_url, display, icons 192/512); SW caching matches documented
  intent (shell-cache only, no API/WS); cache-bump on deploy
  (`Cache-Control: no-cache` from nginx OR versioned SW filename);
  `index.html` includes the manifest link.
- Build + tooling drift: `tsconfig.json` strict flags pinned;
  `package.json` ↔ `bun.lock` sync; Vite base/root/outDir match
  nginx + compose.prod.yaml expectations; `vite-plugin-solid` is
  the plugin layer.

What to IGNORE: style preferences, "could be improved" without
concrete impact, Phase 5+ deferred work explicitly noted in todo.md
or the active checkpoint, Phase 4 UI scope (irssi-shape redesign:
keyboard layout, theme system, nick lists, mode indicators, topic
bar, mobile ergonomics, voice I/O — flag bugs but not "the layout is
messy").

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
- Inter-context call rules (`Boundary` annotations — flag obvious
  violations now if they aren't already in
  `mix boundary.find_violations`)
- Migration drift (`priv/repo/migrations/` order, idempotency,
  schema_migrations consistency)
- Infra: `scripts/*.sh` consistency, `Dockerfile` stages, compose
  files (project-name conflicts, port collisions, env var coverage),
  `.env.example` ↔ `runtime.exs` symmetry, `compose.prod.yaml` env
  vars vs `runtime.exs` reads, `infra/nginx.conf` reverse-proxy
  allowlist vs `lib/grappa_web/router.ex` routes (any new server
  route must land in nginx OR be intentionally bouncer-internal)
- Cicchetto-side cross-cutting: `cicchetto/biome.json` rule
  consistency, `cicchetto/vite.config.ts` build target / outDir
  matching `compose.prod.yaml` `cicchetto-build` expectations,
  `cicchetto/package.json` version pinning AND lockfile sync
  (`cicchetto/bun.lock`), `scripts/bun.sh` UID/cache layout
  matching `compose.prod.yaml` `cicchetto-build`

## Argument: `architecture`

Concern-based structural review. 6 parallel background agents, one per CONCERN:

| Agent | Concern |
|-------|---------|
| Abstraction boundaries | Leaky abstractions, contexts reaching into each other's schemas, return types forcing callers to parse. Includes the server↔client boundary: does cicchetto's `api.ts` consume domain types or re-shape on the client? |
| Responsibility & cohesion | ONE job per context? God modules, feature envy, misplaced logic (controller doing IRC parsing, schema doing PubSub broadcast, cicchetto component holding domain state instead of consuming it from `lib/networks.ts`). |
| Duplication | Same problem solved differently, copy-paste with tweaks, parallel structures that drift. Canonical cases: wire-shape unification across REST/PubSub/Channel/Phase-6 listener AND across server `Wire` modules ↔ cicchetto `api.ts` types. |
| Dependency architecture | Dependency direction (web → contexts → schemas; cicchetto components → `lib/*.ts` stores → `api.ts` + `socket.ts`), import cycles (TS module cycles + Elixir Boundary), hidden coupling via `Application.put_env` or module-level mutable state on the client, supervision-tree ordering invariants. |
| Type system leverage | Atoms-or-typed-literals (CLAUDE.md "never untyped strings"), structs over maps, custom Ecto types over `:map` + key conventions. On the client: TS `strict` + `noUncheckedIndexedAccess`, branded/opaque types over bare `string` for keys (the `ChannelKey` pattern), exhaustive switch over closed unions, `unknown` narrowing instead of `any`. `@spec` discipline (Dialyxir `:underspecs`) on the server. |
| Extension & maintainability | Adding a new IRC kind = touching 15 files (server kind enum + Wire + cicchetto `MessageKind` + ScrollbackPane render + tests)? Adding a new context = touching the supervision tree? Config sprawl across `config/*.exs` AND `cicchetto/{tsconfig,vite,vitest,biome}.json`? Test architecture (lib/ mirror vs outcome-tested; client `__tests__/` colocated). |

Each agent reads files across the ENTIRE codebase (server + cicchetto)
following the concern.

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
