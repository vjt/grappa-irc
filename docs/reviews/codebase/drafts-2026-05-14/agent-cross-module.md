# Codebase Review Draft — Cross-Module Patterns
**Agent:** cross-module
**Scope:** server-wide patterns across `lib/grappa/**` + `lib/grappa_web/**` + `mix.exs` + `config/*`
**Date:** 2026-05-14
**Cluster commits reviewed:** B0 (`/invite` skip requireChannel) → B1 (EventRouter fallthrough → structured `:notice`) → B2 (inbound INVITE [Join] CTA + numeric-double-write fix) → B3 (Bahamut numerics audit) → B4 (clickable URLs in scrollback). The previous cross-module sweep was at commit `730f2c8` (2026-05-12, drafts-2026-05-12).

## Summary table

| Severity | Count |
|----------|-------|
| CRIT     | 0     |
| HIGH     | 1     |
| MED      | 5     |
| LOW      | 3     |
| NIT      | 1     |

Cluster delta vs 2026-05-12 review: prior **S2** (Logger interpolation) FIXED — `auth_controller.ex:204` now uses structured metadata + `:socket_id` is in the allowlist. Prior **S1** (hot-reload preflight blind to map-shape) was already addressed by `lib/grappa/hot_reload/long_lived_modules.ex` extraction (the doc, script and Dialyzer share a single source of truth). Prior **S4** (`Cic.Wire`) FIXED — `lib/grappa/cic/wire.ex` exists and `admin_controller.ex` uses it (boundary `exports: [Bundle, Wire]` in `grappa_web.ex:18`). Prior **S5** (`compile_env!` for `:visitor_network`) NOT FIXED (still LOW now — see X3). Prior **S7** (`:toml` dep) NOT FIXED (see X4). Prior **S10** (`map()` returns) PARTIALLY drifted — `whois_merge` is the same; one new `map()` spec (`scrollback/meta.ex:185 atomize_known`) is internal-only.

The cluster's main novelty is the **EventRouter catch-all** (B1, `event_router.ex:1519`). It closes a real silent-drop class but introduces three cross-module shape concerns documented below — the highest-severity new item this sweep.

## CRITICAL

_None._

## HIGH

### X1. EventRouter catch-all writes mixed-key meta — atom outer + string inner — escaping `Scrollback.Meta` allowlist discipline
**Files:**
- `lib/grappa/session/event_router.ex:1519-1533` (`route/2` catch-all)
- `lib/grappa/scrollback/meta.ex:96-112` (`@type t` + `@known_keys`)
- `lib/grappa/scrollback/meta.ex:155-162` (`dump/1` strict allowlist)

**Description (cross-module aspect explicit):** the new B1 catch-all builds:
```elixir
meta = %{
  raw: %{
    "verb" => command_to_verb_string(command),
    "sender" => sender,
    "params" => params
  }
}
```
The OUTER key (`:raw`) is correctly atom-keyed and on the allowlist. The INNER map (`raw.verb`, `raw.sender`, `raw.params`) uses **raw string keys** for fields that are themselves a closed set across the codebase. This is a CROSS-CONTEXT shape contract: `Scrollback.Meta` is the central registry for every meta atom, and the contract is "closed-set keying with `Enum.find` lookup so the global atom table can't be inflated by attacker input." The inner map silently bypasses that contract — three new well-known field names (`verb`/`sender`/`params`) live as untyped strings with no central registry, no Logger-allowlist sync test, no Dialyzer visibility.

The cic side reads them as strings (`renderRawEvent` in `ScrollbackPane.tsx:269` typed as `{verb?: string; sender?: string; params?: string[]}`), which works today but means the contract is enforced twice in two languages with zero schema cross-check. Per CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped strings for closed sets," and per `Scrollback.Meta`'s own moduledoc "explicit central registry, not implicit drift," the inner map should be promoted to either:
- (a) a sibling `Grappa.Scrollback.RawEventMeta` module with an `@type t` and a documented allowlist of inner atoms, OR
- (b) flat atom keys at the outer level (`%{raw_verb: ..., raw_sender: ..., raw_params: ...}`) with all three added to `@known_keys` + Logger allowlist.

Option (b) is the cheaper fix and matches the existing pattern (every other meta field is flat atom-keyed). Option (a) is the right call if more nested meta shapes are anticipated.

The "inflate atom table" risk is genuine for INNER values too: `params` is upstream-controlled string list of arbitrary length and content, currently flowing through `dump/1` → JSON → DB → `load/1` → atomize-known. The OUTER `:raw` key passes the allowlist, so the inner map's keys/values are NEVER atomized (good — they survive as strings). But that's a load-bearing accident, not a documented contract — a future refactor of `Meta.atomize_known/1` to recurse into nested maps would atomize attacker-controlled `params` strings.

**Recommended fix:** flatten to three atom-keyed top-level fields (`raw_verb: String.t(), raw_sender: String.t(), raw_params: [String.t()]`); add all three to `Scrollback.Meta.@known_keys` + `@type t`; the existing `meta_test.exs:125-130` "Logger allowlist sync" assertion catches the cross-config drift automatically. Cic's `renderRawEvent` reads `msg.meta.raw_verb` etc. — same shape from cic's perspective, just lifted one level.

## MEDIUM

### X2. EventRouter catch-all reuses `:notice` kind for non-notice events — tags wrong domain class on every unhandled verb
**Files:**
- `lib/grappa/session/event_router.ex:1531` (`build_persist(state, :notice, "$server", ...)`)
- `lib/grappa/scrollback/message.ex:89-100` (`@kinds` enum)
- `lib/grappa/scrollback/message.ex:102` (`@body_required_kinds`)
- `lib/grappa/scrollback/message.ex:123` (`@dm_with_eligible_kinds`)

**Description:** the catch-all writes `kind: :notice` for KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, AUTHENTICATE, **inbound INVITE**, and every vendor verb. `:notice` is a CONTENT kind (per `Message.@body_required_kinds` it's required to have a body, per `Message.@dm_with_eligible_kinds` it can carry DM peer info). None of those properties hold for KILL/WALLOPS/CHGHOST/INVITE — they're presence/server-event kinds.

This isn't currently broken (body fallback is `""`, dm_with stays nil), but the kind-enum is the codebase's domain-class discriminator. Any future code that filters `kind in [:privmsg, :notice, :action]` to mean "human content" — and several places do — will incorrectly include KILL/WALLOPS/CHGHOST rows. The closed-set discipline is undermined the moment "the kind is `:notice` because we didn't have a better one" enters the data path.

CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped strings for closed sets. Reject unknown values at the boundary." The right move is either:
- (a) introduce `:server_event` (or `:raw`) as a new kind in `@kinds`, with `:body` not required and `:dm_with` not eligible (matches the actual semantics), OR
- (b) document explicitly that `:notice` is the catch-all bucket and audit every `kind in [...]` filter site to confirm the intent matches.

Option (a) is the closed-set-discipline answer.

Inbound INVITE (B2) is the most visible case: cic's renderRawEvent has a dedicated arm (`ScrollbackPane.tsx:320-345`) with [Join] CTA, but on the persistence side the row reads `kind: :notice` — anyone querying scrollback for "actual NOTICEs from the network" gets every CHGHOST, KILL, INVITE etc. mixed in.

**Recommended fix:** add `:server_event` to `@kinds`, mirror the `:body_required_kinds` exclusion, leave `:dm_with_eligible_kinds` unchanged (server events are never DMs). Update `event_router.ex:1531` and the typed `:invite_ack` effect (which is wire-only and not persisted). Migrate any pre-existing `:notice` rows with `meta.raw` present in a one-shot data backfill if needed.

### X3. `Application.compile_env(:grappa, :visitor_network)` (no bang) silently nils — UNCHANGED since 2026-05-12
**Files:**
- `lib/grappa_web/controllers/auth_controller.ex:58` — `@visitor_network_slug Application.compile_env(:grappa, :visitor_network)`
- `lib/grappa/visitors/login.ex:69` — `@visitor_network Application.compile_env(:grappa, :visitor_network)`

**Description:** prior cross-module review S5 — still present. `compile_env/2` returns `nil` if the key is absent; both modules use the result in string-compare guards. Today `config/config.exs:17` sets the default so nothing breaks, but a missing `:visitor_network` key in any future config split (per-environment override, release task) silently turns visitor-auth into a fall-through. Sibling `endpoint.ex:33` and `admission.ex:73` use `compile_env!`. Half-pattern.

**Recommended fix:** flip both to `compile_env!(:grappa, :visitor_network)`. If a deployer wants to disable visitor-auth, they set the key to `:disabled` and code branches explicitly.

### X4. Dead `:toml` dep still in `mix.exs` — UNCHANGED since 2026-05-12
**File:** `mix.exs:92` — `{:toml, "~> 0.7"}`

**Description:** prior S7 — config is DB-driven (Phase 2 sub-task 2j); zero references to `:toml`/`Toml.` in `lib/` or `test/`. Carrying the dep loads the OTP application at boot for nothing and adds a CVE-tracking surface for `mix.audit`.

**Recommended fix:** remove the line + `mix deps.unlock --unused` + `mix deps.clean toml`. Verify `scripts/check.sh` still green.

### X5. NumericRouter delegates 321/322/323 + 364/365 to EventRouter with NO clauses there — guaranteed silent drop the moment cic wires /list or /links
**Files:**
- `lib/grappa/session/numeric_router.ex:143-163` (delegated list with new TODO comment)
- `lib/grappa/session/event_router.ex:1498` (numeric clause returns `{:cont, state, []}`)

**Description:** the bucket-3 finding (commit `730f2c8`) honestly documents the trap as a TODO: NumericRouter routes 321/322/323 (LIST replies) + 364/365 (LINKS) to EventRouter, but EventRouter has no dedicated clauses, so the new numeric-suppression clause at `event_router.ex:1498` returns `[]` effects → silent drop. The TODO documents "land EventRouter clauses + cic UI in the same commit" as the contract.

This is a CROSS-MODULE latent bug: NumericRouter promises delegation, EventRouter doesn't fulfill, Server.ex's numeric-handler skip path (server.ex:1545 only persists the `:notice` row when `numeric not in @delegated_numerics`) means these numerics neither persist via Server nor get effects via EventRouter. They are discarded entirely.

The TODO is good engineering (document the trap before the next agent steps in it), but it relies on a future agent to read the comment AND notice the cic UI is wiring up. CLAUDE.md "Read MORE than 30 lines of logs" + "Read before writing" — but a single grep for `321` won't find the trap; the agent has to land in numeric_router.ex first.

**Recommended fix:** either (a) MOVE 321/322/323 + 364/365 OUT of `@delegated_numerics` until cic wires them — then Server's default path persists them as plain `:notice` rows (visible, never silent), OR (b) add minimal EventRouter clauses now that emit the same `:notice` row Server would, so the delegation contract holds even before cic ships. Option (a) is one-line cheaper; option (b) keeps NumericRouter's domain (delegated = "EventRouter owns it") consistent.

### X6. Module-size drift: `Session.Server` 2650 LOC, `EventRouter` 2310 LOC — both grew vs prior review
**Files:**
- `lib/grappa/session/server.ex` (2388 LOC at 2026-05-12 → 2650 today, +262)
- `lib/grappa/session/event_router.ex` (1696 → 2310, +614)
- `lib/grappa_web/channels/grappa_channel.ex` (now 1234 LOC)

**Description:** prior cross-module review S3 flagged Session.Server as a god module (2388). The cluster grew it by 262 LOC and EventRouter by 614. These are still the two biggest modules in the codebase. The extraction discipline (`away_state.ex`, `ghost_recovery.ex`, `mode_chunker.ex`, `numeric_router.ex`, `ns_interceptor.ex`, `window_state.ex`) is established but isn't keeping pace with feature growth. EventRouter in particular is a single-file dispatch table that grows linearly with every IRC verb / numeric handled — it's reaching the size where Credo cyclomatic-complexity gates start firing on the catch-all itself.

The cross-module aspect: the pattern of "extract to a sibling under `session/`" already proven for state-helpers (window_state) and for numerics (numeric_router) hasn't been applied to EventRouter's verb families. WHOIS handling alone is ~150 LOC inside EventRouter; LUSERS folding is another ~120; INVITE-ack a smaller block; channel-mode handlers are interleaved with member handlers. Each of these would land cleanly as `event_router/whois.ex`, `event_router/lusers.ex`, etc. with EventRouter as a thin dispatcher.

**Recommended fix:** continue the extraction. Track as a follow-up cluster (`session-router-decomposition`). Suggested ceiling: `event_router.ex` + `server.ex` < 1500 LOC each.

## LOW

### X7. `whois_merge/2` typed as `map() -> map()` — accumulator has a known shape
**File:** `lib/grappa/session/event_router.ex:1958` — `@spec whois_merge(map(), map()) :: map()`

**Description:** prior S10 — same finding, unchanged. `whois_merge` folds 311/312/313/317/319 numerics into a structured WHOIS bundle that has a documented, closed shape (the `whois_extended` wire event). Typing it as `map()` defeats Dialyzer's `:underspecs` + `:unmatched_returns` (both enabled in `mix.exs:42-49`) and contradicts the codebase's "domain types, not maps" rule.

**Recommended fix:** define `@type whois_acc :: %{...}` with the actual fields and update both function signatures.

### X8. `put_subject_id/2` typed `map() -> map()` — could be `attrs() -> attrs()`
**File:** `lib/grappa/session.ex:975` — `@spec put_subject_id(map(), subject()) :: map()`

**Description:** internal helper used by `Session.Server` to attach subject identity to `Scrollback.Message` insert attrs. The "attrs" shape is well-defined (`network_id`, `channel`, `server_time`, `kind`, `sender`, `body`, `meta`, `dm_with`). Typing it as `map()` loses the contract. Lower priority than X7 because the call sites construct the literal map directly above the call.

**Recommended fix:** either inline at the three call sites (single line each) or define an `@type insert_attrs :: %{...}` and tighten the spec.

### X9. `atomize_known/1` typed `map() -> map()` — internal, OK with inline doc
**File:** `lib/grappa/scrollback/meta.ex:185`

**Description:** internal helper called only by `cast/1` and `load/1`. The general `map() -> map()` is honest because the function processes any incoming map (atomize allowlisted keys, leave others as strings — that's the lenient-out contract). Keep as-is; documented inline in the moduledoc.

**Recommended fix:** none. Listed for completeness vs prior review S10 which lumped all three together.

## NIT

### X10. `command_to_verb_string/1` could collapse the `{:numeric, n}` clause
**File:** `lib/grappa/session/event_router.ex:1535-1538`

**Description:**
```elixir
defp command_to_verb_string({:unknown, verb}) when is_binary(verb), do: verb
defp command_to_verb_string({:numeric, n}) when is_integer(n), do: Integer.to_string(n)
defp command_to_verb_string(atom) when is_atom(atom), do: atom |> Atom.to_string() |> String.upcase()
```
The numeric clause is dead — the previous `def route(%Message{command: {:numeric, _}} = _, state)` clause filters every numeric out before this helper is reached. The B1 commit comment calls this "belt-and-braces" which is fair; it's defensive. NIT only because dead-code defensiveness drifts: the moment someone removes the numeric-skip (or adds another caller of `command_to_verb_string/1`), the dead clause becomes live silently.

**Recommended fix:** drop the numeric clause OR add a `# belt-and-braces — see route/2 numeric skip` comment so the next agent doesn't refactor it as duplicate. The two-line comment is cheaper than the cognitive cost of remembering this is intentional.

## Trajectory risks

1. **`:raw` meta + `kind: :notice` overload (X1, X2) is the cluster's main shape debt.** B1 closed a real silent-drop class but introduced two contract drifts: a bypass of the closed-set atom registry (inner string keys) and a kind-enum overload (`:notice` for non-notices). Both are MED today because they're new. Both will become HIGH the moment the codebase grows a second consumer that filters by `kind` or recurses meta. The right time to fix is now while the catch-all has only landed once.

2. **Module-size drift accelerating (X6).** Session.Server +262 LOC and EventRouter +614 LOC across one cluster. The sibling-extraction pattern is well-established but isn't being applied to verb-family handlers inside EventRouter. At the current rate EventRouter crosses 3000 LOC by end of next cluster — Credo + Dialyzer get noisier, hot-reload preflight gets harder to reason about. A `session-router-decomposition` cluster soon would arrest this.

3. **Delegated-numerics-without-handler trap (X5) is documented but not closed.** TODO comments are good engineering when the fix is small AND the next reader will see them at the right moment. Here the trap doesn't fire until cic wires `/list` or `/links` — by which time the original agent is long gone and the new agent is in `cicchetto/` or `grappa_channel.ex`, NOT `numeric_router.ex`. Fix it now (option (a) is one line).

4. **Half-fixed prior findings (X3, X4) are old and cheap.** `compile_env!` flip is two lines; toml dep is one line + `deps.unlock`. These were flagged 2 days ago. The Total Consistency or Nothing rule from CLAUDE.md applies — they should land in the same cluster's housekeeping commit.

5. **What's still working well (zero counts worth recording):**
   - `\\` default arguments in `def`/`defp` across `lib/`: **0** (the `mix/tasks/grappa.*` matches in the grep are inside `@moduledoc` heredoc examples for shell continuations, not real defaults)
   - `String.to_atom/1` from external input: **0**
   - Bare `rescue _` / `catch _, _`: **0** (every rescue is bounded `ArgumentError` / `Ecto.NoResultsError` / `NoServerError` with an inline WHY comment)
   - `Repo.insert/2` without changeset: **0**
   - Inline-interpolation Logger calls: **0** (S2 fix held)
   - Runtime `Application.put_env`: **0** (every match is mix-task pre-boot or boot/0)
   - Runtime `Application.get_env` outside documented exception: **0** (every match is `Admission.Config.boot/0` or `application.ex` start_bootstrap toggle, both documented)
   - Cross-context schema imports from `lib/grappa_web/`: present but exclusively as type aliases for pattern matching and `@spec` clarity, never schema-function calls; `grappa_web.ex:11-32` Boundary `deps:` enumerates exactly the context modules and Ecto helpers
   - Wire-shape modules: every PubSub-publishing context has a `wire.ex` (`accounts/wire.ex`, `cic/wire.ex` NEW, `networks/wire.ex`, `query_windows/wire.ex`, `scrollback/wire.ex`, `session/wire.ex`, `visitors/wire.ex`)
   - `Grappa.HotReload.LongLivedModules` extraction (since prior review): single-source-of-truth list parsed by `scripts/deploy.sh`, type-checked by Dialyzer, doc'd in CLAUDE.md — eliminates the doc/script/code drift class entirely
