# Codebase Review — 2026-05-14 (no-silent-drops cluster, B5)

**Branch:** `cluster/no-silent-drops`
**Reviewers:** 8 parallel agents (irc, lifecycle, persistence, web, cicchetto, cross-module, cross-surface, docker)
**Drafts:** [`docs/reviews/codebase/drafts-2026-05-14/`](drafts-2026-05-14/)
**Prior review:** [`2026-05-12-codebase-review.md`](2026-05-12-codebase-review.md)
**Cluster commits since prior:**

```
730f2c8 no-silent-drops(B3): Bahamut numerics audit matrix + scope finding
6d09247 no-silent-drops(B4): clickable URLs in scrollback (linkify)
b031d89 no-silent-drops(B2): inbound INVITE [Join] CTA + B1 numeric-double-write fix
1a29288 docs(no-silent-drops): cluster reshape B5/B6 + README public-open trajectory
0b96ba9 no-silent-drops(B1): EventRouter fallthrough -> structured :notice
20dc475 no-silent-drops(B0): /invite skip requireChannel when chan supplied
```

## Overview

This review evaluates the codebase 5 commits after the May-12 review and at
the close of the no-silent-drops cluster. The cluster's headline change is
B1's `EventRouter` catch-all — verbs that previously hit
`{:cont, state, []}` (silent drop) now persist a `:notice` row on `$server`
with `meta.raw = %{verb, sender, params}`. B0/B2 close cic-side silent
drops (/invite from $server, inbound INVITE [Join] CTA). B4 ships clickable
URLs in scrollback. B3 audits Bahamut numerics for matrix coverage.

**The B1 catch-all is the dominant new finding source.** It closes a real
class of silent drops, but introduces three new contract drifts:

1. **CRIT-IRC.** AUTHENTICATE payloads (post-registration SASL re-auth) now
   persist to `$server` scrollback as plaintext — credential leak surface
   that re-creates a closed bug class (W12 NickServ-leak hardening).
2. **HIGH-IRC.** Empty-trailing verbs (bare `WALLOPS`, terminal `ERROR`,
   nick-rejected 432 with no trailing) silently drop via the changeset's
   `validate_required(:body)` — the very thing B1 was supposed to fix.
3. **HIGH-XMOD.** The new meta carries mixed-key shape (atom outer +
   string inner) and reuses `kind: :notice` for non-notice events
   (KILL/WALLOPS/CHGHOST/INVITE), undermining the closed-set discipline.

Beyond the cluster delta, the review surfaces:

- 1 CRIT (the AUTHENTICATE leak — same finding from two agents, one source)
- 21 HIGH across 8 surfaces (4 carry-overs from May-12, 17 new)
- ~50 MED, mostly contract refactors and small drifts
- Trajectory blockers for push notifications, image upload, and PUBLIC OPEN

The trajectory after B5/B6 is push notifications → image upload → voice
→ mobile UI polish → PUBLIC OPEN. Findings are scored against that
trajectory, not just "what hurts today."

## Summary table — by surface × severity

| Surface           | CRIT | HIGH | MED  | LOW  | NIT  | Total |
|-------------------|------|------|------|------|------|-------|
| IRC               | 1    | 5    | 8    | 6    | 3    | 23    |
| Lifecycle         | 1    | 6    | 8    | 5    | 2    | 22    |
| Persistence       | 0    | 4    | 8    | 6    | 3    | 21    |
| Web (Phoenix)     | 0    | 4    | 8    | 6    | 3    | 21    |
| Cicchetto         | 0    | 4    | 8    | 6    | 2    | 20    |
| Cross-module      | 0    | 1    | 5    | 3    | 1    | 10    |
| Cross-surface     | 0    | 3    | 6    | 5    | 2    | 16    |
| Docker / Deploy   | 0    | 4    | 6    | 7    | 3    | 20    |
| **Totals**        | **1**| **31**| **57**| **44**| **19**| **152** |

(The CRIT appears in both IRC and Lifecycle drafts — it's the same finding
viewed from two surfaces. Synthesis below dedupes.)

## Cluster-thesis check: did "no silent drops" actually land?

**Partially.** The B1 catch-all closes the original class (verb arrives →
`EventRouter` → `[]` effects → discarded). But the secondary failure modes
were not scoped:

- AUTHENTICATE payload persists with cleartext (security-leak class)
- Empty-trailing verbs silently dropped via changeset reject
- LIST (321/322/323) and LINKS (364/365) numerics are still silent drops
  because `NumericRouter` `@delegated_numerics` lists them but
  `EventRouter` has no clauses — flow falls through both layers' catch-alls
- cic's `subscribe.ts` DM-listener still silently drops
  `mode/join/part/quit/kick/nick_change/topic` events on the own-nick topic
  (deferred to "feature #4")
- `Grappa.PubSub.broadcast_event/2` discards the dispatcher return — the
  broadcast site itself silently swallows fan-out failures

Three of these (AUTHENTICATE leak, empty-trailing drop, LIST/LINKS
silent-drop) are **direct fold-in candidates for B6**. The cic
DM-listener drop and the broadcast-event return discard are scope for
the next cluster.

## Top findings — quick list

### CRIT
1. **B1 catch-all persists AUTHENTICATE payloads to `$server`** —
   credential-leak path; same disease class as the W12 NickServ-leak
   hardening. (IRC + Lifecycle drafts.)

### HIGH (CLUSTER FOLD-IN candidates — fix in B6)
2. **Empty-trailing verbs silently dropped** by `validate_required(:body)`
   on the catch-all's persist path
3. **LIST/LINKS numerics silent-drop** — `NumericRouter` delegates,
   `EventRouter` has no handler, Server skips persist
4. **NumericRouter `scan_params` mis-routes 2-param numerics** to
   `$server` instead of the param target
5. **`Grappa.PubSub.broadcast_event/2` discards dispatcher return** —
   silent-drop entry point at the heart of the streaming surface
6. **EventRouter `meta` shape mixes atom-outer + string-inner keys** —
   bypasses `Scrollback.Meta` allowlist discipline
7. **EventRouter catch-all reuses `:notice` kind** for KILL/WALLOPS/
   CHGHOST/INVITE — wrong domain class
8. **CSS `--fg-muted` undefined in 14 P-0 cluster surfaces** — silent
   visual regression vitest jsdom can't catch
9. **No Playwright e2e for B0/B2/B4** — UX-behavior commits shipped
   without browser smoke (cluster-wide rule violation)

### HIGH (cluster-adjacent / next-cluster)
10. **`openQueryWindowState` optimistic mutation** — last "cic
    originates state" violation
11. **`narrowUserEvent` skips array-element typecheck** for
    `mentions_bundle.messages` and `whois_bundle.channels`
12. **NetworkCircuit + Backoff ETS leak** in BootstrapTest +
    SpawnOrchestratorTest (carry-over)
13. **`Visitors.Login.spawn_and_await/3` bypasses SpawnOrchestrator**
    AND skips admission re-check post-stop_session
14. **Backoff/NetworkCircuit `rescue ArgumentError` masks boot-ordering
    invariant** — silent default for the gating decision
15. **`Backoff.record_failure` cast races with supervisor restart** —
    new session may read OLD count
16. **`terminate/2 catch :exit, _` is broader than necessary** (carry-over)
17. **AdminController `cic_bundle_changed` fans out N broadcasts with
    no per-target accounting**
18. **`broadcast_event/2` permits structs** — CP15 B6 class still open
19. **MessagesController + ChannelsController accept unbounded body**
    — defense in depth missing
20. **ReadCursor visitor cross-device broadcast routes nowhere** —
    `"visitor:<uuid>"` synthetic user_name
21. **`ReadCursor.set/4` does message-belongs check on every settle**
    — three round-trips per blur event
22. **`read_cursors(:last_read_message_id)` index unused** — bloats
    every write
23. **`Scrollback.list_archive/3` GROUP BY scans full subject shard**
    — push-notification trajectory blocker
24. **`GET /networks` ships implicit-shape union** — visitor branch
    silently drops `connection_state` + `nick`
25. **`read_cursor_set` payload built inline in context** — bypasses
    Wire boundary (Phase 6 MARKREAD prerequisite)
26. **`Scrollback.Wire.to_json/1` typespec lies about kind** —
    declares atom, ships string
27. **`deploy.sh` preflight regex misses field-additions** inside
    multi-line `@type t :: %{...}` (carry-over from CP28)
28. **New migration files silently classified HOT** — hot path
    skips `mix ecto.migrate` (carry-over from CP29 R-Z)
29. **nginx config + security-headers edits silently dropped on
    hot deploy** — H3-class silent drop in deploy
30. **`infra/nginx.conf` doc references files removed in CP23**
31. **EventRouter's `cond`-chain `param_derived_route`** —
    recursive-pattern-rule violation

## Next-cluster trajectory blockers (pre-public-open)

1. **Push notifications:**
   - Per-kind `meta` discriminated union on cic (M3) — required before
     push decision logic grows on top of `meta`
   - Typed `topic_for/1` dispatch (M4) — required before push routing
     adds yet another arm to the ad-hoc per-broadcast topic decisions
   - ETS reaper for stale `Backoff` entries — public traffic accumulates
     unbounded keys

2. **Image upload (litterbox):**
   - nginx `client_max_body_size 16m` (M3 docker) — silent 413 today
   - CSP `connect-src https://litterbox.catbox.moe` — needs
     `infra/snippets/security-headers.conf` edit, which is silently
     dropped on hot deploy (H3 docker)
   - `:server_event` kind addition + `Scrollback.Meta.@known_keys`
     extension — scope to "image attachment metadata" wire shape

3. **Voice:**
   - Separate `/voice/websocket` socket; don't multiplex on
     `/socket/websocket` — cic-side voice frames need own auth + channel
   - WebRTC STUN/TURN allowlist in CSP
   - Bandit WS payload-size cap raise

4. **Mobile UI polish:**
   - 768px breakpoint mobile-only branch has KNOWN gaps (no per-tab close
     on `BottomBar`)
   - Real browser smoke at every bucket close (per
     `feedback_cicchetto_browser_smoke`)

5. **PUBLIC OPEN:**
   - nginx rate limits + `limit_conn` + `limit_req_zone` for `/auth`
   - `secure_browser_headers`-equivalent on `:api` pipeline
   - Per-IP rate limit BEFORE admission (so circuit-breaker doesn't trip
     on bot floods from one IP)
   - `signing_salt: "rotate-me"` rotated to env-driven (W-16)
   - `__cic_*` window globals stripped from production builds
   - Bundle hash CSP — Vite source-map output decision (debug vs IP)
   - All five error envelopes (captcha, rate-limit, anon_collision,
     changeset, network_circuit) unified to `{error: "<token>", info: %{}}`

## B6 fold-in candidate list (actionable subset)

The next bucket should land these in the no-silent-drops cluster, not defer:

1. **AUTHENTICATE deny-list** at the head of EventRouter catch-all
   (CRIT-1; ~5 LOC)
2. **Empty-trailing fallback to verb-name body** OR introduce
   `:server_event` kind (HIGH-2; ~10 LOC for verb-name fallback,
   ~50 LOC for new kind + migration)
3. **LIST/LINKS numerics removal from `@delegated_numerics`** (HIGH-3;
   ~5 LOC) — Server's default path persists them as plain `:notice`
4. **NumericRouter `scan_params` 2-param shape fix** (HIGH-4; ~5 LOC + test)
5. **`broadcast_event/2` struct-rejection guard** (HIGH-18; ~3 LOC)
6. **`broadcast_event/2` return surfacing + telemetry** (HIGH-5; ~10 LOC)
7. **Meta atom-key flattening** (HIGH-6; ~10 LOC + test)
8. **CSS `--fg-muted` → `--muted` replace_all** (HIGH-8; ~14 line edits)
9. **B0/B2/B4 Playwright e2e** (HIGH-9; ~3 spec files)
10. **deploy.sh preflight: migration class + nginx class + field-additions
    AST** (HIGH-27/28/29; ~30 LOC; the H1 fix is the hardest)
11. **Carry-overs cheap to land:** `:toml` dep removal, `compile_env!`
    flip for `:visitor_network` (X3/X4; ~5 LOC each)

## MED + LOW + NIT

The full per-surface listings are in the drafts at
[`drafts-2026-05-14/`](drafts-2026-05-14/). The remainder of THIS doc
expands the HIGH+CRIT findings only — MED and below are a "scrolling
audit" rather than a single-page priority list.

---

## CRIT findings (1)

### CRIT-1. EventRouter B1 catch-all persists `AUTHENTICATE` continuation payloads to `$server` scrollback

**Surface:** IRC + Lifecycle (same finding from two angles)
**File:** `lib/grappa/session/event_router.ex:1500-1533`

The B1 fallthrough commit lists `AUTHENTICATE` explicitly in its
"silently dropped" rationale. After the AuthFSM handshake, an upstream
re-auth `AUTHENTICATE <base64>` continuation, an upstream echo, or a
malicious crafted line dispatched via `IRC.Client.process_line` reaches
`Session.Server` BEFORE the FSM step (client.ex:663) and gets routed
through `EventRouter.route/2`. With B1's catch-all in place, the
payload:

1. Persists to scrollback as plaintext — `meta.raw["params"]` carries
   the full param list including SASL base64
2. Broadcasts on `$server` topic to every connected cic tab
3. Replays on reconnect — `Scrollback.fetch` returns it indefinitely

For SASL PLAIN, base64 decodes to `\0sasl_user\0sasl_user\0password`.
Once persisted to sqlite the password sits in scrollback indefinitely
(no scrub path). Symmetric risk for `PASS`. Same disease class as the
W12 NickServ-leak `service_target?/1` hardening at server.ex:1644.

**B6 fix:** Add explicit deny-list at the head of the catch-all clause:

```elixir
@no_persist_verbs ~w(authenticate pass oper)a

def route(%Message{command: command} = _, state)
    when command in @no_persist_verbs,
    do: {:cont, state, []}
```

Plus regression test: `route(authenticate_message, state)` produces
zero `:persist` effects.

---

## HIGH findings — cluster fold-in (B6 candidates)

### HIGH-2. B1 catch-all silently drops verbs with no trailing param

**Surface:** IRC + Lifecycle
**File:** `lib/grappa/session/event_router.ex:1519-1533` +
`lib/grappa/session/server.ex:2251-2278`

Catch-all sets `body = List.last(params) || ""`. Empty string passes
`validate_required(:body)` (non-nil) but the resulting row often fails
downstream — `Scrollback.Message.changeset` returns `{:error, _}` on
the apply_effects path → `Logger.error` + DROP + no PubSub broadcast.
Net behaviour for bare `WALLOPS`, terminal `ERROR` (no trailing),
nick-rejected 432 with no trailing: **silently dropped**, breaking the
exact thing B1 was supposed to fix.

**B6 fix:** Fall back to verb-name body when trailing absent:

```elixir
body =
  case List.last(params) do
    s when is_binary(s) and s != "" -> s
    _ -> command_to_verb_string(command)
  end
```

Or — more honest — introduce a new `:server_event` kind in
`Message.@kinds` that accepts nil/empty body. Larger surface (migration,
update apply_effects + cic-side dispatcher) but semantically right.

### HIGH-3. NumericRouter delegates 321/322/323 (LIST) + 364/365 (LINKS) to EventRouter; no clauses there → silent drop

**Surface:** IRC + Cross-module
**File:** `lib/grappa/session/numeric_router.ex:146-166`,
`lib/grappa/session/event_router.ex:1498-1533`

`@delegated_numerics` lists these with TODO comments noting "EventRouter
handler is owned by dedicated handlers" — but none exist. With B1, the
flow is `:delegated → EventRouter no-numeric-clause → catch-all line
1498 short-circuits to {:cont, state, []}` for `{:numeric, _}` (correct
— Server's numeric handler owns persistence). But the `:delegated`
decision SKIPS Server's persist path. **Net:** still a silent drop. The
first `/list` upstream produces zero rows.

**B6 fix:** Easiest — REMOVE 321/322/323/364/365 from
`@delegated_numerics` so Server's default path persists them as
`:notice` rows. Visible, never silent. Adding cic UI for `/list` is the
polish-cluster scope; the silent-drop fix is one-line.

### HIGH-4. NumericRouter `scan_params` skips trailing element unconditionally — 2-param numerics route to `$server` instead of param target

**Surface:** IRC
**File:** `lib/grappa/session/numeric_router.ex:373-381`

`candidate_params([_, _])` returns `[]`. For 2-param numerics like 401
ERR_NOSUCHNICK with no trailing string in some legacy ircds (`[own_nick,
target]`), `scan_params` returns `{:server, nil}` instead of routing to
the query window for `target`. RFC 2812 makes the trailing param
optional after middle params; the assumption "params[0] echo, last is
trailing" doesn't hold for shape-2 numerics.

**B6 fix:** Drop trailing only when params count ≥ 3. For 2-param shape,
scan `params[1]`. Add tests pinning the 401 route.

### HIGH-5. `Grappa.PubSub.broadcast_event/2` discards dispatcher return — silent-drop entry point at the streaming-surface heart

**Surface:** Web (Phoenix)
**File:** `lib/grappa/pubsub.ex:63-67`

`_ = Phoenix.Channel.Server.broadcast(...)` swallows `{:error, term()}`.
Today: read-cursor cross-device sync (CP29 R-Z), bundle-hash refresh
push, and every Wire-event broadcast all rely on the dispatcher
actually fanning out. Phoenix's local PG2 adapter rarely errors but
fastlane encoding CAN fail (CP15 B6 class). Without the return, the
broadcast site claims success and the silent failure surfaces hours
later as a stale UI badge.

**B6 fix:** Return `:ok | {:error, term()}` from `broadcast_event/2`,
emit telemetry on failure
(`[:grappa, :pubsub, :broadcast_failed]`). Caller-side discard becomes
explicit.

### HIGH-6. EventRouter catch-all writes mixed-key meta — atom outer + string inner — bypasses Scrollback.Meta allowlist

**Surface:** Cross-module
**File:** `lib/grappa/session/event_router.ex:1519-1533` +
`lib/grappa/scrollback/meta.ex:96-162`

The B1 catch-all builds `meta = %{raw: %{"verb" => ..., "sender" => ...,
"params" => ...}}` — outer atom-keyed (in allowlist), inner string-keyed
with no central registry, no Logger-allowlist sync test, no Dialyzer
visibility. The closed-set discipline that prevents attacker-controlled
inputs from inflating the global atom table holds today only by
accident: `Meta.atomize_known/1` doesn't recurse into nested maps. A
future refactor that adds recursion would atomize attacker
`params` strings.

**B6 fix:** Flatten to three atom-keyed top-level fields
(`raw_verb: String.t()`, `raw_sender: String.t()`, `raw_params:
[String.t()]`); add to `Scrollback.Meta.@known_keys` + `@type t`. The
existing `meta_test.exs:125-130` Logger-allowlist-sync assertion catches
drift automatically. cic reads `msg.meta.raw_verb` etc. — same shape,
lifted one level.

### HIGH-7. EventRouter catch-all reuses `:notice` kind for non-notice events

**Surface:** Cross-module
**File:** `lib/grappa/session/event_router.ex:1531`

Catch-all writes `kind: :notice` for KILL, WALLOPS, GLOBOPS, ERROR,
CHGHOST, AUTHENTICATE, inbound INVITE (B2!), and every vendor verb.
`:notice` is a CONTENT kind — `@body_required_kinds` requires body,
`@dm_with_eligible_kinds` allows DM peer info. None hold for these
events. Future code filtering `kind in [:privmsg, :notice, :action]` to
mean "human content" silently includes server-event noise.

**B6 fix:** Add `:server_event` to `@kinds`, exclude from
`@body_required_kinds` (matches actual semantics), leave
`@dm_with_eligible_kinds` unchanged. Update event_router.ex:1531.
Migrate pre-existing `:notice + meta.raw` rows in a one-shot
backfill if needed.

### HIGH-8. Undefined CSS variable `--fg-muted` — 14 references in NEW P-0 cluster surfaces

**Surface:** Cicchetto
**Files:** `cicchetto/src/themes/default.css:1333,1356,1382,1386,1408,
1430,1475,1494,1504,1516,1526,1546,1570,1580`

Variable `--fg-muted` referenced in 14 places across new P-0a/b/c/d/e/f
cards and B2 invite-ack-row CSS, but only `--muted` is defined in both
theme blocks. Browser fallback: inheritance → renders at full body
color. "Muted" labels render at full intensity; the
`border-left: 3px solid var(--fg-muted)` accent bar on PeerAwayBanner
renders as `currentColor`. Vitest jsdom doesn't run CSS parser; only
real browsers expose it.

**B6 fix:** `replace_all` `var(--fg-muted)` → `var(--muted)` across
the 14 sites. Add Playwright e2e covering the muted-text rendering
on at least one P-0 card.

### HIGH-9. No Playwright e2e for B0 (/invite skip), B2 (INVITE CTA), B4 (linkify)

**Surface:** Cicchetto
**Files:** `cicchetto/e2e/tests/` (no new specs); cic source at
`compose.ts:432-453`, `ScrollbackPane.tsx:204-225, 318-351`

Three new UX surfaces shipped without browser smoke. Per
`feedback_ux_e2e_mandatory` and `feedback_cicchetto_browser_smoke`,
cluster-wide rule violation. B2's `[Join]` button is exactly the class
of bug vitest jsdom misses (CSS layout interaction). B4's URL regex
could misclassify and the operator sees broken links with no test signal.

**B6 fix:** Three Playwright specs under `cicchetto/e2e/tests/`:
`b0-invite-from-server-window.spec.ts`,
`b2-inbound-invite-cta.spec.ts`,
`b4-linkify.spec.ts`.

---

## HIGH findings — cluster-adjacent / next-cluster

### HIGH-10. `openQueryWindowState` mutates state optimistically before server broadcast

**Surface:** Cicchetto
**File:** `cicchetto/src/lib/queryWindows.ts:69-84`

Last remaining "cic originates state" violation post-CP17. WS-disconnect
at open time → operator sees phantom DM that vanishes when
`query_windows_list` finally lands. Server-side persist failure has
identical shape.

**Next-cluster fix:** Mirror CP17 — route through server-emitted
`query_window_opened` event.

### HIGH-11. `narrowUserEvent` skips array-element typecheck for `mentions_bundle.messages` and `whois_bundle.channels`

**Surface:** Cicchetto
**File:** `cicchetto/src/lib/userTopic.ts:79-95, 156`

`Array.isArray` ✓ but no per-element validator. Malformed
`messages: [null, {}]` lands as typed `WireUserEvent`, dispatcher
writes the bundle, `MentionsWindow.tsx` crashes on undefined deref.

**Next-cluster fix:** Per-element validators
(`narrowMentionsBundleMessage`, `narrowWhoisChannel`).

### HIGH-12. NetworkCircuit + Backoff ETS leak across container runs in BootstrapTest + SpawnOrchestratorTest

**Surface:** Lifecycle
**File:** `test/grappa/bootstrap_test.exs`,
`test/grappa/spawn_orchestrator_test.exs`,
`test/grappa/admission_test.exs:13-15` (does clean)

Per standing memory `project_network_circuit_ets_leak`. Singleton ETS
tables survive `mix test` runs and `scripts/test.sh` reruns into the
same container. AdmissionTest cleans; the other two don't. Stale
`{:network_circuit_open, _}` from a prior run causes flaky failures.

**Next-cluster fix:** Promote cleanup to
`test/support/admission_state_helpers.ex`; setup blocks call into it.

### HIGH-13. `Visitors.Login.spawn_and_await/3` bypasses SpawnOrchestrator AND skips admission re-check post-stop_session

**Surface:** Lifecycle
**File:** `lib/grappa/visitors/login.ex:285-305, 229-240`

`preempt_and_respawn/4` calls `Session.start_session/3` directly. Between
the original admission check (top of `dispatch/4`) and the start_session
call, the session being preempted is still counted by the network-cap.
Mostly benign (capacity loosens, not tightens) but the orchestrator
contract is broken.

**Next-cluster fix:** Add `SpawnOrchestrator.spawn_and_monitor(subject,
network_id, plan, capacity_input, timeout)` that absorbs notify_pid +
monitor_ref. Login's `preempt_and_respawn` becomes one orchestrator call.

### HIGH-14. Backoff/NetworkCircuit `rescue ArgumentError` masks boot-ordering invariant

**Surface:** Lifecycle
**File:** `lib/grappa/session/backoff.ex:140-152, 192-202, 261-268`,
`lib/grappa/admission/network_circuit.ex:124-160, 107-114`

Both modules absorb "ETS table missing" via `rescue ArgumentError -> 0
| :ok | []`. Returns 0 for `wait_ms/2` lets backoff cycle skip its
delay silently. Returns `:ok` for `NetworkCircuit.check/1` lets
freshly-respawned-and-empty circuit accept a probe that should be
rejected. Same disease class as the cluster's reason for existing.

**Next-cluster fix:** Either remove the rescue (let supervisor handle)
or convert to tagged return `{:ok, n} | {:error, :table_unavailable}`
so callers explicitly handle.

### HIGH-15. `Backoff.record_failure` cast races with supervisor restart

**Surface:** Lifecycle
**File:** `lib/grappa/session/server.ex:1217-1221`,
`lib/grappa/session/backoff.ex:159-162`

`record_failure` is async cast; if Backoff hasn't processed it before
the new Server's `init/1` reads `wait_ms/2`, count is stale. Server's
own comment acknowledges the race but the mailbox-FIFO guarantee doesn't
apply across unrelated pids.

**Next-cluster fix:** Convert `record_failure` to synchronous call
(Server is exiting, one extra round-trip is fine). OR direct ETS write
from caller.

### HIGH-16. `terminate/2 catch :exit, _` is broader than necessary (carry-over)

**Surface:** Lifecycle
**File:** `lib/grappa/session/server.ex:613-628`

Carryover from May-12 S11. Wide-open catch swallows future Client.send_quit
arity bugs, undefined functions, etc. Per CLAUDE.md "Defensive
programming hides bugs" the matched shapes should be `:noproc | :timeout
| :normal | :shutdown | {:shutdown, _}` only.

### HIGH-17. AdminController.cic_bundle_changed fans out N broadcasts with no per-target accounting

**Surface:** Web
**File:** `lib/grappa_web/controllers/admin_controller.ex:60-76`

Iterates `WSPresence.list_user_names()` and broadcasts per user. HTTP
200 returned regardless of 0 or N broadcasts reaching subscribers. If
WSPresence is briefly unavailable, returns `[]` and operator's
deploy-cic.sh prints "ok hash" with nobody notified.

**Next-cluster fix:** Telemetry counts; supervised Task for retry; OR
push to `Phoenix.Tracker`-style state that joins re-read.

### HIGH-18. `broadcast_event/2` permits structs — CP15 B6 class still open

**Surface:** Web
**File:** `lib/grappa/pubsub.ex:64`

Guard `%{} = payload` matches `%Window{}`. CP15 B6 fastlane crash class
stays reachable.

**B6 fix:** Tighten guard: `is_map(payload) and not is_struct(payload)`.

### HIGH-19. MessagesController + ChannelsController accept unbounded body

**Surface:** Web
**File:** `lib/grappa_web/controllers/messages_controller.ex:138-159`,
`lib/grappa_web/controllers/channels_controller.ex:204-217`

Per CLAUDE.md sqlite uses `:text`, no length limits at storage layer
— must adjust at schema. Today neither controller caps. Multi-MB body
persists, fans out to every subscriber.

**Next-cluster fix:** Cap at 4096 bytes (operator-configurable) at the
boundary; reject 413 / `:body_too_large`. Mirror at Channel boundary
for `topic_set`, `kick`, `away`, `umode`.

### HIGH-20. ReadCursor visitor cross-device broadcast routes to no subscriber

**Surface:** Persistence
**File:** `lib/grappa_web/controllers/read_cursor_controller.ex:81-88`,
`lib/grappa/read_cursor.ex:175-208`

Synthetic `"visitor:<uuid>"` user_name baked into a topic shape
`grappa:user:visitor:abc-uuid/network:.../channel:...` that no
`UserSocket` joins. Wasted CPU per scroll-settle event.

**Next-cluster fix:** Drop the visitor branch in `maybe_broadcast/4`;
document loudly in moduledoc.

### HIGH-21. `ReadCursor.set/4` does message-belongs check on every settle

**Surface:** Persistence
**File:** `lib/grappa/read_cursor.ex:140-145, 240-246`

Three round-trips per cic settle event. The `message_belongs?` check
duplicates the `assoc_constraint(:last_read_message)` defense at the
cost of an extra `Repo.exists?` per blur.

**Next-cluster fix:** Drop `message_belongs?` and rely on the FK
constraint. OR collapse to single `INSERT ... ON CONFLICT WHERE EXISTS`.

### HIGH-22. `read_cursors(:last_read_message_id)` index unused — bloats writes

**Surface:** Persistence
**File:** `priv/repo/migrations/20260513133825_create_read_cursors.exs:89`

No query in `Grappa.ReadCursor` filters or joins on it. Every `set/4`
writes one extra index entry — fourth index per write.

**Next-cluster fix:** Drop index in follow-up migration.

### HIGH-23. `Scrollback.list_archive/3` GROUP BY scans full subject shard

**Surface:** Persistence
**File:** `lib/grappa/scrollback.ex:445-461`

`GROUP BY COALESCE(dm_with, channel)` — derived expression. SQLite
materializes every row in (subject, network) shard, then aggregates.
Today's volumes hide it. Push notifications + Phase 6 CHATHISTORY
listener will both need archive enumeration as steady-state.

**Pre-push-notifications fix:** Generated column
`target TEXT GENERATED ALWAYS AS (COALESCE(dm_with, channel)) STORED`
+ composite indexes. Add `EXPLAIN QUERY PLAN` perf test now.

### HIGH-24. `GET /networks` ships implicit-shape union — visitor branch silently drops `connection_state` + `nick`

**Surface:** REST + Channel
**File:** `lib/grappa/networks/wire.ex:46-84`,
`lib/grappa_web/controllers/networks_json.ex:28-37`,
`cicchetto/src/lib/api.ts:158-229`

Two JSON shapes (visitor vs user) with no `kind:` discriminator. cic
invents `tagNetwork()` boundary that joins each row against `me()` to
retrofit the discriminator. Visitor branch has no `connection_state`
field — future visitor parked-state silently no-ops.

**Next-cluster fix:** Add explicit `kind: "user" | "visitor"` field to
both `network_json` and `network_with_nick_json`. cic's `tagNetwork()`
becomes one-line read instead of join. Symmetric with `MeJSON.show/1`.

### HIGH-25. `read_cursor_set` payload built inline in context — bypasses Wire boundary

**Surface:** Channel + IRC (Phase 6 facade)
**File:** `lib/grappa/read_cursor.ex:198-208`

Lone exception across the codebase: every other broadcaster routes
through a typed Wire fn. `lib/grappa/read_cursor/wire.ex` doesn't exist.
Phase 6 MARKREAD line needs the same authoritative shape.

**Pre-Phase-6 fix:** Extract `lib/grappa/read_cursor/wire.ex` with
`read_cursor_set/1`. ~15 LOC. Pre-empts the listener-facade build.

### HIGH-26. `Scrollback.Wire.to_json/1` typespec lies about `kind`

**Surface:** REST + Channel
**File:** `lib/grappa/scrollback/wire.ex:38-92`

`@type t` declares `kind: Message.kind()` (atom). Wire ships string
(Jason converts). Same module's `archive_entry/1` does
`kind: Atom.to_string(kind)` correctly. Two patterns in one file.

**B6 fix:** Two lines:

```elixir
@type t :: %{..., kind: String.t(), ...}
def to_json(%Message{...} = m) do
  %{..., kind: Atom.to_string(m.kind), ...}
end
```

### HIGH-27. deploy.sh preflight regex misses field-additions inside multi-line `@type t :: %{...}`

**Surface:** Docker / Deploy
**File:** `scripts/deploy.sh:142`,
`lib/grappa/session/server.ex:254-` (~70 line `@type t` block)

Per `feedback_deploy_sh_preflight_field_addition_gap`. CP28 incident
root cause; not yet fixed. Field added INSIDE existing block silently
classifies HOT. Phoenix.CodeReloader accepts unsafe diff at runtime;
crash deferred to whenever the next field-touching message arrives.

**B6 fix:** AST-shape oracle: extract `@type t :: %{...}` block + matching
`}` from HEAD and previous SHA, normalize whitespace, diff. Differences
→ COLD.

### HIGH-28. New migration files silently classified HOT — hot path skips `mix ecto.migrate`

**Surface:** Docker / Deploy
**File:** `scripts/deploy.sh:73-159` preflight, `:177-188` hot path,
`:231-232` cold-only `mix ecto.migrate`

Per `feedback_cluster_with_migration_must_cold` (CP29 R-Z lesson). New
migration files pass preflight as HOT. The hot path POSTs `/admin/reload`
— modules reloaded, migrations not executed. First query 500s; if
Bootstrap reads it at next supervision-tree restart, BEAM crash-loops.

**B6 fix:** Add Class 5 to preflight:

```bash
if echo "$changed" | grep -qE '^priv/repo/migrations/'; then
    echo "  → new/edited migration → COLD"
    return 1
fi
```

### HIGH-29. nginx config + security-headers edits silently dropped on hot deploy

**Surface:** Docker / Deploy
**File:** `scripts/deploy.sh:73-159` preflight,
`infra/nginx.conf`, `infra/snippets/security-headers.conf`

Hot path doesn't reload nginx. Edits sit on disk; running nginx serves
old config until next cold deploy. CSP allowlist drift particularly
bad — new captcha provider added to allowlist won't take effect, cic
widgets 404 under CSP.

**B6 fix:** Add Class 6:

```bash
if echo "$changed" | grep -qE '^infra/(nginx\.conf|snippets/)'; then
    echo "  → nginx config changed → COLD"
    return 1
fi
```

### HIGH-30. infra/nginx.conf doc references files removed in CP23

**Surface:** Docker / Deploy
**File:** `infra/nginx.conf:5-9`

References `compose.prod.yaml` + `compose.prod.override.yaml` (both
gone post-CP23 S4) and "cicchetto_dist named volume" (it's now a host
bind-mount at `runtime/cicchetto-dist/`). Doc-comment drift the next
operator (or Claude session) reads literally.

**B6 fix:** Rewrite the comment to reference current
`compose.yaml` `--profile prod` + `${NGINX_PUBLISH:-3000:80}` pattern.

### HIGH-31. EventRouter `cond`-chain `param_derived_route` — recursive-pattern-rule violation

**Surface:** IRC
**File:** `lib/grappa/session/numeric_router.ex:336-348`

Per CLAUDE.md "Recursive pattern match over `Enum.reduce_while/3`" /
`cond` chains for closed-set classification. Three pattern-match
clauses with guards on the code value would be clearer + Dialyzer-
checkable. Same pattern in `route_non_channel_notice_non_chanserv`
(line 1599-1618 of event_router.ex).

**Next-cluster fix:** Convert to clause-per-class.

---

## MED + LOW + NIT (per-surface pointers)

Refer to drafts for full per-finding detail. Notable categories:

- **Cross-module:** `:toml` dep still in mix.exs (X4); `compile_env`
  vs `compile_env!` for `:visitor_network` (X3); module-size drift —
  Session.Server +262 LOC, EventRouter +614 LOC since May-12 (X6)
- **Cross-surface:** five error envelopes (M6); 18 channel verbs vs
  1 REST verb asymmetry (M5); typed `topic_for/1` dispatch missing (M4)
- **Persistence:** `QueryWindows.Wire` keys on integer network_id not
  slug (M1); IP storage class drift (M2); messages.kind CHECK frozen
  drift (M8)
- **Web:** `away` channel handler bypasses `dispatch_subject_verb`
  consistency (W-5); LoopbackOnly hand-rolls JSON envelope (W-7);
  ErrorJSON envelope shape differs from FallbackController (W-18)
- **Cicchetto:** module-level event listeners survive identity rotation
  (M-cic-1); `__cic_*` window globals exposed in production (M-cic-2);
  ScrollbackPane self-JOIN banner re-fires `setSelectedChannel` (carry-
  over)
- **Lifecycle:** `WSPresence.notify_sessions/2` overuses Phoenix.PubSub
  for local fan-out (M); `Visitors.Reaper` zero-sweep silent (M);
  `pending_auth_timeout` discards password without telemetry (M)
- **IRC:** Parser tolerance not pinned for tab-as-separator + 4096-byte
  tag-blob limit + >14 middle params (B5-MED-5); `IRC.AuthFSM.parse_cap_list`
  three-pass when one suffices (S20 carry-over)
- **Docker:** `.env.example` defaults `PHX_HOST=grappa.bad.ass` (M1);
  `bin/start.sh` shebang inconsistent with rest of repo (M2); nginx no
  rate limits / `client_max_body_size` / `gzip` for public open (M3)

---

## Trajectory section — what to fix BEFORE each next cluster

### Before push notifications
- B1 catch-all hardening (CRIT-1, HIGH-2, HIGH-7) — push will read
  `meta.raw` and `kind` on every server-event row; the contract should
  be settled before a new consumer joins
- HIGH-5 `broadcast_event/2` return surfacing — push delivery decision
  needs telemetry, not silent success
- HIGH-23 `list_archive/3` perf test — push enumeration will hit it
- HIGH-21 `ReadCursor.set/4` settle-event chatter — push counter
  computation runs per (subject, network, channel) per render
- M3 cic per-kind `meta` discriminated union — push notification
  decision logic builds on `meta`
- M4 typed `topic_for/1` dispatch — pre-empts P-0f-class silent-drop

### Before image upload
- HIGH-19 body-size cap at controller boundary (and channel)
- M3 nginx `client_max_body_size 16m`
- HIGH-29 nginx CSP edit hot-deploy fix (so allowlist edits actually
  take effect)
- `:server_event` kind extension for attachment metadata (HIGH-7 fix
  enables this)

### Before voice
- Separate `/voice/websocket` socket; codify
  `Topic.voice(user, network, channel)`
- Bandit WS payload-size cap raise

### Before mobile UI polish
- Fix the missing per-tab close affordance on BottomBar (mobile
  branch known gap from May-12)
- Real browser smoke at every bucket close

### Before PUBLIC OPEN
- HIGH-29 nginx config hot-deploy fix → land first; everything else
  needs nginx edits to be enforceable
- M3 nginx rate limits + `limit_conn`
- W-16 signing_salt rotation
- M-cic-2 strip `__cic_*` window globals from production builds
- M6 unify five error envelopes to `{error, info}`
- HIGH-12 ETS test cleanup so CI is reliable for visitor traffic
- Backoff ETS reaper for stale (subject, network) keys
- Per-IP rate limit BEFORE admission so circuit-breaker doesn't trip
  on bot floods from one IP

---

## B6 fold-in candidate list (final)

In priority order (fix in B6 before cluster close):

1. **CRIT-1** AUTHENTICATE deny-list at EventRouter catch-all head
2. **HIGH-2** Empty-trailing fallback (verb-name OR `:server_event`)
3. **HIGH-3** Remove 321/322/323/364/365 from `@delegated_numerics`
4. **HIGH-4** NumericRouter `scan_params` 2-param shape fix
5. **HIGH-6** Meta atom-key flattening (`raw_verb/raw_sender/raw_params`)
6. **HIGH-7** `:server_event` kind addition (enables HIGH-2 honest fix)
7. **HIGH-8** CSS `--fg-muted` → `--muted` replace_all (14 sites)
8. **HIGH-9** B0/B2/B4 Playwright e2e (3 spec files)
9. **HIGH-18** `broadcast_event/2` struct-rejection guard
10. **HIGH-26** `Scrollback.Wire.to_json/1` typespec/wire alignment
11. **HIGH-27** deploy.sh field-additions AST oracle
12. **HIGH-28** deploy.sh migration class
13. **HIGH-29** deploy.sh nginx class
14. **HIGH-30** nginx.conf doc rewrite (CP23 collapse drift)
15. **X3 + X4** `:toml` dep removal + `compile_env!` flip (cheap carry-overs)

The HIGH-5 `broadcast_event/2` return surfacing is a strong B6
candidate too; left out of the fold-in list because it changes a
public function signature that ~30 call sites consume — could land in
B6 if the cluster is willing to spread one cluster-wide refactor.

---

## What's working well (worth recording)

From cross-module's "zero counts":

- `\\` default arguments in `lib/`: 0 (the matches in mix tasks are
  inside `@moduledoc` heredoc shell-continuation examples, not real
  defaults)
- `String.to_atom/1` from external input: 0
- Bare `rescue _` / `catch _, _`: 0 (every rescue is bounded shape with
  inline WHY)
- `Repo.insert/2` without changeset: 0
- Inline-interpolation Logger calls: 0 (May-12 S2 fix held)
- Runtime `Application.put_env`: 0 (every match is mix-task pre-boot or
  `Application.start/2`)
- Runtime `Application.get_env` outside documented exception: 0
- Wire-shape modules: every PubSub-publishing context has a `wire.ex`
  (`accounts/wire.ex`, `cic/wire.ex` NEW, `networks/wire.ex`,
  `query_windows/wire.ex`, `scrollback/wire.ex`, `session/wire.ex`,
  `visitors/wire.ex`)
- `Grappa.HotReload.LongLivedModules` extraction since May-12: single
  source of truth parsed by deploy.sh, type-checked by Dialyzer,
  doc'd in CLAUDE.md — eliminates the doc/script/code drift class

## Cluster verdict

**Substrate is healthy.** The 31 HIGHs are a mix of (a) B1's secondary
failure modes that need closing in B6, (b) carry-overs from May-12 that
remain cheap to land, and (c) trajectory blockers that could be deferred
to their target cluster but are flagged for visibility.

**The B1 catch-all should NOT be reverted** — it does close a real
silent-drop class. It just needs the deny-list (CRIT-1), the empty-trailing
fallback (HIGH-2), and the meta-shape flattening (HIGH-6) to deliver on
its thesis. All three are small diffs.

The "no-silent-drops" cluster's principal goal is partially complete.
B6 should land the B-fold-in list above before the cluster is marked
CLOSED in the project story.

