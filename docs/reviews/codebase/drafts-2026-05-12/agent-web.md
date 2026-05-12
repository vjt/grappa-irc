# Codebase Review Draft — Web (Phoenix layer)
**Agent:** web/
**Scope:** lib/grappa_web/** (endpoint, router, controllers, channels, plugs, JSON views)
**Date:** 2026-05-12

## CRITICAL

### S1. WHOIS dispatched through `dispatch_ops_verb/2` rejects visitor subjects despite explicit moduledoc carve-out
**File:** `lib/grappa_web/channels/grappa_channel.ex:445-454`
**Category:** Logic bug / contract violation
**Severity:** CRITICAL

The "whois" `handle_in/3` clause comment explicitly says: *"visitors not rejected here (WHOIS is a read-only query and the visitor session is allowed to issue it… `dispatch_ops_verb` IS used to short-circuit the visitor path — but that's wrong for WHOIS; use the user-only form-and-call helper instead."*

The author flagged the bug in the comment but then implemented exactly the rejected path (`dispatch_ops_verb(socket, fn user -> Session.send_whois(...))`). Visitor sockets calling `/whois <nick>` will be rebuffed with `{:error, %{reason: "visitor_not_allowed"}}` despite the documented intent.

**Fix:** Replace `dispatch_ops_verb(...)` with a visitor-aware helper that resolves the subject (user OR visitor), looks up the running session, and calls `Session.send_whois/3`. Or, more simply, factor a `dispatch_subject_verb/2` that accepts both subject kinds and rejects only on `:no_session`. The existing `dispatch_ops_verb` is the wrong primitive here because the VERB itself is read-only.

---

## HIGH

### S2. `archive_json.ex` handcrafts wire shape with string keys instead of delegating to a `Grappa.Scrollback.Wire` module
**File:** `lib/grappa_web/controllers/archive_json.ex:16-33`
**Category:** Wire-shape ownership / leaky abstraction
**Severity:** HIGH

The CP15 B6 finding (and CLAUDE.md "Wire conversion is per-context responsibility") mandates that JSON views call `Grappa.{Context}.Wire.to_wire(struct)` rather than handcrafting field shapes inline. Every other JSON view (`MessagesJSON`, `NetworksJSON`, `ChannelsJSON`, `MeJSON`, `AuthJSON`) delegates correctly. `ArchiveJSON` re-implements the per-entry conversion (including `Atom.to_string(kind)`) inside the view module. Drift class: when the archive entry shape evolves (a new `kind` value, a new field), the change must land in two unrelated places.

Additionally, `ArchiveJSON` uses **string** keys (`"target"`, `"kind"`, `"last_activity"`, `"row_count"`, `"archive"`) while every other JSON surface uses **atom** keys (Jason encodes both to JSON-string keys, but the convention split is invisible to wire consumers and confusing to the next maintainer).

**Fix:** Introduce `Grappa.Scrollback.Wire.archive_entry_to_json/1` (or similar). Move the `kind` atom-to-string conversion + field selection there. Have `ArchiveJSON.index/1` map over entries via the wire module. Switch to atom keys for consistency.

### S3. `MembersJSON.index/1` returns context-shape directly without a `Wire` module — boundary leak
**File:** `lib/grappa_web/controllers/members_json.ex:18`
**Category:** Wire-shape ownership / boundary discipline
**Severity:** HIGH

Same shape as S2 but inverted: `MembersJSON.index/1` returns `%{members: members}` where `members` is the literal `Session.member()` shape from the context boundary. There is NO `Grappa.Session.Wire.members_to_json/1` module — the wire shape *is* the storage shape. CLAUDE.md is explicit: "PubSub broadcast + Channel push payloads MUST be JSON-encodable — convert structs to wire shape via a context-owned `*.Wire` module… Raw `%Schema{}` structs over PubSub crashed Phoenix's `fastlane!/1` at the WS edge during fan-out (CP15 B6 finding)." The same rule applies to REST views: the wire shape is a CONTRACT and lives in the context's Wire module, not in the JSON view.

Today this works because `Session.member()` happens to be `%{nick: String.t(), modes: [String.t()]}` — Jason-encodable plain maps with no struct wrappers. But the contract is implicit: a future refactor that wraps the member tuple in a struct (e.g. for membership-time tracking, or to add `:join_time`) would silently leak Elixir-internal fields onto the wire AND crash the channel-side `members_seeded` broadcast (which uses the same `Session.Wire.members_seeded/3` payload).

**Fix:** Move the member shape contract into `Grappa.Session.Wire.member_to_json/1`. Have `MembersJSON.index/1` and `Session.Wire.members_seeded/3` both delegate. Single source of truth.

### S4. `MembersJSON` envelope: REST returns `%{members: [...]}` but channel `members_seeded` broadcast unwraps differently — drift hazard
**File:** `lib/grappa_web/controllers/members_json.ex:18` vs `lib/grappa/session/wire.ex` (`members_seeded/3`)
**Category:** REST/Channel contract divergence
**Severity:** HIGH

`MembersJSON.index/1` ships `%{members: [...]}`. The channel broadcast `members_seeded` (per `push_members_if_seeded/4` in `GrappaChannel`) ships a different envelope (`%{kind: "members_seeded", network: ..., channel: ..., members: [...]}`). Two paths, same domain event, two shapes. A cic refactor that uses one and not the other will silently miss fields. CLAUDE.md "One feature, one code path, every door" — the per-member shape MUST be identical at both REST and Channel; the envelope can differ but should be derived from one source.

**Fix:** Establish `Session.Wire.member_to_json/1` for the per-member shape. Have both REST view and channel push delegate. If the inner per-entry rendering is identical, drift becomes structurally impossible.

### S5. `cic_bundle_changed` broadcast skips visitor sockets entirely
**File:** `lib/grappa_web/controllers/admin_controller.ex:69` + `lib/grappa_web/channels/user_socket.ex:62-68`
**Category:** Coverage gap / correctness
**Severity:** HIGH

`AdminController.cic_bundle_changed/2` iterates `WSPresence.list_user_names()` to broadcast the new bundle hash on every live user-topic. But `UserSocket.connect/3` only registers `WSPresence` for non-visitor sockets (the `unless String.starts_with?(user_name, "visitor:")` guard at line 63). Visitor sockets never appear in `WSPresence.list_user_names()`, so visitors never receive the bundle-hash live broadcast — they're stuck on the bundle baked into the page they loaded until they reconnect.

The `push_bundle_hash/1` on user-topic join (called BEFORE the visitor early-return in `push_user_snapshot/2`) papers over this on RECONNECT but not on the live deploy push. Visitors with a long-lived tab (Mode-3 NickServ-IDP visitors can stay logged in for the visitor TTL) won't see the refresh banner trigger.

**Fix:** Either (a) decouple the broadcast list from `WSPresence` (use a Phoenix.PubSub subscriber count or `Phoenix.Tracker` keyed on user_name including visitors) or (b) have `UserSocket.connect/3` register visitors in `WSPresence` too with a `kind: :visitor` tag so visitor branches that need to be skipped (auto-away timer) can filter explicitly while broadcast paths can include them.

### S6. `topic_set` `with`/`else` ambiguity — error-mapping order is correctness-critical and not exhaustive
**File:** `lib/grappa_web/channels/grappa_channel.ex:528-544`
**Category:** Pattern-match correctness
**Severity:** HIGH

```elixir
with true <- Identifier.safe_line_token?(channel) and Identifier.safe_line_token?(text),
     false <- visitor?(user_name),
     ...
else
  false -> {:reply, {:error, %{reason: "invalid_line"}}, socket}
  true -> {:reply, {:error, %{reason: "visitor_not_allowed"}}, socket}
  ...
```

The `else` clauses match by VALUE not by SOURCE — `false` could come from either a `safe_line_token` failure OR (in a future edit) any other clause that returns `false`. The current mapping happens to work because the two boolean checks are in a fixed order, but adding any new boolean check above either site silently flips the error message a client receives. The pattern is brittle and depends on reading-order convention.

**Fix:** Use explicit tagged tuples — `with {:safe, true} <- {:safe, Identifier.safe_line_token?(...) and ...}, {:visitor, false} <- {:visitor, visitor?(user_name)}, ...` so each `else` clause unambiguously handles ONE failure source. Or split into a guard-helper that returns `{:error, :invalid_line}` / `{:error, :visitor_not_allowed}` and keep the `with` chain pure-`{:ok, _}`/`{:error, _}` shape (matches every other handler).

### S7. Channel inbound payload validation accepts arbitrary `target_nick`/`mask`/`channel` strings — no IRC-syntax check at the boundary
**File:** `lib/grappa_web/channels/grappa_channel.ex` (most `handle_in/3` clauses except `topic_set`)
**Category:** Boundary validation / wire-injection defense in depth
**Severity:** HIGH

`open_query_window`, `close_query_window`, `op`/`deop`/`voice`/`devoice`, `kick`, `ban`/`unban`, `invite`, `whois`, etc. all accept `target_nick`/`channel`/`nick`/`mask` as bare `is_binary(...)` with no IRC-shape validation. Only `topic_set` (line 531) gates on `Identifier.safe_line_token?/1`. Defense in depth lives downstream in `Session.send_*` + `IRC.Client`, but the channel boundary is the OUTER untrusted-input surface — a malformed or `\r\n`-laced payload should be rejected here before crossing the GenServer hop. The REST surface does this rigorously via `GrappaWeb.Validation.validate_channel_name/1` + `validate_target_name/1`; the Channel surface does not.

**Fix:** Add a `validate_*` guard at the head of every `handle_in/3` for fields that go upstream as IRC tokens. Reuse `Grappa.IRC.Identifier.{valid_channel?, valid_nick?, safe_line_token?}` like the REST controllers do. The `GrappaWeb.Validation` helpers can extend to a `validate_for_channel/2` family — same hammer, both nails.

### S8. `MembersJSON` produces empty `[]` from a successful `Session.list_members/3` "channel exists, no members" — indistinguishable from "no session"
**File:** `lib/grappa/session/...` (boundary contract — surfaces here at `lib/grappa_web/controllers/members_controller.ex:41`) & `lib/grappa_web/channels/grappa_channel.ex:822`
**Category:** API contract ambiguity
**Severity:** HIGH (as noted in `project_names_ux_silent_bugs` carry-forward — already an open issue)

Memo (`project_names_ux_silent_bugs`) explicitly tracks: "cold-load no-selection empty members aside" + "joined-target /names silent". Per `push_members_if_seeded/4` line 822, an empty list is treated as "no cache" and silently skipped. This reduces a post-NAMES empty channel and a pre-NAMES uninitialized state to the same wire signal. The REST `members` endpoint has the same property — `Session.list_members/3` returning `{:ok, []}` is ambiguous.

**Fix:** Differentiate `{:ok, :uninitialized}` (no NAMES burst yet) from `{:ok, []}` (NAMES completed, channel is empty) at the `Session.list_members/3` boundary. Both REST and Channel paths can then surface accurately. (This is the correct close for the open project memo.)

---

## MEDIUM

### S9. `LoopbackOnly` plug emits hand-rolled JSON body instead of going through `FallbackController`
**File:** `lib/grappa_web/plugs/loopback_only.ex:37`
**Category:** Wire-shape consistency / DRY
**Severity:** MEDIUM

```elixir
conn |> send_resp(403, ~s({"error":"loopback_only"})) |> halt()
```

`FallbackController` is the documented single source of truth for all `{"error": "..."}` envelope bytes (per its moduledoc: *"Don't introduce a different envelope (`%{message: ...}`, `%{code: ...}`) for any sub-class — consistency at the wire is more valuable than per-error nuance"*). `Plugs.Authn` correctly delegates via `FallbackController.call({:error, :unauthorized})`. `LoopbackOnly` does not — it inlines the JSON byte string with `~s(...)`. Two emitters of the `%{error: ...}` envelope = drift class.

**Fix:** Add `{:error, :forbidden_loopback}` (or reuse `{:error, :forbidden}`) to `FallbackController` and dispatch through it. Mirror the `Authn.unauthorized/1` pattern.

### S10. `AuthController.maybe_disconnect_socket/1` falls through silently on unknown subject shapes
**File:** `lib/grappa_web/controllers/auth_controller.ex:192`
**Category:** Defensive code hides bugs
**Severity:** MEDIUM

`defp maybe_disconnect_socket(_), do: :ok` is a catchall after the user/visitor branches. Per CLAUDE.md "Defensive programming hides bugs" + the M-web-1 invariant ("`:current_subject` is always tagged user|visitor"), an unknown subject here is an invariant violation worth crashing on. Same rationale applies to `maybe_terminate_sessions(_)` at line 183. If the subject discriminator gains a third tag in a future refactor, both fall through silently — the logged-out user keeps their live socket AND keeps their session running. Failure is silent; recovery is impossible without a reproducer.

**Fix:** Drop the catchall fallback clause. Pattern-match exhaustively on `{:user, _}` and `{:visitor, _}`; let an unknown shape `FunctionClauseError` so a future tag is a loud compile-time invariant signal (matching `FallbackController`'s "intentionally raise on unknown error shapes" posture).

### S11. `MeController.show/2` defensive fall-through clause for missing `:current_subject` is unreachable when pipeline is correct
**File:** `lib/grappa_web/controllers/me_controller.ex:34`
**Category:** Defensive code hides pipeline bugs
**Severity:** MEDIUM

The `_ -> {:error, :unauthorized}` clause documents itself as a guard against "`/me` mounted outside `:authn`, or a future subject kind added without updating this controller" (W8). For the pipeline-misconfigured case, a uniform 401 silently returns the wrong status (the route IS mis-configured — should crash visibly). For the future-subject case, you want a `FunctionClauseError` 500 that screams in the operator log so the developer adding the new subject kind notices the controller too.

The W8 rationale — "uniform 401 via FallbackController, not a `KeyError` 500" — optimizes for end-user UX but trades operator-debuggability. Per CLAUDE.md "Let it crash is the rule" + "Defensive programming hides bugs", removing the fallthrough is the right call.

**Fix:** Drop the `_ -> {:error, :unauthorized}` clause. Pattern-match on the two known subject shapes only.

### S12. Endpoint `signing_salt` placeholder noted as smell but no Phase 5 ticket reference
**File:** `lib/grappa_web/endpoint.ex:13-22` (moduledoc)
**Category:** Tracking gap (per scope: flag absence of plan tracking)
**Severity:** MEDIUM

The moduledoc acknowledges the placeholder as "a smell + a footgun for the Phase 5 hardening pass" but doesn't link to a `docs/todo.md` line or a Phase 5 plan task. Verify the rotation work is tracked. If it's not in todo, add it.

**Fix:** Cross-reference the open Phase 5 hardening line in todo.md or `docs/plans/`. If not tracked, add an entry: "rotate `:session_signing_salt` from `"rotate-me"` placeholder via `SECRET_SIGNING_SALT` env at runtime release boot."

### S13. `GrappaChannel.handle_in("client_closing", ...)` uses `unless` and ignores potential `WSPresence.client_closing/2` errors
**File:** `lib/grappa_web/channels/grappa_channel.ex:236-244`
**Category:** Code shape + error swallow
**Severity:** MEDIUM

`unless visitor?(user_name) do … end` returns `nil` when the guard fires, then the handler returns `{:noreply, socket}`. `WSPresence.client_closing/2` is asserted to return `:ok` (`:ok = WSPresence.client_closing(...)`) but a future refactor that returns `{:error, _}` would crash the channel — which kills the WS for the user even though `client_closing` is a fire-and-forget pagehide hint. The intent is clearly "best-effort hint."

**Fix:** Replace `unless` with `if/do/else`. Wrap the WSPresence call to ignore non-`:ok` returns (or document via `@spec` that it's `:ok`-only and remove the assertion). Best-effort hints shouldn't crash the WS.

### S14. `handle_in("watchlist", "list", ...)` and friends — no length cap on `pattern` field
**File:** `lib/grappa_web/channels/grappa_channel.ex:644-656` + `lib/grappa/user_settings.ex` (boundary)
**Category:** Boundary input cap missing
**Severity:** MEDIUM

`pattern` arrives via WS, is asserted `is_binary/1`, prepended to a list, persisted to `user_settings`. No max-length cap, no count cap on the watchlist itself. A misbehaving client can submit `String.duplicate("x", 10_000_000)` and store it; the next read materializes 10MB into the WS frame on next push. Symmetric ask: what's the per-user cap on pattern count? Memory: the watchlist is "no cap" per spec #19, but UNCAPPED at the WIRE level is different from "no functional limit on what the user can WATCH."

**Fix:** Cap `byte_size(pattern) <= 256` (or operator-set ceiling) at the channel boundary. Cap total patterns per user at the `UserSettings.set_highlight_patterns/2` boundary. Reject 400-equivalent at the boundary, not at storage time.

### S15. `parse_cursor`/`parse_limit` in `MessagesController` are duplicates of similar logic that probably exists elsewhere
**File:** `lib/grappa_web/controllers/messages_controller.ex:149-165`
**Category:** Duplication candidate / future drift
**Severity:** MEDIUM

These integer-string parsers are inline. If any other controller adds pagination (Archive doesn't paginate today; QueryWindows might in the future), it'll re-implement the same `Integer.parse(s)` + `{n, ""}` shape. Moving this into `GrappaWeb.Validation` (the documented home for "boundary-shape validators shared by the JSON REST controllers") prevents future copy-paste.

**Fix:** Extract `parse_positive_integer/1` + `parse_optional_integer/1` into `GrappaWeb.Validation`. Both `MessagesController.parse_cursor/parse_limit` callers + future paginators delegate.

### S16. `NetworksController.spawn_session_after_connect/3` swallows admission errors silently
**File:** `lib/grappa_web/controllers/networks_controller.ex:196-214`
**Category:** Silent failure / asymmetry with PATCH semantics
**Severity:** MEDIUM

When `PATCH /networks/:network_id` transitions to `:connected`, the orchestrator may reject (cap exceeded, circuit open). The controller logs a warning and returns `:ok` to the caller — the credential row was updated (`:connected`) but the session is NOT spawned. The client got 200, navigates to the network, sees no live state. There's no observable signal that the spawn failed. Per CLAUDE.md "Silent retries mask root causes" (the `feedback_silent_retry_anti_pattern` memory) — this is the same anti-pattern at the REST layer.

The justification ("DB row is `:connected` (user intent persisted). Bootstrap or the next operator `/connect` will retry.") is fine for the **state**, but the client deserves a hint. Even a `connection_state: "connecting", admission_pending: true` would be clearer than silent success.

**Fix:** Either (a) pass the spawn rejection through to the response body (`%{credential: ..., spawn_error: "network_busy"}`) so cic can render a banner, or (b) emit a PubSub event on the network topic that cic can pick up to surface "bouncer accepted intent but couldn't dial."

### S17. `ChannelsController.delete/2` removes from autojoin AFTER `Session.send_part/3` succeeds — potential inconsistency on PART crash
**File:** `lib/grappa_web/controllers/channels_controller.ex:146-161`
**Category:** Cross-state ordering
**Severity:** MEDIUM

The `with` chain runs `Session.send_part(...)` first, then on success calls `remove_from_autojoin/3` outside the `with` (best-effort). If `remove_from_autojoin` fails (Credentials.remove_autojoin_channel returns `{:error, _}`), the controller logs and returns 202 — but the PART already went out. On reconnect, autojoin re-joins the channel. The user pressed delete, saw success, came back later and the channel is back. CLAUDE.md "Fix root causes, not examples" + "Don't put cross-session state in the session GenServer" — this is the inverse: cross-state mutation needs ordering discipline.

**Fix:** Either (a) remove from autojoin FIRST, then send PART (autojoin removal failure aborts the operation), or (b) wrap both in a transaction-like sequence and surface a `partial_failure: true` if the autojoin removal fails so cic can warn ("disconnected for now but autojoin still has it — reconnect will rejoin").

### S18. `NetworksController.update/2` doesn't preload `network` association on the credential before render
**File:** `lib/grappa_web/controllers/networks_controller.ex:104-112` + `networks_json.ex:46`
**Category:** Implicit precondition / runtime crash hazard
**Severity:** MEDIUM

`NetworksJSON.update/1` doc says: "The `network` association on the credential MUST be preloaded (done by the controller before rendering)." The controller does NOT explicitly preload — it depends on `Networks.connect/1` and `Networks.disconnect/2` (the context functions) to return a credential with `network` already preloaded. If a future refactor of the context strips that preload, this controller silently renders `%Ecto.Association.NotLoaded{}` into the wire shape OR Wire crashes.

**Fix:** Either explicitly `Repo.preload(updated_cred, :network)` here, or move the preload assertion into `Networks.Wire.credential_to_json/1` itself (raise on `NotLoaded`). Better: have the wire function take explicit args (`credential_to_json(credential, network)`) so the contract is positional and unambiguous.

---

## LOW

### S19. `RemoteIP.format/1` doesn't validate the 16-bit range of `hi`/`lo` in the IPv4-mapped clause
**File:** `lib/grappa_web/remote_ip.ex:41-48`
**Category:** Defensive
**Severity:** LOW

`hi` and `lo` are guarded `is_integer/1` only. Bitwise operations on >16-bit integers would produce garbage IPs. In practice `:inet`/Bandit only emits valid 16-bit words here, so the input is trusted. Adding a `hi <= 0xFFFF and lo <= 0xFFFF` guard would document the assumption and crash loudly on bad input.

### S20. `AuthController.format_ip/1` and `user_agent/1` are local thin wrappers
**File:** `lib/grappa_web/controllers/auth_controller.ex:373-384`
**Category:** Cohesion
**Severity:** LOW

`format_ip/1` is a one-line delegate to `RemoteIP.format/1`. `user_agent/1` extracts a header. Both could move into `GrappaWeb.RemoteIP` (and a sibling `GrappaWeb.UserAgent`?) so other controllers that audit IP/UA share one shape. Today only `AuthController` does it; not urgent.

### S21. `GrappaChannel` `handle_info({:after_join, ...})` — third clause is a no-op
**File:** `lib/grappa_web/channels/grappa_channel.ex:220-224`
**Category:** Dead-feeling code (justified, but flag-worthy)
**Severity:** LOW

The `{:network, _, _}` after-join clause exists only to acknowledge the network-level topic doesn't push a snapshot. Could be inlined into the `:after_join` send-decision (skip the `Process.send_after/3` for network topics) so the no-op clause vanishes. Tradeoff: explicit no-op handler is documentation; skipping the send is invisible. Author's call.

### S22. `AdminController.reload/2` failure mode is `text/plain` not `application/json`
**File:** `lib/grappa_web/controllers/admin_controller.ex:55`
**Category:** Wire-shape consistency
**Severity:** LOW

`{:error, msg} -> conn |> put_status(:internal_server_error) |> text(msg)` returns the reloader error verbatim as plain text. Other 500s in the system go through `ErrorJSON`. Operators driving the reload from `docker exec curl` get the raw text — fine for that use case. The `:admin` pipeline accepts both `json` and `text` so this is intentional; LOW-priority for consistency only.

### S23. `Endpoint` module attribute `@session_options` reads compile-env once at module-compile time — correct, but worth a comment about the implication
**File:** `lib/grappa_web/endpoint.ex:30-35`
**Category:** Documentation
**Severity:** LOW

`Application.compile_env!/3` resolves once at compile. Operator rotating `SECRET_SIGNING_SALT` requires a rebuild + redeploy, not a hot reload. Today no code calls `put_session/3`, so this is moot — but the moduledoc could spell out "salt rotation is a cold-deploy event" alongside the existing placeholder rationale. Mirrors the `@visitor_network_slug` rationale in `AuthController`.

### S24. `ResolveNetwork.resolve/2` user-branch nests case-of-case — could flatten with `with`
**File:** `lib/grappa_web/plugs/resolve_network.ex:79-90`
**Category:** Code shape
**Severity:** LOW

The nested case (outer `Networks.get_network_by_slug`, inner `Credentials.get_credential`) reads cleanly but a `with` chain would be flatter and tag the failure source per-branch. Not a bug; idiomatic preference.

### S25. `FallbackController` `format_changeset_errors/1` builds error messages with `String.replace` — works but hides structure
**File:** `lib/grappa_web/controllers/fallback_controller.ex:244-250`
**Category:** Wire shape
**Severity:** LOW

The standard Ecto pattern. Wire consumers see `%{field => [translated_message_strings]}`. Translation happens in-place via `String.replace`. If the message is `"should be at most %{count} character(s)"` with `opts: [count: 50]`, the wire gets `"should be at most 50 character(s)"`. cic can't programmatically branch on the constraint kind. LOW because cic doesn't do per-error-kind UX today.

---

## Summary
- **1 CRITICAL, 7 HIGH, 10 MEDIUM, 7 LOW**
- **Top 3 themes:**
  1. **Wire-shape boundary discipline is leaky.** `ArchiveJSON` (S2) and `MembersJSON` (S3) handcraft wire shapes inside the JSON view module instead of delegating to a context-owned `Wire` module. CP15 B6 established that channel pushes MUST go through Wire; the same rule applies to REST views and is silently broken. Drift class.
  2. **Channel inbound validation is weaker than REST.** `GrappaChannel` accepts most string inputs (`target_nick`, `mask`, `nick`, `channel`) without IRC-shape gates that the REST controllers apply via `GrappaWeb.Validation`. `topic_set` is the lone correct example. (S7)
  3. **Defensive fallthroughs and silent failures hide bugs.** `MeController` fall-through 401 (S11), `AuthController.maybe_disconnect_socket/1` catchall (S10), `NetworksController.spawn_session_after_connect/3` swallowed admission errors (S16), and the WHOIS visitor-rejection regression (S1) all share the "silently degrade rather than crash loudly" anti-pattern that CLAUDE.md and the `silent_retry` memory both call out.
