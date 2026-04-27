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

6 parallel background agents, one per scope:

| Agent | Scope |
|-------|-------|
| irc/ | `lib/grappa/irc/` (parser, client, message struct) + IRC test helpers |
| persistence/ | `lib/grappa/scrollback*` + `priv/repo/migrations/` |
| lifecycle/ | `lib/grappa/{application,bootstrap,config,release,repo,session}*` + `lib/grappa/session/` |
| web/ | `lib/grappa_web/` (endpoint, router, controllers, channels) |
| cicchetto/ | `cicchetto/src/**` + `cicchetto/{tsconfig.json,vite.config.ts,vitest.config.ts,biome.json,package.json,index.html}` + `cicchetto/public/{manifest.json,sw.js,icon*}` |
| cross-module + infra | Patterns across ALL server modules + `scripts/`, `Dockerfile`, `compose*.yaml`, `config/`, `infra/nginx.conf`, `.env.example`, `grappa.toml.example`, `cicchetto/biome.json`, `cicchetto/vite.config.ts`, `cicchetto/package.json` ↔ `cicchetto/bun.lock` sync, `scripts/bun.sh` |

Each agent reads EVERY file in scope + `CLAUDE.md` + the active
checkpoint under `docs/checkpoints/` + `docs/DESIGN_NOTES.md`. The
cicchetto/ agent additionally reads `cicchetto/src/lib/api.ts`'s
server-side counterparts (`lib/grappa/{accounts,networks,scrollback}/wire.ex`,
`lib/grappa_web/controllers/*_json.ex`) so wire-shape drift is
caught against the source of truth.

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

### What agents look for (server-side: irc/, persistence/, lifecycle/, web/, cross-module)

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

### What the cicchetto/ agent looks for

- **SolidJS reactivity bugs** — `setSignal` called inside a tracked
  scope (loops the effect), `createResource` source signal that
  never invalidates, `untrack` misuse (covering up missing reactivity
  vs. legitimate decoupling), `createRoot` ownership leaks (effects
  outliving their owner module), `on(...)` without an explicit defer
  flag where intended, double-creation when `vi.resetModules` resets
  the module-singleton signals.
- **TypeScript strictness violations** — `any` escape hatches, `as`
  casts that bypass exhaustiveness, missing `unknown` narrowing on
  `JSON.parse`/`fetch` body reads, optional-chain holes (`a?.b.c`
  where `b` may be undefined), non-exhaustive switch on closed unions
  like `MessageKind` (`"privmsg" | "notice" | "action"`),
  `noUncheckedIndexedAccess` violations.
- **Wire-shape drift** — every type in `cicchetto/src/lib/api.ts`
  must mirror the server-side `Grappa.{Accounts,Networks,Scrollback}.Wire`
  + `GrappaWeb.*JSON` modules. Missing fields, extra fields, mismatched
  optionality, type-narrower-than-server (e.g. `string` for an
  ISO-8601 stamp the server may send as integer epoch ms), or
  PubSub-event payload shape divergence vs the channel push contract
  in `GrappaWeb.GrappaChannel`.
- **XSS / token leakage / CSP-incompatible patterns** —
  `innerHTML` / `dangerouslySetInnerHTML`-equivalent, `eval` /
  `new Function`, inline `<script>` tags injected at runtime,
  `localStorage` for non-bearer secrets, token in URL bar /
  `window.history`, leaked through `console.log` of full request
  objects, third-party script loads that the nginx CSP rejects.
- **A11y baseline** — semantic HTML (`<button>` not `<div onclick>`),
  ARIA roles/labels on dynamic regions, keyboard navigation
  reachable for every interactive element, visible focus state,
  tap-target sizing on iOS (≥44pt), color contrast on dark
  backgrounds, `lang` attribute, form labels associated correctly.
- **Test quality** — assertions test outcomes (DOM state, store
  state, network call shape) NOT implementation details (which
  function got called); mocks are at module boundaries (vi.mock on
  `../lib/api` + `../lib/socket`); no buggy-behavior-pinned tests;
  realistic mock data (full structs, not empty/zero-length); each
  test calls production code paths rather than re-implementing logic;
  `vi.resetModules()` between cases for module-singleton signals.
- **PWA shell correctness** — `manifest.json` has all required
  fields (name, start_url, display, icons at 192/512), service worker
  caching strategy matches the documented intent (shell-cache only,
  no API/WS responses), SW has cache-bump on deploy
  (`Cache-Control: no-cache` from nginx OR an explicit version-bump
  in the SW filename), `index.html` includes the manifest link.
- **Build + tooling drift** — `tsconfig.json` strict mode flags
  pinned (`strict`, `noUncheckedIndexedAccess`, `noImplicitAny`);
  Biome config consistent with the documented "single tool, single
  config" decision; `package.json` ↔ `bun.lock` sync (no
  hand-edited deps that didn't go through `bun install`); Vite
  config's base/root/outDir match what nginx + compose.prod.yaml
  expect; `vite-plugin-solid` is the plugin layer (not raw Babel
  preset shenanigans).

### What agents ignore

- Style preferences.
- Things that "could be improved" but aren't bugs.
- Pre-existing issues already documented in `docs/todo.md`.
- Phase 5+ deferred items explicitly noted in todo.md or the active
  checkpoint.
- Test files for the server-side line-level scope agents (cross-module
  agent covers server-side test patterns; the cicchetto/ agent owns
  client-side tests since they are a small enough surface that scope
  + test review fit one agent).
- Phase 4 UI scope (irssi-shape redesign): keyboard layout, theme
  system, nick lists, mode indicators, topic bar, mobile ergonomics,
  voice I/O. The walking-skeleton UI is intentionally rough until
  Phase 4 — flag bugs but not "the layout is messy."

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
| Abstraction boundaries | Leaky abstractions, contexts reaching into each other's schemas, return types that force callers to parse. Includes the server↔client boundary: does cicchetto's `api.ts` consume domain types or does it re-shape on the client? |
| Responsibility & cohesion | Does each context have ONE job? God modules, feature envy, misplaced logic (controller doing IRC parsing, schema doing PubSub broadcast, cicchetto component holding domain state instead of consuming it from `lib/networks.ts` store). |
| Duplication | Same problem solved differently, copy-pasted code with tweaks, parallel structures that drift. Canonical cases: wire-shape unification across REST/PubSub/Channel/Phase-6 listener AND across server `Wire` modules ↔ cicchetto `api.ts` types. |
| Dependency architecture | Dependency direction (web → contexts → schemas; cicchetto components → `lib/*.ts` stores → `api.ts` + `socket.ts`), import cycles (TS module cycles + Elixir `Boundary` cycles), hidden coupling via `Application.put_env` (server) or module-level mutable state (client), supervision-tree ordering invariants. |
| Type system leverage | Atoms-or-typed-literals on the server (CLAUDE.md "never untyped strings"), structs over maps in domain returns, custom Ecto types over `:map`. On the client: TS `strict` + `noUncheckedIndexedAccess`, branded/opaque types over bare `string` for keys (the `ChannelKey` pattern), exhaustive switch over closed unions, `unknown` narrowing instead of `any`. `@spec` discipline (Dialyxir `:underspecs`) on the server side. |
| Extension & maintainability | Adding a new IRC kind = touching 15 files (server `kind` enum + Wire + cicchetto `MessageKind` union + ScrollbackPane render + tests)? Adding a new context = touching the supervision tree? Config sprawl across `config/*.exs` AND `cicchetto/{tsconfig,vite,vitest,biome}.json`? Test architecture (lib/ mirror vs outcome-tested; client `__tests__/` colocated). |

Each agent reads files across the ENTIRE codebase (server + cicchetto)
as needed — they follow the concern, not a directory boundary.

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
  a wire payload; the IRC parser leaking byte-shape into the domain;
  cicchetto components reaching past the `lib/networks.ts` store
  to call `api.ts` directly when the store would handle dedup +
  caching; cicchetto re-implementing wire validation that the server
  Wire module already enforces.
- **Responsibility violations:** business logic in controllers,
  display/wire shape in schemas, IRC framing in Session.Server,
  upstream connection state in the Bootstrap Task; on the client,
  components owning store-shape state, REST/WS coordination logic
  in component code (belongs in the store), or tests fixturing
  through the DOM when an outcome assertion against the store would
  be more honest.
- **Duplicated patterns:** two places building wire shapes
  differently for the same domain entity (canonical: server `Wire`
  module vs cicchetto `api.ts` types — these MUST stay in
  lockstep); two places parsing IRC prefixes; the test harness
  duplicating logic that should live in `Grappa.IRCServer` or
  `Grappa.DataCase`; cicchetto repeating REST-error-shape parsing
  in multiple call sites instead of going through `readError`.
- **Dependency violations:** schemas importing from contexts,
  contexts importing from `GrappaWeb`, the `IRC.Parser` reaching
  into Scrollback, supervision tree ordering invariants that are
  load-bearing but not documented; cicchetto modules importing in a
  cycle (`auth ↔ api`), components importing from sibling
  components (should go through stores), `lib/socket.ts` reaching
  into `lib/networks.ts` (should be the other direction).
- **Underused type system:** `String.t()` where an atom enum exists
  (e.g. anywhere a closed set of IRC commands appears), `:map`
  columns with caller-side key conventions instead of custom Ecto
  types (the `Grappa.Scrollback.Meta` pattern is the reference), `nil`
  fields that are never actually nil in practice; on the client,
  bare `string` where a branded type (`ChannelKey`-style) would
  catch type errors at compile time, `any` where `unknown` + a
  narrow would do, exhaustiveness gaps on closed unions, optional
  fields whose runtime value is never undefined.
- **Extensibility pain points:** adding a new IRC event kind
  requires changes in N files where N > 3 (server kind enum + Wire
  + cicchetto `MessageKind` + ScrollbackPane render + tests); adding
  a new metadata key requires extending an allowlist in M places; a
  new HTTP route requires controller + JSON view + channel + test +
  cicchetto api.ts type + cicchetto store integration all in
  parallel without shared shape.

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
- `README.md` "Phases" section (phase plan + intent)
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
