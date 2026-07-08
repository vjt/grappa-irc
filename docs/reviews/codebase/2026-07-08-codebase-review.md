# Codebase Review — 2026-07-08

**Type:** Periodic line-level codebase review (per `docs/reviewing.md`; due
by the 12-session / 2-week cadence — last review 2026-05-22).
**Method:** 8 parallel background agents, one per scope (irc, persistence,
lifecycle, web, cicchetto, cross-module, docker, cross-surface). vjt's three
named concerns — **DUPLICATION, LEAKS, SECURITY** — were pushed hard through
the relevant lenses.
**Emphasis honesty:** the first fan-out of 8 hit a transient upstream
rate-limit; the affected agents were re-dispatched in smaller waves and ALL 8
returned. No scope was reviewed partially.

## Severity counts (after de-dup)

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 23 (22 gating + 1 non-gating) |
| LOW | 24 |
| **Total (unique)** | **50** |

53 raw findings; 3 merged as cross-agent corroborations (S2, S32, S43).
Problems-only — no praise recorded. Deliberate-and-documented patterns
(#182 push-suppression, #192 focus-fold, rfc1459 nick fold, raw-cased members
map, `verify: :verify_none`, single sqlite file, #171 per-IP cap, #153
visitor-eligibility, token-on-WS-query-string) were verified against their
contracts and NOT flagged.

Per-scope: web 8 · irc 5 · persistence 6 · lifecycle 3 · cross-module 8 ·
cross-surface 8 · cicchetto 6 · docker 9.

---

## CRITICAL

None.

---

## HIGH

### S1. Upstream-controlled 333/329 timestamps crash the whole Session
**File:** `lib/grappa/session/event_router.ex:2386-2387` (also `:855`, `:896`)
**Category:** malformed-input handling / crash-boundary / let-it-crash misuse
**Severity:** HIGH
`parse_unix_ts/1` does `DateTime.from_unix!(String.to_integer(ts_str))`.
`String.to_integer/1` raises `ArgumentError` on any non-numeric value, and
`from_unix!/1` raises on an in-range-parse-but-out-of-calendar bignum. The 4th
positional of `:server 333 me #chan setter <ts>` (RPL_TOPICWHOTIME) is fully
upstream-controlled and reaches this unguarded — either raise crashes
`Session.Server`, dropping the live IRC connection + all in-memory
members/topics/window state and driving a reconnect/backoff loop. The sibling
329 RPL_CREATIONTIME handler at `:893-896` already parses gracefully with
`Integer.parse` + a `_ -> {:cont, ...}` fallthrough, but its
`DateTime.from_unix!(ts)` at `:896` still raises on an out-of-range bignum, so
it shares half the defect. A cosmetic topic-setter timestamp must not be able
to nuke an always-on session (`verify_none`, hostile/non-conforming upstream).
**Fix:** Replace `parse_unix_ts/1` with non-bang parsing (`Integer.parse` then
`DateTime.from_unix/2`, dropping the metadata on `:error`), mirroring the 329
arm; switch the 329 `from_unix!` to `from_unix/2` so out-of-range folds to a
no-op.

### S2. `count_after/5` + `count_after_split/5` default `own_nick \\ nil` re-opens the CP14-B3 DM over-count
**File:** `lib/grappa/scrollback.ex:372` and `:408`; live divergent call site `lib/grappa_web/controllers/me_controller.ex:240`
**Category:** DM/case-fold correctness · CLAUDE.md default-arg violation · one-feature-one-code-path
**Severity:** HIGH — *corroborated by persistence + cross-module agents*
Both counters declare `own_nick \\ nil`, the exact footgun already removed from
`fetch/6` in REV-J M12 (docstring `scrollback.ex:238-244`: "no wrapper arities
that default a load-bearing parameter"). `own_nick` selects the own-nick-window
narrowing branch in `channel_or_dm_where/3` (`scrollback.ex:697`). With
`own_nick = nil` and a `channel` equal to the user's own nick, the query falls
through to `dm_eligible?` → `channel == ^ch OR dm_with == ^ch`, pulling **every
inbound DM ever received** (all stored at `channel = own_nick`). Live and
inconsistent across the two doors that seed the same badge: the per-channel WS
`join_reply` (`grappa_channel.ex:287`) threads `own_nick` correctly, but the
`/me` cold-load `build_unread_counts/2` (`me_controller.ex:240`) calls
`count_after_split(subject, net_id, channel, cursor)` with no `own_nick`,
over-counting the own-nick window by every inbound DM — so the two counts
disagree.
**Fix:** Remove both `\\ nil` defaults; make `own_nick` a required positional
(as `fetch/6` already is), then resolve + thread the own-nick through
`me_controller.ex:240`.

### S3. Generated `wireTypes.ts` is a near-dead drift-gate — the real cic types are an unguarded parallel transcription
**File:** `cicchetto/src/lib/wireTypes.ts` (generated, ~80 types) vs `cicchetto/src/lib/api.ts` (hand-rolled mirrors) + `cicchetto/src/lib/wireNarrow.ts`; bridge `cicchetto/src/lib/wireTypesAssert.ts:67-82`
**Category:** DUPLICATION (server↔client)
**Severity:** HIGH
`mix grappa.gen_wire_types` emits ~80 TS types from server `*.Wire` typespecs
and `check.sh` gates typespec→committed drift. But the generated file is
*imported* by only `serverSettings.ts` and `wireTypesAssert.ts` (verified:
`api.ts` + `pushTriggers.ts` only mention it in comments). `wireTypesAssert.ts`
asserts structural equivalence for exactly THREE types (`ConnectionState`,
`FeaturedChannelLink`, `DirectoryEntry`) and its own TODO admits the rest are
unmigrated. So ~27 hand-rolled `api.ts` mirrors + their runtime narrowers have
NO compile-time link to the server-derived types — the codegen catches
typespec↔committed drift but not committed↔`api.ts` drift for ~90% of the wire.
This is the "half-migrated → two patterns" state CLAUDE.md forbids, and it is
the root enabler of findings S13–S16 below.
**Fix:** Land `_Assert_*` pairs in `wireTypesAssert.ts` for every hand-rolled
`api.ts` type with a generated counterpart, then have `wireNarrow.ts` import the
generated types as return types — converting the codegen into an end-to-end
server↔cic gate and letting the hand-rolled unions be deleted.

---

## MEDIUM

*(Gating unless explicitly tagged `[NON-GATING]`.)*

### S4. Upload per-file size cap enforced only after the whole file is read into BEAM memory
**File:** `lib/grappa_web/controllers/uploads_controller.ex:150-156`
**Category:** SECURITY — DoS / resource exhaustion
**Severity:** MEDIUM
`create/2` reads the entire multipart temp file into memory
(`{:ok, bytes} <- read_file(upload)`) and only *then* checks the per-category
cap. The transport ceiling is 128 MiB (`endpoint.ex:79`) but the image cap is
10 MiB — an authenticated user or visitor can POST ~127 MiB fully buffered to
disk then fully read into the BEAM heap before the 10 MiB policy rejects it
(~12× amplification, repeatable concurrently). Endpoint is visitor-eligible.
**Fix:** `File.stat(upload.path)` and compare `.size` against the cap *before*
`read_file/1`; reject oversize files without reading bytes.

### S5. Public upload serving lacks `X-Content-Type-Options: nosniff`
**File:** `lib/grappa_web/controllers/uploads_controller.ex:179-184`
**Category:** SECURITY — stored-XSS / MIME-sniffing (defense-in-depth)
**Severity:** MEDIUM
`show/2` streams user-uploaded bytes from the **same origin** as cic with
`content-disposition: inline`, `cache-control: public, max-age=3600`,
`content-type: row.mime`, and no `nosniff`. `text/plain` is in the accept
allowlist (`:70-98`), so uploaded text containing HTML/JS can be sniffed and
rendered as HTML on the app origin (where the bearer lives in client storage);
the 1-hour cache amplifies persistence.
**Fix:** `put_resp_header("x-content-type-options", "nosniff")` on both the 200
and 206 paths in `send_ranged/4`; consider `content-disposition: attachment`
for text/document categories.

### S6. Admin (mode-1) login has no rate-limit / brute-force protection
**File:** `lib/grappa_web/controllers/auth_controller.ex:94-109`, `:234-255`
**Category:** SECURITY — authn / credential brute-force
**Severity:** MEDIUM
The visitor branch is gated by the #171 per-IP cap + captcha + admission, but
the `@`-identifier admin branch (`mode1_login/3` →
`Accounts.get_user_by_credentials/2`) has no captcha, no per-IP throttle, no
lockout — operator passwords can be brute-forced at bcrypt speed. bcrypt cost
is the only friction.
**Fix:** Apply the same per-source-IP admission/throttle (or a login-specific
counter) to the mode-1 path, or confirm+document that nginx fail2ban (#160)
explicitly covers `/auth/login` mode-1 — nothing in code does today.

### S7. Admin user deletion tears down neither the live WebSocket nor the live Session.Server
**File:** `lib/grappa_web/controllers/admin/users_controller.ex:132-138`; contrast `me_controller.ex:170-175` and `lib/grappa/accounts.ex:306`
**Category:** SECURITY — mid-flight authz / resource leak
**Severity:** MEDIUM
`delete/2` calls only `Accounts.delete_user/1` (bare `Repo.delete` + FK
cascade) — it does NOT stop the user's `Session.Server` nor close its WS. Both
self-delete (#157) and logout (#126 H2) explicitly
`UserSocket.disconnect_subject/1`, and admin *visitor* deletion goes through
`Operator.delete_visitor/1` which terminates the session first. A deleted user
keeps a live upstream IRC connection (orphaned Session.Server) and a live WS
receiving PubSub pushes until the socket happens to close.
**Fix:** After `Accounts.delete_user/1`, call
`UserSocket.disconnect_subject({:user, user})` and route user deletion through
an `Operator`-style helper that stops the live `Session.Server`(s), mirroring
`delete_visitor/1`.

### S8. Admin password rotation does not revoke the target's existing sessions
**File:** `lib/grappa_web/controllers/admin/users_controller.ex:102-122`
**Category:** SECURITY — authn / session lifecycle
**Severity:** MEDIUM
`update_password/2` notes "Auth sessions are NOT revoked (token is session-id,
not derived from password)." An operator rotating a *compromised* account's
password cannot thereby evict the attacker — every previously-minted bearer
stays valid, defeating the usual point of a forced reset.
**Fix:** After `Accounts.update_password/2`, revoke the user's
`accounts_sessions` rows (and `disconnect_subject/1` their sockets), or provide
a "rotate + revoke" verb. At minimum document the security rationale for
withholding revocation.

### S9. Bearer token (`session_id` = session PK) is written to logs, including a still-valid token
**File:** `lib/grappa/accounts.ex:502-505` (and `:439`); allowlisted at `config/config.exs:197`
**Category:** SECURITY — credential logged
**Severity:** MEDIUM
`Grappa.Accounts.Session`'s `:id` **is** the bearer token
(`accounts/session.ex:6-8`). `session_id` is on the Logger metadata allowlist,
so it is emitted. `touch_session/2` logs `session_id: session.id` on the
backward-clock warning path for an **active, non-revoked** session — a live
bearer in the log stream (log-read access is broader than DB access). CLAUDE.md
Security: "Credentials … Never logged." (The `revoke_session/1` and authn-plug
logs are dead tokens — lower risk.)
**Fix:** Never log the raw session id; log a non-reversible handle (truncated
SHA-256, or the `user_id`/`visitor_id` that already correlates lifecycle). Drop
`session_id` from the allowlist or replace with the hashed handle.

### S10. Pending-accumulator maps have no TTL sweep; withheld terminators strand entries
**File:** `lib/grappa/session/event_router.ex:2422` (`whois_pending`), `:2612` (`who_pending`), `:2658` (`names_pending`), `:2470` (`whowas_pending`); `labels_pending` primed at `session/server.ex:2602`
**Category:** LEAK — unbounded accumulator / process-state-stays-small
**Severity:** MEDIUM
These keyed maps grow one entry per operator command and shrink only on the
terminator numeric (318/315/366/369-or-406) or re-query. Unlike
`in_flight_joins` — which has a documented lazy 30s TTL sweep
(`server.ex:3446-3482`) precisely because a terminator may never arrive — these
five have no sweep. A withheld terminator (dropped line, non-conforming/hostile
ircd) permanently strands the entry for the always-on process lifetime. The
type docs actively misstate this ("Bounded by in-flight commands",
`numeric_router.ex:98`).
**Fix:** Reuse the `in_flight_joins` lazy-TTL pattern — stamp each pending entry
at prime time, sweep stale entries on the next prime.

### S11. `Backoff` ETS table has no eviction when a visitor subject is destroyed — orphans accumulate for the node lifetime
**File:** `lib/grappa/session/backoff.ex:205-208` + `lib/grappa/session/server.ex:920-924`; leak path `lib/grappa/visitors/login.ex:239`, `Visitors.Reaper`
**Category:** LEAK — ETS grows without eviction
**Severity:** MEDIUM
`:session_backoff_state` is keyed `{subject, network_id}`; an entry is created
on abnormal exit (`terminate/2` → `Backoff.record_failure`) and removed only by
`record_success/2` (001) or `reset/2` (operator respawn). For `{:visitor, uuid}`
each fresh anon login mints a new UUID: a crash-before-001 followed by case-1's
`Visitors.purge_if_anon` (`login.ex:239`) deletes the visitor row but never
`Backoff.reset`s — the row now references a destroyed subject and can never be
cleared. `Visitors.Reaper` has the same gap. The `preempt_and_respawn` path
(`login.ex:346`) *does* reset — proving the missing eviction. `NetworkCircuit`
is keyed by `network_id` (bounded), so only Backoff leaks. High-churn anon
logins are the explicit PUBLIC-OPEN target.
**Fix:** Add a subject-destruction eviction hook — `Backoff.forget(subject)`
(`:ets.match_delete` all networks) — called from the single `Visitors`
delete/reap choke point (and the case-1 failure branch).

### S12. Dropping the `read_cursors.last_read_message_id` index makes bulk scrollback deletes a full child-scan per row (migration rationale is wrong)
**File:** `priv/repo/migrations/20260514064102_drop_unused_read_cursors_last_read_message_id_index.exs:23-25`; delete path `lib/grappa/scrollback.ex:851-857`, `:801-810`
**Category:** LEAK — missing FK child-key index vs bulk-delete under the single write lock
**Severity:** MEDIUM
`read_cursors.last_read_message_id` is `REFERENCES messages(id) ON DELETE SET
NULL`. The migration claims SQLite "scans by message PK then patches the cursor
row in place" — backwards: for `ON DELETE SET NULL` SQLite must locate **child**
rows whose FK equals each deleted parent, and with no child-key index that is a
full `read_cursors` scan per deleted `messages` row. `delete_for_channel/3` /
`delete_for_dm/3` `Repo.delete_all` can drop tens of thousands of rows in one
transaction → `O(deleted × read_cursors)` while holding the single SQLite write
lock, spilling into the 30s `busy_timeout` for concurrent writers.
**Fix:** Recreate the `(last_read_message_id)` index (accept the small
cursor-upsert write-amplification), or at minimum correct the migration's
rationale and gate/ document large-purge cost.

### S13. `join_failed.numeric` nullability drift — cic type + narrower reject the `null` the server contract permits
**File:** `lib/grappa/session/wire.ex:270-277` + `session/window_state.ex:294-299` vs `cicchetto/src/lib/api.ts:574` + `cicchetto/src/lib/wireNarrow.ts:219-234`
**Category:** wire-shape drift (optionality)
**Severity:** MEDIUM
Server `join_failed_payload` declares `numeric: pos_integer() | nil`; the
cold-subscribe snapshot builds it via `Map.get(ws.failure_numerics, channel)`
(nil when absent). cic's arms type `numeric: number` (non-null) and
`narrowWindowStateEvent` drops the ENTIRE event when numeric is null —
regressing the CP15-B3 cold-reconnect "failed tab" snapshot. Latent today
(event-time effect always carries a `pos_integer`), but both server contract and
snapshot code permit null.
**Fix:** Widen cic to mirror the typespec (`numeric: number | null`, accept
`null` in the narrower); or assert server-side that `:failed` never emits nil.
Server typespec is source of truth → cic widens.

### S14. `MessageKind` closed set is transcribed twice on cic with no gate; a new server kind silently drops messages
**File:** `lib/grappa/scrollback/message.ex:99-111` (`@kinds`) + `scrollback/wire.ex:43` (widens to `kind: String.t()`) vs `cicchetto/src/lib/api.ts:479-490` + `cicchetto/src/lib/wireNarrow.ts:48-60,71`
**Category:** DUPLICATION (closed set) / drift-risk
**Severity:** MEDIUM
`Scrollback.Wire.t/0` widens the authoritative 11-atom `Message.@kinds` to
`kind: String.t()`, so codegen emits `kind: string` — the closed set does not
propagate. cic re-hardcodes 11 values in TWO places and
`narrowScrollbackMessage` returns `null` on an unknown kind, dropping the whole
message. Adding a 12th server kind fails nothing at CI and silently discards
every message of that kind. Contrast `server_reply_source`, correctly declared
as an atom union in the typespec (codegen pins the literal union).
**Fix:** Declare the kind as an atom union in `Scrollback.Wire.t/0` so codegen
emits a literal union; assert cic's `MessageKind` against it; have
`wireNarrow.ts` import it. Collapses 3 copies into one gated chain.

### S15. `upload.active_host` closed set — same widen-to-string + drop-on-unknown pattern as S14
**File:** `lib/grappa/server_settings.ex:82` (`:embedded | :litterbox`) + `server_settings/wire.ex:46` (widens to `String.t()`) vs `cicchetto/src/lib/api.ts:911` + `cicchetto/src/lib/userTopic.ts:385`
**Category:** DUPLICATION (closed set) / drift-risk
**Severity:** MEDIUM
Server owns `:embedded | :litterbox`, Wire widens to `String.t()`, cic
hardcodes the two values in the `WireUserEvent` arm AND the
`server_settings_changed` narrower (drops the ENTIRE settings event on an
unknown host). Adding `:s3` silently kills the reactive settings push for every
client.
**Fix:** Declare the atom union in the typespec so codegen pins it; assert cic's
copy (`serverSettings.ts` already imports the generated type).

### S16. `MeResponse` visitor `expires_at` typed non-null on cic, but server sends `null` for registered visitors
**File:** `lib/grappa_web/controllers/me_json.ex:102` (`DateTime.t() | nil`) + `visitors/wire.ex:62` vs `cicchetto/src/lib/api.ts:194` (`string`); cic's own contradicting `api.ts:1379` (`AdminVisitor.expires_at: string | null`)
**Category:** wire-shape drift (optionality) / REST-vs-REST inconsistency
**Severity:** MEDIUM
`AdminVisitor.expires_at` is correctly `string | null` (rendered as "indefinite
(NickServ)"), but `MeResponse` visitor types `string`. NickServ-registered
visitors carry `expires_at = NULL`. No current consumer reads it (no live
crash), but any future countdown gets `new Date(null)`.
**Fix:** `MeResponse` visitor `expires_at: string | null`; better, derive from
the generated `VisitorsWireT` (already nullable).

### S17. "Content kind" closed set `[:privmsg, :notice, :action]` re-declared in 6 places (drift already started)
**File:** `lib/grappa/scrollback.ex:69`, `lib/grappa/mentions.ex:71`, `lib/grappa/session/event_router.ex:2197`, `lib/grappa/scrollback/message.ex:134`, inline `scrollback.ex:166`, SQL twin `scrollback.ex:417,419`
**Category:** DUPLICATION / closed-set restatement
**Severity:** MEDIUM
The human-content subset is restated across contexts —
`event_router.ex:2197` has the same three atoms **reordered** (drift started),
and there is a hand-maintained raw-SQL `IN ('privmsg','notice','action')` copy.
`Message` exposes `kinds/0` (full enum) but not the content subset, so every
consumer re-declares. A new content kind must be edited in 6 places or
windows/notifications/counts diverge.
**Fix:** Add `Grappa.Scrollback.Message.content_kinds/0` as the single source;
derive `Scrollback`, `Mentions`, `EventRouter`, and the SQL `IN (...)` list from
it at compile time.

### S18. Service-worker notification icon + badge point to a 404 path
**File:** `cicchetto/src/service-worker.ts:163-164`
**Category:** PWA shell / correctness (shipped-feature defect)
**Severity:** MEDIUM
`showNotification` sets `icon`/`badge` to `/icons/icon-192.png`, but icons are
served at root (`/icon-192.png`) — confirmed in `public/` + `dist/`, and the
manifest + `index.html` use root paths. Every Web Push notification fetches a
404 and renders the browser's blank glyph.
**Fix:** Use `/icon-192.png`; add a test tying the SW icon path to the manifest
icon `src`.

### S19. Per-channel WS subscriptions are never torn down on PART/close
**File:** `cicchetto/src/lib/subscribe.ts:115-124`, `:419-420`
**Category:** LEAK — WS subscriptions never torn down
**Severity:** MEDIUM
The `joined` Map (`ChannelKey → Channel`) is `.leave()`d only on token
rotation. On PART, `setParted(key)` drops the `windowState` entry but leaves the
Phoenix `Channel` + its `phx.on("event", …)` handler alive on the socket. Over
an always-on session that joins/parts many channels, subscriptions + handlers
accumulate until logout. The moduledoc notes this as a known Phase-5 gap.
**Fix:** On own-PART also `joined.get(key)?.leave(); joined.delete(key)`; guard
re-JOIN races via the existing pre-subscribe loop.

### S20. Scrollback store grows unbounded
**File:** `cicchetto/src/lib/scrollback.ts:98-100, 136-143, 494-500`
**Category:** LEAK — growing store never pruned
**Severity:** MEDIUM
`scrollbackByChannel[key]` only grows (append live, prepend history, append
refresh); the only removals are archive-delete + identity reset. A PWA kept open
for days on a phone accumulates every message in memory with no cap.
**Fix:** Cap per-channel row count (ring buffer — keep newest N, reset the
`loadMore` exhausted latch), or trim non-focused channels.

### S21. `/topic -delete` is fire-and-forget — swallows WS-down / server errors
**File:** `cicchetto/src/lib/compose.ts:346` (via `cicchetto/src/lib/socket.ts:475-478`)
**Category:** no-silent-drop divergence
**Severity:** MEDIUM
`pushChannelTopicClear` returns `void` and the compose handler immediately sets
`result = { ok: true }`. Unlike the op/deop/voice/kick/ban/mode verbs that #154
converted to awaited Promises with `.receive("error") → friendlyChannelError`, a
topic-clear failure (socket down, server `{:error, _}`) is silently swallowed and
the box paints success.
**Fix:** Give `pushChannelTopicClear` the shared `pushUserChannelVerb` Promise
shape and `await` it, matching the #154 contract.

### S22. Six near-identical param-whitelist / atomize helpers across 5 admin controllers
**File:** `lib/grappa_web/controllers/admin/servers_controller.ex:193`, `users_controller.ex:233`, `networks_controller.ex:224`+`:265`, `featured_channels_controller.ex:113`, `credentials_controller.ex:296`
**Category:** DUPLICATION (copy-paste with tweaks)
**Severity:** MEDIUM
`take_atomized/2` + `put_if_present/3` are byte-identical in four controllers;
`networks`' `atomize_caps/2` and `credentials`' `atomize/2` inline the same
reduce (credentials adds a value hook). Four verbatim copies + two inlined
variants of one helper.
**Fix:** Extract one shared `GrappaWeb.Validation.take_atomized(params, keys,
value_fun)` (value_fun a genuine config default) and delete the copies.

### S23. Push private-message nick whitelist matches with plain `String.downcase` — bypasses the rfc1459 fold (#121 invariant)
**File:** `lib/grappa/push/triggers.ex:209` (match) + `lib/grappa/user_settings.ex:587` (`normalize_list/1` store)
**Category:** SECURITY-adjacent / invariant violation (nick fold)
**Severity:** MEDIUM
`sender_in_whitelist?/2` does `String.downcase(sender) in prefs[...]` and the
stored list is lowercased with plain `String.downcase`. CLAUDE.md: "EVERY
server-side nick compare routes through `canonical_nick`… never a bare
`String.downcase` or `==`." A whitelisted `foo[bar]` won't match inbound
`foo{bar}` (same nick on bahamut) — the identity-fork class #121 closed. (The
sibling `channel_in_whitelist?/2` downcase is fine — channels fold via
`canonical_channel` = downcase.)
**Fix:** Route the sender whitelist through
`Grappa.IRC.Identifier.canonical_nick/1` on both the store path (nick lists only)
and the match; keep channel normalization on `canonical_channel/1`.

### S24. `cicchetto-build` tmpfs hardcodes `uid=1000/gid=1000` while `user:` is parameterized — breaks the build for any non-1000 operator
**File:** `compose.yaml:150` (vs `user:` at `compose.yaml:143`)
**Category:** correctness / UID-drop trap
**Severity:** MEDIUM
The service drops to `user: "${CONTAINER_UID:-1000}:…"` but its tmpfs is
`- /tmp:exec,uid=1000,gid=1000` with `HOME: /tmp`. When `CONTAINER_UID != 1000`
(the path `quickstart.sh:72` drives for non-1000 hosts), bun's `HOME=/tmp`
writes hit EACCES → `bun install && bun run build` fails →
`nginx depends_on cicchetto-build: service_completed_successfully` never
satisfies → deploy hangs. The e2e stack got this right
(`cicchetto/e2e/compose.yaml:299`).
**Fix:** `- /tmp:exec,uid=${CONTAINER_UID:-1000},gid=${CONTAINER_GID:-1000}`.

### S25. Preflight state-shape detection ignores `init/1` map literals despite deploy.sh promising it — latent silent false-HOT
**File:** `lib/grappa/deploy/preflight.ex:363-379` (`collect_state_blocks/1`), promised by `scripts/deploy.sh:22`
**Category:** correctness / hot-vs-cold classification
**Severity:** MEDIUM
`deploy.sh:22` says state-shape change is detected via "`defstruct`, `@type t ::
%{...}`, or `init/1` map literal", but `collect_state_blocks/1` matches only
`@type t` and `defstruct` — no `init/1`-return-map clause. A tracked long-lived
GenServer carrying non-trivial state as a bare `{:ok, %{...}}` in `init/1` with
neither block would compare equal across revs → classified HOT → the next
callback pattern-matches new shape against old in-memory state (the silent-
corruption class the classifier exists to prevent). No module is *currently*
vulnerable, but S46 proves `@modules` entries with no state block are already
accepted, and the comment over-promises.
**Fix:** Add an `init/1`-map clause to `collect_state_blocks/1`, OR drop the
claim from `deploy.sh:22` and add a compile/test assertion that every
`LongLivedModules.modules/0` entry exposes a `defstruct` or `@type t`.

### S26. `.dockerignore` `node_modules/` is root-anchored — 316 MB of `cicchetto/node_modules` bloats every grappa image build `[NON-GATING]`
**File:** `.dockerignore:30` (with `Dockerfile:59` `COPY . .`, `compose.yaml:31` `context: .`)
**Category:** simplification / build-efficiency
**Severity:** MEDIUM
Docker `.dockerignore` patterns are root-anchored: `node_modules/` matches only
`./node_modules`, not `cicchetto/node_modules` (316 MB present). Every grappa
Elixir image `COPY . .` tars 316 MB of dead JS deps into the build context
(runtime bind-mount shadows it, so it is never used) — pure
context-transfer/image-size waste. Efficiency only, no correctness impact →
non-gating.
**Fix:** Add `**/node_modules` (ideally `cicchetto/` wholesale) to
`.dockerignore`.

---

## LOW

### S27. `AdminChannel` authz reads an `is_admin` snapshot frozen at WS connect
**File:** `lib/grappa_web/channels/admin_channel.ex:75`; `channels/user_socket.ex:182`
**Category:** stale privilege
**Severity:** LOW
`authorize/1` gates on `socket.assigns.is_admin`, set once at `connect/3`. A
demoted admin's already-open socket keeps `is_admin: true` and keeps receiving
the `grappa:admin:events` stream until reconnect;
`PATCH /admin/users/:id {is_admin:false}` does not disconnect the socket. Bounded
by socket lifetime (same root as S7).
**Fix:** On demotion `disconnect_subject/1` the user, or re-check `is_admin` from
the loaded subject on admin-channel join/heartbeat.

### S28. `Plug.Session` is mounted (with runtime salt machinery) but never read or written
**File:** `lib/grappa_web/endpoint.ex:85` (plus `:91-153` salt resolution)
**Category:** dead code / unused plug
**Severity:** LOW
Zero `get_session`/`put_session`/`fetch_session` calls in non-test code — auth
is entirely Bearer. The cookie session plug, `SECRET_SIGNING_SALT` runtime read,
`:persistent_term` caching, and `config_change/2` override exist solely to sign a
cookie nothing consumes (and it ships on every response).
**Fix:** Remove `plug :session` + the salt machinery, or comment why it is kept
live.

### S29. Vacuous both-branches-identical dead code in user create validation
**File:** `lib/grappa_web/controllers/admin/users_controller.ex:201-205`
**Category:** dead code
**Severity:** LOW
The inner `if extra == [], do: {:error, :bad_request}, else: {:error,
:bad_request}` returns the same value in both arms.
**Fix:** Collapse the `else` to a bare `{:error, :bad_request}`.

### S30. AuthFSM PASS path does not reject spaces in the server password
**File:** `lib/grappa/irc/auth_fsm.ex:220-222` (`maybe_send_pass`), validation `:185-200`
**Category:** malformed-input handling / boundary consistency
**Severity:** LOW
`maybe_send_pass` emits `"PASS #{pw}\r\n"` but the validators only reject
CR/LF/NUL, not spaces. `PASS` is a single wire token (RFC 2812 §3.1.1); a
space-containing password silently truncates server-side → 464 + restart loop
with no breadcrumb. The OPER path already guards with the stricter
`Identifier.safe_oper_token?/1`.
**Fix:** Gate the PASS-bound password with a space/tab-rejecting single-token
predicate for `:server_pass`/`:auto`.

### S31. `:peer_away` effect can carry `nil` while its type declares `String.t()`
**File:** `lib/grappa/session/event_router.ex:1131` (effect type `:181`)
**Category:** type safety
**Severity:** LOW
For a malformed 301 with no trailing (`params == [_, target]`),
`whois_trailing(rest)` returns `nil`, so `away_message` is `nil` while the effect
type declares `String.t()`; a null flows over PubSub to cic's `peer_away`
handler. Dialyzer did not catch it.
**Fix:** Coalesce to `""` before emitting, or widen the effect type to
`String.t() | nil` and confirm the cic consumer tolerates it.

### S32. Transient channel-keyed maps bypass the `canonical_channel/1` fold SSOT
**File:** `session/server.ex:1252,1272,1433,1444,2967,3413,3480`; `session/event_router.ex:1249,1339,1728,2614,2661,2689`; `networks/session_plan.ex:170,173`
**Category:** consistency / single-source-of-truth bypass
**Severity:** LOW — *corroborated by irc + cross-module agents*
These channel-key lookups derive the key with a bare `String.downcase(channel)`
instead of `Identifier.canonical_channel/1` (the documented SSOT). No live fork
today (`canonical_channel` == `downcase` for sigil names, and prime+drain sides
match), but it is a latent drift point if channel folding ever gains rfc1459
casemapping (bahamut folds channels too).
**Fix:** Route all these through `Identifier.canonical_channel/1` (via the
existing `normalize_channel/1` helper).

### S33. `messages.network_id` has no leading index; network-delete gate + RESTRICT FK full-scan the largest table
**File:** `lib/grappa/scrollback.ex:881-885`; caller `lib/grappa/networks.ex:221-241`
**Category:** LEAK — missing index vs a delete-gate read
**Severity:** LOW
Every `messages` composite index leads with `user_id`/`visitor_id`. When a
network has no messages (the proceed-to-delete case), `has_messages_for_network?/1`
scans the entire table to confirm absence, and `Repo.delete(net)` re-scans to
enforce `ON DELETE RESTRICT`. Two full scans. Rare (operator action).
**Fix:** `create index(:messages, [:network_id])`, or accept + document the cost.

### S34. `Credentials.update_last_joined_channels/3` runs the WIDE credential changeset on the self-JOIN/PART/KICK hot path
**File:** `lib/grappa/networks/credentials.ex:226-242` vs `lib/grappa/visitors.ex:548-562`
**Category:** consistency ("Total consistency or nothing") / half-migrated
**Severity:** LOW
The visitor twin uses a narrow `Visitor.last_joined_channels_changeset/2`; the
user side writes through the wide `Credential.changeset/2` (re-runs all
validators + `put_encrypted_password` + unique_constraint) on every
self-JOIN/PART/KICK. No-ops, but couples a high-frequency write to unrelated
validators. `Credential` already has narrow-changeset precedent.
**Fix:** Add `Credential.last_joined_channels_changeset/2` and route through it.

### S35. `Visitors.list_all/0` is unbounded and feeds N sequential 250 ms `GenServer.call`s
**File:** `lib/grappa/visitors.ex:331-335` (`list_all/0`), `:362-379` (`list_all_with_live_state/0`)
**Category:** LEAK — unbounded list + N-blocking-call fan-out
**Severity:** LOW
The `visitors` table is user-driven (48h TTL + expired-not-reaped rows).
`list_all/0` returns every row with no LIMIT; `list_all_with_live_state/0` loops
it with one registry lookup + one 250 ms `GenServer.call` per visitor —
`O(N × 250 ms)` blocking the admin `GET /admin/visitors` over an unbounded N when
pids are wedged.
**Fix:** Paginate the admin listing (keyset on `inserted_at`), and parallelize
the live-introspection with `Task.async_stream/3` (bounded concurrency).

### S36. `userhost_cache` entries seeded by WHOIS (311) for non-co-member nicks are never evicted within a session
**File:** `lib/grappa/session/event_router.ex:965` (and `:1289`)
**Category:** LEAK — unbounded-ish GenServer map
**Severity:** LOW
`userhost_cache` is evicted by `evict_if_no_overlap/3` on PART/QUIT/KICK, but the
311 handler upserts unconditionally (even unsolicited) for nicks that may share
no channel and so never trigger overlap eviction. Bounded by distinct nicks
`/whois`'d without co-membership; dropped on crash.
**Fix:** Don't seed `userhost_cache` from a WHOIS on a non-co-member, or add a
cap/TTL to WHOIS-seeded entries.

### S37. `handle_terminal_failure` uses unsupervised `Task.start/1`; a crash in the failer silently leaves the credential un-marked `:failed`
**File:** `lib/grappa/session/server.ex:2170-2178`
**Category:** OTP / no-silent-swallow at boundary
**Severity:** LOW
The detach is correct (sync would deadlock, link would kill on `:normal` exit),
but `Task.start/1` is unlinked AND unsupervised (CLAUDE.md wants
`Task.start_link` + `:transient` under a supervisor). If `failer.(reason)` raises,
the DB transition to `:failed` silently never happens, Bootstrap re-spawns the
k-lined session next deploy, and the only trace is an orphan crash report.
**Fix:** Route through a supervised `Task.Supervisor` (add one to the tree),
keeping the detach for the deadlock reason.

### S38. Logger calls interpolate data fields into the message string instead of structured KV
**File:** `lib/grappa/visitors/login.ex:311`, `lib/grappa/uploads/metadata_strip.ex:278`; borderline `session/server.ex:1059,3933`
**Category:** logging convention
**Severity:** LOW
`login.ex:311` and `metadata_strip.ex:278` fold `visitor`/`pid`/`mime`/`reason`
into the message string (CLAUDE.md documents structured allowlisted KV as the
path).
**Fix:** Move the fields into metadata (extend the `config/config.exs` allowlist
— note the cold-deploy cost); keep the message constant.

### S39. `\\ %{}` default argument in shipped `test_support` code
**File:** `lib/grappa/test_support/subject_reset.ex:155`
**Category:** default-argument violation
**Severity:** LOW
`def reset!(user_name, opts \\ %{})` — an options-map default (not a genuine
config default), compiled into the release (drives the e2e reset endpoint).
**Fix:** Drop the default; the single caller passes `%{}` explicitly.

### S40. Runtime `Application.get_env` in `BadgeSource.impl/0` (documented DI seam — informational)
**File:** `lib/grappa/push/badge_source.ex:50`
**Category:** Application env at runtime
**Severity:** LOW (informational)
`def impl, do: Application.get_env(:grappa, :badge_source)` is a runtime read,
but the moduledoc thoroughly justifies it as a behaviour-injection seam breaking
a `Push → BadgeCount → Networks → Session → Push` cycle, with deliberate
`get_env` for graceful hot-deploy degradation — the idiomatic Mox pattern.
**Fix:** None required unless strict-letter compliance is wanted (would mean
injecting the impl through the calling process — the moduledoc explains why
that's awkward here).

### S41. Mixed timestamp representation across payloads (epoch-ms integers vs ISO-8601 strings) with no documented rule
**File:** `lib/grappa/scrollback/wire.ex:38-47` (`server_time: integer()`) + `lib/grappa/session/wire.ex:111-115,146-147,302-309,331`
**Category:** timestamp format consistency
**Severity:** LOW
`server_time`/`signon`/`idle_seconds` are integers; `set_at`/`created_at`/
`opened_at`/`away_started_at`/`expires_at`/`logoff_time` are ISO-8601 strings.
Both sides mirror correctly today, but no documented rule means a new field can
be added as `integer()` server-side and `string` on cic without a gate catching
it (see S3).
**Fix:** Add a one-line rule to a living doc ("message/idle timers are epoch
integers; all other wall-clock stamps are ISO-8601 strings"); once S3's asserts
land the mismatch becomes compile-caught.

### S42. Error-token localization has no coverage gate; ~half of server tokens fall through to the raw wire string
**File:** `cicchetto/src/lib/friendlyApiError.ts:33-76` vs `lib/grappa_web/controllers/fallback_controller.ex`; `cicchetto/src/lib/friendlyChannelError.ts:28-53` vs `channels/grappa_channel.ex:867,962,977,980,1291`
**Category:** error-shape / closed-set duplication
**Severity:** LOW
The wire error envelope is consistent, but the token→copy maps are
hand-maintained subsets with no gate that every server token is localized (~20
REST + several channel tokens unmapped). The fallback is loud (raw
`<status> <code>`), so not a silent drop — but it leaks the raw token to
operators.
**Fix:** Test-pin / generate the full server token set and assert cic's
`KnownApiErrorCode`/`KnownChannelErrorCode` cover the user-facing subset.

### S43. cic `QueryWindowEntry` omits `network_id` the server emits, and the narrower skips per-entry validation
**File:** `lib/grappa/query_windows/wire.ex:22-26` vs `cicchetto/src/lib/api.ts:611-614` + `cicchetto/src/lib/userTopic.ts:150-155`
**Category:** wire-shape drift (missing field) / narrowing-discipline gap
**Severity:** LOW — *corroborated by cicchetto + cross-surface agents*
Server `windows_entry` carries `network_id: integer()`; cic's `QueryWindowEntry`
drops it (benign — network derived from the map key), but the
`query_windows_list` narrower does a bare cast with zero per-entry validation,
breaking the "narrow every WS payload" discipline.
**Fix:** Add `network_id` to the type and narrow each entry with
`narrowArray(..., narrowQueryWindowEntry)`, or document the redundancy and drop
it server-side.

### S44. `lusers_bundle` narrower has a dead branch and coerces instead of rejecting
**File:** `cicchetto/src/lib/userTopic.ts:420-421`
**Category:** TypeScript strictness / boundary robustness
**Severity:** LOW
`const intOrNull = (v) => typeof v === "number" ? v : v === null ? null : null;`
— the `v === null ? null : null` is a tautology, and any non-number/non-null
(e.g. a string) is silently coerced to `null` rather than dropping the payload,
unlike every other strict narrower in the file.
**Fix:** `const intOrNull = (v: unknown): number | null => typeof v === "number"
? v : null;`, or `return null` on a non-null non-number to match the strict
convention.

### S45. Docker `scripts/deploy.sh` has no self-modifying-script re-exec guard
**File:** `scripts/deploy.sh:70` (vs the guard at `infra/freebsd/deploy.sh:140-146`)
**Category:** robustness
**Severity:** LOW
`git pull --ff-only` replaces `deploy.sh` by atomic rename (new inode); the
running bash keeps the old inode's bytes, so a fix downstream of the pull no-ops
on the first deploy that ships it. The FreeBSD jail sibling documents this as a
2026-05-31 incident and fixes it with a re-exec guard; the Docker path (dev
stack only) never got it.
**Fix:** Port the jail's re-exec guard (diff `prev_sha..HEAD` for `deploy.sh`,
`exec` behind a sentinel), or document the deliberate omission.

### S46. `Backoff` + `NetworkCircuit` are ETS-only (`init → {:ok, %{}}`) yet listed in `@modules`, contradicting the module's own policy
**File:** `lib/grappa/hot_reload/long_lived_modules.ex:87,89` (policy at `:54-57`); `session/backoff.ex:249-251`
**Category:** consistency / dead-config
**Severity:** LOW
The moduledoc says ETS-only modules "intentionally fall outside the list," yet
both pure-ETS modules are in `@modules`. Their state-shape check is a permanent
no-op — harmless, but contradicts the stated policy and is the living
demonstration of S25's enforcement gap.
**Fix:** Remove the two from `@modules`, or amend the policy + fix S25 so the
"no state block = always HOT" behavior is intentional and asserted.

### S47. Stale `compose.prod.yaml` references — the file was collapsed in CP23
**File:** `compose.yaml:4`, `compose.oneshot.yaml:1`; also `_lib.sh:20` (named-volume header contradicts the bind-mount reality at `:50-56`)
**Category:** dead-doc / drift
**Severity:** LOW
Comments reference `compose.prod.yaml`, merged into the unified profiled
`compose.yaml` per CP23.
**Fix:** Drop/rewrite the `compose.prod.yaml` mentions; align the `_lib.sh`
header with bind mounts.

### S48. `scripts/iex.sh` bypasses the `_lib.sh` worktree guard — silently attaches to main's code from a worktree
**File:** `scripts/iex.sh:15`
**Category:** consistency / worktree-awareness
**Severity:** LOW
`iex.sh` calls `docker compose … exec grappa iex` directly instead of
`in_container`, so from a worktree it attaches IEx to the container running
**main's** source with no warning. `observer.sh`/`db.sh`/`deploy-cic.sh` all use
`in_container` (which `die`s in this case).
**Fix:** Route `iex.sh` through `in_container` (or emit the worktree warning).

### S49. `bun.sh` uses `id -u`/`id -g` while every compose service uses `${CONTAINER_UID:-1000}` — mixed ownership on the shared `runtime/bun-cache`
**File:** `scripts/bun.sh:48-51` (vs `compose.yaml:37,143`)
**Category:** robustness / UID consistency
**Severity:** LOW
`runtime/bun-cache` is bind-mounted and shared between the raw-`docker run` bun
path (live host UID) and the compose `cicchetto-build` path
(`${CONTAINER_UID:-1000}`). When the operator's real UID differs from the pinned
value, mixed-ownership cache files → intermittent EACCES.
**Fix:** Have `bun.sh` honor `${CONTAINER_UID:-$(id -u)}`/`${CONTAINER_GID:-$(id -g)}`.

### S50. Dead `location = /sw.js` in the reference TLS front — the real SW is `/service-worker.js`
**File:** `infra/nginx-tls-frontend.example.conf:75`
**Category:** dead-config
**Severity:** LOW
`sw.js` was the pre-`vite-plugin-pwa` name; the emitted SW is
`service-worker.js` (`infra/snippets/locations-api.conf:155-165`). The block is
inert (requests fall through to `location /`, which works by luck).
**Fix:** Rename to `location = /service-worker.js`.

---

## Triage / fix plan

**Gate summary:** 0 CRITICAL · 3 HIGH · 22 gating-MEDIUM · (1 non-gating MEDIUM
+ 24 LOW = 25 later-sweep). No P0 — S1 (session crash) requires a
hostile/broken upstream and is contained to one session's restart loop; S2 is a
same-user unread over-count, not a cross-tenant leak.

Every CRITICAL + HIGH + gating-MEDIUM is assigned to a bucket below. Each bucket
is scoped to land in ONE clean worktree session (module/surface-cohesive).
Rides-along LOWs are cheap fixes in the same files — fix opportunistically while
the bucket is open, they do not gate.

### Bucket 1 — Web / auth security hardening
**Gating:** S4, S5, S6, S7, S8, S9 · **Rides-along LOW:** S27, S28, S29
**Scope:** `lib/grappa_web/controllers/uploads_controller.ex`, `auth_controller.ex`,
`admin/users_controller.ex`, `channels/admin_channel.ex`, `endpoint.ex`,
`lib/grappa/accounts.ex`. Upload memory-cap + nosniff, mode-1 login throttle,
admin-delete WS/session teardown, password-rotation revoke, stop logging the
bearer. One session — all web-security-surface.

### Bucket 2 — IRC upstream-input robustness + session-process leaks
**Gating:** S1 (HIGH), S10, S11 · **Rides-along LOW:** S30, S31, S36, S37
**Scope:** `lib/grappa/session/event_router.ex`, `session/server.ex`,
`session/backoff.ex`, `irc/auth_fsm.ex`, `visitors/login.ex` + `Visitors.Reaper`.
Non-bang timestamp parsing, pending-accumulator TTL sweep, Backoff
subject-eviction hook. One session — session-process hardening.

### Bucket 3 — Scrollback DM-leak + persistence perf/index
**Gating:** S2 (HIGH), S12 · **Rides-along LOW:** S33, S34, S35
**Scope:** `lib/grappa/scrollback.ex`, `me_controller.ex`, the read_cursors index
migration, `networks/credentials.ex`, `visitors.ex`. Remove the `own_nick`
defaults + thread it, recreate/justify the child-key index. One session.

### Bucket 4 — Server↔cic wire-shape unification (the drift-gate + closed sets)
**Gating:** S3 (HIGH), S13, S14, S15, S16, S17 · **Rides-along LOW:** S41, S42, S43
**Scope:** `lib/grappa/{scrollback,session,server_settings,query_windows}/wire.ex`,
`scrollback/message.ex`, `me_json.ex`, `cicchetto/src/lib/{api,wireNarrow,
wireTypesAssert,wireTypes,userTopic}.ts`, `mix grappa.gen_wire_types`. Close the
drift-gate (assert hand-rolled ↔ generated), declare closed sets as atom unions
in typespecs, propagate nullability. The largest bucket but one cohesive
mechanism (the codegen chain); needs `WRITABLE_CIC=1` for cic regen.

### Bucket 5 — cic client leaks + silent-swallow + PWA icon
**Gating:** S18, S19, S20, S21 · **Rides-along LOW:** S44
**Scope:** `cicchetto/src/{service-worker.ts, lib/subscribe.ts, lib/scrollback.ts,
lib/compose.ts, lib/socket.ts, lib/userTopic.ts}`. SW icon path, PART teardown,
scrollback ring-cap, topic-clear awaited Promise. One session — cic runtime
hygiene. Needs a real e2e per the E2E-mandatory rule.

### Bucket 6 — cross-module duplication + nick/channel-fold invariants
**Gating:** S22, S23 · **Rides-along LOW:** S32, S38, S39, S40
**Scope:** `lib/grappa_web/controllers/admin/*_controller.ex` (shared
`take_atomized`), `lib/grappa/push/triggers.ex` + `user_settings.ex` (nick fold),
`session/server.ex` + `event_router.ex` + `session_plan.ex` (channel fold).
Extract the shared validation helper, route the push nick whitelist through
`canonical_nick`. One session.

### Bucket 7 — Docker / infra correctness + deploy classifier
**Gating:** S24, S25 · **Non-gating + LOW:** S26, S45, S46, S47, S48, S49, S50
**Scope:** `compose.yaml`, `.dockerignore`, `lib/grappa/deploy/preflight.ex`,
`hot_reload/long_lived_modules.ex`, `scripts/{deploy,iex,bun}.sh`, nginx examples.
Parameterize the tmpfs UID, fix/enforce the preflight state-shape contract, then
sweep the infra dead-config. One session — infra substrate.

**Later-sweep, non-gating:** S26 (build bloat) + all 24 LOWs not carried as
rides-along are informational; batch into a single "infra + hygiene sweep" when
convenient. Rides-along LOWs (S27–S44 where noted) should be fixed inside their
bucket's session rather than deferred.

---

## Trajectory (brief)

**Recent work (post-cp79 → 2026-07-08):** #121 rfc1459 nick-fold, then a dense
run of cic UX correctness — scroll authority (#168), unread/paging (#159/#161/
#163), away-mentions panel (#187/#188), stacked error banners (#119/#120), push
subscription survival (#181), server-side push-suppression + focus-fold (#182/
#192), long-press window-close (#172/#79). Theme is coherent: hardening the
web/PWA surface toward PUBLIC-OPEN, not scatter.

**Serves the mission?** Yes — the bouncer core is stable; the churn is on the cic
client and the anon-visitor path, which is exactly the auth-triangle/PUBLIC-OPEN
arc (epic #108).

**Risk check surfaced by this review:** the recurring structural risk is the
server↔cic wire seam (S3/S13–S17/S41–S43) — a codegen gate exists but only
covers ~10% of the wire, so the "cic mirrors the server" invariant is enforced
by convention, not by CI, on most types. That is the single highest-leverage
fix (Bucket 4). Security mediums (Bucket 1) cluster around mid-flight auth
enforcement — deleting/demoting a user or rotating a password does not evict live
sockets/sessions; this is a known #126-H2 gap left open on the admin path.

**Direction:** land Buckets 1–4 before the next PUBLIC-OPEN feature — the wire
gate (Bucket 4) prevents a whole class of future silent-drop regressions, and
the auth-enforcement gaps (Bucket 1) are exactly the surface a public
deployment exposes. Buckets 5–7 are hygiene and can trail.
