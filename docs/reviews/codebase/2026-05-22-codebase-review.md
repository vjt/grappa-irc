# 2026-05-22 — Codebase Review

**Cadence:** 8 days since the last codebase review (2026-05-14).
Triggered NOT by the time/session-count gate, but by the explicit
post-T+M+U+iOS plan (vjt 2026-05-16): orchestrate parallel-review
cycle → fix ALL CRIT/HIGH + most-important MED, per-bucket fix-up
+ reviewer-loop'd close. All UX-5/6/7 clusters CLOSED. iOS-dogfood
wave done. Gate cleared, wave kicked.

**Method:** 8 parallel review agents (one per scope), each reading
its full file set + CLAUDE.md + active checkpoint + DESIGN_NOTES,
reporting findings against the per-scope rubric in
`docs/reviewing.md` + project memories. Drafts preserved in
`docs/reviews/codebase/drafts-2026-05-22/agent-*.md`.

**Headline:** **113 total findings — 4 CRITICAL, 29 HIGH (after
dedup), 50 MEDIUM, 30 LOW.** No data-corruption critsts; no
runtime XSS/token-leak; no security auth-bypass. The CRITs cluster
on **wire-shape drift between server and cic** (2) and **substrate
fragility** (2). The HIGHs cluster on **closed-set drift across
boundaries** (10), **silent-swallow patterns** (5), **`:ok =
match` regressions** (1), **infra preflight gaps** (3), **PWA
shell coverage gap** (1), and the rest individual hazards.

---

## Severity totals by scope (after cross-agent dedup)

| Scope | CRIT | HIGH | MED | LOW | Total | Notes |
|-------|------|------|-----|-----|-------|-------|
| irc/  | 0 | 1 | 6 | 4 | 11 | Prior IRC reviews (2026-05-08 + 2026-05-12) closed all hot-path bugs; remaining gaps = exhaustiveness/leniency, not safety |
| persistence/ | 1 | 6 | 7 | 3 | 17 | CRIT = unpinned SQLite `synchronous` + `foreign_keys` PRAGMAs (right by accident) |
| lifecycle/ | 0 | 4 | 6 | 3 | 13 | HIGH cluster: backoff bookkeeping gap + bare `:ok = Client.send_*` regressions + Bootstrap closed-set gap |
| web/ | 0 | 1 | 5 | 4 | 10 | Clean overall — topic shapes uniform, FallbackController wired, nginx admin allowlist parity intact |
| cicchetto/ | 0 | 4 | 9 | 5 | 18 | No XSS, no token leak, no SW caching API/WS. HIGH = wire drift + SW denylist + markerRef leak |
| cross-module | 0 | 2 | 3 | 2 | 7 | 13 pattern audits CLEAN (zero `\\` defaults, zero `String.to_atom/1`, zero bare rescue, etc.) |
| docker | 1 | 7 | 8 | 3 | 19 | Primary disease: duplication (admin allowlist 3 places, worktree volumes 10 entries, nginx :80/:443 byte-copy) |
| cross-surface | 2 | 5 | 8 | 3 | 18 | CRIT = cic missing 2 server-emitted event arms (assertNever crash) + flow-union narrowed lie |
| **Total raw** | **4** | **30** | **52** | **27** | **113** | |
| **After dedup** | **4** | **29** | **50** | **27** | **110** | Dedups: cross-surface S1↔cic S1 = same (kept CRIT); cross-surface S5↔cic S17 = same (kept HIGH); cross-module S1↔web S3 = same (kept HIGH) |

---

## CRITICAL findings (all 4 — must-fix before next cluster)

### C1. cic `WireAdminEvent` is missing `upload_reaped` + `uploads_swept` arms — server emits, cic crashes via `assertNever`
**Server:** `lib/grappa/admin_events/wire.ex:113-127, 298-317`,
emitter at `lib/grappa/uploads/reaper.ex:99, 173`
**Cic:** `cicchetto/src/lib/api.ts:756`, `cicchetto/src/lib/adminEvents.ts:76`, `cicchetto/src/AdminEventsTab.tsx:38`
**Reported by:** cross-surface S1 (CRIT) + cicchetto S1 (HIGH)
Server emits both verbs on every TTL upload sweep (60s tick).
Cic's discriminated `WireAdminEvent` union has only 11 of 13
arms — these two are missing. When any operator has the admin
events tab open during a sweep, `assertNever(ev)` throws inside
the channel handler, killing the admin-events stream until full
reload. The cic-side `assertNever` enforcement is correct
discipline per `feedback_no_silent_drops_closed`; the bug is the
missed coupling. **Fix:** Add both arms to `WireAdminEvent` + `ingest()` switch + `renderEvent` in `AdminEventsTab.tsx`. Add a vitest pinning the 13-arm parity against `event_kind` (or at minimum a superset assertion).

### C2. `WireAdminEvent.capacity_reject.flow` typed `"user" | "visitor"` on cic; server emits 5-arm `Admission.flow()` atom
**Server:** `lib/grappa/admission.ex:53-58`, `lib/grappa/admin_events/wire.ex:79-87, 236-251`
**Cic:** `cicchetto/src/lib/api.ts:772-780`
**Reported by:** cross-surface S2 (CRIT)
Server's `Admission.flow()` is the closed atom union `:login_fresh | :login_existing | :bootstrap_user | :bootstrap_visitor | :patch_network_connect`. Cic types it as `flow: "user" | "visitor"` — a lie. Runtime values come from a 5-arm union the type cannot represent. `AdminEventsTab.tsx:44` renders the raw atom string correctly, but any switch on `flow` would mis-branch. The drift is opposite the typical "narrower-on-client" pattern. **Fix:** Widen cic type to the full closed union; pin shared with the cic-side renderer.

### C3. SQLite `synchronous` and `foreign_keys` PRAGMAs not pinned anywhere
**File:** `config/runtime.exs:31-55`, `config/dev.exs:3-10`, `config/test.exs:3-26`
**Reported by:** persistence S1 (CRIT)
CLAUDE.md "Explicit SQLite angle" rule. Today the `exqlite`
default of `synchronous: :normal` is the CORRECT choice for WAL,
and `foreign_keys: on` is the verified default — but **right by
accident**. A dep major version that flips defaults to win a
benchmark silently turns every prod commit into a fsync-deferred
best-effort write, with no migration, no log line, no diff. Same
class for `foreign_keys` (the entire CASCADE chain depends on it
— visitor reap CASCADES through 8 tables). **Fix:** Pin both
PRAGMAs explicitly in `config/{runtime,dev,test}.exs` Repo
config. No runtime behavior change; insurance against dep upgrades.

### C4. `deploy.sh` preflight regex is decoupled from authoritative module list — primed to mask the next CP28
**File:** `scripts/deploy.sh:128`, `lib/grappa/hot_reload/long_lived_modules.ex:112-130`
**Reported by:** docker S1 (CRIT)
Preflight parses the SoT module list with `grep -E
'^\s+Grappa\.[A-Za-z_.0-9]+,?$'` — matches ANY indented line that
looks like a Grappa module reference. Currently picks up 14
lines: 12 real `@modules`/`@state_helpers` entries + 2 typespec
lines (the `@type long_lived` union heads). Today the typespec
lines duplicate real entries so the bug is benign. But:
the regex has **zero structural coupling** to the attribute names.
Adding a module to the typespec union but forgetting `@modules`
silently passes preflight → next hot-deploy crash-loops the BEAM
on shape mismatch (the literal CP28 incident). **Fix:** Replace
regex with `mix run -e 'Grappa.HotReload.LongLivedModules.all()
|> Enum.each(&IO.puts/1)'` — the SoT is the only definition. Kills the awk helper too (`scripts/_extract_state_block.awk`). Massive simplification surface.

---

## HIGH findings (29 after dedup — must-fix or formal defer)

Grouped by theme.

### Theme A — Closed-set drift across boundaries (10 findings)

The single biggest cluster. The codebase has the rule
("**Atoms or `@type t :: literal | literal` — never untyped
strings**") well-internalized at most boundaries, but enough
sites slipped that incremental enum additions silently propagate
or trigger crash-loops. Most of these compile cleanly but lie
to Dialyzer / TypeScript.

- **H1 (cross-surface S5 / cic S17):** `joined`/`join_failed`/`kicked` narrowers duplicated in `wireNarrow.ts:185-222` (per-channel) AND `userTopic.ts:376-419` (user-topic). F1 dual-broadcast left both narrowers needing the same shape; no compile-time enforcement they stay structural identical. **Fix:** Extract `narrowWindowStateEvent` helper called by both outer narrowers.
- **H2 (cross-surface S6):** `connection_state_changed.from`/`to` typed open `string` on cic; server emits closed `Credential.connection_state()` atom. Adding `:reconnecting` (or any 4th state) silently propagates as stringly-typed value. **Fix:** Shared `ConnectionState = "connected" | "parked" | "failed"` at api.ts top-level; narrow in `narrowUserEvent`.
- **H3 (cross-surface S4):** `away_confirmed.state` typed `String.t()` on server-side wire; manual `to_string(atom)` at call site is the only enforcement. **Fix:** `Wire.away_confirmed/2` accepts atom; converts at the wire boundary (mirroring `Atom.to_string(m.kind)` in `Scrollback.Wire`).
- **H4 (cross-surface S7):** `topic_changed.topic` and `channel_modes_changed.modes` declared untyped `map()` server-side; cic-side narrowers are the only contract. **Fix:** Promote `EventRouter`'s topic + modes cache shapes to typed `@type t :: %{required(...)}` referenced by Wire.
- **H5 (cross-surface S3):** `cap_counts_changed.network_slug` typed nullable on both sides but server guarantees non-null (early-returns before broadcast). **Fix:** Tighten typespec to `String.t()`; remove dead `networkLabel` null branch.
- **H6 (persistence S4):** `Networks.connect/1`, `disconnect/2`, `mark_failed/2` each pattern-match a subset of `Credential.connection_states/0` without explicit fallthrough. Spec lies to Dialyzer if enum extended. **Fix:** Either tighten spec to `no_return` clause OR add explicit fallthrough that raises (mirroring `Scrollback.subject_where/2`).
- **H7 (lifecycle S3):** `Bootstrap.spawn_with_admission/6` hardcodes 4 admission-error shapes without coupling to `Admission.capacity_error_atoms()`. Adding a 5th tag crash-loops the app at boot. **Fix:** Drive the case from `Admission.capacity_error_atoms()` OR add `{:error, other}` catch-all + Logger.error.
- **H8 (lifecycle S4):** `Bootstrap.log_web_only_warning` hardcodes `counts.parked + counts.failed`; lies if a 4th `Credential.connection_state` lands (origin of the rule: pre-T-4 honest-log refactor). **Fix:** `Enum.reject(fn {s, n} -> s == :connected or n == 0 end) |> map_join(...)`.
- **H9 (irc S1):** AuthFSM combined `CAP REQ :sasl labeled-response` blob has no fallback when server NAKs the combined request. A `:sasl`-required credential restart-loops permanently against a server that mis-implements `labeled-response` (Bahamut/Solanum variants). **Fix:** On NAK, retry with `CAP REQ :sasl` alone before declaring `:sasl_unavailable`.
- **H10 (web S1):** `dispatch_subject_verb/3` else-block missing `{:error, :invalid_line}` arm — sister `dispatch_ops_verb/3` already handles it (consistency drift). `WithClauseError` → channel pid crash if Session facade ever surfaces it. **Fix:** Add the arm, mirror dispatch_ops_verb.

### Theme B — `:ok = match` regressions (1 multi-site finding)

- **H11 (lifecycle S2):** Eight+ bare `:ok = Client.send_*` matches in `Session.Server` crash the session on dead socket, inverting the U-cluster `IRC.Client.send_line` fix. Sites: operator MODE (1016), chunked ops verbs (2846), apply_effects reply (2537), four AWAY paths (2906, 2912, 2921, 2941, 2947), GhostRecovery flush_lines (1949). **Fix:** Replace every `:ok = Client.send_*` with case-match mirroring `send_privmsg` at server.ex:1849-1859.

### Theme C — Silent-swallow at boundaries (5 findings)

The CLAUDE.md `feedback_no_silent_drops_closed` rule is mostly
internalized but a handful of M-9b-shape sites remain.

- **H12 (lifecycle S1):** `Backoff.record_failure` documented as "called from `Session.Server.terminate/2` on any non-`:normal` exit." Doc is wrong — call site is `handle_info({:EXIT, client_pid, _})` clause only. Any non-Client-EXIT crash bypasses backoff bookkeeping → tight crash loop possible. **Fix:** Move `record_failure` into `terminate/2` on abnormal-reason clause OR document the actual invariant.
- **H13 (persistence S5):** `Visitor.touch_changeset/2` is missing the time-monotonicity guard that `Accounts.Session.touch_changeset/2` got in B5.4 L-pers-3. Backward-clock skew silently shrinks visitor TTL. **Fix:** Port the guard from Accounts.Session.
- **H14 (persistence S6):** `Visitors.commit_password/2` does lookup-then-update without race protection. Concurrent delete → `Ecto.StaleEntryError` instead of spec'd `{:error, :not_found}`. Same class in `Visitors.update_nick/2`. **Fix:** Catch `Ecto.StaleEntryError` → map to typed error.
- **H15 (persistence S7):** `last_joined_channels` cap (200) enforced in context helper only; schema-level changeset has no length validation. Any bypassing writer can grow unbounded. **Fix:** Add `validate_length(:last_joined_channels, max: 200)` at the changeset.
- **H16 (cross-module S1 / web S3):** `PushVapidController.show/2` does runtime `Application.fetch_env!/2` per request — violates CLAUDE.md "boot-time only, runtime banned." The lone runtime offender in the codebase. **Fix:** Add `Grappa.Push.vapid_public_key/0` reading from `:persistent_term` written by a new `Grappa.Push.boot/0` (mirroring `Grappa.Uploads.boot/1`).

### Theme D — Persistence-side correctness (2 findings)

- **H17 (persistence S2):** `Scrollback.delete_for_channel/3` uses raw `String.downcase/1` while the write side goes through `Identifier.canonical_channel/1`. Bug latent today (ASCII channels agree); ticking on any future canonicalize extension (Unicode, leading-`!` strip, etc.). Same shape in `delete_for_dm/3` and the dispatcher in `ArchiveController`. **Fix:** Single-source via `Identifier.canonical_channel/1` everywhere.
- **H18 (persistence S3):** `Scrollback.list_archive/3` does `GROUP BY COALESCE(dm_with, channel)` with no covering index — full-set sort at every archive open. N×log(N) per open on a heavy user (50k messages). **Fix:** Add expression index `(user_id, network_id, COALESCE(dm_with, channel))` + visitor mirror.

### Theme E — Infra preflight + healthcheck gaps (3 findings)

- **H19 (docker S2):** nginx admin allowlist hardcoded in THREE places: `infra/nginx.conf:136`, `cicchetto/e2e/nginx-test.conf:86`, `cicchetto/e2e/nginx-test.conf:153`. Router scope is the SoT (M-9b convention). New admin resource = THREE identical regex edits. **Fix:** Extract `infra/snippets/locations-api.conf` `include`d in both server blocks. The `security-headers.conf` snippet is the proof-of-pattern.
- **H20 (docker S3):** `deploy.sh` preflight Class regexes miss `compose.override.yaml`, `compose.oneshot.yaml`, `bin/grappa`, `.dockerignore`, deeper `infra/snippets/` paths, and ALL `config/*.exs`. SECRET_SIGNING_SALT in `config/config.exs:102` is compile-time-read; a salt rotation via `.env` + auto-deploy is silently broken because preflight doesn't catch config/*.exs changes. **Fix:** Either anchor regex to handle the additional paths OR (better) call `mix run -e ...` on a dedicated `preflight/2` function in Elixir.
- **H21 (docker S4):** `SECRET_SIGNING_SALT` read at COMPILE time in `config/config.exs:102` (line is `System.get_env("SECRET_SIGNING_SALT") || "build-time-placeholder-not-prod-safe"`). Sibling `SECRET_KEY_BASE` is runtime. Salt rotation via `.env` + auto-deploy silently broken; no preflight signal. **Fix:** Move to `config/runtime.exs` alongside `SECRET_KEY_BASE`.

### Theme F — PWA shell coverage gap (1 finding)

- **H22 (cicchetto S3):** SW navigation-route denylist missing `/api`, `/uploads`, `/admin`. Direct navigation to a `📸 https://<host>/uploads/<slug>.png` URL posted in IRC, opened in a new tab from the cic PWA, serves the SPA shell instead of the image. Admin REST endpoints opened directly serve SPA. **Fix:** Broaden denylist regex to `[^\\/(auth|me|networks|socket|push|api|admin|uploads)/]`. Add integration test that parses router scope prefixes and asserts SW denylist is a superset.

### Theme G — cic SolidJS reactivity (1 finding)

- **H23 (cicchetto S4):** `markerRef` `let`-bound ref in `ScrollbackPane.tsx:622` leaks across `<For>` mid-channel re-renders when cursor advance removes the unread-marker row. Compensated for channel-switch case at line 993 but NOT for mid-channel removal. Documented gotcha per `feedback_solidjs_for_ref_leak`. **Fix:** Convert to function-ref signal — `const [markerRef, setMarkerRef] = createSignal<...>()` + `ref={el => setMarkerRef(el)}`. SolidJS calls the function with `undefined` on unmount.

### Theme H — Server boundary discipline (2 findings)

- **H24 (cicchetto S2):** Admin-channel `snapshot` and `event` handlers cast WS payloads directly without the `narrowChannelEvent`/`narrowUserEvent`-style runtime narrower the rest of the codebase adopted. Malformed payload crashes channel subscription. **Fix:** Introduce `narrowAdminEvent` + `narrowAdminSnapshot` in `wireNarrow.ts`; route both `channel.on` arms through it.
- **H25 (cross-module S2):** `Grappa.ServerSettings` defines private `@topic "grappa:server_settings"` + calls raw `Phoenix.PubSub.broadcast/3` — bypasses the documented single source of truth (`Grappa.PubSub.Topic` + `broadcast_event/2`). Topic invisible to `Topic.parse/1`. **Fix:** Add `Topic.server_settings/0`; replace raw broadcast with `Grappa.PubSub.broadcast_event/2`.

### Theme I — Infra healthcheck adequacy (1 finding)

- **H26 (docker S5):** `/healthz` (and the container HEALTHCHECK shell) does not exercise the Repo, Bootstrap-readiness, or long-lived ETS. A wedged-state container with Phoenix.Endpoint still answering passes healthy. Concrete failure: hot-deploy-induced shape mismatch where the BEAM accepts the reload but crashes on next message — `/healthz` returns 200 until that message lands. **Fix:** Have `/healthz` actually exercise the substrate: `Repo.query("SELECT 1")` + `Grappa.Health.ready?/0` that the supervision tree's boot completion sets to true.

### Theme J — Docker pattern divergence (1 finding)

- **H27 (docker S7):** `deploy.sh:235` + `deploy-cic.sh:48` use bare `docker exec grappa …` instead of `_lib.sh`'s `in_container` — escape hatch from the discipline. Assumes container name = `grappa` literally (matches `container_name:` today), brittle to override + multi-host. **Fix:** Replace with `in_container curl …`. Two two-line changes.

---

## MEDIUM findings (50 — gating subset only)

Per `docs/reviewing.md`: **MEDIUM only when the finding is an
architecture smell, maintainability hazard, best-practice gap,
or evolution risk** (will hurt a future cluster). Cosmetic MEDs
collected for sweep but not bucket-gates. **20 of the 50 MEDs
are gating** (listed below); the remaining 30 are in the per-
agent draft files.

### Gating MEDs by theme

**Infra simplification leverage:**
- **M1 (docker S8):** `_lib.sh` `WORKTREE_VOLUMES` hardcoded list duplicates the "worktree source = read-write everything" contract; new top-level config file silently fails to mount. **Fix:** Mount `$SRC_ROOT:/app` directly + tmpfs/named-volume overlays for cache-only paths.
- **M2 (docker S9):** `nginx-test.conf` :80 + :443 blocks are 80% byte-for-byte duplicate. The "can't include inside server block" objection is incorrect. **Fix:** `infra/snippets/locations-api.conf` `include`d from both server blocks.
- **M3 (docker S10):** `bin/grappa` enumerates verbs 4× (function defs + help defs + dispatch_help switch + dispatch switch + help_top heredoc). **Fix:** `declare -Ag VERBS=(...)` single source.
- **M4 (docker S11):** `compose.yaml` / `compose.override.yaml.example` / `compose.oneshot.yaml` disagree on which compose-merge keyword to use (`!override` vs `!reset null` vs `!reset []`). **Fix:** Pick one + document.
- **M5 (docker S12):** `start_period: 180s` is a band-aid for bind-mount-shadows-image. The Dockerfile bakes `_build` then the bind-mount throws it away. **Fix:** Add anonymous volumes for `_build`/`deps`/`.mix`/`.hex`/`.cache`. Mechanically the same fix as M1.
- **M6 (docker S13):** `bin/start.sh`'s `+SDio = +SDcpu = nproc` overrides BEAM's `+SDio 10` floor. On single-core hosts, sqlite WAL pool can serialize. **Fix:** Floor at 10 OR drop the env-var fiddling.

**Server-side closed-set / typespec drift:**
- **M7 (lifecycle S6):** `Session.Server.handle_info({:EXIT, _, :shutdown|:normal})` catch-all silently propagates from unspecified linked process. Comment is the only defense against a future `Process.link/1` from inside a handler. **Fix:** Pattern-match `client_pid` exhaustively; raise on unknown linked pid.
- **M8 (lifecycle S7):** `cancel_and_drain/2` drains only one queued message — invariant by convention. **Fix:** Loop the receive.
- **M9 (lifecycle S8):** `Visitors.Reaper` schedules next `:tick` AFTER `sweep/0` completes — cadence drifts under sweep load. **Fix:** Monotonic-clock-based "next tick at" OR schedule at START of handler.
- **M10 (lifecycle S5):** `Operator.reset_circuit/2` uses `:sys.get_state` to drain NetworkCircuit's cast — couples Operator to NetworkCircuit internals. **Fix:** Expose `NetworkCircuit.reset_sync/1`.
- **M11 (lifecycle S10):** `Operator.disconnect_session` emits `:session_disconnected` even on already-parked credential. Admin-events ring buffer dishonest. Sister visitor branch correctly gates on `Session.whereis`. **Fix:** Gate emission on the actual `:connected → :parked` transition.
- **M12 (persistence S10):** `Scrollback.fetch/5` + `fetch_after/5` 5-arity wrappers auto-pass `nil` for `own_nick`. CP14-B3 leak fix can silently re-emerge through any future controller forgetting the threading. **Fix:** Drop the 5-arity wrappers; make own_nick always required.
- **M13 (persistence S11):** `Networks.transition!/3` bypasses every changeset rule via `Ecto.Changeset.change/2`. `connection_state_reason` text field has NO CR/LF/NUL guard; would split log lines if a malformed reason ever propagated. **Fix:** Route through `Credential.connection_state_changeset/2` with `safe_line_token` validation.

**Cross-cutting / single-source-of-truth:**
- **M14 (cross-module S5):** `Grappa.Session.call_session/3` defaults to 5s GenServer timeout with no error-shape capture (sibling `/4` has the explicit-timeout shape with graceful `{:error, :timeout}`). Two sibling functions, inconsistent caller behavior. **Fix:** Inline `/3` into `/4` with explicit default + `try/catch :exit, {:timeout, _}` wrapper.
- **M15 (cross-module S7):** `Grappa.Networks.broadcast_state_change/4` broadcasts TWO consecutive `broadcast_event` calls per state change. Subscribers can see inconsistent state in the window between the two events. **Fix:** Fold into one payload OR move to distinct topics.

**Web boundary discipline:**
- **M16 (web S2):** `ChannelsController.remove_from_autojoin/3` logs at warning + returns 202 even when autojoin removal fails. M-9b silent-swallow shape. Next reconnect re-joins a channel the user explicitly left. **Fix:** Propagate the error through `with`; FallbackController surfaces 422/404.
- **M17 (web S5):** `ArchiveController.delete/2` strict-binds on `{:ok, _} =` — any context error becomes MatchError → 500 bypassing FallbackController. **Fix:** Replace with `with` arm.
- **M18 (web S6):** `UploadsController.disposition_header/1` uses `URI.encode_www_form/1` (form-URL encoding, space → `+`) inside RFC 5987 `filename*=UTF-8''...` value which requires `%20`. **Fix:** `URI.encode/2` with unreserved-char predicate.

**Cross-surface naming + drift:**
- **M19 (cross-surface S15):** `mentions_bundle.messages[*]` uses `sender_nick:` while sibling `ScrollbackMessage` uses `sender:`. Server moduledoc flagged this as deferred drift; per "Total consistency or nothing" should be paid. **Fix:** Rename `sender_nick` → `sender` everywhere; one-touch breaking change.
- **M20 (cross-surface S18):** REST error envelope uses `error:` key; WS Channel uses `reason:` key for the same conceptual error. cic can't branch on WS error tokens. **Fix:** Unify on `error:` in both surfaces.

The remaining 30 MEDs are cosmetic / minor evolution risk —
see per-agent drafts. Examples: irc auth_fsm phase-pin parity
on 903/904/905 numerics; `Visitor.touch_changeset` misnamed for
dual use; `UserSettings.merge_with_defaults` dead atom-key
fallback; cic `HomePane` `home_data?` optional contradicting
server contract; cic `Sidebar` archiveKey ad-hoc string concat
duplicating `channelKey`; cic `Shell` registerHandlers at
body-level instead of `onMount`.

---

## LOW findings (27)

Informational sweep — collected per agent draft, not gating. Spot-fix
opportunistically when adjacent code is touched.

Notable themes: dead-code clauses in `Identifier.services_sender?`,
empty-reason `send_away/2` accepting `AWAY :\r\n`,
`Push.subscription.id` as `string` vs branded UUID type on cic,
`linkify` regex `\S+` unbounded match length, `image-upload.ts`
reading `localStorage["grappa-token"]` directly instead of via
`token()` signal, `bin/start.sh` env-fiddling vs trusting BEAM
defaults, `register-dns.sh` deployment-specific helper sitting
in universal scripts directory.

---

## Trajectory

### What we built recently (CP30 → CP38 timeline)

Past 8 days produced: full UX-5 cluster (15 buckets A→BD,
mobile polish wave), full UX-6 cluster (11 buckets A→L + Z,
iPhone dogfood wave 2 including the 6-attempt iOS rubber-band
saga and the embedded image-uploader server stack), full UX-7
cluster (6 buckets A→F, baseline-e2e-fails investigation). Plus
the post-iOS dogfood "what's still broken on a real iPhone" wave.

iOS dogfood Z, autoscaling-cluster Z, T-cluster Z, M-cluster Z all
LANDED. README "Closed clusters" section now spans Phase 1 →
Phase 4 + most-of-Phase-5-UX in one continuous narrative.

### Does it serve the core mission

**Mission:** always-on IRC bouncer with REST + Phoenix Channels
real-time event push, plus a browser PWA (cicchetto) that looks
like irssi. Phase 6 IRCv3 listener facade downstream.

**Verdict: yes — emphatically.** The mission is being built. The
walking-skeleton-through-iOS-dogfood arc covered everything from
the IRC framing layer up to the per-pixel WKWebView keyboard
behavior. CP38 baseline: 2314 ExUnit tests passing, 8 doctests,
32 properties, 0 Dialyzer warnings, 0 Credo strict warnings, 0
Sobelow findings, doctor green, bats 23/23, 1575 vitest passing,
e2e suite mostly green (45 baseline-flake testnet specs).

### What's stalling

**Phase 5 hardening backlog has 8 items unbought.** Listed in
todo.md High tier — TLS verify chain, NickServ correlation
machinery, multi-server failover, HSM-keyed Vault, a11y audit,
WS token off query string, `signing_salt` rotation. UX-clusters
shipped continuously; hardening accumulates. This review surfaces
some hardening-adjacent gaps (C4 preflight, H21 salt-compile-
time, M5 healthcheck depth) that the explicit Phase 5 backlog
doesn't cover yet.

**Phase 6 IRCv3 listener has zero buckets started.** Listed in
README roadmap as "Phase 6 IRCv3 listener facade" — not in
todo.md beyond a Medium-tier "open tracking doc" item. The IRC
parser is ready for it (Phase 1 design contract), but no
listener spec exists yet.

### Observation items overdue

`feedback_bahamut_load_flake` — 45 baseline e2e flake spec set
is unliquidated for 4+ weeks. CLAUDE.md `feedback_recurring_e2e_not_flake`
says same-triplet recurring fails are NEVER flakes — yet the
operator decision was "park as flake" rather than investigate.
At minimum, the set should be triaged: which are real product
bugs hidden behind a flake label?

`project_bastille_deploy_workstream` (GitHub #8) — ordered AFTER
this review wave per memory; not gating today, but the moment
all CRIT/HIGH/gating-MED are closed, that becomes the next big
work item.

### Risk check

**Drift between server and cic shapes is the biggest emergent
risk.** Two CRITs land there (C1 + C2); a third of the HIGHs
cluster on closed-set drift (Theme A); the explicit recommendation
from cross-surface S5 → "extract shared narrower" is the
right architectural shape to make this class of bug structurally
preventable rather than caught at code-review.

**Substrate fragility is the second.** The single CRIT (C4
preflight regex) is benign today but is exactly the kind of "one
wrong refactor" gate that the CP28 incident-class lives behind.
H19/H20/H21/H26 all live in the same substrate space — duplication
+ preflight gaps + healthcheck depth — and they compound.

### Direction recommendation

1. **This review wave** (per vjt 2026-05-16 plan): fix all 4
   CRIT + all 29 HIGH + the 20 gating MED in a multi-bucket
   sprint. Per-bucket reviewer-loop. Estimated 8-12 buckets
   given the natural seams (Theme A could be 2-3 buckets, Theme
   E could be 1-2, infra fixes 2-3, server boundary 2-3, etc.).
2. **Then Phase 5 hardening** — pick the highest-leverage High-
   tier item from todo.md (`signing_salt` rotation slot well
   with the salt-compile-time CRIT-adjacent fix that lands in this
   wave; TLS verify chain naturally follows).
3. **Then Bastille deploy workstream** (#8) per the project
   memory ordering.

A specific structural recommendation that emerged from this
review and didn't exist in any prior plan: **introduce a
generated `cicchetto/src/lib/wireTypes.ts` from server-side
Wire typespecs.** The drift between `Wire.ex` typespecs and cic
types is the bug class behind C1, C2, H1, H2, H3, H4, H6, M19,
M20. A small Elixir mix task that emits TS type definitions from
the Wire module typespecs would close this class structurally
rather than at code-review. Worth one bucket of scoping work.

---

## Bucket plan (proposal for vjt blessing)

To deliver this review, propose the following bucket sequence.
Each bucket is independently shippable, gated by reviewer-loop
+ scripts/check.sh exit-0 + bun check/test exit-0 + per-surface
e2e where touched. Cic-touching buckets HOT cic-only. lib-touching
buckets use `scripts/deploy.sh` preflight (HOT vs COLD auto-
detect). Cluster name: **REV** (codebase-review-fixes,
2026-05-22).

| Bucket | Scope | Findings closed | Surface | Deploy |
|--------|-------|-----------------|---------|--------|
| **REV-A** | Cross-surface wire arms + flow union | C1, C2, H1 | both | COLD (cic + Wire typespec + new tests) |
| **REV-B** | Persistence SQLite pragma + closed-set guards | C3, H6, H17, H18 | server | COLD (config/runtime + migration for H18 index) |
| **REV-C** | Substrate preflight + healthcheck depth | C4, H20, H21, H26 | infra | COLD (deploy.sh + healthcheck + signing_salt move to runtime.exs) |
| **REV-D** | Silent-swallow at boundaries | H12, H13, H14, H15, H16, M16, M17 | server | preflight-detect (mix.exs unchanged; lib changes only) |
| **REV-E** | `:ok = Client.send_*` regression sweep | H11 | server | preflight-detect (lib changes only) |
| **REV-F** | IRC SASL fallback + missing arm | H9, H10 | server | preflight-detect |
| **REV-G** | cic SW denylist + adminEvents narrower + markerRef leak | H22, H24, H23 | cic | HOT cic-only |
| **REV-H** | Server-side type tightening (Theme A continued) | H2, H3, H4, H5, H7, H8, H25 | server + cic | COLD (touches Wire typespecs + cic types in lockstep) |
| **REV-I** | Infra simplification (nginx snippets + bin/grappa table + docker dedup) | H19, H27, M1-M6 | infra | COLD |
| **REV-J** | Cross-cutting smells (cross-module M14/M15 + lifecycle M7-M11 + persistence M12-M13) | M7-M15 | server | preflight-detect |
| **REV-K** | Cross-surface naming pay-down (sender_nick → sender + error envelope unify) | M19, M20 | both | COLD |
| **REV-Z** | Docs + README sweep + LOW liquidation that fits | (LOW set) | docs | n/a |

Mid-cluster CP38 → CP39 rotation likely after REV-D or REV-E (CP38 at 344 lines; first 4 bucket entries push past 400).

Standing by for vjt blessing on the bucket plan + first-bucket dispatch.
