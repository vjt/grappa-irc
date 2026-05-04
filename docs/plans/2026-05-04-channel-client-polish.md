# `cluster/channel-client-polish` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Spec is in memory pin** `project_channel_client_polish` (vjt-blessed CLOSED 2026-05-04) — read it before any task; this plan is the implementation-order overlay, not the spec.

**Goal:** Fill core IRC-client UX gaps in cicchetto so grappa is "an IRC client worth its name" (vjt's words). 21 features + cluster-wide rules. T32 disconnect verb REVIVED simplified; auto-away on web disconnect + mentions-while-away window; channel-header strip; user-action numeric routing; full slash-command verb set (~25 verbs); persisted query windows + watchlist; mobile layout reshape (bottom-bar UNDER input grouped-by-network).

**Architecture:** 13 buckets. **S1–S4** server-side primitives (T32 / persistence / presence / numeric routing / ops chunking) ship first so cicchetto has wire-shape contracts to consume. **C1–C8** cicchetto consumes those primitives and adds UX. **Z** wrap (DESIGN_NOTES, full-cluster review, LANDED). **Push per-bucket on green** (vjt-blessed 2026-05-04 — push frequently). Cicchetto is `/srv/grappa/cicchetto/` — same git repo, same worktree branch covers both sides.

**Tech stack:** Elixir 1.19 / OTP 28; Phoenix 1.8 + Bandit; Ecto 3 + ecto_sqlite3 (sqlite supports json1); SolidJS + TypeScript + Vite + Bun + Biome (cicchetto); Bypass + Mox + ExUnit + StreamData (server tests); vitest + jsdom (cicchetto tests); container-only execution via `scripts/*.sh`.

**Spec:** `~/.claude/projects/-srv-grappa/memory/project_channel_client_polish.md` (memory pin) + `~/.claude/projects/-srv-grappa/memory/project_t32_disconnect_verb.md` (T32 spec). Brainstorm CLOSED 2026-05-04 — see decision table below.

**Existing scaffolding (substantial — most buckets EXTEND, not greenfield):**
- Server: `Grappa.Session.Server` already handles `:send_privmsg`, `:send_topic`, `:send_nick`, `:send_join`, `:send_part`, `:list_channels`, `:list_members`, IRC PING, EXIT, backoff, ghost recovery.
- Server: `Grappa.Session.EventRouter` routes IRC events including MODE sign-walking (per T31 cleanup).
- Server: `GrappaWeb.GrappaChannel` + `UserSocket` are the Phoenix Channels surface.
- Cicchetto: `slashCommands.ts` (87 lines, basic parser); `mentions.ts` + `mentionMatch.ts` (existing matcher); `userTopic.ts` (topic state stub); `modeApply.ts` (MODE handling); `members.ts` (channel members with prefixes); `networks.ts` + `subscribe.ts` + `socket.ts` (Phoenix Channels infrastructure); `TopicBar.tsx` (stub with placeholder topic + hamburger affordances).

**Process gates:**
- **Worktree:** `cluster/channel-client-polish` branched from local `main` (`git checkout main` first). Worktree path `~/code/IRC/grappa-task-channel-client-polish`.
- **TDD:** failing test FIRST per task. Use production code in tests; never re-implement logic.
- **Plan-fix-first:** spec drift mid-execution → fix this plan (or pin) on main FIRST in a docs-only commit, THEN proceed.
- **README currency AS WE GO** (per `feedback_readme_currency` — vjt 2026-05-04 "fucking readme must be kept current as we go"): every bucket that ships user-facing surface (new slash-cmd, new REST endpoint, new visible UX element, new env var, new mix task, deploy-flow change) updates `README.md` IN THE SAME BUCKET — folded into the bucket-close commit OR a dedicated `docs(readme): ...` commit before the bucket-atomic ff-merge. NOT deferred to bucket Z. Bucket Z is the SAFETY NET (final diff catches misses), not the primary mechanism. Per-bucket README touch obligations are listed in each user-facing bucket's task list.
- **Reviewer gate evidence:** subagent reviewer pastes literal tail of every gate command (`scripts/format.sh --check`, `scripts/credo.sh --strict`, `scripts/dialyzer.sh`, `scripts/test.sh`, `scripts/check.sh`, `cd cicchetto && bun run test`, `cd cicchetto && bun run check`). Decision H from T31 (B6.21) lands the reviewer-template upgrade — channel-client-polish inherits.
- **Standalone dialyzer:** before LANDED claim, run `scripts/dialyzer.sh` standalone in addition to `scripts/check.sh` per `feedback_dialyzer_plt_staleness`.
- **25% ctx ceiling:** orchestrator triggers proactive clear-cycle on sibling at ~25% per `feedback_orchestrator_proactive_clear`.
- **Push per-bucket on green:** orchestrator instructs `git push origin main` after each bucket ff-merges and gates pass per `feedback_push_autonomy` (NOT cluster-end-only — vjt-blessed 2026-05-04).
- **Cicchetto repo coordination:** same git repo, same worktree branch. Server-side and cicchetto changes can land in the same bucket commits where they're tightly coupled (e.g. new Phoenix Channels event + cicchetto consumer); split when independent.

---

## Decision table (vjt-blessed brainstorm 2026-05-03 / 2026-05-04)

| ID | Decision | Verdict |
|----|----------|---------|
| A | T32 disconnect verb REVIVED (was DROPPED) | YES, simplified scope |
| B | T32 column shape | enum `connection_state :: :connected | :parked | :failed` + `_reason` + `_changed_at`, NOT a single bool. Runtime sub-states (`:connecting`, `:reconnecting`, `:backing_off`) stay in Session.Server, NOT mirrored to DB |
| C | T32 `:failed` triggers | LENIENT ("just be polite"). Hard errors only: 465 ERR_YOUREBANNEDCREEP (k-line/g-line), permanent SASL fail (904/906 on misconfigured creds, NOT transient retries). Transient errors (timeout, max-backoff, refused, dns) keep Session.Server in continuous reconnect with `:connected`. |
| D | `/quit` semantics | Nuclear: park ALL bound networks (`:parked`) + IRC QUIT each upstream + close WS + clear auth + redirect to login |
| E | `/disconnect` semantics | Surgical per-network. Active-window's network if no arg; named network if arg. Visitor: alias to `/quit`. |
| F | `/connect` semantics | Unpark + respawn Session.Server. Works from `:parked` OR `:failed`. |
| G | Auto-away debounce | 30s after last WS connection closes |
| H | Auto-away immediate path | `pagehide` / `beforeunload` browser hint → cicchetto sends "closing" hint over WS → server sets away IMMEDIATELY (no debounce). Falls back to debounced if hint never arrives. |
| I | Mentions-while-away window | Pseudo-window kind `:mentions` per network. Show ALL matches in interval (no cap). Click row → jump to source channel scrolled to that message in context. |
| J | Watchlist storage | New `user_settings` table. Cross-network single list (one list per user, applied everywhere). JSON column shape (sqlite json1) — keeps room for future per-user prefs beyond the watchlist. |
| K | Watchlist verbs | `/watch` and `/highlight` are synonyms. Subverbs: `add <pattern>` / `del <pattern>` / `list`. |
| L | Watchlist patterns | Default = case-insensitive substring + word-boundary. Regex via `/<pattern>/` slash-delimited literal IF cheap; otherwise defer to post-cluster. |
| M | Watchlist updates | Forward-only — when watchlist changes mid-session, do NOT re-aggregate past mentions. New patterns apply to incoming traffic only. |
| N | `/topic <text>` clear-syntax | Follow irssi: `/topic -delete`. |
| O | Bare-nick ban-mask default | WHOIS-cache derived `*!*@host` if WHOIS data cached; fallback `nick!*@*`. Implies Session.Server keeps lightweight `nick → {user, host}` cache. |
| P | `/banlist` + `/invite` | BUNDLED into cluster (not deferred). Render numerics inline like WHOIS. |
| Q | `/links` render-loc | Server-messages window (#4). NO dedicated `:links` window. |
| R | Mobile breakpoint | Tailwind `md:` ~768px. |
| S | Channel-window header | Always pinned (no auto-collapse on scroll). |
| T | Window-list ordering | Server-messages first → channels → queries. Grouped by network. Horizontal scrolling on mobile + within network. Same shape on desktop. |
| U | Failure-class numeric visual | Red color (text or prefix; render-pass detail). |
| V | `labeled-response` IRCv3 cap | Opportunistic: enable when upstream advertises in CAP LS. Numeric routing fallback uses last-command-window if cap absent. |
| W | Push policy | Per-bucket on green ff-merge. NOT cluster-end-only. |
| X | Window kinds | `:channel | :query | :server | :list | :mentions`. (`:links` dropped — uses server-msgs.) |
| Y | Focus rule | Cluster-wide: focus changes ONLY on user actions (`/join`-self, `/msg`/`/query`/`/q`, click on nick or tab). Never on incoming traffic. |
| Z | Visitor edges | Visitors skip auto-away, query_windows persistence, watchlist persistence (their credential row is ephemeral). `/disconnect` for visitors aliases to `/quit`. |

---

## Bucket overview

| Bucket | Title | Side | Tasks | Push after |
|---|---|---|---|---|
| **S1** | T32 connection_state + verbs end-to-end | server + cic | 6 | yes |
| **S2** | Persistence migrations + Session.Server state shells | server | 5 | yes |
| **S3** | Presence + auto-away + WS counter | server + cic | 6 | yes |
| **S4** | Numeric routing + labeled-response cap | server | 4 | yes |
| **S5** | Server-side ops + multi-target chunking | server | 5 | yes |
| **C1** | Window-list refactor + close semantics + restore | cic | 5 | yes |
| **C2** | Slash-command parser dispatch (all verbs) | cic | 3 | yes |
| **C3** | Channel-window header + JOIN-self banner | cic | 3 | yes |
| **C4** | DM auto-open + focus rule + /msg /query /q | cic | 3 | yes |
| **C5** | Ops UI submenu + numeric red rendering | cic | 4 | yes |
| **C6** | Mobile layout (bottom-bar + hamburger + 768px) | cic | 4 | yes |
| **C7** | Scrollback polish bundle | cic | 7 | yes |
| **C8** | Mentions window + away UI + watchlist UI | cic | 4 | yes |
| **Z** | DESIGN_NOTES + README integrity check + cluster review + LANDED (README touched per-bucket throughout) | both | 4 | yes (final) |

**Cross-bucket order:** S1 → S2 → S3 → S4 → S5 → C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → Z. Server-side primitives ship first; cicchetto consumes them. Within each bucket sibling carves natural sub-seams.

**Total tasks:** ~63 (Z gained README sweep per `feedback_readme_currency`). Cluster scope is large; per-bucket push policy means user sees progress continuously rather than waiting for end-of-cluster.

---

## Bucket S1 — T32 connection_state + verbs end-to-end

**Goal:** Land the `connection_state` enum migration, `Networks.connect/disconnect/mark_failed` context fns, PATCH endpoint extension, Session.Server `:failed` triggers, plus `/quit /disconnect /connect` cicchetto slash-cmd wiring END-TO-END (validates the full plumbing pipeline before bigger buckets pile on).

### Task S1.1: Migration — `connection_state` enum + reason + changed_at on `Networks.Credential`

**Files:**
- Create: `priv/repo/migrations/<ts>_add_connection_state_to_network_credentials.exs`
- Modify: `lib/grappa/networks/credential.ex`
- Modify: `test/grappa/networks/credential_test.exs`

- [ ] **Step 1**: Migration adds 3 columns. `Ecto.Enum [:connected, :parked, :failed]` (default `:connected`); `connection_state_reason :: :string` nullable; `connection_state_changed_at :: :utc_datetime` (default `fragment("CURRENT_TIMESTAMP")`). Backfill all existing rows to `:connected`.
- [ ] **Step 2**: Schema field updates + cast/validate in changesets. State transitions allowed: any → any (server enforces business rules in context, not schema).
- [ ] **Step 3**: Property test: round-trip enum values; reject invalid atoms.
- [ ] **Step 4**: `git commit -m "feat(networks): connection_state enum + reason + changed_at on Credential (T32 part)"`

### Task S1.2: `Networks.connect/1` + `Networks.disconnect/2` + `Networks.mark_failed/2`

**Files:**
- Modify: `lib/grappa/networks.ex`
- Create: `test/grappa/networks/connection_state_test.exs`

- [ ] **Step 1**: Tests for each context fn. `disconnect/2` issues IRC QUIT upstream via Session.Server (use Mox or in-process fake), then transitions to `:parked` + sets reason + changed_at + broadcasts session-lifecycle event over PubSub. `connect/1` transitions to `:connected` + spawns Session.Server (re-uses existing `Networks.spawn_session/1` path Bootstrap uses). `mark_failed/2` is server-internal; transitions to `:failed`, terminates Session.Server, broadcasts.
- [ ] **Step 2**: Implementation. State-transition matrix:
  - `connect/1`: from `:parked | :failed` → `:connected`; idempotent if already `:connected`.
  - `disconnect/2`: from `:connected` → `:parked`; reject if already `:parked` or `:failed` (return `{:error, :not_connected}`).
  - `mark_failed/2`: from `:connected` → `:failed`; idempotent if already `:failed`. Reject from `:parked` (parked is user intent, don't override).
- [ ] **Step 3**: Update `Networks.list_credentials_for_all_users/0` to filter `connection_state == :connected` (Bootstrap skips others).
- [ ] **Step 4**: `git commit -m "feat(networks): connect/disconnect/mark_failed context fns (T32 part)"`

### Task S1.3: PATCH `/networks/:id` endpoint extension

**Files:**
- Modify: `lib/grappa_web/controllers/network_controller.ex`
- Modify: `lib/grappa_web/controllers/network_json.ex`
- Modify: `test/grappa_web/controllers/network_controller_test.exs`

- [ ] **Step 1**: Tests — PATCH with `{connection_state: "parked", reason: "manual"}` calls `Networks.disconnect/2`. PATCH with `{connection_state: "connected"}` calls `Networks.connect/1`. PATCH with `{connection_state: "failed"}` returns 400 (server-set only). Authz: only credential owner.
- [ ] **Step 2**: Implementation in NetworkController.update/2. Reuse FallbackController for error tuples. Render new `connection_state` + `connection_state_reason` + `connection_state_changed_at` in network_json.ex.
- [ ] **Step 3**: `git commit -m "feat(web): PATCH /networks/:id supports connection_state transitions (T32 part)"`

### Task S1.4: Session.Server hook for `:failed` triggers (lenient)

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `test/grappa/session/server_test.exs`

- [ ] **Step 1**: Tests — receiving 465 ERR_YOUREBANNEDCREEP from upstream calls `Networks.mark_failed/2` with reason `"k-line: <numeric trailing>"`. Receiving 904 with permanent-fail reason (e.g. SASL aborted) marks failed. Receiving 904 with transient (timeout) does NOT mark failed (continues backoff). Timeout / refused / dns errors do NOT mark failed.
- [ ] **Step 2**: Implementation. New `handle_terminal_failure/2` private fn. Pattern-matches on numeric + reason. Calls `Networks.mark_failed/2`, sets state, terminates self (supervisor sees `:normal` exit; `:transient` restart strategy doesn't restart on `:normal`).
- [ ] **Step 3**: `git commit -m "feat(session): lenient :failed triggers — k-line + permanent SASL only (T32 part)"`

### Task S1.5: Cicchetto wiring — `/quit /disconnect /connect` verbs

**Files:**
- Modify: `cicchetto/src/lib/slashCommands.ts`
- Create: `cicchetto/src/lib/__tests__/slashCommands.test.ts` (extend if exists)
- Modify: `cicchetto/src/lib/api.ts` (PATCH /networks/:id wrapper)
- Modify: `cicchetto/src/Shell.tsx` (handle /quit logout flow)

- [ ] **Step 1**: Slash-cmd parser tests for `/quit`, `/quit reason`, `/disconnect`, `/disconnect #netname`, `/disconnect reason`, `/connect netname`. Bare `/disconnect` from a query/server window error-renders inline ("requires channel context" — wait actually `/disconnect` needs network context, which any window has if it's network-attached — error only if active window has no network).
- [ ] **Step 2**: `/quit` flow: collect all credentials, PATCH each to `:parked`, then close WS + clear auth + redirect to login. Reason propagated to PATCH body.
- [ ] **Step 3**: `/disconnect` and `/connect` flows: single PATCH each, refresh window-list state from response.
- [ ] **Step 4**: `git commit -m "feat(cic): /quit /disconnect /connect slash verbs (T32 part)"`

### Task S1.6: README touch + bucket-atomic ff-merge + push

- [ ] **README touch** (per `feedback_readme_currency` per-bucket rule): document `/quit`, `/disconnect [network] [reason]`, `/connect <network>` slash-commands; document the `connection_state` user-visible model (parked/connected/failed) + `PATCH /networks/:id` connection_state extension. One commit `docs(readme): T32 verbs + connection_state model` before ff-merge.
- [ ] Run `scripts/check.sh` + standalone dialyzer + `cd cicchetto && bun run test` + `cd cicchetto && bun run check`. All green.
- [ ] Rebase worktree onto main (`git fetch origin && git rebase origin/main`).
- [ ] ff-merge to main; push origin/main per `feedback_push_autonomy`.
- [ ] CP entry for S1 LANDED.

---

## Bucket S2 — Persistence migrations + Session.Server state shells

**Goal:** Land `query_windows` table, `user_settings` table (JSON column), and Session.Server in-memory cache shells (topic + modes + WHOIS-userhost). Wire Phoenix Channels events for the new state. No cicchetto consumption yet — that lands in C-side buckets.

### Task S2.1: Migration — `query_windows` table

**Files:**
- Create: `priv/repo/migrations/<ts>_create_query_windows.exs`
- Create: `lib/grappa/query_windows.ex` (context module)
- Create: `lib/grappa/query_windows/window.ex` (schema)
- Create: `test/grappa/query_windows_test.exs`

- [ ] **Step 1**: Migration. Columns: `user_id` (FK), `network_id` (FK), `target_nick :: string` (case-preserve, but lookup case-insensitive), `opened_at :: utc_datetime`. Composite unique index `(user_id, network_id, lower(target_nick))`. ON DELETE CASCADE for both FKs.
- [ ] **Step 2**: Schema + changeset.
- [ ] **Step 3**: Context fns — `open(user_id, network_id, target_nick)` upsert; `close(user_id, network_id, target_nick)` delete; `list_for_user(user_id)` returns grouped-by-network list.
- [ ] **Step 4**: Tests including idempotent upsert + case-insensitive uniqueness.
- [ ] **Step 5**: `git commit -m "feat(query_windows): table + context fns for persisted DM windows"`

### Task S2.2: Migration — `user_settings` table (JSON column)

**Files:**
- Create: `priv/repo/migrations/<ts>_create_user_settings.exs`
- Create: `lib/grappa/user_settings.ex` (context)
- Create: `lib/grappa/user_settings/settings.ex` (schema)
- Create: `test/grappa/user_settings_test.exs`

- [ ] **Step 1**: Migration. Single row per user. Columns: `user_id` (FK, unique, ON DELETE CASCADE), `data :: :map` (JSON column via sqlite json1; Ecto type `:map`). Default `%{}`. `inserted_at` + `updated_at`.
- [ ] **Step 2**: Schema with explicit accessors for first known key: `highlight_patterns :: list(string)` (default `[]`). Use `embedded_schema` or accessor functions; first version goes with accessor functions over `data` map to keep migrations cheap as new keys arrive.
- [ ] **Step 3**: Context fns — `get_or_init(user_id)` returns settings row, creates if missing. `get_highlight_patterns(user_id)` returns list. `set_highlight_patterns(user_id, list)` updates. Atomic via Ecto.Multi or `update_or_insert`.
- [ ] **Step 4**: Tests including default empty list + persist round-trip + concurrent-update safety.
- [ ] **Step 5**: `git commit -m "feat(user_settings): table + context fns + highlight_patterns key"`

### Task S2.3: Session.Server topic + modes cache state

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `lib/grappa/session/event_router.ex` (already routes TOPIC events; consume into cache)
- Modify: `test/grappa/session/server_test.exs`

- [ ] **Step 1**: Add `topics :: %{channel => %{text, set_by, set_at}}` and `channel_modes :: %{channel => %{modes :: charlist, params :: list(string)}}` to Session.Server state struct.
- [ ] **Step 2**: Handle 332 RPL_TOPIC, 333 RPL_TOPICWHOTIME, 331 RPL_NOTOPIC, unsolicited TOPIC. Update `topics` map.
- [ ] **Step 3**: Handle MODE events on channels (already partially via event_router). Update `channel_modes` map (apply +/- sigil walking with PREFIX-aware exclusion of user-mode prefixes like @+).
- [ ] **Step 4**: New API: `Session.Server.get_topic(network_id, channel)` + `get_channel_modes(network_id, channel)`. Both serve from cache (no upstream query).
- [ ] **Step 5**: Broadcast events on TOPIC change + MODE change to `Phoenix.PubSub.broadcast(Grappa.PubSub, "grappa:network:#{net}/channel:#{chan}", {:topic_changed, %{...}})` etc.
- [ ] **Step 6**: `git commit -m "feat(session): topic + channel-modes cache state + PubSub broadcasts"`

### Task S2.4: Session.Server WHOIS-userhost cache

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/server_test.exs`

- [ ] **Step 1**: Add `userhost_cache :: %{nick => %{user, host}}` to Session.Server state. Populated from JOIN's userhost (when nick present in JOIN message prefix), WHOIS replies (311 RPL_WHOISUSER), and WHO replies (352 RPL_WHOREPLY).
- [ ] **Step 2**: Tests — populate from each source; case-insensitive nick lookup; LRU or cap TBD (defer; no cap for first version, evict on QUIT/PART events).
- [ ] **Step 3**: New API: `Session.Server.lookup_userhost(network_id, nick)` returns `{:ok, %{user, host}} | :error`. Used by S5 for ban-mask derivation.
- [ ] **Step 4**: `git commit -m "feat(session): WHOIS-userhost cache for ban-mask derivation"`

### Task S2.5: Phoenix Channels events for new state

**Files:**
- Modify: `lib/grappa_web/channels/grappa_channel.ex`
- Modify: `test/grappa_web/channels/grappa_channel_test.exs`

- [ ] **Step 1**: New outbound events: `topic_changed`, `channel_modes_changed`, `query_windows_list` (sent on join + on every persistent change). Schema documented inline (one short `@type t` block per event payload).
- [ ] **Step 2**: On user-socket join: send initial snapshot of topics + modes for joined channels + `query_windows_list` for the user.
- [ ] **Step 3**: Tests — subscribe + assert events arrive on state change.
- [ ] **Step 4**: `git commit -m "feat(channel): topic/modes/query_windows events on Phoenix Channels surface"`

### Task S2.6: Bucket-atomic ff-merge + push

(Per S1.6 pattern.)

---

## Bucket S3 — Presence + auto-away + WS counter

**Goal:** Auto-away on web disconnect (#19). Multi-tab WS-presence tracking; 30s debounce timer; `pagehide` immediate-away hint from cicchetto; explicit `/away` interaction with auto-away precedence. Mentions-while-away aggregation query (server-side; cicchetto window render lands in C8).

### Task S3.1: WS-presence counter per user-network

**Files:**
- Modify: `lib/grappa/session/server.ex` (or new `lib/grappa/session/presence.ex` if cleaner)
- Modify: `lib/grappa_web/channels/user_socket.ex`
- Create: `test/grappa/session/presence_test.exs`

- [ ] **Step 1**: Track count of connected WS sessions per user. Use Phoenix.Tracker or a Registry entry per WS — pick during impl based on existing patterns. NOT mirrored to DB.
- [ ] **Step 2**: On WS connect: increment counter. On WS disconnect: decrement; if zero, schedule 30s debounce timer for auto-away.
- [ ] **Step 3**: Tests — multi-tab simulation: open 2 sockets, close 1, no away. Close both, debounce starts. Reconnect within debounce, debounce cancelled.
- [ ] **Step 4**: `git commit -m "feat(presence): WS-counter + auto-away debounce timer"`

### Task S3.2: Auto-away state + transitions in Session.Server

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `test/grappa/session/server_test.exs`

- [ ] **Step 1**: Add `away_state :: :present | :away_explicit | :away_auto`, `away_started_at :: utc_datetime | nil`, `away_reason :: string | nil` to Session.Server state.
- [ ] **Step 2**: API: `set_explicit_away(server, reason) | unset_explicit_away(server) | set_auto_away(server) | unset_auto_away(server)`. Each issues IRC `AWAY :reason` or bare `AWAY` upstream.
- [ ] **Step 3**: Precedence rule: `set_auto_away` is no-op if `away_state == :away_explicit`. `unset_auto_away` is no-op if `away_state == :away_explicit`. `set_explicit_away` always wins (overwrites auto-away).
- [ ] **Step 4**: Tests — precedence matrix; round-trip transitions; idempotency.
- [ ] **Step 5**: `git commit -m "feat(session): away_state + explicit-takes-precedence-over-auto rule"`

### Task S3.3: pagehide immediate-away hint endpoint

**Files:**
- Modify: `lib/grappa_web/channels/grappa_channel.ex`
- Modify: `cicchetto/src/lib/socket.ts` (or new presence.ts)
- Modify: `cicchetto/src/main.tsx` (`pagehide` / `beforeunload` listener)

- [ ] **Step 1**: New inbound channel event: `client_closing`. On reception, server immediately calls `set_auto_away` (skips debounce).
- [ ] **Step 2**: Cicchetto: `pagehide` and `beforeunload` listeners send `client_closing` over WS using `socket.send(...)` synchronously. Best-effort — browser may not deliver.
- [ ] **Step 3**: Tests — server side asserts immediate transition. Cicchetto vitest jsdom-mocks pagehide event + asserts socket.send call.
- [ ] **Step 4**: `git commit -m "feat(presence): pagehide immediate-away hint (no debounce)"`

### Task S3.4: `/away` slash-cmd integration

**Files:**
- Modify: `cicchetto/src/lib/slashCommands.ts`
- Modify: `lib/grappa_web/channels/grappa_channel.ex` (away handler)
- Tests in both repos.

- [ ] **Step 1**: `/away :reason` calls `set_explicit_away`; `/away` (bare) calls `unset_explicit_away`. Channel event payload: `%{action: :set | :unset, reason: string | nil}`.
- [ ] **Step 2**: Server numerics 305/306 fan back as `away_confirmed` event for inline render.
- [ ] **Step 3**: `git commit -m "feat(cic+server): /away slash-cmd + 305/306 inline confirm"`

### Task S3.5: Mentions aggregation query

**Files:**
- Modify: `lib/grappa/scrollback.ex` (or new `lib/grappa/mentions.ex`)
- Tests in `test/grappa/scrollback_test.exs` or new file.

- [ ] **Step 1**: New context fn `aggregate_mentions(user_id, network_id, away_started_at, away_ended_at, watchlist_patterns)`. SQL query with case-insensitive word-boundary match against patterns OR target == user's nick. Returns scrollback message rows ordered by `server_time ASC`.
- [ ] **Step 2**: Property test: synthetic scrollback insertions + various patterns; assert correct subset returned.
- [ ] **Step 3**: Performance check: query uses existing `(network_id, channel, server_time DESC)` index; LIKE-with-leading-wildcard may not benefit from index but result set is small (one away interval). Document in comment.
- [ ] **Step 4**: `git commit -m "feat(scrollback): aggregate_mentions query for mentions-while-away"`

### Task S3.6: Bucket-atomic ff-merge + push

---

## Bucket S4 — Numeric routing + labeled-response cap

**Goal:** Ship the numeric-routing matrix (#21) + opportunistic IRCv3 `labeled-response` cap. Param-derived routing for most numerics; last-command-window correlation as fallback for param-less numerics when cap is unavailable.

### Task S4.1: `Grappa.Session.NumericRouter` module + matrix

**Files:**
- Create: `lib/grappa/session/numeric_router.ex`
- Create: `test/grappa/session/numeric_router_test.exs`

- [ ] **Step 1**: Define `route/2` taking `%Message{}` numeric + Session.Server state. Returns `{:target_window, window_kind, params}` like `{:channel, "#foo"}`, `{:query, "nick"}`, `{:server, nil}`, `{:active, nil}`. Encode the matrix from spec — file contains a well-commented routing table:
  - Channel-param numerics: 404 442 471 472 473 474 475 477 478 482 367 368 → `:channel`
  - Nick-param numerics: 401 405 442 → `:query` if exists, else `:active`
  - Param-less: 432 433 437 421 461 305 306 → `:active` (uses last_command_window from state)
  - Already-handled (delegated): WHOIS 311–319, WHO 352/315, NAMES 353/366, LIST 321/322/323, LINKS 364/365, MOTD 375/372/376 (route via existing handlers; not this matrix's job).
- [ ] **Step 2**: Property tests: each numeric class routes as documented.
- [ ] **Step 3**: `git commit -m "feat(session): NumericRouter matrix (param-derived)"`

### Task S4.2: IRCv3 `labeled-response` cap negotiation + correlation

**Files:**
- Modify: `lib/grappa/irc/client.ex` or wherever CAP LS handling lives
- Modify: `lib/grappa/irc/parser.ex` (parse `@label=...` tag if not already)
- Modify: `lib/grappa/session/server.ex`

- [ ] **Step 1**: During CAP LS, request `labeled-response` if advertised. Track per-Session.Server whether the cap is active.
- [ ] **Step 2**: When sending a tracked command (one that we want to correlate), prepend `@label=<uuid>` IRCv3 message-tag. Track `labels_pending :: %{label => origin_window}` in state.
- [ ] **Step 3**: When numeric arrives with label echo, look up origin_window in labels_pending and use it as routing target.
- [ ] **Step 4**: Tests — Bypass IRC server simulating cap advertisement + label echo.
- [ ] **Step 5**: `git commit -m "feat(irc): IRCv3 labeled-response cap + per-label window correlation"`

### Task S4.3: `last_command_window` fallback in Session.Server

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `lib/grappa_web/channels/grappa_channel.ex` (pass origin_window to send_*)

- [ ] **Step 1**: Add `last_command_window :: window_ref | nil` to state. Updated on every cicchetto-originated command. cicchetto's outbound channel events carry `origin_window: %{kind: :channel | :query | ..., target: string}`.
- [ ] **Step 2**: NumericRouter falls back to `last_command_window` when param-derived routing yields `:active`.
- [ ] **Step 3**: Tests — origin propagation; fallback correctness.
- [ ] **Step 4**: `git commit -m "feat(session): last_command_window for cap-less numeric correlation"`

### Task S4.4: Phoenix Channels event with `target_window` field

**Files:**
- Modify: `lib/grappa_web/channels/grappa_channel.ex`
- Tests.

- [ ] **Step 1**: `numeric_routed` event with `%{numeric: int, params: list, trailing: string, target_window: %{kind, target}, severity: :ok | :error}`. cicchetto consumes in C5 to render in target_window's view.
- [ ] **Step 2**: `git commit -m "feat(channel): numeric_routed event with target_window field"`

### Task S4.5: Bucket-atomic ff-merge + push

---

## Bucket S5 — Server-side ops + multi-target chunking

**Goal:** Server-side handlers for all ops verbs (`/op /deop /voice /devoice /kick /ban /unban /banlist /invite /umode /mode /topic`). Multi-target chunking per ISUPPORT MODES=. WHOIS-cache-aware ban-mask derivation. `/topic` set-and-clear.

### Task S5.1: ISUPPORT MODES= parsing + chunker

**Files:**
- Modify: `lib/grappa/irc/client.ex` (ISUPPORT 005 numeric handling)
- Create: `lib/grappa/session/mode_chunker.ex`
- Tests.

- [ ] **Step 1**: Parse `MODES=N` from RPL_ISUPPORT; default 3 if not advertised. Store on Session.Server state.
- [ ] **Step 2**: `ModeChunker.chunk(modes, params, max_per_chunk)` returns list of `{modes_str, params_chunk}`. Round-trip property test.
- [ ] **Step 3**: `git commit -m "feat(session): ISUPPORT MODES= + ModeChunker"`

### Task S5.2: Ops verb handlers in Session.Server

**Files:**
- Modify: `lib/grappa/session/server.ex` — new handle_call clauses
- Tests.

- [ ] **Step 1**: `:send_op {chan, nicks}` / `:send_deop {chan, nicks}` / `:send_voice {chan, nicks}` / `:send_devoice {chan, nicks}` / `:send_kick {chan, nick, reason}` / `:send_ban {chan, mask}` / `:send_unban {chan, mask}` / `:send_invite {chan, nick}` / `:send_banlist chan` / `:send_topic_set {chan, text}` (already exists via `:send_topic`) / `:send_topic_clear chan` / `:send_umode modes` / `:send_mode {target, modes, params}`.
- [ ] **Step 2**: `:send_op /deop /voice /devoice /ban /unban` route through ModeChunker. `:send_mode` is verbatim pass-through (no chunking).
- [ ] **Step 3**: `:send_ban {chan, bare_nick}` calls `Session.Server.lookup_userhost/2` (S2.4) for `*!*@host`; falls back to `nick!*@*`.
- [ ] **Step 4**: Tests for each verb. Use in-process IRCServer test helper.
- [ ] **Step 5**: `git commit -m "feat(session): ops verb handlers + ModeChunker integration + WHOIS-aware ban-mask"`

### Task S5.3: GrappaChannel handlers for ops events

**Files:**
- Modify: `lib/grappa_web/channels/grappa_channel.ex`
- Tests.

- [ ] **Step 1**: Inbound channel events for each verb. Each carries `origin_window` per S4.3.
- [ ] **Step 2**: Auth: only logged-in user, scoped to user's networks.
- [ ] **Step 3**: `git commit -m "feat(channel): inbound ops events"`

### Task S5.4: `/topic -delete` (irssi convention)

**Files:**
- Modify: `lib/grappa/session/server.ex` (`:send_topic_clear` issues `TOPIC #chan :` with empty trailing)
- Tests.

- [ ] **Step 1**: irssi semantic: `/topic -delete` clears (sends `TOPIC #chan :` with empty trailing). Verify against IRC RFC + bahamut behaviour. Document in commit body.
- [ ] **Step 2**: `git commit -m "feat(session): topic-clear via empty trailing arg (irssi convention)"`

### Task S5.5: Bucket-atomic ff-merge + push

---

## Bucket C1 — Window-list refactor + close semantics + restore

**Goal:** Refactor cicchetto window-list to support window-kind atoms (`:channel | :query | :server | :list | :mentions`). Implement ordering rule (server / channels / queries grouped by network). Closeable X-button + close semantics per kind. Restore-on-WS-connect (uses S2 `query_windows_list` event).

### Task C1.1: Window-kind type + ordering selector

**Files:**
- Modify: `cicchetto/src/lib/networks.ts` (or wherever window state lives)
- Create: `cicchetto/src/lib/windowKinds.ts`
- Tests.

- [ ] **Step 1**: Type `WindowKind = "channel" | "query" | "server" | "list" | "mentions"` (matches server-side atom names exactly).
- [ ] **Step 2**: Ordering selector: takes flat list of windows + groups by network + within-network sorts: server first, channels (alpha), queries (alpha), list, mentions. Ephemeral kinds (list, mentions) only present when active.
- [ ] **Step 3**: `git commit -m "feat(cic): window-kind atom + ordering selector"`

### Task C1.2: Close semantics per kind

**Files:**
- Modify: `cicchetto/src/Sidebar.tsx`
- Modify: `cicchetto/src/lib/api.ts` (close-query API call)
- Tests.

- [ ] **Step 1**: X-button on each tab. Close behavior:
  - `:channel` → issues PART; window dismissed on PART confirm.
  - `:query` → calls `closeQueryWindow(network_id, target_nick)` API → server deletes `query_windows` row → cicchetto window dismissed.
  - `:server` → not closeable (no X button rendered).
  - `:list, :mentions` → client-side dismiss only.
- [ ] **Step 2**: Tests — vitest with mocked API + state.
- [ ] **Step 3**: `git commit -m "feat(cic): close semantics per window kind"`

### Task C1.3: Restore-on-WS-connect (query_windows_list event)

**Files:**
- Modify: `cicchetto/src/lib/subscribe.ts`
- Tests.

- [ ] **Step 1**: On `query_windows_list` event from socket join, populate cicchetto window-list state with restored queries.
- [ ] **Step 2**: Tests — synthetic event → window-list state populated.
- [ ] **Step 3**: `git commit -m "feat(cic): restore persisted query windows on WS connect"`

### Task C1.4: openQueryWindow API + state

**Files:**
- Modify: `cicchetto/src/lib/api.ts` (POST /query_windows)
- Modify: `cicchetto/src/lib/networks.ts` (window-state mutation)
- Server: extend Phoenix Channel with `open_query_window` inbound event (delegate to `Grappa.QueryWindows.open/3`).

- [ ] **Step 1**: API + state. Auto-deduped server-side via unique idx.
- [ ] **Step 2**: Tests.
- [ ] **Step 3**: `git commit -m "feat(cic+server): open_query_window event + persistence"`

### Task C1.5: Bucket-atomic ff-merge + push

---

## Bucket C2 — Slash-command parser dispatch (all verbs)

**Goal:** Extend cicchetto `slashCommands.ts` to parse and dispatch every verb in the spec. Inline error rendering harness (ephemeral lines) for verbs that error before reaching server. Each verb wires to its appropriate channel event or REST API call. NO new feature behavior — pure plumbing layer for verbs.

### Task C2.1: Parser refactor — dispatch table

**Files:**
- Modify: `cicchetto/src/lib/slashCommands.ts`
- Tests in `cicchetto/src/lib/__tests__/slashCommands.test.ts`

- [ ] **Step 1**: Refactor parser into `parse(input) → {verb, args, raw}` + dispatch table mapping verb → handler fn. Verbs to register: `msg query q nick away quit who names list links disconnect connect op deop voice devoice kick ban unban banlist invite umode mode topic watch highlight`.
- [ ] **Step 2**: Per-verb arg validation + error harness (returns `{:error, msg}` for inline render).
- [ ] **Step 3**: Aliases: `q == query`; `watch == highlight`. One dispatch fn per logical verb.
- [ ] **Step 4**: Tests — table-driven with input → expected dispatch.
- [ ] **Step 5**: `git commit -m "feat(cic): slash-cmd parser refactor with dispatch table"`

### Task C2.2: Handler wiring per verb

**Files:**
- Modify: `cicchetto/src/lib/slashCommands.ts`
- Reference fn calls into existing infrastructure.

- [ ] **Step 1**: Wire each handler to its target. Examples:
  - `/msg /query /q` → openQueryWindow + send PRIVMSG (C4 will polish auto-open behavior)
  - `/topic <text>` → channel event :send_topic_set
  - `/topic` (bare) → render cached topic inline (uses topic state from C3's TopicBar source)
  - `/topic -delete` → :send_topic_clear
  - `/op` etc → channel event :send_op + multi-arg parsing
  - `/watch /highlight {add|del|list}` → REST POST/DELETE/GET `/user_settings/highlight_patterns`
  - `/quit /disconnect /connect` → from S1 already wired.
- [ ] **Step 2**: Tests for each handler — vitest mocks of channel + API.
- [ ] **Step 3**: Commits per verb-cluster (single bucket commit OK if natural seam):
  ```
  feat(cic): slash-cmd handlers — DM verbs (/msg /query /q)
  feat(cic): slash-cmd handlers — channel ops (/op /deop /voice /devoice /kick /ban /unban /banlist /invite)
  feat(cic): slash-cmd handlers — info verbs (/who /names /list /links)
  feat(cic): slash-cmd handlers — user verbs (/nick /umode /mode)
  feat(cic): slash-cmd handlers — topic verbs (/topic /topic <text> /topic -delete)
  feat(cic): slash-cmd handlers — watchlist (/watch /highlight)
  ```

### Task C2.3: Bucket-atomic ff-merge + push

---

## Bucket C3 — Channel-window header + JOIN-self banner

**Goal:** Fill out `TopicBar.tsx` with always-pinned topic + modes display. Render JOIN-self banner with topic + names + count summary. Touches the channel-window first-impression UX heavily.

### Task C3.1: TopicBar full implementation

**Files:**
- Modify: `cicchetto/src/TopicBar.tsx` (currently 64 lines, mostly stub)
- Modify: `cicchetto/src/lib/userTopic.ts` (extend topic state)
- Modify: `cicchetto/src/themes/default.css`
- Tests.

- [ ] **Step 1**: TopicBar reads topic + mode-string from state (subscribed to `topic_changed` / `channel_modes_changed` events from S2.5).
- [ ] **Step 2**: Single-line ellipsized topic + click/tap → modal expand showing full topic + setter nick + set-at timestamp.
- [ ] **Step 3**: Compact mode-string (`+nt`) with hover-tooltip listing modes.
- [ ] **Step 4**: Empty-topic placeholder "(no topic set)".
- [ ] **Step 5**: Always-pinned (no auto-collapse).
- [ ] **Step 6**: Tests — vitest with various topic states.
- [ ] **Step 7**: `git commit -m "feat(cic): TopicBar always-pinned topic + modes header"`

### Task C3.2: JOIN-self banner

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx`
- Tests.

- [ ] **Step 1**: On JOIN-by-self event, render banner at top of channel scrollback view: "You joined #chan", topic line, names list with PREFIX sigils (@op +voice etc.), "N users, M ops" summary. Pure render; not persisted as scrollback rows.
- [ ] **Step 2**: Banner shows once per session per channel-window-mount; subsequent visits to same channel within the session don't re-render banner (it's a first-impression artifact).
- [ ] **Step 3**: Tests.
- [ ] **Step 4**: `git commit -m "feat(cic): JOIN-self banner with topic + names + count"`

### Task C3.3: Bucket-atomic ff-merge + push

---

## Bucket C4 — DM auto-open + focus rule + /msg /query /q

**Goal:** Implement auto-open-on-incoming-PRIVMSG (unfocused). Cluster-wide focus-rule enforcement (focus changes only on user actions). Wire /msg, /query, /q from C2 to actual DM open + send.

### Task C4.1: Auto-open query window on incoming PRIVMSG

**Files:**
- Modify: `cicchetto/src/lib/subscribe.ts` (PRIVMSG handler)
- Modify: `cicchetto/src/lib/networks.ts` (window-state)
- Tests.

- [ ] **Step 1**: On incoming PRIVMSG to own nick from a sender with no existing query window: call openQueryWindow API (persists row), open window in cicchetto state. **Do NOT switch focus.** Increment unread badge per #8.
- [ ] **Step 2**: Tests — synthetic PRIVMSG + assert window opened + focus unchanged.
- [ ] **Step 3**: `git commit -m "feat(cic): auto-open query window on incoming PRIVMSG (unfocused)"`

### Task C4.2: Focus-rule audit + enforcement

**Files:**
- Modify: `cicchetto/src/lib/networks.ts` (focus mutation guards)
- Tests.

- [ ] **Step 1**: Audit every focus-change call site. Focus may change only on: /join-self, /msg /query /q, click-on-tab, click-on-nick. NOT on incoming traffic, NOT on auto-open-from-PRIVMSG, NOT on window auto-creation.
- [ ] **Step 2**: Add invariant test: "focus does not change after incoming traffic" (vitest).
- [ ] **Step 3**: `git commit -m "feat(cic): cluster-wide focus-only-on-user-action rule + tests"`

### Task C4.3: /msg /query /q wiring complete

**Files:**
- Modify: `cicchetto/src/lib/slashCommands.ts` (handlers from C2)
- Tests.

- [ ] **Step 1**: `/msg <nick> <text>` opens query window (focus switch) AND sends PRIVMSG immediately. `/query <nick>` and `/q <nick>` open window (focus switch) without sending.
- [ ] **Step 2**: Tests — full flow including focus switch.
- [ ] **Step 3**: `git commit -m "feat(cic): /msg /query /q full DM verbs"`

### Task C4.4: Bucket-atomic ff-merge + push

---

## Bucket C5 — Ops UI submenu + numeric red rendering

**Goal:** Right-click context menu on members for ops actions. Permission-gated (disabled rendering, not hidden). Render numeric replies routed via S4 in target windows. Failure-class numerics in red.

### Task C5.1: Right-click context menu

**Files:**
- Modify: `cicchetto/src/MembersPane.tsx`
- Create: `cicchetto/src/UserContextMenu.tsx` (or similar)
- Tests.

- [ ] **Step 1**: Right-click on member → submenu: op/deop, voice/devoice, kick (with reason input), ban (with mask preview), WHOIS, query.
- [ ] **Step 2**: Permission gating: disable items based on own-nick channel modes. Read modes from S2.3 channel_modes_changed state.
- [ ] **Step 3**: Tests — render with various perm states.
- [ ] **Step 4**: `git commit -m "feat(cic): user context menu with permission-gated ops"`

### Task C5.2: Numeric routing render in target windows

**Files:**
- Modify: `cicchetto/src/lib/subscribe.ts`
- Modify: `cicchetto/src/ScrollbackPane.tsx` (ephemeral inline render)
- Tests.

- [ ] **Step 1**: Consume `numeric_routed` event from S4.4. Route to target_window's ephemeral inline render (NOT persisted as scrollback row).
- [ ] **Step 2**: Render shape: short-line `* <numeric_text>` style; failure-class in red; success-class muted.
- [ ] **Step 3**: Tests.
- [ ] **Step 4**: `git commit -m "feat(cic): numeric_routed event consumer + per-window inline render"`

### Task C5.3: Failure-class red visual

**Files:**
- Modify: `cicchetto/src/themes/default.css`
- Tests.

- [ ] **Step 1**: CSS class for failure numerics: red text or red prefix marker. Render-pass detail; brainstorm exact color (~#ff4444 readable on dark + light themes).
- [ ] **Step 2**: Visual review.
- [ ] **Step 3**: `git commit -m "feat(cic): failure-class numeric visual (red)"`

### Task C5.4: Bucket-atomic ff-merge + push

---

## Bucket C6 — Mobile layout (bottom-bar + hamburger + 768px)

**Goal:** Mobile UX reshape per #10. Bottom tab-bar UNDER text input. Hamburger nicks-only. Breakpoint at tailwind `md:` ~768px. Horizontal scrolling for window-list grouped by network.

### Task C6.1: Layout breakpoint + responsive shell

**Files:**
- Modify: `cicchetto/src/Shell.tsx` (currently 207 lines)
- Modify: `cicchetto/src/themes/default.css`
- Tests.

- [ ] **Step 1**: Breakpoint at 768px via CSS (or tailwind `md:`). Below: mobile shape; above: desktop shape (existing).
- [ ] **Step 2**: Tests — vitest jsdom with viewport mock (or playwright if available).
- [ ] **Step 3**: `git commit -m "feat(cic): mobile breakpoint + responsive shell"`

### Task C6.2: Bottom tab-bar UNDER text input

**Files:**
- Modify: `cicchetto/src/Shell.tsx`
- Modify: `cicchetto/src/Sidebar.tsx` (or new BottomBar.tsx)
- Tests.

- [ ] **Step 1**: New BottomBar component for mobile. Vertical order: scrollback → text input → tab-bar (BELOW input). Horizontal scroll for windows. Grouped by network with a network-name chip header.
- [ ] **Step 2**: Window ordering (server / channels / queries) per C1.1 selector.
- [ ] **Step 3**: Badges per #8 inline on each tab.
- [ ] **Step 4**: `git commit -m "feat(cic): mobile bottom tab-bar UNDER input + network grouping"`

### Task C6.3: Hamburger nicks-only on mobile

**Files:**
- Modify: `cicchetto/src/Shell.tsx`
- Modify: `cicchetto/src/MembersPane.tsx`

- [ ] **Step 1**: Hamburger menu (top corner) opens slide-out nicks-list for current channel. ONLY nicks — channels live in bottom-bar, not duplicated.
- [ ] **Step 2**: Tests.
- [ ] **Step 3**: `git commit -m "feat(cic): mobile hamburger nicks-only slide-out"`

### Task C6.4: Bucket-atomic ff-merge + push

---

## Bucket C7 — Scrollback polish bundle

**Goal:** Polish-pack for scrollback rendering: day-separators, muted-events, unread-marker, scroll-to-bottom button, msg-vs-events badges, clickable nicks, in-scrollback highlight rendering, failure-class red rendering.

### Task C7.1: Day-separator lines

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx`
- Tests.

- [ ] **Step 1**: When timestamp delta crosses a day boundary in user's local TZ, render separator row "── Saturday, May 4 ──" between scrollback rows. Pure client-side from `server_time` field.
- [ ] **Step 2**: Tests with synthetic scrollback spanning multiple days.
- [ ] **Step 3**: `git commit -m "feat(cic): day-separator lines in scrollback"`

### Task C7.2: Muted-events rendering

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx`
- Modify: `cicchetto/src/themes/default.css`
- Tests.

- [ ] **Step 1**: JOIN/PART/QUIT/MODE/NICK/TOPIC events render with reduced contrast (dimmer color, smaller font, possibly italic). PRIVMSG/NOTICE/ACTION dominate visually.
- [ ] **Step 2**: Tests.
- [ ] **Step 3**: `git commit -m "feat(cic): muted-event rendering for non-message scrollback rows"`

### Task C7.3: Unread-marker on focus switch

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx`
- Modify: `cicchetto/src/lib/scrollback.ts` (read-cursor state)
- Tests.

- [ ] **Step 1**: When user switches to a window with unread:
  - Render 2-3 most-recent READ messages above marker.
  - Render "── XX unread messages ──" marker line.
  - Render unread messages below.
  - Initial scroll position = at marker.
- [ ] **Step 2**: Read cursor in localStorage keyed `(network_id, channel)`.
- [ ] **Step 3**: Tests.
- [ ] **Step 4**: `git commit -m "feat(cic): unread-marker on focus switch + localStorage read-cursor"`

### Task C7.4: Scroll-to-bottom floating button

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx`
- Modify: `cicchetto/src/themes/default.css`
- Tests.

- [ ] **Step 1**: Floating button (lower-right of scrollback pane) appears when scrolled away from latest. Click → smooth-scroll to bottom + resume auto-follow.
- [ ] **Step 2**: Tests with scroll position simulation.
- [ ] **Step 3**: `git commit -m "feat(cic): scroll-to-bottom floating button + auto-follow resume"`

### Task C7.5: Msg-vs-events separated badges

**Files:**
- Modify: `cicchetto/src/Sidebar.tsx` and `BottomBar.tsx`
- Modify: `cicchetto/src/lib/networks.ts` (per-window unread split)
- Tests.

- [ ] **Step 1**: Per window, track two counters: messages-unread (PRIVMSG/NOTICE/ACTION) + events-unread (JOIN/PART/QUIT/MODE/NICK/TOPIC). Render messages-unread as bold/prominent badge; events-unread as smaller dot or count without background.
- [ ] **Step 2**: Both reset to zero on window focus.
- [ ] **Step 3**: Tests.
- [ ] **Step 4**: `git commit -m "feat(cic): split msg-vs-events unread badges per window"`

### Task C7.6: Clickable nicks (left-click query, right-click submenu)

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx` (nick links in scrollback rows)
- Modify: `cicchetto/src/MembersPane.tsx` (already in C5)
- Tests.

- [ ] **Step 1**: Author nicks in scrollback rows clickable: left → openQueryWindow + focus switch. Right → user context menu (C5.1).
- [ ] **Step 2**: Tests.
- [ ] **Step 3**: `git commit -m "feat(cic): clickable nicks in scrollback (left=query, right=submenu)"`

### Task C7.7: In-scrollback highlight rendering (watchlist)

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx`
- Modify: `cicchetto/src/lib/mentionMatch.ts` (extend matcher with watchlist patterns)
- Modify: `cicchetto/src/themes/default.css` (highlight color/weight)
- Tests.

- [ ] **Step 1**: When incoming PRIVMSG/NOTICE/ACTION body matches user's watchlist (incl. own_nick), render with distinct visual (different color or weight). Watchlist read from user_settings (S2.2). Pattern matching = case-insensitive substring + word-boundary; regex if S5/C2 included it.
- [ ] **Step 2**: Tests.
- [ ] **Step 3**: `git commit -m "feat(cic): in-scrollback highlight rendering for watchlist matches"`

### Task C7.8: Bucket-atomic ff-merge + push

---

## Bucket C8 — Mentions window + away UI + watchlist UI

**Goal:** Implement `:mentions` pseudo-window kind (consumes S3.5 aggregation). Click row → scroll-to-message-in-context. Away visual indicator on own-nick. Watchlist UI via /watch /highlight verbs (already wired in C2; this bucket polishes UX).

### Task C8.1: Mentions window component

**Files:**
- Create: `cicchetto/src/MentionsWindow.tsx`
- Modify: `cicchetto/src/Shell.tsx` (route :mentions kind)
- Tests.

- [ ] **Step 1**: New component for `:mentions` window kind. Consumes `mentions_bundle` event from server emitted on back-from-away. Renders list of matched messages with timestamp + channel + sender + body. Each row clickable.
- [ ] **Step 2**: Window opens automatically on back-from-away IF there's at least one match. Closeable; ephemeral (no persist).
- [ ] **Step 3**: Tests with synthetic bundle.
- [ ] **Step 4**: `git commit -m "feat(cic): MentionsWindow component for back-from-away aggregation"`

### Task C8.2: Click-to-context (scroll-to-message-in-channel)

**Files:**
- Modify: `cicchetto/src/MentionsWindow.tsx`
- Modify: `cicchetto/src/ScrollbackPane.tsx` (scroll-to-timestamp API)
- Tests.

- [ ] **Step 1**: Click row → switch focus to source channel + scroll scrollback to that message timestamp.
- [ ] **Step 2**: Reuse infra from C7.3 unread-marker scroll-positioning (similar problem shape).
- [ ] **Step 3**: Tests.
- [ ] **Step 4**: `git commit -m "feat(cic): click-mention-to-context (focus channel + scroll to message)"`

### Task C8.3: Away visual indicator + watchlist UI polish

**Files:**
- Modify: `cicchetto/src/Shell.tsx` or topbar component (own-nick badge)
- Modify: `cicchetto/src/lib/slashCommands.ts` (/watch /highlight UX feedback inline)
- Tests.

- [ ] **Step 1**: When own_away_state ≠ :present, show subtle "away" indicator near own-nick label.
- [ ] **Step 2**: `/watch list` renders inline list of patterns. `/watch add foo` confirms inline. `/watch del foo` confirms inline. Errors (e.g. pattern already exists) render as failure-class numeric (red, per #21 + C5.3).
- [ ] **Step 3**: Tests.
- [ ] **Step 4**: `git commit -m "feat(cic): away visual indicator + /watch /highlight inline UX"`

### Task C8.4: Bucket-atomic ff-merge + push

---

## Bucket Z — DESIGN_NOTES + cluster review + LANDED

**Goal:** Cluster close-out. DESIGN_NOTES entry for the architectural shifts. Full-cluster code review (parallel agents per `code-review` skill). LANDED CP entry. Memory pin status updates.

### Task Z.1: DESIGN_NOTES entry

**Files:**
- Modify: `docs/DESIGN_NOTES.md`

- [ ] **Step 1**: Append entry covering: T32 connection_state shape; auto-away semantics (multi-tab WS counter, pagehide hint); numeric-routing matrix; query_windows persistence; user_settings as forward-compatible JSON store; cluster-wide focus-only-on-user-action rule; window-kind atom enumeration; visitor-skip discipline.
- [ ] **Step 2**: `git commit -m "docs(design-notes): channel-client-polish cluster architectural decisions"`

### Task Z.2: README final integrity check (safety net per `feedback_readme_currency`)

**Files:**
- Modify: `README.md` (only if drift surfaces)

This is the SAFETY NET, not the primary mechanism — the per-bucket README-touch sub-step (process gates section, also explicitly listed in S1.6 / S5.X / C1.X / C2.X / C3.X / C4.X / C5.X / C6.X / C7.X / C8.X bucket-close tasks) is where README updates actually land in-step with shipping. This task verifies nothing slipped.

**Files:**
- Modify: `README.md` (only if drift surfaces)

- [ ] **Step 1**: Diff README against the FULL cluster shipped surface — slash-commands (~25 verbs across S1+C2: /quit /disconnect /connect /nick /away /msg /query /q /op /deop /voice /devoice /kick /ban /unban /banlist /invite /umode /mode /topic /who /names /list /links /watch /highlight), REST surface (PATCH `/networks/:id` connection_state extension), tables (`query_windows`, `user_settings`), env vars (none expected), mix tasks (none expected), deploy steps (migrations only), visible cicchetto UX surface (window-kinds, mobile bottom-bar, channel-header strip, mentions window).
- [ ] **Step 2**: If gaps surface: per-bucket README-touch failed at SOMEWHERE — trace which bucket missed it, and either back-fill in this commit OR (if substantial) raise to vjt as a process audit.
- [ ] **Step 3**: If no gaps: this task lands a no-op note in the CP entry confirming the per-bucket discipline held.
- [ ] **Step 4**: If diff lands: `git commit -m "docs(readme): channel-client-polish final integrity sweep — <list misses>"`. If no-op: skip the commit, note it in CP.

### Task Z.3: Full-cluster code review (parallel agents)

- [ ] Spawn parallel review agents per `code-review` skill — server-side review, cicchetto review, cross-cutting consistency review, security review (Sobelow + manual auth surface).
- [ ] Triage findings; fold-forward fixes per T31-style discipline.
- [ ] Re-run all gates after fixes.

### Task Z.4: LANDED CP + memory pin updates

**Files:**
- Modify: active checkpoint (`docs/checkpoints/2026-05-XX-cpYY.md`)
- Memory pin update: `~/.claude/projects/-srv-grappa/memory/project_channel_client_polish.md` mark LANDED with date.
- Memory pin update: `~/.claude/projects/-srv-grappa/memory/project_t32_disconnect_verb.md` mark LANDED.
- Memory pin update: `~/.claude/projects/-srv-grappa/memory/project_post_p4_1_arc.md` strike `cluster/channel-client-polish` from "next ships," promote `cluster/image-upload`.

- [ ] **Step 1**: Final gates: full `scripts/check.sh` + standalone dialyzer + `cd cicchetto && bun run test` + `cd cicchetto && bun run check` + boundary check.
- [ ] **Step 2**: Real-browser e2e via `chrome-devtools-mcp`:
  1. Login (registered + visitor flows).
  2. Open multiple channels + query windows; close some; reload page; restored state matches.
  3. Slash-cmd flows: `/topic` set/clear; `/op` user; `/disconnect` + `/connect`; `/quit` (full nuclear path).
  4. `/away` set + unset → mentions window appears with synthetic mentions if any during interval.
  5. Mobile viewport (DevTools mobile emulation): bottom-bar visible + horizontal scroll across networks; hamburger opens nicks-only.
  6. Auto-away: close all tabs → reopen 30s+ later → AWAY upstream issued during gap (verify via IRC log capture).
  7. Pagehide path: navigate away from cicchetto → AWAY immediate (no debounce).
- [ ] **Step 3**: Deploy: `scripts/deploy.sh` rebuilds prod image; healthcheck green at `http://grappa.bad.ass`.
- [ ] **Step 4**: Memory pin updates + CP LANDED entry.
- [ ] **Step 5**: Worktree cleanup: branch + worktree removal per `commit-commands:clean_gone` skill.
- [ ] **Step 6**: `git commit -m "docs(cp): channel-client-polish LANDED — full IRC-client UX cluster"`
- [ ] **Step 7**: Final push to origin.

---

## Cluster ship gates (sibling reads BEFORE claiming LANDED)

  * `scripts/check.sh` — 0 failures, 0 dialyzer, 0 credo, 0 sobelow.
  * `scripts/dialyzer.sh` standalone — 0 errors (per `feedback_dialyzer_plt_staleness`).
  * `cd cicchetto && bun run test` — all green.
  * `cd cicchetto && bun run check` — biome + tsc clean.
  * `mix boundary` — no boundary violations.
  * `scripts/deploy.sh` — prod image rebuilds; healthcheck green at `http://grappa.bad.ass`.
  * Real-browser e2e (per Z.3 Step 2 list).
  * Push autonomous on green per `feedback_push_autonomy` AT EACH BUCKET (vjt-blessed 2026-05-04).

## CP entry pattern (per bucket)

After each bucket lands + pushes, append a small summary to active CP:

```
## SXX — 2026-05-XX — channel-client-polish bucket BX LANDED

<bucket name>: <X tasks, Y commits>. Features closed: <list>.

Gates: check.sh + standalone dialyzer green; cicchetto X/X tests +
biome+tsc clean.

Worktree state: cluster/channel-client-polish at HEAD <sha>; ff-rebased
onto main during execution per plan-fix-first; merged ff-only after
LANDED claim. Push: pushed origin/main on bucket-LANDED per
feedback_push_autonomy.
```

## Spec coverage check (orchestrator self-review)

| Bucket | Spec features | Plan tasks |
|---|---|---|
| S1 | T32 (#17 #18 #13 backend) | S1.1–S1.5 |
| S2 | persistence (#1 #19 watchlist #20 topic+modes #3 ban-mask cache) | S2.1–S2.5 |
| S3 | auto-away (#19) + presence | S3.1–S3.5 |
| S4 | numeric routing (#21) | S4.1–S4.4 |
| S5 | server-side ops + chunking (#3) | S5.1–S5.4 |
| C1 | window-list + close (#6) + restore (#1) | C1.1–C1.4 |
| C2 | slash-cmd parser dispatch (#1 #11 #12 #13 #14 #15 #16 #17 #18 #19 #3) | C2.1–C2.2 |
| C3 | channel-header (#20) + JOIN-self banner (#7) | C3.1–C3.2 |
| C4 | DM auto-open + focus rule + /msg /query /q (#1 + cluster-wide focus rule) | C4.1–C4.3 |
| C5 | ops UI (#3) + numeric red render (#21 #5 #11 #12 #14) | C5.1–C5.3 |
| C6 | mobile layout (#10) | C6.1–C6.3 |
| C7 | scrollback polish (#5 #8 #9 + watchlist highlight from #19) | C7.1–C7.7 |
| C8 | mentions window + away UI + watchlist UX (#19) | C8.1–C8.3 |
| Z | wrap (incl. Z.2 README final integrity check — per-bucket touch obligations live in each user-facing bucket-close task, NOT here) | Z.1–Z.4 |

All 21 spec features mapped. T32 verb cluster mapped (S1 + C2 + C4-via-/quit-flow). Cluster-wide rules (focus-only-on-user-action; visitor-skip; one-feature-one-code-path) enforced per-bucket.

## Continuation after LANDED

  * Update `docs/DESIGN_NOTES.md` with final cluster close-out entry (Z.1).
  * Update memory pins (Z.3).
  * Add CP entry summarizing close.
  * Worktree cleanup.
  * Origin push autonomous on green per `feedback_push_autonomy`.

  * **Next cluster:** `cluster/image-upload` per `project_post_p4_1_arc` arc — cicchetto image upload via litterbox.catbox.moe + clickable links + image overlay; brainstorm UX before code.

## Carry-forward (not in scope this cluster)

  * Settings page UI (deferred to post-cluster polish; `/watch` slash-cmds suffice initially).
  * Regex pattern support in watchlist if not cheap during S2.2 / C7.7.
  * `/quiet <nick>` Charybdis +q (IRCd-specific, defer).
  * Voice/video → P4-V cluster.
  * Image upload → next cluster `image-upload`.
  * DCC SEND / DCC CHAT → out of MVP scope.
  * Settings-page UI for watchlist beyond /watch slash-cmds — defer.
  * Topic edit modal for /topic on long topics — brainstorm later if `/topic <text>` UX is friction.

## Open Qs (flagged during draft; non-blocking — pick during implementation)

  * **`user_settings` table shape:** JSON column (sqlite json1) vs explicit columns vs KV. Plan default: JSON column for forward-flex; redirect to explicit if migration churn becomes a problem.
  * **Regex marker syntax for `/watch`:** `/<pattern>/` slash-delimited (irssi). Include if cheap during S2.2; defer if costly.
  * **Scrollback highlight visual (color/weight):** brainstorm during C7.7 render pass.
  * **`{add|del|list}` subverb form for /watch /highlight:** plan default `/watch add <p>`, `/watch del <p>`, `/watch list`. Bare `/watch <p>` could toggle (irssi-style); brainstorm during C2.2 if user wants.
  * **failure-class red exact color:** brainstorm during C5.3.
  * **Mode-string compact rendering format:** `+nt` vs `[+nt]` vs icons. C3.1 render pass.
  * **Window-list ordering tiebreaker:** within-network channels alpha-sorted; queries alpha-sorted. Tiebreaker beyond alpha is not specified — plan goes alphabetical for both.
