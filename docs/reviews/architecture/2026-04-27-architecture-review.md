# Architecture Review — 2026-04-27

**Branch / commit baseline:** `main` @ `1bad0b0` (post-CP10 four-cluster
review-fix campaign: C1 vite-plugin-pwa swap, C2 init/1 → handle_continue,
C3 MessageKind widen, C4 post-Phase-2 hygiene close-out).
**Review type:** architecture (concern-based structural analysis).
**Dispatched:** 6 parallel agents — abstraction boundaries, responsibility
& cohesion, duplication, dependency architecture, type system leverage,
extension & maintainability.
**Raw findings:** 53. **Deduped findings:** 30. **Tally:** 0 CRITICAL,
4 HIGH, 13 MEDIUM, 13 LOW.

This is **architecture, not line-level**. Findings are structural patterns.
Line-level bugs go in `docs/reviews/codebase/`.

Codebase shape at review time:
- ~7,500 LOC of Elixir under `lib/`; ~1,500 LOC of TypeScript under `cicchetto/src/`
- 8 properties + 427 tests + 0 failures
- 22 top-level Boundary annotations enforced
- Phase 3 (cicchetto walking-skeleton PWA) live at `http://grappa.bad.ass`,
  iPhone install + login + scrollback round-trip operator-verified

The previous architecture review (`2026-04-26`) closed 30 findings
across CP07-08 work. This review is the first since the cicchetto/
subsystem landed and the first since the cross-language wire contract
became load-bearing. The thematic shift: **server-side type/boundary
discipline is strong; the gap is at the cross-language seam** — cicchetto
mirrors are by-hand, drift detection is post-hoc, and several Wire
shapes are over-promised against under-implemented producers.

---

## Summary table

| ID  | Title | Concern | Severity |
|-----|-------|---------|----------|
| A1  | cicchetto module-level `joined`/`loadedChannels` Sets leak across token rotations | Dependency / state lifecycle | HIGH |
| A2  | `Grappa.Networks` god-context — 4 distinct concerns, 7 deps | Cohesion / Dependency | HIGH |
| A3  | `Grappa.IRC.Client` god-module — transport+FSM+policy+crypto in 569 lines | Cohesion | HIGH |
| A4  | `cicchetto/src/lib/networks.ts` god-module — 9 concerns, mutable module state | Cohesion | HIGH |
| A5  | `ChannelsController` returns autojoin list, not session-tracked membership | Boundaries | MEDIUM |
| A6  | Wire-shape advertises 10 MessageKinds; producer only writes `:privmsg` | Boundaries / Cohesion / Extension | MEDIUM |
| A7  | `Scrollback.Wire.message_event/1` couples wire-shape to PubSub envelope — Phase 6 listener bifurcates anyway | Boundaries | MEDIUM |
| A8  | cicchetto `api.ts` `as` casts at JSON-decode boundary — server contract unverified at runtime | Boundaries / Type system | MEDIUM |
| A9  | Pagination cursor flat-list shape forces Phase 6 wire-shape break | Boundaries | MEDIUM |
| A10 | cicchetto `socket.ts` hand-rolls topic strings instead of mirroring `Grappa.PubSub.Topic` | Duplication / Boundaries | MEDIUM |
| A11 | cicchetto `Login.tsx` string-matches `err.message` instead of typed `ApiError.code` | Duplication | MEDIUM |
| A12 | `auth_method` enum hand-mirrored 4 places (schema, OptionParsing, two `@type` literals) | Duplication / Type system | MEDIUM |
| A13 | REST URL prefix duplicated 4 places (router.ex / nginx / vite proxy / PWA denylist) | Duplication / Config | MEDIUM |
| A14 | `Scrollback.Meta` allowlist not mirrored as typed union — `meta: map()` server, `Record<string, unknown>` client | Type system / Boundaries | MEDIUM |
| A15 | Bare `string` for domain primitives — no brand for NetworkSlug, ChannelName, UserName, MessageId | Type system | MEDIUM |
| A16 | `conn.assigns.current_user_id` access untyped across 8+ controllers | Type system | MEDIUM |
| A17 | `ChannelEvent` discriminated union has only one arm — `kind !== "message"` guard not exhaustive | Extension | MEDIUM |
| A18 | Compose deploy: Bootstrap starts before migrations complete — Phase-5+ schema-changing migrations race | Dependency / Deploy | MEDIUM |
| A19 | No "how to add a context" recipe — pattern propagation will entrench accidents | Extension | MEDIUM |
| A20 | `Grappa.Session.Server.handle_info` will balloon under Phase 5 presence-event capture | Cohesion | LOW |
| A21 | `Grappa.Networks.Credential` schema embeds business policy (auth/password coupling) | Cohesion | LOW |
| A22 | `Grappa.Log` narrow-API masquerades as cross-cutting concern | Cohesion | LOW |
| A23 | `Network.network_to_json/1` exports `id`/`updated_at` no client consumes | Boundaries | LOW |
| A24 | `Networks.Wire.credential_to_json/1` exported but unused — defensive scaffolding | Boundaries | LOW |
| A25 | `Scrollback` boundary `dirty_xrefs: [Networks.Network]` papers over real cycle | Boundaries / Dependency | LOW |
| A26 | `MessageKind` mirror has no compile-time link to server `@kinds` | Duplication | LOW |
| A27 | Logger metadata key allowlist not statically checked vs callsites | Type system | LOW |
| A28 | `auth_command_template` field unused — dead OR untyped escape hatch | Type system | LOW |
| A29 | Supervision-tree ordering documented but not test-enforced | Dependency | LOW |
| A30 | Phase 6 listener readiness — schema 80% there, but encode-side gap + msgid migration unbrainstormed | Extension | LOW |

---

## Cross-cutting themes

Five themes recur across the 30 findings — each one an architectural
seam where the codebase is structurally weaker than its individual
modules suggest.

### Theme 1: Cross-language wire-shape drift (the cicchetto seam)

**Findings:** A6, A8, A10, A11, A12, A13, A14, A17, A26.

Server side: every domain entity routes through ONE `Wire` module
(`Accounts.Wire`, `Networks.Wire`, `Scrollback.Wire`); every controller's
JSON renderer delegates; topic vocabulary lives in `Grappa.PubSub.Topic`;
identifier validation lives in `Grappa.IRC.Identifier`. The single-source-
of-truth discipline is enforced by Boundary annotations + Dialyzer
specs + tests. Strong.

Client side: `cicchetto/src/lib/api.ts` re-declares the wire shape as
TS interfaces by hand. Topic strings are template-literal-built. Error
codes are matched by `err.message.includes("invalid_credentials")`.
`MessageKind` is a hand-typed union (CP10 C3 just landed it). `auth_method`
is a hand-typed union too. JSON responses are `as`-cast without runtime
narrowing.

The asymmetry is structural: server-side drift is caught by Dialyzer +
Boundary + tests; client-side drift surfaces only at runtime when an
unknown shape arrives. Six C3-style "widen the union" emergencies are
already latent (one per cross-language enum).

The Phase 5 `mix grappa.gen_ts_types` codegen (see A26 recommendation)
collapses A12 + A14 + A17 + A26 into a single source — but it's one
build-system addition, not part of any current phase. Until it lands,
each enum needs a contract test.

### Theme 2: Phase 5 presence-event capture is half-built

**Findings:** A6, A14, A17, A20.

The wire-shape contract advertises 10 message kinds (server `@kinds` +
client `MessageKind`). The renderer handles all 10 (CP10 C3). The meta
allowlist tolerates `:target | :new_nick | :modes | :args | :reason`.
The IRC parser captures every kind. **The producer writes only
`:privmsg`.**

Three modules drift in lockstep against an unimplementable contract.
When Phase 5 lights up presence persistence in `Session.Server`, two
cliffs hit at once: (1) `Scrollback.Meta` normalization paths get
exercised for the first time, (2) cicchetto's renderer renders real
data for the first time. Bugs in any of three mirrors surface only
then.

The structural consequence: `Scrollback.persist_privmsg/5` is
hardcoded `kind: :privmsg`. Phase 5 needs `Scrollback.persist_event/1`
taking a kind parameter. `Session.Server.handle_info` needs a data-driven
dispatcher (`Grappa.Session.EventRouter`) instead of hand-written per-kind
clauses. Both refactors should land BEFORE the first presence-event
producer to avoid landing on a half-baked surface.

### Theme 3: Cohesion drift in three load-bearing modules

**Findings:** A2 (`Grappa.Networks` 4 concerns), A3 (`Grappa.IRC.Client`
4 concerns), A4 (`cicchetto/src/lib/networks.ts` 9 concerns).

Each is the largest file in its layer (501, 569, 245 lines). Each grew
its responsibility set over Phase 2 + Phase 3 without being split. The
"verbs not nouns" rule was violated three times: shared data model
(`Network` row, IRC client GenServer, networks-and-channels store)
absorbed unrelated verbs (server CRUD + credential lifecycle + session
plan resolution; transport + FSM + auth policy + crypto; resource
fetch + scrollback state + selection + WS lifecycle).

Phase 5/6 will land in these files unless they're split first:
- Multi-server failover, credential REST surface, hot-reload → `Networks`
- Phase 5 reconnect/backoff, Phase 6 listener facade reuse, `grappa_irc_client` hex extraction → `IRC.Client`
- Nick lists, mode indicators, topic, presence rendering → `lib/networks.ts`

Cost of splitting now: 1-2 days each, mechanical refactoring + test
file moves. Cost of NOT splitting: every Phase 5/6 sub-task lands in
overloaded files where the next regression hides easily.

### Theme 4: cicchetto module-singleton state without lifecycle

**Findings:** A1 (HIGH), implicitly A4.

`joined: Set<ChannelKey>` and `loadedChannels: Set<ChannelKey>` are
module-level mutable state with no `createSignal`/`createStore`
wrapper and no token-rotation cleanup. After logout-then-login,
`joined.has(key)` returns TRUE from the previous user's session,
silently skipping WS handler installation and scrollback fetch on
the new login. Phoenix.js socket also retains channel handles.

Already flagged in CP10 review S17 (line-level) — this review confirms
it as a pattern, not an isolated bug. The fix is mechanical (wrap in
signal + register token-clear effect + iterate `_socket.channels` and
`leave()` on disconnect) but reveals a missing pattern: **client-side
"session-bound state" needs a documented lifecycle**, equivalent to
the server's "GenServer state stays small, source-of-truth in Ecto."

### Theme 5: Extension paths are uneven — REST is smooth, IRC kinds aren't

**Findings:** A6, A17, A19.

Adding a REST endpoint = ~6 files, well-rehearsed pattern (router →
controller → context → JSON renderer → api.ts → component). Adding a
mix task = 1 file, helper triad covers boilerplate. Both smooth.

Adding a `MessageKind` (e.g. `:invite`) = 9-10 files across two
languages. Producer-side is hardcoded to one kind. Three drift surfaces
have no contract test (server `@kinds` ↔ client `MessageKind` ↔
renderer switch ↔ tests). Phase 5 will hit this hard.

Adding a context = no written recipe. `Grappa.Networks` and
`Grappa.Scrollback` chose different patterns for sub-schema test
mirroring; `Grappa.Log` is bound to one caller despite naming itself
cross-cutting. Pattern propagation rule means whichever Phase-5
addition lands first becomes the template for the next.

---

## Findings (deduplicated)

### A1. cicchetto module-level `joined`/`loadedChannels` Sets leak across token rotations
**Concern:** Dependency / module-singleton state without lifecycle
**Scope:** `cicchetto/src/lib/networks.ts:79-80`, `cicchetto/src/lib/auth.ts:34-41`, `cicchetto/src/lib/socket.ts:28`
**Severity:** HIGH

`joined: Set<ChannelKey>` and `loadedChannels: Set<ChannelKey>` at
module scope, neither wrapped in `createSignal`/`createStore`, neither
cleared when `setToken(null)` fires. Logout-then-login flow: token
clears → socket disconnects → token flips → resources rebuild →
createEffect tries to join channels → `joined.has(key)` returns TRUE
(stale!) → handler-install skipped. Scrollback never re-loads on the
new user's account. Phoenix.js `_socket.channels` retains old channel
handles referencing previous user's topic strings.

**Impact:** Logout-then-login-as-different-user shows empty scrollback
for every channel; messages arriving via WS are silently dropped
because the per-channel handler was never installed. Tests work
around with `vi.resetModules()`; production has no equivalent.

**Recommendation:** Wrap both Sets in `createSignal<Set<ChannelKey>>`
or `Map`-backed `createStore`. Add `createEffect(on(token, (t) => { if
(!t) { joined.clear(); loadedChannels.clear(); _socket?.channels?.forEach(c
=> c.leave()); } }))` inside the existing `createRoot`. Pair with
CP10 review S17 follow-up.

---

### A2. `Grappa.Networks` god-context — 4 distinct concerns, 7 deps
**Concern:** Responsibility / Cohesion + Dependency direction
**Scope:** `lib/grappa/networks.ex` (501 lines, 17 public functions)
**Severity:** HIGH

A single context module owns: (1) network slug CRUD, (2) server-endpoint
CRUD + selection policy (`pick_server!`, `classify_server_error`), (3)
per-user credential lifecycle including encrypted password handling +
cascade-on-empty + scrollback rollback, (4) Session-plan resolution
that reads from `Accounts`, picks a server, decrypts a Cloak password
into a primitive opts map. The cascade path imperatively calls
`Session.stop_session/2` and `Scrollback.has_messages_for_network?`
mid-transaction. The boundary lists 7 deps — highest in the codebase.

**Impact:** Every Phase 5 surface (multi-server failover, credential
REST, hot-reload, audit logging) lands here. Networks is now the only
context with both upstream (Web → it) and downstream (it → Session,
Scrollback) edges — a dep-graph hotspot.

**Recommendation:** Extract `Grappa.Networks.Servers` (server CRUD +
`pick_server!`), `Grappa.Networks.Credentials` (credential lifecycle +
unbind cascade), and `Grappa.Networks.SessionPlan` (Accounts + Server
+ Credential resolver). Keep `Grappa.Networks` as slug-CRUD core.
Long-term: introduce `Grappa.Operations` (or `Grappa.NetworkLifecycle`)
for cross-context orchestration so Networks's deps shrink to `Accounts,
EncryptedBinary, IRC, Repo, Vault`.

---

### A3. `Grappa.IRC.Client` god-module — transport + FSM + policy + crypto
**Concern:** Responsibility / Cohesion
**Scope:** `lib/grappa/irc/client.ex` (569 lines)
**Severity:** HIGH

Largest single module in `lib/grappa/`. Owns: (a) TCP/TLS transport
plumbing, (b) full IRCv3 CAP/SASL state machine (5 phases, multi-clause
`handle_cap`, `finalize_cap_ls`, `cap_unavailable`), (c) auth-method
policy decisions (`maybe_send_pass`, `maybe_nickserv_identify`, `:auto`
vs `:sasl` vs `:nickserv_identify` branching), (d) SASL PLAIN payload
assembly + Base64, (e) per-line outbound helpers with `safe_line_token?`
guards (duplicates `Session` facade), (f) password-presence validation
mirroring `Networks.Credential.changeset`, (g) TLS posture-warning
Logger emission. Moduledoc explicitly names three responsibilities;
counted four+.

**Impact:** Phase 5 reconnect/backoff, Phase 6 listener facade reuse,
`grappa_irc_client` hex extraction (per user's auto-memory) all land
here. Each change risks the FSM. The `send_*` helper guards duplicating
`Session.send_*` is dead-code defensive duplication.

**Recommendation:** Split into `Grappa.IRC.Client` (GenServer +
transport + line dispatch) and `Grappa.IRC.AuthFSM` (pure functions:
`step(state, message) :: {:cont, state, [send]} | {:stop, reason}`).
The FSM is the natural unit to test in isolation and the natural shape
to reuse for the Phase 6 listener facade. Move `send_*` validation up
to `Grappa.Session` facade — drop Client-side `safe_line_token?`
checks (single chokepoint, raw `Client.send_line/2` remains the
explicitly-unguarded escape hatch per A25).

---

### A4. `cicchetto/src/lib/networks.ts` god-module — 9 concerns, mutable module state
**Concern:** Responsibility / Cohesion (client-side mirror of A2)
**Scope:** `cicchetto/src/lib/networks.ts` (245 lines)
**Severity:** HIGH

Single module owns: (1) `/networks` resource fetch, (2) `/me` resource
fetch, (3) `/networks/:slug/channels` per-network fan-out, (4)
per-channel scrollback state (`scrollbackByChannel` map + dedupe +
sort), (5) unread counts, (6) selected-channel state, (7) initial
scrollback load + load-more pagination, (8) outbound `sendMessage`
REST passthrough, (9) Phoenix.Channel join + per-channel event handler
installation. Module-level mutable Sets (`joined`, `loadedChannels`)
hold session-scoped state without lifecycle (A1). The composite
`createRoot(() => { ... })` block contains two effects doing different
things.

**Impact:** Mirrors server-side concentration in `Grappa.Networks`. As
Phase 4/5 add nick lists, mode indicators, topic, presence — they all
land in this file. Phase 4 brainstorm should not begin with this module
in its current shape.

**Recommendation:** Split into `lib/networks.ts` (network/channel tree
+ `/me` resources), `lib/scrollback.ts` (per-channel scrollback +
load-more + send), `lib/selection.ts` (selected-channel + unread
counts), `lib/channelSubs.ts` (WS join effect + event-handler install).
Each gets its own module-singleton signal store with token-rotation
cleanup (A1). The composite `ChannelKey` brand is shared infrastructure
→ `lib/channelKey.ts`.

---

### A5. `ChannelsController` returns autojoin list, not session-tracked membership
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa_web/controllers/channels_controller.ex` `index/2`, `cicchetto/src/lib/networks.ts`
**Severity:** MEDIUM

`GET /networks/:slug/channels` reads `credential.autojoin_channels` —
operator-supplied static list. Bouncer's runtime joined-channels live
in `Session.Server` state and are NOT reflected here. JOIN via REST →
new channel goes upstream + session knows, but `GET /networks/:slug/channels`
keeps returning old autojoin until operator re-binds. Wire shape is
`ChannelEntry = {name}` with no `joined: bool`, no source discriminator.
Cicchetto consumes this list as authoritative.

**Impact:** Channel list and live session state drift. New JOINs via
REST/WS won't appear in sidebar. PARTs leave dead entries. Wire-shape
contract conflates "operator policy" with "current state." Phase 5's
planned channel-membership tracking will need a wire-shape change
(joined / topic / unread) that breaks today's clients.

**Recommendation:** Introduce `Session.list_channels/2` returning the
runtime joined set (could derive from a `MapSet` in Session.Server
state or replay via an `IRC.Membership` context). `ChannelsController.index`
returns the union: `{name, source: :autojoin | :joined}`. Until then,
document the divergence explicitly in `Networks.Wire.channel_json`
typedoc.

---

### A6. Wire-shape advertises 10 MessageKinds; producer only writes `:privmsg`
**Concern:** Boundaries / Cohesion / Extension
**Scope:** `lib/grappa/scrollback/{message,meta,wire}.ex`, `lib/grappa/session/server.ex`, `cicchetto/src/lib/api.ts MessageKind`, `cicchetto/src/ScrollbackPane.tsx`
**Severity:** MEDIUM

Server kind enum + Meta allowlist + cicchetto exhaustive switch all
advertise 10 kinds. `Session.Server` only persists `:privmsg`; presence
events (JOIN/PART/QUIT/MODE/etc.) are logged with `Logger.info` and
discarded. `ScrollbackPane.renderBody` already handles `meta.new_nick`,
`meta.target`, `meta.modes`, `meta.args`, `meta.reason` — none of which
Phase 1 ever emits. `Scrollback.persist_privmsg/5` is hardcoded
`kind: :privmsg`; there is NO generic `persist_event/1` taking `:kind`.

**Impact:** Three modules drift in lockstep against unimplementable
contract. When Phase 5 lights up presence-event capture, two cliffs
hit at once: (1) Meta normalization paths exercised for first time,
(2) cicchetto rendering paths render real data for first time. Bugs
surface only then. The Phase 6 `CHATHISTORY` listener can't be tested
against a populated scrollback because no JOIN row ever exists.

**Recommendation:** Either (a) accept deferral and explicitly TAG
unused meta keys / kinds as "schema-reserved, no producer" with a
single `@phase_5_reserved` annotation in one place — and stop having
the wire/Wire/TS chain pretend they ship today, or (b) implement
`Session.Server` PRIVMSG persistence's siblings for at least
`:join | :part | :quit` so the wire is exercised end-to-end.
**Companion refactor:** introduce `Scrollback.persist_event/1` taking
explicit `:kind` (no defaulting); `persist_privmsg/5` becomes a thin
wrapper. Introduce `Grappa.Session.EventRouter` (pure module:
`route(message, state) :: :ignore | {:persist, kind, attrs} | {:reply, line}`)
so Server's `handle_info({:irc, msg}, state)` delegates — separate
the WHAT (pure, testable) from the WHEN (GenServer wrapper).

---

### A7. `Scrollback.Wire.message_event/1` couples wire-shape to PubSub envelope
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/scrollback/wire.ex`, `lib/grappa/session/server.ex`, `lib/grappa_web/channels/grappa_channel.ex`, `cicchetto/src/lib/api.ts ChannelEvent`
**Severity:** MEDIUM

`message_event/1` returns `{:event, %{kind: :message, message: to_json(m)}}`
— a tuple-tagged map shaped so `GrappaChannel.handle_info/2` can blindly
pattern-match `{:event, payload}` and `push("event", payload)`. The
Phase 6 IRCv3 listener facade needs the same domain event encoded as
IRC bytes (a PRIVMSG line with `server-time` / `msgid` tags), NOT as
JSON under `:message` key. The `to_json/1` half is reusable; the
`message_event/1` envelope is JSON-Channel-specific. The wire-shape
module enshrines the JSON envelope as part of "the verb."

**Impact:** When Phase 6 lands, the listener will need to either (a)
deconstruct the JSON map back into Message fields to render IRC bytes
— the exact "client re-shapes wire output" anti-pattern this design
prevents — or (b) skip `message_event/1` entirely and call `to_json/1`
raw, leaving `message_event/1` JSON-only. Either path bifurcates the
Wire-shape contract.

**Recommendation:** Refactor so `message_event/1` is renamed
`pubsub_envelope/1` (or moves out into `Grappa.PubSub.Wire`), making
clear it is JSON-Channel-specific. Phase 6 listener uses `to_json/1`
directly + its own IRC-bytes encoder. The outer `kind: :message`
discriminator becomes redundant once Phase 5 presence events carry
their own outer payload shapes — the inner `message.kind` IS the
discriminator.

---

### A8. cicchetto `api.ts` `as` casts at JSON-decode boundary
**Concern:** Abstraction boundaries / Type system
**Scope:** `cicchetto/src/lib/api.ts:146,154,170,178,198,226`
**Severity:** MEDIUM

Every fetch path ends with `return (await res.json()) as LoginResponse`
(or appropriate type). Six sites. No runtime narrowing. Server-side
wire-shape regression (renamed field, type widened, kind added) ships
green from server tests + green from client tests (Vitest's
`vi.mock("../lib/api")` short-circuits the real fetch shape) and breaks
at runtime in production with cryptic "cannot read 'undefined'" errors.
`tsconfig` has `strict: true` + `noUncheckedIndexedAccess: true` (great)
but `as` blows past both. The `readError/1` path correctly types its
body as `{error?: string; errors?: {detail?: string}}` and narrows —
that pattern should be everywhere.

**Impact:** Class of bugs `noUncheckedIndexedAccess` catches at
compile-time but at the wire boundary. The client has no notion of
"the server returned a shape I don't recognize"; everything 200 is
happy.

**Recommendation:** Add a thin runtime validator at each api.ts boundary.
Either zod / valibot (small, brand-friendly) or a hand-rolled
`assertScrollbackMessage(unknown): asserts unknown is ScrollbackMessage`
— invariant: `unknown` narrowing at every fetch boundary, never `as`.
The server-side `Wire.t/0` types stay the source of truth; the
client-side validator stays in sync via the same review discipline as
the type itself.

---

### A9. Pagination cursor flat-list shape forces Phase 6 wire-shape break
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/scrollback.ex` `fetch/5`, `lib/grappa_web/controllers/messages_controller.ex` `index/2`, `cicchetto/src/lib/networks.ts loadMore`
**Severity:** MEDIUM

`Scrollback.fetch/5` returns `[Message.t()]` — a flat list. The
pagination cursor (`server_time` of the oldest row) is **derived by
the caller** from the last element. `cicchetto/src/lib/networks.ts`
`loadMore` does `current[0]?.server_time` and feeds that back as
`?before=`. Empty page = no more history. A page of exactly `limit`
rows where the next-oldest has identical `server_time` would lose
rows at the boundary (the Scrollback moduledoc admits this). Phase 6
plans to switch to a `(server_time, msgid)` tuple cursor.

**Impact:** Phase 6's tuple-cursor plan is a wire-shape break: the
client re-derives the cursor from page contents today. Migrating to
`(server_time, msgid)` requires either (a) wire returning an envelope
`{messages, next_cursor}` (breaking change every consumer tracks) OR
(b) the client to keep deriving but from two fields (still a contract
break). Today's "flat array" forces either a breaking change OR a
forever-second-best cursor.

**Recommendation:** Promote the response to an envelope NOW:
`%{messages: [...], next_cursor: integer() | nil, has_more: boolean()}`.
Wire-shape break is one-time; the future Phase 6 cursor migration
becomes a `next_cursor` field-shape change inside the envelope, not
a wire-level redesign. `Scrollback.fetch/5` returns the envelope,
`Wire.to_json/1` extends with the cursor, cicchetto's `listMessages`
mirrors. Bonus: `has_more: false` removes the empty-page-as-EOF
heuristic that hides the equal-`server_time` boundary bug.

---

### A10. cicchetto `socket.ts` hand-rolls topic strings instead of mirroring `Grappa.PubSub.Topic`
**Concern:** Duplication / Boundaries
**Scope:** `cicchetto/src/lib/socket.ts:52,58,64-66`, `lib/grappa/pubsub/topic.ex`
**Severity:** MEDIUM

Server enforces topic-string construction through one module
(`Grappa.PubSub.Topic.{user,network,channel}/{1,2,3}`) — hard CLAUDE.md
invariant ("`grappa:` prefix mandatory"). Client `socket.ts`
template-literal-builds the same shape inline:
`` `grappa:user:${userName}/network:${networkSlug}/channel:${channelName}` ``.
Tests in `socket.test.ts` hardcode the same strings. Server changing
the separator (`/network:` → `/net:`) or adding a new shape is now a
two-codebase edit with no compile-time link.

**Impact:** Topic shape drift between subscriber (cicchetto) and
broadcaster. Subscriber-routing change must be hand-mirrored. Phase 5
presence subtopics or Phase 6 listener subscriptions multiply the
sync points.

**Recommendation:** Add `cicchetto/src/lib/topic.ts` mirror with
`userTopic(name)`, `networkTopic(name, slug)`, `channelTopic(name, slug, chan)`
returning a branded `Topic` opaque type (same pattern as `ChannelKey`).
Reference from `topic.ex` moduledoc.

---

### A11. cicchetto `Login.tsx` string-matches `err.message` instead of typed `ApiError.code`
**Concern:** Duplication
**Scope:** `cicchetto/src/Login.tsx:31-32`, `cicchetto/src/lib/api.ts:87-97`
**Severity:** MEDIUM

`api.ts` deliberately exposes `ApiError.code` (snake_case wire token
from `FallbackController`) so callers branch on a stable string.
Login does `code.includes("invalid_credentials")` against `err.message`
— substring search defeats the typed contract. Server adding a new
`:invalid_credentials_some_variant` token would silently match the
same branch.

**Impact:** `ApiError.code` exists as the unification point, but the
only consumer bypasses it. C4/M5 unification of `Plugs.Authn` 401
through `FallbackController` is half-realized — server side funneled,
client side not.

**Recommendation:** `Login.tsx` should `if (err instanceof ApiError &&
err.code === "invalid_credentials")`. Bonus: introduce typed union
`type ErrorCode = "invalid_credentials" | "unauthorized" | "bad_request"
| "not_found" | "no_session" | "invalid_line"` mirroring
`FallbackController` `@spec`, with TS exhaustive switch wherever an
`ApiError` is consumed.

---

### A12. `auth_method` enum hand-mirrored 4 places
**Concern:** Duplication / Type system
**Scope:** `lib/grappa/networks/credential.ex:38,40`, `lib/mix/tasks/grappa/option_parsing.ex:16-17,43-44`, `lib/grappa/irc/client.ex:96`
**Severity:** MEDIUM

`Credential.@auth_methods` is the schema-side SoT. `OptionParsing.@auth_methods`
redeclares the same five atoms for the `--auth` flag. Both modules
also separately repeat the `:auto | :sasl | :server_pass | :nickserv_identify
| :none` type literal in their `@type`/`@spec`. `Client.auth_method/0`
is a third copy. Adding a sixth method (e.g. `:certificate`) is a
four-place edit; missing one place silently rejects valid CLI input
or accepts invalid ones.

**Impact:** Two-source-of-truth drift. Atoms-as-typed-literals discipline
followed in shape but registry duplicated.

**Recommendation:** Expose `Credential.auth_methods/0` returning
`@auth_methods`; OptionParsing consumes that. Centralize `@type
auth_method` in Credential only; alias from Client/Session. Single
SoT, mechanical CLI surface.

---

### A13. REST URL prefix duplicated 4 places
**Concern:** Duplication / Config
**Scope:** `lib/grappa_web/router.ex:39-69`, `infra/nginx.conf:105`, `cicchetto/vite.config.ts:89,97-103`
**Severity:** MEDIUM

The set of REST top-level prefixes (`/auth`, `/me`, `/networks`,
`/healthz`, `/socket`) is hand-mirrored in four places: (1) router.ex
scope declarations (truth), (2) nginx
`location ~ ^/(auth|me|networks|healthz)` regex, (3) vite dev-proxy
keys, (4) Workbox `navigateFallbackDenylist` regexes. Adding a new
top-level scope requires four synchronized edits across two repos and
three syntaxes (Elixir DSL, nginx regex, JS regex). The vite.config.ts
comment acknowledges "Keep these in lockstep with router.ex's REST
scope prefixes if new ones are added" — duplication-by-comment is
duplication.

**Impact:** Silent breakage on deploy: SPA navigation interceptor
will eat a new REST route until denylist is updated; nginx will 404
it; dev proxy will not forward it.

**Recommendation:** This is the right kind of duplication to accept
(each tool wants its own syntax) but make the SoT explicit: doc
comment in router.ex listing every consumer; CI test asserting
`infra/nginx.conf` and `cicchetto/vite.config.ts` reference each
top-level scope. Cheaper than a code-gen layer, catches drift loudly.

---

### A14. `Scrollback.Meta` allowlist not mirrored as typed union
**Concern:** Type system / Boundaries
**Scope:** `lib/grappa/scrollback/wire.ex:45`, `lib/grappa/scrollback/message.ex:125`, `cicchetto/src/lib/api.ts:79`, `cicchetto/src/ScrollbackPane.tsx`
**Severity:** MEDIUM

Server: `Grappa.Scrollback.Meta` is a custom Ecto type with a closed
`@known_keys` allowlist + per-kind shape table. But `Message.t()` and
`Wire.t()` declare `meta: map()` — the type signature throws away the
discipline the custom type encodes. Client: `meta` is
`Record<string, unknown>`. Renderer narrows defensively at every
access (`typeof msg.meta.new_nick === "string" ? ... : "?"`). The `"?"`
placeholder fallback masks both legitimate null cases and shape-drift
bugs — operator can't tell them apart. Same drift class as CP10
review S29 (already-closed `:reason` dead key).

**Impact:** Producers can hand any map shape; consumers forced into
defensive narrowing. Adding a new meta key (e.g. `:topic_old`) is a
hidden-field on the wire — TypeScript doesn't notice, renderer
silently drops it.

**Recommendation:** Tighten server `@type`: `%{optional(:target) =>
String.t(), optional(:new_nick) => String.t(), optional(:modes) =>
String.t(), optional(:args) => [String.t()], optional(:reason) =>
String.t()}` — reuse from `Message.t()` and `Wire.t()`. Mirror as TS
discriminated union per kind: `type ScrollbackMessage = { kind:
"nick_change"; meta: { new_nick: string }; ... } | { kind: "kick";
meta: { target: string; reason?: string }; ... } | ...`. Adding a key
becomes a compile error in both codebases.

---

### A15. Bare `string` for domain primitives — no brands
**Concern:** Type system
**Scope:** `cicchetto/src/lib/api.ts:24-38` (MeResponse, Network, ScrollbackMessage)
**Severity:** MEDIUM

`MeResponse.id: string` (server: `Ecto.UUID.t()`), `Network.slug: string`
(server: validated by `Identifier.valid_network_slug?/1`),
`ScrollbackMessage.{network,channel,sender}: string` (server: validated
channel/nick grammar), `ScrollbackMessage.id: number` (could be
`MessageId` brand for monotonic-id contracts the dedupe logic relies
on). The `ChannelKey` brand pattern proves the team already knows how
— but it's applied only to one composite key, not to underlying
primitives.

**Impact:** Scrollback dedupe by `id` and topic-key construction in
`socket.ts` consume bare strings/numbers where a brand would prevent
footguns (e.g. passing `Network.id` integer FK instead of `Network.slug`
to `joinChannel`).

**Recommendation:** Add `NetworkSlug`, `ChannelName`, `UserName`,
`MessageId`, `UserId` brands in `lib/api.ts`. Update wire types and
store signatures. `socket.ts` join helpers and `channelKey` builder
become natural producers. Single-edit migration; brand has no runtime
cost.

---

### A16. `conn.assigns.current_user_id` access untyped across 8+ controllers
**Concern:** Type system
**Scope:** `lib/grappa_web/controllers/{messages,channels,me,networks,auth}_controller.ex`
**Severity:** MEDIUM

Every authenticated controller does `conn.assigns.current_user_id` and
`conn.assigns.current_session_id`. Both are set by `Plugs.Authn` on
success — but `Plug.Conn.assigns` is typed `%{atom() => any()}`, so
`conn.assigns.current_user_id` returns `any()`. Dialyzer cannot prove
(a) the key is set, (b) its value is a binary UUID, (c) the controller
never accidentally typos `current_user`. A controller mounted without
the authn pipeline crashes at access time, not compile time.

**Recommendation:** Single `GrappaWeb.AuthnContext` helper —
`current_user_id(conn) :: Ecto.UUID.t()` and `current_session_id(conn)
:: Ecto.UUID.t()` — both pattern-match on `%Plug.Conn{assigns:
%{current_user_id: id}}` and crash loudly when missing. Controllers
go through it; Dialyzer sees `Ecto.UUID.t()` and the `conn.assigns.<key>`
syntax disappears.

---

### A17. `ChannelEvent` discriminated union has only one arm
**Concern:** Extension
**Scope:** `cicchetto/src/lib/api.ts:82-85`, `cicchetto/src/lib/networks.ts:197`
**Severity:** MEDIUM

`ChannelEvent = { kind: "message"; message: ScrollbackMessage }`. The
handler does `if (payload.kind !== "message") return;` — string-tag
check that would not catch a typo'd `"messag"` from server. Server
side is `@type event :: {:event, %{kind: :message, message: t()}}` —
single literal too. Both will need to grow (presence/topic-change
events per moduledoc); shipping the discriminator now lays groundwork.

**Impact:** Phase 5 presence events guaranteed to land on the wire
and silently disappear in client unless dev remembers to extend
`networks.ts` handler.

**Recommendation:** Pre-emptively extend `ChannelEvent` to a
discriminated union with `{kind: "presence"; ...}` as a stub typed
against future `Scrollback.Wire.presence_event/1` shape. Rewrite
`networks.ts` event handler as exhaustive switch with `assertNever`
default. Forward-compat insurance per CLAUDE.md "Total consistency or
nothing."

---

### A18. Compose deploy: Bootstrap starts before migrations complete
**Concern:** Dependency / Deploy
**Scope:** `compose.prod.yaml:107-112`, `scripts/deploy.sh:48-67`
**Severity:** MEDIUM

Deploy ordering: build → cicchetto-build → `compose up grappa nginx`
→ `compose exec grappa bin/grappa eval 'Grappa.Release.migrate()'` in
retry loop. Up-step starts grappa container with `Application.start`
calling `Bootstrap` which spawns sessions; sessions write scrollback
rows. Migrations run after grappa is up. On a fresh column-add
migration (e.g. Phase 5 `messages.msgid`), Bootstrap's `Session.Server`s
write PRIVMSGs against OLD schema while migration is queued. Retry
loop assumes migrations are idempotent (true) but doesn't gate
Bootstrap on migration completion.

**Impact:** First PRIVMSGs after a deploy with pending migration MAY
fail Ecto cast/load if column shape diverges. Today (Phase 1/2) every
migration is additive AND schema doesn't read added columns until
subsequent code rolls out, so race is benign. Phase 5+ migrations that
change column shape (NOT NULL, type changes) would be vulnerable.

**Recommendation:** Either (a) move migrations to a separate `migrate`
oneshot service in compose.prod.yaml that nginx + grappa both
`depends_on: condition: service_completed_successfully`, OR (b) add
a `Grappa.Bootstrap`-side gate that delays `run/0` until
`Ecto.Migrator.migrations(@repo)` returns no pending. Option (a) is
the canonical Phoenix-deploy pattern.

---

### A19. No "how to add a context" recipe
**Concern:** Extension
**Scope:** `lib/grappa/{accounts,networks,scrollback,session,irc,pubsub,log,vault}.ex`, CLAUDE.md `### Phoenix / Ecto patterns`
**Severity:** MEDIUM

Adding e.g. `Grappa.Logging` requires deciding: Boundary annotation
shape (`top_level?`, `deps`, `exports`, `dirty_xrefs`, sub-boundaries —
5-way matrix); whether to add a child to the supervision tree (only
some contexts boot a process); whether to add a Wire module; DataCase
sandbox setup; doc updates. Existing contexts have divergent answers.
NO written recipe in CLAUDE.md or DESIGN_NOTES; the answer is "copy
Networks for stateful, copy Accounts for simpler."

**Impact:** Every new context is novel decision-tree. Reviewers
re-litigate "is this dep allowed" each time. Pattern propagation rule
("the codebase IS the instruction set") means the FIRST context added
without explicit guidance becomes the template.

**Recommendation:** `docs/patterns/adding-a-context.md` covering
Boundary template, supervision wiring decision, Wire-shape decision,
custom `Ecto.Type` (Meta is canonical example), Repo-call rules
(only context boundary calls Repo, schemas never), DataCase extension.
Reference from CLAUDE.md.

---

### A20. `Grappa.Session.Server.handle_info` will balloon under Phase 5 presence-event capture
**Concern:** Cohesion (anticipatory)
**Scope:** `lib/grappa/session/server.ex` `handle_info` clauses
**Severity:** LOW (today; HIGH the moment Phase 5 starts)

Server is documented as orchestration but `handle_info` clauses
contain protocol-aware logic: numeric 1 autojoin, `:ping → send_pong`,
`:privmsg → persist + broadcast`, presence-event `Logger.info`. The
`persist_and_broadcast/4` private fn knows Topic shape, Wire shape,
Scrollback persist shape — three boundaries crossed. When Phase 5
lights up presence persistence, current 9-clause `handle_info` becomes
50-line switchboard. `@logged_event_commands` allowlist becomes
`@persisted_event_commands` with per-kind body/meta extraction.

**Recommendation:** Fold into A6 fix — introduce
`Grappa.Session.EventRouter` (pure: `route(message, state)`) and have
Server delegate. Same shape as A3 split for Client. `persist_and_broadcast/4`
moves to a `Grappa.Session.Broadcaster` because it owns the Wire+Topic+Scrollback
contract.

---

### A21. `Grappa.Networks.Credential` schema embeds business policy
**Concern:** Cohesion
**Scope:** `lib/grappa/networks/credential.ex`
**Severity:** LOW

Schema carries: auth-method-coupled password presence rule, "auth_method
changed → require fresh password" anti-footgun, `effective_realname`/
`effective_sasl_user` helpers called from `Networks.session_plan`'s
`build_plan`, `upstream_password/1` accessor. Schema reaches across
boundaries to enforce wire-shape rules belonging to IRC layer
(`Identifier.safe_line_token?` validations on every text field).
Two enforcement points for auth/password rule: changeset + `IRC.Client.validate_password_present`.

**Recommendation:** Move `effective_*` and `upstream_password` to
`Grappa.Networks.CredentialPolicy` consumed by SessionPlan resolver.
Keep `Credential` to schema + cast + simple regex validations.
`IRC.Client.validate_password_present` becomes redundant — delete
and trust the boundary.

---

### A22. `Grappa.Log` narrow-API masquerades as cross-cutting concern
**Concern:** Cohesion
**Scope:** `lib/grappa/log.ex`
**Severity:** LOW

Module named `Grappa.Log` but API is exclusively about session context
(`session_context/2`, `set_session_context/2`, `@type session_metadata`).
Moduledoc admits `Session.Server` is the only caller. No general-purpose
logging concern: no formatter config, no metadata-key allowlist (in
`config/config.exs`), no telemetry helpers. Pre-claims a namespace for
nothing.

**Recommendation:** Rename `Grappa.Session.LogContext` (or fold into
`Grappa.Session` — 4 lines each). Reserve `Grappa.Log` for actual
cross-cutting logging infrastructure when Phase 5 lands JSON formatter
+ PromEx integration.

---

### A23. `Network.network_to_json/1` exports `id`/`updated_at` no client consumes
**Concern:** Boundaries
**Scope:** `lib/grappa/networks/wire.ex`, `lib/grappa_web/controllers/networks_controller.ex`, `cicchetto/src/lib/api.ts Network`
**Severity:** LOW

`Network.network_to_json/1` emits `{id, slug, inserted_at, updated_at}`.
Every other door in the system says integer `id` is FK-internal:
`MessagesController` resolves `:network_id` from URL slug, `Topic`
only knows the slug, `cicchetto`'s `joinChannel` uses slugs verbatim.
Integer is sent on wire then never consumed by any client code.
`inserted_at`/`updated_at` similarly have no PWA consumer.

**Recommendation:** Drop `id`/`inserted_at`/`updated_at` from
`network_json`, keep `{slug}`. Mirror in `cicchetto/src/lib/api.ts`
follows. If ID-by-slug is the contract everywhere, enforce at the wire too.

---

### A24. `Networks.Wire.credential_to_json/1` exported but unused
**Concern:** Boundaries
**Scope:** `lib/grappa/networks/wire.ex credential_to_json/1`
**Severity:** LOW

Function carries thoroughly-documented "CRITICAL — read before adding
fields" moduledoc + per-field shape. No code in `lib/grappa_web/`
calls it; no cicchetto type mirrors it. Exists exclusively as defense
for a future endpoint. Defensive scaffolding without consumer is
maintenance liability — gets updated when fields drift but never
against a real wire.

**Recommendation:** Either land `GET /networks/:slug/credential`
endpoint OR move next to test that exercises it + label "scaffolding-only,
no production consumer."

---

### A25. `Scrollback` boundary `dirty_xrefs: [Networks.Network]` papers over real cycle
**Concern:** Boundaries / Dependency
**Scope:** `lib/grappa/scrollback.ex:48`, `lib/grappa/networks.ex:50`, `lib/grappa/scrollback/{message,wire}.ex`
**Severity:** LOW

`Scrollback` declares `dirty_xrefs: [Grappa.Networks.Network]` to
permit `belongs_to :network, Network` and `%Network{slug: _}` pattern.
Meanwhile `Networks` deps `Scrollback` (calls
`Scrollback.has_messages_for_network?/1`). Real bidirectional edge;
`dirty_xrefs` only prevents Boundary compiler from flagging it.
Future drift (function call into Networks, not just struct access)
lands silently in the gap.

**Recommendation:** Either (a) lift `network_slug` denormalised onto
`messages` row — Wire reads `m.network_slug` directly; FK stays
`network_id`; OR (b) `Networks.slug_for/1` accessor — function-call
edge cleaner than struct-shape coupling. Option (a) is the more honest
fix. Document choice in DESIGN_NOTES.

---

### A26. `MessageKind` mirror has no compile-time link to server `@kinds`
**Concern:** Duplication
**Scope:** `lib/grappa/scrollback/message.ex:87-98`, `cicchetto/src/lib/api.ts:59-69`
**Severity:** LOW

Client union is hand-typed. Moduledoc comment says "must mirror" —
no test-time or build-time check. C3 has shown this lands successfully
when an extra kind is appended; minor risk for one enum, more
acceptable as the pattern repeats (A12 auth_method, A14 meta keys,
A11 error tokens).

**Recommendation:** Phase 5 `mix grappa.gen_ts_types` codegen task —
emits `cicchetto/src/lib/__generated__/wire.ts` from
`Scrollback.Message.kinds/0`, `Credential.auth_methods/0`,
`FallbackController` error tokens, `Scrollback.Meta.known_keys/0`.
One generator covers all four cases — the right answer to "is the
pattern documented as repeatable?" Not now; document in DESIGN_NOTES
as "the cross-language closed-set pattern."

---

### A27. Logger metadata key allowlist not statically checked vs callsites
**Concern:** Type system
**Scope:** `config/config.exs:69`, all `Logger.info/warning/error/debug` callsites
**Severity:** LOW

`:metadata` allowlist in `config/config.exs` is canonical type for
"things Logger may carry." `Scrollback.Meta.@known_keys` ↔ Logger
metadata sync is documented and tested but not statically checked
between allowlist and Logger callsites. CP10 S55-class drift could
re-emerge — no compile-time gate that `Logger.info("foo", new_key:
...)` lands a key in allowlist. Current shape is "test catches it
post-hoc."

**Recommendation:** `Grappa.Log.event/3`-shape facade with
`@type metadata_kw :: [user: ..., network: ..., ...]` Dialyzer gate.
Routes every Logger call through one typed entry point. Alternative:
Credo custom check.

---

### A28. `auth_command_template` field unused — dead OR untyped escape hatch
**Concern:** Type system
**Scope:** `lib/grappa/networks/credential.ex:53,85,111,133`, `wire.ex:36`
**Severity:** LOW

`auth_command_template: String.t() | nil` carries "free-form NickServ
verbs" per moduledoc but is never read by `IRC.Client` or `Session.Server`
(`grep` returns only schema/wire/changeset references — no consumer).
Dead code OR future foot-gun (next implementer treats it as template
literal). CLAUDE.md "Will this still exist in two weeks?" gate.

**Recommendation:** Either remove field OR, when consumer lands, type
template format as closed structure (`%{verb: :identify | :ghost |
:register, args: [String.t()]}`).

---

### A29. Supervision-tree ordering documented but not test-enforced
**Concern:** Dependency
**Scope:** `lib/grappa/application.ex:14-47`, `lib/grappa/bootstrap.ex` moduledoc
**Severity:** LOW

`application.ex` carries excellent inline comments documenting WHY
the order is Vault → Repo → PubSub → Registry → DynamicSupervisor →
Endpoint → Bootstrap. Bootstrap's moduledoc redocuments. Future child
addition (Phase 5 telemetry exporter, observer_cli, LiveDashboard on
separate Endpoint) — rule "anything that depends on a started thing
comes after it" is in CLAUDE.md and comments — but it's a rule, not
a test.

**Recommendation:** Architectural test asserting child-spec ordering
matches a documented list, OR property like "every child whose moduledoc
claims it depends on `Grappa.PubSub` appears AFTER `{Phoenix.PubSub,
...}` in `children/0`." Pin formally before Phase 5 starts adding
children.

---

### A30. Phase 6 listener readiness — schema 80% there, encode-side gap + msgid migration unbrainstormed
**Concern:** Extension
**Scope:** `lib/grappa/scrollback/message.ex` (msgid deferred), `lib/grappa/irc/parser.ex` (encode-side gap), `lib/grappa/scrollback/wire.ex` (JSON-only)
**Severity:** LOW

Schema documents future `msgid` column explicitly. Cursor logic in
`Scrollback.fetch/5` is `before` (single-int). Phase 6 listener will
need: (a) `msgid` column, (b) tuple-cursor `fetch/N` variant, (c)
query translation `CHATHISTORY BEFORE msgid=X LIMIT N` to Ecto query.
First two mechanical; third is the listener facade. `Wire.to_json/1`
is JSON-only — Phase 6 emits IRC bytes; need parallel
`Wire.to_irc_message/1` (returning `%Grappa.IRC.Message{}` for
`Parser.encode/1`). Verify `Parser.encode/1` exists on encode side
(parser primarily decodes today).

**Impact:** Listener facade is ~3 modules + schema migration +
serializer. Most decision-cost paid (Wire-shape, topic shape, schema
shape). Risk: migration backfill — adding `msgid` to populated table
on operator's prod DB requires backfill strategy (synthesize from
`(network, server_time, id)`? leave NULL and degrade gracefully?).

**Recommendation:** `docs/plans/phase6-listener.md` stub (even empty)
as forcing function for design decisions: msgid backfill strategy,
encode-side `Parser.encode/1` verification, listener-side acceptor.
Wire-shape `to_json/1` should grow sibling `to_message/1` returning
`%IRC.Message{}` (struct, not bytes — bytes happen at `Parser.encode/1`).

---

## Recommendation: trajectory

### What this review confirms

- **Server-side type/boundary discipline is strong.** 22 Boundary
  annotations enforced. Wire modules are single-source-of-truth per
  domain. Identifier validation centralized. Topic helpers centralized.
  Error envelope centralized. Phase 2/3 absorbed correctly into
  existing structures.
- **The cicchetto seam is the new structural weakness.** Six
  cross-language enums hand-mirrored without compile-time link. JSON
  decoding bypasses tsconfig strict via `as` casts. Topic strings,
  error tokens, MessageKind, auth_method, meta keys all redeclared
  client-side. None of these are bugs today — they are drift surfaces.
- **Three modules need splitting before Phase 5/6.** `Grappa.Networks`,
  `Grappa.IRC.Client`, `cicchetto/src/lib/networks.ts`. Each is the
  largest file in its layer. Each will absorb Phase 5/6 surface area
  if not split first.
- **Phase 5 presence-event capture has a producer-shaped hole.** Wire
  contract advertises 10 kinds; producer writes 1. Three modules drift
  in lockstep against an unimplementable shape. The fix is paired with
  `Scrollback.persist_event/1` + `Grappa.Session.EventRouter` extraction
  — both should land before the first presence kind ships.

### Direction (3 sentences)

The user's stated next move — fix all CP10 review correctness carryovers
(C5 security + C6 IRC-state + C7 channel-test flake + C8 omnibus) — is
the right immediate path; this review's MEDIUM findings are all
structural debt, not correctness bugs, so they don't displace the
correctness campaign. The HIGH findings (A1-A4) cluster cleanly into
"D-series" architectural mini-clusters that should land between the
correctness campaign and Phase 4 brainstorm — A1 folds naturally into
C7 (token-rotation cleanup is half the S17 fix), A2/A3/A4 are each a
half-session split-and-test refactor that should NOT be deferred to
"naturally surface during Phase 4" (the same anti-pattern that produced
this review). Phase 4 brainstorm should begin AFTER the C5-C8 correctness
campaign closes AND after at minimum A4 (cicchetto/lib/networks.ts split)
lands, so the brainstorm operates on clean modules instead of recreating
the god-module shape in components.
