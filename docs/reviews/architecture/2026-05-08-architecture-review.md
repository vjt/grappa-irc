# Architecture Review — 2026-05-08

**Scope:** Concern-based architectural review across 6 dimensions, per
`docs/reviewing.md` §2: abstraction-boundaries, responsibility & cohesion,
duplication, dependency architecture, type-system leverage, extensibility.

**Sibling line-level review:** `docs/reviews/codebase/2026-05-08-codebase-review.md`.

**Trigger:** Companion to the codebase review gate (≥12 sessions since
2026-05-03). Architecture reviews don't have a separate cadence — they
ride along with the codebase gate when the codebase has matured enough
to question structure. CP15 (event-driven windows) just landed an
architectural shift (typed events + Wire modules per context, cic-as-mirror
invariant), so the timing is right to ask "did the new shape settle, or
did we ship half a migration?"

---

## Executive summary

**Total findings across 6 concerns:** 0 CRITICAL · 19 HIGH · 24 MEDIUM · 22 LOW.

**Three load-bearing themes — read these first:**

### Theme 1 — CP15 B7 wire-module rule shipped as documentation, not enforcement

The hard invariant landed in CLAUDE.md ("PubSub broadcast + Channel push
payloads MUST be JSON-encodable — convert structs to wire shape via a
context-owned `*.Wire` module"). Five concerns flag the same gap:

- **Abstraction-boundaries A1 (HIGH)** — `Session.Server` constructs 9 distinct
  event payloads inline (`topic_changed`, `channel_modes_changed`,
  `members_seeded`, `joined`, `join_failed`, `kicked`, `channels_changed`,
  `own_nick_changed`, `away_confirmed`, `mentions_bundle`). `window_state_payload/3`
  re-builds the same shapes for the snapshot push. CP15 B3 requires
  byte-identicality between snapshot + event-time but enforces it via
  prose comments only.
- **Responsibility A2 (HIGH)** — three event-broadcast paths build wire
  shape inline; `mentions_bundle` even drifts on field name (`sender_nick:`
  inline vs `sender:` in `Scrollback.Wire`).
- **Duplication A1, A5, A6 (HIGH/MEDIUM)** — same inline-mirror problem
  expressed across `joined`/`join_failed`/`kicked`, `members_seeded`/
  `topic_changed`/`channel_modes_changed`, `query_windows_list` envelope.
- **Extensibility A2 (HIGH)** — CP15 B3's "byte-identical" invariant lives
  in reviewer attention, not in code; every other context (Scrollback,
  Networks, QueryWindows) factored through Wire modules but Session didn't,
  even though the rule was just elevated to invariant in CP15 B7.
- **Type-system A1, A2 (HIGH)** — wire-event `kind:` is an untyped string
  at every broadcast site; no `@type wire_event_kind` enum exists; cic
  mirrors via two hand-maintained shapes. `Wire.message_payload/1` emits
  `kind: :message` (atom) while every other broadcast emits `kind: "<string>"`.

**Action:** Extract `Grappa.Session.Wire` (and complete `Visitors.Wire`).
Pin a `@type wire_event_kind :: literal | literal | …` enum on the server
and a discriminated union on cic. Single bucket, ~half session, closes 6+
HIGH findings across both reviews.

### Theme 2 — cic re-introduces a parallel state machine despite the invariant

CLAUDE.md was tightened in CP15 B7 (commit `6c60ffe`) to spell out
"cic NEVER originates state — no parallel client-side state machine."
The same cluster (CP15 B5) ships `compose.ts:210` calling `setPending(...)`
after `/join` to work around a Phoenix-PubSub late-subscriber race.

- **Dependency A1 (HIGH)** — flags this as an invariant violation. The fix
  was justified for a real race, but the *structure* is wrong: it solves
  the race by introducing exactly the parallel state machine the invariant
  outlaws.
- **Recommendation:** move `:pending` origination to the server
  (`Session.send_join/3` already records in-flight joins — extend to write
  `window_states[ch] = :pending` + broadcast).

### Theme 3 — Session.Server is a 2271-LOC, 153-fn god module owning 10 domains

- **Responsibility A1 (HIGH)** — concrete extractable sub-contexts named:
  `WindowState` (the `window_states %{}` + `window_failure_*` + `window_kicked_meta`
  triplet), `AwayState` (auto-away debounce + away_label tracking),
  `ModeChunker` (ISUPPORT MODES= extraction + per-line chunking).
- This is the eventual consequence of letting every new feature land in
  Session.Server because that's where the per-channel state already lived.
  Five HIGH findings (A2, A4, A5, A8 in arch + S1-S3 in lifecycle line)
  ultimately point back to "this module is doing too much; some of these
  bugs are emergent from the size."

**Recommendation hierarchy** (from arch agents' cluster-ordering proposals):

1. **`wire-discipline-sweep` cluster** (~half session): `Grappa.Session.Wire` +
   `Grappa.Visitors.Wire` + `WireUserEvent` discriminated union in `api.ts` +
   fix three stale typespecs + atom-vs-string `kind:` consistency. Closes
   Theme-1 HIGH findings + several MEDIUMs.
2. **`server-side-pending` bucket** (~quarter session): move `:pending`
   origination to server, drop cic's `setPending` call. Closes Theme-2 HIGH.
3. **`Session.Server.WindowState` extraction** (~half session): pull the
   window-state triplet maps + their transitions into a sub-context.
   Closes Theme-3 partially + several lifecycle line findings.
4. Then re-evaluate. The remaining MEDIUM/LOW findings are easier to triage
   once the three load-bearing themes are addressed.

---

## How to read this file

Each concern's raw findings follow, grouped under a `# <concern>/` heading.
Severity headers within each concern: `## CRITICAL`, `## HIGH`, `## MEDIUM`,
`## LOW`. Findings use the format prescribed by `docs/reviewing.md` §2
(`### A<N>. Title` with **Concern** / **Scope** / **Problem** / **Impact**
/ **Recommendation**).

Cross-references to the line-level codebase review use `S<N>` / `H<N>` / `W<N>` IDs.

---


# abstraction-boundaries/

# Architecture Review — Abstraction Boundaries — 2026-05-08

**Concern:** Leaky abstractions, contexts reaching into each other's
schemas, return types that force callers to parse, server↔client
boundary integrity. Includes the cicchetto seam.

**Method:** Followed the concern across `lib/grappa/{scrollback,
networks, accounts, query_windows, session, visitors,
user_settings}/`, `lib/grappa_web/{controllers,channels}/`,
`cicchetto/src/lib/*.ts` and `cicchetto/src/*.tsx`. Cross-checked
prior architecture reviews (2026-04-25, 04-26, 04-27) and the most
recent codebase review (2026-05-03) so already-fixed findings (Wire
modules for Scrollback / Networks / Accounts / QueryWindows;
`Grappa.PubSub.broadcast_event/2` wrapper; `Atom`/`Ecto.Enum`
pinning of `Scrollback.Message.kind`) are not re-flagged.

**Trajectory cross-check:** CP15 closed 2026-05-07 with TWO new
project-wide invariants in CLAUDE.md:

1. "PubSub broadcast + Channel push payloads MUST be JSON-encodable
   — convert structs to wire shape via a context-owned `*.Wire`
   module."
2. "Window state model lives on the server. … cic NEVER originates
   state — no optimistic STATE assumptions, no parallel client-side
   state machine."

Findings below are evaluated against those invariants. Two CP15-era
sweeps (Scrollback.Wire, QueryWindows.Wire) are recent and partial —
the surface they cover is correct, the surface they DON'T cover is
where the leaks now cluster.

---

## HIGH

### A1. CP15 wire-module rule is stated, but Session.Server still constructs 8 distinct event payloads inline

**Concern:** Abstraction boundaries
**Scope:**
  * `lib/grappa/session/server.ex` apply_effects arms at lines
    1611–1640 (`channels_changed`, `own_nick_changed`), 1647–1657
    (`topic_changed`), 1663–1672 (`channel_modes_changed`),
    1693–1702 (`members_seeded`), 1713–1722 (`joined`), 1791–1802
    (`join_failed`), 1843–1854 (`kicked`), 1908–1916
    (`away_confirmed`), 2253–2264 (`mentions_bundle`).
  * `lib/grappa/session/server.ex:1973–2006` — `window_state_payload/3`
    re-builds the SAME shape for the cold-WS-subscribe snapshot.
  * `lib/grappa_web/channels/grappa_channel.ex:705–760` —
    `push_topic_if_cached/4`, `push_modes_if_cached/4`,
    `push_members_if_seeded/4` re-build `topic_changed` /
    `channel_modes_changed` / `members_seeded` payloads at the
    after-join push site.
**Problem:** CLAUDE.md as of CP15 B7 (commit `6c60ffe`) makes wire-
shape conversion a "context responsibility" via
`Grappa.{Scrollback,QueryWindows}.Wire`. The rule is upheld for
those two contexts. Session — the busiest event producer in the
codebase, and the one CP15 explicitly hardened — produces nine
distinct event shapes via raw map literals at the broadcast site.
The CP15 B3 design explicitly requires the snapshot push and the
event-time broadcast to be **byte-identical** so cic dispatches one
handler regardless of origin (intent doc, also moduledoc on
`Session.window_state_payload/3`). Today that byte-identicality is
maintained by code review, not by a single-source module:
`window_state_payload(state, channel, :failed)` and the
`apply_effects([{:join_failed, ...}])` arm independently construct
maps with the same keys. The same is true for `topic_changed` and
`channel_modes_changed` (Session emits AND `GrappaChannel`
re-emits at after-join).
**Impact:** Any contributor adding a field to one of these events
must remember to update 2–3 sites that aren't textually adjacent;
the diff that adds a field to the event-time broadcast and
forgets the snapshot site will compile, pass tests for the live
path, and silently regress the deploy-reconnect race CP15 B3
specifically fixed. The CP15-era moduledoc comment "Single source
of truth for the projection — must stay byte-identical to the
event-time payloads emitted in the apply_effects arms above"
*describes the invariant* but does not *enforce it* — it's a
comment, not a function. Same drift class as the historical
A4/A7/A25 (which were fixed by introducing Scrollback.Wire);
Session has now grown enough event surface to warrant its own
treatment.
**Recommendation:** Introduce `Grappa.Session.Wire` (sibling to
`Scrollback.Wire` / `QueryWindows.Wire` / `Networks.Wire`) with one
function per `kind:` discriminator: `topic_changed/3`,
`channel_modes_changed/3`, `members_seeded/3`, `joined/2`,
`join_failed/4`, `kicked/4`, `channels_changed/0`,
`own_nick_changed/2`, `away_confirmed/2`, `mentions_bundle/5`.
Each returns the typed payload map and is pinned by a `@type`. The
apply_effects arms call the verb instead of building the literal;
`window_state_payload/3` becomes a one-liner that calls the same
verb (`Wire.joined/2` / `Wire.join_failed/4` / `Wire.kicked/4`) so
snapshot + event are LITERALLY the same expression. The
after-join push helpers in `grappa_channel.ex` collapse the same
way. Deferred `:parted` (intentionally absent per the moduledoc)
gets a comment in the Wire module — central place to document
event-surface decisions.

### A2. Cicchetto re-derives `network_id` from `slug` 14× across compose.ts — store gap

**Concern:** Abstraction boundaries (server↔client store layer)
**Scope:** `cicchetto/src/lib/compose.ts` — every channel-ops and
DM verb (`/topic-clear`, `/msg`, `/query`, `/op`, `/deop`,
`/voice`, `/devoice`, `/kick`, `/ban`, `/unban`, `/banlist`,
`/invite`, `/umode`, `/mode`) repeats the pattern
`networks()?.find((n) => n.slug === networkSlug)?.id` at lines
251, 264, 275, 344, 353, 362, 371, 380, 389, 398, 407, 418, 426,
434.
**Problem:** The REST surface and the Phoenix-Channel topic
surface address networks by `slug` (string). The user-level
inbound-event surface (`GrappaWeb.GrappaChannel.handle_in/3` for
all ops verbs + `open_query_window` + `close_query_window`)
addresses networks by integer `network_id`. cicchetto must
convert at every call site. Fourteen identical six-line snippets
live in one file, each with its own "network not found" error
string variant. A future API where channels go through a stricter
Authn check (per-network), or where the server adds an extra
field per network — all 14 sites need to be touched in lockstep.
This is the single most duplicated pattern in the cicchetto
codebase post-CP15. It IS a leak: `compose.ts` is a verb-
dispatch module that should consume `(slug, channel)` tuples and
let the store layer answer "what's the integer id?" because the
store owns the `networks` resource lifecycle (cache, refetch,
identity rotation).
**Impact:** Verb-dispatch logic is shot through with id-resolution
boilerplate. Adding a new ops verb means copy-pasting yet another
six-line preamble. The fact that the lookup CAN fail (`?.id` →
`undefined`) leaks into every verb's error-shape branching;
`/op: network not found` etc. are 14 distinct error strings that
duplicate the same diagnostic. The asymmetry — REST takes slug,
WS verbs take integer id — also doesn't have a documented
rationale anywhere (it appears to be historical from before
Networks had a stable slug surface).
**Recommendation:** Two paths, in order of preference:
  1. **Server-side (preferred):** convert the WS handlers to
     accept `network_slug` (string) instead of `network_id`
     (integer), looking up via `Networks.get_network_by_slug/1`
     inside the channel handler with the same iso check used in
     `Plugs.ResolveNetwork`. This eliminates the cicchetto
     duplication outright AND makes the wire surface uniform
     (slug everywhere, id is REST-internal). Backwards-compat:
     accept both shapes for one release cycle, then drop integer
     id from the wire.
  2. **Client-side (if option 1 won't ship soon):** add
     `networkIdBySlug(slug)` to `cicchetto/src/lib/networks.ts` as
     a single sanctioned lookup. compose.ts's 14 sites collapse
     to one helper call per verb. Same store, same identity-
     rotation cleanup, single error-message source.

### A3. Visitor wire shape is inlined in two places; no `Grappa.Visitors.Wire`

**Concern:** Abstraction boundaries (schema field exposure)
**Scope:**
  * `lib/grappa_web/controllers/me_json.ex:46–53` — directly reads
    `visitor.id`, `visitor.nick`, `visitor.network_slug`,
    `visitor.expires_at` to build the `:visitor` MeResponse.
  * `lib/grappa_web/controllers/auth_json.ex:41–51` — directly
    reads `v.id`, `v.nick`, `v.network_slug` to build the
    `:visitor` AuthJSON subject.
  * `lib/grappa/visitors/` has NO `wire.ex` despite Accounts /
    Networks / Scrollback / QueryWindows all having one.
  * cicchetto mirrors this in `lib/api.ts:39–46` (LoginResponse
    visitor) AND `lib/api.ts:63–71` (MeResponse visitor) —
    overlapping shapes typed twice on the client.
**Problem:** Visitor is the only schema with a public wire shape
that has NO Wire module. Both consumers (`MeJSON`, `AuthJSON`)
construct the visitor wire shape inline; the rationale in
`AuthJSON` moduledoc — "Grappa.Visitors.Visitor is fully internal
to the cluster/visitor-auth work and has no separate Wire module
yet" — was written when there was one consumer. There are now
two, and cicchetto's `LoginResponse`/`MeResponse` types treat the
shape as a stable public contract. A future Visitor field with
`redact: true` (e.g. the visitor's encrypted password — see
`Grappa.Visitors.commit_password/2`) is one diff away from
shipping over the wire, the way `Networks.Wire` exists precisely
to gate that risk for Credentials.
**Impact:** Same class of risk Networks.Wire was created to
prevent (per its moduledoc — leaking `password_encrypted`).
Visitor's `password_encrypted` field is staged at registration
time and lives on the row encrypted-at-rest. Two inline
serializer sites + a third coming with any future visitor wire
endpoint = one of them will eventually `Map.from_struct(visitor)`
or `json(conn, visitor)` and the leak ships. Beyond security:
the LoginResponse and MeResponse visitor shapes drift today
(LoginResponse omits `expires_at`, MeResponse includes it) — a
single Wire module would force the difference to be explicit
(two functions: `visitor_to_credential_json/1` mirroring
`Accounts.Wire.user_to_credential_json/1`, plus `visitor_to_json/1`
mirroring `user_to_json/1`).
**Recommendation:** Create `lib/grappa/visitors/wire.ex` with
`visitor_to_json/1` (full shape: id, nick, network_slug,
expires_at) and `visitor_to_credential_json/1` (id, nick,
network_slug only). Both `MeJSON` and `AuthJSON` delegate. The
Wire module's moduledoc points at `Networks.Wire` as the
analogous redact-protection rationale and explicitly excludes
`:password_encrypted` and any other future credential-shaped
field.

### A4. `QueryWindows` typespecs lie about wire shape — the Wire module exists but the typespec wasn't updated

**Concern:** Abstraction boundaries
**Scope:**
  * `lib/grappa/query_windows.ex:84` — declares `windows_list_payload
    :: %{kind: String.t(), windows: %{integer() => [Window.t()]}}`.
  * `lib/grappa/query_windows.ex:40` — moduledoc still claims
    `windows: list_for_user(user_id)` ships in the broadcast
    payload (raw `[Window.t()]`).
  * `lib/grappa_web/channels/grappa_channel.ex:163–166` —
    `query_windows_list_payload` typedoc declares `windows:
    %{integer() => [QueryWindows.Window.t()]}`.
  * Reality (`query_windows.ex:204` + `grappa_channel.ex:670`):
    both broadcast paths now call `Wire.render_grouped/1`, so the
    actual payload is `%{integer() => [windows_entry()]}` (typed by
    `QueryWindows.Wire.windows_map/0`).
**Problem:** This is the exact bug CP15 B6 fixed — broadcasting
raw `%Window{}` structs crashed the WS edge during fan-out. The
fix added `Wire.render_grouped/1`. The fix did NOT update the
typespecs that declared the OLD struct shape. Three typespecs
across two files now describe a wire shape that has not been
emitted since `2026-05-07 @ B6`. Worse: `GrappaChannel`'s
`query_windows_list_payload` typedoc is the public contract
documented for cic; the actual wire shape mirrors
`QueryWindows.Wire.windows_map/0` (snake_case keys, ISO-8601
strings). Cic's `userTopic.ts:30–47` then hand-writes a `WireWindow`
type AND a `parseWindowsMap` re-shaper to translate the snake_case
back to camelCase — work that would be a no-op if the server-side
typespec actually published the snake_case shape and cic's `api.ts`
exported it as a typed contract.
**Impact:** The most-likely Dialyzer-catchable boundary leak in
the codebase right now. Anything that tries to consume the
`windows_list_payload` per its declared type (e.g. a future
preflight test that asserts wire-shape against the typespec)
gets a false positive. Cic's hand-rolled reshape is duplicating
work the server's Wire module already does — and the keys could
diverge silently.
**Recommendation:** Three small edits, one PR:
  1. `lib/grappa/query_windows.ex:84` — typespec `windows ::
     QueryWindows.Wire.windows_map()`. Update line 40 moduledoc
     prose to match.
  2. `lib/grappa_web/channels/grappa_channel.ex:163` — same change.
  3. `cicchetto/src/lib/api.ts` — export a `QueryWindowEntry` type
     mirroring `QueryWindows.Wire.windows_entry()` exactly
     (snake_case fields). `userTopic.ts` consumes it and the
     `parseWindowsMap` re-shaper goes away (or shrinks to
     `Object.entries` with `Number(key)`). Pairs with the broader
     "snake_case wire is the contract" rule already established
     by CLAUDE.md.

---

## MEDIUM

### A5. cicchetto components reach past stores to import REST verbs from `lib/api.ts`

**Concern:** Abstraction boundaries (cicchetto store layer)
**Scope:**
  * `cicchetto/src/Sidebar.tsx:2,109` — imports `postPart` from
    `./lib/api` directly; calls `void postPart(t, slug,
    channelName)` inline in the X-button handler. Does NOT go
    through any verb store.
  * `cicchetto/src/Login.tsx:3` — imports `ApiError` from
    `./lib/api` (acceptable: error-shape consumer, no store layer
    needed).
  * `cicchetto/src/MembersPane.tsx:2`, `Shell.tsx:4`,
    `ScrollbackPane.tsx:11` — import `displayNick` /
    `ScrollbackMessage` type only (acceptable: type-only imports
    + a pure helper).
**Problem:** The cicchetto architecture (per CP10/CP14 trajectory
+ the architecture-review rubric in `docs/reviewing.md` §2)
splits responsibility as **Components → Stores → api.ts +
socket.ts**. Stores own bearer-keyed identity rotation, dedup,
and integration with reactive sources. Sidebar bypassing this
for `postPart` means: (a) the PART verb has no centralized
identity-rotation gate (logout mid-PART = orphan request), (b)
no centralized error-shape friendly-message logic (the X-button
swallows the promise via `void`), (c) the same verb is invoked
from `compose.ts:230` through the store-layer pattern via
`postPart` import — same import, two callers, no shared store
seam. Either both should use a `Channels` store verb, or the
existing pattern is the right one and the store layer is
under-defined.
**Impact:** The Sidebar PART path is a one-line side-channel
that doesn't feed into compose.ts's draft/error/history
machinery. If the user X-clicks during a token rotation, the
PART hits the server with a stale bearer; if the server returns
an `ApiError`, it's swallowed because there's no store-side
error sink. The pattern is small now (one component, one verb)
but the cluster `channel-client-polish` is about to add
`/disconnect`, `/connect`, `/quit` UI affordances — if those
also reach past the store, the leak compounds.
**Recommendation:** Add a `Channels` store verb
`partChannel(slug, channel)` to `cicchetto/src/lib/networks.ts`
(or a new `cicchetto/src/lib/channels.ts` if `networks.ts` is at
its size limit). The verb gates on `token()`, calls `postPart`,
catches `ApiError`, surfaces failures via the existing
notification path used by `compose.ts`. Sidebar's X-button calls
the store verb. Same shape as `loadArchive` in
`cicchetto/src/lib/archive.ts` — verbs live in the store, not in
components.

### A6. `kind: "channels_changed"` is a ping-with-no-payload — server tells cic to refetch instead of telling cic what changed

**Concern:** Abstraction boundaries (server↔client event surface)
**Scope:**
  * `lib/grappa/session/server.ex:1605–1619` — emits `kind:
    "channels_changed"` whenever `Map.keys(state.members)` differs
    pre→post. Payload carries NO data — just the discriminator.
  * `cicchetto/src/lib/userTopic.ts:73–74` — handler is literally
    `if (payload.kind === "channels_changed") refetchChannels();`,
    triggering a `GET /networks/:slug/channels` round-trip.
  * Affected by the late-subscribe race documented in CP15 B5 fix
    `07a7fba` — the typed `joined` event arrives BEFORE
    `channels_changed`'s refetch surfaces the new channel in the
    `channelsBySlug` resource, so subscribe.ts's pending-loop has
    to compensate by joining the per-channel topic at
    `setPending` time.
**Problem:** Every other event in the system carries the data the
client needs to update its local model (`topic_changed` carries
the topic, `members_seeded` carries the member list, `joined`
carries the channel name + state). `channels_changed` is the
exception — it tells cic "go ask via REST." This forces a REST
round-trip on the data path, splits the truth across two
transports, and creates the late-subscribe race CP15 B5 had to
work around. Cic's pending-loop fix is a workaround for the
underlying design: the server already KNOWS which channel was
added/removed (the apply_effects arm has the diff in scope) but
broadcasts only the fact that the set changed. The 04-26 review
(A12) introduced `Grappa.PubSub.broadcast_event/2` precisely to
make payloads first-class; `channels_changed` predates it but
hasn't been migrated.
**Impact:** REST + WS both carry the truth, with REST as the
"authoritative" source — but the WS push fires first, and any
consumer that doesn't go through `refetchChannels` sees stale
state. The cic-side fix in `subscribe.ts` (pending-loop)
compensates by speculatively subscribing to per-channel topics
before they appear in `channelsBySlug` — a parallel mechanism
that wouldn't exist if `channels_changed` simply carried the
delta. Future feature work (e.g. operator dashboards observing
channel-set changes) will repeat the same workaround.
**Recommendation:** Replace `channels_changed` with two typed
events:
  * `kind: "channel_added"` carrying `%{network: slug, channel:
    name, source: :joined | :autojoin}`.
  * `kind: "channel_removed"` carrying `%{network: slug, channel:
    name}`.
Cic's `userTopic.ts` handler updates `channelsBySlug`
optimistically AND removes the `refetchChannels()` call; the
pending-loop in `subscribe.ts` becomes a regular subscribe
because the typed event arrives WITH the channel name in scope.
The current REST endpoint stays as a snapshot-load surface (used
on first mount + after_join cold reconnect). `channels_changed`
itself can stay around as a fallback during the migration but
is removed at end of cycle.

### A7. `userTopic.ts` consumes WS payloads with `as string` casts — no shared discriminated-union type

**Concern:** Abstraction boundaries (server↔client typing)
**Scope:** `cicchetto/src/lib/userTopic.ts:72–124` — handler
signature is `(payload: { kind?: string; [k: string]: unknown })`.
Per-arm field reads use casts: `payload.network as string` (×2),
`payload.away_started_at as string`, `payload.away_ended_at as
string`, `payload.away_reason as string | null`,
`payload.messages as { … }[]`, `payload.state as string`,
`payload.network_id as number`, `payload.nick as string`.
Compare to `cicchetto/src/lib/subscribe.ts:92–122` which DOES
define a `WireEvent` discriminated union covering the
per-channel topic events.
**Problem:** Two sibling subscribers (`subscribe.ts` for
per-channel topics, `userTopic.ts` for the user-level topic)
have asymmetric type discipline. The per-channel side narrows
via discriminated union; the user-level side narrows via
ad-hoc `as` casts. There is no `WireUserEvent` type that
captures `channels_changed | query_windows_list |
mentions_bundle | away_confirmed | own_nick_changed`. Adding a
field to `mentions_bundle`, or adding a new event kind to the
user-level topic, will not be caught by `tsc` — the cast happily
returns `undefined as string`. This pairs with A1 directly: a
server-side `Grappa.Session.Wire` module would document the
exact wire shape, which would in turn suggest the matching
client-side discriminated union.
**Impact:** Two issues. (1) The pre-existing handler arms could
silently break on a server payload-shape change because
`payload.X as string` will not throw on missing keys. (2) No
exhaustiveness check — adding a new `kind:` to the server
without updating `userTopic.ts` produces no compile error;
unknown kinds are silently dropped. The `subscribe.ts`
`WireEvent` shape is the model to mirror.
**Recommendation:** Introduce `WireUserEvent` in
`cicchetto/src/lib/api.ts` (sibling to `ChannelEvent`) covering
all five user-topic event shapes. `userTopic.ts` handler accepts
`(payload: WireUserEvent)` and dispatches via
`payload.kind === "..."` discriminator narrowing; the `as` casts
disappear. End the handler with an `assertNever(payload)` for
exhaustiveness coverage matching the ScrollbackPane render
pattern. Pairs naturally with A1 (server-side Session.Wire) and
A4 (QueryWindowEntry typed export) — three changes in one PR
close the user-topic wire-shape contract.

### A8. `mentions_bundle` payload constructed inline in Session, re-shaped inline in cicchetto — neither end has a typed contract

**Concern:** Abstraction boundaries
**Scope:**
  * `lib/grappa/session/server.ex:2238–2264` — builds the bundle
    payload (`message_payloads` list with `%{server_time, channel,
    sender_nick, body, kind}` per message, plus `away_started_at`
    / `away_ended_at` / `away_reason`) inline, with kind manually
    `Atom.to_string/1`'d.
  * `cicchetto/src/lib/userTopic.ts:84–97` — re-shapes via
    `messages: payload.messages as { server_time: number;
    channel: string; sender_nick: string; body: string | null;
    kind: string }[]`. The two field lists must stay in sync by
    code review.
**Problem:** The `mentions_bundle` event payload is the most
complex single event in the codebase (nested message list,
multiple per-event metadata fields), and it's the LEAST typed.
Server emits via raw map literal; client consumes via raw
type assertion. The fields it carries (server_time, channel,
sender_nick, body, kind) are ALMOST `Scrollback.Wire.t()` but
not quite (uses `sender_nick` instead of `sender`; omits id,
network, meta) — yet there's no comment explaining why this is
its own wire shape rather than a list of `Scrollback.Wire.t()`
entries. A future contributor adding a meta field to scrollback
will not know to mirror it here.
**Impact:** The bundle's wire shape diverged from
`Scrollback.Wire.t()` for unclear reasons. If the divergence is
intentional (UI rendering doesn't need id/meta — light payload
preferred), it should be one place. If it's accidental (someone
forgot Scrollback.Wire existed), the duplication is technical
debt that will compound when watchlist tooling evolves.
**Recommendation:** Roll into A1: `Grappa.Session.Wire`'s
`mentions_bundle/5` function takes the message list + away
metadata and returns the typed payload. Document in the
moduledoc whether the bundle uses `Scrollback.Wire.t()` per
message (recommended — single source of truth, even if some
fields are unused on the cic side) or a stripped variant (with
explicit rationale). Cic mirrors via a `MentionsBundleEvent`
type in `api.ts`.

---

## LOW

### A9. cic store `archivedBySlug` exposes server-side `kind` discriminator atom-as-string without re-typing

**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/scrollback.ex:216–222` declares
`archive_entry.kind :: :channel | :query` (atoms). Wire shape at
`lib/grappa_web/controllers/archive_json.ex:27` does
`Atom.to_string(kind)` so cic sees `"channel" | "query"`. cic's
`api.ts:362–363` types this as a string-literal union — correct
shape, but the conversion happens because the JSON view manually
converts the atom.
**Problem:** Minor, but: every time the server defines a closed
atom set that ships over the wire (`MessageKind`, `ConnectionState`,
`auth_method`, archive `kind`, `WindowState`), the conversion is
hand-rolled. `MessageKind` works because Jason serializes atoms
as strings by default; archive `kind` is special-cased here.
Inconsistency in how the server publishes atom-set wire values.
**Impact:** Low — consistent atom-as-string serialization is a
nice-to-have rather than a bug surface today. Surfaces if
someone adds a 3rd archive kind and forgets the
`Atom.to_string` line, shipping the literal `:foo` (which Jason
serializes as the string `"foo"` via the default atom encoder
anyway, so it'd actually still work — making this LOW).
**Recommendation:** Move `archive_kind_to_wire/1` into
`Grappa.Scrollback.Wire` (or a future `Grappa.WireAtom` helper
used by every context that ships closed-set atoms) so the
conversion is one verb, callable from any future archive-
adjacent surface (e.g. the IRCv3 listener facade in Phase 6).

### A10. `compose.ts:487` collapses `ApiError.code` to a UI-displayed string with no friendly-message mapping

**Concern:** Abstraction boundaries (error-shape boundary)
**Scope:** `cicchetto/src/lib/compose.ts:487` — catches
`ApiError`, sets `error: e.code` directly. `ApiError.code` is
the snake_case server token (`"invalid_credentials"`,
`"captcha_required"`, etc.). cic has a `friendlyMessage`
function in `Login.tsx:16` that maps server tokens to UX copy
— but it's not used here.
**Problem:** Compose box error rendering surfaces raw server
tokens to the user (e.g. typing `/topic` against a channel
where the operator isn't op gets `error: "no_session"` or
similar verbatim). The token-to-friendly-copy mapping exists
for the Login surface but hasn't been generalized; compose
verbs each have their own ad-hoc fallback ("network not
found", "send failed") interspersed with raw API tokens.
**Impact:** UX nit at the boundary level — the api/error wire
shape is leaking into the rendered UI. Doesn't break anything
but is the kind of inconsistency that makes the wire surface
feel "rough."
**Recommendation:** Promote `friendlyMessage` from `Login.tsx`
to a shared `cicchetto/src/lib/errorMessage.ts` keyed on
`ApiError.code`. compose.ts's catch arm calls it. Add a
default arm so unknown codes fall back to `e.code` (current
behavior — graceful degradation). Same change unblocks future
WS-side error mapping (when channel verb replies start
returning typed error tokens).

### A11. `Networks.Wire.credential_to_json/1` returns `DateTime.t()` — typed but not iso-8601-stringified

**Concern:** Abstraction boundaries (wire-shape consistency)
**Scope:** `lib/grappa/networks/wire.ex:30–43` — `credential_json`
typespec declares `inserted_at: DateTime.t()` and
`connection_state_changed_at: DateTime.t() | nil`. Compare
`QueryWindows.Wire.render/1` which does `DateTime.to_iso8601(...)`
explicitly to lock the wire shape to a string regardless of
what Jason's default encoder does for `%DateTime{}`.
**Problem:** Two patterns in the codebase: some Wire modules
emit `DateTime.t()` and rely on Jason's default ISO-8601
encoding; others (`QueryWindows.Wire`) explicitly stringify.
The cic-side type for `inserted_at` is `string` (api.ts:92),
which assumes the ISO-8601 encoding will happen. It does today
(Jason default), but the typespec on the server doesn't pin
the wire shape — only the in-memory shape. Any future Jason
config tweak (e.g. epoch encoding for performance, microsecond
precision) silently breaks cic's type without any compile-time
signal. `QueryWindows.Wire`'s explicit stringification is
defensible as the more disciplined pattern, especially given
CP15 B6 just landed wire-modules-as-the-rule.
**Impact:** Low today, latent risk on Jason config changes.
**Recommendation:** Standardize on explicit
`DateTime.to_iso8601/1` in every Wire module's emit path. Pin
the type as `String.t()` in the typespec so the wire-shape
declaration is the wire shape, not "what Jason happens to do
with this struct." Same edit covers `Accounts.Wire`,
`Networks.Wire` credential + network shapes.

---

## Cross-cutting theme

The CP15 B7 invariant ("wire-module rule") is the right one. The
sweep that landed it covered Scrollback (already done in 04-25
A4/A7) and QueryWindows (the bug-fix that triggered the rule).
Three contexts that emit JSON over PubSub or Phoenix.Channel are
NOT yet covered:

  1. **Session** — by far the largest event producer. A1 + A8
     fold here.
  2. **Visitors** — A3.
  3. **The user-level event surface as a typed contract on cic** —
     A4 + A7 fold here.

The natural next iteration of the wire-module rule would be a
1–1.5 cluster session: introduce `Grappa.Session.Wire` and
`Grappa.Visitors.Wire`; export typed contracts from cicchetto's
`api.ts` for `WireUserEvent` (mirror of the user-topic union)
and `QueryWindowEntry` (mirror of `QueryWindows.Wire`); fix the
three stale typespecs that mis-describe today's wire shape.

The cicchetto-side leak in A2 (slug→id 14× duplication) is
independent of the server-side wire pattern and is the largest
single piece of duplicated client code. Best resolved by changing
the server-side handler shape (option 1 in A2) so the underlying
asymmetry — REST takes slug, WS takes id — goes away.

A6 (channels_changed as a ping) is a strategic question, not a
mechanical fix: the server-side bookkeeping to emit
`channel_added` / `channel_removed` is small (the diff is in
scope at the broadcast site) and the cic-side simplification is
significant. Worth doing alongside the Session.Wire extraction
since the same arm needs touching.

The remaining LOW items (A9–A11) are housekeeping that would
naturally fall out of a "tighten Wire module discipline" pass.

---

## Verdict

**YELLOW** — proceed, with one focused cluster.

CP15 introduced two project-wide invariants. They are upheld for
the contexts they were introduced for. Three sibling contexts
have not yet received the same treatment, and the cicchetto
consumption side of those wire shapes is the noisiest set of
type-cast leaks in the codebase. The recommended next-cluster
work — `wire-discipline-sweep` — is small enough to fit one
cluster session and pairs naturally with the
`channel-client-polish` cluster's typing needs.

No CRITICAL findings. Four HIGH (A1–A4) cluster on the same
"finish what CP15 B7 started" theme. Four MEDIUM (A5–A8) are
adjacent — A5 is a cic store gap, A6 is a strategic event-shape
question, A7+A8 are typing follow-ups. Three LOW (A9–A11) are
housekeeping that would land naturally in the same pass.

---

# responsibility/

# Architecture review — Responsibility & cohesion (2026-05-08)

**Concern:** Does each context/module have ONE job? God modules,
feature envy, misplaced logic.

**Reviewer:** sibling agent dispatched 2026-05-08 from main session,
following `docs/reviewing.md` §2 + the post-CP15 `windowState` +
`*.Wire` invariants in `CLAUDE.md`.

**Method:** read CP15 closure + 2026-05-03 codebase review + the
three prior architecture reviews (2026-04-25/26/27) + every
`lib/grappa/**/*.ex`, `lib/grappa_web/**/*.ex`, and the cic
`*.tsx` + `lib/*.ts` surface. Cross-checked claimed splits
against actual call sites.

## Severity summary

| Severity | Count |
|----------|------:|
| CRITICAL | 0 |
| HIGH     | 4 |
| MEDIUM   | 4 |
| LOW      | 2 |

Theme: **CP15 B6 pinned `*.Wire` modules + window-state-on-server
as hard invariants**. The cluster shipped `Grappa.QueryWindows.Wire`
+ `Grappa.Scrollback.Wire`, but THREE event-broadcast paths still
hand-build their wire shape inline at the boundary, AND the
"admit + reset backoff + spawn session" verb has been
copy-paste-tweaked into FOUR sites without ever getting a home.
Session.Server is a 2.27 KLOC + 153-fn module that owns ten
distinct domains. IRC framing leaks back into Session.Server in
seven hand-built MODE/KICK/INVITE/UMODE/TOPIC-clear lines despite
the `IRC.Client` facade pattern.

---

## HIGH

### A1. `Session.Server` is a 2271-LOC, 153-fn god module owning ten distinct domains

**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/server.ex` (entire file)
**Problem:** Per CLAUDE.md "Process state stays small" + the CP10
D-cluster verb-keyed split principle that already extracted
`AuthFSM`, `EventRouter`, `NumericRouter`, `ModeChunker`,
`NSInterceptor`, `GhostRecovery`, and `Backoff` — `Session.Server`
still owns:

  1. **Upstream connection lifecycle** (`init`, `handle_continue`,
     `do_start_client`, `EXIT` arms, `start_client_after_backoff`).
  2. **Outbound IRC framing** for KICK / INVITE / BANLIST / UMODE
     / MODE / TOPIC-clear (lines 654, 676, 682, 688, 694–704, 711) —
     hand-built strings via `Client.send_line/2` instead of `IRC.Client`
     helpers (see A4).
  3. **Mode-chunking dispatch** (`send_chunked_mode/4`, lines
     2080–2094) + ISUPPORT MODES= extraction
     (`extract_modes_isupport/2` + `parse_modes_token/2`,
     lines 2122–2135).
  4. **Ban-mask derivation** (`derive_ban_mask/2`, lines 2102–2114).
  5. **Away-state machine** (`set_explicit_away_internal/3`,
     `set_auto_away_internal/1`, `unset_away_internal/2`,
     `handle_call({:set_explicit_away, ...})` x 2 +
     `:unset_explicit_away` x 4 + `:set_auto_away` + `:unset_auto_away`
     + `:auto_away_debounce_fire` + `ws_*` arms, lines 724–971,
     2149–2222).
  6. **Mentions aggregation broadcast** (`maybe_broadcast_mentions_bundle/1`,
     lines 2230–2270) including INLINE wire-shape construction
     (see A2).
  7. **Window-state mirror maps** (`window_states`,
     `window_failure_reasons`, `window_failure_numerics`,
     `window_kicked_meta`) + `window_state_payload/3` builder
     (lines 1975–2006) — also INLINE wire-shape (see A2).
  8. **In-flight JOIN tracking** with TTL sweeper
     (`record_in_flight_join/2`, lines 2033–2045) — duplicated
     state that EventRouter could carry as part of its pure
     state map.
  9. **Pending-password staging** for NickServ (`maybe_stage_pending_password`,
     `stage_pending_auth`, lines 1442–1464).
 10. **`labels_pending` + `last_command_window`** (`prepare_label/2`,
     `generate_label/0`, `label_tag/1`) and **service-target detection**
     (`service_target?/1`, `handle_service_target_send/3`).

Domains 3, 4, 5, 6, 7, 8 are sub-context candidates. Each carries
its own state slice + helper trio that has nothing to do with
the GenServer's "I own one upstream socket session" job.

Concrete co-location smell: `extract_modes_isupport/2` runs at
RPL_ISUPPORT-time to prime `state.modes_per_chunk`; `send_chunked_mode/4`
reads it back at MODE-time. Both belong inside `ModeChunker` — the
chunker is currently a stateless 3-arg helper that takes
`modes_per_chunk` from outside.

**Impact:** Every new IRC verb or away nuance grows the module.
Crash-blast radius is everything (all ten domains share the same
GenServer state struct). `state()` typespec is the only shape
documentation; reading `lib/grappa/session/server.ex` top-to-bottom
is the only way to know what a 2271-LOC change touches.
Test files inevitably mirror this — one server_test exercising
ten domains via mock-heavy setup.

The Phase 6 IRCv3 listener facade per the CLAUDE.md scrollback
invariant is supposed to reuse `IRC.Parser` mechanically; right
now it would inherit nine of these domains accidentally because
they are entangled in `Session.Server`'s `state()`.

**Recommendation:** Phase the split, smallest-blast-radius first:

  1. **Move ISUPPORT MODES= extraction + `send_chunked_mode/4` into
     `ModeChunker`** (rename to `Grappa.IRC.Modes` if it grows beyond
     chunking). `Modes.absorb_isupport/2` returns the new
     `modes_per_chunk`; `Modes.dispatch_chunked/4` takes the client +
     channel + mode_str + params and does the framing+send. Session.Server
     loses ~50 LOC of helper.
  2. **Extract `Grappa.Session.WindowState`** as a small map-of-maps
     module owning `window_states`, `window_failure_reasons`,
     `window_failure_numerics`, `window_kicked_meta` — plus
     `window_state_payload/3` (see A2). Session.Server stores
     `state.window_state` as a `WindowState.t()` opaque struct;
     `apply_effects` arms call `WindowState.set_joined/2` etc.
  3. **Extract `Grappa.Session.AwayState`** — same shape, all six
     `handle_call` arms become `AwayState.set_explicit/3` etc., the
     mentions broadcast hangs off `AwayState.flush/1`.
  4. **Extract `Grappa.Session.OutboundIRC`** as the dispatch layer
     for KICK/INVITE/BANLIST/UMODE/MODE/TOPIC-clear — but ONLY after
     A4 is done (those should live in `IRC.Client` first).

Each extraction is one bucket. None require new boundaries or a
new supervision shape.

---

### A2. THREE event-broadcast paths build wire shape inline, bypassing `*.Wire` modules — the CP15 B6 invariant

**Concern:** Responsibility & cohesion (display/wire shape in non-Wire module)
**Scope:**
  - `lib/grappa/session/server.ex:1975-2006` — `window_state_payload/3` for `:joined` / `:join_failed` / `:kicked` events
  - `lib/grappa/session/server.ex:2240-2264` — `mentions_bundle` event payload (incl. per-message `%{server_time, channel, sender_nick, body, kind}` re-shape)
  - `lib/grappa/networks.ex:443-463` — `connection_state_changed` event payload (T32 surface)

**Problem:** CLAUDE.md hard rule (added in CP15 B7 6c60ffe):
> PubSub broadcast + Channel push payloads MUST be JSON-encodable —
> convert structs to wire shape via a context-owned `*.Wire` module
> (`Grappa.Scrollback.Wire`, `Grappa.QueryWindows.Wire`). [...]
> Wire conversion is per-context responsibility.

Three sites are still in violation:

  - **`window_state_payload/3`** — three event shapes (`joined` /
    `join_failed` / `kicked`) constructed inline. These are exactly
    the events CP15 B5 made cic mirror as the authoritative window
    state — they MUST have a typed home. There is NO
    `Grappa.Session.Wire` module.
  - **`maybe_broadcast_mentions_bundle/1`** — receives a
    `[Scrollback.Message.t()]` from `Mentions.aggregate_mentions/6`
    and re-shapes each into a per-message map inline (lines 2240–2248)
    INSTEAD of calling `Scrollback.Wire.to_json/1`. The shape DRIFTS
    from `Wire.to_json/1`'s contract: this site emits `sender_nick:`
    where Wire.to_json emits `sender:`, and omits `id` / `meta` /
    `network` entirely. Cic now consumes two distinct
    `ScrollbackMessage` shapes and has to handle the variant.
  - **`Networks.broadcast_state_change/4`** — emits a
    `{:connection_state_changed, %{...}}` legacy 2-tuple via
    `Phoenix.PubSub.broadcast/3`. NOT through
    `Grappa.PubSub.broadcast_event/2`. Note: a grep across both
    `lib/` and `cicchetto/src/` finds ZERO subscribers — this event
    appears to be orphaned dead code OR a Phase-6 hook with no
    consumer yet (CP15 B5 explicitly punted T32 cic surface). The
    wire shape inline-builds `%{user_id, network_id, network_slug,
    from, to, reason, at}`.

**Impact:** The whole point of `*.Wire` is "Adding a field to a
Message row = one edit here. Removing one = a breaking change
visible at this single site." With three inline emitters, adding
one field requires six edits (wire + producer + consumer x3).
The CP15 B6 Jason-crash bug (raw `%Window{}` structs over
PubSub fastlane) was the canonical proof — Mentions today is
the SAME bug class waiting to land. The shape divergence in
`maybe_broadcast_mentions_bundle/1` IS a live drift: cic's
`MentionsWindow.tsx` consumes `sender_nick` while the rest of
the app consumes `sender`.

**Recommendation:**
  - Create `Grappa.Session.WindowState.Wire` (or fold into the
    `WindowState` extraction from A1) with three render functions:
    `joined/2`, `join_failed/4`, `kicked/4`. Each returns the
    typed map. `Session.Server.window_state_payload/3` becomes a
    one-line delegator and `apply_effects` calls them.
  - Create `Grappa.Mentions.Wire` (or extend `Scrollback.Wire`)
    with `bundle_payload/4` taking `(messages, away_started_iso,
    away_ended_iso, away_reason)`. Internally calls
    `Scrollback.Wire.to_json/1` per message so the mention-row
    shape MATCHES the `:message` event shape — cic stops needing
    a variant.
  - Create `Grappa.Networks.Wire.connection_state_changed_payload/4`.
    Migrate `broadcast_state_change/4` to call it, AND switch
    from raw `Phoenix.PubSub.broadcast/3` to
    `Grappa.PubSub.broadcast_event/2` so the WS push is fastlane-
    aware (CP15 B6 BUG 6 lesson). If the orphan-consumer status
    is intentional ("Phase-6 hook"), document that explicitly in
    the moduledoc; otherwise remove the dead broadcast.

---

### A3. "Admission check + Backoff.reset + Session.start_session" duplicated across FOUR sites with no owning module

**Concern:** Responsibility & cohesion (no home for a recurring verb)
**Scope:**
  - `lib/grappa/bootstrap.ex:335-381` — `spawn_with_admission/6`
  - `lib/grappa_web/controllers/networks_controller.ex:186-205` —
    `spawn_session_after_connect/3` (T32 `/connect` REST surface)
  - `lib/grappa/visitors/login.ex:152, 182, 196` — three
    branches inside `dispatch/4` (case-1 fresh anon, case-2
    registered, case-3 anon-token)
  - `lib/grappa/visitors/login.ex:232 + 290` — `preempt_and_respawn`
    does the `Backoff.reset` + `Session.start_session` half

**Problem:** Per CLAUDE.md "Implement once, reuse everywhere"
+ "(6) Reuse the verbs, not the nouns". Four sites run essentially
the same verb (admission check → backoff reset → resolve plan →
start session → branch on `:already_started`/cap-exceeded/error
→ log+account). Each implements it slightly differently:

  - Bootstrap returns a `%Result{spawned, skipped, failed}`
    accumulator.
  - NetworksController collapses errors to `:ok` and logs +
    `:resolve_failed` / `:start_failed` private tags.
  - Visitors.Login uses `with` + per-branch `NetworkCircuit.record_*`
    (Bootstrap does NOT call NetworkCircuit at all).

The `NetworksController` moduledoc literally says "Mirrors
`Bootstrap.spawn_with_admission/6` but for the REST surface. Per
the S1.2 boundary note: `Networks.connect/1` does DB + broadcast
only; the admission + backoff-reset + start_session orchestration
lives HERE so `Networks` doesn't dep `Admission` (which already
deps `Networks` for cap reads — adding the reverse edge closes a
cycle)."

The boundary cycle observation is correct. The fix is NOT to
copy-paste-mirror; it's to extract the verb into a standalone
`Grappa.SessionLauncher` (or `Grappa.Admission.Spawn`) module that
deps both `Admission` + `Session` + `Backoff`. Only one wrong
turn was taken and three call sites compound it.

**Impact:** The four sites have ALREADY drifted on whether
NetworkCircuit gets called (Bootstrap NO, Visitors.Login YES,
NetworksController NO). Adding the new "admission check on
parked-out reconnect" arm requires four edits with three
different shapes. The next time someone introduces an admission
gate (e.g. T31 captcha rotation, future Phase 5 rate limit), the
"thin spec → fat reality" gap widens.

**Recommendation:** Extract `Grappa.SessionLauncher.launch/4`
taking `(subject, network_id, plan, capacity_input)` and
returning `{:ok, pid} | {:error, :network_cap_exceeded |
:circuit_open | :start_failed | :resolve_failed | reason}`.
Internals: `Admission.check_capacity/1` → `Backoff.reset/2` →
`Session.start_session/3` with the `:already_started` arm folded
in. The four call sites become 1-line dispatches. The
NetworkCircuit accounting that Visitors.Login does becomes a
caller responsibility (Visitors.Login wraps the launcher in its
case-1 + case-2 + case-3 with `record_success`/`record_failure`).
Bootstrap collapses its accumulator-update around the launcher's
return shape. The boundary cycle stays closed because Launcher
is a NEW top-level module deping Admission+Session+Backoff
(none of which dep it).

---

### A4. Outbound IRC framing leaks back into `Session.Server` — `IRC.Client` is missing seven verb helpers

**Concern:** Responsibility & cohesion (IRC framing in Session.Server)
**Scope:**
  - `lib/grappa/session/server.ex:654` — `KICK #{channel} #{nick} :#{reason}\r\n`
  - `lib/grappa/session/server.ex:676` — `INVITE #{nick} #{channel}\r\n`
  - `lib/grappa/session/server.ex:682` — `MODE #{channel} b\r\n` (banlist)
  - `lib/grappa/session/server.ex:688` — `MODE #{state.nick} #{modes}\r\n` (umode)
  - `lib/grappa/session/server.ex:694-704` — `MODE #{target} #{modes}\r\n` / with params (raw)
  - `lib/grappa/session/server.ex:711` — `TOPIC #{channel} :\r\n` (topic clear)
  - `lib/grappa/session/server.ex:587` — `[label_tag(label), "NICK #{new_nick}\r\n"]` (labeled NICK)
  - `lib/grappa/session/server.ex:2086-2087` — `MODE #{channel} #{modes}\r\n` (chunked verbs)
  - `lib/grappa/session/server.ex:2213` — `@label=#{label} AWAY\r\n` (labeled AWAY)

**Problem:** CLAUDE.md "IRC is bytes; the web is UTF-8. Convert at
the boundary, not inside business logic." + the IRC.Client
moduledoc explicitly says "callers can use the high-level helpers
(`send_privmsg/3`, `send_join/2`, etc.) or the raw `send_line/2`
for unframed wire bytes." The intent is that `Session.Server` is
business logic and `IRC.Client` is the framing boundary.

`IRC.Client` exposes `send_privmsg`, `send_join`, `send_part`,
`send_topic`, `send_nick`, `send_quit`, `send_away`,
`send_away_unset`, `send_pong`. It is MISSING `send_kick`,
`send_invite`, `send_banlist`, `send_umode`, `send_mode`,
`send_topic_clear`, AND any labeled-response (`@label=` prefix)
support — all seven gaps are filled with hand-built
`"VERB ... \r\n"` strings via `Client.send_line/2` directly from
`Session.Server`.

The labeled-response handling is the worst case: the prefix
shape (`"@label=<uuid> "`) is replicated in `label_tag/1` inside
Session.Server (line 1559) AND interpolated inline at 587 + 2213.
Three sites; adding a third command that needs labeling means a
fourth.

**Impact:** Grappa rejected `exirc` for "stale on hex" (`CLAUDE.md`)
and bet on owning the parser+client. The bet pays out only if
`IRC.Client` is the single source of truth for outbound framing.
Right now it isn't — adding a new verb (e.g. CP15 follow-up
WHOX, the channel-client-polish T32 surface, or the Phase-6
listener facade) repeats the same pattern: a `:send_xxx`
handle_call in Session.Server, hand-built `"XXX ...\r\n"`,
`Client.send_line`. The `Identifier.safe_line_token?/1` injection
guard ALREADY lives at the `IRC.Client.send_*` boundary; bypassing
via `send_line` skips it (KICK reason is currently NOT validated
at line 654 — a CR/LF in `reason` would inject a second IRC line).

**Recommendation:** Add the seven missing helpers to
`IRC.Client` — same shape as `send_topic/3`: validate via
`Identifier.safe_line_token?/1`, framing inside the helper.
Move `label_tag/1` into `IRC.Client` as `prefix_label/2` (private
helper). Add a `with_label/3` wrapper or a `label:` opt on each
`send_*` so labeled-response is one parameter, not a string-
concatenation pattern. Session.Server's handle_call arms become
one-liners delegating to the client. CC drops below the gate
naturally.

The Phase-6 listener facade (which CLAUDE.md says will reuse the
parser) gets the same outbound surface for free.

---

## MEDIUM

### A5. `GrappaChannel.watchlist_*_for_user/3` does context business logic in the channel module

**Concern:** Responsibility & cohesion (business logic in controller/channel)
**Scope:** `lib/grappa_web/channels/grappa_channel.ex:589-615`,
`lib/grappa/user_settings.ex` (missing helpers)

**Problem:** CLAUDE.md "Controllers thin, contexts thick. Controller
responsibilities: parse params, call context, render. Logic lives in
the context." — `watchlist_add_for_user/3` reads existing patterns,
checks `if pattern in existing`, builds the new list, calls
`set_highlight_patterns/2`. `watchlist_del_for_user/3` does the same
with a `not_found` short-circuit. Those are domain rules — "adding
a duplicate is a no-op success", "removing a missing pattern is
`{:error, :not_found}`".

`UserSettings` exposes `get_highlight_patterns/1` +
`set_highlight_patterns/2` (whole-list overwrite). It is MISSING
`add_highlight_pattern/2` + `remove_highlight_pattern/2` that
encode the dedup + removal semantics ONCE.

**Impact:** A second consumer (REST `/me/watchlist`, mix task,
future operator-facing tool) would re-implement the dedup +
not-found rules. The current implementation in the channel module
is racy too — `get_highlight_patterns/1` + `set_highlight_patterns/2`
are NOT transactional, so two concurrent /watch add from the
same user could lose one pattern.

**Recommendation:** Add `UserSettings.add_highlight_pattern/2`
and `UserSettings.remove_highlight_pattern/2` returning
`{:ok, [String.t()]}` (new patterns) | `{:error, :not_found |
changeset}`. Implement inside a `Repo.transaction` so the
read-modify-write is atomic. Channel collapses to a 3-line
`{:ok, patterns} -> {:reply, {:ok, %{patterns: patterns}}, socket}`
dispatch.

---

### A6. cic `Sidebar.tsx` owns store-shape derivations (`pseudoChannelsForNetwork`, `visibleArchiveForNetwork`)

**Concern:** Responsibility & cohesion (component owning store-shape state)
**Scope:** `cicchetto/src/Sidebar.tsx:84-99`, `cicchetto/src/Sidebar.tsx:125-136`

**Problem:** Per `docs/reviewing.md` §2 "components owning store-shape
state, REST/WS coordination logic in component code (belongs in the
store)". Sidebar.tsx defines TWO derivations:

  1. `pseudoChannelsForNetwork(slug, networkId)` — cross-references
     `windowStateByChannel()` × `channelsBySlug()` × `queryWindowsByNetwork()`
     to compute the "synthetic row" set. Pure derived state from
     three store signals.
  2. `visibleArchiveForNetwork(slug, networkId)` — filters
     `archivedBySlug()` by the union of live channels + queries.
     Mirrors server-side `Scrollback.list_archive/3`'s
     `active_keyset` filter (CP15 B5 follow-up `e3934b0`).

Both are reactive memos in disguise (they're called in JSX render
context, so SolidJS treats them as derivations).

`BottomBar.tsx` reads `channelsBySlug`, `queryWindowsByNetwork`
but does NOT use the synthetic-row derivation — so a `:failed`
JOIN on mobile shows no row in the BottomBar window picker
either. That divergence is a downstream symptom of (1): if the
projection lived in `lib/sidebar.ts` (or extended `windowState.ts`),
BottomBar would consume the same projection and the mobile UX
would inherit the synthetic-row treatment for free.

**Impact:** Per CP15 B6 finding "Sidebar synthetic-row coverage" —
the same projection rule was bug-fixed for `failed/kicked/parked`
in B6 by extending `pseudoChannelsForNetwork`. Locating the
projection inside the component meant the bug surfaced only when
this specific JSX renders; if a Phase-4 mobile branch consumer
landed first, the `failed`/`kicked`/`parked` synthetic-row miss
would re-surface in `BottomBar`. The projection is a domain
invariant ("any windowState key not in `channelsBySlug` and not
a query target must render") — domain invariants belong in stores.

**Recommendation:** Move `pseudoChannelsForNetwork` to
`cicchetto/src/lib/windowState.ts` as
`pseudoRowsForNetwork(slug, networkId): { name, state }[]`
(or sit it as a sibling `lib/sidebar.ts` if windowState should
stay focused on raw maps). Move `visibleArchiveForNetwork` to
`cicchetto/src/lib/archive.ts` as `visibleArchive(slug, networkId)`.
Sidebar + BottomBar import. The CP15 B6 bug class becomes
mechanically impossible: any consumer rendering the network
listing automatically gets the projection.

---

### A7. cic `Shell.tsx` owns navigation-store logic (`flatChannels`, `nextUnread`/`prevUnread`)

**Concern:** Responsibility & cohesion (component owning store-shape state + cross-cutting logic)
**Scope:** `cicchetto/src/Shell.tsx:78-129`

**Problem:** Shell.tsx defines `flatChannels()` — a flat
`(slug, name)` ordered list derived from `channelsBySlug()` ×
`networks()`. Then `nextUnread` and `prevUnread` walk that list
looking up `unreadCounts()` to pick the next mention/unread
window. None of this is JSX or layout; it's the same selection-
domain logic that `lib/selection.ts` owns.

Three signals worth of behavior live as closures inside the
keybinding-registration block, with no test home. The
`shownBanners` `Set<string>` in `cicchetto/src/ScrollbackPane.tsx:113`
is similar — module-scoped mutable Set used as the "have I shown
this banner once" state, with a manual `resetShownBannersForTest/0`
escape hatch instead of a proper signal in a store module.

**Impact:** `flatChannels` is the canonical "all reachable windows"
projection — the same one A6's `pseudoRowsForNetwork` would
extend if the `:pending`/`:failed` rows are reachable for nav too
(today they're NOT — Alt+1..9 skips them, which is itself a
silent bug because pending rows are visible in the sidebar but
unreachable via keyboard). The fix-up needs to live in one place.
`shownBanners` similarly is a per-page-session piece of state with
no observable shape — testing the JOIN-self banner requires a
side-channel reset hook because the state isn't a signal.

**Recommendation:**
  - Add `flatWindows()` to `lib/selection.ts` (or a sibling
    `lib/navigation.ts`) returning `{slug, name, kind}[]` over
    the union of channels + queries + (optionally) pseudo-rows.
    Move `nextUnread`/`prevUnread`/`selectChannelByIndex` selection
    logic into the same module — they're pure functions over
    `(flatWindows, unreadCounts, currentSelection)`. Shell becomes
    a thin keybinding-registration site.
  - Replace `shownBanners` Set with a `bannerShownByChannel`
    signal in `lib/joinBanner.ts` (or fold into `windowState.ts`).
    Drop the test-only reset hook — tests reset the signal via
    its public setter.

---

### A8. `Networks.broadcast_state_change/4` event has no consumer; `Mentions` events use a wire shape that drifts from `Scrollback.Wire`

**Concern:** Responsibility & cohesion (orphan + drift)
**Scope:**
  - `lib/grappa/networks.ex:443-463` (orphan)
  - `lib/grappa/session/server.ex:2240-2248` (drift) +
    `cicchetto/src/MentionsWindow.tsx`'s consumer

**Problem:** Two related smells under "wire conversion is per-context
responsibility":

  - `:connection_state_changed` is broadcast from THREE call sites
    (`connect/1`, `disconnect/2`, `mark_failed/2`) but has ZERO
    subscribers in either `lib/` or `cicchetto/src/` (verified via
    grep). Either the T32 cic surface is supposed to consume it
    (and never wired up — CP15 B5 punted parked-flow to the
    `channel-client-polish` cluster), OR it's dead code from an
    earlier design pass. Either way, an orphan broadcaster IS a
    responsibility violation: the verb's responsibility is
    incomplete on the consuming end.
  - The `mentions_bundle` event's per-message map uses
    `sender_nick:` as the key (line 2244) where every other surface
    in the codebase uses `sender:` (matches the schema field name
    + `Scrollback.Wire.to_json/1`'s output). cic consumers therefore
    use `m.sender_nick` for mention rows and `m.sender` for
    everything else — silent drift the typescript compiler doesn't
    catch (the API type for the bundle surface is presumably
    distinct from the per-message API type, papering over the
    rename).

**Impact:** Orphan broadcaster: consumes process mailbox slots
+ network bandwidth for nothing; a future T32 cic consumer that
uses the obvious legacy 2-tuple shape would skip the
fastlane-aware `broadcast_event/2` migration A2 calls for. Drift:
the next cluster touching mention rendering OR scrollback
rendering will fail to share helpers, and a `Scrollback.Wire`
field addition won't propagate to MentionsWindow.

**Recommendation:** Either remove the
`:connection_state_changed` broadcast (with a `git grep` audit
to confirm no out-of-tree consumer in cic e2e tests) OR wire it
up properly per A2 (Wire module + `broadcast_event/2`). For the
mentions drift: rename `sender_nick:` to `sender:` AND emit the
per-message map via `Scrollback.Wire.to_json/1` so the shape is
identical to the `:message` event's `message:` field — cic's
`MentionsWindow` reuses the existing `ScrollbackMessage` type.

---

## LOW

### A9. `Visitors.Login` re-implements admission + spawn THREE times in three branches of `dispatch/4`

**Concern:** Responsibility & cohesion (intra-module duplication)
**Scope:** `lib/grappa/visitors/login.ex:144-200`

**Problem:** Even after A3's extraction lands, `dispatch/4`'s three
branches (case-1 fresh anon, case-2 password gate, case-3 anon
token) each open with a similar `capacity_input = %{network_id, client_id, flow}`
construction + `Admission.check_capacity/1`. The flow tags differ
(`:login_fresh` vs `:login_existing`) but the rest is mechanical.
A4 collapse would centralize this further.

**Impact:** Adding a fourth admission gate (e.g. CAPTCHA on
case-2 — currently only case-1 has it) means three edits.

**Recommendation:** After A3's extraction, fold the three
`dispatch/4` branches' admission shape into a single
`with_admission(input, network, flow, fn -> ... end)` helper.
Each case's body becomes the lambda. The `flow:` tag is the
only param.

---

### A10. `lib/mix/tasks/grappa/boot.ex` is the operator-task admission boundary; the runtime/operator distinction is implicit

**Concern:** Responsibility & cohesion (operator-task vs runtime config split is implicit)
**Scope:** `lib/mix/tasks/grappa/boot.ex` (referenced by every operator mix task)

**Problem:** Per CLAUDE.md OTP rule on `Application.put_env/2`:
"inside mix-task helpers BEFORE `Application.ensure_all_started/1`
(operator-task suppression of `Grappa.Bootstrap` is mirror-symmetric
with `config/test.exs`'s `:start_bootstrap, false` — pre-boot
configuration of the same exception point, not config-as-IPC)."

The `boot.ex` module IS the documented exception point — but
it's not labeled as such in the moduledoc, AND every new operator
mix task reads it manually. There's no compile-time guard
preventing a task author from suppressing OTHER children (e.g.
`Endpoint`) via the same `Application.put_env` channel.

**Impact:** Discoverability; risk of a future operator-task
introducing a second `:start_endpoint, false`-style flag that
nobody knows is read at boot.

**Recommendation:** Document the rule in `boot.ex`'s moduledoc:
"This is the ONLY sanctioned `Application.put_env/2` writer
outside `config/*.exs` and `lib/grappa/application.ex`. New
operator tasks: import this module's `suppress_bootstrap/0`,
do NOT add new put_env reads/writes." Optionally extract a
`Grappa.OperatorTask` behaviour that wraps the boot-suppress +
`ensure_all_started` pattern; new tasks `use` it.

---

## Summary

The post-CP15 codebase has clean **invariants** (window-state on
the server, wire conversion per context, IRC framing on the IRC
side) but **incomplete enforcement**: three event-broadcast paths
still inline-build wire shape (A2), Session.Server reaches across
the IRC framing boundary in seven hand-built lines (A4), the
"admit + spawn" verb has been copy-paste-tweaked into four sites
without a home (A3), and `Session.Server` itself is a 2271-LOC
god module owning ten distinct domains (A1) — three of which (mode
chunking, away-state, window-state-mirror) are extraction-ready
sub-context candidates.

cicchetto-side cohesion is healthier post-CP15 D-cluster split,
but the Sidebar/BottomBar drift on synthetic rows (A6) shows the
cost of letting components own derivations: domain invariants
that need to apply to multiple consumers regress silently.

Recommended sequencing for the next architecture-debt cluster:

  1. **A2** first — three `*.Wire` extractions are 1-bucket each,
     no boundary change, plus the BUG-class lesson from CP15 B6
     is fresh.
  2. **A4** next — fills the IRC.Client gap, removes the
     `safe_line_token?` injection skip path on KICK, and unblocks
     A1's Session.Server slimming.
  3. **A3** — the SessionLauncher extraction collapses the
     four-site duplication and stops Visitors.Login + Bootstrap +
     NetworksController drift.
  4. **A1's WindowState extraction** — fold A2's
     `Session.WindowState.Wire` into the same module; smallest-
     blast-radius first per the recommendation.
  5. **A6 + A7** in cic — single bucket, parallels A1's "extract
     domain projections to a store module."

A5, A8, A9, A10 are paper-cut findings that fit at the tail of
each respective bucket without their own cluster.

---

# duplication/

# Architecture Review — Duplication
**Date:** 2026-05-08
**Reviewer:** architecture-duplication agent
**Concern:** Same problem solved differently, copy-pasted with tweaks, parallel structures that drift.
**Cluster context:** CP15 (event-driven windows) just landed. CP15 B6 explicitly fixed one Wire-shape duplication bug (`Grappa.QueryWindows.Wire` extraction after the `%Window{}` Jason crash). The pattern is now policy ("wire-shape conversion is a context responsibility"). This review traces where the policy is followed, where it isn't, and where parallel structures are silently drifting.

---

## CRITICAL

(none)

## HIGH

### A1. Window-state event payloads are hand-mirrored across event-time and snapshot-time paths
**Concern:** Duplication
**Scope:**
- `lib/grappa/session/server.ex:1712-1722` (`apply_effects [{:joined, ...}]`)
- `lib/grappa/session/server.ex:1791-1802` (`apply_effects [{:join_failed, ...}]`)
- `lib/grappa/session/server.ex:1842-1854` (`apply_effects [{:kicked, ...}]`)
- `lib/grappa/session/server.ex:1973-2006` (`window_state_payload/3` — snapshot builder)
- `lib/grappa/session.ex:601-625` (`@type window_state_snapshot`)

**Problem:** CP15 B3 introduced a new event family (`joined`/`join_failed`/`kicked`) and pinned that the snapshot push (cold-WS reconnect) MUST be byte-identical to the event-time broadcast. The implementation enforces this via prose discipline, NOT via shared code: the three `apply_effects` arms each build their `%{kind: ..., network: ..., channel: ..., state: ..., ...}` map inline, and `window_state_payload/3` rebuilds the same three shapes a second time for the snapshot path. The CP15 B3 narrative ("payload is byte-identical to the event-time broadcast") is a reviewer-burden contract — there is no compile-time check that the four sites stay aligned.

The CP15 cluster's own retrospective named exactly this pattern as a lesson: B6 found `query_windows_list` hand-mirrored between `QueryWindows.broadcast_windows_list/2` and `GrappaChannel.push_query_windows_list/2`, fixed by extracting `Grappa.QueryWindows.Wire`. The same fix never reached the window-state events that B3 introduced one bucket earlier.

**Impact:**
- A future B-bucket adding `:parked` (T32 work, already named in the typespec) MUST remember to update both `apply_effects` AND `window_state_payload/3`. The stub at `server.ex:228` already says `:parked` "reads as `:not_tracked` from the snapshot verb until disconnect verbs land" — the asymmetry is already baked in.
- A field added to one path drifts silently. The same class of bug B6 found (`join_failed` event broadcast but the persisted notice never broadcast as `kind: "message"`) fits this shape: two broadcasters, one kept up to date, the other forgotten.
- Cic-side `subscribe.ts:96-122` `WireEvent` union must also be updated in lockstep (third site) — there is currently no codegen or shared shape between server and client (see A2).

**Recommendation:** Extract a `Grappa.Session.WindowStateWire` module sibling to `Grappa.QueryWindows.Wire` and `Grappa.Scrollback.Wire`:
```elixir
defmodule Grappa.Session.WindowStateWire do
  @spec joined(String.t(), String.t()) :: t()
  def joined(network_slug, channel), do: %{kind: "joined", network: network_slug, channel: channel, state: "joined"}

  @spec join_failed(String.t(), String.t(), String.t() | nil, pos_integer()) :: t()
  def join_failed(network_slug, channel, reason, numeric), do: ...

  @spec kicked(String.t(), String.t(), String.t() | nil, String.t() | nil) :: t()
  def kicked(network_slug, channel, by, reason), do: ...
end
```
Both the `apply_effects` arms and `window_state_payload/3` consume the same constructors. Adding `:parked` is then one site (the new constructor + the snapshot-arm dispatch). The `members_seeded` payload (server.ex:1696-1701 + grappa_channel.ex:747-752) and `topic_changed` / `channel_modes_changed` payloads have the same problem and the same fix — collect them under `Grappa.Session.Wire` (or per-concern: `MembersWire`, `TopicWire`, `ModesWire`) and have **every** broadcaster + snapshot pusher delegate.

### A2. cicchetto `WireEvent` union is hand-typed mirror of seven server-side broadcast shapes
**Concern:** Duplication
**Scope:**
- `cicchetto/src/lib/subscribe.ts:92-122` (`WireEvent` discriminated union)
- `cicchetto/src/lib/api.ts:31-45` (`AdmissionError`, `Subject`, `LoginResponse`)
- `cicchetto/src/lib/api.ts:63-71` (`MeResponse`)
- `cicchetto/src/lib/api.ts:401-416` (`CredentialJson`)
- All `lib/grappa/*/wire.ex` modules
- All inline-shape broadcasters in `lib/grappa/session/server.ex` (`channels_changed`, `own_nick_changed`, `away_confirmed`, `members_seeded`, `topic_changed`, `channel_modes_changed`, plus the three CP15 window-state events)
- `lib/grappa/query_windows.ex:209` + `lib/grappa_web/channels/grappa_channel.ex:671` (`query_windows_list` envelope built inline at both sites)

**Problem:** Every server-side wire shape has a hand-typed TypeScript counterpart. CLAUDE.md mandates "wire-shape conversion is a context responsibility" with `*.Wire` modules — but that policy only addresses the SERVER side. The client-side `api.ts` types and the `WireEvent` union in `subscribe.ts` are pure prose-contract mirrors of:
- `Grappa.Accounts.Wire` (user)
- `Grappa.Networks.Wire` (network, network_with_nick, channel, credential)
- `Grappa.Scrollback.Wire` (message, event-wrapper)
- `Grappa.QueryWindows.Wire` (window, grouped)
- `Grappa.Visitors.Visitor` (no Wire — see A4)
- 9 inline event shapes never extracted to Wire (3 window-state + members_seeded + topic_changed + channel_modes_changed + channels_changed + own_nick_changed + away_confirmed + query_windows_list envelope)

The `WireEvent` union (subscribe.ts:92-122) is the worst offender: it carries 7 inline literal types, none of which have a server-side type alias; the only enforcement is "the moduledoc says it's the same shape." The 2026-05-03 codebase review's M-arch-3 already flagged the cross-language enum drift as a Phase-5 codegen target (5 enums then; this brings it to ~12 sites).

**Impact:**
- Every server-side broadcast shape change is a two-commit minimum with a prose-only correctness contract. The CP15 retrospective's B6 bug-3 ("join_failed notice silent on cic") is exactly this class — server side broadcast shape + cic handler diverged because nothing forced them to stay aligned.
- Phase 6 IRCv3 listener needs a third serializer (IRC bytes) for these same shapes. With no canonical shape source, the divergence triples.
- Extension cost is hidden but real: adding a 10th event kind requires touching server broadcast site + (possibly) a snapshot-push site + cic `WireEvent` union + cic dispatch handler — minimum 4 sites, no compile-time check anywhere.

**Recommendation:** This is the Phase 5 codegen story already implicit in the trajectory. Two-step path:
1. **Eliminate inline event shapes server-side first (per A1)** — every broadcaster goes through a `*.Wire` module. Once the server shapes have ONE canonical Elixir definition, codegen has a target.
2. **Generate `cicchetto/src/lib/api.ts` types from the Wire modules' `@type` definitions** (mix task emitting a `wire.generated.ts`; commit-time gate ensures no drift). Smallest viable shape: walk each `Wire` module's `@type t` via `Module.get_attribute`, emit TS unions from atom literals, structs from `@type` records. The `subscribe.ts` `WireEvent` union becomes a generated `ServerEvent` import.

This is large work; the small bite that closes the IMMEDIATE drift risk is A1 + A4 + A5 (extract the missing Wire modules so the prose contract becomes function calls server-side).

### A3. Cicchetto per-channel signal stores duplicate the `createRoot + on(token) reset` boilerplate at 7+ sites
**Concern:** Duplication
**Scope:**
- `cicchetto/src/lib/scrollback.ts:54-88`
- `cicchetto/src/lib/members.ts:34-46`
- `cicchetto/src/lib/selection.ts:54-66`
- `cicchetto/src/lib/windowState.ts:41-65`
- `cicchetto/src/lib/mentions.ts:18-25`
- `cicchetto/src/lib/channelTopic.ts:30-42` (also stores topic + modes — two maps in one root)
- `cicchetto/src/lib/queryWindows.ts:35-50`
- `cicchetto/src/lib/archive.ts` (uses similar shape, slug-keyed)

**Problem:** Every per-channel signal store opens with the identical 6-line block:
```typescript
const exports_ = createRoot(() => {
  const [byKey, setByKey] = createSignal<Record<ChannelKey, T>>({});
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) setByKey({});
    }),
  );
  // ...verbs...
});
```
The "on identity rotation, flush the per-key map" rule is a cross-store invariant (logout + bearer-rotation safety). Every store re-implements it. The `prev != null` idiom is the same load-bearing detail at every site (initial-run + cold-login both have `prev === undefined`/`null`; only logout/rotate trigger the reset). One store implementing it slightly differently is a per-tenant data-leak bug.

The pattern is documented inline at every site as "mirror of `scrollback.ts`'s on(token) cleanup" — explicit prose-pinned duplication.

**Impact:**
- Adding an 8th per-channel store will repeat the boilerplate. Forgetting the cleanup is a security bug (cross-tenant leak) that no test today guards against in the abstract — each store has its own cleanup test, none assert the cross-store invariant.
- `windowState.ts` ALREADY has a small variant: it flushes 3 maps in one effect (lines 56-65). The next store with N maps will re-author the same N-set logic.
- The CP15 retrospective named cic store extension as a recurring pattern; per-bucket the store count grew from 5 to 8.

**Recommendation:** Extract a `cicchetto/src/lib/identityScopedStore.ts` factory:
```typescript
export function createPerChannelStore<T>() {
  const [signal, setSignal] = createSignal<Record<ChannelKey, T>>({});
  createEffect(on(token, (t, prev) => { if (prev != null && t !== prev) setSignal({}); }));
  return [signal, setSignal] as const;
}
```
Each store becomes 1 line + its verbs. The cross-tenant invariant moves from "8 sites, eyeball-verified" to "1 site, type-checked." Variants: a `createPerChannelMultiStore` for `windowState.ts` taking N reset functions, or simply have `windowState.ts` make 3 separate calls (the splits are independent today).

### A4. `Grappa.Visitors.Visitor` has no Wire module — wire shape duplicated inline at 2 sites
**Concern:** Duplication
**Scope:**
- `lib/grappa_web/controllers/auth_json.ex:41-50` (`{kind: "visitor", id, nick, network_slug}`)
- `lib/grappa_web/controllers/me_json.ex:46-54` (`{kind: "visitor", id, nick, network_slug, expires_at}`)
- `lib/grappa/visitors/visitor.ex` (no companion `Wire` module)

**Problem:** `User` has `Grappa.Accounts.Wire.user_to_json/1` + `user_to_credential_json/1` because Argon2 password_hash leaks via Jason struct walks. `Visitor` has `password_encrypted` (Cloak-decrypted to plaintext upstream password in memory after `Repo.one!`) + `:redact` on the field — the EXACT same hazard `Networks.Wire` documents. Yet the visitor wire shape is hand-rolled at TWO controllers, and `AuthJSON`'s moduledoc explicitly admits: "Grappa.Visitors.Visitor is fully internal to the cluster/visitor-auth work and has no separate Wire module yet." The "yet" has been there since the visitor-auth cluster closed (CP11 S16, ~3 weeks).

The CP15 B6 retrospective's bug-2 (`%Window{}` struct over PubSub crashed Phoenix's fastlane) PLUS the existing `Networks.Wire` rationale ("redact protects inspect/1 and Logger output but NOT Jason.encode!/1") = an existing pattern that says: any schema with a sensitive field MUST go through a Wire module. Visitor breaks this rule.

**Impact:**
- Any future controller that does `json(conn, visitor)` or any Phoenix Channel push that sends `%Visitor{}` over PubSub leaks `password_encrypted` (post-Cloak-load plaintext). The Wire module is the documented chokepoint; without it, the "next naive controller" that returns visitor profile data leaks credentials.
- The two-site inline shape WILL drift. CP15 already added `expires_at` to `MeJSON.show/1`; the NEXT visitor field (T32 will likely add visitor connection state) lands at 2 sites with prose contract.
- Mirror sites in `cicchetto/src/lib/api.ts:39-46` (`Subject` union) + `:63-71` (`MeResponse` visitor branch) pile on the drift.

**Recommendation:** Create `lib/grappa/visitors/wire.ex` with `visitor_to_subject_json/1` (id/nick/network_slug — the AuthJSON shape) + `visitor_to_profile_json/1` (id/nick/network_slug/expires_at — the MeJSON shape). Mirror the `Accounts.Wire` allowlist + the `Networks.Wire` "NEVER include password_encrypted" moduledoc. Both controllers delegate. Closes a real security risk (the Wire-as-allowlist defense is missing) AND the 2-site duplication.

### A5. `members_seeded`, `topic_changed`, `channel_modes_changed`, `channels_changed`, `own_nick_changed`, `away_confirmed` event shapes are hand-mirrored across broadcaster + snapshot pusher
**Concern:** Duplication
**Scope:**
- `lib/grappa/session/server.ex:1696-1702` (members_seeded broadcast) ↔ `lib/grappa_web/channels/grappa_channel.ex:747-752` (members_seeded snapshot push)
- `lib/grappa/session/server.ex:1651-1656` (topic_changed broadcast) ↔ `lib/grappa_web/channels/grappa_channel.ex:708-713` (topic_changed snapshot push)
- `lib/grappa/session/server.ex:1666-1671` (channel_modes_changed broadcast) ↔ `lib/grappa_web/channels/grappa_channel.ex:724-729` (channel_modes_changed snapshot push)
- `lib/grappa/session/server.ex:1611-1614` (channels_changed broadcast — no snapshot push)
- `lib/grappa/session/server.ex:1632-1638` (own_nick_changed broadcast — no snapshot push)
- `lib/grappa/session/server.ex:1908-1916` (away_confirmed broadcast — no snapshot push)
- `lib/grappa_web/controllers/members_json.ex:14-19` (REST members shape — third mirror)
- `lib/grappa/session/server.ex:814-819` (`{:list_members, ...}` callback — fourth mirror of the members → list-of-maps reshape)

**Problem:** Every "cached state + WS subscribers might miss the original broadcast" event has TWO sites that build the same payload by hand: the event-time broadcaster (in `apply_effects`) and the deploy-reconnect snapshot pusher (in `grappa_channel.ex`). The CP15 B3 narrative explicitly documents the byte-identical contract — yet enforces it via prose. Three of the six events lack a snapshot path today (channels_changed / own_nick_changed / away_confirmed); when those gain one (Phase 5+ likely), the duplication doubles.

The members shape is the most extreme: FOUR sites (event broadcast, snapshot push, REST `MembersJSON`, `Session.Server.handle_call({:list_members, ...})`). Three of them apply the same `Enum.map(fn {nick, modes} -> %{nick: nick, modes: modes} end) |> Enum.sort_by(...)` reshape on `state.members`. Server.ex:1683 even has a prose comment: "Sort + serialize the same way list_members/3 does" — which is the textbook duplication smell.

**Impact:**
- The same class of bug B6 fixed (silent push because two broadcasters had different shapes) WILL recur. Each new event-with-snapshot doubles the surface.
- Wire-shape evolution requires audit of pairs. Adding a `:host` field to members (post-Phase-5 IRCv3 with `:identify-msg`) means 4 edits for one feature.
- REST `MembersJSON` and the WS `members_seeded` push currently have DIFFERENT envelope styles — REST wraps `%{"members" => [...]}` with stringified keys, WS sends the inner list with atom keys. Cic doesn't care today (no REST consumer post-CP15-B5) but if the REST endpoint stays in-router with no consumer, that's dead code (cross-cutting with responsibility review's scope, not strictly duplication).

**Recommendation:** Same shape as A1 — extract per-event constructors:
```elixir
defmodule Grappa.Session.Wire do
  def members_seeded(network_slug, channel, members), do: %{kind: "members_seeded", ...}
  def topic_changed(network_slug, channel, entry), do: %{kind: "topic_changed", ...}
  def channel_modes_changed(network_slug, channel, entry), do: %{kind: "channel_modes_changed", ...}
  def channels_changed, do: %{kind: "channels_changed"}
  def own_nick_changed(network_slug, prev_nick, next_nick), do: ...
  def away_confirmed(network_slug, away_str), do: ...
end
```
Plus `Grappa.Session.MembersWire.from_state_members(state_members)` for the `state.members → sorted list-of-maps` reshape — consumed by the `:list_members` callback, the `:members_seeded` apply_effects arm, and `MembersJSON` (which would simply pass-through). This kills the prose-pinned "build it the same way" contract at all four sites.

## MEDIUM

### A6. `query_windows_list` envelope built inline at 2 sites despite `QueryWindows.Wire` extraction
**Concern:** Duplication
**Scope:**
- `lib/grappa/query_windows.ex:209` (`%{kind: "query_windows_list", windows: windows}`)
- `lib/grappa_web/channels/grappa_channel.ex:671` (`%{kind: "query_windows_list", windows: windows}`)

**Problem:** CP15 B6 extracted `Grappa.QueryWindows.Wire.render_grouped/1` to fix the `%Window{}` struct Jason crash, but only the INNER reshape moved to the Wire module. The outer `%{kind: "query_windows_list", windows: ...}` envelope is still hand-rolled at both broadcaster (query_windows.ex:209) and snapshot pusher (grappa_channel.ex:671). Same shape, same dispatcher key, two definitions — the bug B6 fixed is half-fixed.

**Impact:**
- A future renaming `kind: "query_windows_list"` to anything else needs both edits.
- Adding a sibling field (e.g. `last_synced_at`) to the envelope requires both edits.

**Recommendation:** Add `Grappa.QueryWindows.Wire.list_event(windows_grouped) :: %{kind: String.t(), windows: ...}`. Both call sites become `Wire.list_event(Wire.render_grouped(list_for_user(...)))`. Same shape as `Scrollback.Wire.message_payload/1` already does for the message envelope — consistency with the existing pattern.

### A7. `WireEvent` union has 5 in-handler dispatch arms in `installChannelHandler` mirroring 5 inline server kinds
**Concern:** Duplication
**Scope:**
- `cicchetto/src/lib/subscribe.ts:249-282` (installChannelHandler 5-arm if-chain)
- `cicchetto/src/lib/subscribe.ts:337-358` (installDmListenerHandler — same shape, different dispatch)

**Problem:** `installChannelHandler` and `installDmListenerHandler` both implement a per-`kind` dispatch as a series of `if (payload.kind === "X") return` early-returns. The list maps 1:1 to the `WireEvent` union variants but is built by hand at each install site. There is no exhaustiveness check (`assertNever`). A new `WireEvent` variant (e.g. T32 `parked` event) compiles fine even if neither handler dispatches on it — it silently drops at runtime. The cic claim that a new server state inherits handling automatically (CLAUDE.md "new states automatically inherit synthetic-row + greyed-class treatment") only holds AFTER subscribe.ts is also updated.

**Impact:**
- Adding a 6th event kind = 3 sites: `WireEvent` union + `installChannelHandler` + `installDmListenerHandler` (or explicit drop documented). No type system enforces it.
- The "B6 bug-3" silent-drop class (server emits, cic ignores) reproduces on every new event.

**Recommendation:** Replace the if-chain with a `switch (payload.kind)` + `default: assertNever(payload)`. The `assertNever` helper (commonly seen in this codebase per `ScrollbackPane.tsx`'s `MessageKind` exhaustiveness — see api.ts:122) makes future additions a compile error. Also: hoist the channel-handler dispatch table to a single function `dispatchChannelEvent(payload, deps)` so installChannelHandler's "channel topic" routing and installDmListenerHandler's "DM-listener" routing share the message-routing arms (they currently both call `routeMessage` but build their own boilerplate around it).

### A8. `User` and `Visitor` schemas have parallel "subject discriminator" projections at 3+ sites with no shared module
**Concern:** Duplication
**Scope:**
- `lib/grappa_web/controllers/auth_json.ex:36-51` (login subject discriminator)
- `lib/grappa_web/controllers/me_json.ex:40-54` (me subject discriminator)
- `lib/grappa_web/subject.ex` (exists but unverified — may help)
- `lib/grappa_web/plugs/authn.ex` (assigns `:current_subject`, `:current_user`, `:current_visitor` in parallel — discriminator carried as 3 separate keys not 1 tagged tuple)
- `cicchetto/src/lib/api.ts:39-46` (`Subject` union — third site)
- `cicchetto/src/lib/api.ts:63-71` (`MeResponse` union — fourth site)

**Problem:** The `{:user, %User{}} | {:visitor, %Visitor{}}` discriminated union is a first-class domain concept (every controller pattern-matches on it; Plugs.Authn explicitly carries `current_subject` as the canonical form). Yet the wire-side rendering is hand-built at each emitter — `AuthJSON.login/2` renders a 4-field shape, `MeJSON.show/1` renders a 5-field shape, both with the same `kind:` + `id:` + `name|nick|network_slug:` discriminator core. The 2026-05-03 codebase review M-arch-5 already flagged that `Admission.capacity_input` carries `subject_kind` + `subject_id` as parallel fields not the tagged tuple — same root issue at a different boundary.

**Impact:**
- Adding a 3rd subject kind (none planned, but a real risk — Phase 6 IRCv3 listener "facade subject" could be a new kind) requires touching every emit site.
- Visitor field additions repeat at multiple sites (already happened with `expires_at`).

**Recommendation:** Combine with A4. Define `Grappa.Subject.Wire` that takes `{:user, User.t()} | {:visitor, Visitor.t()}` and emits the discriminated wire shape. Both `AuthJSON` and `MeJSON` delegate; the per-action shape difference (login = minimal, me = full profile) becomes a second arity (`Subject.Wire.credential/1` vs `Subject.Wire.profile/1`).

### A9. `Captcha.Turnstile` and `Captcha.HCaptcha` near-duplicates (also flagged by 2026-05-03 review M-arch-1)
**Concern:** Duplication
**Scope:**
- `lib/grappa/admission/captcha/turnstile.ex` + `lib/grappa/admission/captcha/h_captcha.ex` (35-line near-duplicates)
- Test files at `test/grappa/admission/captcha/{turnstile,h_captcha}_test.exs` (76-line near-duplicates per M-cross-3)

**Problem:** Already filed in 2026-05-03 codebase review M-arch-1 + M-cross-3 as part of the T31 follow-up cleanup cluster. **Not new** — re-flagging only because the cluster has not yet opened, the duplication remains, and the architectural cost of leaving it (+ provider name hand-mirrored at 5 sites: 2 captcha modules + FallbackController + cicchetto Login.tsx + cicchetto AdmissionError union) compounds with each new admission gate.

**Impact:** Adding a 3rd captcha provider (recaptcha, hcaptcha-enterprise) means 35 LOC of mostly-copy with one URL change, plus a 4th spot in `FallbackController.captcha_provider_wire/0`, plus a 4th union arm in cic.

**Recommendation:** Per existing M-arch-1: extract `Grappa.Admission.Captcha.SiteVerifyHttp` private helper; per-impl modules collapse to ~6 lines. ALSO: the captcha provider name → wire token table needs a `Captcha.wire_name/0` callback so `FallbackController` consumes the verb instead of the case (existing M-arch-3 fix). Folded here as a duplication concern (not a new finding) for traceability.

### A10. Sidebar "synthetic row + greyed class" treatment derives `windowStateByChannel` shape at multiple sites
**Concern:** Duplication
**Scope:**
- `cicchetto/src/Sidebar.tsx` (`pseudoChannelsForNetwork` projection — failed/kicked/parked rows synthesized when state in `windowStateByChannel` but not in `channelsBySlug`)
- `cicchetto/src/MembersPane.tsx` (three-branch render keyed on windowState — joined / pending / not-joined)
- `cicchetto/src/ComposeBox.tsx` (greyed class when state ∈ {failed, kicked, parked})
- `cicchetto/src/lib/windowState.ts` (`NOT_JOINED_STATES` set — search the source for the exact constant)

**Problem:** The CP15 B6 narrative claims that `windowStateByChannel` is "the AUTHORITATIVE sidebar projection key" and that "new states automatically inherit synthetic-row + greyed-class treatment as long as they land in `windowStateByChannel`" (CLAUDE.md, post-CP15 invariant). That's true for the projection KEY — but the per-state semantic ("which states are non-joined for compose-greying purposes", "which states render as 'not joined' in MembersPane", "which states get a synthetic sidebar row") is computed at each consumer. Sidebar.tsx, MembersPane.tsx, and ComposeBox.tsx each have to know "the set of non-joined states is {pending, failed, kicked, parked}." Adding `:locked` (the SASL-gated state CLAUDE.md mentions as a hypothetical) requires updating 3 consumer sites in lockstep.

**Impact:**
- The "automatically inherits" claim is partially true: only the `windowStateByChannel` *key* inherits. The *semantic* (which states grey, which states block compose, which states show "not joined") is still per-site.
- A consumer that forgets to update a state set silently degrades for the new state.

**Recommendation:** Promote `NOT_JOINED_STATES` (the set used at multiple sites) to `windowState.ts` as an exported predicate `isWindowJoined(state) | isWindowPending(state) | isWindowFailed(state)` — consumers use the predicates, not the literal sets. Plus: a derived signal `synthethicSidebarRows(networkSlug)` in `windowState.ts` that returns the rows Sidebar.tsx needs to synthesize, computed ONCE from `windowStateByChannel + channelsBySlug + queryWindowsByNetwork`. Sidebar.tsx becomes a renderer over the derived signal, not a re-derivation site. Same shape as A3 (the cross-cutting per-channel-store invariant) at the projection layer.

### A11. Two paths for "is this row outbound vs inbound DM" — server-side `Scrollback.dm_peer/4` is the rule, but cic computes the same thing for rendering
**Concern:** Duplication
**Scope:**
- `lib/grappa/scrollback.ex` (`dm_peer/4` — single source server-side per CP14 B3)
- `lib/grappa/session/server.ex:1375` (calls dm_peer for outbound — correctly delegates)
- `cicchetto/src/lib/subscribe.ts:331-360` (DM-listener handler re-derives the "is this DM" rule via `payload.message.kind === "privmsg" || "action"` + topic = own-nick, plus `sender !== ownNick` for inbound vs self-msg detection)
- `cicchetto/src/ScrollbackPane.tsx` (renders DM lines — the "is own message" + "is DM target same as me" check is at render time)

**Problem:** "Is this PRIVMSG a DM?" and "who's the DM peer?" are server-side rules (`Scrollback.dm_peer/4`). The wire payload carries `dm_with` (CP14 B3) — but cic's subscribe.ts computes the equivalent client-side from sender + ownNick instead of reading `dm_with`. There are two DM-detection paths now: server's `dm_peer` for `dm_with` column AND cic's "if I'm subscribed to the own-nick topic the message is a DM" rule. They agree today; there's no single contract that pins them.

**Impact:**
- Adding a new DM-shape event (e.g. `:notice` to a peer) means updating server `dm_peer` AND cic dispatch. The `dm_with` column already exists — cic doesn't read it.
- Phase 6 IRCv3 listener (`CHATHISTORY` translation) will need DM detection for tag mapping. Three implementations of one rule.

**Recommendation:** cic should read `payload.message.dm_with` directly when present and dispatch via that — not topic-based heuristics. The topic-based subscribe routing stays (it's a transport concern), but the per-message "this is a DM with X" decision must come from the wire field. This narrows cic's DM logic to "subscribe to topic; on event, check `dm_with`." The B3 follow-up "subscribe pre-joins per-channel topic on windowState pending" notes that subscribe.ts logic generalizes to "all WS-topic subscribe paths" — same impulse, different concern.

## LOW

### A12. cicchetto `archive.ts` slug-keyed store is the 8th instance of the createRoot+on(token) pattern but slug-keyed not channel-keyed — first variant of A3
**Concern:** Duplication
**Scope:** `cicchetto/src/lib/archive.ts`
**Problem:** Folded into A3. Variant: keyed by network slug not ChannelKey. The factory in A3's recommendation should accept the key-type as a generic parameter so this store fits the same shape.

### A13. `e2e/fixtures/grappaApi.ts` has its own `WireMessage` type duplicating `cicchetto/src/lib/api.ts` `ScrollbackMessage`
**Concern:** Duplication
**Scope:** `cicchetto/e2e/fixtures/grappaApi.ts:78-87`
**Problem:** The e2e runner declares `type WireMessage = { id, network, channel, server_time, kind, sender, body, meta }` — identical to `ScrollbackMessage` in `cicchetto/src/lib/api.ts:135-144`. Two reasons: e2e is a separate TS project (separate tsconfig) so cross-importing isn't free; and the runner is a deliberately minimal client (no Solid bundle). Either acceptable — but the type duplication is worth flagging because the same ostensibly-minimal-runner has both `loginAs` (mirroring server `LoginResponse`) and `partChannel`/`joinChannel` (mirroring `cicchetto/src/lib/api.ts` `postPart`/`postJoin`). When server wire shape changes, four sites (server Wire, controller JSON, cic api.ts, e2e fixture) need an audit.

**Recommendation:** Either (a) share `cicchetto/src/lib/api.ts` types with the e2e runner via a path mapping in e2e's tsconfig (the api.ts types are already pure type aliases, no Solid runtime), or (b) accept the duplication as the cost of e2e isolation but enforce the shape via a single golden-fixture test that asserts every Wire field is present.

### A14. `loadInitialScrollback` REST gate (`loadedChannels` Set) is a per-tenant invariant — pattern aligns with A3 but the gate Sets aren't reset visibly via the same factory
**Concern:** Duplication
**Scope:** `cicchetto/src/lib/scrollback.ts:54-88`
**Problem:** scrollback.ts has THREE separate `Set<ChannelKey>` instances (`loadedChannels`, `loadMoreInFlight`, `loadMoreExhausted`) all reset by the same `on(token)` arm. The pattern is per-store internal; not worth its own factory but reinforces A3's case. **Folded** into A3.

### A15. `MembersJSON` envelope wraps with stringified keys (`"members" => [...]`) while every other JSON view uses atom-keyed maps
**Concern:** Duplication / inconsistency
**Scope:** `lib/grappa_web/controllers/members_json.ex`, `lib/grappa_web/controllers/archive_json.ex`
**Problem:** `MembersJSON` and `ArchiveJSON` both wrap their lists in stringified-key envelopes (`%{"members" => ...}`, `%{"archive" => ...}`) AND build per-row maps with stringified keys, while every other JSON view uses atom-keyed maps that Jason converts. Two different idioms within the same controller layer. Cic doesn't care (Jason renders both identically) but the inconsistency means the next contributor copies whichever they read first. Not a wire bug; a maintenance smell.

**Recommendation:** Pick one (atom-keyed; matches every other Wire and JSON site). MembersJSON moves through a `Members.Wire` (per A5).

### A16. The IRC parser path in `Grappa.IRC.Parser` is single-source — confirmed, but Phase 6 listener facade will need it as a service module
**Concern:** Duplication (forward-looking)
**Scope:** `lib/grappa/irc/parser.ex` (production), `test/support/irc_server.ex` (in-process fake)
**Problem:** No current duplication; `Grappa.IRC.Parser` is the sole framing module per CLAUDE.md. The test-side `IRCServer` wraps `:gen_tcp` correctly without re-implementing parsing (it's a transport fake, not a parser fake). **Confirmation only — no finding.** Flagging because Phase 6 IRCv3 listener facade will need to expose Parser as a public service module (currently exports are tight). Document as a forward-compat note when the listener cluster opens; not a current architectural debt.

---

## Summary

**8 HIGH, 5 MEDIUM, 5 LOW = 18 findings (3 cross-references — A12, A14 fold into A3; A16 is a confirmation not a finding; A9 was already filed in the 2026-05-03 review).**

**Net new findings: 14.**

**Headline themes:**

1. **Wire-shape policy is half-applied.** CP15 B6's wire-module discipline only covered 2 contexts (`Scrollback.Wire`, `QueryWindows.Wire`). The CP15 cluster ITSELF added 9 inline event payloads (3 window-state events at A1; 3 cached-state events at A5; the query_windows_list envelope at A6) without extracting them to Wire modules. The 3 events that have BOTH a broadcast and a snapshot path (joined / join_failed / kicked, plus the 3 in A5) hand-mirror the shape across the two sites, exactly the pattern B6 fixed for query_windows. The Wire-module policy is a best-practice that needs to land everywhere — the cluster that introduced the policy left half its own surface unmigrated (CLAUDE.md "Total consistency or nothing").

2. **No server↔client wire-shape source of truth.** A2 is the structural finding: all 7 inline-event-shapes plus all `*.Wire` modules have hand-typed counterparts in `cicchetto/src/lib/api.ts` + `subscribe.ts:WireEvent`. The 2026-05-03 codebase review's M-arch-3 named this as the Phase 5 codegen target; the surface has grown ~30% since then (CP15 added 7 new inline event types; T32 about to add more). Forward-fix path: extract every server-side inline broadcaster to Wire (closes A1, A5, A6, A4); then the codegen story has a target.

3. **cicchetto store boilerplate is a factory-shaped extraction (A3).** Smallest, highest-ROI cleanup: 7+ stores all repeat the same 6-line `createRoot + on(token) reset` block where the cross-tenant invariant lives. One factory closes 7 sites and pins the security boundary.

4. **Visitor wire shape is missing entirely (A4).** Highest-priority security-adjacent finding. Visitor has the same "Cloak-decrypted plaintext password in struct" hazard `Networks.Wire` defends against, but no Wire module — two controllers hand-roll the wire shape inline. Folds with A8 into a `Subject.Wire` shape.

5. **The CP15 cluster's own retrospective predicted A1.** B6 found `query_windows_list` hand-mirrored. The B3 commit that introduced the same hand-mirroring for window-state events landed one bucket earlier, was never re-audited under the lesson the same cluster learned. This is the meta-finding worth flagging to the orchestrator: per-bucket cleanup didn't loop back over the cluster's own preceding buckets.

**Suggested ordering when remediation cluster opens:**
- A4 first (security-adjacent, smallest surface — one Wire module, two controllers).
- A1 + A5 + A6 next (extract `Grappa.Session.Wire` covering all inline event shapes including the snapshot-pusher pairs; closes the prose-pinned correctness contract everywhere on the server).
- A3 in parallel (cic factory; isolates by language).
- A7 + A10 once A1/A5 are in (cic-side dispatch + projection cleanup; the type-level enforcement becomes possible once the server union is stable).
- A2 (codegen story) lands as a Phase 5 cluster — depends on A1+A5+A6 closing first.
- A8 (Subject.Wire union) folds into A4's commit if scope permits, else as a follow-on.
- A9 (captcha duplication) ships in the existing T31 follow-up cleanup cluster (already triaged 2026-05-03).
- A11 (DM detection rule) is a small follow-up; cic reads `dm_with` directly.

Reviewer is HALT'd here. Awaiting orchestrator/vjt direction on cluster ordering vs other concern reviews from this round.

---

# dependency/

# Architecture review — Dependency architecture (2026-05-08)

**Concern:** Dependency direction (web → contexts → schemas; cicchetto components
→ `lib/*.ts` stores → `api.ts` + `socket.ts`), import cycles, hidden coupling
via `Application.put_env` (server) / module-level mutable state (client),
supervision-tree ordering invariants. Last codebase review: 2026-05-03.

**Method:** Walked every `use Boundary` annotation in `lib/`, every `alias
Grappa.*` declaration, every `import` in `cicchetto/src/**/*.{ts,tsx}`, the
`application.ex` supervision tree, and the `Application.{get,put,fetch}_env`
call graph. Zero CRITICAL. Findings cluster on (a) **CLAUDE.md drift** —
authoritative docs describe a 6-child tree that has expanded to 11 children
without update; (b) **client-side state-origination** — `compose.ts` originates
window state in violation of the invariant `cicchetto NEVER originates state`
that CLAUDE.md was JUST extended (CP15 B7) to make explicit; (c) **boundary
exports that don't constrain** — `Session` exports `Server`, but no caller
outside the Session boundary actually invokes `Session.Server.*` functions —
only the facade — so the export grants reach that no producer needs.

The HIGH from 2026-05-03 (H1: `Application.get_env` runtime reads in Admission
+ FallbackController) HAS been remediated — `Grappa.Admission.Config.boot/0` is
the boot-time injection point now called from `Application.start/2:27`. Captcha
modules + FallbackController consume the resolved struct. Confirmed by grep:
zero `Application.get_env` reads at runtime outside the documented exception
(`:start_bootstrap` in `application.ex:121`) + the `Config.boot/0` site itself.

---

## HIGH

### A1. `compose.ts` originates window state — CLAUDE.md "cic NEVER originates state" violation

**Concern:** Dependency architecture (hidden coupling via client-side
parallel state machine)
**Scope:**
- `cicchetto/src/lib/compose.ts:30` (`import { setPending } from "./windowState"`)
- `cicchetto/src/lib/compose.ts:200-210` (the `case "join":` branch calls
  `setPending(channelKey(networkSlug, cmd.channel))` after `postJoin`
  resolves)
- `cicchetto/src/lib/subscribe.ts:399-435` (a "pending-channel pre-subscribe
  loop" `createEffect` reads `windowStateByChannel()` to find `state ===
  "pending"` keys client-originated in `compose.ts` and pre-joins the
  per-channel WS topic before the server-side `joined` event arrives)
- CLAUDE.md lines 53-69 (the Window-state-on-server invariant —
  freshly tightened in CP15 B7 commit `6c60ffe`)

**Problem:** CLAUDE.md is unambiguous: *"Window state model lives on the
server. … cic NEVER originates state — no optimistic STATE assumptions, no
parallel client-side state machine. Adding a new state (e.g. SASL-gated
`:locked`) requires server changes; cic just mirrors."* The five documented
states are `:pending | :joined | :failed | :kicked | :parked`.

`compose.ts:210`'s `setPending(...)` call is exactly the optimistic state
assumption the invariant prohibits. The justification block in compose.ts
(comments lines 200-227) acknowledges the design tension but argues the
client must set `:pending` synchronously so subscribe.ts's pre-subscribe loop
fires before the server's typed event arrives, otherwise Phoenix PubSub
drops the typed JOIN broadcast on the floor (no replay to late subscribers).
The DESIGN_NOTES line 2069-2071 entry confirms this is a known race fix.

The fix is *correct* — it solves a real Phoenix-PubSub late-subscriber
race. The structure is *wrong* — it solves the race by introducing exactly
the parallel client-state machine the invariant outlaws. Cic now owns one
state value (`:pending`) that the server never emits, and ASKS the server
to confirm it via the next event. That IS originating state.

**Impact:**
- The CLAUDE.md invariant the orchestrator just added is violated by the
  same cluster (CP15 B5) that motivated the invariant. The principle has
  zero deterrent power going forward — next contributor cites compose.ts
  as precedent for "yeah, optimistic state IS allowed, see the join case."
- Adding a new state (the invariant's own example: SASL-gated `:locked`)
  requires deciding whether cic also needs an optimistic-locked path.
  The invariant says no; the code says yes-for-pending.
- Test coverage of the pre-subscribe loop (`subscribe.test.ts:866`,
  `1902`) hardcodes the optimistic-pending behavior — pinning the
  violation as "intentional" makes future cleanup harder.

**Recommendation:** Move `:pending` origination to the server. Two
shapes are credible:

1. **Server emits `:pending` on JOIN dispatch.** `Session.send_join/3`
   already records the in-flight join in `state.in_flight_joins`
   (CP15 B2 evidence). Have it ALSO write
   `state.window_states[ch] = :pending` and broadcast `kind: "pending"`
   on the per-channel topic at the moment the JOIN command is enqueued.
   `compose.ts` drops `setPending` entirely; subscribe.ts's
   pre-subscribe loop disappears (the topic-join sequence becomes
   reactive on the typed event, not on a client-fabricated state). The
   late-subscriber race vanishes because the per-channel topic is now
   joined AFTER the topic-join completes successfully — there's no
   "before the topic exists, listen for events on it" scheme.
2. **Push topic-join into the WS layer.** Move the topic-join verb
   from subscribe.ts's reactive loop into a synchronous server-side
   ack: REST `POST /channels` returns the topic to subscribe to, cic
   joins it before the response resolves. Server then fires the
   `joined` event after upstream confirms.

Shape 1 is closer to the existing infrastructure and doesn't require a
new REST contract. Either shape lets compose.ts drop the windowState
import entirely, restoring "cic mirrors, never originates."

If the invariant is *intended* to allow optimistic-pending as a
documented exception, then CLAUDE.md needs a carve-out:
*"`:pending` is the only state cic may originate. All other states
must originate server-side."* — and a test that pins the carve-out so
future contributors don't infer the broader pattern.

---

### A2. CLAUDE.md supervision tree is 5 children stale — doc-vs-code drift

**Concern:** Dependency architecture (supervision-tree ordering invariants
that are load-bearing but not documented in the authoritative file)
**Scope:**
- `CLAUDE.md` lines 17-27 (the canonical 6-child tree)
- `lib/grappa/application.ex:32-110` (the actual 11-child tree)

**Problem:** CLAUDE.md authoritatively documents:

```
Grappa.Application
├── Grappa.Repo
├── Phoenix.PubSub (name: Grappa.PubSub)
├── Registry (name: Grappa.SessionRegistry)
├── DynamicSupervisor (name: Grappa.SessionSupervisor)
├── GrappaWeb.Endpoint
└── Grappa.Bootstrap
```

The actual tree in `application.ex` has **11 children** in this order:

```
0. Grappa.Admission.Config.boot/0   (manual call before children — boot-time put_env)
1. Grappa.Vault                     (BEFORE Repo — Cloak Ecto types need it at schema load)
2. Grappa.Repo
3. {Phoenix.PubSub, name: Grappa.PubSub}
4. {Registry, ..., name: Grappa.SessionRegistry}
5. Grappa.Session.Backoff           (ETS table for per-(subject,network) reconnect)
6. Grappa.WSPresence                (live-ws presence for auto-away)
7. Grappa.Admission.NetworkCircuit  (circuit-breaker ETS GenServer)
8. {DynamicSupervisor, ..., max_restarts: 10_000, max_seconds: 60}
9. GrappaWeb.Endpoint
10. Grappa.Visitors.Reaper          (after Endpoint, by intent — comment in src)
11. Grappa.Bootstrap                (conditional on :start_bootstrap)
```

CLAUDE.md self-describes as the rules document the human "will want
enforced six months from now without re-explaining" (line 1015). Five
children — **Vault, Backoff, WSPresence, NetworkCircuit, Reaper** — plus
the `Admission.Config.boot/0` pre-children call are completely absent.
Each one has load-bearing ordering encoded only in `application.ex`
inline comments. CLAUDE.md "Architecture" section's stale tree IS the
violation per the section's own rule:

> Don't touch supervision tree ordering casually. Ordering matters
> (PubSub before Endpoint, Repo before sessions). Document the WHY in a
> comment if you change it.

The comment is in `application.ex`, but the architecture section CLAUDE.md
points humans to is wrong — and CLAUDE.md is the file every session reads
on `/start`. Six months from now, a contributor will look at CLAUDE.md,
see 6 children, and edit `application.ex` thinking the 5 extra are
incidental.

**Impact:**
- New session boot:s the documented tree, not the actual tree. Designs
  that assume 6 children (the ones in CLAUDE.md) drift silently.
- The Vault-before-Repo invariant is genuinely load-bearing — Cloak's
  `Grappa.EncryptedBinary` Ecto type calls into Vault at schema dump/load
  time. A session reading the docs would not know that and could
  reorder.
- The `Admission.Config.boot/0` boot-time call is THE remediation for
  H1 from the 2026-05-03 review (5 runtime `Application.get_env`
  reads collapsed to one boot-time read). It's invisible in CLAUDE.md.
  Next contributor adding a new context with similar config needs may
  add another runtime read because the boot-time pattern isn't
  surfaced where they'll look.
- The 2026-05-03 H1 **architectural countermeasure** (M-arch-6 from
  that review: "introduce `Grappa.Bootstrap.preflight/0` walking the
  captcha config + asserting required env vars") is still untaken — and
  the CLAUDE.md architecture section is exactly where its existence
  would be most discoverable.

**Recommendation:** Update CLAUDE.md `## Architecture` section to mirror
`application.ex` reality. Three additions, all surface-level:

1. List the 11 children with one-liner WHY per child (the same WHYs
   already in `application.ex` comments). Don't duplicate the prose —
   point at `application.ex` for the full rationale.
2. Add the `Admission.Config.boot/0` pre-children call to the diagram
   as a `[boot]` step with one-liner: "captcha config injection;
   the only documented exception to the runtime-`Application.get_env`
   ban on the read side, mirror-symmetric with `:start_bootstrap`."
3. Keep the existing key-invariants block; add three lines:
   - **Vault before Repo** — Cloak Ecto types crash on `:noproc` at
     schema load otherwise.
   - **`Admission.NetworkCircuit` + `Session.Backoff` before
     `SessionSupervisor`** — ETS reads from the supervised children's
     start path require the table to exist.
   - **`Reaper` after `Endpoint`** — the public-surface-visible
     visitor invariant.

---

## MEDIUM

### A3. `Session` boundary exports `Server` but no caller outside Session uses it

**Concern:** Dependency architecture (Boundary annotations that allow
everything are no-ops; export grants reach producers don't need)
**Scope:**
- `lib/grappa/session.ex:exports: [Backoff, Server]`
- All cross-boundary references to `Session.Server` (grep — see below)

**Problem:** `Session`'s Boundary annotation exports `Backoff` and
`Server`. The `Backoff` export is genuinely consumed cross-boundary
(`networks_controller.ex:52`, `bootstrap.ex:145`, `visitors/login.ex:64`
all alias `Session.Backoff` and call `Backoff.reset/2` etc.). The
`Server` export is NOT — every cross-boundary reference is
docstring/comment text only:

- `members_controller.ex:5` — moduledoc comment
- `bootstrap.ex:111` — moduledoc comment
- `networks.ex:332` — moduledoc reference
- `networks/credential.ex:299` — moduledoc reference
- `networks_controller.ex` — uses `Session.*` facade (no `.Server.*`)

Real callers go through the `Grappa.Session.*` facade
(`Session.start_session/3`, `Session.stop_session/2`,
`Session.send_*/n`, `Session.list_members/3`, etc.). The `Server`
export grants reach (any boundary that lists `Grappa.Session` in
deps can suddenly call `Session.Server.handle_terminal_failure/2`)
that no producer asks for.

**Impact:**
- The Boundary annotation lies about the contract. `Server` LOOKS
  like a public API surface; tests, future contributors, and code
  review can't tell from the annotation that the facade is the only
  blessed path. Boundary checks pass, the architectural intent
  silently rots.
- `Server` exposing means a future call site reaching `Session.Server.cast(pid,
  :something)` won't be flagged at compile time — it'll just work,
  and the GenServer's mailbox contract becomes the implicit public
  API.
- The 2026-05-03 review's M-arch-3 ("six new admission error atoms
  have no `@type` union") is the same shape of problem one boundary
  over — exposing implementation details that the facade's `@spec`
  could constrain.

**Recommendation:** Drop `Server` from `exports`. Move it to internal
within Session boundary (it remains a callable from the Session
facade and from other Session.* siblings). Verify with `mix
compile --warnings-as-errors` after removing — Boundary will surface
any genuine cross-boundary call site (which then gets a facade
function, not the export). Same audit pass for the other top-level
contexts: `Grappa.Visitors`, `Grappa.Networks`, `Grappa.Accounts` —
each lists exports the umbrella context owns; verify each is
genuinely consumed.

### A4. `Sidebar.tsx` reaches past the store layer into `api.postPart`

**Concern:** Dependency architecture (cicchetto components → `lib/*.ts`
stores → `api.ts` + `socket.ts`)
**Scope:**
- `cicchetto/src/Sidebar.tsx:1` (`import { postPart } from "./lib/api"`)
- `cicchetto/src/lib/compose.ts:198-227` (the `case "part":` branch
  calls `postPart` THROUGH the slash-command store layer)

**Problem:** The architectural rule (per `docs/reviewing.md` §2 +
CLAUDE.md "channels are not a separate state model from REST") is
that components consume stores, stores call `api.ts` + `socket.ts`.
`Sidebar.tsx` violates this for one verb: clicking the × on a
sidebar entry calls `postPart` directly, bypassing the
`compose.ts` slash-command pipeline that handles the same verb when
typed as `/part`. Two paths to the same domain action:

- `compose.ts` `case "part":` → optimistic state, optional channel
  selection, post-success scrollback retention semantics
- `Sidebar.tsx` × button → `postPart` directly, no shared shape

Other components consume `api.ts` only for **types and pure helpers**
(`displayNick`, `ApiError`, `ScrollbackMessage`) — those are leaf
exports that legitimately cross the boundary. `postPart` is a verb,
not a leaf — and it has a sibling (compose.ts) that already wraps it
with the documented invariants.

**Impact:**
- The two PART paths can drift. If compose.ts gains "remove window
  from sidebar after PART succeeds" logic, the sidebar × button
  doesn't get it — same domain action, different UX.
- The Window-state-on-server invariant (CLAUDE.md lines 53-69) is
  partially observable here: A1's optimistic-pending hack relies
  on every channel mutation going through compose.ts; the sidebar
  × button skips that path entirely. Low-impact today (PART doesn't
  set state to `:pending`) but the structural debt is the same as
  A1 — two state-mutation entry points instead of one.
- New verbs (close-window-with-archival, kick-and-ban, etc.) will
  be added either via slash command OR via UI button; right now
  there's no convention forcing them to share a code path. The
  sidebar × button is the precedent for the wrong choice.

**Recommendation:** Extract a `partChannel(networkSlug, channel)`
verb in `compose.ts` (or a new `lib/channels.ts` store) that wraps
`api.postPart` + the post-success cleanup. Sidebar.tsx imports the
verb, not `api.postPart`. Audit the other UI buttons on similar
shape: the join-button-in-newchannel form, the topic-edit modal,
etc. — each should consume the store verb, not `api.*` directly.
Pure-helper imports (`displayNick`, `ApiError` type, `ScrollbackMessage`
type) stay legitimate.

### A5. Two `SessionPlan` modules in two namespaces — name collision waiting

**Concern:** Dependency architecture (parallel structures that drift)
**Scope:**
- `lib/grappa/networks/session_plan.ex` (`Grappa.Networks.SessionPlan`)
- `lib/grappa/visitors/session_plan.ex` (`Grappa.Visitors.SessionPlan`)
- `lib/grappa/bootstrap.ex:148-149` (`alias Grappa.Networks.SessionPlan;
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan`)
- `lib/grappa_web/controllers/networks_controller.ex:51` (`alias
  Grappa.Networks.{Credential, Credentials, SessionPlan}`)

**Problem:** `Networks.SessionPlan` and `Visitors.SessionPlan` are
intentional mirrors — both produce a `Session.start_opts/0` map; one
keys on `%Credential{}` (user-side), one keys on `%Visitor{}`
(visitor-side). The `Visitors.SessionPlan` moduledoc explicitly
calls out the mirror: *"Mirror of `Grappa.Networks.SessionPlan` for
visitor-row input."*

The mirror pattern is OK per CLAUDE.md "Implement once, reuse
everywhere"… *only as long as the two implementations stay
synchronized*. Today they don't share code — `build_plan/4` is
duplicated, the `:no_server` rescue is duplicated, the `Repo.preload`
shape is duplicated, and both modules independently know the
`Session.start_opts` map shape. A field added to `start_opts` (e.g.
the cluster's pending TLS-config keyword) requires editing both.

The `bootstrap.ex` alias dance — aliasing one as `SessionPlan` and the
other as `VisitorSessionPlan` — is the readability tell that the
domain boundary is sitting in the wrong place. Bootstrap's caller code
already discriminates on `{:user, _}` vs `{:visitor, _}`; the plan
resolver should be ONE module taking the discriminated subject.

**Impact:**
- Current 2026-05-03 review's M-arch-5 ("`Admission.capacity_input`
  carries `subject_kind` + `subject_id` as parallel fields, not
  `subject :: {:user, id} | {:visitor, id}`") is the same shape of
  problem at the input-data layer. Same cluster of tech debt.
- A future field — e.g. an `auto_join` list passed at session start —
  added to `Networks.SessionPlan.build_plan/4` but forgotten in
  `Visitors.SessionPlan.build_plan/4` will silently fail for visitors
  only. No compile-time error.
- Boundary annotations don't enforce mirror-keeping — both modules
  pass independently.

**Recommendation:** Extract a `Grappa.Session.PlanBuilder` (or
`Grappa.Session.OptsBuilder`) that takes a discriminated input —
either `{:credential, %Credential{}}` or `{:visitor, %Visitor{}}` —
and returns `{:ok, start_opts} | {:error, reason}`. Both context-
specific resolvers collapse to thin wrappers that look up
the side data (network preload for visitor, user lookup for
credential) then delegate.

Alternative shape if the per-context resolution is too divergent:
introduce a `@behaviour Grappa.Session.PlanResolver` with `resolve/1`
+ `@type input :: ...` + `@type error :: ...`, and let each context
implement it. The behaviour pins the shared shape so a new field is
caught by Dialyxir at the implementor sites.

### A6. `Networks.Credentials.unbind_credential/2` orchestrates Session AND Scrollback — Networks reaches across two siblings

**Concern:** Dependency architecture (one verb spans three contexts)
**Scope:**
- `lib/grappa/networks/credentials.ex:46` (`alias Grappa.{Scrollback, Session}`)
- `lib/grappa/networks/credentials.ex:155-200` (the `unbind_credential/2`
  body: calls `Session.stop_session/2`, then transactionally checks
  `Scrollback.has_messages_for_network?/1`, then deletes the credential,
  then optionally cascades to the network row + servers FK)
- `lib/grappa/networks.ex:9-13` (Boundary deps include both
  `Grappa.Scrollback` AND `Grappa.Session`)

**Problem:** `unbind_credential/2` is the canonical mux: one operator-
visible verb (mix grappa.unbind_network) drives orchestration across
three contexts. The current shape has Networks owning the orchestration:

```
Credentials.unbind_credential
  → Session.stop_session       (terminate live GenServer)
  → Repo.transaction
    → Scrollback.has_messages_for_network?  (gate)
    → Repo.delete(credential)
    → maybe_cascade_network    (delete network row + cascade)
```

The Networks Boundary therefore deps on Scrollback AND Session. That's
fine *if Networks is the orchestrator*. The moduledoc justifies it
as "credential concerns — including the `Session.stop_session/2` ↔
`Scrollback.has_messages_for_network?/1` orchestration that drives
`unbind_credential/2` — live here so the Phase 5 credential REST
surface and audit-logging hooks land in one cohesive module."

The structural smell: this is the ONLY place in the codebase where one
context drives a multi-context teardown ordering. Symmetric verbs that
will land in Phase 5 — Visitor reaping that orchestrates session stop
+ scrollback purge, network-disconnect that touches credential state +
session state — will face the same question: which context owns the
orchestration?

Today the answer is implicit. Networks does it because credential is
the persistent root. But *visitor-disconnect* will need similar
orchestration, and Visitors → Networks → Session → Scrollback chains
get long fast. The choice is undocumented.

**Impact:**
- Future orchestrator (visitor-reaper, network-rotation, multi-network
  bulk operations) lacks a precedent shape. Each will pick its own —
  drift by the third one.
- The Networks Boundary deps list grows to include every leaf its
  orchestrations touch, eroding what Boundary actually constrains.
  Today: `Accounts, EncryptedBinary, IRC, PubSub, Repo, Scrollback,
  Session, Vault` — seven. Adding cross-cutting verbs grows this
  monotonically.
- The orchestration is pattern is invisible to anyone reading
  `Grappa.Networks.unbind_network/2` — the entry point looks like a
  simple credential delete. The reach is in the helper.

**Recommendation:** Two paths, pick one and document it:

1. **Lift orchestration to a sibling `Grappa.Lifecycle` (or
   `Grappa.Operations`) context.** `Lifecycle.unbind_credential/2`
   owns the cross-context teardown; `Networks.Credentials` shrinks
   to pure credential CRUD; `Lifecycle` deps on
   `[Networks, Scrollback, Session]`. Visitor-reaper, network-
   rotation, etc. land here too. Networks's deps shrink back to
   `[Accounts, EncryptedBinary, IRC, PubSub, Repo, Vault]`.
2. **Document the rule "the context owning the persistent root
   owns the cross-context teardown."** Add a short paragraph to
   CLAUDE.md `## Engineering Standards > Code-shape rules`. Future
   visitor-reaper goes in Visitors; network-rotation goes in
   Networks; etc. Consistent, but each context's deps list grows
   over time.

The trajectory hint is the 2026-05-03 review's M-arch-2 (NetworkCircuit
+ Backoff overlap) and the existing `Grappa.RateLimit.JitteredCooldown`
extraction — the codebase IS already extracting cross-cutting concerns
into named siblings. Path 1 is the consistent next step.

---

## LOW

### A7. `bootstrap.ex` aliases two `SessionPlan` modules — consider an alternative

**Concern:** Dependency architecture (alias-rename smell)
**Scope:** `lib/grappa/bootstrap.ex:148-149`
**Problem:** `alias Grappa.Networks.SessionPlan` + `alias
Grappa.Visitors.SessionPlan, as: VisitorSessionPlan` is the
classic "two modules with the same final segment" workaround.
Folded into A5's recommendation; flagged separately as the
visible day-to-day symptom.
**Impact:** Cosmetic until A5 lands. Low.
**Recommendation:** Resolve via A5.

### A8. `Visitors.Reaper` is its own top-level boundary — could be inside Visitors

**Concern:** Dependency architecture (boundary granularity)
**Scope:** `lib/grappa/visitors/reaper.ex:5` (`use Boundary,
top_level?: true, deps: [Grappa.Visitors]`); `lib/grappa/visitors.ex`
exports list excludes `Reaper`.
**Problem:** Reaper is a `:permanent` GenServer that calls into
`Visitors` (one dep). It's its own top-level boundary, sibling of
`Visitors`, rather than a child. Sound rationale (the supervision
tree treats Reaper as infrastructure, not as a Visitors
internal). But the same shape applies to other GenServer children
(`Backoff`, `NetworkCircuit`, `Vault`) which are NOT top-level.
The convention is inconsistent: Backoff is `Session.Backoff`
inside the Session boundary (exported); NetworkCircuit is
`Admission.NetworkCircuit` inside the Admission boundary
(exported). Reaper is `Visitors.Reaper` BUT separate boundary.
**Impact:** Boundary-shape inconsistency. Reading `mix boundary`
output, Reaper looks like a peer of Visitors when it's actually
a satellite that depends on Visitors only.
**Recommendation:** Either (a) move Reaper inside the Visitors
boundary and add it to exports (matching Backoff/NetworkCircuit
shape), or (b) elevate Backoff + NetworkCircuit to top-level
boundaries (matching Reaper). Pick one convention; the consistency
is what matters.

### A9. `Admission` boundary uses `dirty_xrefs` for `Visitors.Visitor` schema-only access — pattern mirroring `Accounts`

**Concern:** Dependency architecture (cycle-breaking via dirty_xref)
**Scope:** `lib/grappa/admission.ex:7-12`; `lib/grappa/accounts.ex:11-15`;
`lib/grappa/scrollback.ex:9-21` (mirror cases)
**Problem:** Three top-level boundaries (`Admission`, `Accounts`,
`Scrollback`) declare `dirty_xrefs: [Grappa.Visitors.Visitor]`
to permit schema-only access without listing `Visitors` as a
dep — each justified to break a cycle with `Visitors`. The
pattern is documented in each moduledoc; the workaround is
honest. The structural cost — three boundaries silently lose
Boundary's checks on `%Visitor{}` field access — is intentional.

The risk: a future contributor adding a fourth dirty_xref site
won't know it's a pattern (each comment justifies its own case
ad-hoc). And the underlying cycle is Visitors → Networks; the
moment Visitors needs to call Accounts or Scrollback or Admission
*for real* (not just struct access), the cycle resurfaces and a
4th dirty_xref isn't the answer.
**Impact:** Pattern-rot — three sites today, no documented
limit, no cluster-level pin in `docs/DESIGN_NOTES.md` saying
"if you find yourself adding a 4th, redesign Visitors instead."
**Recommendation:** Add a one-paragraph entry to
`docs/DESIGN_NOTES.md` (or a `## Boundary patterns` section in
CLAUDE.md) that catalogs the three existing dirty_xref sites,
states the underlying Visitors → Networks cycle as the root cause,
and pre-commits the rule "a 4th dirty_xref site is the trigger
for fixing the cycle, not for adding the workaround." Optional:
a `mix boundary` follow-up Credo check or test that fails when
a 4th `dirty_xrefs:` directive appears in the codebase.

### A10. CLAUDE.md doesn't document the `Wire` module convention as a Boundary export pattern

**Concern:** Dependency architecture (extension pattern)
**Scope:** `lib/grappa/scrollback/wire.ex`,
`lib/grappa/networks/wire.ex`, `lib/grappa/accounts/wire.ex`,
`lib/grappa/query_windows/wire.ex` (four `Wire` modules); each
context exports `Wire` in its Boundary annotation; CLAUDE.md
key-invariants block describes Wire conversion as "per-context
responsibility" but doesn't pin the shape.
**Problem:** Four contexts have a `Wire` submodule, exported by
the boundary, called by both `GrappaWeb.*JSON` modules and
PubSub broadcasters in the same context. The pattern is the
same in every case — but it's documented as "per-context
responsibility" without specifying the module shape, so context
#5 (e.g. UserSettings doesn't have a Wire module today; Mentions
doesn't either) won't necessarily follow the convention.
The Mentions context, for instance, returns `%Scrollback.Message{}`
to its REST consumer — no Wire layer, no JSON encoding contract.
That works today (Scrollback's Wire handles it transitively) but
breaks the moment Mentions needs a Mentions-specific wire shape.
**Impact:** New contexts may or may not get a Wire module. Wire
shape consistency is verified by tests + reviewer attention,
not by structural convention.
**Recommendation:** Add a one-paragraph CLAUDE.md note under
"Phoenix / Ecto patterns": *"Each context with a public WS or
REST surface owns a `<Context>.Wire` submodule, exported via
the Boundary annotation, that converts schemas to JSON-encodable
maps. PubSub broadcasts MUST go through it. REST JSON views in
`GrappaWeb.<X>JSON` consume the Wire output as their input."*
That pins the shape so context #5 doesn't get to choose.

---

# type-system/

# Architecture Review — Type-System Leverage (2026-05-08)

**Concern:** Atoms/typed-literals over untyped strings on the server (CLAUDE.md
"never untyped strings"); structs over maps; custom Ecto types over `:map`;
branded TS types over bare `string`; exhaustive switches over closed unions;
`@spec` discipline; `unknown + narrow` over `any`.

**Method:** Walked every wire-emitting site (`lib/grappa/**/wire.ex`,
controllers, channel pushes, `Session.Server` broadcast arms),
every Ecto schema, the Dialyxir config, the cicchetto `tsconfig.json`,
and the cic store / subscribe / api modules. Cross-checked
`MessageKind` / `WindowState` / `ChannelKey` propagation. Ignored items
already filed in the 2026-05-03 review and the CP15 todo follow-ups.

**Headline:** No CRITICAL gaps. Foundation is strong — `MessageKind`
exhaustiveness pinned in `ScrollbackPane` + `members.ts` via `never`
checks, `ChannelKey` brand widely used (60 callsite imports), `Meta`
custom Ecto type is the project reference for closed-key maps,
`Grappa.ClientId` custom type already supersedes the prior `:string`
finding, Dialyxir `:underspecs` flag is on (mix.exs:37). The remaining
findings cluster into **two themes**:

1. **Wire-event `kind` is an untyped string at the broadcast boundary**
   (server emits `kind: "joined"` etc. with no shared atom enum or
   `@type wire_event_kind`; cic mirrors via per-handler string literals).
   This is the single largest type-system gap and the same shape that
   compounded into the `MessageKind` cross-language drift theme called
   out in prior reviews.
2. **Atom-vs-string inconsistency between `Wire.message_payload/1`
   (`kind: :message`, atom) and every other broadcast site
   (`kind: "joined" | "join_failed" | "members_seeded" | ...`, string).**
   Cic already handles `kind === "message"` (atom round-trips to string
   via Jason) so there's no breakage TODAY, but the inconsistency is a
   trap for the next contributor + invisible to Dialyzer.

Severity: 0 CRITICAL, 2 HIGH, 5 MEDIUM, 4 LOW.

---

## HIGH

### A1. Wire-event `kind` is untyped string across broadcast surface — no shared enum, no `@type`, no `Wire` module-level contract

**Concern:** Type system leverage
**Scope:**
- `lib/grappa/session/server.ex:1614,1635,1652,1667,1697,1717,1795,1847`
  (broadcast call sites: `channels_changed`, `own_nick_changed`,
  `topic_changed`, `channel_modes_changed`, `members_seeded`, `joined`,
  `join_failed`, `kicked`)
- `lib/grappa/session/server.ex:1977,1986,1995` (snapshot payload
  `window_state_payload/3`)
- `lib/grappa_web/channels/grappa_channel.ex:709,725,748` (cold-resub
  snapshot pushes — `topic_changed`, `channel_modes_changed`,
  `members_seeded`)
- `lib/grappa/query_windows.ex:40,209` (`query_windows_list`)
- `cicchetto/src/lib/subscribe.ts:94-122` (`WireEvent` discriminated
  union — the cic-side mirror, hand-maintained)
- `cicchetto/src/lib/userTopic.ts:72-124` (`payload.kind` arms +
  `as string` casts on every payload field)

**Problem:** Every broadcast emits `kind: "<literal>"` as a bare string
at the construction site. There is NO `@type wire_event_kind ::
:joined | :join_failed | :kicked | :members_seeded | :topic_changed
| :channel_modes_changed | :channels_changed | :own_nick_changed
| :query_windows_list | :mentions_bundle | :away_confirmed | :message`
union anywhere on the server. The cic-side `WireEvent` union in
`subscribe.ts:94-122` is the closest thing to a contract, but it
covers only the per-channel topic — `userTopic.ts` carries a SECOND
hand-mirror (`channels_changed`, `query_windows_list`,
`mentions_bundle`, `away_confirmed`, `own_nick_changed`) with NO
discriminated union at all (`{kind?: string; [k: string]: unknown}`)
and `as string` / `as number` casts on every field.

This is the same drift theme the 2026-05-03 review flagged for
captcha provider tokens (M-arch-3). Adding a new `kind:` requires
edits in 3-5 sites that no compile error connects:

  1. Server emit site (string literal — Dialyzer can't catch a typo).
  2. cic per-channel `WireEvent` union OR cic `userTopic.ts`
     handler — depends on which topic.
  3. cic dispatch arm with the literal again.
  4. Snapshot push payload (if window-state shaped).
  5. Tests.

The new `:joined`/`:join_failed`/`:kicked` events landed in CP15
exemplify the cost: `window_state_payload/3` (server snapshot helper)
and the apply_effects arms emit duplicate string literals in 6 sites
(`server.ex:1717,1795,1847,1977,1986,1995`); the `:state` field
ALSO carries the literal `"joined" | "failed" | "kicked"` redundantly
with `kind:`, doubling the surface to keep in sync. The cic
`WindowState` type (`windowState.ts:29`) and the wire-shape `state:`
literal must stay byte-aligned by hand.

**Impact:** A typo in a broadcast `kind:` literal (`"join_failed"` vs
`"joinFailed"`) ships silently; cic's handler arm doesn't fire and
the window state silently fails to transition. Same class of bug as
the QueryWindows Jason crash CP15-B6 surfaced — invisible until a
real user-facing flow breaks. The cost compounds with each new
event kind.

**Recommendation:**
1. Define `@type wire_event_kind` in a single module (e.g.
   `Grappa.PubSub.Topic` or a new `Grappa.PubSub.Event`) enumerating
   every kind atom. Mirror Scrollback.Message's `@kinds` /
   `kinds/0` shape — closed list + accessor verb.
2. Server-side: emit `kind: :joined` (atom) — Jason round-trips to
   `"joined"` string for cic exactly like `MessageKind` already does
   in `Wire.to_json/1`. Move EVERY `kind: "literal"` site to the
   atom form. Dialyzer's `:underspecs` flag on the `broadcast_event`
   spec will then catch typos at compile time when the spec is
   tightened to `%{required(:kind) => wire_event_kind, ...}`.
3. cic-side: collapse `WireEvent` (`subscribe.ts`) and the ad-hoc
   `userTopic.ts` payload type into a single shared
   `WireEvent` union in `lib/wireEvents.ts`. Every dispatch site
   uses the union; the `default` arm asserts `never` (mirror of
   `ScrollbackPane`'s exhaustive switch). Remove every
   `payload.X as string` cast — narrow on `payload.kind` first,
   then access typed fields.
4. The `kind:` enum + payload shape effectively become a
   shared "wire IDL." This is the Phase 5 codegen target the
   2026-05-03 review trajectory already flagged (cicchetto wire-shape
   → server source); A1 is the concrete first step.

### A2. `Wire.message_payload/1` emits `kind: :message` (atom); every other broadcast emits `kind: "<string>"` — silent inconsistency

**Concern:** Type system leverage / total consistency or nothing
**Scope:**
- `lib/grappa/scrollback/wire.ex:48,87-89` — `kind: :message` atom
- `lib/grappa/session/server.ex:1697,1717,1795,1847` — `kind: "members_seeded"`,
  `"joined"`, `"join_failed"`, `"kicked"` strings
- `lib/grappa/query_windows.ex:209` — `kind: "query_windows_list"` string
- `lib/grappa_web/channels/grappa_channel.ex:709,725,748` — `kind:
  "topic_changed"`, etc. strings
- `cicchetto/src/lib/api.ts:147-149` — `ChannelEvent` declares `kind:
  "message"` (string); Jason atom→string at the wire keeps the cic
  type valid by accident

**Problem:** CLAUDE.md "Total consistency or nothing. Half-typed is
worse than untyped. Half-migrated creates two patterns — Claude
copies whichever is closer." `Wire.message_payload/1` is the
canonical wire builder for the most-trafficked event (every PRIVMSG)
and uses the atom-keyed shape; every event added since is a string
literal. The next contributor reading either side will copy whichever
pattern they encountered last.

The atom vs string distinction is invisible on the wire (Jason
serializes both to `"message"`) so there is NO test that pins which
shape is in flight. A renderer that reaches for `payload[:kind]`
on the server side (e.g. for telemetry, batch dedup, audit) finds
the atom in one event and the string in others. `@spec` on
`broadcast_event/2` (`lib/grappa/pubsub.ex:63`) is `%{} :: :ok` —
no payload-shape contract.

**Impact:** The inconsistency adds a hidden dependency on Jason's
atom-stringification behaviour (works today; would break if anyone
ever reaches for raw `Phoenix.PubSub.broadcast/3` — which would skip
the JSON edge entirely and deliver `:message` atom to any in-Elixir
subscriber, while the strings stay strings). Same root cause as the
CP15-B6 QueryWindows Jason crash: implicit serialization assumptions
that surface only at the WS edge. A1's `wire_event_kind` atom
enum subsumes this — pick the atom form (Jason handles it,
`MessageKind`'s `Wire.to_json/1` already proves the round-trip) and
migrate every `kind: "<string>"` to `kind: :<atom>` in lockstep.

**Recommendation:** Fold into A1's migration. ALL wire `kind:` values
become atoms drawn from the `@type wire_event_kind` enum. cic types
declare the string literal (post-Jason) as today; nothing on the cic
side changes. The fix is server-side only.

---

## MEDIUM

### A3. `:state` literal in window_state events duplicates `:kind` discriminator — two parallel enums encoding the same fact

**Concern:** Type system leverage / duplication
**Scope:** `lib/grappa/session/server.ex:1717-1721, 1795-1798, 1847-1849,
1977-1981, 1984-1992, 1995-2005` (event + snapshot payloads);
`cicchetto/src/lib/subscribe.ts:106-122` (`WireEvent.state`
discriminator); `cicchetto/src/lib/windowState.ts:29` (`WindowState`
type union)

**Problem:** Every window-state event payload carries BOTH `kind:
"joined" | "join_failed" | "kicked"` AND `state: "joined" | "failed"
| "kicked"`. The two are 1-1 redundant: `kind: "joined"` always
carries `state: "joined"`, `kind: "join_failed"` always
`state: "failed"`, `kind: "kicked"` always `state: "kicked"`. cic
ignores `state:` entirely (`subscribe.ts:271-282` dispatches on
`payload.kind` and immediately writes the literal `setJoined` /
`setFailed` / `setKicked` without referencing `payload.state`).

The `:parted` and `:pending` cases live at the same conceptual layer
but have NO `kind:` event — they project from absence and from a
separate cic-side `setPending` call respectively. Five window states,
three event `kind:` values, four `state:` strings on the wire (one
event-less). The drift surface keeps growing as states are added
(T32 `:parked` lays the typespec slot at `server.ex:187` but doesn't
yet broadcast).

**Impact:** Adding a SASL-gated `:locked` state, per the CLAUDE.md
window-state-on-server invariant, is a 4-site edit (server typespec
+ apply_effects arm + event payload `kind:` AND `state:` + cic
`WindowState` union). Two enums on the same domain fact double the
drift risk for nothing — `state:` adds zero information cic
consumes.

**Recommendation:** Drop the `state:` field from every window-state
event payload (event AND snapshot). cic dispatches on `kind:` alone
already; the field has no other consumer. `kind:` is the SOLE
discriminator, drawn from the A1 enum. Saves one layer of literal
duplication at every emit site.

### A4. `meta:` on `ScrollbackMessage` wire is `Record<string, unknown>` — cic re-narrows per-kind at every render site

**Concern:** Type system leverage / abstraction leakage
**Scope:**
- Server: `lib/grappa/scrollback/meta.ex:82` — `@type t :: %{optional(allowlist) => term()}` (atom-keyed allowlist on the server)
- Wire: `lib/grappa/scrollback/wire.ex:45` — `meta: Meta.t()` (typed)
- cic: `cicchetto/src/lib/api.ts:143` — `meta: Record<string, unknown>` (untyped)
- cic: `cicchetto/src/ScrollbackPane.tsx:301,309-310,325` (`typeof
  msg.meta.new_nick === "string"`, `Array.isArray(msg.meta.args)`,
  `typeof msg.meta.target === "string"`); `cicchetto/src/lib/members.ts:74,81,87-89`
  (same per-kind narrowing inline)

**Problem:** The server `Meta` custom Ecto type is the project
reference for closed-key maps — atom-keyed allowlist, normalized
on cast/load/dump, documented per-kind shape table. That entire
contract is THROWN AWAY at the wire boundary: cic gets
`Record<string, unknown>` and re-discovers the per-kind shape via
inline `typeof` / `Array.isArray` checks at every render and
presence-apply site. The per-kind shape table in
`scrollback/meta.ex:55-65` (privmsg → %{}, nick_change →
%{new_nick:}, mode → %{modes:, args:}, kick → %{target:}) is the
EXACT shape cic needs as a discriminated union, but cic re-derives
it inline with no compile-time guarantee.

This is a missed opportunity for the project's reference custom-type
pattern. If the server adds a meta key (e.g. CP15's
`%{numeric: int}` for the `:join_failed` notice), cic happily
ignores it because the type is `unknown` — the renderer doesn't
fail loudly, it just silently drops the field. The 2026-05-03
prior-review M-irc-3 ("Message.tags lookup helpers absent — typed
shape bypassed by callers") flagged the same shape for IRC tags.

**Impact:** Per-kind drift between server `Meta` allowlist + cic
render code is invisible to TypeScript. Same drift theme as A1 — the
list of meta keys the server may emit is ONE source on the server
(`@known_keys`) and N hand-mirror narrows in cic. CLAUDE.md
"implement once, reuse everywhere" violated at the wire boundary.

**Recommendation:** Define a per-`MessageKind` discriminated meta
type in `cicchetto/src/lib/api.ts`:

```ts
type MessageMeta =
  | { kind: "privmsg" | "notice" | "action" | "topic" | "join" | "part" | "quit"; meta: Record<string, never> }
  | { kind: "nick_change"; meta: { new_nick: string } }
  | { kind: "mode"; meta: { modes: string; args: string[] } }
  | { kind: "kick"; meta: { target: string } }
  ...
```

Or refactor `ScrollbackMessage` so `meta` is a `kind`-keyed
discriminated union. Either way, the renderer in `ScrollbackPane`
reads `msg.meta.new_nick` typed as `string` — no `typeof` ladder.
Drift becomes a compile error.

### A5. cic `WindowKind` allows `"server" | "list" | "mentions"` but server `Scrollback.target_kind/1` only emits `:channel | :query`

**Concern:** Type system leverage / wire-shape drift
**Scope:**
- `cicchetto/src/lib/windowKinds.ts:22` — `WindowKind = "channel" |
  "query" | "server" | "list" | "mentions"`
- `cicchetto/src/lib/api.ts:360` — `ArchiveEntry.kind: "channel" | "query"`
- `lib/grappa/scrollback.ex:269-273` — `target_kind/1 :: :channel | :query`
- `cicchetto/src/lib/selection.ts:51` — `SelectedChannel.kind: WindowKind`

**Problem:** Two parallel `WindowKind`-like enums with a strict
subset relationship encoded by hand. The server-side
`Scrollback.target_kind/1` emits ONLY `:channel | :query`
(archive entries are channels or DMs by definition; pseudo-windows
have no scrollback). The cic-side `WindowKind` extends to include
`"server" | "list" | "mentions"` because cicchetto's selection state
also tracks pseudo-windows that exist purely client-side. Two
overlapping closed sets with no shared source.

`ArchiveEntry.kind` is correctly typed as the narrow `"channel" |
"query"` — but the relationship to `WindowKind` is implicit. A new
window kind on cic (e.g. `"settings"` — there's already a settings
drawer) requires extending `WindowKind` AND remembering NOT to
extend `ArchiveEntry.kind` (or the server response would have to
filter at a layer that doesn't know about it).

**Impact:** Adding a new kind on either side risks subtle drift.
Today benign — `WindowKind` is only used in `SelectedChannel.kind`
and `Sidebar` ordering, both cic-only paths. The drift surfaces
when somebody tries to hoist `WindowKind` into a wire shape (e.g. a
future "window list" REST endpoint that mirrors the sidebar).

**Recommendation:** Split into `WireWindowKind = "channel" | "query"`
(server-emitted) and `ClientWindowKind = WireWindowKind | "server"
| "list" | "mentions"` (cic-extended). `ArchiveEntry.kind:
WireWindowKind`. `SelectedChannel.kind: ClientWindowKind`. The
subset relationship is then a TypeScript fact, not a memory item.

### A6. `Login.tsx::friendlyMessage` switches on `err.code: string` — closed admission-error union exists but isn't typed at the call site

**Concern:** Type system leverage / exhaustiveness
**Scope:**
- `cicchetto/src/Login.tsx:16-46` — `function friendlyMessage(err: ApiError): string` switches on `err.code: string`
- `cicchetto/src/lib/api.ts:31-37` — `AdmissionError` union (typed)
- `cicchetto/src/lib/api.ts:151-163` — `ApiError.code: string` (untyped)
- Server enum: `lib/grappa/admission.ex:66-71` —
  `@type error :: capacity_error() | Captcha.error()`

**Problem:** The server `Grappa.Admission` exposes a closed
`@type error` enum spanning every wire token a Login response can
return. The cic-side `AdmissionError` mirrors this as a typed
discriminated union. But `ApiError.code` is `string` (untyped) and
`friendlyMessage` switches on the bare string with a `default:`
arm returning `err.message`. Adding a 7th admission error atom
(server-side spec extension landed; cic AdmissionError extended;
`friendlyMessage` arm forgotten) ships silently — the new code
falls through to the default and the user sees the raw wire token.

This is the gap the 2026-05-03 review flagged as H4 (`captcha_required`
arm missing) — addressed for that one case but the structural
problem remains. Any future admission error ships the same way until
caught in user-facing testing.

**Impact:** Cross-language drift on the admission-error enum has no
compile-time guard on the cic side. The discriminated union exists
in `api.ts` but `friendlyMessage` doesn't consume the discriminant.

**Recommendation:** Re-shape `ApiError` so `code` is
`AdmissionErrorCode | "unauthorized" | "invalid_credentials" | string`
(branded, with the closed admission codes typed as a union) OR
expose a typed `friendlyAdmissionMessage(err: AdmissionError): string`
helper that switches on `err.error` (the discriminant) with a
`never` exhaustiveness arm. The `default:` arm in the current
implementation hides the gap; a `never` arm would make the next
extension a compile error.

### A7. `userTopic.ts` event handler uses `{kind?: string; [k: string]: unknown}` payload type — every field accessed via `as` cast

**Concern:** Type system leverage / `unknown + narrow` over `any`
**Scope:** `cicchetto/src/lib/userTopic.ts:72-124` (handler body),
`api.ts` (no payload union for these events)

**Problem:** The user-topic handler dispatches on `payload.kind`
checking 5 string literals (`channels_changed`, `query_windows_list`,
`mentions_bundle`, `away_confirmed`, `own_nick_changed`) and reads
typed fields via `as` casts (`payload.network as string`,
`payload.network_id as number`, `payload.away_started_at as string`,
etc. — 9 casts in this file). The payload type is the catch-all
`{kind?: string; [k: string]: unknown}`. There is no discriminated
union, no exhaustiveness check, no compile-time guard that the
fields the handler reads actually exist on the wire.

`subscribe.ts` does this RIGHT (the `WireEvent` discriminated union,
narrow on `payload.kind`, then access typed fields). userTopic.ts
predates the pattern (or wasn't migrated when subscribe.ts was) and
violates CLAUDE.md "total consistency or nothing."

**Impact:** Server-side rename of `payload.network_id` to
`payload.networkId` ships silently; cic's `as number` cast happily
returns `undefined`-as-number and the next math op produces `NaN`.
The bug shows up far from the cause. `as` casts are the cic-side
equivalent of the `Application.get_env runtime` rule — explicit
escape hatches that erode the typing discipline elsewhere.

**Recommendation:** Define `UserTopicEvent` discriminated union in
`api.ts` (or a new `lib/userTopicEvents.ts`) covering all 5 kinds.
Migrate the handler to switch on `payload.kind` with typed access
to `payload.network`, `payload.away_started_at`, etc. Drop every
`as` cast. This subsumes into A1's broader unification.

---

## LOW

### A8. `slashCommands.ts::parseNicksVerb` casts `verb as "op" | "deop" | "voice" | "devoice"` — bypasses exhaustiveness

**Concern:** Type system leverage
**Scope:** `cicchetto/src/lib/slashCommands.ts:97-101`

**Problem:** The helper takes a `verb: string` and narrows the
returned `kind` via `verb as "op" | "deop" | "voice" | "devoice"`.
The cast trusts the dispatch table to call the helper only for those
four verbs — true today, brittle tomorrow. A 5th verb added to the
dispatch table that re-uses `parseNicksVerb` would silently
mis-tag.

**Recommendation:** Take the verb as a typed parameter:
`function parseNicksVerb(verb: "op" | "deop" | "voice" | "devoice", rest: string): SlashCommand`.
Dispatch table call sites already know the literal — the `as` cast
moves to the dispatch-table key (closed) instead of the helper return
(open).

### A9. `slashCommands.ts::invite` and `mode` use `toks[0] as string` despite `noUncheckedIndexedAccess: true`

**Concern:** Type system leverage / `noUncheckedIndexedAccess` violation
**Scope:** `cicchetto/src/lib/slashCommands.ts:233,247-248`

**Problem:** `tsconfig.json` sets `noUncheckedIndexedAccess: true`.
That flag exists precisely to force the `string | undefined`
narrow at indexing. The handlers guard `toks.length === 0` /
`toks.length < 2` and then read `toks[0]` / `toks[1]` with an
`as string` cast to silence the flag.

The narrative `toks.length >= N` doesn't propagate to the type
system — TypeScript still sees `string | undefined`. The cast is
the workaround, but it's load-bearing on a mental model of the
guard rather than the type.

**Recommendation:** Use destructuring with default + length check,
or extract a typed helper:

```ts
const [a, b, ...rest] = toks;
if (a === undefined || b === undefined) return err(...);
return { kind: "mode", target: a, modes: b, params: rest };
```

`a` and `b` narrow to `string` after the explicit `undefined`
check — no cast needed. Same shape applies to `parseWatchlist`'s
`subverb = toks[0]` (which then short-circuits via implicit nullish
checks; less load-bearing but the same pattern would tighten it).

### A10. `members.ts` `applyPresenceEvent` casts `msg.meta.args.filter(...) as string[]` — `unknown` shouldn't need re-asserting

**Concern:** Type system leverage / `unknown + narrow`
**Scope:** `cicchetto/src/lib/members.ts:87-89`

**Problem:** `msg.meta.args` is `unknown` (per the `meta: Record<string,
unknown>` problem in A4). The filter `(a) => typeof a === "string"`
correctly narrows each element, but TypeScript can't propagate
the narrow through `Array.prototype.filter` without a user-defined
type predicate; the `as string[]` is the workaround.

Not a bug per se — `Array.isArray` already gates the branch. But it's
a symptom of A4: cic re-narrows the per-kind meta shape inline and
needs casts because `meta` is untyped at the API surface. Fixed
when A4's per-kind discriminated meta lands.

**Recommendation:** Type-predicate helper
`isStringArray(xs: unknown): xs is string[]` OR migrate to A4's
per-kind meta shape so `msg.meta.args` is already `string[]` at the
type level.

### A11. `Wire.message_payload/1` event type uses `kind: :message` atom but `Wire.to_json/1` returns the message as a separate map; consumers can't introspect via type

**Concern:** Type system leverage / `@spec` granularity
**Scope:** `lib/grappa/scrollback/wire.ex:37-48,86-89`,
`lib/grappa/pubsub.ex:63-68`

**Problem:** `broadcast_event/2`'s spec is
`@spec broadcast_event(String.t(), map()) :: :ok`. The `map()`
is the maximally weak shape. Phoenix's fastlane crashed at the WS
edge in CP15-B6 because a `%Window{}` struct landed where a
plain JSON-encodable map was expected — exactly the class of bug
the spec couldn't catch (a struct IS a map; Dialyzer sees `:ok`).

The `Wire.event/0` type (`%{kind: :message, message: t()}`) exists
but isn't referenced from `broadcast_event/2`'s spec. There's no
`@type broadcast_payload` union the function spec narrows to.

**Impact:** Adding a new context's broadcast (e.g.
`Grappa.QueryWindows.Wire.windows_map/0`) silently widens the wire
without any type-system signal — exactly what enabled the CP15-B6
crash. The wire-module pattern is sound; the `broadcast_event/2`
boundary is too loose.

**Recommendation:** Define `@type Grappa.PubSub.payload :: <union>`
gathering every wire module's broadcast type
(`Scrollback.Wire.event() | QueryWindows.Wire.windows_map() | ...`).
`broadcast_event/2`'s spec narrows to that union. Each new wire
module declares its payload type and gets added to the union — the
addition is a one-site edit in `lib/grappa/pubsub.ex`. Subsumes into
A1's `wire_event_kind` enum if A1 lands first.

---

## Trajectory note

The two HIGH findings (A1 + A2) are the same shape: **wire payload
discipline lags behind the schema/Ecto-type discipline.** The
project's strongest type-system patterns
(`Scrollback.Meta`, `Grappa.ClientId`, `Ecto.Enum` on `kind` /
`auth_method` / `connection_state`, custom `EncryptedBinary`,
`MessageKind` exhaustiveness in cic) all live INSIDE a context.
The boundary BETWEEN contexts and the boundary BETWEEN server and
cic is where the discipline thins out — strings, `:map`, `unknown`,
`as` casts, hand-mirrored unions.

The `*.Wire` module pattern (CP15 B6's outcome, now mandated by
CLAUDE.md) is the correct architectural answer; A1's
`@type wire_event_kind` + cic-side `WireEvent` consolidation is the
type-system ratchet that makes it enforceable. Both findings fit
naturally into the next cluster's "wire-IDL hardening" work that
the 2026-05-03 trajectory note already flagged as a Phase 5 codegen
target — A1 is the concrete first step that makes codegen possible
without a full IDL.

No CRITICAL findings. The codebase is in good shape on this concern;
the gaps are real but are concentrated at the cross-language /
cross-context boundary where the project hasn't yet committed to
its strongest pattern. Recommend bundling A1+A2+A3+A7 into one
cluster (call it `wire-event-typing`) before a third broadcast
shape lands and compounds the drift.

---

# extensibility/

# Architecture Review — Extension & Maintainability — 2026-05-08

**Reviewer:** sibling agent under `/review` orchestrator. Concern:
adding a new IRC kind / event kind / context / route / config knob —
how many files? Where does sprawl live? What does the test
architecture force you into?

**Method:** read CP15 (B1–B7) end-to-end, the CLAUDE.md "wire-module
rule" + window-state invariant just written, plus the 2026-05-03
codebase review's already-flagged extensibility findings (M-arch-3 +
M-arch-5). Then walked the surfaces — `Scrollback.{Message,Meta,Wire}`,
`Networks.Wire`, `QueryWindows.Wire`, `Session.Server`,
`GrappaChannel`, `cicchetto/src/lib/{api,subscribe,userTopic,
windowState}.ts`, `ScrollbackPane.tsx`, `config/*.exs`, `cicchetto/
{tsconfig,vite,vitest,biome}.json`, `priv/repo/migrations/`,
`test/**`, `cicchetto/src/__tests__/**`, `cicchetto/e2e/tests/**`. Did
NOT re-flag findings already filed in the 2026-05-03 review or
already in `docs/todo.md`.

**Headline:** Three structural extensibility traps land in HIGH:

  1. **Channel-event `kind:` is a 13-string ad-hoc enum, undeclared
     anywhere on the server, with parallel TS dispatch loops in cic
     that don't share an exhaustive type.** Adding a new channel
     event = ~6 file edits with NO compile-time signal if you forget
     a site (A1).
  2. **Window-state event payloads are duplicated literal-map shapes
     in 2 places per kind inside `Session.Server` (apply_effects
     write arm + `window_state_payload` read snapshot arm).** CP15
     B3 doc says "byte-identical" — that invariant lives in
     reviewer attention, not code (A2).
  3. **`Networks.connection_state_changed` event is a tuple-shape
     PubSub broadcast that does NOT use the unified `kind:` envelope
     and is NOT consumed via Channels** (cic refetches `/networks`
     after PATCH instead). Two divergent broadcast contracts exist
     in the codebase under the same `Grappa.PubSub.broadcast_event`
     era — the wire-module rule's "single source of truth" only
     covers the `Wire`-shaped events, not this one (A3).

MEDIUM cluster around `userTopic.ts` not engaging the type system,
`ArchiveJSON` re-shaping inline instead of via `Scrollback.Wire`,
and the JSON-view-vs-Wire-module split being inconsistent across
contexts.

LOW around migration cadence + test mirror gaps.

**No CRITICAL.** The extensibility shape is healthy at the small
scale (10 message kinds, 13 event kinds, 21 migrations across 13
days, 18 controllers) — but the duplication channels are wired such
that the next addition will mechanically widen them in proportion to
how many contexts the new kind crosses, not how many actual concepts
the new kind introduces. That's the definition of structural debt.

---

## HIGH

### A1. Channel-event `kind:` is a 13-string ad-hoc enum with no central registry, no server-side @type, no shared cross-language source

**Concern:** Extension & maintainability + Type system leverage
**Scope:**
  - Server emit sites: `lib/grappa/session/server.ex` (10 sites),
    `lib/grappa_web/channels/grappa_channel.ex` (3 sites — 671, 709,
    725, 748), `lib/grappa/query_windows.ex` (2 sites — 40, 209).
  - Client dispatch sites: `cicchetto/src/lib/subscribe.ts` (per-
    channel topic, has typed `WireEvent` discriminated union ~L94-122
    with 6 arms — 1 message + 5 typed events), `cicchetto/src/lib/
    userTopic.ts` (user-topic, NO discriminated union — uses `kind?:
    string; [k: string]: unknown` and 5 `if/else if` arms with `as`
    casts at every field).
  - 13 distinct `kind:` strings emitted server-side (ripgrep): 
    `away_confirmed`, `channel_modes_changed`, `channels_changed`,
    `join_failed`, `joined`, `kicked`, `members_seeded`,
    `mentions_bundle`, `message`, `own_nick_changed`, `parted`
    (referenced in comments but server intentionally doesn't
    emit), `query_windows_list`, `topic_changed`.

**Problem:** There is no Elixir-side `@type channel_event_kind ::
"joined" | "kicked" | ...` and no central `@kinds [...]` allowlist on
the channel side. Each emit site hand-writes the literal string. The
13 strings are not catalogued anywhere — to enumerate them I had to
ripgrep `kind: "[a-z_]+"` and `sort -u`. The cicchetto side has TWO
parallel envelopes:

  - `subscribe.ts` invests in a real discriminated union (`type
    WireEvent = ChannelEvent | { kind: "topic_changed"; ... } | ...`)
    — but consumes it with chained `if (payload.kind === "X")`
    statements rather than `switch + assertNever`, so the union does
    NOT enforce exhaustiveness at the consumer. `ScrollbackPane`'s
    nested `MessageKind` switch DOES use `const _exhaustive: never =
    msg.kind` (the right pattern). The same pattern is missing one
    layer up.
  - `userTopic.ts` doesn't bother with the union at all — `payload:
    { kind?: string; [k: string]: unknown }` and `as string` casts
    everywhere (`payload.network as string`, `payload.windows`,
    `payload.away_started_at as string`, etc.). The discriminator
    is a runtime-only string compare; TypeScript never sees the
    contract.

The `Scrollback.Message.kind` enum (10 IRC presence/content kinds) is
done correctly: `@kinds` allowlist + `Ecto.Enum` + `@type kind ::
literal | literal` + `kinds/0` exposed-for-tests + cicchetto
`MessageKind` mirror + exhaustive switch + `assertNever`. CP15 added
13 channel-event kinds at the wire boundary that DON'T follow that
discipline. The shape rule (`@type t :: literal | literal` per
CLAUDE.md) is enforced at the per-row enum but skipped at the per-
event envelope.

**Impact:** Adding a new channel event today (e.g. T32 `parked`
broadcast, the upcoming SASL-locked state, or a `motd_complete`
refresh) requires:

  1. Pick a string at the emit site (`Session.Server` or `Networks`
     or `QueryWindows`).
  2. Add an arm to `subscribe.ts` `WireEvent` union (if per-channel)
     OR remember that `userTopic.ts` doesn't have a union and just
     write another `else if (payload.kind === "X")` branch.
  3. Add a `setX` store + a render hook somewhere in cic.
  4. If you misspell the string at any of the 4 sites, nothing
     fires and nothing complains — the `else if` chain in cic just
     falls through, the test suite passes, the e2e suite passes
     (until the test expects the side-effect), and the bug surfaces
     in production as silently absent UI state.

The CP15 cluster itself was forced into B6's surprise discoveries
under exactly this pressure: bug #2 (`QueryWindows broadcast Jason
crash`) was a `kind:` envelope/struct mismatch detected only
because the e2e suite happened to exercise the close path, and bug
#3 (`join_failed notice silent on cic`) was `apply_effects`
broadcasting the typed event but forgetting to ALSO broadcast the
`kind: "message"` event for the persisted notice — the "two
different envelope shapes for one persisted thing" pattern, no
type check possible. Both are exact instances of "13 strings, no
registry, hand-written at every emit site."

The `MessageKind` enum (10 kinds, fully typed) has had ZERO drift
incidents in the same period. The extension cost gap between "did it
right" and "didn't" is concrete.

**Recommendation:**

  1. Promote channel-event kinds to a server-side typed registry —
     `Grappa.PubSub.Topic` already exists as the topic-name
     authority; add a sibling `Grappa.PubSub.Event` with `@type
     kind :: "joined" | "join_failed" | ...` + `@kinds [...]` +
     `kinds/0` exposed for tests, mirroring the `Message.kinds/0`
     shape. Tests assert all 13 sites' literal strings ∈ `@kinds`
     (a ripgrep-and-allowlist test, fast).
  2. Tighten cicchetto: collapse `userTopic.ts`'s `payload: {
     kind?: string; ... }` envelope to a discriminated union
     `UserTopicEvent = ... | ... | ...`; convert both `subscribe.ts`
     and `userTopic.ts` from `if/else if` chains to `switch (payload.
     kind) { ... default: assertNever }` — same pattern
     `ScrollbackPane.tsx:334-338` already uses for `MessageKind`.
     Today TS has 0 leverage on these envelopes; the change is a
     half-day max and pays compounding interest.
  3. The cross-language drift target was already named in the
     2026-05-03 review's M-arch-3 ("six new admission error atoms
     have no @type union ... candidate target for the cicchetto
     codegen story") — channel-event kinds is the bigger and more
     immediate codegen target. Two cross-language enums is a
     coincidence; three or more is a project rule and codegen pays
     off. The `Scrollback.Wire` ↔ `cicchetto/src/lib/api.ts`
     `MessageKind` mirror, the `connection_state` enum, and the
     channel-event kind union all want the same generator.

---

### A2. Window-state event payloads exist as duplicate literal-map shapes (apply_effects arm + `window_state_payload` snapshot arm), with the "byte-identical" invariant living in code review attention not code

**Concern:** Duplication + Extension & maintainability
**Scope:**
  - `lib/grappa/session/server.ex:1697,1717,1795,1847` —
    apply_effects-arm broadcast literals for `members_seeded`,
    `joined`, `join_failed`, `kicked`.
  - `lib/grappa/session/server.ex:1977,1986,1999` —
    `window_state_payload/3` snapshot helper for `joined`,
    `join_failed`, `kicked`.
  - `lib/grappa_web/channels/grappa_channel.ex:735-755` —
    `push_members_if_seeded/4` constructs another `kind:
    "members_seeded"` literal at the snapshot path (not delegated).

**Problem:** The CP15 B3 docstring claims "Single source of truth
for the projection — must stay byte-identical to the event-time
payloads emitted in the apply_effects arms above" (server.ex:1968-72).
This invariant is enforced by the reviewer reading both literals and
checking. There is no shared `Wire`-style verb that constructs the
payload once for both write-time broadcast AND snapshot-time read.

The pattern is **inverted from the rest of the codebase**: every
other wire shape is centralised — `Scrollback.Wire.message_payload/1`
(single emit point used by every persist+broadcast site),
`QueryWindows.Wire.render_grouped/1` (added precisely because BUG
2 in CP15 B6 was the literal-struct-broadcast bug), `Networks.Wire.
credential_to_json/1`. The window-state events skipped this rule —
even though CP15 B7 just enshrined "wire-shape conversion is per-
context responsibility" as a CLAUDE.md hard invariant.

`members_seeded` is even worse: the literal lives in THREE places —
the apply_effects arm in `Session.Server` (broadcast on event), the
snapshot helper in `Session.Server` (assembled then broadcast on
demand), AND `GrappaChannel.push_members_if_seeded/4` (constructed
at after_join from the cached members list, not via a Session verb).

**Impact:** Adding any field to the event payload (e.g. `:source`
to distinguish "snapshot-emitted" from "event-emitted" for
debugging — vjt has flagged this as a desirable property in
multiple sessions) requires editing 2 or 3 sites per kind, with
NO compile or test signal if you forget one. The "snapshot is
byte-identical to event broadcast" invariant is literally what
CP15 B3 had to prove by close reading; it would be enforced by
construction if both paths called the same `Session.Wire.window_
state_payload(state, channel, transition)` verb.

This is exactly the duplication category CLAUDE.md "Implement once,
reuse everywhere" + "Reuse the verbs, not the nouns" rules outlaw.
And the window-state cluster JUST closed — the rule was being
broken in the cluster that pinned the rule.

**Recommendation:**

  1. Extract `Grappa.Session.Wire` (or fold into a wider context)
     with `window_state_payload(state, channel, transition)` +
     `members_seeded_payload(network_slug, channel, members)`. Both
     arms in `apply_effects` AND `window_state_payload` snapshot
     verb AND `GrappaChannel.push_members_if_seeded/4` go through
     it. Six total literal-map sites collapse to three call sites.
  2. Move the snapshot dispatch to a per-kind verb pair:
     `Wire.window_state_payload(state, channel, :joined |
     :join_failed | :kicked)` — same shape `Session.Server`'s
     `window_state_payload/3` already has, just lifted to the
     Wire module. The `apply_effects` arms then call
     `Wire.window_state_payload(state, channel, :joined)` instead
     of inlining the literal.
  3. Apply the same factoring to `members_seeded`. Apply the same
     factoring proactively to the next set the cluster
     introduces — when you add a 14th channel-event, decide
     `Wire`-or-not at the design step, not after the bug ships.

---

### A3. `Networks.connection_state_changed` PubSub event uses tuple-shape envelope, not consumed via Channels — second broadcast contract inside one codebase

**Concern:** Duplication + Abstraction boundaries
**Scope:**
  - `lib/grappa/networks.ex:443-466` — emits `{:connection_state_
    changed, %{user_id, network_id, network_slug, from, to, reason,
    at}}` via Phoenix.PubSub.broadcast/3 directly (NOT via
    `Grappa.PubSub.broadcast_event/2`).
  - `cicchetto/src/lib/api.ts:389-413` — comment block + types for
    consuming the connection_state via the REST `PATCH /networks/:id`
    response and refetching `/networks` to pick up updates.
  - `cicchetto/src/lib/userTopic.ts`, `subscribe.ts` — no handler
    for `connection_state_changed`.

**Problem:** Two divergent broadcast contracts coexist in the
codebase. The unified one (used by `Session.Server`,
`GrappaChannel`, `QueryWindows`) goes through
`Grappa.PubSub.broadcast_event/2` → `phx_msg{event: "event",
payload: %{kind: "...", ...}}` → cicchetto `channel.on("event",
...)` handler. The Networks one goes through raw `Phoenix.PubSub.
broadcast/3` with a `{:event_atom, payload}` tuple shape that
**Phoenix Channels' fastlane CANNOT relay** (the channel server
broadcasts the literal tuple as a `%Phoenix.Socket.Broadcast{}`
only when it's emitted via `Endpoint.broadcast` or
`Channel.Server.broadcast`, NOT raw `PubSub.broadcast`). So the
event fires, internal Elixir subscribers can hear it, but
cicchetto cannot — and the workaround (added by the operator
side) is "PATCH then refetch /networks", a REST round-trip that
defeats the very purpose of the broadcast.

The CP15 B7 narrative in `docs/checkpoints/2026-05-07-cp15.md`
just elevated "wire-shape conversion is a context responsibility"
to a CLAUDE.md hard invariant — but the Networks event predates
that and was never migrated. The 2026-05-03 review noted
`broadcast_event/2` came out of CP15 B6's BUG #2 (Jason crash on
struct broadcast). The Networks event uses a plain `%{...}` map
so it wouldn't crash, but it is the SAME class of bug latent
(any future struct field added to the payload would crash if
the channel layer ever subscribed). And the contract gap means
cic has to poll-and-refetch instead of consuming the push.

**Impact:** Three concrete drifts:

  1. **REST round-trip latency on every reconnect/disconnect.**
     The `/disconnect` `/connect` `/quit` slash commands make a
     PATCH then refetch — the broadcast that exists internally
     does nothing for the cic-side UX update.
  2. **Adding a 4th `connection_state` (e.g. `:reconnecting`)
     requires changing both the broadcast event shape AND adding
     a refetch-trigger somewhere in cic** — two parallel paths.
  3. **The wire-module rule has an exception that's not documented
     anywhere.** The CP15 B7 invariant says "every PubSub broadcast
     and Channel push payload MUST be JSON-encodable via a context-
     owned Wire module." The Networks event is a PubSub broadcast,
     it is NOT JSON-encodable in the channel-fastlane sense (tuple
     shape), and it has no Wire module. The next contributor
     reading CLAUDE.md and looking for the pattern in `Networks`
     will find the WRONG pattern.

**Recommendation:**

  1. Migrate `Networks.broadcast_state_change/4` to
     `Grappa.PubSub.broadcast_event/2` with `kind: "connection_state_
     changed"`, payload built via `Networks.Wire.connection_state_
     event/4` (sibling to `credential_to_json/1`). One commit.
  2. Add the `connection_state_changed` arm to cic's `userTopic.ts`
     event dispatch — when this lands, the PATCH-then-refetch
     workaround in `compose.ts:290`-area can drop the refetch.
  3. Adds a 14th channel-event kind (which folds into A1's
     register-the-enum recommendation; do A1 + A3 in the same
     bucket).

This was missed in the 2026-05-03 review because T32 was being
designed at the time, not built. Now that the broadcast exists +
the wire-module rule is explicit, the gap is visible and the fix
is mechanical.

---

## MEDIUM

### A4. `userTopic.ts` consumes events with `payload: { kind?: string; [k: string]: unknown }` envelope + `as` casts, completely sidestepping the TS type system

**Concern:** Type system leverage + Extension & maintainability
**Scope:** `cicchetto/src/lib/userTopic.ts:72-124`.

The consumer for the `Topic.user(name)` Phoenix Channel — handles
5 distinct event kinds (`channels_changed`, `query_windows_list`,
`mentions_bundle`, `away_confirmed`, `own_nick_changed`) — uses
the type-erased envelope `(payload: { kind?: string; [k: string]:
unknown }) => { ... if (payload.kind === "X") ... }`. Every field
read inside an arm is then cast with `as`: `payload.network as
string`, `payload.windows`, `payload.away_started_at as string`,
`payload.away_reason as string | null`, `payload.messages as
{...}[]`, `payload.network_id as number`, `payload.nick as
string`. The discriminator is a runtime-only string compare; the
type system has zero leverage.

`subscribe.ts` does this RIGHT (`type WireEvent = ... | ... | ...`
discriminated union) — `userTopic.ts` is the inconsistent sibling.
The two consumers were authored at different times by different
clusters; the right pattern got established in `subscribe.ts`,
the wrong pattern survives in `userTopic.ts`.

**Impact:** Adding a 6th user-topic event = another `else if
(payload.kind === "X")` chain entry with hand-cast field reads.
Misspell the string, no error. Read a field that doesn't exist,
no error (returns `undefined`-cast-to-type). The TS strict mode
flags pinned in `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`,
`noImplicitAny`) are bypassed at this exact boundary. The 2026-
05-03 review's TS-strictness theme (LOW count of violations was
reported) doesn't reach this file.

**Recommendation:** Mirror `subscribe.ts`'s `WireEvent` shape:

```ts
type UserTopicEvent =
  | { kind: "channels_changed" }
  | { kind: "query_windows_list"; windows: WireWindowsMap }
  | { kind: "mentions_bundle"; network: string; away_started_at: string;
      away_ended_at: string; away_reason: string | null;
      messages: MentionMessage[] }
  | { kind: "away_confirmed"; network: string; state: "away" | "present" }
  | { kind: "own_nick_changed"; network_id: number; nick: string };
```

Convert `if/else if` to `switch (payload.kind) { ... default:
assertNever }`. Drop every `as` cast inside the arms. Half-day,
no runtime change.

---

### A5. `ArchiveJSON` re-shapes on the wire (atom-stringification + string-key map) inline, not via a `Scrollback.Wire.archive_to_json/1` verb

**Concern:** Duplication + Abstraction boundaries
**Scope:**
  - `lib/grappa_web/controllers/archive_json.ex:18-32` — inline
    `Atom.to_string(kind)` + `%{"target" => ..., "kind" => ...,
    "last_activity" => ..., "row_count" => ...}` (string keys).
  - `lib/grappa/scrollback.ex` — `Scrollback.list_archive/3` returns
    `[archive_entry()]` with atom-keyed maps.
  - `lib/grappa/scrollback/wire.ex` — has `to_json/1` and
    `message_payload/1` for messages, NOT for archive entries.

**Problem:** CP15 B7's invariant is "wire-shape conversion is per-
context responsibility, via a context-owned `*.Wire` module."
`ArchiveJSON` is a JSON view, not a Wire module — it lives in
`grappa_web` and re-shapes on the way out. The atom-to-string
conversion + atom→string key flip lives in the controller layer,
not in the Scrollback context. Two consumers of `Scrollback.list_
archive/3` cannot exist today without either (a) re-implementing
the shape flip, or (b) reaching into the JSON view.

The factoring is also inconsistent with the project pattern: every
other Wire module returns atom-keyed maps with the keys as the
public contract. `ArchiveJSON`'s string-keyed shape exists because
it's emitted directly by the controller via `render(conn, :index,
archive: entries)` and `Phoenix.View` JSON-encodes whatever the
view returns. But the right factoring is `Scrollback.Wire.archive_
to_json(entries)` returning atom-keyed maps + `ArchiveJSON.index`
delegating to that.

**Impact:** Adding a Phase 6 `CHATHISTORY` listener (the documented
Phase 6 work) that needs to walk the archive can't reuse the wire
shape — the listener can't be a `cd lib/grappa_web/controllers/
archive_json.ex` consumer (web-layer dependency from the listener
would invert boundaries). It would re-implement the shape, which
would drift the moment a field is added.

The "byte-identical to wire" check that lives in CP15 B3's
`window_state_payload` is the same problem in another corner.

**Recommendation:**

  1. Add `Scrollback.Wire.archive_to_json(entries)` returning the
     atom-keyed shape; `ArchiveJSON.index` delegates with one
     line.
  2. Phase 6 listener facade reuses the same verb. Same pattern
     `Networks.Wire.credential_to_json/1` already proves out for
     credentials.

---

### A6. JSON view ↔ Wire module split is inconsistent across contexts

**Concern:** Duplication + Responsibility & cohesion
**Scope:**
  - `lib/grappa/scrollback/wire.ex` — exists, used by
    `MessagesJSON` + `Session.Server` broadcasts.
  - `lib/grappa/networks/wire.ex` — exists, used by
    `NetworksJSON`.
  - `lib/grappa/query_windows/wire.ex` — exists, used by
    `GrappaChannel` push + `QueryWindows` broadcast.
  - `lib/grappa_web/controllers/me_json.ex` — DOES NOT have
    `Accounts.Wire`; constructs `%{kind: "user" | "visitor", id,
    ...}` shape inline.
  - `lib/grappa_web/controllers/auth_json.ex` — same shape
    inline at 38, 45 (subject discriminator).
  - `lib/grappa_web/controllers/members_json.ex`,
    `channels_json.ex`, `archive_json.ex`,
    `health_controller.ex`, `error_json.ex` — no Wire module
    counterparts.

**Problem:** The wire-module rule is half-applied. Three contexts
(Scrollback, Networks, QueryWindows) own their wire — three
contexts (Accounts, Visitors, Mentions) do not, and the JSON views
hand-construct shape. The subject discriminator in particular
(`%{kind: "user"|"visitor", id, name|nick, ...}`) is repeated
verbatim in `MeJSON` + `AuthJSON` + cicchetto `Subject` type +
test fixtures — same drift class the channel-event kinds suffer
from in A1.

The rule's deterrent function only works if it's followed
uniformly. Today it reads "use a Wire module if your context has
one" — i.e. the rule only applies to contexts that already have
one. New contexts (like Visitors) get no nudge to start with one.

**Impact:** Adding a field to the `:user`/`:visitor` subject shape
requires editing `MeJSON` + `AuthJSON` + cicchetto `lib/auth.ts` +
cicchetto `lib/api.ts` + 3-4 test fixtures. No central registry,
no Dialyzer signal, no TS exhaustiveness on the subject side
(it IS discriminated in cic, but the union isn't anchored to a
server-derived type).

**Recommendation:**

  1. Add `Grappa.Accounts.Wire` (subject discriminator + me/auth
     payloads) — collapses 4-5 inline shape sites to 1.
  2. Add `Grappa.Visitors.Wire` (visitor subject + nick + expires_at).
  3. Promote the wire-module rule from "use one if you have one"
     to "every context that emits a wire shape has one. New
     context = new Wire module." Add as a CLAUDE.md item under
     the existing Phoenix Channels invariant.
  4. Test architecture: add `test/grappa_web/wire_coverage_test.exs`
     that asserts every `*JSON` module's `render` clauses delegate
     to a `*.Wire` module (ripgrep-and-allowlist test).

---

### A7. Adding a new context requires touching `Grappa.Application` boundary deps + supervision tree — that's correct, but the boundary-deps `use Boundary, deps: [...]` list is 9 entries and growing without a structural pattern

**Concern:** Dependency architecture + Extension & maintainability
**Scope:**
  - `lib/grappa/application.ex:7-15` — `deps: [Grappa.Admission,
    Grappa.Bootstrap, Grappa.PubSub, Grappa.Repo, Grappa.Session,
    Grappa.Vault, Grappa.Visitors.Reaper, Grappa.WSPresence,
    GrappaWeb]`.
  - The boot path adds children at 11 explicit positions
    (`Vault, Repo, PubSub, Registry, Backoff, WSPresence,
    NetworkCircuit, DynamicSupervisor, Endpoint, Reaper,
    bootstrap_child`), with EVERY position commented for the
    load-bearing reason — which is the right discipline.

**Problem:** This is 80% right. The `deps:` list grew organically,
not by a pattern — `Visitors.Reaper` is a sub-module of Visitors
listed directly (other contexts list the umbrella, not the sub-
module: `Grappa.Session` not `Grappa.Session.Backoff` even though
Backoff is in the supervision tree). Adding a 12th child today =
edit the comment + add to children list + add to deps. Adding a
13th = same. The order matters and is documented; the pattern
for "where in the deps list does my new context go" is unclear.

`Boundary` analysis is documented in 2026-05-03 review H5 as
silently ignoring module-as-atom literals in case patterns —
that gap is open follow-up. So even the `deps: [...]` list isn't
a hard gate today.

**Impact:** Adding a context goes:
  - new `lib/grappa/<context>.ex` with `use Boundary, ...`,
  - schema/sub-modules under `lib/grappa/<context>/`,
  - update `Application.deps` + `children`,
  - controller + JSON view (or Wire + view) under `lib/grappa_web/
    controllers/`,
  - router pipeline if it needs auth,
  - tests under `test/grappa/<context>/`.
  - cicchetto: api.ts type + lib/<context>.ts store + component.
  - 8-10 file edits for a small context, ~15-20 for a large one.

That's the floor. It's not bad. But there's no scaffold (no `mix
grappa.gen.context`) and the right shape (Wire module + boundary
deps + Application children + tests + cic mirror) only exists in
operator memory.

**Recommendation:** Lightweight — write a single `docs/patterns/
new-context.md` checklist (the way the gate-evidence rule is
captured in feedback memory). Not a generator, not Boundary
churn. Just a checklist of the 8 sites + a rule for which
contexts need Wire vs which can hand-build (per A6's outcome).

---

### A8. `Scrollback.Meta.@known_keys` ↔ Logger metadata allowlist sync is enforced by ONE test — adding a new metadata key requires editing 4 sites with one test catching drift

**Concern:** Extension & maintainability + Type system leverage
**Scope:**
  - `lib/grappa/scrollback/meta.ex:84` — `@known_keys ~w[target
    new_nick modes args numeric severity]a` (6 keys).
  - `config/config.exs:99-178` — Logger `:metadata` allowlist (37
    keys total, 6 mirroring meta + 31 unique).
  - `test/grappa/scrollback/meta_test.exs:107-115` — single
    sync-assertion test.
  - `lib/grappa/scrollback/message.ex:114-124` — per-kind meta
    shape table in moduledoc (not enforced, doc-only).

**Problem:** The 2026-05-03 review M-arch-3 noted "Six new admission
error atoms have no @type union — adding a 7th atom is a 5-site
edit." Same shape applies to meta keys: adding a 7th meta key
means editing `@known_keys` + Logger allowlist + Wire shape (cic-
side type for the kind that uses it) + the moduledoc per-kind
table + adding a test for the new shape. The sync is enforced for
`@known_keys ↔ Logger` only; the cic-side type for `meta` is just
`Record<string, unknown>` (no per-kind narrowing) which is the
right minimum for now but means the cic side never benefits from
the meta-key allowlist either.

**Impact:** Bounded — 6 keys today, the rate of growth is low (last
key added was severity in CP13). But the meta system was designed
in Phase 1 with the explicit intent that "Phase 5+ presence-event
producers light it up" (per Message moduledoc). When that lights
up — `:join`, `:part`, `:quit`, `:nick_change`, `:mode`, `:kick`
all start writing meta — the per-kind shape registry will need to
exist. Today it doesn't.

**Recommendation:**

  1. Promote per-kind meta shape from moduledoc-prose to a
     `@spec`-typed `Meta.shape_for_kind(kind)` function returning a
     `MapSet` of allowed keys. Adding a kind/key combination
     requires extending the function clause; a Dialyzer-or-test
     check enforces "every key the producer writes for kind K must
     be in `shape_for_kind(K)`."
  2. Folds into A1's "channel-event registry" recommendation if
     done together — same shape (server-side enum + tests + cic-
     side mirror).
  3. Defer the per-kind meta shape strictening until Phase 5
     presence-event producers actually light up the kinds —
     today the surface is too small to be worth the ceremony.

---

### A9. `Session.Server` is 2271 LOC and `EventRouter` is 1191 LOC — the natural axis of split (per-event-kind handler modules) hasn't been taken

**Concern:** Responsibility & cohesion + Extension & maintainability
**Scope:**
  - `lib/grappa/session/server.ex` — 2271 LOC, mixed
    responsibilities (state struct, per-effect arms, broadcast
    helpers, snapshot verbs, in-flight tracking, autojoin,
    NickServ orchestration, mode chunker integration).
  - `lib/grappa/session/event_router.ex` — 1191 LOC, 71 def/defp
    functions, per-IRC-command dispatch.
  - `lib/grappa/session/numeric_router.ex` — 328 LOC, per-
    numeric dispatch.

**Problem:** The natural split is per-IRC-event-kind: `JOIN` /
`PART` / `KICK` / `MODE` / `NICK` / `PRIVMSG` / `NOTICE` / `TOPIC`
each have routing + apply_effects arm + broadcast + snapshot
behavior. Today these threads are interleaved in 3 files. The
split happens at the WRONG axis (read-route vs effect-apply
vs server-state) instead of at the cohesive axis (per-event
lifecycle).

This is exactly the "god module" pattern the 2026-05-03 review's
A2 warned about for a different module (NetworkCircuit + Backoff
overlap) — `Session.Server` is the surviving instance. Adding a
new IRC event kind today means walking three files looking for the
right pattern to copy.

**Impact:** CP15 buckets B1-B6 added 4 new event kinds (`:joined`,
`:join_failed`, `:parted`, `:kicked`) and 3 new state fields
(`window_states`, `window_failure_reasons`, `window_failure_
numerics`, `window_kicked_meta`). Each addition was a multi-site
edit across `EventRouter` clauses + `apply_effects` arms in
`Session.Server` + `state` typespec + `window_state_payload`
snapshot helper + tests. The `:kick` clause "tipped from CC 9 to
10 with the new effect-emission branch" (per CP15 B3 doc) and had
to be refactored into private helpers — the cyclomatic-complexity
gauge is the only signal for "this module is too big for its
remit," and it only fires per-function, not per-module.

**Recommendation:** Defer until pain. The 2271-LOC count is
uncomfortable but not yet broken — `mix credo --strict` doesn't
gate per-module size, and the refactors that have happened
(extract `kick_state_update/3` + `evict_cache_if_no_overlap/3`)
have been local. The honest path is:

  - Wait for the next 2 IRC event additions (channel-client-polish
    cluster will add several: `/who` `/names` inline, `/nick`
    response, `/away` confirmation, `/quit` lifecycle).
  - When the 4-of-3-files pattern bites a second time (estimated
    next cluster), split per-event-kind: each IRC verb gets
    `lib/grappa/session/events/<kind>.ex` with router clause +
    apply effect + broadcast + snapshot in one file.
  - Don't pre-split today — the boundary isn't clear yet (some
    IRC events route as numerics, some as commands; a clean
    per-kind split has to handle that).

Mention here so it's tracked, not actionable this cluster.

---

## LOW

### A10. Migration cadence: 21 migrations in 13 days post-Phase-1, 9 in the visitor-auth + T31 + CP15 window — high churn but each is small + reversible. Not a finding; a "watch this" note.

The migration directory has 21 files; 11 of them are post-2026-05-02
(visitor-auth + T31 + CP15). They're each well-named, each does one
schema change, each has a clear lineage from the corresponding
checkpoint. The pattern is good. The note: high migration cadence
is a Phase 4-5 phenomenon; once the schema settles in Phase 5
hardening (no further new contexts planned), this rate should drop
to <1/week. If it doesn't, it's a sign of underspecified domain.
Defer as observation.

### A11. `cicchetto/src/__tests__/` is flat (36 files), not nested by surface — works at this scale, breaks past ~80

Cic test architecture is flat: every test file in
`cicchetto/src/__tests__/` regardless of whether it tests a
component, a lib helper, or an integration scenario. Server-side
`test/` mirrors `lib/` (correct). Cic-side will start to bite past
~80 test files (CP15 ended at 627 tests across 36 files); the
e2e/ directory IS nested correctly (`cicchetto/e2e/tests/cp15-*`).
Recommend nest cic `__tests__/` into `__tests__/lib/`,
`__tests__/components/`, `__tests__/integration/` when adding the
next 5 files. Not urgent.

### A12. Config sprawl is small but unprincipled — 4 cic config files (tsconfig 26 LOC, vite 110 LOC, vitest 23 LOC, biome 30 LOC) + 5 server config files (config 180 LOC, dev 29, prod 5, runtime 117, test 86)

Total config: 8 files, ~600 LOC, no duplication detected. Cic
side is principled (biome single tool, single config; tsconfig
strict flags pinned per the 2026-05-03 review LOW finding). Server
side is principled (runtime.exs has the env-var registry comment
block per CP11 S22 deploy-bug post-mortem; compose.prod.yaml +
.env.example sync requirement is documented at the file head). No
sprawl finding. Mention only because the review prompt asked.

### A13. Test architecture: server `test/` mirrors `lib/` (correct), cic-side has `__tests__/` flat colocated AND `e2e/tests/` nested — different conventions in different scopes, not drift

Server: `test/grappa/<context>/<schema>_test.exs` mirrors
`lib/grappa/<context>/<schema>.ex` (8 schema test mirror dirs
under `test/grappa/`). Mox/Bypass patterns documented in CLAUDE.md.
Cic vitest: `cicchetto/src/__tests__/` flat. Cic Playwright:
`cicchetto/e2e/tests/<bucket-tag>-*.spec.ts` (per-cluster prefix).
Three different conventions in three scopes — but each is
internally consistent and the conventions are documented enough.
Not a finding; just a note that flat-vs-nested is a cic-side
inconsistency that will widen.

---

## Trajectory note

The 2026-05-03 codebase review's H1 (T31 `Application.get_env`
runtime reads) was followed by a real cleanup cluster (T31-cleanup
LANDED 2026-05-04 S29 per memory pin) — the architectural-drift
fix happened. Good. But the same review's M-arch-3 ("six new
admission error atoms have no @type union — candidate target for
the cicchetto codegen story") wasn't acted on, and CP15 added 13
more cross-language strings (channel-event kinds) following the
same pattern: bare strings, no central registry, no codegen, no
exhaustiveness check, no test sync.

The lesson the codebase keeps re-learning: **adding a closed-set
enum without the discipline of `@type t :: literal | literal +
exposed `kinds/0` + cicchetto mirror + test-sync IS the bug**, and
the cost of doing it right at first introduction is half-day; the
cost of fixing later compounds with each consumer.

A1 + A3 + A4 should land together as one bucket in the next
cluster — they're the same pattern at three different boundaries
(channel-event kind, Networks broadcast contract, userTopic.ts
typing). A2 + A6 should land together — same pattern at two
different Wire-module gaps. A5, A7, A8, A9 are deferred / lighter.

---

## Verdict

**YELLOW** — proceed, file the cluster.

3 HIGH findings (A1, A2, A3) all in the duplication / type-system-
leverage axis. Zero CRITICAL. The structural shape is healthy at
this scale; the duplication channels widen with each addition
mechanically. The cost of the consolidation work is bounded
(~one cluster, possibly piggybacking on channel-client-polish
which will need to add more event kinds anyway); the cost of
NOT doing it scales with each new event kind shipped without
the registry.

Per orchestrator HALT trigger: zero CRITICAL — proceed to
synthesis.

---
