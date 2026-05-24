# CODEGEN — wireTypes.ts from server-side Wire typespecs

**Date**: 2026-05-24
**Author**: brainstorm session (vjt + Claude SIBLING autopilot)
**Status**: approved — proceed to plan

## What this fixes

Drift between server-side `Grappa.*.Wire` typespecs and cic-side
hand-rolled types in `cicchetto/src/lib/api.ts`. Per the
2026-05-22 codebase review (§ "Direction recommendation"), this drift
is the bug class behind:

- C1 — cic `WireAdminEvent` missing two server-emitted arms
  (`upload_reaped` + `uploads_swept`); `assertNever` crash on emit
- C2 — `capacity_reject.flow` typed `"user" | "visitor"` on cic;
  server emits 5-arm `Admission.flow()` atom union
- H1 — duplicated `joined`/`join_failed`/`kicked` narrowers in
  `wireNarrow.ts` AND `userTopic.ts`
- H2 — `connection_state_changed.from`/`to` typed open `string` on
  cic; server emits closed `Credential.connection_state()` atom
- H3 — `away_confirmed.state` typed `String.t()` server-side; manual
  `to_string(atom)` at the call site is the only enforcement
- H4 — `topic_changed.topic` and `channel_modes_changed.modes`
  declared untyped `map()` server-side; cic narrowers are the only
  contract
- H6 — `Networks.connect/disconnect/mark_failed` pattern-match a
  subset of `Credential.connection_states/0` without explicit
  fallthrough
- M19 — `mentions_bundle.messages[*].sender_nick:` vs sibling
  `ScrollbackMessage.sender:` (REV-K paid this down for the field
  name, codegen would prevent recurrence)
- M20 — REST error envelope uses `error:`, WS Channel uses `reason:`
  for the same conceptual error

All nine findings share one root: cic and server independently
type the same wire shape. Code review at cluster time catches
some drift; the rest leaks. Replacing hand-rolled cic types with
a generated mirror closes the class STRUCTURALLY — adding a field
server-side breaks `bun run check` on cic, period.

## Approach

### Architecture

Single mix task `Grappa.GenWireTypes` reads `@type` definitions
from every module under `lib/grappa/**/wire.ex` (or annotated with
`@wire_module true`), emits ONE deterministic file at
`cicchetto/src/lib/wireTypes.ts`. The file is committed; CI fails
if drift exists (`mix grappa.gen_wire_types --check` re-generates
in a tmp dir, diffs against committed file).

```
lib/grappa/<context>/wire.ex   →  reads @type declarations
                                  via Code.Typespec.fetch_types/1
                                  + AST walk for nested literals
                                  ↓
mix grappa.gen_wire_types       →  collects, normalizes, emits TS
                                  ↓
cicchetto/src/lib/wireTypes.ts  →  imported by api.ts (which
                                  re-exports + adds REST-only
                                  aggregate types)
                                  ↓
cic narrowers (wireNarrow.ts +  →  cast `unknown` payloads to
userTopic.ts)                       generated discriminated unions
```

Existing per-module convention:

- Wire modules at `lib/grappa/<context>/wire.ex` (10 today:
  accounts, admin_events, cic, networks, query_windows,
  read_cursor, scrollback, server_settings, session, visitors)
- Each Wire module already has `@type X_payload :: %{...}`
  declarations describing one event payload
- Discriminator convention varies: some use `kind: :atom_literal`
  (admin_events.ex line 63 onwards, networks.ex line 47),
  some use `kind: String.t()` (session.ex line 87 onwards) —
  inconsistent; cluster fixes session.ex to use atom literals
  before codegen runs

### Generation conventions

**Atom literals**: `:visitor` → TS string literal `"visitor"`.
Discriminator kinds preserved as literals so cic gets discriminated
unions. Atom unions like `:user | :visitor` → `"user" | "visitor"`.

**Standard scalars**:
- `String.t()` → `string`
- `integer()` / `non_neg_integer()` / `pos_neg_integer()` → `number`
- `boolean()` → `boolean`
- `map()` → `Record<string, unknown>` (with WARNING during codegen —
  bare `map()` defeats the purpose; H4 finding says fix these)
- `nil` → `null`
- `T | nil` → `T | null`

**Lists**: `[T]` → `T[]`

**Tuples**: `{a, b}` → `[A, B]` (cic doesn't use tuples but they appear
in JSON as fixed-arity arrays via Jason). Flag during codegen.

**Cross-module references**: `Credential.auth_method()` resolves via
`Code.Typespec.fetch_types(Credential)`. Chains followed transitively;
emitted as TS aliases at top of `wireTypes.ts`. Cycle detection bails
loudly (Wire types shouldn't have cycles).

**Union discrimination**: when multiple `@type X_payload :: %{kind:
:literal, ...}` declarations exist in one module, codegen ALSO emits
a union type `export type WireXEvent = X1Payload | X2Payload | ...`.
The discriminating field is detected as the field whose value is a
literal across all arms.

**Module-to-TS naming**:
- `Grappa.AdminEvents.Wire.upload_reaped_event` → `UploadReapedEvent`
- `Grappa.Scrollback.Wire.t` → `ScrollbackWireMessage` (when `t` is
  the canonical type — moduledoc convention)
- `Grappa.Session.Wire.joined_payload` → `JoinedPayload` (drop the
  `_payload` suffix? KEEP — distinguishes payload from name)
  
Decision: keep `_payload` suffix; emit verbatim camelCase. Avoids
collision-by-rename and preserves grep-back-to-Elixir.

### File shape

`cicchetto/src/lib/wireTypes.ts`:

```ts
// GENERATED FILE — DO NOT EDIT
// Run `scripts/mix.sh grappa.gen_wire_types` to regenerate.
// Source: lib/grappa/**/wire.ex

// === Grappa.AdminEvents.Wire ===

export type CircuitOpenEvent = {
  kind: "circuit_open";
  network_id: number;
  network_slug: string | null;
  threshold: number;
  cooldown_ms: number;
  at: string;
};

// ... more types ...

export type WireAdminEvent =
  | CircuitOpenEvent
  | CircuitCloseEvent
  | /* ... all 13 arms ... */;

// === Grappa.Scrollback.Wire ===
// ...
```

Deterministic ordering: modules alphabetical, types within module in
source order (preserves docstring intent + grep-friendliness).

### Consumer migration

`cicchetto/src/lib/api.ts` currently re-declares all wire types. Post-
codegen:

```ts
// Was:
export type WireAdminEvent = /* hand-rolled 11-arm union */;

// Becomes:
export type { WireAdminEvent } from "./wireTypes";
```

REST-only types (LoginResponse, MeResponse, AdminSnapshotPayload-as-
envelope) stay in api.ts because they aren't 1:1 wire-shape mirrors —
they aggregate or transform.

The two narrowers (`wireNarrow.ts` + `userTopic.ts`) cast `unknown`
to generated types verbatim; no other change needed.

### CI gate

Append to `scripts/check.sh` (after Elixir gates, before bats):

```bash
"$SRC_ROOT/scripts/mix.sh" grappa.gen_wire_types --check
```

`--check` flag: regenerate to `/tmp/wireTypes.ts`, diff against
committed `cicchetto/src/lib/wireTypes.ts`, exit non-zero if drift.
The error message tells the operator: "run `scripts/mix.sh
grappa.gen_wire_types` and commit the result."

## Bucket cadence

Order is load-bearing: A first (convention sweep) so B can codegen
cleanly. C migrates consumers (TS imports). D adds CI gate.

### Bucket A — Wire-module convention sweep

Fix every `kind: String.t()` to `kind: :atom_literal` in
`lib/grappa/session/wire.ex` (currently 12 payloads use `String.t()`
because the moduledoc explicitly documents "kind: STRING JSON-wire
convention"; codegen needs the atom literal at the TYPE level to
discriminate). `to_json/1` already wraps with `Atom.to_string/1` —
no runtime change.

Also: H4 fix (promote `topic_changed.topic` + `channel_modes_changed.
modes` from `map()` to typed `@type t :: %{required(...)}`). Per the
2026-05-22 review, H4 is part of REV-H (deferred) — codegen forces
the issue.

No new tests beyond existing Wire-module tests (they already exercise
`to_json/1` shapes; type changes are compile-time-only — Dialyzer
catches drift).

### Bucket B — `Grappa.GenWireTypes` mix task

`lib/mix/tasks/grappa.gen_wire_types.ex` reads Wire modules,
parses `@type` declarations via `Code.Typespec.fetch_types/1`,
emits `cicchetto/src/lib/wireTypes.ts` deterministically.

Includes:
- `--check` flag (regenerate + diff vs committed; exit 1 on drift)
- ExUnit test suite at `test/mix/tasks/grappa/gen_wire_types_test.exs`
  covering: every standard type mapping, atom union, nested map,
  cross-module reference, deterministic ordering, `--check` exit codes

Output file committed to `cicchetto/src/lib/wireTypes.ts`. No cic
consumer migration yet — file exists but is unused.

### Bucket C — Migrate api.ts to import from wireTypes.ts

Edit `cicchetto/src/lib/api.ts`:
- Replace hand-rolled wire types with `export type { X } from
  "./wireTypes"` aliases
- REST-only aggregate types stay in api.ts (Login/Me/Admin*
  responses are not direct wire mirrors)

Update narrowers if any type-name changed (likely none if codegen
follows the existing naming).

Run `bun run check && bun run test` to verify zero regressions.

Browser smoke: open admin events tab + connect to a network →
confirm no console errors during a live cap_counts_changed event.

### Bucket D — CI gate

Append `mix grappa.gen_wire_types --check` to `scripts/check.sh`
(after `ci.check`, before `bats.sh`). Drift between server typespec
+ committed `wireTypes.ts` fails the build with a clear message
telling the operator to regenerate.

Per `feedback_landed_claim_evidence`: full `scripts/check.sh` exit-0
+ tail paste at bucket close.

## Per-bucket deploy cadence

Per `feedback_per_bucket_deploy`:

- **A** — server typespec changes; preflight detects HOT (no
  `application.ex`, no migrations, no `long_lived_modules`, just
  typespec-only edits in `lib/grappa/*/wire.ex`). HOT deploy.
- **B** — mix task new file + new test + new generated `wireTypes.ts`;
  the test exercises against committed shape so CI is the smoke. No
  prod-runtime impact (mix task isn't on the hot path).
- **C** — cic-only: `cicchetto/src/lib/api.ts` + maybe narrowers.
  HOT cic deploy via `scripts/deploy-cic.sh`. Browser smoke.
- **D** — `scripts/check.sh` modification; not a deploy. CI verifies
  the new gate works.

## Hard rules carry-forward

- Worktree FIRST for production code per CLAUDE.md Development Cycle.
- No `@skip` / `--grep` exclusions to mask failing specs.
- No weakening production code to make tests pass.
- `scripts/check.sh` exit-0 + literal tail paste at each LANDED claim.
- Code review per bucket via `code-review:loop` per
  `feedback_subagent_driven_development`.
- Per CLAUDE.md "Implement once, reuse everywhere": cic-side hand-
  rolled types are duplication that codegen eliminates.

## Out of scope

- **No runtime validation generation**. wireTypes.ts gives compile-
  time discrimination only; `wireNarrow.ts` + `userTopic.ts`'s
  runtime narrowers stay hand-coded (small, well-tested, the
  validation logic isn't drift-prone — the type drift is what
  caused C1/C2/H1-H6).
- **No REST aggregate type generation**. MeResponse, LoginResponse,
  AdminSnapshotPayload-envelope etc. are cic-side concepts that
  combine multiple wire types; they stay in api.ts.
- **No JSON Schema or zod**. Two-layer generation (Elixir → schema →
  TS) adds maintenance for no gain when the producer + consumer
  are both single-language at the boundary.
- **No build-time generation in Vite**. The file is committed so git
  diffs surface drift; CI gate catches stale commits. Build-time
  generation loses the "static file under review" property.
- **REV-G H22 SW denylist / REV-H Theme A continued**: already
  closed in REV-G + REV-H buckets per `project_rev_cluster_closed`
  memory. Not re-scoped here.

## Risks & open questions

- **Atom-literal convention in session.ex**: 12 payloads use
  `kind: String.t()`. The moduledoc cites "kind: STRING JSON-wire
  convention" — the convention is about the WIRE shape (it IS a
  string post-`Atom.to_string/1`); the TYPESPEC can be the atom
  literal because Elixir's `String.t() | nil` and `:atom_literal`
  are both valid spec-side declarations of "this slot carries the
  literal value." `to_json/1` already converts. Risk: a Wire-module
  test asserts `kind: "joined"` (string) and atom literal in spec
  breaks the assertion — confirm during bucket A that tests pass.

- **Cross-module type resolution depth**: `Credential.auth_method()`
  → `AuthFSM.auth_method()` → atom union. Codegen must follow
  module aliases + transitively resolve. Cycle protection: depth
  limit (5?) + cycle Set; raise loudly on either trigger.

- **`map()` bare type**: bucket A includes promoting H4 sites; if
  ANY remaining `map()` exists in a Wire module post-A, codegen
  emits `Record<string, unknown>` with a stderr WARNING. CI doesn't
  fail (warning, not error) — operator fixes in the next pass.

- **api.ts re-export pattern**: TS allows `export type { X } from
  "./other"`. Verify the existing biome config doesn't trip on
  this shape. If it does, drop re-export, have callers import
  directly from wireTypes.ts.

- **Operator workflow when adding a field**:
  1. Add field to `Grappa.X.Wire` typespec + `to_json/1`
  2. Run `scripts/mix.sh grappa.gen_wire_types`
  3. Commit `lib/grappa/x/wire.ex` + `cicchetto/src/lib/wireTypes.ts`
     in one commit
  4. Cic code that uses the new field compiles; cic code that
     doesn't, compiles unchanged
  
  vs today's workflow which is: edit two unrelated files in two
  different commits, hope nothing drifts. The 1-second `mix
  grappa.gen_wire_types` run is the small tax that closes the
  drift class.

## Memory hooks worth re-reading during implementation

- `feedback_plan_vs_production_reality` — follow production if plan
  disagrees, record deviation in commit body
- `feedback_per_bucket_deploy` — deploy cadence
- `feedback_landed_claim_evidence` — gate-tail paste at LANDED
- `feedback_atomic_css_pattern` — ship coherent pieces together
- `feedback_subagent_driven_development` — code-review:loop per
  bucket
- `feedback_push_autonomy` — push without sign-off when green
- `project_ux_8_cluster_closed` — previous cluster, same shape
  (brainstorm → spec → plan → autopilot exec)
