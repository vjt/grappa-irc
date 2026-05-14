# Codebase Review Draft — Web (Phoenix layer)
**Agent:** web/
**Scope:** lib/grappa_web/** (endpoint, router, controllers, channels, plugs, JSON views) + lib/grappa/pubsub*.ex
**Date:** 2026-05-14
**Cluster:** B5 codebase review for `no-silent-drops`

## Summary

| Severity | Count |
| -------- | ----- |
| CRIT     | 0     |
| HIGH     | 4     |
| MED      | 8     |
| LOW      | 6     |
| NIT      | 3     |

**Top themes:**

1. **Silent drops at the broadcast boundary.** `Grappa.PubSub.broadcast_event/2` swallows the underlying `Phoenix.Channel.Server.broadcast` return; `AdminController.cic_bundle_changed/2` fans out N broadcasts in a loop with no per-target accounting; `AuthController.broadcast_disconnect/1` log-and-swallows. Per the cluster theme, every channel/PubSub egress in the web layer needs an audit pass for "did the message actually reach a subscriber, or did we just hand it to the dispatcher and walk away."
2. **Boundary input caps still missing on long-lived persistence paths.** `watchlist add` (S3, carry-forward from CP15 S14) accepts an unbounded `pattern` string. `MessagesController.create/2` accepts an unbounded `body` (only CRLF/NUL-checked downstream). REST + Channel both let a client persist multi-MB rows that materialize on every refetch. Defense-in-depth at the wire boundary is missing.
3. **Public-open trajectory risks.** No `secure_browser_headers`-equivalent in the router pipeline; no rate-limit plug above admission; no per-WS-frame size cap in the Endpoint config; the placeholder `signing_salt: "rotate-me"` is still rotation-deferred to Phase 5. Each is fine for the LAN/loopback default but is a known landmine for the public-open milestone the trajectory is heading toward.

Most CP15 + CP18 + 2026-05-12 web findings are CLOSED in this snapshot — the wire-shape-via-Wire migration (S2/S3/S4), the `topic_set` tagged-tuple `with`-shape (S6), the channel inbound IRC validation (S7), the `:uninitialized` differentiation (S8), and the WHOIS visitor carve-out (S1) all land via CP24 bucket E. New findings below are mostly distinct from the May-12 set.

---

## CRIT

*(none — no auth-bypass, data-leak, or crash class found in the web layer in this pass)*

---

## HIGH

### W-1. `Grappa.PubSub.broadcast_event/2` discards the dispatcher return value — silent-drop entry point at the heart of the streaming surface
**File(s):** `lib/grappa/pubsub.ex:63-67`
**Description:** `broadcast_event/2` calls `Phoenix.Channel.Server.broadcast(__MODULE__, topic, "event", payload)` and explicitly throws away the return via `_ =`, then returns `:ok` unconditionally. The moduledoc justifies this: "Phoenix.Channel.Server.broadcast returns `:ok | {:error, term()}` but the local PG2 adapter (the only one configured for this app) never errors in practice — distributed adapters would. The state-transition is the authoritative effect; a missed broadcast is at most a stale UI badge, not a correctness problem."

This rationale is wrong for the **no-silent-drops** trajectory:

1. **Read-cursor cross-device sync** (CP29 R-Z) depends on the broadcast actually fanning out — a missed broadcast means tab B never moves its cursor and the operator sees stale unread badges across devices forever (not "until next refresh"). Telemetry that the broadcast site swallows is unrecoverable.
2. **Tomorrow's distributed adapter** (when grappa scales beyond one node — Phase 7+) will start surfacing errors here, and the discard means we won't notice until a user complaint. The "PG2 doesn't error today" rationale ages badly.
3. **Phoenix Channel fastlane encoding can fail** even on the local adapter when the payload isn't Jason-encodable — the original CP15 B6 `%Schema{}` crash class. Today the channel-server traps the encoder failure and emits a `:error` log line; a bug like B6 reappears as a silent UI gap with no test signal because the broadcast site says `:ok`.

**Recommended fix:** Surface the dispatcher's `{:error, term()}` to the caller. Update `@spec` to `:: :ok | {:error, term()}`. Telemetry-emit the failure (`:telemetry.execute([:grappa, :pubsub, :broadcast_failed], %{}, %{topic: topic, reason: reason})`). Callers that want to ignore the failure can pattern-match `_ = broadcast_event(...)` explicitly — make the discard a CALLER decision, not a library default. Alternatively keep the `:ok`-only return but ALWAYS emit telemetry on the error path so the silent-drop still lands in Prometheus.

### W-2. `AdminController.cic_bundle_changed/2` fans out N broadcasts with no per-target accounting and no recovery on partial failure
**File(s):** `lib/grappa_web/controllers/admin_controller.ex:60-76`
**Description:** The handler iterates `WSPresence.list_user_names()` and emits `broadcast_event(Topic.user(user_name), payload)` per user. The HTTP response is `text(conn, hash)` — operator sees "ok" regardless of whether 0 or N broadcasts actually reached a subscriber. There's no way to reconcile after the fact:

- If `WSPresence` is briefly unavailable mid-deploy (process crash, supervisor restart), `list_user_names()` returns `[]` and the operator's `deploy-cic.sh` prints "ok hash"; nobody sees the refresh banner.
- If a single `broadcast_event` raises (today it can't because of W-1's silent discard, but if W-1 lands, it would), the iteration stops mid-list and the trailing users miss the push.
- The `for` comprehension produces a list of `:ok` atoms that's then discarded — zero feedback that any specific user got the push.

This compounds with the previous review's S5 (visitor sockets are NOW registered in WSPresence per CP24 bucket E web/S5, but the broadcast still has no acknowledgement signal — the symptom changes from "visitors silently miss bundle hash" to "anyone could silently miss it under partial failure").

**Recommended fix:** (a) Emit telemetry with broadcast counts (`emitted: N, failures: K`) so the deploy script can surface "ok hash · 247 sockets notified" in the operator log. (b) Move the fan-out to a supervised Task so transient `WSPresence` unavailability gets a retry, OR (c) push the bundle-hash signal to a `Phoenix.Tracker`-style state that new joins re-read on connect (post-deploy reconnects already read it via `push_bundle_hash/1` in `GrappaChannel`; the live-deploy push could be a notification-on-state-change instead of a fan-out).

### W-3. `Grappa.PubSub.broadcast_event/2` accepts only `%{}` (struct or map) — silently rejects keyword lists, but no explicit guard fails the test
**File(s):** `lib/grappa/pubsub.ex:64`
**Description:** The function head guards on `%{} = payload` which matches ANY map (including struct values). The CP15 B6 finding established that struct payloads (e.g. `%Window{}`) crash at the fastlane encode site. The guard does NOT prevent passing `%Window{}` here — `%{} = %Window{}` matches. The `Jason.Encoder` derive on the schema may help but is not enforced. The B6 finding was specifically about a struct-shaped payload escaping into the broadcaster; today the broadcaster's contract still permits it.

**Recommended fix:** Tighten the guard to reject struct values: `def broadcast_event(topic, payload) when is_binary(topic) and is_map(payload) and not is_struct(payload)`. Add a Credo check or unit test that asserts `broadcast_event(topic, %SomeStruct{})` raises `FunctionClauseError`. This makes the wire-shape-via-Wire-module rule (CLAUDE.md) enforced at the broadcaster boundary, not just documented.

### W-4. `MessagesController.create/2` and `ChannelsController.topic/2` accept unbounded `body` strings — no byte-size cap at the REST boundary
**File(s):** `lib/grappa_web/controllers/messages_controller.ex:138-159`, `lib/grappa_web/controllers/channels_controller.ex:204-217`
**Description:** Both actions guard on `is_binary(body) and body != ""` with no maximum. `Session.send_privmsg/4` and `Session.send_topic/4` both delegate to `Identifier.safe_line_token?/1` (CRLF/NUL gate) but neither caps length. A malicious or buggy client can POST a 10MB body; it persists into `messages` (sqlite text col, no length constraint per CLAUDE.md "Use `:text` for free-text columns. Don't bake length limits into sqlite — adjust at the schema layer if needed"); every subsequent paginated fetch ships it back over the wire; every channel-broadcast sends it to every subscriber.

IRC's own RFC 1459 / 2812 limit is 512 bytes per line including framing, but grappa is a bouncer and has no incentive to enforce that downstream-of-cic — except that the wire-format eventually has to fit through `IRC.Client` which DOES split on the upstream boundary. Letting a multi-MB body persist into scrollback is still wrong even if the upstream splits the line.

**Recommended fix:** Add `byte_size(body) <= @max_message_bytes` (suggest 4096 or operator-configured) at both controllers' guards; reject with `{:error, :bad_request}` (or a new `:body_too_large` → 413). Mirror at the Channel boundary for `topic_set`'s `text` field. Same rule applies to `kick`'s `reason` field, `away`'s `reason` field, `umode`'s `modes` field — anything that becomes scrollback or upstream-IRC-line bytes.

---

## MED

### W-5. `GrappaChannel.handle_in("away", ...)` doesn't reuse `dispatch_subject_verb/2` or validate `reason` via `safe_line_token?` — duplicates the verb-dispatch shape
**File(s):** `lib/grappa_web/channels/grappa_channel.ex:284-337`
**Description:** Every other ops verb routes via `dispatch_ops_verb/3` or `dispatch_subject_verb/3` (CP24 bucket E web/S7 added the inbound IRC-shape validator at the helper). `away` predates that cluster and is still hand-rolled — it does its own visitor check, its own user lookup, its own `with`/`else` shape. The `reason` string is only checked by the downstream `Session.set_explicit_away/3+4` boundary (the `:invalid_line` mapping at line 305 confirms this); the channel boundary doesn't gate via `validate_args(line: reason)` like `topic_set` does. Consistency loss, not a correctness bug today, but cluster-wide rule "Implement once, reuse everywhere" applies.

**Recommended fix:** Refactor `away` (set + unset variants) to flow through `dispatch_set_away_verb/dispatch_unset_away_verb` helpers that share the `validate_thunk → check_not_visitor → safe_get_user → thunk` chain with `dispatch_ops_verb/3`. The `origin_window` map can ride along as an opt. Once unified, every visitor-check is in ONE place; adding a new visitor-eligible verb in the future requires touching one helper, not N handle_in clauses.

### W-6. `MessagesController.parse_int/1` and `parse_limit/1` return `{:error, :bad_request}` from inside helpers, bypassing `GrappaWeb.Validation`
**File(s):** `lib/grappa_web/controllers/messages_controller.ex:181-198`
**Description:** Per CP15 S15 (still open): pagination integer-string parsers are still inline. `parse_int` and `parse_limit` could move to `GrappaWeb.Validation` as `parse_positive_integer/1` + `parse_limit_with_ceiling/2`. The `@max_http_limit 200` constant is also private to this controller — when QueryWindows or Archive grow pagination, that ceiling will be re-invented.

**Recommended fix:** Extract to `GrappaWeb.Validation`. Add `parse_id_cursor/1` so all 3 cursor params share the int-parse path (and the same error tagging). The `@max_http_limit` becomes a parameter to `parse_limit_with_ceiling/2` so different controllers can pin different ceilings.

### W-7. `Plugs.LoopbackOnly` still hand-rolls JSON envelope bytes (`~s({"error":"loopback_only"})`) — duplicate `error:` envelope emitter
**File(s):** `lib/grappa_web/plugs/loopback_only.ex:37`
**Description:** Carry-forward from CP15 S9 — still open. `FallbackController` is the documented single source of truth for the `%{error: ...}` envelope per its moduledoc. `Plugs.Authn` correctly delegates via `FallbackController.call({:error, :unauthorized})`. `LoopbackOnly` does not. Two emitters of the same envelope = drift class.

**Recommended fix:** Add `{:error, :forbidden_loopback}` (or reuse `{:error, :forbidden}`) to `FallbackController` and dispatch through it. Mirror the `Plugs.Authn.unauthorized/1` pattern.

### W-8. `AuthController.maybe_disconnect_socket/1` and `maybe_terminate_sessions/1` keep their catchall `_ -> :ok` clauses — silently swallow unknown subject shapes
**File(s):** `lib/grappa_web/controllers/auth_controller.ex:183, 192`
**Description:** Carry-forward from CP15 S10 — still open. Per CLAUDE.md "Defensive programming hides bugs" + the M-web-1 invariant ("`:current_subject` is always tagged user|visitor"), an unknown subject here is an invariant violation worth crashing on. If a future refactor adds a third subject tag (e.g. `:listener` for the Phase 6 IRCv3 facade), both fall through silently — the logged-out subject keeps their live socket AND keeps their sessions running.

**Recommended fix:** Drop the catchall fallback clauses on both functions. Pattern-match exhaustively on `{:user, _}` and `{:visitor, _}`; let an unknown shape `FunctionClauseError` so a future tag is a loud invariant signal at the boundary.

### W-9. `MeController.show/2` keeps the defensive `_ -> {:error, :unauthorized}` fall-through
**File(s):** `lib/grappa_web/controllers/me_controller.ex:53-55`
**Description:** Carry-forward from CP15 S11 — still open. Same anti-pattern as W-8. The W8-rationale comment in the moduledoc justifies it as "uniform 401 via FallbackController, not a `KeyError` 500." That trades operator-debuggability for end-user UX. Per CLAUDE.md "Let it crash is the rule" + "Defensive programming hides bugs", removing the fallthrough is the right call.

**Recommended fix:** Drop the `_ -> {:error, :unauthorized}` clause. Pattern-match on the two known subject shapes only.

### W-10. `NetworksController.spawn_session_after_connect/3` swallows admission errors — PATCH returns 200 even when the session never spawns
**File(s):** `lib/grappa_web/controllers/networks_controller.ex:198-216`
**Description:** Carry-forward from CP15 S16 — still open. When `PATCH /networks/:network_id` transitions to `:connected`, the orchestrator may reject (cap exceeded, circuit open). The controller logs a warning and returns `:ok` to the caller — the credential row was updated (`:connected`) but the session is NOT spawned. The client got 200, navigates to the network, sees no live state. There's no observable signal that the spawn failed. This is the silent-drop anti-pattern at the REST layer (mirrors `feedback_silent_retry_anti_pattern` memory).

**Recommended fix:** Either (a) thread the spawn rejection through the response body (`%{credential: ..., spawn_error: "network_busy"}`) so cic can render a banner, or (b) emit a PubSub event on the network topic that cic can pick up to surface "bouncer accepted intent but couldn't dial." The B5 cluster is exactly the right time to land this.

### W-11. `ChannelsController.delete/2` runs PART before autojoin removal — partial failure leaves the channel "deleted from cic, joined on next reconnect"
**File(s):** `lib/grappa_web/controllers/channels_controller.ex:146-194`
**Description:** Carry-forward from CP15 S17 — still open. The `with` chain runs `Session.send_part(...)` first, then on success calls `remove_from_autojoin/3` outside the `with` (best-effort). The autojoin removal failure is logged but the controller returns 202. On reconnect, autojoin re-joins the channel. The user pressed delete, saw success, came back later and the channel is back. Cluster-relevant: the no-silent-drops theme covers this exact "user sees success / system silently failed" class.

**Recommended fix:** Either (a) remove from autojoin FIRST, then send PART (autojoin removal failure aborts the operation), or (b) wrap both in a transaction-like sequence and surface a `partial_failure: true` if the autojoin removal fails. (b) is closer to the cluster's spirit — surface the partial failure rather than hide it.

### W-12. `UserSettings.set_highlight_patterns/2` has no per-pattern byte-size cap and no list-length cap — channel `watchlist add` can persist megabyte-sized patterns
**File(s):** `lib/grappa_web/channels/grappa_channel.ex:769-781`, `lib/grappa/user_settings.ex:200-215`
**Description:** Carry-forward from CP15 S14 — still open at both the channel boundary AND the context boundary. The `validate_patterns/1` helper only checks `byte_size(&1) > 0` — it accepts a single 100MB string. The watchlist is "no cap" per spec #19, but UNCAPPED at the WIRE level (per-pattern byte size + list length) is different from "no functional limit on what the user can WATCH." A misbehaving client persists the pattern; the next read materializes it into the WS frame on every join.

**Recommended fix:** Cap per-pattern at 256 bytes at the channel boundary AND at the context boundary (defense in depth). Cap list length at 100 patterns at the context boundary. Reject 400-equivalent at the boundary, not at storage time. (Symmetric with W-4's body-cap proposal.)

---

## LOW

### W-13. `AdminController.reload/2` failure mode is `text/plain` not `application/json`
**File(s):** `lib/grappa_web/controllers/admin_controller.ex:54-58`
**Description:** Carry-forward from CP15 S22. `{:error, msg} -> conn |> put_status(:internal_server_error) |> text(msg)` returns the reloader error verbatim as plain text. Other 500s in the system go through `ErrorJSON`. Operators driving the reload from `docker exec curl` get the raw text — fine for that use case. Wire-shape consistency only.

**Recommended fix:** Use `json(conn, %{error: "reload_failed", detail: msg})`. Or accept the text variant explicitly via the `:admin` pipeline `text` accept (it's there) and document the mixed shape in the moduledoc.

### W-14. `RemoteIP.format/1` accepts any integer for `hi`/`lo` in the IPv4-mapped clause — no 16-bit range check
**File(s):** `lib/grappa_web/remote_ip.ex:41-48`
**Description:** Carry-forward from CP15 S19. Bitwise operations on >16-bit integers would produce garbage IPs. In practice `:inet`/Bandit only emits valid 16-bit words, but adding a `hi <= 0xFFFF and lo <= 0xFFFF` guard would document the assumption.

**Recommended fix:** Add `and hi <= 0xFFFF and lo <= 0xFFFF` to the function head guard.

### W-15. `ResolveNetwork.resolve/2` user-branch nests case-of-case — could flatten with `with`
**File(s):** `lib/grappa_web/plugs/resolve_network.ex:79-90`
**Description:** Carry-forward from CP15 S24. Idiomatic preference; not a bug. The nested case (outer `Networks.get_network_by_slug`, inner `Credentials.get_credential`) reads cleanly but a `with` chain would tag the failure source per-branch.

**Recommended fix:** Refactor to `with {:ok, network} <- Networks.get_network_by_slug(slug), {:ok, _cred} <- Credentials.get_credential(user, network) do ... end`.

### W-16. `Endpoint` `signing_salt: "rotate-me"` placeholder is still tracked-only-by-comment
**File(s):** `lib/grappa_web/endpoint.ex:13-22`, `config/dev.exs`, `config/test.exs`
**Description:** Carry-forward from CP15 S12. The moduledoc acknowledges the placeholder and points at "Phase 5 hardening pass" but doesn't link to a `docs/todo.md` line or a `docs/plans/` task. Verify the rotation work is tracked. Today no code calls `put_session/3`, so this is moot — but as the trajectory heads toward push notifications (which often grow a session-cookie surface) and public open, salt rotation needs to be a tracked deliverable, not a moduledoc TODO.

**Recommended fix:** Add an entry in `docs/todo.md` under Phase 5 hardening: "rotate `:session_signing_salt` from `"rotate-me"` placeholder via `SECRET_SIGNING_SALT` env at runtime release boot." Cross-link from the moduledoc.

### W-17. `Subject.to_session/1` lives at `lib/grappa_web/subject.ex` but no test file exists
**File(s):** `lib/grappa_web/subject.ex` (no test/grappa_web/subject_test.exs)
**Description:** The conversion module is a small but load-bearing boundary (every controller that touches Session goes through it). No test asserts the two pattern-match branches. A future refactor that swaps the user/visitor `id` field shape would silently break — the function would compile because both subjects expose `:id`, but a tests-as-contract miss.

**Recommended fix:** Add `test/grappa_web/subject_test.exs` with `assert {:user, "u123"} = Subject.to_session({:user, %User{id: "u123"}})` + visitor mirror.

### W-18. `ErrorJSON.render/2` envelope (`%{errors: %{detail: ...}}`) is structurally different from `FallbackController`'s `%{error: "..."}` envelope
**File(s):** `lib/grappa_web/controllers/error_json.ex:13`, `lib/grappa_web/controllers/fallback_controller.ex` (passim)
**Description:** Phoenix invokes `ErrorJSON.render/2` for unhandled errors (uncaught exceptions, route-not-found before any controller fires). The body shape is `%{errors: %{detail: "Not Found"}}` — a different envelope from `FallbackController`'s `%{error: "not_found"}`. cic's `readError` (per `FallbackController` moduledoc) was specifically updated post-bucket-G to handle the `error: "<token>"` shape; an uncaught 500 lands in the OLD shape and surfaces as `res.statusText` ("Internal Server Error") client-side instead of a programmatic error tag.

**Recommended fix:** Rewrite `ErrorJSON.render/2` to emit the `%{error: "<token>"}` envelope: `render("404.json", _) -> %{error: "not_found"}; render("500.json", _) -> %{error: "internal"}; render("503.json", _) -> %{error: "service_unavailable"}`. Mirror every status code Phoenix can surface unhandled. Single envelope at every door.

---

## NIT

### W-19. `MeJSON.show/1` two clauses repeat the `Map.put(:kind, _) |> Map.put(:read_cursors, _)` chain
**File(s):** `lib/grappa_web/controllers/me_json.ex:56-68`
**Description:** Minor DRY. Both clauses do the same envelope-postprocessing (kind + read_cursors). Could factor into `defp put_envelope(json, kind, cursors)`.

### W-20. `GrappaChannel`'s `handle_info({:after_join, {:network, _, _}}, _)` no-op clause could vanish if the network-topic skipped the `:after_join` send
**File(s):** `lib/grappa_web/channels/grappa_channel.ex:242-246`
**Description:** Carry-forward from CP15 S21. Author's call — the explicit no-op clause documents that network-topic snapshots are intentional zero. Or it could go away by making `join/3` skip the `Process.send_after(self(), {:after_join, parsed}, 0)` call for `:network` topics. Either is fine.

### W-21. `validate_args` private type spec `validate_arg` claims `{:nicks, [String.t()]}` but `validate_args([{:nicks, []} | _])` returns `:invalid_nick`
**File(s):** `lib/grappa_web/channels/grappa_channel.ex:1057`
**Description:** The empty-list-as-error clause is correct (you can't `/op` zero nicks), but the `validate_arg` typespec says `[String.t()]` which permits the empty list. Tighten to `[String.t(), ...]` (non-empty list) or document the empty-list-rejection in the typedoc.

---

## Trajectory risks (Phase 5 hardening + public-open)

The current LAN/loopback default is fine. The next four trajectory items each surface a specific landmine in the web layer:

1. **Push notifications (immediate next).** Will grow a per-subject device-token table and a per-message "should this push?" decision. The decision MUST live in the context (`Grappa.Notifications` or similar), NOT in `GrappaChannel.handle_in("privmsg", ...)`. Today's pattern would be tempted to bolt it onto the channel handler. Pre-design: the broadcast-event boundary (W-1's recommendation) is the right place — telemetry from there feeds the push decision.

2. **Image upload.** Will introduce a `multipart/form-data` POST surface. `Plug.Parsers` already accepts `:multipart` (endpoint.ex:45) but no max-body-size is set in the Endpoint config. Default Plug limit is 8MB which is generous AND not enforced as a rate limit. Pre-public-open: explicit `length: <bytes>` on `Plug.Parsers` config + per-IP rate limit before the parser runs. Catbox/litterbox-as-passthrough means the bouncer doesn't store the bytes, but it DOES proxy them temporarily — explicit cap matters.

3. **Voice (post-image).** Adds a binary streaming surface that almost certainly wants its own WS endpoint, not a multiplex on `/socket/websocket`. The current single-socket assumption (`UserSocket`) is fine for typed-event JSON but voice-frame multiplex would re-introduce the BUG-6 fan-out class. Pre-design: a separate `VoiceSocket` mounted at `/voice/websocket` with its own auth + channel module.

4. **Public open.** Three concrete deltas needed in the web layer:
   - **`secure_browser_headers`-equivalent.** No CSP, no X-Frame-Options, no nosniff, no Referrer-Policy in the router pipeline. Today acceptable (LAN); for public open the CSP comment in CLAUDE.md ("`'self'` covers same-origin ws/wss automatically") needs to be a real `put_resp_header` plug on the `:api` pipeline.
   - **Rate limiting above admission.** T31 admission is per-(client, network) for SESSIONS — the REST surface itself (login, message POST, channel POST) has no per-IP rate limit. A login-flooder can probe credentials forever. `Hammer` or similar belongs in `:api` pipeline before `:authn`.
   - **`signing_salt: "rotate-me"` is a footgun the moment any code calls `put_session/3`.** W-16's tracking. The placeholder won't fail loudly — it'll silently sign cookies with a guessable salt the day someone adds a session-cookie path.

The B5 cluster's "no silent drops" theme intersects most directly with item 4's rate-limiting + W-1's broadcast accountability. The other items are downstream, but flagging them here so the next cluster's design phase already has the boundary mapped.
