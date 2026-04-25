# Architecture Review — 2026-04-25

**Branch / commit baseline:** `main` @ `76bbc8e` (post-S12, walking-skeleton complete, prod live).
**Review type:** architecture (concern-based structural analysis).
**Dispatched:** 6 parallel agents, one per concern (abstraction boundaries, responsibility & cohesion, duplication, dependency architecture, type system leverage, extension & maintainability).
**Findings:** 24 (after dedup across overlapping concerns). 4 CRITICAL, 6 HIGH, 10 MEDIUM, 4 LOW.

This is **architecture, not line-level**. Findings are structural patterns. Line-level
bugs go in `docs/reviews/codebase/`.

Codebase shape at review time:
- `lib/grappa/` — application (Repo, Bootstrap, Config, Release), `irc/` (Parser,
  Client, Message), `scrollback/` (Message, Meta + context), `session/` (Server +
  facade).
- `lib/grappa_web/` — Endpoint, Router, controllers (Health, Messages, Fallback),
  channels (UserSocket, GrappaChannel).
- 121 tests + 5 properties; ci.check green at baseline.

---

## Summary table

| ID  | Title                                                                   | Concern                  | Severity |
|-----|-------------------------------------------------------------------------|--------------------------|----------|
| A1  | No PubSub topic helper — string-interpolation duplicated 2× + validated 3rd-place | Duplication / Boundaries | CRITICAL |
| A2  | `Message.command` is `String.t()` not atom enum                         | Type system              | CRITICAL |
| A3  | Session.Server mixes IRC framing with session lifecycle                 | Cohesion                 | CRITICAL |
| A4  | Session.Server reaches into wire-shape `to_wire/1` for broadcast        | Cohesion                 | CRITICAL |
| A5  | Session.Server pattern-matches `{:nick, n, _, _}` prefix tuple directly | Boundaries               | HIGH     |
| A6  | Session.Server accesses `Config.Network` struct fields without accessors| Boundaries               | HIGH     |
| A7  | Wire-shape `to_wire/1` lives in schema, not in dedicated formatter      | Cohesion                 | HIGH     |
| A8  | Logger metadata schema is implicit, no canonical helper                 | Duplication              | HIGH     |
| A9  | `Config.Network.host`/`nick` accept any `String.t()` — no RFC validation| Type system              | HIGH     |
| A10 | Scrollback identifiers (`network_id`, `channel`, `sender`) unconstrained| Type system              | HIGH     |
| A11 | `Boundary` library installed but no `use Boundary` annotations          | Dependency               | MEDIUM   |
| A12 | `Config` couples TOML I/O with schema validation                        | Cohesion                 | MEDIUM   |
| A13 | `Bootstrap` couples config loading with session spawning                | Cohesion                 | MEDIUM   |
| A14 | `MessagesController` constructs Scrollback insert attrs                 | Cohesion                 | MEDIUM   |
| A15 | `@spec` gap on private helpers in `Scrollback.Meta` + `Application`     | Type system              | MEDIUM   |
| A16 | Phoenix.Channel event payload shape is implicit (no typed contract)     | Type system              | MEDIUM   |
| A17 | Test fixtures hand-craft expected wire shape, bypassing `to_wire/1`     | Duplication              | MEDIUM   |
| A18 | `Meta.@known_keys` + Logger `:metadata` allowlist require manual 2-file sync | Extension          | MEDIUM   |
| A19 | Supervision tree ordering is correct but undocumented                   | Dependency               | MEDIUM   |
| A20 | Bootstrap `:no config` warning conflates 3 causes                       | Boundaries               | MEDIUM   |
| A21 | `signing_salt` + TLS `verify_none` hardcoded in module bodies           | Cohesion / Type          | LOW      |
| A22 | `Config.load/1` returns `{:error, String.t()}` — undiscriminated        | Type system              | LOW      |
| A23 | IRC command not case-normalized at parser boundary                      | Boundaries               | LOW      |
| A24 | NICK/USER handshake constructed inline in `Session.init/1`              | Boundaries               | LOW      |

A20, A21 already in `docs/todo.md` Phase 5 list. Kept here for completeness.

---

## CRITICAL

### A1. No PubSub topic helper — duplication + drift surface

**Concern:** Duplication / Boundaries
**Scope:** `lib/grappa_web/controllers/messages_controller.ex:98`,
`lib/grappa/session/server.ex:129`,
`lib/grappa_web/channels/grappa_channel.ex:27-45`,
`lib/grappa_web/channels/user_socket.ex:17-18`.

**Problem:** The topic string `"grappa:network:#{net}/channel:#{chan}"` is hand-built
by string interpolation in **two broadcast call sites** (REST controller +
Session.Server). The matching shape is **validated separately** in the channel join
guard (`grappa_channel.ex:27-45`) and the **router wildcards** in `user_socket.ex`
declare a third copy of the prefix pattern. Wire-shape unification (`Message.to_wire/1`)
exists for the **payload**; no equivalent exists for the **topic**.

CLAUDE.md mandates `grappa:` prefix discipline and the topic format is
load-bearing for Phase 6 (listener facade must subscribe to identical topics — no
state bifurcation). Today the format lives in 4 places.

**Impact:**
- Typo or interpolation error in either broadcaster silently routes to a topic
  nobody subscribes to. Tests pass; messages disappear.
- Adding a new topic shape (presence, system broadcast) requires 4 coordinated
  edits: router, channel guard, two broadcast sites.
- Phase 6 listener will copy the same hardcoded format, deepening the drift.

**Recommendation:** Create `Grappa.PubSub.Topic` module with:
```elixir
def channel(network_id, channel), do: "grappa:network:#{network_id}/channel:#{channel}"
def network(network_id),          do: "grappa:network:#{network_id}"
def user(user_name),              do: "grappa:user:#{user_name}"
def parse(topic), do: ...                # → {:channel, net, chan} | {:network, net} | {:user, u} | :error
def valid?(topic), do: parse(topic) != :error
```
All broadcasters call `Topic.channel(net, chan)`; channel join guard calls
`Topic.parse/1`. Router keeps wildcards but defers validation to channel via
`Topic`. Single source of truth, additive for new shapes.

---

### A2. `IRC.Message.command` is `String.t()` — closed set, untyped

**Concern:** Type system leverage
**Scope:** `lib/grappa/irc/message.ex:46`, `lib/grappa/irc/parser.ex` (entire),
`lib/grappa/session/server.ex` (handlers at lines 102, 107, 113, 145, 148).

**Problem:** The IRC command set is **closed**: ~13 RFC 2812 verbs + 999 numeric
codes. `Message.command` is typed `String.t()` and the parser does not normalize
case. `Session.Server` matches hardcoded uppercase strings (`"PRIVMSG"`,
`"PING"`, `"001"`). The catch-all clause swallows mismatches.

The parser moduledoc explains the choice as "atom-table-DoS surface" — that
argument applies to **unbounded user content** (message bodies, nicks), not to a
fixed protocol vocabulary of ~110 tokens. CLAUDE.md is explicit: *"Atoms or
`@type t :: literal | literal` — never untyped strings."*

**Impact:**
- Dialyzer cannot prove handler exhaustiveness — the type is `String.t()`, not a
  union. Forgetting to handle a new numeric is silent.
- Case-sensitivity bug surface: if any future parser change or upstream variant
  shifts case, every handler match silently fails through to the catch-all.
- Phase 6 listener will need to re-decide command typing. Diverging there is
  certain unless this is fixed first.
- Logger metadata `:command` (A8 below) is also typed `String.t()` — fixing one
  fixes both.

**Recommendation:** Define
```elixir
@type command :: :privmsg | :notice | :join | :part | :quit | :nick | :user
              | :mode | :topic | :kick | :ping | :pong | :cap
              | {:numeric, 0..999}
              | {:unknown, String.t()}      # only for non-RFC vendor commands
```
Parser atomizes against an explicit allowlist (one constant). `Session.Server`
matches atoms; Dialyzer can now check exhaustiveness. The `{:unknown, _}` arm
preserves forward-compatibility for vendor extensions without atom-table risk.

---

### A3. `Session.Server` mixes IRC protocol framing with lifecycle

**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/server.ex` (lines 92-93 NICK/USER, 107-110 PONG,
113-142 PRIVMSG handler).

**Problem:** Session.Server owns two concerns that should be separate:
1. **IRC protocol mechanics** — constructs raw wire format inline:
   `Client.send_line(client, "NICK #{net.nick}\r\n")`, `Client.send_line(client,
   "PONG :#{token}\r\n")`. CRLF framing, command syntax, colon-prefix for trailing
   params: protocol detail.
2. **Session policy** — when to autojoin, what to persist, what to broadcast.

`Grappa.IRC.Client` already exposes typed helpers (`send_join/2`, `send_part/2`,
`send_privmsg/3`), but Session bypasses them for NICK/USER/PONG.

**Impact:**
- Phase 5 SASL/CAP handshake adds ~30 lines of NICK/USER/CAP sequencing — that
  state machine has no home today; it will land inside Session.
- Tests for session behaviour must encode IRC wire format expectations (`"NICK
  vjt\r\n"`) instead of policy outcomes ("session sends nick handshake").
- Phase 6 listener will need outbound framing too; the inline pattern will
  duplicate.

**Recommendation:** Move all wire construction into `IRC.Client`:
- `Client.send_handshake(client, nick, user)` — emits NICK + USER.
- `Client.send_pong(client, token)`.
- `Client.send_quit(client, reason)` (already present? if not, add).
Session calls these helpers exclusively. `send_line/2` becomes private to Client
or only used for raw debug. Wire-format knowledge concentrated in one module.

---

### A4. `Session.Server` depends on `Scrollback.Message.to_wire/1` for broadcast

**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/server.ex:130`,
`lib/grappa_web/controllers/messages_controller.ex:99`.

**Problem:** Session.Server constructs the broadcast event by calling
`Grappa.Scrollback.Message.to_wire(message)` — a function whose purpose is to
produce the **JSON wire shape** consumed by web clients. Session is pure
IRC/lifecycle machinery; coupling it to the JSON serializer ties session
correctness to the web contract.

The wire-shape unification (verified working — same `to_wire/1` is used by REST
controller, JSON view, channel push) is the right principle, but it should
expose the **broadcast event** as the contract, not the raw wire shape that the
broadcaster has to wrap.

**Impact:**
- Adding a field to `Message` requires updating `to_wire/1` AND every
  broadcaster (currently 2) to construct the event map.
- Session test must assert exact JSON shape, not domain outcome.
- Phase 6 listener (downstream IRC server) emits a different wire format (IRC
  protocol bytes, not JSON) — yet still needs the same domain "PRIVMSG happened"
  event. Coupling Session to JSON makes this awkward.

**Recommendation:** Move broadcast-event construction into the Scrollback
context as a public helper:
```elixir
# In Grappa.Scrollback
def message_event(%Message{} = m), do: {:event, %{kind: :message, message: Message.to_wire(m)}}
```
Both broadcasters call:
```elixir
:ok = Phoenix.PubSub.broadcast(Grappa.PubSub, Topic.channel(net, chan), Scrollback.message_event(message))
```
Combined with A1 (Topic helper), the broadcast becomes one line, contract-owned
by the Scrollback context, and Session no longer imports `Message`.

---

## HIGH

### A5. Session.Server pattern-matches `IRC.Message` prefix tuple shape directly

**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/session/server.ex:162-164` (`nick_of/1` private helper).

**Problem:** `nick_of/1` destructures `{:nick, nick, _, _}` and `{:server, server}`
— internal tuple shapes from `IRC.Message.prefix`. This embeds parser internals
into the session layer. Any reshape (e.g., to a struct) silently breaks the match.
Phase 5 presence handlers (JOIN, PART, QUIT, NICK, MODE) will need the same
extraction; the three-clause pattern will be copy-pasted.

**Impact:** Brittle to parser evolution; future presence work duplicates.

**Recommendation:** Make `nick_of/1` (rename: `Message.sender_nick/1`) a public
function on `Grappa.IRC.Message`. Prefix shape stays internal to the IRC module.

---

### A6. Session.Server accesses `Config.Network` struct fields directly

**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/session/server.ex` references `state.network.host`,
`state.network.port`, `state.network.tls`, `state.network.nick`,
`state.network.id`, `state.network.autojoin`.

**Problem:** Session is tightly bound to the `Config.Network` struct field names.
Phase 2 will introduce per-user DB-backed network credentials (encrypted SASL
passwords); the source of network records will move from TOML-derived structs to
Ecto-backed records with potentially different field shapes. Today's
direct-field-access pattern means every shape change ripples into Session.

**Impact:** Phase 2 refactor is not just "swap the source"; it's "audit every
field reference".

**Recommendation:** Add accessors on the `Config` module — `network_host/1`,
`network_nick/1`, `network_autojoin/1`, etc. — or change Session to take only the
data it needs (`%{host:, port:, tls:, nick:, id:, autojoin:}`) at start_link
time. The `Network` struct stays internal to Config.

---

### A7. `to_wire/1` lives in the schema module, not a dedicated formatter

**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/scrollback/message.ex:178-190`.

**Problem:** Schemas describe data shape. Wire format is a transformation
(verb). Mixing them inflates the schema moduledoc with wire contract docs and
makes the schema module the import target for any serialization concern. When
Phase 6 needs an IRC-wire serializer (different format), there is no clean home
for it — adding `to_irc_wire/1` to the schema doubles the smell.

**Impact:** Schema accretes unrelated responsibilities; multiple wire formats
in one module become a `case format` switch.

**Recommendation:** Move to `Grappa.Scrollback.Wire` (or `Format`). Schema stays
"data + changeset". `MessagesJSON` calls `Wire.to_json/1`. Phase 6 adds
`Grappa.IRCv3.Listener.Wire` alongside without disturbing the schema.

---

### A8. Logger metadata schema is implicit; no canonical setter

**Concern:** Duplication
**Scope:** `lib/grappa/session/server.ex:82` (`Logger.metadata(user:, network:)`),
`lib/grappa/irc/client.ex:89` (accepts `logger_metadata:` from session via opts),
`lib/grappa/bootstrap.ex:90` (per-log `user:, network:` keys ad-hoc),
`config/config.exs:25-50` (allowlist).

**Problem:** Three patterns for the same metadata: Session uses
`Logger.metadata/1` at init, Client takes metadata as a `start_link` option,
Bootstrap passes per-log keys. The `:user`/`:network` schema is consistent today
but not enforced; per-log keys (`:command`, `:channel`, `:sender`, `:target`)
are added ad-hoc without a documented contract.

**Impact:** Phase 5 modules (presence, multi-network state) will reinvent the
metadata pattern. Structured-logging tooling (Phase 5 PromEx + JSON formatter)
cannot rely on a consistent context schema.

**Recommendation:** Add `Grappa.Log` module exporting `set_session_context(user,
network)` and a documented `@type context` listing canonical keys. All session
code calls the helper. The allowlist in `config/config.exs` becomes the
single allowlist — and (per A18) Meta's `@known_keys` should auto-extend it at
boot to remove the manual two-file sync.

---

### A9. `Config.Network.host`/`nick` accept any `String.t()` — no syntax validation

**Concern:** Type system leverage
**Scope:** `lib/grappa/config.ex:107-129` (`build_network/1`).

**Problem:** TOML-loaded `host` and `nick` are validated only as `is_binary`.
RFC 2812 specifies nick syntax (`nickname = (letter / digit) *8(letter / digit
/ special)`). Hostname has DNS-label rules. A typo with spaces or control chars
loads cleanly and breaks at first connect attempt.

**Impact:** Operator misconfiguration is detected late, far from cause.

**Recommendation:** Add validators in `build_network/1`:
- `nick` regex: `~r/^[A-Za-z][\w\-\[\]\\`^{|}]{0,15}$/` (RFC 2812 + bracket chars).
- `host` regex: `~r/^([a-zA-Z0-9](-?[a-zA-Z0-9])*\.)*[a-zA-Z0-9](-?[a-zA-Z0-9])*$/`
  or accept IP literals.
Reject at config-load time with a clear message.

---

### A10. Scrollback identifiers (`network_id`, `channel`, `sender`) are unconstrained `String.t()`

**Concern:** Type system leverage
**Scope:** `lib/grappa/scrollback/message.ex:116-120`.

**Problem:** Same class as A9 but at the persistence boundary. The schema
enforces presence but not format. A buggy upstream (or future Phase 5 producer)
inserting a malformed channel name (`"#foo bar"`, missing `#`) round-trips
silently. Web clients receive bad data via `to_wire/1`.

Also: `network_id` is used as a PubSub topic component (A1). A `network_id`
containing `/` corrupts the topic structure.

**Impact:** Bad data persists; queries return malformed identifiers; PubSub
routing can collide.

**Recommendation:** Add changeset validators:
- `network_id` — `~r/^[a-z0-9_-]+$/i` (no path separators, no whitespace).
- `channel` — must start with `#` or `&` per RFC 2812 §1.3.
- `sender` — RFC 2812 nick or server name (delegate to a shared validator with A9).
The validators live on the changeset; the type stays `String.t()` (Elixir can't
express regex in types). One source of truth via shared regex constants.

---

## MEDIUM

### A11. `Boundary` library installed but no `use Boundary` annotations

**Concern:** Dependency architecture
**Scope:** `mix.exs` declares `{:boundary, "~> 0.10", runtime: false}` and
configures `default: [check: [in: true, out: true]]`. No module uses `use
Boundary`.

**Problem:** Boundary is a compile-time check that needs explicit annotations
to fire. With zero `use Boundary`, it has nothing to enforce — the gate is
silent. Phase 1 Task 10 (per todo) is meant to add annotations; today the
library is inert.

**Impact:** The investment (mix dep + config) does no work. Cross-context
imports are unchecked. Adding annotations later in bulk will surface a flood of
(possibly real) violations all at once.

**Recommendation:** Phase 1 Task 10 work — add `use Boundary, classify_to:
:public` (or appropriate) to top-level context modules: `Grappa.Scrollback`,
`Grappa.Session`, `Grappa.Bootstrap`, `Grappa.IRC`. Wire `mix boundary.spec`
into `mix ci.check`.

---

### A12. `Config` couples TOML I/O with schema validation

**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/config.ex` — `load/1` (I/O + parse) + `build_*/1` (validation).

**Problem:** Two jobs in one module. Phase 2 (per-user config via REST API) will
need the validator without the TOML loader.

**Recommendation:** Extract `Config.validate(map())` as a pure function. `load/1`
stays as `File.read |> Toml.decode |> validate`. Phase 2 REST handler calls
`validate/1` directly on parsed JSON.

---

### A13. `Bootstrap` couples config loading with session spawning

**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/bootstrap.ex`.

**Problem:** Bootstrap reads TOML and iterates spawning sessions. Phase 2 REST
"add network" endpoint will reimplement the spawn loop.

**Recommendation:** Extract `Grappa.Session.spawn_batch(users)` returning
`%{started:, failed:}` stats. Bootstrap becomes 4 lines: load → spawn_batch →
log. REST handler in Phase 2 calls `spawn_batch/1` directly with one user.

---

### A14. `MessagesController.create/2` constructs Scrollback insert attrs

**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa_web/controllers/messages_controller.ex:76-85`
(hardcoded `sender: "<local>"` placeholder).

**Problem:** Controller assembles domain attrs (network_id, channel,
server_time, kind, sender, body) and calls `Scrollback.insert/1`. When auth
lands (Phase 2), the sender source moves but the attrs construction stays in
the controller — it should never have been there.

**Recommendation:** Add `Scrollback.persist_outbound(%{network:, channel:,
sender:, body:})` that owns kind selection (`:privmsg`), server_time, and
delegates to `insert/1`. Controller calls the helper.

---

### A15. `@spec` gap on private helpers in `Scrollback.Meta` + `Application`

**Concern:** Type system leverage
**Scope:** `lib/grappa/scrollback/meta.ex` (private helpers
`atomize_known/1`, `normalize_key/1`, `stringify/1`),
`lib/grappa/application.ex` (`bootstrap_child/0`).

**Problem:** Dialyzer infers, but explicit `@spec` is the documented project
norm (`:underspecs` is on). Inconsistency invites future drift.

**Recommendation:** Add specs. Mechanical, no behavioural change.

---

### A16. Phoenix.Channel event payload shape is implicit

**Concern:** Type system leverage
**Scope:** `lib/grappa_web/channels/grappa_channel.ex:48-50`,
`lib/grappa_web/controllers/messages_controller.ex:99-100`,
`lib/grappa/session/server.ex:130`.

**Problem:** The payload tuple `{:event, %{kind: :message, message: ...}}` is
typed nowhere. Broadcasters and consumers agree by convention.

**Recommendation:** Define `@type event :: {:event, %{kind: :message, message:
Message.wire()}}` in `Grappa.PubSub.Event` (or alongside `Topic` from A1). Spec
the broadcast helper from A4 to return this type.

---

### A17. Test fixtures hand-craft expected wire shape

**Concern:** Duplication
**Scope:** `test/grappa_web/controllers/messages_controller_test.exs:119-131`,
`test/grappa/session/server_test.exs:171-185`.

**Problem:** Two tests assert the broadcast payload by inlining the wire shape
map (`%{kind: :message, message: %{kind: :privmsg, body: ..., ...}}`). The
channel test correctly builds via `Message.to_wire/1`. If `to_wire/1` adds a
field, the two inline assertions miss it.

**Recommendation:** Test helper `assert_message_event(payload, expected_attrs)`
in `test/support/grappa_assertions.ex`. Tests assert outcomes (sender, body,
channel) not full shape.

---

### A18. `Meta.@known_keys` + Logger `:metadata` allowlist require manual 2-file sync

**Concern:** Extension & maintainability
**Scope:** `lib/grappa/scrollback/meta.ex:64`, `config/config.exs:25-50`.

**Problem:** Adding a new event meta field needs both:
1. `Meta.@known_keys` (DB round-trip atomization).
2. Logger `:metadata` allowlist (or the field is silently dropped from logs).

The coupling is documented but not enforced. Easy to forget one.

**Recommendation:** Either (a) Add a checklist entry to `CLAUDE.md` ("Adding a
new IRC meta field"), or (b) remove the manual sync by extending the Logger
allowlist programmatically at boot via `:logger.add_handler` or a config helper
that reads `Meta.@known_keys`. (b) is preferable — the compiler enforces.

---

### A19. Supervision tree ordering is correct but undocumented

**Concern:** Dependency architecture
**Scope:** `lib/grappa/application.ex` children list.

**Problem:** The order (`Repo` → `PubSub` → `Registry` → `DynamicSupervisor` →
`Endpoint` → `Bootstrap`) is correct and load-bearing. Zero comments explain
why. A future maintainer reordering for "logical" reasons (HTTP first?) would
break boot silently.

**Recommendation:** Add a comment block listing the WHY for each entry. CLAUDE.md
explicitly mandates documenting supervision-tree ordering changes; today's
state has nothing to amend, so add the doc proactively.

---

### A20. Bootstrap `:no config` warning conflates 3 causes

**Concern:** Abstraction boundaries (operator UX)
**Scope:** `lib/grappa/bootstrap.ex:54-65`.

**Problem:** Missing file / malformed TOML / missing required field all log the
same warning. Operator can't diagnose without re-reading code.

**Status:** Already in `docs/todo.md` Phase 5 hardening list. Noted here for
completeness — should split error tags and emit distinct warnings.

---

## LOW

### A21. `signing_salt` + TLS `verify_none` hardcoded in module bodies

**Concern:** Cohesion / Type system / Security
**Scope:** `lib/grappa_web/endpoint.ex:28` (signing_salt: `"rotate-me"`),
`lib/grappa/irc/client.ex:151` (`verify: :verify_none`).

**Status:** Already in `docs/todo.md` Phase 5 hardening list. Per CLAUDE.md
"credentials via env vars only" — both should move to `runtime.exs`. Salt
particularly important to lift **before** Phase 2 introduces auth (cookies
signed with placeholder become a security debt requiring full rebuild to
rotate).

---

### A22. `Config.load/1` returns `{:error, String.t()}` — undiscriminated

**Concern:** Type system leverage
**Scope:** `lib/grappa/config.ex:57-68`.

**Problem:** Single string error type collapses file-not-found / parse-error /
validation-error. Callers cannot branch programmatically.

**Recommendation:** `@type load_error :: :file_not_found | {:invalid_toml,
String.t()} | {:invalid_config, String.t()}`. Bootstrap can then log distinctly
(addresses A20 partially) and Phase 2 REST handler can return appropriate HTTP
codes (404 vs 422).

---

### A23. IRC command not case-normalized at parser boundary

**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/irc/parser.ex` (does not normalize),
`lib/grappa/session/server.ex` (matches uppercase strings).

**Problem:** RFC 2812 commands are case-insensitive; servers send uppercase by
convention. If any upstream variant or future parser change shifts case,
`Session.Server`'s pattern matches silently fail.

**Status:** Subsumed by A2. Atomization (against an allowlist) implicitly
case-normalizes since the allowlist is canonical.

---

### A24. NICK/USER handshake constructed inline in `Session.init/1`

**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/session/server.ex:92-93`.

**Status:** Subsumed by A3. The fix (`Client.send_handshake/3`) covers this.

---

## Cross-cutting themes

Three structural patterns recur across multiple agents' findings:

1. **Wire-format / topic-format helpers missing.** A1 (topic), A2 (command type),
   A4 (event helper), A8 (logger metadata helper) all share the same shape:
   convention exists, helper does not, callers reinvent. **Fix together as
   "Phase 1.5 contract module"** before Phase 2 work begins.

2. **Session.Server is an over-broad concern.** A3 (framing), A4 (wire shape),
   A5 (prefix tuple), A6 (config struct), A24 (handshake): five findings on one
   module. Phase 5 SASL/CAP work will compound this. **Plan a Session.Server
   refactor** before Phase 2 SASL — extract `Session.Protocol` module owning
   IRC framing + handshake state machine; Session.Server becomes a thin
   "lifecycle + persist + broadcast" GenServer.

3. **Identifiers are unvalidated `String.t()`.** A9 (config nick/host), A10
   (scrollback nick/channel/network_id) — IRC has well-defined identifier
   syntax. **Fix together as "boundary validation pass"** with shared regex
   constants in `Grappa.IRC.Identifier`.

## Verified strengths

- **Wire-shape unification (canonical case):** verified working end-to-end. REST
  controller, JSON view, channel push, Session broadcast all route through
  `Message.to_wire/1`. Single source of truth ✓.
- **Dependency direction:** web → contexts → schemas → repo. No reverse
  imports, no horizontal coupling. Comprehensive grep confirms no `Application.put_env`,
  no `Process.put`/`get`, no circular aliases ✓.
- **`Application.fetch_env!` discipline:** only in `application.ex` and
  `release.ex` (the documented exception locations) ✓.
- **No `try/rescue` in production code** (let-it-crash respected) ✓.
- **Test discipline:** outcome-driven, real Repo via Sandbox, in-process IRC
  fake (`Grappa.IRCServer`) instead of mocking `:gen_tcp` ✓.
- **Bootstrap supervision strategy:** correct (`Task` with `restart: :transient`,
  conditional via `:start_bootstrap` flag for tests) ✓.
- **Migration design:** schema future-proofed for all IRC event kinds at Task 8a-pre
  (kind enum extended, body nullable, meta JSON column added) ✓.

## Recommendations — priority order

| Priority | Items                                                                       | Estimate |
|----------|-----------------------------------------------------------------------------|----------|
| Now      | A1 (Topic helper) + A4 (event helper) + A19 (sup-tree comments)             | ~2h      |
| Now      | A2 (command atom enum) — unblocks A8, A23                                   | ~3h      |
| Now      | A3 + A24 (Client owns wire format) — unblocks Phase 5 SASL                  | ~2h      |
| Phase 1.5 | A5 (`Message.sender_nick/1`) + A7 (`Scrollback.Wire`) + A11 (`use Boundary`) | ~3h     |
| Phase 1.5 | A9 + A10 (identifier validation, shared regex constants)                    | ~2h      |
| Phase 2 prep | A6 (Config accessors), A12 (split Config), A13 (`spawn_batch/1`), A14 (controller) | ~3h |
| Phase 5  | A20, A21 (already tracked in todo)                                          | tracked  |
| Cleanup  | A15, A16, A17, A18, A22                                                     | ~2h      |

The **Now** tier (~7h, two sessions) addresses the cross-cutting themes #1 and
#2 — fix before Tasks 9-10 land or before Phase 2 SASL begins. Topic + command
type + protocol-extraction are foundational; deferring compounds the cost.

---

*End of review. No trajectory section — architecture review per skill protocol.
Trajectory belongs to codebase reviews.*
