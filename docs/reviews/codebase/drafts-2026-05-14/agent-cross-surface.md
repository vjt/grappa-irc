# Codebase Review Draft — Cross-Surface (REST ↔ Channel ↔ IRC seams)

**Agent:** cross-surface
**Cluster:** B5 (no-silent-drops)
**Scope:** seams between the three surfaces. NOT a deep dive into any one — that
is for the per-surface agents.
**Date:** 2026-05-14

## Headline

The cluster's preceding work (P-0, U1 `Grappa.Wire.Time`, U3 `wireNarrow.ts`,
H4 channel-side runtime narrowing, the bucket-1 `EventRouter` catch-all that
persists unknown verbs as `:notice`-with-`meta.raw`) has materially closed the
two biggest silent-drop classes from the May-12 draft. The remaining seam
defects are concentrated in three pockets: **(a)** wire/typespec mismatch
where Jason rescues a sloppy contract, **(b)** an implicit-shape `GET /networks`
union that needs a server-emitted `kind:` discriminator now that cic has had
to invent one at the boundary, and **(c)** ad-hoc inline payload construction
in two contexts that bypass their own Wire boundary by ~one line.

Trajectory: **push notifications** will exercise every cross-user routing seam
and the `WSPresence` ETS table; **image upload** will add a fourth wire-shape
(URLs) that needs the same contract treatment as `:meta`; **PUBLIC OPEN** will
be the first time the per-subject auth boundary is stressed by adversarial
clients. The findings below are scored against that trajectory, not against
"what hurts today."

## Severity counts

| Severity | Count |
|----------|-------|
| CRIT     | 0     |
| HIGH     | 3     |
| MED      | 6     |
| LOW      | 5     |
| NIT      | 2     |

Carry-over from May-12 draft: M2 (`set_at` in topic_changed), M3 (`meta` opaque
on cic), M4 (`source` enum hand-mirrored), M7 (network-shape topic dead port),
M8 (no version-skew handler) — all still open today; not re-stated in detail.
H1/H2/H3/H4/H5 from May-12 → all CLOSED (verified in code).

---

## HIGH

### [HIGH] H1 — `GET /networks` ships an implicit-shape union; visitor branch silently drops `connection_state` + `nick`

**Surfaces involved:** REST, Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/networks/wire.ex` lines 46-84,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/controllers/networks_json.ex` lines 28-37,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/api.ts` lines 158-229

**Description:** `GET /networks` returns one of two JSON shapes
(`network_json` for visitors — `{id, slug, inserted_at, updated_at}`;
`network_with_nick_json` for users — adds `nick` + 3 T32 fields) WITHOUT an
explicit `kind:` discriminator on the wire. The shape difference is implicit
in the bearer's subject kind. cic had to invent a client-side `tagNetwork()`
boundary that joins each row against `me()` to retrofit a `kind: "user" |
"visitor"` discriminator (api.ts ll. 197-229) — but the server's typespec
union has no shared discriminator, so:

  1. A future third subject kind (org / service-account) requires server +
     client re-derivation in lockstep with no shared anchor.
  2. The visitor branch omits `connection_state` entirely. If visitor sessions
     ever gain a parked-state (say, ephemeral disconnect from upstream IRC
     after explicit `/disconnect`), the cascading parked-window UX cic
     already has wired for users will silently no-op for visitors — REST
     payload has no field to derive from.
  3. CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped strings
     for closed sets" — the subject kind IS a closed set (`:user | :visitor`)
     and should land at the wire as a `kind:` field, same way every
     Channel-broadcast event carries `kind: "<verb>"` (`Session.Wire`,
     `Networks.Wire.connection_state_event`).

**Recommended fix:** Add an explicit `kind: "user" | "visitor"` field at the
top of both `network_json` and `network_with_nick_json` returned by
`Networks.Wire.network_to_json/1` and `network_with_nick_to_json/3`. cic's
`tagNetwork()` boundary becomes a one-line read instead of a join against
`me()`. Symmetric with `MeJSON.show/1`'s discriminated `MeResponse`. Cost:
~5 lines server, ~15 lines cic deletion. Sequencing: ship server-side
first (additive), let cic continue to derive at the boundary, then flip cic
to read the field, then drop the derivation code.

---

### [HIGH] H2 — `read_cursor_set` event payload built inline in context; bypasses the Wire boundary the rest of the codebase enforces

**Surfaces involved:** Channel, IRC (Phase 6 facade)
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/read_cursor.ex` lines 198-208

**Description:** `ReadCursor.broadcast_set/4` constructs the
`%{kind: "read_cursor_set", last_read_message_id: ...}` payload INLINE inside
the context module, bypassing a Wire module:

```elixir
Grappa.PubSub.broadcast_event(topic, %{
  kind: "read_cursor_set",
  last_read_message_id: last_read_message_id
})
```

Every other broadcaster in the codebase (`Session.Wire`, `Networks.Wire`,
`QueryWindows.Wire`, `Cic.Wire`, `Scrollback.Wire`) routes through a typed
fn — the read_cursor case is the lone exception. CLAUDE.md hard invariant:
"Wire conversion is per-context responsibility." `lib/grappa/read_cursor/`
has only the schema (`cursor.ex`) — no Wire module exists.

This is small TODAY (one event, two fields). It becomes painful at the Phase 6
listener seam: the IRCv3 `+draft/read-marker` MARKREAD line needs the same
authoritative shape, and any future field addition (e.g. `set_at: ISO8601`,
or a typed `source: "settle" | "click" | "scroll"` discriminator) will land
inline here AND in cic's `wireNarrow.ts` arm AND in the future MARKREAD
emitter, without a single typed fn linking them. Same disease class as the
pre-CP15 inline event payloads in `Session.Server` (CP15 B7 elevated to
hard invariant for exactly this reason).

**Recommended fix:** Extract `lib/grappa/read_cursor/wire.ex` with
`read_cursor_set/1` returning the typed payload. Add `@type
read_cursor_set_payload :: %{kind: String.t(), last_read_message_id:
integer()}`. `ReadCursor.broadcast_set/4` calls into it. Cost: 15 LOC.
Pre-empts the listener-facade build and forces the typespec to track the
wire shape from day one.

---

### [HIGH] H3 — `Scrollback.Wire.to_json/1` declares `kind: Message.kind()` (atom) but the wire ships a string — typespec lies, Jason rescues

**Surfaces involved:** REST, Channel, IRC (Phase 6 facade)
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/scrollback/wire.ex` lines 38-92,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/api.ts` lines 326-336

**Description:** `Scrollback.Wire.to_json/1` lines 81-92 returns the
message map with `kind: m.kind` raw — the schema field is an Ecto.Enum atom
(`:privmsg | :notice | ...`). The `@type t` at line 43 declares
`kind: Message.kind()` — i.e. an atom. Jason's atom-key encoder converts the
atom to its string representation at serialization time so the wire bytes
work, but the typespec disagrees with the bytes. Compare with
`archive_entry/1` (lines 124-132 in the same module): explicitly does
`kind: Atom.to_string(kind)` and declares `kind: String.t()`. Same module,
two patterns; the second one is correct.

This is the same disease class as pre-bucket-G `Networks.Wire.iso8601_or_nil/1`
— Jason rescues the contract while the typespec drifts. Symptoms: a future
Dialyzer reader (or a Phase 6 listener facade emitter that doesn't go through
Jason and serializes from the typed map directly) will produce wrong output;
and any consumer that pattern-matches on `kind: :privmsg` will compile
against the wrong contract.

cic's `MessageKind` (api.ts:326-336) is the string union; the listener
facade IRC encoder will need the string projection too. The atom→string
conversion is a one-liner that should not live in the framework's encoder
— it should live in the same module that declares the wire shape.

**Recommended fix:** Two lines:

```elixir
@type t :: %{..., kind: String.t(), ...}     # was Message.kind()
def to_json(%Message{...} = m) do
  %{..., kind: Atom.to_string(m.kind), ...}
end
```

Mirrors `archive_entry/1` and `mentions_bundle_message/1` (`Session.Wire`
ll. 538-547 — the project_bundle_message helper already does
`Atom.to_string(m.kind)`). Brings consistency to a 3rd site in this Wire
module that's currently the outlier. Cost: 3 LOC.

---

## MEDIUM

### [MED] M1 — `Accounts.Wire.user_to_json/1` and `Visitors.Wire.visitor_to_json/1` still emit raw `%DateTime{}` after the bucket-G U1 helper landed

**Surfaces involved:** REST
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/accounts/wire.ex` line 56,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/visitors/wire.ex` line 97,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/wire/time.ex`

**Description:** Bucket G U1 of the May-12 review extracted
`Grappa.Wire.Time.iso8601_or_nil/1` (`lib/grappa/wire/time.ex`) so the
`DateTime → ISO-8601 string` projection is one definition with one set
of tests. `Networks.Wire` adopted it (ll. 151, 198, 246). But
`Accounts.Wire.user_to_json/1` returns `inserted_at: user.inserted_at`
(raw `%DateTime{}`); `Visitors.Wire.visitor_to_json/1` returns
`expires_at: v.expires_at` (raw `%DateTime{}`). The typespecs declare
`DateTime.t()` — Jason converts to string at encode time, but consistency
is half-done.

CLAUDE.md "Total consistency or nothing." The bucket-G refactor migrated
two of three Wire modules with `DateTime` fields; the remaining two are
the half-migrated state the rule warns against. The next reader will
copy whichever pattern is closer.

**Recommended fix:**

```elixir
alias Grappa.Wire.Time, as: WireTime

# accounts/wire.ex
def user_to_json(%User{} = user) do
  %{id: user.id, name: user.name,
    inserted_at: WireTime.iso8601_or_nil(user.inserted_at)}
end

# visitors/wire.ex — same shape
```

Update the two typespecs to `String.t() | nil`. Cost: 6 LOC.

---

### [MED] M2 — CARRY-OVER: `topic_entry.set_at` ships as raw `DateTime.t() | nil` (Session.Wire.topic_changed/3 passes through verbatim)

**Surfaces involved:** Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/session/event_router.ex` lines 128-132,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/session/wire.ex` lines 350-354

**Description:** Same pattern as M1 — `topic_changed` passes the
event_router-built `topic_entry` map through verbatim. `set_at` is
declared as `DateTime.t() | nil`; on the wire it lands as ISO-8601
(Jason). Carry-over from May-12 draft M2.

**Recommended fix:** Stringify at the Wire boundary. Either map the
entry inside `Session.Wire.topic_changed/3` or expose a
`Session.Wire.topic_entry/1` projection that the call site passes through
explicitly. Cost: 5 LOC. Same one-edit win as M1.

---

### [MED] M3 — CARRY-OVER: `Scrollback.Message.meta` is a typed per-kind shape table on the server, opaque `Record<string, unknown>` on cic

**Surfaces involved:** REST, Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/scrollback/meta.ex`,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/api.ts` line 346

**Description:** Carry-over from May-12 draft M3. Server's `Scrollback.Meta`
holds a per-kind shape table (`:notice → %{} | %{numeric, severity}`,
`:nick_change → %{new_nick}`, `:mode → %{modes, args}`, `:kick → %{target}`,
plus the new bucket-1 `:notice → %{raw: %{verb, sender, params}}` from the
no-silent-drops cluster). cic's `meta: Record<string, unknown>` discards all
that typing.

The bucket-1 catch-all has WIDENED the surface: every previously-unknown
verb (KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, AUTHENTICATE, vendor verbs)
now lands with a `meta.raw = %{verb, sender, params}`. cic's renderer for
those will pile up `as { raw: { verb: string, ... } }` casts, each of
which can drift from the server's actual shape.

**Recommended fix:** Per-kind discriminated union on cic — the May-12
draft's M3 fix sketch still applies:

```ts
type ScrollbackMessage =
  | (Base & { kind: "privmsg" | "action" | "topic"; meta: {} })
  | (Base & { kind: "notice"; meta: {} | { numeric: number; severity: "ok" | "error" } | { raw: { verb: string; sender: string | null; params: string[] } } })
  | (Base & { kind: "nick_change"; meta: { new_nick: string } })
  | (Base & { kind: "mode"; meta: { modes: string; args: string[] } })
  | (Base & { kind: "kick"; meta: { target: string } })
  | ...
```

Larger payoff today than at May-12 because of the bucket-1 widening.

---

### [MED] M4 — Wire-event topic-routing rule is documented in moduledocs; not testable

**Surfaces involved:** Channel, IRC
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/session/wire.ex` lines 437-622,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/session/server.ex` lines 1972-2249

**Description:** The Session.Wire module declares the wire shape for ~17
event kinds. WHICH topic each kind broadcasts on (per-channel vs
per-network vs user-topic) is decided ad-hoc at the broadcast site in
`Session.Server.apply_effects/2`. The rule has been litigated multiple
times in the cluster — P-0e shipped `invite_ack` on the per-channel
topic, P-0f flipped to user-topic after live smoke caught the silent
drop ("operators usually invite peers to channels they are NOT in,
dropping the broadcast on the floor in the common case"). The current
rule, paraphrased from the moduledocs:

> Ephemerals carrying their own `network` field route via `Topic.user/1`
> (`whois_bundle`, `whowas_bundle`, `peer_away`, `lusers_bundle`,
> `invite_ack`). State-change events for a specific channel route via
> `Topic.channel/3` (`topic_changed`, `channel_modes_changed`,
> `members_seeded`, `joined`, `kicked`). State-change events for an
> implicit-or-pre-subscription target route via `Topic.user/1`
> (`window_pending`, `channels_changed`, `own_nick_changed`).

There is no ONE place where this is asserted in code. Adding a new event
requires the author to apply the rule from memory and the reviewer to
catch a violation by reading the apply_effects arm.

**Recommended fix:** Add a `Session.Wire.topic_for/1` function that takes
a `wire_event_kind()` and returns one of `:user | :channel | :network`.
Each broadcast site at apply_effects becomes:

```elixir
:ok = Grappa.PubSub.broadcast_event(
  topic_for_event(state, channel, kind),
  payload
)
```

A single typed dispatch table. Adding a new kind → one entry in
`topic_for/1` (fail-loud `FunctionClauseError` if missing) AND one entry
in cic's narrowers. Drift surfaces at compile time. P-0f's bug class
(silent drop because the wrong topic was used) becomes a
non-finding by construction. Cost: ~30 LOC + a test that asserts every
`wire_event_kind()` has a clause.

---

### [MED] M5 — Channel inbound `handle_in/3` has 18 verbs; REST has 1 (`POST /networks/:id/nick`); ops verbs are channel-only with no REST sibling

**Surfaces involved:** REST, Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/channels/grappa_channel.ex` lines 280-836,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/router.ex` lines 90-110

**Description:** CLAUDE.md "One feature, one code path, every door. New
data = context function → controller → channel event. Same logic, three
access methods." The current state is asymmetric:

- **REST has but Channel doesn't:** `POST /networks/:id/channels` (JOIN),
  `DELETE /networks/:id/channels/:c` (PART), `POST /networks/:id/channels/:c/topic`
  (TOPIC SET), `POST /networks/:id/channels/:c/messages` (PRIVMSG),
  `POST /networks/:id/nick` (NICK).
- **Channel has but REST doesn't:** away set/unset, op/deop/voice/devoice,
  kick, ban/unban, banlist, invite, whois, whowas, lusers, who, names,
  umode, mode, topic_set/topic_clear, open_query_window, close_query_window,
  watchlist add/del/list.

The channel-only verbs ALL route through the same `Session.send_*` context
fns the REST controllers would use. A REST sibling for each ops verb is a
mechanical wrap. Today this asymmetry doesn't cause a runtime bug, but it
breaks the documented invariant and means:

  1. A future curl-based admin tool / scripted operator action cannot
     trigger an op/deop without WS roundtripping (heavyweight for a
     scripted use case).
  2. The Phase 6 IRCv3 listener facade — whose contract is "the same
     verbs on a different transport" — will inherit the asymmetry: the
     listener-side `OP #chan alice` line needs to land in the same
     context function the channel handler uses, so the asymmetry has
     to be resolved BEFORE Phase 6 lands or the facade's wire spec
     forks from the REST spec.

**Recommended fix:** Don't ship REST controllers for every channel verb
TODAY (overengineering — 14 unused endpoints). DO codify the rule: every
new write verb adds ONE context function + a Channel handle_in arm + a
REST controller (the controller may be a `:nyi` placeholder if no
client needs it yet, but the route+controller+test exist). And resolve
the existing asymmetry with a one-cluster pass when Phase 6's spec is
written, not before. Until then this is documentation drift, not a
correctness bug. Demote to LOW if a REST surface for ops verbs is never
intended (which contradicts CLAUDE.md but may be the actual decision).

---

### [MED] M6 — CARRY-OVER: validation errors via `field_errors` envelope work, but no unified `{error, info}` shape across captcha / rate-limit / changeset

**Surfaces involved:** REST
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/controllers/fallback_controller.ex` lines 170-262

**Description:** Carry-over from May-12 draft U4. Bucket-G H2 was fixed —
the changeset arm now emits `{error: "validation_failed", field_errors:
%{...}}`. BUT: captcha emits `{error, site_key, provider}` (top-level keys);
network_circuit_open emits `{error}` + `Retry-After` header; anon_collision
emits `{error}` + `Retry-After`. Five envelopes coexist. cic's `readError`
narrows on `error` only and ignores everything else. Adding a 6th error
shape (e.g. push notification subscription failure) will land in another
new envelope unless the `{error, info}` unification lands.

**Recommended fix:** Single envelope `{error: "<token>", info: %{...}}`
where `info` carries `site_key`/`provider` for captcha, `retry_after` for
rate-limit/anon_collision, `field_errors` for changeset. Per-token
discriminated union on cic. Cost: 2-3 hours touching FallbackController +
cic's `readError` + `friendlyMessage` + `Login.tsx` captcha narrow.

---

## LOW

### [LOW] L1 — `MessagesController.create/2` returns 201 with the full message; the same message also fans out via the per-channel WS push — cic could double-render

**Surfaces involved:** REST, Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/controllers/messages_controller.ex` lines 134-159,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/session/server.ex` lines 1679-1685

**Description:** `POST /channels/:c/messages` calls `Session.send_privmsg/4`
which (a) persists the message, (b) broadcasts on the per-channel topic
via `Wire.message_payload/1`, AND (c) sends upstream. Then the controller
returns 201 with the rendered message. cic potentially sees the same
message twice: once via the REST 201 body, once via the per-channel WS
push. Today cic dedupes by `message.id` (every message has a stable
DB id), so this works — but the deduplication relies on cic implementing
last-write-wins by id. If a future cic refactor handles the 201 + push
in two separate code paths without sharing dedupe state, double-render
returns.

**Recommended fix:** Either drop the 201 body to bare `{ok: true}` (cic
reads from the WS push, identical to the JOIN/PART/TOPIC pattern in
ChannelsController) OR document the dedupe expectation explicitly in
api.ts + add a test asserting cic dedupes-on-id. Lighter answer is the
former — REST `POST /messages` becomes uniform with `POST /channels`
(202+`{ok:true}`).

---

### [LOW] L2 — `validate_post_target_name` rejects `$server` for POST messages (W1) but the channel handler doesn't have an equivalent gate for the open_query_window flow

**Surfaces involved:** REST, Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/controllers/messages_controller.ex` line 149,
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/channels/grappa_channel.ex` lines 688-707

**Description:** `validate_post_target_name/1` rejects POST to `$server`
(W1 fix, server window is read-only). cic's `open_query_window` channel
handler validates the nick via `Identifier.valid_nick?/1` — `$server` is
not a valid nick syntax (sigil `$`), so this is gated transitively. But
the gate is by accident, not by intent. If the nick validator ever
loosened sigils for, say, services-bot accounts ($Operserv, etc.), the
"can't open a query window on $server" rule silently breaks.

**Recommended fix:** Add an explicit `target != SERVER_WINDOW_NAME` check
in the open_query_window handle_in arm, mirroring `validate_post_target_name`.
Defense in depth.

---

### [LOW] L3 — `archive_json.ex` uses string keys; every other JSON view emits atom keys (Jason converts on output)

**Surfaces involved:** REST
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/controllers/archive_json.ex`

**Description:** Carry-over from May-12 draft L4. Stylistic outlier; cosmetic.

---

### [LOW] L4 — `kicked`/`joined`/`window_pending`/`join_failed` payloads carry redundant `state:` field

**Surfaces involved:** Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/session/wire.ex` lines 143-173

**Description:** Carry-over from May-12 draft L5. `state:` is always the
underscored projection of `kind:`. cic dispatches on `kind:` only.
Harmless redundancy but one more piece to keep in sync.

---

### [LOW] L5 — `users socket` id-topic disconnect path: payload is bare `%{}` not via Wire

**Surfaces involved:** Channel
**File(s):**
`/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/controllers/auth_controller.ex` lines 195-211

**Description:** `broadcast_disconnect/1` calls
`GrappaWeb.Endpoint.broadcast(socket_id, "disconnect", %{})` — the
"disconnect" event is a Phoenix-internal contract for socket teardown,
NOT a wire event reaching cic's narrower. Payload shape `%{}` is correct
for the framework. Pure note: the `"disconnect"` event-name string is
hardcoded; if the Phoenix contract evolves the wire shape, the breakage
is silent. Phoenix has been stable on this contract for years; lowest
LOW.

---

## NIT

### [NIT] N1 — `M-web-2` comment in `auth_controller.ex` is excellent prose but ~80 lines of moduledoc explaining one `Application.compile_env/2` call

**File(s):** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa_web/controllers/auth_controller.ex` lines 42-66

Move to `docs/DESIGN_NOTES.md` with a one-line code comment pointing back.
The decision is design-log material; the controller doesn't need 14 lines
to justify a single `compile_env`.

### [NIT] N2 — `Session.Wire.peer_away_payload` typespec says "P-0b — standalone 301 RPL_AWAY ephemeral" — every typespec doc redundantly carries the IRC numeric

**File(s):** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/lib/grappa/session/wire.ex` (multiple)

The numeric belongs at the broadcast site (where the `apply_effects` arm
ALSO documents which numeric triggered it). Wire module should describe
the wire shape; the trigger numeric is irrelevant to a cic-side or
listener-side consumer of the Wire fn. Mild duplication.

---

## Trajectory risks

### Push notifications
- **WSPresence** is the single source of "who is connected"; push notifications
  will need to derive "send notification because no socket is up." The current
  WSPresence pid-tracking is per-process and uses raw
  `Phoenix.PubSub.broadcast/3` (ws_presence.ex line 334), NOT
  `broadcast_event/2`. That's deliberate (internal bridge, not WS-bound),
  but a future "send push" emitter must NOT confuse the two surfaces. The
  rule is moduledoc'd in `Topic.ws_presence/1`; codify by giving the push
  emitter its own typed bridge fn (don't grow the ws_presence overload).
- The implicit-shape `GET /networks` (H1) becomes more painful when push
  notifications need a per-network "do I want pushes for this?" toggle —
  visitor branch with no fields to extend will force a third asymmetry.

### Image upload (future)
- URLs in message bodies will need a **fourth wire-shape contract**: structured
  attachment metadata (URL, mime, dimensions) — almost certainly inside
  `Scrollback.Meta`. Per M3, the cic-side `meta: Record<string, unknown>` will
  hide every drift. Land M3's fix BEFORE the image-upload cluster, otherwise
  every renderer cast becomes a new bug surface.
- Server should NEVER store rendered HTML / pre-localized "image preview"
  strings. Bare URL + structured meta only. cic owns rendering. CLAUDE.md
  feedback memory `feedback_no_localized_strings_server_side` covers this
  but is worth pinning explicitly in the cluster plan.

### Voice (future)
- Voice will need a fifth wire-shape (PCM stream metadata, codec negotiation,
  WebRTC offer/answer). PROBABLY a separate transport (not Channels), but
  the per-(user, network, channel) addressing model must extend to it. Today
  the only addressing scheme is Phoenix Channels topic strings — codify
  `Topic.voice(user_name, network_slug, channel_name)` BEFORE landing voice
  so the topic shape is single-sourced (M2 of CLAUDE.md "Single source of
  truth: Grappa.PubSub.Topic" extends naturally).

### PUBLIC OPEN
- The implicit-subject-shape `GET /networks` will be the first thing an
  adversarial client probes. Every endpoint that branches on `current_subject`
  shape implicitly should be audited — H1 is the lead case.
- The five-envelope error shape (M6) will become user-visible as confusing
  messages on rate-limit/captcha/validation; `{error, info}` unification
  before public open prevents per-error hand-rolled cic UX.
- The 18-channel-verb / 1-REST-verb asymmetry (M5) is operator-pain, not
  user-pain — but a future "I want to op alice via curl" SRE need will
  surface it; document the constraint or shoot the asymmetry.

### Phase 6 IRCv3 listener facade
- H2 (`read_cursor_set` inline payload) is the highest-leverage pre-Phase-6
  cleanup: MARKREAD wire-on-IRC needs the same authoritative shape; can't
  be a one-edit win unless the source is in a Wire fn.
- M4 (topic-routing decided ad-hoc per arm) will bite the listener facade
  hard: the facade reads from PubSub topics and re-emits to its own
  IRC sockets. Topic-shape drift = listener invisible-event class. Land
  the typed dispatch before Phase 6 starts.
- Three-doors consistency at the action level (M5) — the listener facade
  IS the third door. Asymmetric verbs become "you can op via WS but not
  via the listener" which is wrong for a CHATHISTORY/IRCv3 client.

### Read cursor (CP29) coherence
- REST set + Channel push + per-channel join_reply are all in place
  (`/me` envelope + per-channel `read_cursor` in join reply + per-channel
  `read_cursor_set` push). Phase 6 MARKREAD is the missing fourth door.
  Per H2, extracting the Wire module is the prerequisite.

---

## Summary

- **0 CRITICAL, 3 HIGH, 6 MEDIUM, 5 LOW, 2 NIT**
- **Top 3 cross-surface findings:**
  1. **H1** Implicit-subject-shape `GET /networks` — silently drops
     `connection_state` + `nick` on visitor branch; cic re-derives the
     `kind:` discriminator at boundary because server doesn't ship one.
     Single biggest "the wire told the truth in two languages" defect
     remaining post-bucket-G.
  2. **H2** `ReadCursor.broadcast_set/4` builds wire payload inline,
     bypassing the per-context Wire boundary the rest of the codebase
     enforces. Phase 6 MARKREAD prerequisite.
  3. **H3** `Scrollback.Wire.to_json/1` typespec says atom, wire ships
     string. Same Wire module's `archive_entry/1` does it correctly —
     two patterns in one file.
- **Top trajectory risk:**
  - Push notifications + image upload + Phase 6 listener will all stress
    the wire-shape contract MORE than today's load. M4 (topic-routing
    typed dispatch) and M3 (per-kind `meta` discriminated union on cic)
    are the highest-leverage "land before the next clusters do" items.
- **Cluster context:** No-silent-drops bucket 1 (EventRouter catch-all
  for unknown commands) is shipped and good. The remaining "silent drop"
  shapes in the cross-surface seam are wire-typing (H1, H3, M3) and
  routing (M4) — same disease class, different surface. Worth adding
  buckets to the cluster.
