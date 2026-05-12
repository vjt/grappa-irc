# Codebase Review Draft — Cross-Module Patterns
**Agent:** cross-module
**Scope:** server-wide patterns across `lib/grappa/**` + `lib/grappa_web/**` + `test/**` + `config/*` + `mix.exs`
**Date:** 2026-05-12

The codebase is unusually disciplined for its age. The cross-module
sweep found ZERO instances of the canonical anti-patterns CLAUDE.md
warns about: zero `\\` default arguments in any `def`/`defp` across
118 lib files, zero `String.to_atom/1`, zero bare `rescue _` /
`catch _, _`, zero raw `Repo.insert/2` without changeset, zero
`Application.put_env` from a controller/plug/GenServer/context, zero
direct `:gen_tcp` mocking in tests, zero call-sequence assertions.
The remaining findings are concentrated in three themes: hot-reload
preflight blind spots, one Logger metadata leak, and Session.Server
god-module concentration.

## CRITICAL

_None._

## HIGH

### S1. Hot-reload preflight blind to long-lived GenServer map-state shape changes
**Files:**
- `lib/grappa/session/server.ex:392-460` (`init/1` — `state = %{...}` ~30 keys, no `defstruct`)
- `lib/grappa/ws_presence.ex:184-191` (`init/1` — `%{sockets: %{}, notify_pids: %{}, refs_to_user: %{}}`, no `defstruct`)
- `scripts/deploy.sh` preflight (per CLAUDE.md "Hot vs cold deploy")
**Category:** OTP / hot-reload safety
**Severity:** HIGH

CLAUDE.md's hot-deploy preflight explicitly enumerates "long-lived
GenServer modules (Session.Server, IRC.Client, AuthFSM, WSPresence,
Admission.NetworkCircuit)" and triggers a cold deploy when a
`defstruct` line is modified. But `Session.Server` and `WSPresence`
DON'T HAVE a `defstruct` — both carry their state as bare maps. The
preflight regex is structurally incapable of detecting a state-shape
change in the very modules listed as the highest-risk source of
deferred crashes.

`Session.Server`'s state map is touched via `state.foo` / `state, foo:`
137 times across the file. Adding/removing a key in the `init/1`
literal is invisible to a `defstruct`-based diff check. The deferred-crash
class CLAUDE.md was designed against (`feedback_hot_deploy_preflight`)
arrives silently on the next `handle_info` that pattern-matches the
new shape — could be hours later.

`IRC.Client` (`lib/grappa/irc/client.ex:101`) and `AuthFSM`
(`lib/grappa/irc/auth_fsm.ex:103`) DO use `defstruct` and ARE caught.
Backoff and NetworkCircuit hold state in ETS with empty `%{}` GenServer
state (intentionally — no shape risk).

**Fix:** Either (a) introduce `defstruct` on Session.Server +
WSPresence so the preflight regex catches edits, or (b) extend the
preflight to also flag any change to `init/1`'s state-literal in the
five enumerated modules (grep for `def init` + same-file `%{` literal
diff is sufficient). Path (a) also lets Dialyzer typecheck state-key
access; path (b) is a deploy-script-only change.

### S2. Logger interpolation leaks unallowlisted metadata key
**File:** `lib/grappa_web/controllers/auth_controller.ex:204`
**Category:** logging discipline
**Severity:** HIGH

```elixir
Logger.warning("logout disconnect broadcast failed for #{socket_id}",
  reason: inspect(reason)
)
```

`socket_id` is interpolated into the message string instead of riding
as structured metadata. Per memory `project_logging_format` the
allowlist in `config/config.exs:110-160` is the contract; `socket_id`
is NOT in it. This is the SOLE inline-interpolation Logger call
across the entire `lib/` tree (52 other Logger calls all use KV
metadata correctly).

**Fix:** Add `:socket_id` to `config/config.exs` Logger metadata
allowlist (next to `:session_id`, `:authn_failure`), then rewrite as
`Logger.warning("logout disconnect broadcast failed", socket_id: socket_id, reason: inspect(reason))`.

## MEDIUM

### S3. Session.Server is a 2388-line god module
**File:** `lib/grappa/session/server.ex` (2388 lines), `lib/grappa/session/event_router.ex` (1696 lines)
**Category:** cohesion / maintainability
**Severity:** MEDIUM

`Session.Server` is 2.7× the size of the next largest module
(`grappa_channel.ex` at 930). The `lib/grappa/session/` directory
already shows a partial extraction discipline (`window_state.ex`,
`away_state.ex`, `ghost_recovery.ex`, `mode_chunker.ex`,
`numeric_router.ex`, `ns_interceptor.ex` are all extracted siblings
of `event_router.ex`) — but the GenServer itself and the event router
remain enormous. Combined: ~4084 lines of session code that's hot-path
to every IRC event, every cic broadcast, every reload safety call.

This is not a "split for splitting's sake" call: the cross-module
finding is that the session-internal extraction discipline already
established (one concern → one module under `session/`) hasn't been
applied to the GenServer's `handle_info` clauses themselves. The
event_router IS the in-flight extraction; finishing it should drain
~400-600 more lines from server.ex.

**Fix:** Track as a follow-up cluster — continue the
event-router-style extraction by topic (IRC verb family per module),
target server.ex < 800 lines as the operational ceiling.

### S4. `Grappa.Cic.Bundle` broadcasts inline payload, no `Cic.Wire`
**Files:**
- `lib/grappa_web/controllers/admin_controller.ex:67` (`payload = %{kind: "bundle_hash", hash: hash}`)
- `lib/grappa/cic/bundle.ex` (no `wire.ex` sibling)
**Category:** wire-shape discipline
**Severity:** MEDIUM

Every other context that publishes to PubSub has a `wire.ex` module
(`accounts/wire.ex`, `networks/wire.ex`, `query_windows/wire.ex`,
`scrollback/wire.ex`, `session/wire.ex`, `visitors/wire.ex`).
`Grappa.Cic.Bundle` publishes its `bundle_hash` payload as a literal
map at the controller call site. CLAUDE.md "Wire conversion is
per-context responsibility" — and the CP15 B6 finding cited there
was exactly this: ad-hoc payload construction at the broadcast site
drifts from the consumer's expected shape silently.

It's a single-field payload today, but the `cic_bundle_changed`
endpoint is the canonical operator-touched surface, and any future
field addition (e.g. `built_at` ISO timestamp, `git_sha`,
`cicchetto_version`) lands at the controller — at which point the
boundary discipline is already lost.

**Fix:** Add `lib/grappa/cic/wire.ex` with
`bundle_hash_payload(hash) :: %{kind: String.t(), hash: String.t()}`
exporting `Grappa.Cic.{Bundle, Wire}` from the boundary. Inline
construction in `admin_controller.ex:67` becomes
`CicWire.bundle_hash_payload(hash)`.

### S5. `compile_env` (no bang) on required `:visitor_network` slug
**Files:**
- `lib/grappa_web/controllers/auth_controller.ex:58` — `@visitor_network_slug Application.compile_env(:grappa, :visitor_network)`
- `lib/grappa/visitors/login.ex:69` — `@visitor_network Application.compile_env(:grappa, :visitor_network)`
**Category:** configuration discipline
**Severity:** MEDIUM

`Application.compile_env(:grappa, :visitor_network)` returns `nil` if
the key is absent. Both `auth_controller` and `visitors/login` use
that nil in string compare guards — a typo'd or omitted config key
yields silent visitor-login failure (compares against `nil`, never
matches a real slug, every visitor login takes a fall-through path).

`config/config.exs:17` does set the default, so today there's no
breakage — but the CLAUDE.md rule "Reject unknown values at the
boundary" applies: a missing `:visitor_network` config IS an unknown
boundary state for visitor-auth code, and the contract should be
loud at compile time.

`endpoint.ex:33` correctly uses `compile_env!` for the signing salt;
`admission.ex:73` uses it for the per-network cap default. Same
pattern should apply here.

**Fix:** Change both call sites to `compile_env!(:grappa,
:visitor_network)`. If a deployer wants to disable visitor-auth, they
can set the key to a sentinel (`:disabled` atom) and the code branches
explicitly — never silently nil.

### S6. CLAUDE.md PubSub topic shape stale vs `Grappa.PubSub.Topic`
**Files:** `CLAUDE.md` lines documenting "Topics are `grappa:user:{user}`, `grappa:network:{net}`, and `grappa:network:{net}/channel:{chan}`" vs `lib/grappa/pubsub/topic.ex:14-20`
**Category:** docs drift
**Severity:** MEDIUM

CLAUDE.md says topics are `grappa:network:{net}` etc. — but the
ACTUAL implementation in `Grappa.PubSub.Topic` makes every topic
rooted in `user`:
- `grappa:user:{user_name}`
- `grappa:user:{user_name}/network:{network_slug}`
- `grappa:user:{user_name}/network:{network_slug}/channel:{channel_name}`

The Topic module's moduledoc explicitly explains why (Phase 2 sub-task
2h: cross-user authz at the routing layer). The implementation is
correct; CLAUDE.md is the divergent source. Per the file's own rule
"This file + DESIGN_NOTES + plans are the authority" — this drift
will mislead future agents.

**Fix:** Update CLAUDE.md "Phoenix Channels is the streaming surface"
bullet to match the user-rooted topic shapes documented in
`Grappa.PubSub.Topic`'s moduledoc.

### S7. Dead `:toml` dep in `mix.exs`
**File:** `mix.exs:86` — `{:toml, "~> 0.7"}`
**Category:** dep hygiene
**Severity:** MEDIUM

Per CLAUDE.md "Config" section: "Phase 2 sub-task 2j replaced the TOML
loader" — config is now DB-driven. Zero references to `:toml` or
`Toml.` anywhere in `lib/` or `test/`. Carrying an unused runtime dep
adds a CVE-tracking surface (`mix.audit` gate) for no benefit, plus
loads the OTP application at boot.

**Fix:** Remove the `{:toml, "~> 0.7"}` line + run `mix deps.unlock
--unused` + `mix deps.clean toml`. Verify `scripts/check.sh` still
green (it should — nothing imports it).

### S8. Two `async: false` test files lack documented justification
**Files:**
- `test/grappa/log_test.exs` — `use ExUnit.Case, async: false` (no moduledoc explaining)
- `test/grappa/application_test.exs` — `use ExUnit.Case, async: false` (no moduledoc explaining)
**Category:** test discipline
**Severity:** MEDIUM

CLAUDE.md "Sandbox per test (`async: true`)" — 38 of 90 test files
are `async: false`. Most have an explicit moduledoc explaining why
(SQLite single-writer contention, singleton GenServer, global
`:telemetry.attach` handler, etc.) which is the right pattern. These
two don't, so the next agent will not know whether a refactor to
`async: true` is safe.

**Fix:** Add a one-line `# async: false because <X>` comment above the
`use ExUnit.Case` line in each file. If the answer is "no good
reason", flip to `async: true` and verify.

## LOW

### S9. `require Logger` repeated inside private helpers
**File:** `lib/grappa_web/controllers/networks_controller.ex:224, 248`
**Category:** code shape
**Severity:** LOW

Two private helpers each `require Logger` locally instead of a single
top-of-module `require`. Cosmetic; idiomatic Elixir is one
`require Logger` at the top of the controller module.

**Fix:** Move `require Logger` to module top, drop the two in-function
calls.

### S10. Generic `map()` return type in three internal helpers
**Files:**
- `lib/grappa/session.ex:911` — `put_subject_id(map(), subject()) :: map()`
- `lib/grappa/scrollback/meta.ex:183` — `atomize_known(map()) :: map()`
- `lib/grappa/session/event_router.ex:1487` — `whois_merge(map(), map()) :: map()`
**Category:** type leverage
**Severity:** LOW

These are all internal helpers (not boundary returns), but they're
the only `map()`-typed signatures in the codebase. `whois_merge` in
particular folds 311/312/313/317/319 numerics into a structured
bundle that DOES have a known shape — typing it as `map()` defeats
Dialyzer's `:underspecs` and `:unmatched_returns` checks (both
enabled in `mix.exs:42-49`).

**Fix:** Define a typed accumulator (`@type whois_acc :: %{...}`) and
update the spec. `put_subject_id` and `atomize_known` are conversion
helpers and may legitimately need `map()`; document inline if so.

## Summary

- **0 CRITICAL, 2 HIGH, 6 MEDIUM, 2 LOW.**
- **Top 3 themes:**
  1. Hot-reload preflight is structurally blind to map-shape changes
     in `Session.Server` + `WSPresence` (S1) — the very classes
     CLAUDE.md's hot-deploy memory was written about.
  2. Wire-shape + config discipline have one-off lapses (S4 inline
     payload at admin controller, S5 missing `compile_env!`) where the
     established pattern wasn't followed.
  3. Documentation drift in CLAUDE.md (S6 topic shape) — plus the
     dead `:toml` dep (S7) — are stale-bit-rot symptoms ripe for a
     2-line sweep.
- **Systemic counts (zeros worth recording):**
  - `\\` default arguments in `def`/`defp`: **0** across 118 lib files
  - `String.to_atom/1`: **0**
  - Bare `rescue _` / `catch _, _`: **0** (every rescue is bounded
    `Ecto.NoResultsError` / `ArgumentError` / `NoServerError` with an
    inline WHY comment)
  - `Repo.insert/2` / `Repo.update/2` without preceding changeset: **0**
  - Inline-interpolation Logger calls: **1** (S2)
  - Runtime `Application.put_env`: **0**
  - Runtime `Application.get_env` outside the documented exception
    (`application.ex:121` start_bootstrap toggle, `admission/config.ex`
    boot-time read into `:persistent_term`): **0**
  - Cross-context schema imports from `lib/grappa_web/`: present but
    Boundary-declared via `dirty_xrefs` and `exports:` lists (clean)
- **What's working very well:** Boundary discipline (every context
  declares `dirty_xrefs` with paragraph-long WHY comments for the
  cycle-breakers), `@spec` coverage on context boundary modules
  (8 sampled context modules: 100% public-fn coverage), property
  tests via StreamData on parser + identifier + query_windows +
  user_settings + encrypted_binary, the `Grappa.IRCServer` test
  helper used in every integration test (zero direct `:gen_tcp`
  mocking), single-source-of-truth `Grappa.PubSub.Topic` module with
  enforced parser at the channel join boundary.
