# 2026-05-12 Codebase Review

**Trigger:** Post-CP23 cluster close (code-reload LANDED 2026-05-12).
Sessions since last review (2026-05-08): ~17 across CP19+20+21+22+23.
Mega-cluster authorized 2026-05-12 — fix all CRIT + HIGH + cherry-pick MEDs.

**Scope (vjt-blessed expanded):** grappa Elixir server + cicchetto TS/SolidJS PWA + SQLite + Docker substrate + cross-surface lens. Per `.claude/skills/review/SKILL.md` (8-agent fan-out — see `1cff5e3`).

**Per-agent drafts:** `docs/reviews/codebase/drafts-2026-05-12/agent-{irc,persistence,lifecycle,web,cicchetto,cross-module,docker,cross-surface}.md`.

This document is the **triage artifact** — drafts are the audit trail.

---

## Severity counts

| Agent | CRIT | HIGH | MED | LOW |
|-------|------|------|-----|-----|
| irc | 1 | 5 | 9 | 10 |
| persistence (incl. SQLite) | 1 | 7 | 10 | 9 |
| lifecycle | 0 | 5 | 10 | 8 |
| web | 1 | 7 | 10 | 7 |
| cicchetto | 0 | 4 | 10 | 9 |
| cross-module | 0 | 2 | 6 | 2 |
| docker | 0 | 1 | 9 | 10 |
| cross-surface | 0 | 5 | 8 | 8 |
| **TOTAL** | **3** | **36** | **72** | **63** |

(Docker H1 → MED on closer inspection: file is gitignored + not tracked, public-leak framing was wrong.)

Plus: 12 simplification opportunities (docker), 5 unification opportunities (cross-surface).

---

## Triage outcome

Per vjt direction (severity gates from skill update `1cff5e3`):

- **All CRITICAL → mega-cluster bucket A** (must-fix before next feature work).
- **All HIGH → mega-cluster buckets B-F** (must-fix or formal defer with rationale).
- **MEDIUMs cherry-picked** when architecture smell / maintainability / evolution risk; cosmetic MEDIUMs noted not gated.
- **LOWs informational** — sweep at cluster close, not blocking.

Cluster shape proposed at end of this doc.

---

## CRITICAL findings (3)

### C1. SASL credential leak in pre-handshake phases (irc/S1)

`lib/grappa/irc/auth_fsm.ex:232-234`. The `step/2` clause for `AUTHENTICATE +` is matched UNCONDITIONALLY for any `phase` other than `:registered`. A hostile or buggy upstream (or, under Phase-1 `verify: :verify_none`, a network-position MitM) can send `:any AUTHENTICATE +` while the FSM is in `:pre_register` / `:awaiting_cap_ls` / `:awaiting_cap_ack` and the FSM will reply `AUTHENTICATE <base64(\0sasl_user\0sasl_user\0password)>` with the operator's credentials — BEFORE SASL has been negotiated.

The CP S1-S4 review comment at lines 209-227 explicitly enumerated this exact threat but the fix only covered the post-`:registered` arm.

**Fix:** Guard the AUTHENTICATE clause on `phase: :sasl_pending` (the only legitimate phase per IRCv3 SASL spec). Add regression tests covering each non-`:sasl_pending` phase against a stray `AUTHENTICATE +`.

### C2. SQLite `PRAGMA foreign_keys` never enabled in dev/prod (persistence/S1) — ❌ FALSE FINDING (corrected 2026-05-12 bucket A)

**Original claim (preserved verbatim below for audit):** `config/runtime.exs:22-27` ; `config/dev.exs:3-6` ; `config/config.exs:71-73`. SQLite ships with `PRAGMA foreign_keys = OFF` by default. Nowhere in the codebase do we set it for dev or prod. Test runs only enable it implicitly via Sandbox defaults — which is precisely why every `assoc_constraint` works in tests but the comments throughout the codebase describe FK errors as un-pattern-matchable in prod.

**Reality (probed on live container 2026-05-12 bucket A pre-fix):**
- `Grappa.Repo.query!("PRAGMA foreign_keys").rows == [[1]]` — **FK enforcement is ON.**
- Probe insert with orphan `user_id` raises `Exqlite.Error "FOREIGN KEY constraint failed"` — confirmed propagation.
- `deps/exqlite/lib/exqlite/pragma.ex:52` defaults `:foreign_keys` to `:on`. `deps/ecto_sqlite3/lib/ecto/adapters/sqlite3.ex:85` documents: *"`:foreign_keys` — we set it to `:on`, for better relational guarantees. This is also the default of the underlying `Exqlite` driver."* The reviewer (and the persistence draft) read "SQLite ships with PRAGMA foreign_keys = OFF" as the runtime default and missed that ecto_sqlite3 / exqlite override it on every connection-init.

**Downstream consequences:**
- All migrations' `references(..., on_delete: :delete_all|:restrict|:cascade)` ARE enforced at runtime.
- CASCADE on user/visitor delete (Reaper, `purge_if_anon`, `accounts.user.delete_all`) DOES cascade.
- The `:restrict` guard on `messages.network_id → networks.id` DOES block the network drop. The `Scrollback.has_messages_for_network?/1` cascade gate is a CONVENIENCE that produces a clean `{:error, :scrollback_present}` return instead of a raised `Ecto.ConstraintError`.
- The `validate_subject_exists/1` pre-flight checks in `Accounts.create_session/4`, `QueryWindows.open/4`, `UserSettings.get_or_init/1` exist for a SEPARATE, REAL ecto_sqlite3 limitation: the engine returns the FK constraint NAME as `nil`, so `Ecto.Changeset.assoc_constraint/3` cannot pattern-match the raised exception to produce a clean changeset error. The pre-flight `Repo.exists?` converts the miss to a clean changeset error BEFORE the insert; the FK constraint is the backstop on TOCTOU. The existing source comments at `lib/grappa/accounts.ex:179-189`, `lib/grappa/query_windows.ex:228-239`, `lib/grappa/user_settings.ex:76-81` already describe this correctly — they are NOT "load-bearing for FK enforcement" (original review claim) but "load-bearing for changeset-error UX." No source edits required.

**Trajectory section impact:** the "Risk check" item 2 ("C2 (FK pragma OFF) — every CASCADE/RESTRICT/CHECK in 23 migrations is decorative in prod") is FALSE. The migrations are enforced. The trajectory section's "data-integrity invariants we thought were enforced are not" framing reverses to "data-integrity invariants we thought were not enforced are." The CRITICAL severity tally is now **2 (C1+C3), not 3.** Persistence/S7 ("validate_subject_exists TOCTOU loses its backstop without C2 fix") was wrong about the backstop disappearance — re-evaluate at bucket B before promoting to a HIGH if the changeset-error UX itself is at risk.

**Bucket A action:** Document-only correction. No source-tree changes for C2. C1 (SASL phase guard) and C3 (visitor WHOIS) remain CRITICAL and were fixed in bucket A as planned.

### C2 (HISTORICAL — invalidated text retained for audit)

`config/runtime.exs:22-27` ; `config/dev.exs:3-6` ; `config/config.exs:71-73`. SQLite ships with `PRAGMA foreign_keys = OFF` by default. Nowhere in the codebase do we set it for dev or prod. Test runs only enable it implicitly via Sandbox defaults — which is precisely why every `assoc_constraint` works in tests but the comments throughout the codebase describe FK errors as un-pattern-matchable in prod.

**Downstream consequences:**
- Every `references(..., on_delete: :delete_all|:restrict|:cascade)` in 23 migrations is **dead code at runtime**.
- CASCADE on user/visitor delete (Reaper, `purge_if_anon`, `accounts.user.delete_all`) does NOT cascade to messages / sessions / visitor_channels / query_windows / user_settings.
- The `:restrict` guard on `messages.network_id → networks.id` does NOT block the network drop — the elaborate `Scrollback.has_messages_for_network?/1` cascade gate is the ONLY real guard.
- The `defer_foreign_keys=ON` lesson from CP19 in migration `20260504020002` proves someone investigated FK enforcement in detail — and missed the connection-level toggle.

**Fix:** Add `foreign_keys: true` to every `Grappa.Repo` config block (`runtime.exs`, `dev.exs`, `config/config.exs`). Verify via `scripts/db.sh` `PRAGMA foreign_keys;` (expect `1`). Add a runtime smoke test asserting an FK violation propagates as `Ecto.ConstraintError`. Then revisit the "ecto_sqlite3 returns FK constraint name as nil — pre-flight check is required" workarounds across `Accounts.create_session/4`, `QueryWindows.open/4`, `UserSettings.get_or_init/1` — those workarounds may still be needed for clean changeset errors, but the reasoning recorded is half-true.

### C3. Visitor WHOIS broken — dispatched through `dispatch_ops_verb/2` despite explicit moduledoc carve-out (web/S1)

`lib/grappa_web/channels/grappa_channel.ex:445-454`. The "whois" `handle_in/3` clause comment explicitly says: *"visitors not rejected here (WHOIS is a read-only query and the visitor session is allowed to issue it… `dispatch_ops_verb` IS used to short-circuit the visitor path — but that's wrong for WHOIS; use the user-only form-and-call helper instead."*

The author flagged the bug in the comment but then implemented exactly the rejected path (`dispatch_ops_verb(socket, fn user -> Session.send_whois(...))`). Visitor sockets calling `/whois <nick>` get rebuffed with `{:error, %{reason: "visitor_not_allowed"}}` despite documented intent.

**Fix:** Replace `dispatch_ops_verb(...)` with a visitor-aware helper (factor `dispatch_subject_verb/2` accepting both subject kinds, rejecting only on `:no_session`). The existing `dispatch_ops_verb` is the wrong primitive — the verb is read-only.

---

## HIGH findings (36)

Grouped by theme, not by agent.

### Theme 1 — IRC outbound trust + validation asymmetry (irc/S2-S5)

- **irc/S2** `client.ex:179-191` — `send_join` / `send_part` skip `Identifier.valid_channel?` (every other channel-targeted helper enforces it). Pending-window state machine creates `:pending` entries for malformed channel names that never resolve.
- **irc/S3** `client.ex:168-175` — `send_privmsg` accepts arbitrary `target` strings including empty ones; emits malformed `PRIVMSG  :body\r\n`.
- **irc/S4** `auth_fsm.ex:435-437` — SASL PLAIN payload may contain NUL bytes from password without precondition guard. RFC 4616 forbids; AuthFSM advertised as Phase-6-reusable.
- **irc/S5** `auth_fsm.ex:166-198, 416-419` — AuthFSM trusts un-validated `nick` / `realname` / `password` for line construction. Today saved by `Networks.Credential` validator on the write path; Phase-6 caller bypassing schema can inject CRLF.
- **irc/S6** `client.ex:473` — `Logger.metadata(opts.logger_metadata)` accepts arbitrary keys without allowlist enforcement; non-allowlisted keys silently dropped at format time.

### Theme 2 — SQLite contention + index gaps (persistence/S2-S8)

- **persistence/S2** `runtime.exs:22-27, dev.exs:3-6` — no `busy_timeout` in prod/dev. Default ~2s vs WAL+single-writer reality. Direct cause of the CP23 S4 e2e flake (`cp15-b6-kicked` + `m9-cicchetto-part-x-click` `database is locked` retries).
- **persistence/S3** `runtime.exs:24` — `pool_size: 10` for SQLite is misleading. Single writer + no busy_timeout + 10 concurrent transactions = structural cascading-busy.
- **persistence/S4** `networks/credentials.ex:202-228` + `networks.ex:475-477` — PubSub broadcast inside / adjacent to `Repo.transaction`. `Networks.disconnect/2` does upstream QUIT + `stop_session` BEFORE the DB write — if `Repo.update!` raises, get "ghost connected row, dead session" surviving reboot.
- **persistence/S5** `networks/credentials.ex:282-292` — missing partial index on `network_credentials.connection_state` for the Bootstrap hot path. Mirrors `session_client_id_partial_index` shape.
- **persistence/S7** `accounts.ex:190-211` + `query_windows.ex:240-262` + `user_settings.ex:184-198` — `validate_subject_exists` TOCTOU patterns lose their backstop without C2 fix. After C2, keep pre-flight checks for clean changeset errors but rewrite "load-bearing" comments to "convenience."
- **persistence/S8** `networks/credential.ex:134-145` + `credentials.ex:111-139` — `last_joined_channels` JSON write unbounded. Every self-JOIN/PART/KICK rewrites the entire array AND bumps `updated_at`.

### Theme 3 — Wire-shape boundary discipline leaks (web/S2-S4, lifecycle/S10, cross-module/S4)

- **web/S2** `archive_json.ex:16-33` — handcrafts wire shape with **string keys** instead of delegating to `Grappa.Scrollback.Wire`. CLAUDE.md "Wire conversion is per-context responsibility" explicitly broken. Other JSON views (Messages/Networks/Channels/Me/Auth) delegate correctly. Drift class.
- **web/S3** `members_json.ex:18` — returns context-shape `Session.member()` directly, no `Wire` module. Works because the type is plain map today; future struct-wrapping silently leaks Elixir-internal fields onto wire AND crashes channel `members_seeded` broadcast.
- **web/S4** REST `MembersJSON` `%{members: [...]}` envelope vs Channel `members_seeded` `%{kind, network, channel, members}` envelope — drift hazard with no shared per-member shape source.
- **lifecycle/S10** `cic/bundle.ex:23` — `Grappa.Cic.Bundle` boundary is `exports: []` but moduledoc says `current_hash/0` is callable from web. `Boundary.find_violations` should flag.
- **cross-module/S4** `admin_controller.ex:67` — `cic_bundle_changed` payload built inline (`%{kind: "bundle_hash", hash: hash}`); no `Grappa.Cic.Wire` module. Every other context has one.

### Theme 4 — Channel inbound validation weaker than REST (web/S6, S7)

- **web/S6** `grappa_channel.ex:528-544` — `topic_set` `with`/`else` matches by raw `true`/`false` value not by source. Brittle — any new boolean check above either site silently flips error message.
- **web/S7** Most `handle_in/3` clauses (`open_query_window`, `op`/`deop`/`voice`/`devoice`, `kick`, `ban`/`unban`, `invite`, `whois`) accept arbitrary `target_nick`/`mask`/`channel` strings without IRC-shape validation. REST surface gates rigorously via `GrappaWeb.Validation.validate_*`; Channel does not. Defense in depth missing at outer untrusted boundary.

### Theme 5 — Visitor coverage gaps (web/S5, web/S8, lifecycle/S1)

- **web/S5** `admin_controller.ex:69` + `user_socket.ex:62-68` — `cic_bundle_changed` broadcast iterates `WSPresence.list_user_names()` which excludes visitors at register-time. Visitors with long-lived tabs never see live bundle-hash refresh banner trigger.
- **web/S8** `Session.list_members/3` returns `{:ok, []}` ambiguously for "no NAMES burst yet" vs "channel has 0 members." Closes the open `project_names_ux_silent_bugs` memo.
- **lifecycle/S1** `session/server.ex:1440-1448` — visitor sessions have no `credential_failer` callback. K-line / permanent-SASL on visitor exits silent → Bootstrap re-spawns forever. No operator signal for permanently-rejected visitors.

### Theme 6 — Lifecycle classification + boot perf (lifecycle/S2-S5)

- **lifecycle/S2** `bootstrap.ex:235-257` vs `:335-378` — divergent user-flow paths: `validate_credential_servers!` iterates servers per credential; SessionPlan.resolve re-fetches the same list per row. Two passes for one verb.
- **lifecycle/S3** `session/server.ex:1095-1098` — clean Client EXIT clause wraps `:normal/:shutdown` into `{:client_exit, :normal}` (a tuple), which the `:transient` supervisor classifies as **abnormal** despite the comment claiming the opposite. Comment + behavior contradict; code OR comment must change.
- **lifecycle/S4** `session/server.ex:1486-1488` — `service_target?/1` `String.ends_with?(target, "serv")` misclassifies channels like `#hubservers` and nicks like `Conserv` / `Dataserv` as service targets → silently drops from scrollback. Replace with closed allowlist (`["nickserv", "chanserv", "memoserv", "operserv", "botserv", "hostserv", "helpserv"]`); channel-prefixed targets bypass entirely.
- **lifecycle/S5** `bootstrap.ex:222-233` — `spawn_all/1` is sequential `Enum.reduce`. Each `SpawnOrchestrator.spawn/4` does ≥3 admission DB queries serially; ~50 credentials = O(seconds) boot latency before first session.

### Theme 7 — Cross-surface drift (cross-surface/H1-H5)

- **cross-surface/H1** `Login.tsx:104-108` — dead `captcha_provider_unavailable` arm; server emits `service_degraded`. Silent UX degradation on captcha provider outage.
- **cross-surface/H2** Validation errors collapse to HTTP statusText on cic. `format_changeset_errors` returns `%{field => [msg]}` but `api.ts:373-376` reads `errors.detail` → every 422 loses field-level info.
- **cross-surface/H3** `WireEvent` channel-event union duplicated between `api.ts:210-213` (narrow: `message` only) and `subscribe.ts:96-124` (full: 6 kinds). Future consumer importing from `api.ts` is type-blind to 5/6 kinds.
- **cross-surface/H4** Per-channel WS events not runtime-narrowed. `userTopic.ts:62-169` has `narrowUserEvent`; `subscribe.ts:269,370` cast directly. Same gap that motivated the cic M1 user-topic fix.
- **cross-surface/H5** `connection_state` enum split awkwardly across two TS types (intentional but brittle). Demote to MED per cross-surface agent's own note.

### Theme 8 — Cicchetto own-nick + nick-comparison correctness (cicchetto/H1-H4)

- **cicchetto/H1** `Shell.tsx:55` + `MembersPane.tsx:73` re-introduce the `displayNick(me)` foot-gun the team JUST closed in cic H3 on 2026-05-08. Affects mention highlighting + ops-menu enable/disable on networks where account name ≠ IRC nick.
- **cicchetto/H2** CSP allowlist (`infra/snippets/security-headers.conf:48`) covers Turnstile only; cic + server config support hcaptcha. Selecting hcaptcha in prod silently fails with misleading "ad-blocker" message.
- **cicchetto/H3** `members.ts:57,62,69,76` + `ScrollbackPane.tsx:461-462,562` — case-sensitive nick comparisons (`===`). RFC 2812 nicks are case-insensitive. Phantom members on JOIN→QUIT casing mismatches; missed self-JOIN banner triggers; ownModes lookup miss. `subscribe.ts:183,319,328,556` correctly uses `.toLowerCase()` — drift between stores.
- **cicchetto/H4** `Network.connection_state` typed optional in cic; server contract makes it required for user subjects. Defensive checks scattered. Split type into `UserNetwork` | `VisitorNetwork`; discriminate at `me().kind`.

### Theme 9 — Cross-module + Docker substrate (cross-module/S1-S2, docker/H2)

- **cross-module/S1** `deploy.sh` preflight regex enumerates `Session.Server` + `WSPresence` for `defstruct` checks — but BOTH carry state as bare maps (no `defstruct`). Preflight is structurally blind to the very modules it lists. Add `defstruct` (also helps Dialyzer typecheck) OR extend preflight to grep `init/1` map literals.
- **cross-module/S2** `auth_controller.ex:204` — sole inline-Logger violation in entire codebase. `socket_id` interpolated into message string; not in `config/config.exs:110-160` allowlist.
- **docker/H2** `scripts/deploy.sh:110` long-lived-GenServer regex misses `lib/grappa/visitors/reaper.ex` (60s sweeper, supervised under Application). CLAUDE.md "Hot vs cold deploy" enumeration also omits it. Pick one source-of-truth and reflect both.

---

## Cherry-picked MEDIUMs (gating)

These MEDs are gated into the cluster because they are architecture-smell / maintainability hazards. Cosmetic MEDs noted in drafts but NOT gated.

### Wire-shape + type leverage

- **persistence/S13** `messages.kind` CHECK constraint frozen-snapshot drift class. New kind atom passes `Ecto.Enum` but DB CHECK rejects → silent drift. Same for `auth_method`. Add migration test: `Message.kinds() == ` literal CHECK list.
- **persistence/S15** `EncryptedBinary` `password_encrypted` field name lies (it's plaintext post-load). Three layers of doc warnings guard one naming bug. Rename to `password_at_rest` or split into `_ciphertext` (raw col) + virtual `password` field (`redact: true`). High discipline cost; removes cross-module consistency requirement.
- **persistence/S17** `query_windows.opened_at` is `:utc_datetime` (second precision); `messages`/`accounts`/`session.last_seen_at` are `:utc_datetime_usec`. Mixed precision creates "two clocks" at JSON wire emission. Standardize on `:utc_datetime_usec`.
- **persistence/S18** `User.password_hash` not `redact: true`. `inspect(%User{})` prints full Argon2 hash (algo+salt+cost). Compare to `Visitors.Visitor.password_encrypted` and `Credential.password_encrypted` which both redact.

### Defensive code hides bugs

- **lifecycle/S8** `apply_effects/2` — `:join_failed` arm partial-effect leakage. If `Scrollback.persist_event/1` fails, broadcast + state mutation STILL run. cic renders failure banner; reconnect → empty scrollback, no failure indication. Gate broadcast on persist success OR add WindowState mutation to failure path.
- **lifecycle/S11** `session/server.ex:564-578` — `terminate/2` `try/catch :exit` with bare `:exit, _` swallows EVERY exit reason including future `Client.send_quit/2` bug (arity change, undefined). Tighten to specific shapes.
- **lifecycle/S13** `WSPresence` uses `Phoenix.PubSub.broadcast/3` for purely-local fan-out. PubSub crash → WSPresence crashes (`:permanent`) → restarts with empty state → every session sees `:ws_all_disconnected` after 30s debounce. Replace with `Registry.dispatch(Grappa.SessionRegistry, ...)`.
- **web/S10** `auth_controller.ex:192` — `maybe_disconnect_socket(_)` catchall after user/visitor branches. CLAUDE.md "Defensive programming hides bugs" — drop the fallthrough; let `FunctionClauseError` scream when a third subject kind appears.
- **web/S11** `me_controller.ex:34` — `_ -> {:error, :unauthorized}` defensive fallthrough. Drop; let crash if pipeline misconfigured.
- **web/S16** `networks_controller.ex:196-214` — `spawn_session_after_connect/3` swallows admission errors. Client gets 200 but session not spawned. Per `feedback_silent_retry_anti_pattern` — surface via response body (`spawn_error: "network_busy"`) or PubSub event.

### Cross-module + Docker

- **cross-module/S5** `auth_controller.ex:58` + `visitors/login.ex:69` — `compile_env` (no bang) on required `:visitor_network`. Missing config → silent visitor-login failure. Use `compile_env!`.
- **cross-module/S6** CLAUDE.md PubSub topic shape stale. Says `grappa:network:{net}` but `Grappa.PubSub.Topic` is `grappa:user:{u}/network:{n}/...`. Update CLAUDE.md.
- **cross-module/S7** Dead `:toml` dep in `mix.exs:86`. Phase 2 sub-task 2j replaced TOML loader; zero references.
- **docker/M1** `compose.prod.override.yaml` (gitignored, NOT tracked, vjt-local only) — confirmed not a public-leak issue. Cosmetic local cleanup if vjt wants; flag only.
- **docker/M2** `Dockerfile:60` `LABEL grappa.hot_deployable=true` is dead code: `scripts/hot-deploy.sh` doesn't exist (CP23 collapsed); `deploy.sh` doesn't read it; CI doesn't compute it. Delete.
- **docker/M5** `runtime/cicchetto-dist/.gitkeep` + `runtime/bun-cache/.gitkeep` — fresh-clone `compose --profile prod up cicchetto-build` bombs without these (bind-mount of nonexistent host path → root-owned).

### Cross-surface

- **cross-surface/M1+M2** `Accounts.Wire` + `Visitors.Wire` + `Session.Wire.topic_changed` return raw `%DateTime{}`. Jason coerces to ISO-8601 so wire bytes match cic — but typespec disagrees with wire. Apply `iso8601_or_nil/1` (extract `Grappa.Wire.Time` shared helper per U1).
- **cross-surface/M3** `meta` field on scrollback messages opaque on cic side (`Record<string, unknown>`); server has documented per-kind shape table. Mirror as discriminated union per kind.
- **cross-surface/M5** `auth.ts.logout()` swallows ALL errors (5xx, network, etc.) with bare `try{}catch{}`. Add `console.warn` before swallow.

### Cic

- **cicchetto/M2** `ScrollbackPane.tsx:572-585` — banner effect calls `setSelectedChannel` on ANY self-JOIN, including server-initiated re-joins (NickServ ghost recovery, autojoin replay, SAJOIN). Violates `feedback_target_window_ux_rule` "focus only on user action". Drop the focus shift; rely on `compose.ts:223` for user-issued joins.
- **cicchetto/M5** `userTopic.ts:75-91, 146-148` — `mentions_bundle.messages` and `whois_bundle.channels` array-narrowed but elements not type-checked. Server bug (or malformed broadcast) sending `messages: [null, null]` crashes cic renderer.
- **cicchetto/M8** `__cic_socketHealth` / `__cic_bundleHash` window globals exposed in production builds. Wrap in `import.meta.env.MODE !== "production"`.

---

## LOW findings (63)

Catalog kept in per-agent drafts. Not gated; sweep at cluster close.

---

## Unification opportunities (5, from cross-surface)

- **U1** Shared `Grappa.Wire.Time.iso8601_or_nil/1` helper — every Wire produces ISO-8601 strings consistently. ~10 min, removes M1+M2 inconsistency.
- **U2** Codegen TS unions from server-side closed sets (`Message.kinds`, `Wire.wire_event_kind`, `Meta` per-kind shapes, `Credential.connection_states`, `ChannelEntry.source`). Highest-leverage drift-killer for the next year. ~1 day. **Recommend AFTER channel-client-polish + image-upload land** — codebase is moving fast right now and a generator would be churned by every other commit.
- **U3** Single `wireNarrow.ts` module with `narrowChannelEvent` mirroring `narrowUserEvent`. Half-day. Pair with U2.
- **U4** Single `{error: "<token>", info: %{...}}` envelope server-side. Kills H2 (validation errors) and tightens H1. 2-3 hours.
- **U5** `Topic.parse/1` builders only on server side; cic builds topic strings by hand. Pin via comment + test now; real unification arrives with U2.

## Simplification opportunities (12, from docker)

Top 3 picked into mega-cluster:
- **S2** Delete `LABEL grappa.hot_deployable=true` + dead-code comment in Dockerfile (gates with docker/M2).
- **S6** Delete `.dockerignore` `dist/` entry (post-CP23 path moved).
- **S7** Bake `runtime/cicchetto-dist/.gitkeep` + `runtime/bun-cache/.gitkeep` (gates with docker/M5).

Rest catalogued in `agent-docker.md` for later sweep.

---

## Trajectory

### What did we build in the last ~17 sessions?

- **CP19 (2026-05-08 → 05-10)** — channel-client-polish theme stayed open; defer_foreign_keys lesson; B-restart cluster (last_joined_channels persistence); CP15 EDW B1-B7 LANDED; cic H3 own-nick foot-gun fix.
- **CP20-CP21 (2026-05-10)** — channel-client-polish bucket grind: query windows, DM filter narrowing, target-window UX rule, slash command consolidation.
- **CP22 (2026-05-10 → 05-11)** — EXTRA_CHECK_ORIGINS + clean QUIT + user-topic dedup; socket-health banner LANDED.
- **CP23 (2026-05-11 → 05-12)** — `code-reload` cluster: single-stage Dockerfile + unified compose + hot-deploy preflight + cic bundle-refresh banner + unified `deploy.sh` + `deploy-cic.sh`. Productization complete; version 0.2.0.

**Theme:** product-surface infrastructure (deploy hot-vs-cold, bundle-refresh, scripts unification) interleaved with channel-client-polish UX iteration. Two distinct trajectories running concurrently.

### Does recent work serve the core mission?

(Always-on IRC bouncer + REST/WS API + browser PWA + downstream IRCv3 listener facade.)

- **Yes** — channel-client-polish is irssi-shape UX that an "IRC client worth its name" needs (vjt's framing 2026-05-04).
- **Yes** — code-reload is dev-loop infrastructure that lets the IRC work move faster without losing sessions.
- **Phase 5 hardening unmoved** — TLS verify_none → CA chain still deferred; PromEx not landed; Sobelow gate not yet bumped to MEDIUM-fail. NOT blocking but the security debt accumulates.
- **Phase 6 listener facade** — IRC parser is ready (single source of truth, byte-clean, test-covered) but no listener work started. AuthFSM modules advertise Phase-6 reuse but rely on Networks.Credential for byte-safety (irc/S5 finding) — the modules need to be self-defending before extraction is real.

### What's stalling?

- **Phase 5 hardening** — TLS verify_none, PromEx, Sobelow strictness, NickServ-on-connect umode check, NickServ NOTICE parsing, NickServ REGISTER proxy. All in todo.md High tier. Untouched ~3 weeks.
- **Image upload cluster** — in queue (memory `project_image_upload`). Not blocking but listed before Phase 5.
- **/names UX silent bugs** — three open issues in memory `project_names_ux_silent_bugs`. Two land naturally with web/S8 fix (`{:ok, :uninitialized}` vs `{:ok, []}` differentiation).

### Observation items due

None flagged in todo.md observation tier as past-due. The codebase-review gate itself was overdue (this is the catch-up).

### Risk check

Three previously-unknown risks surfaced:
1. **C1 (SASL leak)** — security-class. Phase-1 `verify: :verify_none` made this exploitable from the network. **Highest priority fix.**
2. **C2 (FK pragma OFF)** — every CASCADE/RESTRICT/CHECK in 23 migrations is decorative in prod. Data-integrity invariants we thought were enforced are not.
3. **persistence/S2-S3 (busy_timeout + pool_size)** — the `database is locked` e2e flake we labeled "pre-existing" in CP23 S4 is structural, not bad luck.

Plus persistent risks vjt knows about:
- TLS verify_none (Phase 5 deferred — explicit).
- Hot-deploy preflight regex blind to map-state Session.Server + WSPresence (cross-module/S1, docker/H2).
- Visitor-side observability gap (lifecycle/S1, web/S5).

### Recommendation

The codebase is **unusually disciplined for its age** (cross-module: zero `\\` defaults, zero `String.to_atom`, zero `rescue _`, zero raw `Repo.insert/2`, zero runtime `Application.put_env` across 118 files; cross-surface: every Wire path goes through context-owned modules; Boundary discipline holds). The findings concentrate in **three domains**: pre-handshake credential safety, SQLite production defaults, and visitor flow asymmetry. None are "the architecture is wrong"; all are "specific gaps the original author intended to close but didn't yet."

**Direction:** Mega-cluster the CRIT+HIGH+gating-MEDs as vjt directed. Defer U2 (codegen) until after the next two product clusters land — the leverage is real but the churn risk is also real. After mega-cluster closes, Phase 5 hardening becomes the next gate (TLS, PromEx, Sobelow strictness, NickServ-on-connect) — with C1 fixed, the `verify_none → CA chain` work no longer has a credential-leak interaction.

---

## Mega-cluster shape (proposed for Phase 3)

Naming: `cluster/post-cr-review` (post-code-reload review fixes). New checkpoint CP24.

**N sessions, flush+clear between buckets (vjt direction).** Per-bucket: deploy + healthcheck + browser smoke (memory `feedback_per_bucket_deploy`). Per `feedback_landed_claim_evidence` — every bucket close requires literal `scripts/check.sh` exit-0 tail.

| Bucket | Theme | Findings | Effort |
|--------|-------|----------|--------|
| **A** | CRITICAL trifecta | C1 SASL phase guard + tests, C2 FK pragma + smoke + revisit pre-flight comments, C3 visitor WHOIS | 1 session |
| **B** | SQLite production defaults + hot-path index | persistence/S2 busy_timeout, S3 pool_size + doc, S5 connection_state partial index, S8 last_joined_channels cap | 1 session |
| **C** | IRC outbound + AuthFSM hardening | irc/S2-S6 (validation + NUL guard + self-defense + Logger metadata) | 1 session |
| **D** | Wire-shape boundary discipline | web/S2 ArchiveJSON, S3+S4 MembersJSON+broadcast unification, lifecycle/S10 Cic.Bundle exports, cross-module/S4 Cic.Wire + cherry-pick S6 (CLAUDE.md topic doc) | 1 session |
| **E** | Channel inbound validation + visitor coverage | web/S5 visitor bundle-broadcast, S6 topic_set tagged-tuple, S7 channel boundary validation, S8 list_members `:uninitialized`, lifecycle/S1 visitor_failer | 1 session |
| **F** | Cic correctness | cicchetto/H1 own-nick (Shell+MembersPane), H2 CSP hcaptcha, H3 nick-comparison helper + storage normalization, H4 Network type split | 1 session |
| **G** | Cross-surface drift + envelope unification | cross-surface H1 Login dead arm, H2+U4 unified `{error,info}` envelope, H3 `WireEvent` consolidation, H4+U3 `narrowChannelEvent`, U1 `Grappa.Wire.Time` | 1 session |
| **H** | Lifecycle correctness + boot perf | lifecycle/S2 spawn_one verb-reuse, S3 client-exit classification fix, S4 service_target allowlist, S5 parallel admission check, plus MEDs S8+S11+S13 (defensive code class) | 1-2 sessions |
| **I** | Cross-module + Docker debt | cross-module/S1 preflight + Session.Server defstruct, S2 socket_id allowlist, docker/H2 reaper preflight, docker/M2 LABEL deletion, M5 .gitkeep, S5 compile_env!, S7 toml dep removal, plus docs sweep | 1 session |
| **Z** | Sweep + close | LOWs cherry-picked + check.sh + browser smoke + checkpoint close + memory updates | 1 session |

**Total estimate: 10-11 sessions.** Real shape decided per-bucket as we work.

---

## Next session

Phase 3: open `cluster/post-cr-review` worktree, rotate CP24, start bucket A (CRITICAL trifecta). Deploy after each bucket close per `feedback_per_bucket_deploy`.
