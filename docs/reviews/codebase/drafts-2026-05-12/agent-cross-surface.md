# Codebase Review Draft — Cross-Surface (grappa ↔ cicchetto)
**Agent:** cross-surface
**Scope:** server Wire / JSON view / Channel surface ↔ cic api.ts / socket.ts / subscribe.ts / store layers
**Date:** 2026-05-12

The boundary is in remarkably good shape — every domain entity that crosses
the wire passes through a context-owned `*.Wire` module on the server
(`Scrollback.Wire`, `Networks.Wire`, `Accounts.Wire`, `QueryWindows.Wire`,
`Visitors.Wire`, `Session.Wire`) and the cic side mirrors most of those
shapes in `lib/api.ts` (REST) and `lib/subscribe.ts` (Channel events) with
TS discriminated unions + `assertNever` exhaustiveness checks at both
`subscribe.ts` (per-channel) and `userTopic.ts` (user-topic). CP15 B7's
hard invariant ("wire conversion is per-context responsibility") and CP16
B5's discriminated-union pattern are paying real dividends. The drifts
below are concentrated in three pockets: (a) timestamp typing, (b) error
envelope handling, and (c) shared "closed sets" that have to be restated
on each side without a generator.

## CRITICAL

_None._ The "one IRC parser, on the server" invariant holds — no cic file
parses IRC frames. Wire conversion via `*.Wire` is honored at every
broadcast/push site. No security bug: every credential-bearing path goes
through the redact-protected wire allowlist.

## HIGH

### H1 — Login.tsx has dead-code `captcha_provider_unavailable` branch (server emits `service_degraded`)

`lib/grappa_web/controllers/fallback_controller.ex:177-181` maps
`:captcha_provider_unavailable` to wire body `%{error: "service_degraded"}`
(deliberate — see line 261's `captcha_provider_wire/0` and `service_degraded`
at L181). The cic `AdmissionError` union (`api.ts:31-37`) correctly lists
`service_degraded` only and OMITS `captcha_provider_unavailable`. Yet
`Login.tsx:104-108` has a switch arm `case "captcha_provider_unavailable":`
that is **unreachable** — `err.code` will never carry that string. A
genuine server-side captcha-provider outage shows the
`service_degraded` arm's "Login service temporarily unavailable" copy
(L96-97), not the more specific "Verification service is unreachable"
copy (L107). Drop the dead arm or change the server wire to
`captcha_provider_unavailable` (lower-cost: drop the cic arm).

**Fix:** Edit `cicchetto/src/Login.tsx:104-108` — remove the dead `case`.

### H2 — Validation errors collapse to HTTP statusText on cic — `errors:` envelope unparseable

`fallback_controller.ex:238-242` returns
`%{errors: format_changeset_errors(changeset)}` for `Ecto.Changeset`
errors — shape is `%{field => [msg]}` (e.g.
`%{nick: ["has invalid format"]}`). `error_json.ex:13` returns
`%{errors: %{detail: "Not Found"}}` for default Phoenix templates.
`api.ts:373-376` does:

```ts
const errs = body.errors as { detail?: string } | undefined;
code = (body.error as string | undefined) ?? errs?.detail ?? res.statusText;
```

Two problems:
1. The `errors` shape from `format_changeset_errors` is field-keyed
   (`{nick: [...]}`), not `{detail: ...}`, so cic falls back to
   `res.statusText` ("Unprocessable Entity") for EVERY validation 422.
   Field-level error info is lost; cic can't tell "nick has bad format"
   from "body too long".
2. The two server-side envelopes (`error_json` `errors.detail` vs
   `fallback_controller` `errors.<field>`) collide on key name —
   the cast in `api.ts:375` accidentally types both the same way and
   makes the server-side ambiguity invisible to the developer.

**Fix:** Either pick one shape server-side and unify (recommend
`{error: "validation_failed", fields: %{<field> => [msg]}}` so the
single-tagged-error envelope and the validation envelope are
unambiguously different), or extend cic's `readError` to detect the
field-keyed shape and surface it via `info.fields`. Cite changeset-
returning endpoints: AuthController login (visitor credentials),
nothing else — `messages_controller`, `nick_controller` etc. ALL
return atom errors, so changeset errors are rare today. Will become
critical when more endpoints validate input.

### H3 — `WireEvent` channel-event union duplicated between `api.ts` and `subscribe.ts`

`api.ts:210-213` defines `ChannelEvent = { kind: "message"; message: ScrollbackMessage }`
— the canonical wire shape mirror of `Scrollback.Wire.event`. But
`subscribe.ts:96-124` defines a LARGER union `WireEvent` that extends
`ChannelEvent` with `topic_changed`, `channel_modes_changed`,
`members_seeded`, `joined`, `join_failed`, `kicked`. The server emits
all six on the per-channel topic (`Session.Wire.{topic_changed,
channel_modes_changed, members_seeded, joined, join_failed, kicked}`),
so `ChannelEvent` is misleadingly narrow.

Net effect: any future consumer of cic-side per-channel events that
imports `ChannelEvent` from `api.ts` will be type-blind to 5 out of 6
event kinds. The `assertNever` in `subscribe.ts:341` only protects
that one site.

**Fix:** Either fold `WireEvent` into `api.ts` next to `WireUserEvent`
(both belong in the wire-types module), or rename `ChannelEvent` →
`MessageChannelEvent` so the narrowness is explicit. The first option
is the correct unification — cic's wire-types module is api.ts.

### H4 — Per-channel event payloads not runtime-narrowed (only user-topic events are)

`userTopic.ts:62-169` defines `narrowUserEvent(raw)` — runtime
validator that ensures every required field is present and well-typed
before the discriminated dispatch fires. `api.ts:cic M1` audit row
explicitly motivated this ("malformed server push would let the
dispatch arm read `undefined`"). The same risk exists on the
per-channel topic: `subscribe.ts:269` and `subscribe.ts:370` install
handlers that take `payload: WireEvent` via raw cast, NO runtime
narrow. A malformed `members_seeded` push (server bug, proxy mangling,
historic-broadcast replay during deploy) would let `seedMembers(key,
undefined)` corrupt store state silently.

**Fix:** Mirror `narrowUserEvent` for `WireEvent` — same defensive
boundary, same console.warn-and-drop fallback. Same module location
(api.ts or a new `wireNarrow.ts`).

### H5 — `connection_state` enum split awkwardly across two TS types

Server enum: `:connected | :parked | :failed`
(`networks/credential.ex:62, 82`). cic splits this:
- `CredentialConnectionState = "connected" | "parked"` (api.ts:580 — user-settable values).
- `Network.connection_state?: CredentialConnectionState | "failed"`
  (api.ts:153 — readback values, including `:failed` which is
  server-set only).

`patchNetwork`'s body type uses the narrow `CredentialConnectionState`
correctly (the controller rejects `:failed` from clients per
`networks_controller.ex:147`). Split is intentional and even documented.
But the relationship is brittle: a future fourth state would need to
land in the right type, and the server's authoritative set
(`Credential.connection_states/0`) is not visible at the cic boundary
at all.

**Fix:** Add a comment on the cic `Network.connection_state` field
pointing to `Credential.connection_states/0` as the source of truth,
and make the cic type expression
`CredentialConnectionState | "failed"` literal so adding a new state
forces a cic edit. (Already done — keep this entry as a unification
opportunity, see U2.) Demote to MEDIUM.

## MEDIUM

### M1 — `inserted_at` / `expires_at` raw `DateTime.t()` in some Wire shapes, ISO-8601 string in others

`Networks.Wire` is consistent — `iso8601_or_nil/1` converts every
`%DateTime{}` to an ISO-8601 string before the wire (lines 150-152,
197, 198-199, 245). But `Accounts.Wire.user_to_json/1`
(`accounts/wire.ex:55-57`) returns raw `inserted_at: user.inserted_at`
(a `%DateTime{}` struct), and `Visitors.Wire.visitor_to_json/1`
(`visitors/wire.ex:92-99`) returns raw `expires_at: v.expires_at`. The
typespecs declare these as `DateTime.t()`, NOT `String.t()`. Jason's
default `%DateTime{}` encoder produces an ISO-8601 string so the
on-wire bytes match what cic expects (`MeResponse.inserted_at:
string`, `expires_at: string` at api.ts:64-71), but the contract is
inconsistent inside the codebase: the typespec and the wire literally
disagree about what `inserted_at` is.

**Fix:** Apply `iso8601_or_nil/1` (or its equivalent) inside
`Accounts.Wire` and `Visitors.Wire` and update the typespecs to
`String.t()`. Pull the helper into a shared `Grappa.Wire.Time` module
(see U1).

### M2 — Server `topic_entry.set_at` stored as raw `DateTime.t()`, broadcast as raw struct

`session/event_router.ex:130-132` declares `set_at: DateTime.t() | nil`
in `topic_entry`. `Session.Wire.topic_changed/3` passes the entry
through verbatim (`session/wire.ex:213-216` — `topic: entry`). The
broadcast goes through fastlane → Jason → ISO-8601 string. cic's
`TopicEntry.set_at: string | null` (`channelTopic.ts:19-23`) matches.
Same Jason-coercion-saves-us situation as M1 — works, but the typespec
and wire disagree.

**Fix:** Stringify at the Wire boundary (`Session.Wire.topic_changed`)
just like `Networks.Wire` does for credential timestamps. One-line
edit; brings symmetric consistency to all Wire modules.

### M3 — `meta` field on scrollback messages is opaque on cic side (`Record<string, unknown>`)

Server side `Scrollback.Meta` (lib/grappa/scrollback/meta.ex) maintains
a documented per-kind shape table:
- `:notice` → `%{}` OR `%{numeric: 1..999, severity: :ok | :error}`
- `:nick_change` → `%{new_nick: String.t()}`
- `:mode` → `%{modes: String.t(), args: [String.t()]}`
- `:kick` → `%{target: String.t()}`

cic's `ScrollbackMessage.meta: Record<string, unknown>` (api.ts:207)
has none of this typed. Consumers (`operatorActionEcho.ts:39-40`,
ScrollbackPane renderers, modeApply) cast to the shape they expect
case-by-case. A server-side change to `meta` (e.g. add `at_iso` to
`:nick_change`) would compile + ship without any cic compile error.

**Fix:** Mirror the per-kind shape table in cic — discriminated union
on `kind`:

```ts
type ScrollbackMessage =
  | (Base & { kind: "privmsg" | "action" | "topic"; meta: {} })
  | (Base & { kind: "notice"; meta: {} | { numeric: number; severity: "ok" | "error" } })
  | (Base & { kind: "nick_change"; meta: { new_nick: string } })
  | (Base & { kind: "mode"; meta: { modes: string; args: string[] } })
  | (Base & { kind: "kick"; meta: { target: string } })
  | ...
```

Cost is real (every consumer needs an exhaustive switch over `kind`),
benefit is large (compile-time enforcement of the shape contract). Pair
with a server-side codegen of the TS union from
`Grappa.Scrollback.Meta.@known_keys` for free synchronization.

### M4 — `ChannelEntry.source` enum mirror is hand-maintained on both sides

Server: `Networks.Wire.channel_to_json/3` accepts `source in
[:autojoin, :joined]` (line 211) and Jason serializes as
`"autojoin" | "joined"`. cic: `ChannelEntry.source: "autojoin" | "joined"`
(api.ts:171). These literals are restated in three places at minimum
(server typespec, server JSON, cic type); a third value would need
hand-coordinated edits.

**Fix:** Same class as M3 — see U2. Less urgent (set is small + stable).

### M5 — `auth.ts.logout()` swallows ALL errors — no diagnostic for non-401 failures

`auth.ts:152-159` uses a bare `try { await api.logout(t); } catch {}`.
The comment notes the 401 path (server-side already-revoked) is
intentional. But the catch also swallows 5xx, network errors, and any
other 4xx — the user gets the local logout regardless, which IS the
right UX, but operator diagnostic is zero. Compare with
`AuthController.logout/2` server side which explicitly logs the
PubSub broadcast failure (auth_controller.ex:200-209).

**Fix:** Add a `console.warn` (matching the rest of cic's diagnostic
posture) before the swallow.

### M6 — Cic-side `WindowState` mirror duplicates a server enum that's not exposed at any wire boundary

`windowState.ts:31` defines `WindowState = "pending" | "joined" |
"failed" | "kicked" | "parked"`. The server enum lives in
`session/window_state.ex` AND is referenced as the union of broadcast
events (`joined`, `join_failed`, `kicked`, `window_pending` per
`Session.Wire`); `:parked` is intentionally NOT broadcast (cic derives
it from `Network.connection_state`); `:parted` is intentionally NOT
broadcast (cic derives it from `setParted` on own-PART). The relationship
is documented in `windowState.ts:23-24` and `subscribe.ts:325-330` but
the closed-set literal lives in two places without any cross-reference
test.

**Fix:** Pure documentation — add a Boundary-style test on the server
side that asserts `Session.Wire.wire_event_kind` (lib/grappa/session/
wire.ex:67-79) matches the closed-set list of cic-relevant atoms.
Won't catch all classes of drift but pins the registry.

### M7 — `Topic.parse/1` accepts three shapes; cic's `socket.ts` only ever joins two of them

`grappa_channel.ex:135-139` documents three accepted topic shapes:
`grappa:user:{user}`, `grappa:user:{user}/network:{net}`,
`grappa:user:{user}/network:{net}/channel:{chan}`. cic's `socket.ts`
exposes `joinUser` (user shape) and `joinChannel` (channel shape) at
lines 92-105 + 107-124, plus a comment "joinNetwork is reserved
infrastructure on the server side but has no cicchetto consumer yet"
(lines 88-89). The network-shape topic accepts joins (no snapshot, see
`grappa_channel.ex:220-224`) but cic never connects to it. Either
remove the network-shape support server-side until a real consumer
lands, or wire the consumer (presence per network, MOTD on per-user
topic moved here, etc.). Dead port.

### M8 — No version-skew handling: cic's `WireEvent` arm names are restated; a renamed event would silently drop

If the server renamed `kind: "channels_changed"` to `"channel_set_changed"`
(or similar), cic's `narrowUserEvent` switch would land in the default
arm and call `console.warn("[userTopic] dropped malformed payload",
raw)` — which is reasonable but means the channels list goes stale
silently. No "received unknown event kind X — please refresh"
mechanism. The bundle-hash protocol would catch this if the event
rename rode a deploy that bumped the cic bundle, but the protocol
relies on `cicchetto-build` having been run AND the operator hitting
`POST /admin/cic-bundle-changed` — it doesn't auto-detect "server is
ahead of cic" without the bundle pipeline cooperating.

**Fix:** Document the pattern; keep the bundle-hash protocol as the
operational answer. Long-term: a `min_cic_bundle_hash` field on
user-topic join push that cic checks against `bootBundleHash` and
surfaces a banner if too old.

## LOW

### L1 — `socket.ts` push-helpers are 14× near-identical fire-and-forget shapes

`socket.ts:204-321` defines 14 push helpers (`pushChannelOp`, `pushChannelDeop`,
`pushChannelVoice`, ..., `pushChannelInvite`, `pushChannelMode`,
`pushChannelTopicSet`, `pushChannelTopicClear`, `pushWho`, `pushNames`,
`pushWhois`). Each one is the same 3-line shape: null-check, push, return.
Could collapse to a single `pushChannelVerb<K extends string>(verb: K,
payload: ...)` with a discriminated union over verb name. Cosmetic; current
shape is greppable.

### L2 — `pushWatchlist*` helpers reject with raw `unknown` from `receive("error", err)`

`socket.ts:336-360` — three watchlist push helpers reject with the raw
server-error term. The shape from `GrappaChannel.handle_in("watchlist",
...)` is `{:error, %{reason: "..."}}` so cic's reject value is
`{reason: "..."}` — but typed as `unknown`. Callers can't type-narrow.
Compare with `pushAwaySet`/`pushAwayUnset` (lines 150-173) which wrap
with `new Error(String(err))` — at least an Error instance.

**Fix:** Wrap consistently. Tiny; not load-bearing.

### L3 — `validate_target_name` vs `validate_post_target_name` divergence opaque to cic

`messages_controller.ex:69` uses `validate_target_name` (allows
`$server`); `:124` uses `validate_post_target_name` (rejects `$server`,
W1 fix). cic doesn't know about this rule — could attempt a POST to
`$server` and get a 400 with no specific code. The asymmetry is
documented in `validation.ex` but cic could helpfully short-circuit
client-side ("server messages window is read-only").

**Fix:** Tiny client-side guard in `compose.ts` — refuse to send to
`SERVER_WINDOW_NAME`. Trivial; defense in depth.

### L4 — `ArchiveJSON` uses string keys (`"target"`, `"kind"`, ...) instead of atom keys

Every other Wire/JSON module in the codebase uses atom keys (Jason converts
to strings on output). `archive_json.ex:21-31` uses string keys explicitly
— inconsistent stylistic outlier. Cosmetic.

### L5 — `WireEvent` `joined`/`join_failed`/`kicked` arms carry `state:` field that's redundant with `kind`

`session/wire.ex:113-141` — `joined_payload` has `state: String.t()` (always
`"joined"`); same for `window_pending` (`"pending"`), `join_failed`
(`"failed"`), `kicked` (`"kicked"`). The `state` field duplicates `kind`
minus the underscore; cic dispatchers ignore it. Adding `state:` was a CP15
B5 design choice (subscribe.ts:108-124 mirrors); the redundancy is harmless
but represents one more piece of the wire that has to stay in sync for
zero benefit.

**Fix:** Drop `state:` from these payloads — cic dispatches purely on
`kind`. No effective change. Defer to a future cleanup cluster.

### L6 — `query_windows_list` payload key shape is integer→list, but JSON keys are strings (cic coerces)

`Session.Wire` is the wire-source-of-truth pattern but the query-windows
list payload `windows: %{integer() => [windows_entry()]}` ships as
JSON object → cic does `parseWindowsMap` (userTopic.ts:40-51) to coerce
string→Number. Mild leak of "JSON makes everything a string" into the
cic store layer. Documented at api.ts:217-219 ("server-side `windows_map`
keys on integer `network_id`; on the wire JSON keys are strings").

**Fix:** Could ship `windows: [{network_id, entries}]` (array of
records) so the cic side can stop coercing. Cosmetic; current shape works.

### L7 — `notifyClientClosing()` on cic uses `_userChannel` module-let; rotation could leak prior channel ref

`socket.ts:47, 104, 138-141` — `_userChannel` is a module-singleton
holding the last `joinUser` channel. On token rotation the createEffect
disconnects the socket but doesn't null out `_userChannel`. Subsequent
`pagehide` between `setToken(null)` and the next `setToken(t)` could
push `client_closing` on a dead channel. Phoenix's `push` on a torn-down
channel is a no-op (returns a Push that never resolves) — benign, but
the variable is incorrectly named.

**Fix:** Null `_userChannel` in the createEffect's `t === null` arm.

### L8 — `auth.ts.bootstrapAuth()` order: cic must call it before any module-import-time `api` call

The on401 handler is wired by `bootstrapAuth()` which is called from
`main.tsx`. If a future module-load-time call to `api.foo()` ever fires
BEFORE `bootstrapAuth()` runs, that call's 401 won't clear the token.
M-cic-6 captures the rationale; the fragility is real but small.

**Fix:** Document at the top of `auth.ts` (already there). Could enforce
via a check in `setOn401Handler` ("cannot register null after first call"
etc.). Defer.

## Unification opportunities

### U1 — Shared `Grappa.Wire.Time` helper for ISO-8601 conversion

**Today:** `Networks.Wire` defines a private `iso8601_or_nil/1`
(networks/wire.ex:257-258); `Accounts.Wire` and `Visitors.Wire`
return raw `%DateTime{}` (relying on Jason); `Session.Wire.topic_changed`
passes through raw entries. Three patterns, one concern.

**Unification:** Extract `Grappa.Wire.Time.iso8601_or_nil/1` (and
optionally `Time.unix_ms_or_nil/1` for the millisecond-int fields like
`message.server_time`). Every Wire module imports + uses. Remove all
inconsistency in one cluster.

**Cost:** ~10 minutes. Benefit: every Wire's typespec accurately reflects
the wire bytes; one place to change if we ever migrate to RFC3339 with
nanosecond precision or whatever.

### U2 — Codegen TS unions from server-side closed sets

**Today:** Multiple closed sets are restated on both sides with no
machine-checked link:
- `Scrollback.Message.kinds()` (10 values) ↔ `MessageKind` (api.ts:187)
- `Credential.connection_states()` (3 values) ↔ split across two cic types
- `Networks.Wire.channel_json.source` (`:autojoin | :joined`) ↔ `ChannelEntry.source`
- `Session.Wire.wire_event_kind` (12 values) ↔ `WireEvent` + `WireUserEvent`
- `Scrollback.Meta` per-kind shape table (5 distinct) ↔ untyped `Record<string, unknown>`

**Unification:** A small `mix grappa.gen.cic_types` task that walks
each `*.Wire` module via `@type` introspection (or a registered
attribute) and emits `cicchetto/src/lib/api.gen.ts`. cic imports from
the generated file; the manual `api.ts` re-exports. CI gate ensures
the generated file is up to date. The `meta` shape table is the
biggest win (M3) — the rest are smaller but cumulative.

**Cost:** ~1 day to write the task + plumbing. Benefit: every closed
set drifts at compile time, not at "I noticed a runtime bug."
Recommend after the channel-client-polish + image-upload clusters
land — the codebase is moving fast right now and a generator would
be churned by every other commit.

### U3 — Single `wireNarrow` module mirroring every WireEvent + WireUserEvent kind

**Today:** `userTopic.ts:62-169` defines `narrowUserEvent` for the
user-topic union. `subscribe.ts` does NOT narrow per-channel events
(H4 above). One module is hardened; the other is not.

**Unification:** Move `narrowUserEvent` to `lib/wireNarrow.ts` and
add `narrowChannelEvent` for the per-channel union. Every channel
handler calls `narrowChannelEvent(payload)` instead of trusting the
unsafe cast. Same defensive boundary as the user-topic side.

**Cost:** Half a day; tiny test surface. Benefit: same as the
existing user-topic gate — known-good runtime shape per arm,
malformed payloads land in `console.warn` instead of corrupting
state silently. Pair with U2 to generate the narrowers from the
union types so they can never drift from the dispatch arms.

### U4 — Single error-envelope contract: pick `{error: token, info: {...}}` everywhere

**Today:** Three error envelopes coexist —
- `{error: "<token>"}` from FallbackController for atom errors
- `{error: "<token>", site_key, provider}` from FallbackController for captcha_required
- `{error: "<token>"}` + `Retry-After` header for rate-limit / circuit
- `{errors: %{detail: "..."}}` from ErrorJSON (Phoenix template)
- `{errors: %{<field> => [msg]}}` from FallbackController changeset arm

cic's `readError` (api.ts:369-386) handles the first three OK, falls
through to statusText for the last two. The fifth one (changeset) is
the most user-relevant and the most broken.

**Unification:** Single envelope:

```elixir
%{error: "<token>", info: %{...optional details}}
```

`info` carries `site_key`/`provider` for captcha, `retry_after` for
rate-limit, `fields: %{<f> => [msg]}` for changesets, etc. cic narrows
on `error` token, reads typed `info` per token. Remove `errors` /
`detail` paths entirely. Rendering 404/500 templates needs adjustment
but those are operator-facing surfaces; a tagged token is fine.

**Cost:** 2-3 hours; touches `error_json.ex`, `fallback_controller.ex`,
cic's `readError` + `friendlyMessage` + Login captcha-narrow. Benefit:
single source of truth at the wire; cic types the `info` per error
token via discriminated union; validation errors stop being silently
unparseable.

### U5 — One Wire module per context — but `Topic.parse/1` is the only "wire shape" not in a Wire module

`Grappa.PubSub.Topic` defines the topic-string parser/builder. It's
a wire shape (the topic IS what cic's `joinChannel` constructs as a
string), and the validators `Topic.user/1` / `Topic.channel/3` /
`Topic.network/2` are the canonical builders. cic's
`socket.ts:107-124` builds the channel-topic string by hand:

```ts
const topic = `grappa:user:${userName}/network:${networkSlug}/channel:${channelName}`;
```

Server-side: `Topic.channel/3` does the same string construction.
**Two builders** for one wire shape; a future change (URL-encoding
non-ASCII channel names, etc.) needs to land in both.

**Unification:** Codegen `Topic.user/1` etc. as TS functions in the
same generated file U2 produces. Or expose them via a wire-spec
endpoint. Or just hardcode a comment pointing back to `Grappa.PubSub.Topic`
on the cic side (cheapest; current state is essentially this).

**Cost:** Zero today; pin via comment + test. Real unification
arrives with U2.

## Summary

- **0 CRITICAL, 5 HIGH, 8 MEDIUM, 8 LOW**
- **Top 3 drift findings:**
  1. **H1** Login.tsx `captcha_provider_unavailable` arm is dead code
     (server emits `service_degraded`) — silent UX degradation when
     the captcha provider's site-verify endpoint is unreachable.
  2. **H2** Validation errors lose all field-level info on cic; the
     `errors:` envelope from `format_changeset_errors` is unparseable
     and collapses to "Unprocessable Entity" statusText.
  3. **H4** Per-channel WS events are not runtime-narrowed; only
     user-topic events are. A malformed `members_seeded` push can
     corrupt store state silently — same gap that motivated cic M1's
     fix on the user-topic side.
- **Top 3 unification opportunities:**
  1. **U2** Codegen TS unions from server-side closed sets
     (`Message.kinds`, `Wire.wire_event_kind`, `Meta` per-kind shapes,
     etc.) — the highest-leverage drift-killer for the next year of
     development. Pair with U3 (generate runtime narrowers from the
     same source).
  2. **U4** Single `{error, info}` envelope server-side — stops
     validation errors being unparseable, makes captcha + rate-limit
     + admission errors all share one shape, kills H2 and tightens
     H1.
  3. **U1** Shared `Grappa.Wire.Time` helper — every Wire module
     produces ISO-8601 strings consistently; typespecs match the wire
     bytes. Cheap; just discipline.
