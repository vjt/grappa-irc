# Cross-module scope — 7 findings (0 CRIT, 2 HIGH, 3 MED, 2 LOW)

Scope: walked all of `lib/` for cross-cutting CLAUDE.md violations. Avoided overlap with the IRC, persistence, lifecycle, web, cicchetto, Docker, and cross-surface agents — only patterns that span the entire server codebase are reported here.

Methodology: ripgrep + targeted reads on every category listed in the brief. `scripts/mix.sh compile` completed cleanly with no Boundary warnings; the codebase compiles without violation.

---

### S1. `Application.fetch_env!/2` at runtime inside controller action
**File:** `lib/grappa_web/controllers/push_vapid_controller.ex:57`
**Category:** runtime-config-banned
**Severity:** HIGH

`PushVapidController.show/2` calls `Application.fetch_env!(:web_push_elixir, :vapid_public_key)` inline in the controller action. CLAUDE.md explicitly bans `Application.{get,fetch}_env/2` at runtime: "Banned at runtime — neither read nor written from any GenServer callback, controller, context function, plug body, or release task." The moduledoc rationalises sharing the upstream library's app-env namespace ("preventing drift between cic encryption and Push.Sender signing"), but the rule does not exempt foreign app namespaces. The lookup is unbounded reads-per-request from a globally-mutable ETS-backed store; the value never changes after boot.

Every other config surface in the codebase already follows the right pattern (`Application.compile_env!/2` for compile-time pins, `:persistent_term` for boot-time snapshots written by `Grappa.Admission.Config.boot/0` / `Grappa.Uploads.boot/0`). This controller is the lone runtime reader.

**Fix:** Add a `Grappa.Push.vapid_public_key/0` accessor that reads from `:persistent_term` (key written by a new `Grappa.Push.boot/0` invoked from `Grappa.Application.start/2`, mirroring `Grappa.Uploads.boot/1`). Controller calls `Grappa.Push.vapid_public_key()`. Bonus: removes a `Grappa.PushVapid` → `:web_push_elixir` Boundary edge.

---

### S2. `Grappa.ServerSettings` topic bypasses `Grappa.PubSub.Topic`
**File:** `lib/grappa/server_settings.ex:54` (`@topic "grappa:server_settings"`), `lib/grappa/server_settings.ex:184` (raw `Phoenix.PubSub.broadcast/3`)
**Category:** pubsub-single-source-of-truth
**Severity:** HIGH

CLAUDE.md: "Single source of truth: `Grappa.PubSub.Topic`." Every other broadcaster either calls `Grappa.PubSub.broadcast_event/2` (struct-guarded; emits the wire `"event"` envelope) or, for server-internal signals, uses `Grappa.PubSub.Topic.ws_presence/1`. `Grappa.ServerSettings` defines its own private `@topic "grappa:server_settings"` constant, calls `Phoenix.PubSub.broadcast/3` directly with a 2-tuple payload, and the topic string is invisible to `Topic.parse/1` / `Topic.valid?/1`. Moduledoc justifies it as "in-process signal for tests + future internal subscriber," but the same justification applies to `ws_presence` (also internal-only) which DOES live in `Topic`.

Three consequences:
1. New subscribers won't discover the topic by reading `Topic` (the documented single source of truth).
2. The compiler can't catch a typo'd topic string at either producer or consumer.
3. `Phase 6 IRCv3 listener` mandate "Topic-shape evolution must go through this module" is silently broken — adding a `server_settings_changed` listener-facade frame would have to read the constant out of `ServerSettings`.

Same applies more weakly to `lib/grappa_web/channels/admin_channel.ex:47` — the `join/3` clause hardcodes `"grappa:admin:events"` rather than matching on `Topic.admin_events()`. Phoenix's `join/3` does require a literal head pattern, so this one is a syntactic constraint, but the literal could at least be `@admin_topic` aliased to a compile-time `Topic.admin_events()` call.

**Fix:** Add `Topic.server_settings/0 :: "grappa:server_settings"` + register `:server_settings` in the `parsed` type and `parse/1` clauses. Replace `Phoenix.PubSub.broadcast/3` with `Grappa.PubSub.broadcast_event/2` (the payload `{:server_settings_changed, public_view()}` is already a struct-free map shape with one wrap-and-unwrap). Add `Grappa.PubSub` to `ServerSettings`'s Boundary `deps:`.

---

### S3. `Grappa.ServerSettings` Boundary missing `Grappa.PubSub` dep
**File:** `lib/grappa/server_settings.ex:49`
**Category:** boundary-declaration
**Severity:** MEDIUM

`use Boundary, top_level?: true, deps: [Grappa.Repo]` declares only `Grappa.Repo`, but the module calls `Phoenix.PubSub.broadcast/3` (an external lib, not strictly a Boundary'd internal — so Boundary doesn't complain). However, the moduledoc itself says "Deps: `Grappa.PubSub`, `Grappa.Repo`" — the docstring contradicts the declaration. Once S2's fix lands (`Grappa.PubSub.broadcast_event/2`), Boundary will require the dep be added.

**Fix:** Update `deps: [Grappa.Repo, Grappa.PubSub]` (in lockstep with S2).

---

### S4. `Grappa.ServerSettings.public_view/0` invoked but no `@spec` returned-type mention of fields
**File:** `lib/grappa/server_settings.ex:141-142`
**Category:** typespec drift
**Severity:** LOW

Public `@spec public_view() :: public_view()` is correct but the type definition (`@type public_view :: %{upload: %{...}}`) is a wide shape with no other admin keys planned. Once admin-only settings land (per moduledoc), the type widens. This isn't a violation today but is a future drift vector — Wire shapes that exist as inline `@type` next to a single use site are easy to update at the producer and forget at the consumer. Cross-surface agent owns the consumer-side check; here it's a noted pre-Phase-5 concern.

**Fix:** When adding the second class of settings, lift `public_view` into a `Grappa.ServerSettings.Wire` module (sibling of `Grappa.Scrollback.Wire`, `Grappa.QueryWindows.Wire`) so the wire-shape contract is colocated with other Wire modules and discoverable by the cross-surface diff agent.

---

### S5. `Grappa.Session.call_session/3` defaults to 5s GenServer timeout for IRC verbs
**File:** `lib/grappa/session.ex:1032`
**Category:** timeout-hygiene
**Severity:** MEDIUM

`GenServer.call(pid, request)` with no explicit timeout uses 5000ms. The call site is the dispatch for every REST verb that touches an active `Session.Server` (`send_join`, `send_part`, `send_privmsg`, etc.). A `Session.Server` blocked on its own mailbox (waiting for an upstream IRC numeric, or a 1s `IRC.Client.send_quit` synchronous call inside `terminate/2`) will exceed 5s on a slow upstream and surface as an opaque `:exit, {:timeout, _}` — `call_session/4` (its sibling at line 1036) has the explicit-timeout shape with a graceful `{:error, :timeout}` re-shape, but the default-timeout sibling doesn't. The two sibling functions also create inconsistent caller behaviour: the bare `call_session/3` callers crash on timeout; the `call_session/4` callers get a tagged error.

CLAUDE.md "no silent-swallow at boundaries" + "fix at the boundary that raised" both apply — the unhandled timeout exits the controller process and surfaces as a Phoenix 500 with no `{:error, :timeout}` shape in the FallbackController spec.

**Fix:** Inline `call_session/3` into `call_session/4` with an explicit (configurable) default and the same `try/catch :exit, {:timeout, _}` wrapper. Add `:timeout` to the `FallbackController.call/2` spec union. One function, one behaviour.

---

### S6. `lib/grappa/session/server.ex` + `event_router.ex` are 3001 + 2544 LOC
**File:** `lib/grappa/session/server.ex` (3001 LOC), `lib/grappa/session/event_router.ex` (2544 LOC)
**Category:** maintainability
**Severity:** LOW

Not a CLAUDE.md violation directly but worth noting cross-cut: these two modules are an order of magnitude larger than any other in the codebase (the next-largest is `lib/grappa_web/channels/grappa_channel.ex` ~1100 LOC). `Grappa.Session.Server` packs the GenServer lifecycle, window-state machine, autojoin replay, CTCP handling, /who pipeline, /names pipeline, channel-key tracking, mode-prefix accounting, archive housekeeping, and broadcaster glue — every one of these is a candidate for extraction (`Session.Window`, `Session.WhoCollector`, `Session.NamesCollector` already exist as siblings; the trend is good but incomplete).

The "crash boundary alignment" rule applies — a single oversized GenServer means any unrelated failure inside one collector takes the entire `(user, network)` session down. Splitting into supervised children narrows the blast radius.

**Fix:** Track as a planned post-Phase-5 refactor. Not blocking current work but flagged for the next cluster that touches `session/server.ex` to chip away at extractions where natural seams already exist (CTCP handlers, the whois bundle accumulator, the archive promotion logic).

---

### S7. `Grappa.Networks.broadcast_state_change/4` and siblings broadcast two events per state change
**File:** `lib/grappa/networks.ex:614-615`
**Category:** broadcast-fan-out-discipline
**Severity:** MEDIUM

Two consecutive `Grappa.PubSub.broadcast_event/2` calls per state transition:

```elixir
:ok = Grappa.PubSub.broadcast_event(topic, state_payload)
:ok = Grappa.PubSub.broadcast_event(topic, home_payload)
```

Each call hits the PubSub dispatcher independently — two telemetry samples, two WS pushes, two fastlane traversals. CLAUDE.md doesn't ban multi-broadcast per state change but the comment chain above this site (lines 568–613) explains the careful framing of one logical event (`connection_state_changed`) into a single message. Splitting it into two payloads on the same topic forces every subscriber to correlate two events to reconstruct one logical state change, and creates a temporal window where a subscriber that processes the first broadcast sees inconsistent state until the second arrives.

This is exactly the "PubSub broadcast + Channel push payloads MUST be JSON-encodable — convert structs to wire shape via a context-owned `*.Wire` module" rule taken to its logical conclusion: one logical event, one wire payload, one broadcast. If `home_payload` is a derived view of the same state, derive it on the consumer; if it's a genuinely separate concern, give it a distinct topic so subscribers can opt in independently.

**Fix:** Either fold `home_payload` into `state_payload` at the producer (single broadcast) or move it to a distinct topic (so admin-pane consumers don't subscribe to the home-pane data and vice versa). Audit other multi-broadcast sites (`grep -B1 'broadcast_event' lib/grappa/networks.ex` shows this is the only one; good — keep it that way).

---

## Pattern audits with no findings (clean)

For completeness, the following pattern audits found zero violations:

1. **`\\` default arguments in `def`/`defp`** — zero offenders in `lib/`. All matches for `\\` are documentation, regex character classes, binary patterns, or shell-continuation lines in mix-task moduledocs.
2. **`Application.put_env/2` at runtime** — only legitimate callers (`lib/mix/tasks/grappa/boot.ex:12,43`, pre-`ensure_all_started` per the documented exception; `lib/grappa/application.ex` boot path).
3. **`String.to_atom/1`** — zero offenders. Every atom-coercion site uses `String.to_existing_atom/1` and is gated by an explicit allowlist (`@allowed_cred_keys`, `@auth_strings`, admin controller allowlist). Atom DoS is closed.
4. **Inline string interpolation in `Logger` calls** — zero offenders. Every `Logger.{info,warning,error,debug}` uses metadata keywords; the only `inspect()` usage is on metadata values (`error: inspect(reason)`), which is the correct shape.
5. **Bare `catch _, _` / `rescue _`** — every rescue/catch in `lib/` names a specific exception type or exit reason. The `terminate/2` exit catches in `session/server.ex` enumerate every shape explicitly. The previous wide-catch incident (commit `7bb3caa`) is the documented lesson; it's stayed clean.
6. **Boundary annotations** — every context module under `lib/grappa/*.ex` has `use Boundary`; `scripts/mix.sh compile` produced zero warnings.
7. **Migration drift** — 80+ migrations, sequential timestamps, single `create_if_not_exists` substring match is in a moduledoc only (the migration file itself uses plain `create`).
8. **`@spec` coverage on public context APIs** — all 12 top-level context modules sampled have one-spec-per-public-def (clauses share specs correctly). `accounts.ex`, `networks.ex`, `scrollback.ex`, `session.ex`, `visitors.ex`, `uploads.ex`, `push.ex`, `admission.ex`, `read_cursor.ex`, `query_windows.ex`, `user_settings.ex`, `server_settings.ex` all clean.
9. **Raw struct inserts (`Repo.insert(%Schema{})`)** — zero. Every `Repo.insert`/`Repo.update` flows through a changeset pipeline.
10. **`Repo.query/2` (raw SQL)** — zero offenders in `lib/`.
11. **`Process.put/get`** — zero (no process-dictionary state hacks).
12. **`IO.inspect` / `IO.puts` outside mix tasks + `Grappa.Operator`** — zero stray debug prints.
13. **`Mix.env()` at runtime** — two callsites, both compile-time gated (`if Mix.env() == :test do` wrapping a function definition, not a runtime check).
