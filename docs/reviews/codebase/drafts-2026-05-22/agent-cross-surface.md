# Cross-surface scope — 18 findings (2 CRIT, 5 HIGH, 8 MED, 3 LOW)

Scope: server `*/wire.ex` ↔ cic `lib/*.ts` (api, socket, subscribe, userTopic, *Store, components-that-read-wire-shape). Reviewer focus: drift on field names / event kinds / enums / error envelopes / state-mirror discipline. Per CLAUDE.md: cic NEVER originates state; all PubSub payloads must be JSON-encodable via context-owned Wire modules.

---

### S1. cic `WireAdminEvent` is missing two server-emitted arms (`upload_reaped`, `uploads_swept`)
**Files:** `lib/grappa/admin_events/wire.ex:113-127, 298-317` ↔ `cicchetto/src/lib/api.ts:756-846`, `cicchetto/src/lib/adminEvents.ts:76-97`
**Category:** state-mirror / event-divergence
**Severity:** CRITICAL
Server `Grappa.AdminEvents.Wire` declares + constructs both `:upload_reaped` and `:uploads_swept`. They are actively emitted by `lib/grappa/uploads/reaper.ex:99` (`AdminEvents.record(AdminWire.upload_reaped(...))`) and `:173` (`AdminEvents.record(AdminWire.uploads_swept(n))`) and broadcast on `Topic.admin_events/0`. cic's `WireAdminEvent` union has 13 arms; these two are MISSING. When the Uploads.Reaper sweeps with an admin tab open, every server broadcast lands in `adminEvents.ts:ingest/1`'s `switch` and falls through to `assertNever(ev)` — which throws and unmounts the entire admin-events stream. The audit ring's `feedback_no_silent_drops_closed` invariant ("adding a new union arm walks both sides") is violated.
**Fix:** Add both arms to `WireAdminEvent` in `api.ts` (mirror the typespecs at `wire.ex:113-127`), then add matching `case "upload_reaped":` / `case "uploads_swept":` arms in `adminEvents.ts:ingest/1` that `setEvents((prev) => cap([ev, ...prev]))` like the other audit-eligible kinds, and a `renderEvent` arm in `AdminEventsTab.tsx`.

---

### S2. `WireAdminEvent.capacity_reject.flow` types `"user" | "visitor"`; server emits 5-arm `Admission.flow()` atom
**Files:** `lib/grappa/admission.ex:53-58`, `lib/grappa/admin_events/wire.ex:79-87, 236-251` ↔ `cicchetto/src/lib/api.ts:772-780`
**Category:** wire-drift / closed-union / naming
**Severity:** CRITICAL
Server's `Admission.flow()` is the closed atom union `:login_fresh | :login_existing | :bootstrap_user | :bootstrap_visitor | :patch_network_connect`. `Wire.capacity_reject/5` accepts a bare `atom()` and renders `flow: flow` directly; Jason stringifies the atom verbatim. Cic types it as `flow: "user" | "visitor"` — a complete lie. `AdminEventsTab.tsx:44` renders `${ev.flow} flow rejected` so the operator sees `login_fresh flow rejected` (correct at runtime) but every developer touching the type believes the union has only two values, and a `switch` over it would never branch correctly. Worse: the type lies in the OPPOSITE direction of the typical drift class — cic's narrower type passes `tsc`, but the runtime value is from a 5-arm union the type cannot represent. Symmetric to S6 below (untyped server-string fields on cic side); this one is a wrong typed narrowing.
**Fix:** Either (a) widen cic to the full closed union `type AdmissionFlow = "login_fresh" | "login_existing" | "bootstrap_user" | "bootstrap_visitor" | "patch_network_connect"` and pin it shared with the cic-side renderer, or (b) project flow → subject_kind at the server-side Wire boundary (`flow_to_subject_kind(:login_fresh) -> :user`, etc.) since the cic surface today only renders "user/visitor flow rejected". Option (a) is the cleaner per "Wire conversion is per-context responsibility" — server should not collapse a 5-arm enum for a downstream consumer's convenience.

---

### S3. `cap_counts_changed` broadcast on `admin_events` topic but missing field documented in server typespec — also missing reviewer-flagged `client_id` vs U-3 contract
**Files:** `lib/grappa/admin_events/wire.ex:171-180, 500-533`, `lib/grappa/admin_events.ex:212-232` ↔ `cicchetto/src/lib/api.ts:838-846`, `cicchetto/src/lib/adminEvents.ts:60-70`
**Category:** event-divergence
**Severity:** HIGH
Server's `:cap_counts_changed` typespec carries `network_slug: String.t() | nil`. `AdminEvents.broadcast_lifecycle/3` short-circuits with `:ok` (no broadcast) when `Networks.get_network/1` returns `nil` (S2 of U-5 review). So in practice cic NEVER sees a `null` slug for this kind — but the server typespec and cic type both declare it nullable. Defensive type is fine; the drift is that `AdminEventsTab.tsx:69` renders `${networkLabel(ev.network_slug, ev.network_id)}` which surfaces `net#<id>` for null even though the server guarantees that branch is unreachable. Low-grade: the type-and-renderer tolerate impossible state. Not a bug today but it widens the type beyond what the server contract demands.
**Fix:** Tighten server-side typespec from `String.t() | nil` to `String.t()` on the `cap_counts_changed` arm; mirror in cic. Removes the dead branch in `networkLabel` for this kind.

---

### S4. `away_confirmed.state` typed `"present" | "away"` on both sides but server guard accepts string instead of atom
**Files:** `lib/grappa/session/wire.ex:510-514`, `lib/grappa/session/server.ex:2553` ↔ `cicchetto/src/lib/api.ts:610`
**Category:** closed-union / wire-drift
**Severity:** HIGH
Server `Wire.away_confirmed/2` takes `state` as `String.t()` with `state in ["present", "away"]` guard — i.e. the caller must already have stringified. `Session.Server.handle_*` constructs the string and passes it. The `away_str` is built at the call site; if a new state ever lands (e.g. `:away_explicit`, `:away_auto`), the wire-shape function signature does not enforce it — only the call site does. cic has the right closed union but the server has no type-level coupling between `AwayState.t()` enum and the wire string. The pattern is fragile: per CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped strings", `Wire.away_confirmed` should accept the atom and convert at the wire boundary (mirroring `Atom.to_string(m.kind)` in `Scrollback.Wire.to_json`). 
**Fix:** Change `Wire.away_confirmed/2` signature to take an atom (`:present | :away`) and project to string inside. Callers drop the manual `to_string`. Adds Dialyzer coverage that the call site's state has the right shape.

---

### S5. cic-side `subscribe.ts` and `userTopic.ts` BOTH narrow + dispatch `joined`/`join_failed`/`kicked` payloads; duplicate per-arm narrowers
**Files:** `cicchetto/src/lib/userTopic.ts:376-419` + `cicchetto/src/lib/wireNarrow.ts:185-222` ↔ same server `Session.Wire.{joined, join_failed, kicked}` types
**Category:** duplicated-logic / missing-shared-source-of-truth
**Severity:** HIGH
F1 (visitor-parity 2026-05-15) added user-topic dual-broadcast of `joined/join_failed/kicked` to close a subscribe-then-broadcast race. As a result the cic narrowing logic now lives in TWO places: `wireNarrow.ts:185-222` (per-channel topic arm) and `userTopic.ts:376-419` (user-topic arm). Both narrow the SAME wire shape (`Session.Wire.joined_payload`, etc.) byte-for-byte. Any future field add to `Session.Wire.kicked/4` requires two edits in cic, and there is no compile-time enforcement that they stay structurally identical. The cluster F1 design intentionally accepted dual broadcast (idempotent setters) — the narrower duplication is the unwanted side effect.
**Fix:** Extract a single `narrowWindowStateEvent(raw): {kind: "joined"|"join_failed"|"kicked", ...} | null` into `wireNarrow.ts` and call it from both `narrowChannelEvent` and `narrowUserEvent`. The two outer narrowers route to a shared helper; the per-field validation lives once. Reuses the verb, not the noun — same code path for the two delivery routes.

---

### S6. `connection_state_changed.from` / `to` are open `string` on cic; server emits closed `Credential.connection_state()` atom-set
**Files:** `lib/grappa/networks/credential.ex:62, 82`, `lib/grappa/networks/wire.ex:115-125, 293-305` ↔ `cicchetto/src/lib/api.ts:626-636`, `cicchetto/src/lib/userTopic.ts:175-195`
**Category:** closed-union / wire-drift
**Severity:** HIGH
Server enum: `:connected | :parked | :failed`. The wire stringifies the atom; cic `WireUserEvent.connection_state_changed` types `from: string` and `to: string`. Per `feedback_no_silent_drops_closed` every closed union should be mirrored in both surfaces — adding a 4th state (e.g. `:reconnecting` for a future cluster) silently propagates as a stringly-typed value cic accepts everywhere. The `HomeNetworkRow.connection_state` type at api.ts:103-109 IS narrowed to `"connected" | "parked" | "failed"`, so cic has the union — it's just not reused here. `narrowUserEvent` accepts any string for `from`/`to` (line 181-184).
**Fix:** Define a shared `ConnectionState = "connected" | "parked" | "failed"` type at api.ts top-level, replace string fields on `connection_state_changed` + `HomeNetworkRow`, and narrow against the closed set in `narrowUserEvent`. Also tighten `tagNetwork`'s `RawNetwork.connection_state` (currently `CredentialConnectionState | "failed"` — a clumsy way to spell the full union).

---

### S7. `topic_changed` and `channel_modes_changed` use untyped `map()` server-side; cic mirrors with `TopicEntry` / `ModesEntry` types
**Files:** `lib/grappa/session/wire.ex:94-106, 350-364` ↔ `cicchetto/src/lib/channelTopic.ts` (type definitions) + `cicchetto/src/lib/wireNarrow.ts:82-109`
**Category:** missing-shared-source-of-truth
**Severity:** HIGH
Server `topic_changed_payload` declares `topic: map()` and `channel_modes_changed_payload` declares `modes: map()` — totally untyped. The actual shape (text/set_by/set_at for topic; modes/params for modes) is enforced only inside `EventRouter`'s caching code and by cic's `narrowTopicEntry`/`narrowModesEntry` runtime narrowers. A new field added to the EventRouter's topic entry never surfaces a type error; cic just silently drops or under-narrows it. The runtime narrower is the only contract.
**Fix:** Promote `Grappa.Session.EventRouter`'s topic-cache shape + modes-cache shape into typed maps with `@type t :: %{required(:text) => ..., ...}` and reference those types in `Wire.topic_changed_payload` / `Wire.channel_modes_changed_payload`. Then a future add lands at both the server (typespec drift caught) and cic (narrower compile-time check). Currently the server side is an open `map()` and is the weak link.

---

### S8. `WireUserEvent` `joined`/`join_failed`/`kicked` carry redundant `state` field that is also encoded in `kind`
**Files:** `lib/grappa/session/wire.ex:143-173, 437-502` ↔ `cicchetto/src/lib/api.ts:467-483, 693-711`
**Category:** wire-drift / naming
**Severity:** MEDIUM
Every `joined` payload carries `state: "joined"`; every `join_failed` carries `state: "failed"`; every `kicked` carries `state: "kicked"`. The `state` field is fully determined by `kind`. The narrower (`wireNarrow.ts:188`) requires `r.state !== "joined"` to reject — but `kind === "joined"` already guarantees the producer set it. The duplication exists because the WindowState in cic is the `state` value (not the `kind`), but cic's `setJoined/setFailed/setKicked` setters don't even read the field. Pure noise on the wire. A producer mistake setting `kind: "joined", state: "failed"` would be a server bug the narrower partially catches — but a real "single state per kind" enum would catch it at the type level.
**Fix:** Drop `state` from the three payloads at the Wire boundary. cic narrower already discriminates on `kind`. Saves three fields × N broadcasts/day; reduces drift surface.

---

### S9. `MeJSON.show/1` `inserted_at` typespec says `DateTime.t()` but wire emits ISO-8601 string via Jason
**Files:** `lib/grappa/accounts/wire.ex:42-47, 60-62`, `lib/grappa_web/controllers/me_json.ex:50-67` ↔ `cicchetto/src/lib/api.ts:130-156`
**Category:** time-format / naming
**Severity:** MEDIUM
Server's `Accounts.Wire.user_to_json/1` returns `inserted_at: user.inserted_at` (a `DateTime` struct). The typespec declares it `DateTime.t()`. Jason serializes `DateTime` to ISO-8601 via the bespoke encoder. cic correctly types as `inserted_at: string`. But every OTHER wire module (`Networks.Wire`, `Visitors.Wire.t/0`'s `expires_at`) explicitly calls `DateTime.to_iso8601/1` so the typespec accurately reflects what hits the wire. `Accounts.Wire` is the exception — relies on Jason's implicit conversion + a struct-typed typespec.
**Fix:** Update `Accounts.Wire.user_to_json/1` to call `DateTime.to_iso8601(user.inserted_at)` explicitly and tighten the typespec to `String.t()`. Same for `Visitors.Wire.visitor_to_json/1` (`expires_at: v.expires_at` at line 97 — typespec is `DateTime.t() | nil`, wire emits ISO-8601 string via Jason). One pattern across all Wires: atomify-and-stringify at the boundary, never lean on Jason.

---

### S10. Push.subscription wire response field name divergence: server `created_at` / `last_used_at` (string ISO) vs cic-typed `string` but no shared source
**Files:** `lib/grappa_web/controllers/push_subscription_json.ex:30-65` ↔ `cicchetto/src/lib/api.ts:1162-1175` (also `cicchetto/src/lib/push.ts:131-149`)
**Category:** missing-shared-source-of-truth / time-format
**Severity:** MEDIUM
`PushSubscriptionJSON.summary/1` emits `created_at: sub.inserted_at` and `last_used_at: sub.last_used_at` — both `DateTime`-shaped at construction. The typespec declares `DateTime.t() | nil`. Cic types them as `string`. Per S9, same issue. Also: the field name rename `inserted_at → created_at` (server schema → wire) lives only in this view file; there's no Wire module to declare the contract. Same with `endpoint`/`p256dh`/`auth` ↔ server schema `endpoint`/`p256dh_key`/`auth_key` rename. The renames are documented in moduledoc but not enforced.
**Fix:** Either (a) introduce `Grappa.Push.Wire` to centralize the {schema field → wire field} renames + ISO-8601 stringification; or (b) explicitly stringify in the JSON view file. Today the JSON view IS the Wire module by accident — making the naming convention "*_json.ex view OR Wire.ex context module" inconsistent across the codebase. Six other context Wire modules exist; Push is the missing one.

---

### S11. cic-side `Push.subscription` `id` typed `string` is an `Ecto.UUID.t()` server-side — convention drift vs `User.id`
**Files:** `lib/grappa_web/controllers/push_subscription_json.ex:35-50` ↔ `cicchetto/src/lib/api.ts:1162-1175`, `cicchetto/src/lib/push.ts:131-138`
**Category:** naming
**Severity:** LOW
Server typespec says `id: Ecto.UUID.t()`. Cic types as `id: string`. Both correct for the wire (UUID is a 36-char string), but cic could declare a branded `type UUID = string` for clarity and uniformity. Minor — Subject.id, AdminVisitor.id, AdminSession.subject_id all share the pattern.
**Fix:** Optional: define `type UUID = string` once in api.ts; rename strings in admin and push types. Not load-bearing.

---

### S12. `ServerSettings.Wire.upload_view/1` accepts `%{active_host: atom, ...}` but server typespec lies about input shape
**Files:** `lib/grappa/server_settings/wire.ex:66-77` ↔ `cicchetto/src/lib/api.ts:1196-1216`, `cicchetto/src/lib/serverSettings.ts:57-72`
**Category:** wire-drift (server-side only — informational for cross-surface)
**Severity:** MEDIUM
`upload_view/1` declares input as `%{active_host: atom(), per_file_cap_bytes: pos_integer(), global_cap_bytes: pos_integer()}` and outputs strings. cic side correctly types as `"embedded" | "litterbox"`. The cic surface is fine; the drift is server-side — `ServerSettings.public_view/0`'s upload subtree should be exposed as a typed struct, but the input is just `%{} = upload`. As written, a caller can pass `%{active_host: nil}` and the function will `Atom.to_string(nil)` and return `"nil"` to cic. Cic's narrower at `userTopic.ts:298-304` would catch this, but the server should not have a serializer that can encode garbage.
**Fix:** Tighten `ServerSettings.public_view/0` to return a typed struct (or atomic map enforced by a `defp build_public_view/1` constructor with `when active_host in [:embedded, :litterbox]` guards). Reject impossible state at construction, not at the wire.

---

### S13. `AdminVisitor.live_state` and `AdminSession.live_state` aliased to same shape but with optional/required disagreement on `joined_channels`
**Files:** `lib/grappa/live_introspection/admin_wire.ex` (referenced) ↔ `cicchetto/src/lib/api.ts:962-981`
**Category:** wire-drift
**Severity:** MEDIUM
Cic declares one shared `AdminLiveState` type: `joined_channels: string[] | null`. The U-0 honesty rule is that visitor live_state is the whole struct OR null (degraded; the U-0 honesty signal). But within a non-null `AdminLiveState`, the `joined_channels: null` semantically means "introspection failed for this field" (introspection_degraded includes "joined_channels"). There's no docstring or runtime invariant relating the two fields. If `joined_channels === null` while `introspection_degraded === []`, the state is inconsistent — but the type permits it. Server-side typing should mirror this constraint.
**Fix:** Either (a) wrap `joined_channels` access through a helper `wasIntrospectionDegraded(ls, "joined_channels")` predicate so the relationship is checked at one site, or (b) introduce a sum-type-of-sorts on cic: `joined_channels: string[] | "introspection_degraded"` so the relationship is the type. The current shape lets the two fields drift silently.

---

### S14. `archive_changed` event drops `target` field while `archive_purged` carries it; cic codebase commentary explains the split but the two arms are easily confused
**Files:** `lib/grappa/scrollback/wire.ex:159-228` ↔ `cicchetto/src/lib/api.ts:725-734`, `cicchetto/src/lib/userTopic.ts:420-442`
**Category:** event-divergence / naming
**Severity:** LOW
The split between `archive_changed` (PART moved a channel to archive; no `target`) and `archive_purged` (DELETE destroyed scrollback; carries `target`) is principled per the bug-history in `archive_purged_payload`'s moduledoc. cic correctly dispatches both. The risk is naming: `archive_changed` reads as "any change to the archive" — a future contributor adding a DESTRUCTIVE rename verb would be tempted to reuse the lighter `archive_changed` shape. The discriminator is "is this destructive?" but the names don't say so.
**Fix:** Consider renaming `archive_changed` to `archive_list_changed` (no scrollback impact) to make the distinction load-bearing in the name. Minor, cosmetic; the bug-trap is documented in comments today.

---

### S15. `mentions_bundle.messages[*]` uses `sender_nick:` while siblings (`Scrollback.Wire.to_json`) use `sender:`
**Files:** `lib/grappa/session/wire.ex:181-187, 538-547` ↔ `cicchetto/src/lib/api.ts:516-523`
**Category:** naming / wire-drift
**Severity:** MEDIUM
The mentions bundle's per-message shape has `sender_nick: m.sender` while the canonical `ScrollbackMessage` wire has `sender: m.sender`. Server-side moduledoc at `wire.ex:52-58` flags this as a "historical bundle shape" deferred to a "next channel-client-polish cluster". Per CLAUDE.md "Consistency: same problem, same solution" and "Total consistency or nothing", this is a latent inconsistency that should be paid down — every consumer that handles both `ScrollbackMessage` and `MentionsBundleMessage` has to remember which field name to use, and bugs surface at compile time only if they `tsc`-narrow.
**Fix:** Rename `sender_nick` → `sender` in `mentions_bundle_message` typespec + `project_bundle_message/1` builder + cic `MentionsBundleMessage` type + every consumer. One-touch breaking change; ship in a single bucket.

---

### S16. `own_nick_changed` carries `network_id` (integer) while all other Session events carry `network` (slug string)
**Files:** `lib/grappa/session/wire.ex:88-92, 342-345` ↔ `cicchetto/src/lib/api.ts:611`
**Category:** naming / wire-drift
**Severity:** MEDIUM
The Wire moduledoc explains the choice: cic's networks store keys on `id` and the user-level topic is not network-scoped, so the broadcast uses integer ID for direct lookup. Defensible. But it's the lone exception in a wire surface that otherwise consistently uses slug + slug. Cic's `mutateNetworkNick(networkId, nick)` mutates by id; if the broadcaster ever switched to slug, the lookup path becomes O(n) `.find()`. The asymmetry isn't a bug but it's a foot-gun if a developer extends the event with additional fields and forgets the asymmetry. Documenting at the receiver side (`userTopic.ts:559-569`) catches some — not all.
**Fix:** Consider adding `network_slug` ALONGSIDE `network_id` so the contract is "always carries slug; sometimes also carries id for legacy O(1) lookup paths". cic can still mutate by id; future receivers default to slug. Or commit fully to the asymmetry — at minimum, add a typespec note that mentions WHY `network_id` here vs `network` everywhere.

---

### S17. `validate_args` tagged-tuple atoms (`:invalid_channel`, etc.) map to wire strings inside Channel `dispatch_*_verb` arms, but no centralized mapping → drift risk vs FallbackController's `{:error, :bad_request}` envelope
**Files:** `lib/grappa_web/channels/grappa_channel.ex:1146-1153, 1259-1265` ↔ `cicchetto/src/lib/api.ts` (`ApiError.code`)
**Category:** error-shape / duplicated-logic
**Severity:** MEDIUM
The Channel boundary returns `{:reply, {:error, %{reason: "invalid_channel"}}, socket}` from a hand-typed dispatch table. The REST boundary returns `{error: "invalid_line"}` etc. through `FallbackController`. They share atom names BUT they hand-spell the strings independently. Per `feedback_no_silent_drops_closed` + CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped strings", these wire strings should come from a single source. A future rename (`:invalid_channel` → `:malformed_channel`) requires two edits + cic-side update; missing one = silent inconsistency where the WS surface uses one token and REST uses another.
**Fix:** Extract `defp atom_to_wire(:invalid_channel), do: "invalid_channel"` etc. into a shared helper module (e.g. `Grappa.Web.ErrorWire` or fold into `FallbackController`). Channel `dispatch_*_verb`'s `else` arms call the helper. Cic-side error-string-to-action mapping moves into a single switch instead of N call sites.

---

### S18. Channel "reply" envelope is `{:error, %{reason: "..."}}` while REST is `{error: "..."}` — different key
**Files:** `lib/grappa_web/channels/grappa_channel.ex:1146-1153` ↔ `lib/grappa_web/controllers/fallback_controller.ex:68-72` ↔ `cicchetto/src/lib/socket.ts:201-208`, `cicchetto/src/lib/api.ts:903-933`
**Category:** error-shape / wire-drift
**Severity:** MEDIUM
REST error envelope (FallbackController): `%{error: "<token>"}` — flat top-level `error:` key.
WS Channel `handle_in` reply envelope: `{:error, %{reason: "<token>"}}` — `reason:` key, nested under the `{:error, _}` Phoenix reply tuple.
cic's `pushAwaySet` reads `err: unknown` and does `reject(new Error(String(err)))` — opaque stringification, no field extraction. `pushWatchlist*` reads `err: unknown` and rejects opaquely too. So cic CANNOT branch on the reason atom from a WS error reply the way it can from a REST `ApiError.code`. The two surfaces have different shapes for the same conceptual thing.
**Fix:** Unify on `error:` key in both surfaces. Update `dispatch_*_verb` / `topic_set_dispatch` / `away_*_dispatch` to reply `{:error, %{error: "<token>"}}` (and update `with_body_check`'s body_too_large arm). cic Push helpers can then extract `err.error` and reject with a typed Error class mirroring `ApiError`. One envelope shape — no consumer has to remember which surface.

---

## Notes on what was already well-aligned (no findings):

- `WireChannelEvent`/`WireUserEvent` discriminated unions + `assertNever` exhaustiveness — the closed-union enforcement pattern is correctly applied across both surfaces.
- `members_seeded` per-row shape is single-sourced via `Grappa.Session.Wire.member/1`; both REST `MembersJSON.index/1` and the Channel push delegate to the same builder.
- `bundle_hash` and `server_settings_changed` after-join snapshot pushes have parity with their broadcast counterparts (`Cic.Wire.bundle_hash/1` shared; `ServerSettings.Wire.server_settings_changed/1` shared).
- `home_network_state_changed.network` row shape is shared with `home_data.networks[*]` via `Networks.Wire.home_network_row/2` — single edit lands at both consumers.
- `read_cursor_set` payload + bulk `read_cursors` envelope share field name (`last_read_message_id` vs `id`) deliberately; no drift.
- `tagNetwork` boundary fetcher (HIGH-24) closes the missing-discriminator gap on `GET /networks` shape inference at cic.

## Recommended fix order:

1. S1 (CRIT) — unblock admin events for upload deletes.
2. S2 (CRIT) — type the `flow` field correctly before a 6th admission flow lands.
3. S5/S6 (HIGH) — close the dual-narrower and stringly-typed connection_state drift while the closed-union enforcement pattern is fresh.
4. S15 (MED) — pay down the `sender_nick` historical drift; it's load-bearing for "Total consistency or nothing".
5. S18/S17 (MED) — unify error envelopes between REST and WS.
6. Remaining LOW + MED items as bandwidth permits.
