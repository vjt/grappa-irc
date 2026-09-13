# Grappa — Project Memory

## What This Is

An always-on IRC bouncer with a REST API + Phoenix Channels real-time event
push, plus a browser PWA (`cicchetto`, separate codebase) that looks like
irssi. One supervised OTP process per `(user, network)`; sqlite-backed
scrollback; Phase 6 adds a downstream IRCv3 listener facade.

See `README.md` for the spec and `docs/DESIGN_NOTES.md` for the
chronological decision log. Backlog and roadmap live in GitHub issues
(`gh issue list`); implementation plans are ephemeral scratch, never
committed (see Docs map). Operator + developer runbook (verbs, scripts,
deploy machinery, per-host overrides, runtime data, monitoring) lives in
**`docs/OPERATIONS.md`**.

## Architecture

Top-level supervision tree:

```
Grappa.Application
├── Grappa.Vault                       (Cloak — encrypts at-rest creds; before Repo)
├── Grappa.Repo.LockWatch              (#1420 write-lock holder/waiter observer; before Repo — owns the ETS table the BEGIN IMMEDIATE seam writes to)
├── Grappa.Repo                        (Ecto + sqlite)
├── Phoenix.PubSub                     (name: Grappa.PubSub)
├── Registry                           (name: Grappa.SessionRegistry)
├── Registry                           (name: Grappa.SourceAliasHolders — #543 derived-alias holder index; before SessionSupervisor: sessions register on acquire)
├── Grappa.Session.Backoff             (ETS — per-(subject, network) failure counter)
├── Grappa.WSPresence                  (per-user WS pid tracking → auto-away signal)
├── Grappa.Admission.NetworkCircuit    (T31 ETS-backed per-network circuit breaker)
├── Grappa.AdminEvents                 (M-11 admin-event ring buffer + telemetry sink)
├── Grappa.SessionLog                  (#215 IRC session-lifecycle log sink)
├── Grappa.DbLatency                   (#357 SQLite write/query-latency telemetry sink)
├── Grappa.Push.VendorLog              (#1321 push rejection-reason telemetry sink)
├── Grappa.ShareTokens                 (ETS one-shot share-link tokens, both subject kinds)
├── Grappa.RateLimit.DailyQuota        (#75 per-(bucket, subject, day) creation quota)
├── Grappa.RateLimit.FailureWindow     (S6 per-(bucket, key) login-throttle window)
├── Grappa.Accounts.WebAuthnChallengeStore (short-lived WebAuthn ceremony challenges)
├── Grappa.Auth.Oidc.Transaction (#1911 one-shot OIDC round trips — verifier + nonce + intent; before Endpoint so /auth/oidc/authorize never races a dead GenServer)
├── Grappa.RateLimit.TokenBucket       (#340 per-(subject, network) send token bucket)
├── Grappa.Net.PtrCache                (#252 vhost reverse-DNS (PTR) name cache)
├── Task.Supervisor                    (name: Grappa.TaskSupervisor — detached tasks)
├── Grappa.WindowCounts.Pusher.Coalescer (#1768 one window_counts snapshot per window per window_ms; after TaskSupervisor — flushes into it)
├── DynamicSupervisor                  (name: Grappa.SessionSupervisor)
│   └── Grappa.Session.Server          (one per (user, network), :transient)
├── GrappaWeb.Endpoint                 (Phoenix HTTP + WS)
├── GrappaWeb.SessionRevocationListener (turns a bearer-death event into the WS teardown; with/after Endpoint)
├── Grappa.Net.SourceAliasManager      (#543 alias ref-counts; after Endpoint — boot reconcile; before Bootstrap — sessions acquire)
├── Grappa.Visitors.Reaper             (60s sweep of expired visitors; after Endpoint)
├── Grappa.Uploads.Reaper              (UX-6-B1 upload GC sweep; after Endpoint)
├── Grappa.Avatars.Reaper              (M3b peer-avatar cache GC sweep; after Endpoint)
├── Grappa.Accounts.Reaper             (#223 idle auth-session GC; after Endpoint)
└── Grappa.Bootstrap                   (reads DB credentials, spawns sessions; LAST)
```

Child order is load-bearing — see `lib/grappa/application.ex` for the
why-comment per child. Vault before Repo (Cloak schema callbacks);
LockWatch before Repo (#1420: it owns the ETS table
`Repo.immediate_transaction/1` writes on every write transaction, and the
seam self-disables while the table is absent);
Backoff/WSPresence/NetworkCircuit before SessionSupervisor (ETS
tables read directly from `Session.Server`'s start path); Bootstrap
LAST (depends on Registry + SessionSupervisor existing). `Grappa.SpawnOrchestrator`
is a top-level boundary module (admission → Backoff.reset → spawn
verb), NOT a supervised child — both Bootstrap and
`NetworksController.connect/2` call into it.

Key invariants — break only with deliberate cause + DESIGN_NOTES entry:
- **One IRC parser, on the server.** `Grappa.IRC.Parser` is the single
  source of truth for IRC framing. `cicchetto` (the web PWA) NEVER parses
  IRC; it consumes typed JSON events.
- **Scrollback is bouncer-owned.** sqlite via Ecto. Schema is
  `(network_id, channel, server_time DESC)`-indexed; a future
  `CHATHISTORY` listener facade (Phase 6) is a mechanical query
  translation, not a redesign.
- **Identifiers (nicks AND channels) are case-folded by ONE
  `canonical_target` fold at every KEY boundary (GH #537, unifying #121
  nicks + #364/#525 channels); wire + display stay RAW.** bahamut
  (Azzurra, all of prod) advertises AND implements `CASEMAPPING=ascii`: it
  folds `A-Z` ONLY, leaving `[ ] \ ~` UNTOUCHED, and folds channels the
  SAME way it folds nicks. The single source of truth is
  `Grappa.IRC.Identifier.canonical_target/1` — the plain byte-level ASCII
  `fold_ascii/1`. A sigil sits outside `A-Z`, so
  `canonical_target("#Chan") == "#" <> fold("Chan")` and a nick folds
  identically: that is WHY #537 collapsed the former sigil-gated
  `canonical_channel/1` AND `canonical_nick/1` into this one function. Its
  query-side SQL twins `Identifier.nick_fold/1` (Ecto fragment) +
  `nick_fold_sql/1` stay plain `lower()`, BYTE-PINNED to the folded-index
  migrations (`network_credentials` / `query_windows` / `notify_entries`)
  — `IdentifierTest`'s pin test fails on one byte of drift (SQLite drops
  an expression index the moment the query string differs). `#chan[1]`/
  `#chan{1}`, `foo[1]`/`foo{1}`, and non-ASCII (`#CAFÉ` vs `#café`) all
  stay DISTINCT (the #525 posture, reversing the #364 over-fold). **Only
  KEYs fold** — never fold `sender`, `dm_with`, the members map, a ban
  mask, or any wire builder (the key/display/wire split). A new identifier
  lookup, equality, or key-derivation MUST fold via `canonical_target/1`
  (or the SQL twins), never a bare `String.downcase` (Unicode-over-folds
  non-ASCII) or `==`, or it silently forks/merges identities. **Channel
  KEYs (the channel pattern):** every channel-keyed table (`messages`,
  `read_cursors`, `network_credentials.autojoin_channels` /
  `last_joined_channels`, archive, `network_featured_channels`) STORES the
  folded channel (fold at write) and every lookup folds then compares
  plain `==`. Channels carry NO display column — **the folded key IS the
  display (option B)** ("as-first-seen" rejected: on rfc1459 `#Foo[1]`
  renders folded anyway). **History stays put (#525):**
  `refold_identifiers_ascii` does NOT rewrite stored channel VALUES — a
  brace-spelled channel keeps its scrollback, a bracket-spelled one starts
  fresh. **Display exception:** `channel_directory.name` is stored verbatim
  (the /LIST spelling), folded only at the featured-label compare
  (`ChannelDirectory.Wire.mark_featured/2`).
- **Per-network CASEMAPPING is normalised at INGRESS only (GH #537 axis
  2).** solanum/Libera advertise `CASEMAPPING=rfc1459`, where `{ } | ^`
  are the lowercase equivalents of `[ ] \ ~` (so `#foo[1]`/`#foo{1}` are
  ONE channel there). Rather than teach `canonical_target/1` + the
  byte-pinned SQL `lower()` three fold tables, `normalize_casemapping/2`
  maps the four national chars ONCE at the ingress door, then every KEY
  path folds `A-Z` via `canonical_target/1`; `canonical_target/2` is the
  composition. **On `:ascii` (all prod) normalize is a no-op**, so
  storage/query are byte-for-byte the pre-#537 fold. Storage + query stay
  pure ASCII; ONLY the three ingress classes normalise, each supplying the
  casemapping from where it reaches the 005: `Session.Server` +
  `EventRouter` from `state.isupport` (`ISupport.casemapping`, `Map.get`
  hot-safe; `fold_key/2`); the stateless web edge (controllers,
  `GrappaChannel` topic join) from `Grappa.Session.casemapping/2` (a
  GenServer call, `:ascii` when no live pid). A folded WRITE forces a
  folded READ compare — including plain-`==` sites no `canonical_*` grep
  surfaces (`channel == own_nick` in `Push.Triggers.dm?`/`Payload`,
  self-window `dm_with == ^channel`) and the raw
  `Repo.update_all(set: channel:)` in `rename_dm_peer`. **Known niche gaps
  (rfc1459-only, out of scope, DESIGN_NOTES 2026-07-30):** a national-char
  DM peer on rfc1459 (`dm_with` RAW + `nick_fold` ASCII, like the
  members-map raw key); the pre-connect autojoin plan folded ASCII before
  005 (rfc1459 + national-char autojoin + invite-only ChanServ misses
  `maybe_request_chanserv_invite`).
- **Nick KEYs fold via the same `canonical_target/1`; the display stays
  RAW (GH #121, #372).** A nick's case IS presentation (`vjt` vs `VJT`),
  so `sender`/`dm_with` are stored RAW and only the MATCH folds — via
  in-memory `canonical_target/1` or its query-side twin
  `Identifier.nick_fold/1` (`lower()`, on a UNIQUE **expression** index,
  NOT a denormalised column). EVERY server-side nick compare routes
  through one of them — visitor + query_windows lookups, the
  WHOIS/userhost/whowas caches, dm_peer, the **DM-peer read + archive
  match** (`Scrollback.where_dm_peer/2`, shared by `channel_or_dm_where/3`
  + `delete_for_dm/3`, and `list_archive/3`'s grouping+exclusion — #372;
  `dm_with` is stored RAW for display, so the MATCH must fold, like
  `query_windows.target_nick`), numeric_router, and event_router
  self-detection. A new nick lookup, equality, or nick-keyed cache MUST
  fold via these, never a bare `String.downcase` or `==`, or it silently
  forks identities. **Out of scope / known gap:** the in-memory members
  map keys + `state.nick` as an identity key stay raw-cased
  (server-consistent identity, not a fold-MATCH site). cic mirrors with
  `nickEquals` — including the INCOMING DM re-key (`subscribe.ts` →
  `canonicalQueryNick`) and the archive-visibility filter (`archive.ts` →
  `normalizeNick`), the client twins of the #372 server fold. **A peer NICK change is an identity MIGRATION, not a fold
  (GH #373).** When `old ≢ new` (a genuine rename, not a casing) EVERY
  store of the old nick moves old→new, folding only to MATCH the old:
  the `query_windows` row (`QueryWindows.rename/4` — UPDATE, or MERGE on
  a fold-collision with an existing `new` window), the DM scrollback
  (`Scrollback.rename_dm_peer/4` — `dm_with` + outbound/orphan `channel`),
  the DM read cursor (`ReadCursor.rename_dm_peer/4` — else the migrated
  history reads fully unread), the per-conversation MUTE
  (`UserSettings.rename_muted_target/4` — nick-keyed since #1038 keyed it
  `(network, peer)`; #1340), and cic's own caches
  (`scrollback.renameScrollbackKey` + `readCursor.renameReadCursorChannel`
  + `selection.followQueryNick`, driven by the per-channel `nick_change`,
  mirroring `members.ts`). Server-driven: `EventRouter` emits
  `{:peer_nick_renamed, old, new}`, `Session.Server.apply_effects/2`
  renames the row (`QueryWindows.rename/4`, no broadcast), migrates the
  DM history + read cursor on `:renamed` only, migrates the mute
  UNCONDITIONALLY (a mute outlives the window it silenced, so gating it on
  the window row would strand it — same posture as the `:unknown` presence
  reset in that arm), and THEN broadcasts
  `query_windows_list` (`QueryWindows.broadcast_windows_list/2`) — the
  broadcast is a truthful "rename fully applied" barrier, so a consumer
  reacting to the event is guaranteed the history has already moved
  old→new (broadcasting mid-migration raced a follow-on
  `Scrollback.fetch`; #373 rename-order fix). A NEW nick-keyed store MUST
  be added to this migration set or a rename silently strands its
  old-nick rows — the set and its one retried transaction live in
  `Grappa.NickMigration` (#1374), not in `Session.Server`. Boundary limit: IRC delivers a NICK only to
  channel-sharing peers, so a query with someone in no shared channel
  cannot follow. **Our OWN nick keys exactly one window — the SELF
  window (`/msg <ownnick>`, GH #948) — and it has its own set** on
  `{:own_nick_renamed, old, new}`: `Scrollback.rename_self_window/4`
  (rows) → `ReadCursor.rename_dm_peer/4` → `QueryWindows.rename/4` →
  `UserSettings.rename_muted_target/4` → broadcast, GATED on a non-zero
  row count (the inverse of the peer arm, which gates on the window) —
  and the mute is INSIDE that gate here, unlike the peer arm, because the
  row count is the only evidence the window is ours (#1340). A window at our old nick is EITHER
  our self window OR a leftover query with a peer who bore that nick
  before us, and the fold-unique index makes those ONE row — only the
  scrollback's `sender` separates them (folded to MATCH; the fold is
  never STORED). **On a SELF row `sender` MIGRATES** (raw new nick),
  unlike a peer's frozen `sender`: all three columns name the same
  person, an UPDATE that does not preserve the shape its predicate
  matches is one-shot (`a→b→a` via GhostRecovery would strand the
  window for good), and `Push.Triggers.own_row?/2` reads `sender` as a
  LIVE identity test. **General rule: a DISPLAY column migrates when a
  consumer reads it as the LIVE identity** — why #514 re-keys the
  own-nick TAG in `channel` (#498), and why a peer's `sender` does not
  move. #514's `rename_own_nick/4` is the sibling that moves the
  inbound-DM own-nick TAG (not a window key), disjoint by the `dm_with`
  conjunct. cic does NOT mirror the self-window rename: the
  `own_nick_changed` event carries neither the old nick nor whether the
  migration ran, so a client mirror would originate state.
- **Read state is server-owned, per (subject, network, channel).**
  Cursor = `last_read_message_id` (FK to `messages.id`). Removing
  server-side cursor is a breaking change. The write cadence (settle
  events), the cic in-pane divider freeze contract, and the Phase 6
  `+draft/read-marker` MARKREAD facade are mechanics, not invariants —
  see `docs/DESIGN_NOTES.md`.
- **`CAP LS` + SASL is the only required upstream IRCv3 feature.**
  Everything else (`server-time`, `batch`, `labeled-response`, etc.) is
  opportunistic. Never assume upstream-side `CHATHISTORY` exists.
- **The client-facing wire contract is versioned + additive-only (GH
  #447).** `Grappa.Protocol` is the SSOT for the wire `protocol_version`
  + `min_protocol_version` (DISTINCT from `Grappa.Version`, the software
  release string — a client keys compatibility off `protocol_version`,
  never the release string). **The WIRE is additive-only:** new frame
  kinds, event types, and fields may appear at ANY time; a
  client MUST ignore verbs/fields it does not recognise
  (unknown-is-never-fatal, BOTH directions — an unknown client verb
  earns a non-fatal error frame and the socket stays open); existing
  fields are NEVER repurposed. **🔴 "…or removed" fell on 2026-08-26
  (vjt's ruling, #1626): removal is no longer NEVER, it is ONLY ON A
  RULING.** One field has been taken back — `row_count` on the archive
  entry (protocol v8) — because emitting it forced
  `Scrollback.list_archive/3` to visit the whole `(subject, network)`
  partition, and no amount of query work buys the complexity class back
  while an exact per-group count is in the shape. The bar that case
  sets, and it is deliberately high: the field must be the thing
  standing between the server and a property it cannot otherwise have;
  the break must be MEASURED on the real client (cic's generated
  `wireSchema` rejects an object missing a required key, so an old
  bundle throws every archive response away) rather than argued; and it
  takes a ruling, not a judgement call inside the slice. Everything
  short of that is still additive-only. **`protocol_version`
  BUMPS ON EVERY WIRE-SHAPE CHANGE, ADDITIVE INCLUDED (vjt's ruling,
  2026-08-21, #1393d — reversing this file's own former "may appear at
  ANY time WITHOUT a version bump").** Two reasons, and the second is
  the load-bearing one. (1) Additivity describes what the SERVER emits
  and says nothing about what a CLIENT requires: the moment a client
  stops tolerating a missing field and starts REQUIRING it, it can no
  longer talk to a server predating that field, and nothing was added
  or removed server-side to express that. The break runs new-client →
  old-server, which is the direction the number exists for. (2) The
  number is only worth comparing against if it is TOTAL — a client
  reading `server >= N` as "has everything N had" is entitled to, and
  ONE un-bumped addition makes that reading false forever after. A
  floor that lies is worse than no floor, because the client believed
  it checked. **Measured, and it is why the rule fell:**
  `@protocol_version` sat at `1` from #447 (2026-07-27) through FIVE
  additive fields (`recoverable`, `inviter`, `list_modes_queryable`,
  `chantypes`, `prefix_order`), every one of which cic later came to
  require. Enforced, not merely written: `mix grappa.wire_pin --check`
  (in `scripts/check.sh` + CI) holds a digest of the generated wire
  shape NEXT TO the version it was taken at, so a shape change with a
  still number is RED — `mix grappa.gen_wire_types --check` cannot host
  this, measured, because it compares the artefact with its own SOURCE
  and answers `in sync.` in exactly the case to catch (DESIGN_NOTES
  2026-08-21). `min_protocol_version` is a DIFFERENT axis and does NOT
  follow the bump: raise it only when old clients can no longer be served —
  the WS handshake then 426s a `?client_proto=` below the floor via the
  endpoint `error_handler` (`UserSocket.handle_ws_error/2`); a below-min
  return is `{:error, :upgrade_required}` (426), an auth failure is bare
  `:error` (403), and the two MUST stay distinct. **Absent
  `client_proto` = current** (existing clients untouched). Unauth `GET
  /api/config` + the user-topic join reply publish the numbers. The
  whole wire is **snake_case** without exception (verified vs
  `cicchetto/src/lib/wireTypes.ts`) — a NEW field MUST be snake_case,
  never camelCase, even when a spec says otherwise. Client-author
  contract: `docs/CLIENT_PROTOCOL.md`; decisions + the deliberate
  casing divergence from #447's text: DESIGN_NOTES 2026-07-27.
- **Phoenix Channels is the streaming surface, not SSE.** Topics are
  user-rooted (per Phase 2 sub-task 2h, for cross-user authz at the
  routing layer):
  `grappa:user:{user_name}`,
  `grappa:user:{user_name}/network:{network_slug}`, and
  `grappa:user:{user_name}/network:{network_slug}/channel:{channel_name}`.
  Single source of truth: `Grappa.PubSub.Topic`. The `phoenix.js`
  client lib handles reconnect + replay. PubSub broadcast + Channel
  push payloads MUST be JSON-encodable — convert structs to wire
  shape via a context-owned `*.Wire` module (`Grappa.Scrollback.Wire`,
  `Grappa.QueryWindows.Wire`). Raw `%Schema{}` structs over PubSub
  crash Phoenix's `fastlane!/1` at the WS edge during fan-out;
  `Jason.Encoder` derive on schemas is NOT enough because the
  schema's wire shape rarely matches the storage shape. Wire
  conversion is per-context responsibility.
- **Window state model lives on the server.** `Grappa.Session.Server`
  owns `window_states %{channel => :pending | :invited | :joined |
  :failed | :kicked | :parked}` + sibling `window_failure_{reasons,numerics}`
  + `window_kicked_meta` maps. **Every LIVE window-state transition
  broadcasts on the USER topic** — `window_pending` / `window_invited`
  (chicken-and-egg states cic must see BEFORE it subscribes
  per-channel) and, since F1 (2026-05-15), the three terminal events
  too (`kind: "joined" | "join_failed" | "kicked"`, via
  `broadcast_window_state/2` → `Broadcaster.to_user/2`), because a
  per-channel broadcast raced cic's own `phx.join` and Phoenix PubSub
  does not replay. The per-channel topic carries window state ONLY as
  the cold-subscribe snapshot — a per-socket `push/3` from
  `push_window_state_if_known/4`, not a broadcast. The per-channel
  topic's OWN traffic is the post-join-handshake set, and its SSOT is
  the `Broadcaster.to_channel/3` call sites — do NOT restate that list
  in prose anywhere, an enumeration of it is what rotted here. A
  third-party client that subscribes per-channel and waits for a live
  `joined` waits forever. cic's `lib/windowState.ts` mirrors via
  `lib/userTopic.ts` (live) + `lib/subscribe.ts` (snapshot) dispatch. `:invited` (#78) is a
  not-joined greyed tab opened by an inbound INVITE we didn't request —
  see DESIGN_NOTES 2026-06-28. cic NEVER originates state — no
  optimistic STATE assumptions, no parallel client-side state
  machine. Adding a new state (e.g. SASL-gated `:locked`) requires
  server changes; cic just mirrors. The cic-side
  `windowStateByChannel` store is the AUTHORITATIVE sidebar
  projection key — `channelsBySlug` feeds into it but is not the
  sole source. New states automatically inherit synthetic-row +
  greyed-class treatment as long as they land in
  `windowStateByChannel`.

## Tech Stack

- **Elixir 1.19 + Erlang/OTP 28** — pinned in `.tool-versions`.
- **Phoenix 1.8** + **Bandit** — HTTP server + WebSocket Channels.
- **Ecto 3 + ecto_sqlite3** — persistence.
- **Own IRC client** (`lib/grappa/irc/`) — binary pattern matching.
  `exirc` was rejected (stale on hex). The parser is reused for the
  Phase 6 IRCv3 listener facade.
- **Tooling:** Dialyxir + Credo (strict) + Sobelow + mix_audit + doctor +
  Boundary + ExUnit + StreamData + Mox + Bypass + ExMachina +
  excoveralls + observer_cli + recon.

Operator dispatcher (`bin/grappa`), developer scripts (`scripts/*.sh`),
hot vs cold deploy preflight, per-host compose overrides, runtime data
(DB / migrations / logs / config), monitoring — all in **`docs/OPERATIONS.md`**.

## Engineering Standards

These rules carry across all sessions. They override the temptation to
copy whatever pattern is closest in the codebase. **Read the directions,
not the surrounding code.**

### Foundation rules

- **Challenge the spec.** If domain knowledge contradicts the
  requirements, say so before building. A 30-second question costs
  nothing. Building the wrong thing costs hundreds of commits.
- **Directions over code.** This file + `docs/DESIGN_NOTES.md` are
  the authority. If existing code contradicts
  them, the code is wrong — flag it to vjt, don't copy the divergent
  pattern. Every session starts with zero memory; the codebase will
  tempt you to copy whatever pattern is closest. Resist. **This applies
  to plans and specs too.** When copying an existing pattern into a
  design, evaluate it against this file first. A bad return type doesn't
  become good by being in the spec — the spec inherited a bug.
- **Ask before building.** Before implementing anything substantial:
  (1) Does the infrastructure already provide this? (2) Is there a
  10x simpler approach? (3) Will this still exist in two weeks?
- **LESS CODE IS BETTER CODE (vjt, 2026-09-11).** Deleting old and
  useless code is the work, not a side quest. A branch that a change
  renders dead goes away in the SAME commit — not commented out, not
  kept "just in case": git remembers it. A refactor is expected to end
  with LESS code as well as a better architecture; one that ends with
  more owes an explanation. **The pruning is for DEAD code only.**
  Input validation, security checks and test assertions are never
  "excess code": see "Ecto.Changeset for ALL user input" below, and no
  assert gets weakened to turn a red green.
- **Design discipline.** Before proposing recovery mechanisms,
  tracking structures, or escalation ladders:
  (1) Don't duplicate state that already exists — derive it. Every
  parallel structure needs housekeeping that will drift.
  (2) Think about the general problem, not the specific incident
  that triggered the design. No tunnel vision.
  (3) Optimize for all general cases with room for edge cases.
  (4) Lightweight over heavyweight. If the mechanism is heavier
  than the problem, the mechanism IS the problem.
  (5) Think it through before proposing. Consider all dimensions
  (existing state, lifecycle, constraints, redundant work) THEN
  present. Don't make the human iterate half-baked proposals.
  (6) Reuse the verbs, not the nouns. When a second use case fits 80%
  of existing infrastructure, ask "what are the 20% that don't fit?"
  Those 20% are the domain boundary. Shared execution framework =
  good reuse. Shared data model with a type flag = boundary violation.

### Investigation discipline

- **Debug with data first**: read logs (`scripts/monitor.sh`), inspect
  runtime state (`scripts/observer.sh` or `:sys.get_state(pid)` in IEx),
  query the DB (`scripts/db.sh`) before changing code. NEVER guess.
  NEVER change code speculatively. Evidence first.
- **Never fabricate explanations.** If you don't know why something
  happened, say "I don't know, let me check" and read the code or
  logs. A confident wrong explanation is worse than admitting
  ignorance — it wastes time and erodes trust.
- **Debugging tools are infrastructure**: when you need to inspect
  system state, build an HTTP endpoint or `Phoenix.LiveDashboard`
  metric — not a throwaway IEx script. Endpoints are reusable, remotely
  accessible, tested, and survive across sessions.
- **One feature, one code path, every door.** New data = context
  function → controller → channel event. Same logic, three access
  methods. Channels are not a separate state model from REST; they
  push the same domain events.

### Code-shape rules

- **Read before writing.** Before editing any file, read its sibling
  modules and existing patterns. Grep for what you're about to build —
  it probably exists.
- **Implement once, reuse everywhere**: if two places need the same
  logic, refactor to share it. Never copy-paste with tweaks.
- **Use infrastructure, don't bypass it.** Going around the established
  path "just this once" loses observability (Logger metadata, telemetry,
  PubSub broadcasts). If the infrastructure doesn't support what you
  need, extend it.
- **No leaky abstractions**: each context owns its domain. Return
  domain types (`%Grappa.Scrollback.Message{}`, not `map()`). If the
  architecture doesn't support what you need, fix the architecture.
- **Consistency**: same problem, same solution. Plans must read this
  file FIRST — if a plan conflicts with a documented pattern, fix the
  plan.
- **Atoms or `@type t :: literal | literal` — never untyped strings**
  for closed sets. Message kinds (`:privmsg | :notice | :action`),
  network states, etc. all live as types or atoms-in-allowlist. Reject
  unknown values at the boundary.
- **Total consistency or nothing.** Half-typed is worse than untyped.
  Half-migrated creates two patterns — Claude copies whichever is
  closer. If migrating, migrate ALL instances. No exclusion lists, no
  "Phase 2 later." The codebase IS the instruction set — whatever
  patterns exist, Claude will propagate.
- **State the contract**: signature + failure mode in one sentence
  before implementing. "`@spec foo(integer()) :: {:ok, t()} |
  {:error, :not_found}`" — write the spec FIRST.
- **Fix root causes, not examples**: no band-aids. A bug report is one
  instance of a broader class — find the general rule.
- **Dialyzer warnings are design signals.** When Dialyzer flags a
  type mismatch, ask WHY — the constraint is probably correct, your
  approach is probably wrong.
- **No default arguments via `\\`**, except for genuine config defaults
  where the default is the correct production behavior. Default
  arguments create silent degradation paths. Every new function MUST
  require all parameters explicitly. When touching existing code that
  uses defaults, REMOVE them.
- **Recursive pattern match over `Enum.reduce_while/3` for
  collect-or-bail traversal.** When mapping a function across a list
  with success-extends-acc / error-returns-immediately semantics, write
  the three-clause recursive shape — it's tail-recursive, declarative,
  and avoids the `{:ok, acc}` wrapper + pipe-to-case afterthought:

  ```elixir
  defp traverse(list, fun), do: traverse(list, [], fun)
  defp traverse([], acc, _), do: {:ok, Enum.reverse(acc)}
  defp traverse([h | t], acc, fun) do
    case fun.(h) do
      {:ok, item} -> traverse(t, [item | acc], fun)
      {:error, _} = err -> err
    end
  end
  ```

  `Enum.reduce_while/3` is still right for genuine fold-with-early-exit
  (search-with-state, accumulate-until-threshold) where the accumulator
  carries computed state across iterations. For pure collect-or-bail,
  it's overkill.
- **IRC stays text only.** No inline rendering of media types in
  scrollback (images, videos, audio, link-unfurl previews). Media
  URLs in PRIVMSG bodies are clickable links via the existing
  `linkify` path; clicking opens the resource in a browser tab. Do
  not propose in-scrollback thumbnails / autoplay / preview cards /
  lightbox-on-arrival without an explicit cluster spec lifting this
  rule. The image-upload pattern ships a 📸-prefixed URL that is
  text on the wire and a clickable link in cic — that is the model.
- **Bite-sized commits**: one logical change. Messages explain WHY.
- **🔴 NEVER give the `DESIGN_NOTES.md` entry separator its own commit.**
  The `\n---\n\n` that opens an entry goes IN the same commit as the entry
  it belongs to — always, including when you are repairing a lost one.
  **Why: a separator-only commit is three lines identical to three lines
  already on main, so `git rebase` computes the same patch-id and DROPS it
  as already-upstream — no conflict, no warning, no `dropping` line.** Three
  confirmed occurrences across two workers, each losing exactly three lines
  (73→70, 79→76, 95→92), and a lone restoration commit is eaten the same
  way, which is why folding is the cure and not a preference.
  **Verify, never eyeball: keep the branch's contribution `--numstat` in a
  FILE before every rebase and diff it against the post-rebase one** — the
  test is two-sided (additions unchanged AND deletions zero) — **then read
  the BOUNDARY SHAPE on the real file** (full stop / blank / `---` / blank /
  heading), because an identical numstat proves nothing when the pre-rebase
  state was already broken.
  **🔴 TWO-SIDED means BOTH directions are failures, not just loss (#1432).**
  Additions going **DOWN** is the driver EATING a separator; additions going
  **UP** is it RESURRECTING text the base deliberately deleted — `merge=union`
  takes the additions from both sides and never the deletions, so a branch
  that predates a removal gets it back, glued wherever it lands. Measured:
  **131 of 1001** DESIGN_NOTES commits on main delete text, and for **30 of
  those 131 (22.9%)** a tail-appending branch forked just before would
  resurrect it. Both modes report `rc=0`, zero conflicts and zero deletions.
  `scripts/union-rebase.sh` is that ritual automated — it pins, rebases,
  re-pins and compares. **It is a VERB and not a check in
  `design-notes-gate.sh` on purpose:** after a rebase the merge base collapses
  onto the base ref and the only state recording that a line was ever deleted
  is gone (measured: 2 such lines visible pre-rebase, 0 post), so the detector
  needs a BEFORE and an AFTER and the gate has neither.
- **🔴 Open every new DESIGN_NOTES entry with a UNIQUE `<!-- entry #NNNN -->`
  line, as its FIRST appended line (#1271).** Exact shape: marker / blank /
  `---` / blank / `## <date> — #NNNN: …`, with NO blank before the marker.
  **Why: the separator loss above is not bad luck, it is `merge=union` doing
  what it is told.** Every entry used to be appended with the same three
  leading lines, so the merge machinery aligned that identical prefix as a
  COMMON addition and only the diverging tails reached the driver, which
  emitted the shared prefix once. A marker line differs between branches, so
  there is no prefix left to collapse and both separators survive — measured,
  losing not one line, whereas putting a blank ahead of the marker still costs
  that blank and a duplicated marker costs FOUR lines instead of three. A
  marker on EITHER side protects the pair, so old entries need no retrofit.
  Enforced by `scripts/design-notes-gate.sh` over the entries a branch ADDS,
  in CI and in `scripts/bats.sh`; the same gate treats an added `^## ` as an
  ENTRY heading, so a subsection inside an entry must be `###` or deeper.
  **UNIQUE has two scopes, and the second is the one that bites (#1428):
  unique in your file, AND unique against what `origin/main` carries NOW.**
  One issue producing several entries needs distinct suffixes (`#1404a`,
  `#1404b`, …) — and the suffix must be chosen against the base's CURRENT
  content, not the base you branched from, because **a rebase is exactly when
  a previously-unique marker stops being unique**. A marker the base already
  carries restores the identical prefix the convention exists to destroy, and
  costs **FOUR** lines instead of three — one MORE than no marker at all,
  since the marker collapses together with the separator block it was added
  to protect. The gate checks this against the base ref's TIP; the collision
  does not exist at the merge base, so checking there sees nothing.
- **Log honesty**: when a fast path skips work, the log message must
  describe the state it OBSERVED, not the absence of work. Example:
  `bootstrap: no credentials bound — running web-only` lies when N
  credentials exist but all are `:parked` or `:failed`. The honest
  line reads `0 credentials in :connected state (N parked, M failed)
  — running web-only`. General rule: fast paths state what they
  observed, not what they did. If your fast path is "skip because
  input was empty," check WHY it was empty before logging the skip —
  the empty input is often a different bug surfacing at the wrong
  layer.
- **DB state and live state are separate sources of truth.** Every
  admin resource listing MUST combine both, and `live_state: null` is
  the honesty signal that something diverged — don't paper over
  with computed-from-DB fields.
  `Grappa.Networks.Credential.connection_state` is the DB-canonical
  state; `Grappa.Session.whereis/2` is the live-pid truth. They can
  disagree: a `:connected` credential whose `Session.Server` crashed
  mid-restart; a `:parked` credential whose pid is in respawn backoff;
  a row STILL reading `:connected` whose process is already in
  `terminate/2`, because `Networks.disconnect/2` and `mark_failed/2`
  both stop the session BEFORE writing the transition. The closed set
  is `[:connected, :parked, :failing, :failed]` (#1675) — there is no
  `:disconnected` state (the `:disconnected` in `session_log_events` is
  a lifecycle EVENT, a different axis).
  **🔴 `:connected` means REGISTERED UPSTREAM, not "a session process is
  alive" (#1675).** Until then it meant the latter, and that is exactly
  the lie: `Networks.connect/1` writes `:connected` on SPAWN success (the
  U-0 ordering, correct as far as it goes — see #642), and three prod
  networks that never completed registration read `connected` for hours
  because nothing walked the row back. `:failing` is that missing state —
  "the session process is alive and the reconnect backoff is running, but
  the upstream link is not registered" — written by the NON-terminal
  `Networks.mark_failing/2` with the actual cause in
  `connection_state_reason` (`IRC.Client.describe_connect_failure/1`, never
  a category label), reversed by `mark_registered/1` on 001 RPL_WELCOME,
  and reached from `Session.Server` only through the injected
  `link_state_reporter` closure → `Networks.report_link_state/3` (the ONE
  subject-polymorphic door; the drift has no subject branch, so visitors
  are in scope by construction). `:failed` stays TERMINAL and unchanged:
  `mark_failed/2` stops the session BEFORE the transition, so a
  `:failed → :connected` edge on 001 can never fire — which is WHY this is
  a fourth value and not a reason string on `:failed`. Boot resumes
  `:failing` and still skips `:failed`
  (`Credentials.list_credentials_for_all_users/0`), else a reboot inside a
  backoff window drops the network permanently. **Known gap, not a bug to
  rediscover:** a socket that CONNECTS but never registers (blocked rDNS,
  ident hang) emits no `irc_connect_failed`, so it still reads
  `:connected` — there is no registration watchdog, deliberately. A new
  reader of `connection_state` MUST decide which fact it wants and say so;
  a liveness check is `Grappa.Session.whereis/2`, not this column.
  `AdminSessionsTab` surfaces BOTH columns and shows an explicit
  `null` when the live pid is gone — diagnostic value beats false
  uniformity. When adding a new admin listing, return both
  projections; never compute one from the other to "tidy up" the
  response shape.
- **No silent-swallow at boundaries.** Two failure modes share one
  root: (a) a controller helper that wraps an ok-or-error
  orchestrator and throws the error away while returning ok (e.g.
  DB row at `:connected`, no live Session.Server, REST writes 404
  silently); (b) a wide `try`/`catch` exit-clause in a long-lived
  process (e.g. `Session.Server.terminate/2`) that absorbs an
  exception class which "shouldn't happen" and so hides the next
  bug to fall into it. Both share the lesson: the operator (or CI)
  MUST see the failure. Fix at the boundary that raised (return
  `{:error, _}` and propagate via `with`/FallbackController); never
  widen the catch to swallow more. A safety net that catches an
  impossible exception silently absorbs the next class of bug.

### OTP patterns (Elixir-specific)

- **GenServer when** state must persist between calls AND callbacks
  must be serialized. Mailbox is the synchronization primitive.
- **Task when** there's a one-shot async unit of work. `Task.async` +
  `Task.await` for promise-shape. `Task.start_link` (linked) +
  `restart: :transient` for fire-and-forget under a supervisor.
- **Agent when** state is shared but doesn't need behaviour. Almost
  never the right call — prefer GenServer for explicit message
  contracts.
- **Registry for named processes**, NEVER `Application.put_env` for
  runtime state. `{:via, Registry, {Grappa.SessionRegistry, key}}`
  for unique-key lookup; `:duplicate` keys for pubsub-style fan-out.
- **DynamicSupervisor when** processes are spawned at runtime (one
  per user, one per channel, etc.). Plain `Supervisor` only for
  static children declared at boot.
- **Let it crash** is the rule for unexpected errors. `try/rescue`
  ONLY when you can recover meaningfully (network timeout retried,
  malformed input rejected at boundary). Otherwise let the
  supervisor restart with fresh state. Defensive programming hides
  bugs.
- **Crash boundary alignment**: a session GenServer crashing should
  reset only that session's state. Don't put cross-session state in
  the session GenServer. Don't put per-user state in
  `Phoenix.Endpoint`.
- **Restart strategy:**
  - `:permanent` for infrastructure (Repo, Endpoint, PubSub).
  - `:transient` for per-user sessions (restart on abnormal exit,
    don't restart on `:normal` shutdown).
  - `:temporary` for one-shot tasks (don't restart at all).
- **Process state stays small.** Anything that must survive a crash
  goes in Ecto, not GenServer state. GenServer state is "what I need
  to do my next message" — not the source of truth.
- **`Application.{put,get}_env/2`: boot-time only, runtime banned.**
  Allowed at boot-time configuration boundaries: `config/*.exs`,
  `lib/grappa/application.ex` start/2 (the documented exception), and
  inside mix-task helpers BEFORE `Application.ensure_all_started/1`.
  Banned at runtime — neither read nor written from any GenServer
  callback, controller, context function, plug body, or release task.
  Pass config via `start_link/1` opts; the supervisor reads env at
  boot and injects. Lets tests substitute values without runtime
  config tricks. **Non-process DI-seams** (stateless resolver modules
  reached from controllers / context fns / hot paths — no `start_link`
  of their own) use the sibling boot boundary instead: a `boot/0`
  called from `application.ex` `start/2` reads env ONCE into
  `:persistent_term`; the runtime resolver reads
  `:persistent_term.get(key, default)` (the default preserves any
  hot-deploy graceful-degradation contract); tests inject via a
  `Mix.env() == :test`-gated `put_test_*/1` helper. Precedent:
  `Grappa.Admission.Config`, `Grappa.Uploads`, `Grappa.HttpHosts`,
  `Grappa.Push.BadgeSource` / `WindowCounts.PushSource` /
  `Themes.BackgroundImage` (#364 J/cross-module-S2). `start_link` opts
  is for GenServers; `:persistent_term` is for everything else — never
  a per-call `Application.get_env/2`.

### Phoenix / Ecto patterns

- **Contexts at `lib/grappa/<context>.ex`.** Schemas live as
  `lib/grappa/<context>/<name>.ex`. Public API on the context module;
  schemas internal. Boundary library enforces.
- **A boundary that needs only a SCHEMA declares the schema, not the
  context — promote the schema to its own boundary (`use Boundary,
  top_level?: true`, #1398 / #1399).** Declaring `Grappa.<Context>` to
  name one struct also hands the consumer every exported verb, and the
  checker then has nothing to say about a call nobody meant to allow —
  measured, not argued (#1521, `03e7254b`): `Accounts.get_user!/1`
  inserted into `Grappa.Subject` compiles GREEN while `Subject` declares
  the whole `Grappa.Accounts`, and RED once it declares
  `Grappa.Accounts.User` alone. The leaf's OWN `deps:` is measured from
  ITS outbound edges, not assumed empty — `Accounts.User` is `[]`,
  `Accounts.Session` is `[Grappa.Subject]`, `Networks.Credential` is
  `[Grappa.IRC, Grappa.Subject]`. **Second half: often the right move
  is to declare NOTHING, because the reference carries no edge.**
  `belongs_to :x, Mod`, `field :x, Mod` and `Mod.t()` in a typespec are
  module atoms in metadata, so the xref checker never sees them — why
  `Networks.Credential` aliases `Accounts.User`, `Visitor` and
  `EncryptedBinary` and declares none of them. `from(s in Mod)` in an
  Ecto query IS an edge: declare-nothing does not compile there, and
  that is why `Admission` and `Vhosts` had to narrow to the leaf rather
  than drop the dep. **Verify with the COMPILER.** Boundary is wired
  into `compilers:` (`mix.exs`), so `mix compile --force
  --warnings-as-errors` IS the check and enumerates the blast radius
  for you; **there is no `mix boundary.find_violations` task in
  boundary 0.10.4** — don't go looking for one. Measure under
  `--env=test` as well: `MIX_ENV=dev` never compiles `test/support`, so
  a dev-only run under-counts by exactly the test-support boundaries,
  silently. **Carve-out, accepted knowingly (vjt ruling, 2026-08-20):**
  the promoted leaf keeps its `Grappa.<Context>.<Schema>` name while
  being a SIBLING of `Grappa.<Context>` in the graph. Boundary's own
  docs call that namespace/model mismatch discouraged and offer a
  rename instead; we decline the rename — it moves files and renames
  modules, which means beams disappearing and a COLD deploy, to buy a
  naming nicety. Nothing breaks (Boundary still compiles, no runtime
  effect); the price is a reader guessing the wrong owner from the
  name. **A promoted identity or FK schema is a deliberate carve-out,
  not a context internal** — that is the rule, not a smaller count of
  nested `top_level?: true`.
- **Controllers thin, contexts thick.** Controller responsibilities:
  parse params, call context, render. Logic lives in the context.
- **`FallbackController` for `{:error, X}` returns.** Don't `case` on
  results in every action.
- **Ecto.Changeset for ALL user input.** Never `Repo.insert/2` with a
  raw map you didn't validate. Validate at the boundary.
- **Migrations are idempotent.** Use `create_if_not_exists` only when
  rebuilding from scratch is meaningful; otherwise plain `create` so a
  drift between migrations and schema is a loud error.
- **🔴 GENERATE migrations with `mix ecto.gen.migration <name>` — NEVER
  hand-write the timestamp.** Every migration on main carries a round
  hand-typed stamp (`…120000`, `…130000`, `…100000`), some dated in the
  future, and that is how #1044 and #1038 came to claim the SAME version
  `20260810120000` with different basenames. **Git fuses two such files
  without a word** — different names, no conflict marker, nothing to
  review. A generated stamp is UTC-to-the-second and effectively cannot
  collide. **On a rebase, re-check the version against `origin/main`'s
  latest**: the correct number is past whatever landed while you were out,
  not past the main you branched from.
  **Why it matters more than tidiness — measured in Ecto's own source:**
  the pending filter (`migrator.ex:647`) keys on the integer VERSION, never
  the filename, and `ensure_no_duplication!` (`:708`) only ever sees the
  PENDING set (`:456`). So a duplicate version has three regimes: on a fresh
  DB it raises `Ecto.MigrationError` (loud, fine); **on a DB that has ALREADY
  APPLIED that version, BOTH files drop out of pending, `ensure_no_duplication!([])`
  answers `:ok`, the run reports SUCCESS and neither migration ever runs —
  permanently, since the version is already in `schema_migrations`**; and the
  hot preflight (`hot_reload.ex:164`) dies on `[path] = Path.wildcard(…)`.
  The silent regime is the dangerous one, and it is the one production hits.
  ⚠️ **A deploy preflight must therefore compare migration VERSIONS against
  `schema_migrations`, never count pending files** — a pending count of zero
  is exactly what the silent regime produces.
- **🔴 A dirty NIF parked on a SQLite write-lock wait blocks every
  `persistent_term` write and every module load in the VM, for the whole
  wait (#1715).** The window is `busy_timeout` — **per-env, and
  `config/runtime.exs` is the SSOT: do not restate the value here, it
  moves** — while the 133 s seen in `lock_watch_test` is that file's own
  `@waiter_budget_ms`, **never** a production number, and quoting it as
  one is the mistake this line exists to stop. For the field scale, cite
  a DATED measurement instead of a live knob: the 29 holds logged on
  2026-09-08 ran 31.1–94.1 s. **What blocks:** *every*
  `persistent_term:put/2` and `erase/1` — **word-sized ones too**, which
  trigger no global GC of their own but queue behind somebody else's, and
  the shipped docs do not lead you to expect that; *every* **module's
  first log line** (`logger_config:allow/2:67` **is** a put); and *every*
  **module load** — that is, every module **not yet loaded**, since an
  already-loaded one short-circuits in `code:ensure_loaded/1` and never
  reaches the code server.
  **⚠️ The module-load leg does NOT reach the release, and a retracted
  number used to say it did (#2003).** This paragraph claimed *"2464 of
  3063 modules are still cold (80 %), 265 of `Grappa.*` alone, because
  the release runs `:interactive` and its `vm.args` sets no `-mode`"*.
  **The release runs `-mode embedded`** — read on the live node
  (`RELEASE_MODE=embedded` in pid 45683's environment, `procstat -e`) and
  derivable entirely off-prod: the repo ships no `rel/`, so the generated
  `bin/grappa` supplies the flag from its OWN default
  (`RELEASE_MODE="${RELEASE_MODE:-"embedded"}"`, line 31) and
  `RELEASE_MODE` appears **0 times** anywhere in the repo. The `vm.args`
  half was true; the conclusion drawn from it was not, because the flag
  comes from the start script and not from the args file.
  🔴 **The census is DELETED, not re-measured**, on three grounds: nobody
  recorded which node produced it (an unsourced number gets cited as
  measured by the next reader); it cannot describe this substrate
  (`releases/<vsn>/start.script` carries **317** `Elixir.Grappa*` modules
  inside `primLoad`, all loaded at boot under embedded); and a *correct*
  re-measurement would still be the WRONG EVIDENCE for the rule it was
  supporting — module residency and Logger-cache residency are different
  axes. **A rule may not cite a number that does not measure it.**
  **🔴 The rule STANDS, on the other leg, and never depended on `-mode`:
  a module that may log DURING a write-lock wait buys its Logger cache
  key at boot** (`LockWatch.prime_logger_module_cache/0`, #1731) — the
  observer whose job is to report the wait is otherwise its own
  casualty. Embedded mode loads CODE; it does not populate Logger's
  per-module cache, so a preloaded module that has never logged still
  owes its `persistent_term:put` on its first line. That leg holds on
  every substrate. The module-load leg is live only where the node really
  is interactive — docker/dev's `mix phx.server`, `iex -S mix` — which is
  also the likeliest provenance of the deleted census. **Name the
  observers; never blanket-prime.** Not for cost — blanket priming
  measures sub-millisecond, five orders below the bug — but for **scope**:
  the modules that must log under contention are enumerable (they live
  around the Repo), and priming the whole tree is unfalsifiable
  maintenance that will drift (design-discipline (1) and (5)). The
  mechanism is measured in the field and **never reproduced on a bench**;
  its final causal link is **inferred**, not measured. Measurements, the
  2×2×2 and the three retractions: DESIGN_NOTES 2026-08-24; the embedded
  correction and the census retraction: DESIGN_NOTES 2026-09-08.
- **Sandbox per test (`async: true`).** Never share sandbox across
  tests. `use Grappa.DataCase, async: true`.
- **PubSub topic naming: `grappa:` prefix mandatory.** Topics are
  user-rooted: `grappa:user:{user_name}`,
  `grappa:user:{user_name}/network:{network_slug}`,
  `grappa:user:{user_name}/network:{network_slug}/channel:{channel_name}`.
  Single source of truth: `Grappa.PubSub.Topic`. Don't introduce
  sibling prefixes; future Phase 6 listener may need to share topics
  with the REST surface.
- **Phoenix Channels = the event push surface.** REST is for resources
  (channels, messages, networks). State changes broadcast over
  Channels via `Phoenix.PubSub.broadcast/3`. Don't poll REST for
  updates from a connected client.
- **Admin endpoints go through the `:admin_authn` pipeline.** When
  adding a `/admin/<resource>` route under
  `scope "/admin", GrappaWeb.Admin`, mount it on
  `pipe_through [:api, :authn, :admin_authn]`. The `:admin_authn` plug
  (`GrappaWeb.Admin.AuthPlug`) requires
  `current_subject = {:user, %User{is_admin: true}}` and 403s every
  other subject shape — don't bypass it with per-controller checks or
  skip-the-plug shortcuts. Distinct from the loopback `:admin`
  pipeline (which gates `/admin/reload` + `/admin/cic-bundle-changed`
  on `Plugs.LoopbackOnly`); same URL prefix, separate scopes.
  **No nginx allowlist to maintain (GH #485).** Every nginx that
  survives is a dumb reverse proxy (`infra/snippets/locations-api.conf`,
  `location / → BEAM`) — it forwards `/admin/*` unfiltered, so a new
  `/admin` route needs NO proxy edit. Two substrates have no nginx at
  all: Docker since #485, and the m42 bastille jail since its nginx was
  deleted (the HOST vhost proxies straight to the jail BEAM on :4000) —
  there the BEAM gates are the ONLY gates, by construction. The gate is
  BEAM-side only:
  `:admin_authn` (bearer + `is_admin`) for the cic-facing routes and
  `Plugs.LoopbackOnly` (real client IP via `RemoteIpFromProxy`) for the
  loopback ones. The old snippet allowlist that used to keep new routes
  from being auto-exposed through the proxy was deleted with the nginx
  container in #485; the Docker single-container prod path never had one.

### Charset / wire-format rule

- **IRC is bytes; the web is UTF-8.** Convert at the boundary, not
  inside business logic. The Ecto schema stores `body :string` as
  Elixir-canonical UTF-8. The IRC parser handles incoming bytes;
  output to upstream is encoded back to bytes at `IRC.Client`.
- **CTCP control characters (`\x01`) are preserved as-is** in the
  scrollback `body`. Don't strip them — round-trip fidelity matters
  for `ACTION` and other CTCP verbs.
- **Never assume ASCII.** Nicknames, channel names, message bodies are
  all potentially UTF-8. Use `String.length/1` only when you mean
  graphemes; use `byte_size/1` for IRC framing limits.

### Testing Standards

**How to RUN tests is in `docs/TESTING.md`** — single canonical
runbook for `scripts/test.sh`, `scripts/check.sh`,
`scripts/bun.sh run test`, `scripts/integration.sh`, e2e
cascade-vs-flake triage, gotchas, and `--repeat-each` iso-rerun
discipline. Don't duplicate test-running commands here; this
section is RULES, that file is HOW.

- Assert outcomes, not call sequences. Ask: "If the implementation were
  wrong, would this test catch it?" If not, the test is a mirror.
- **Never assert buggy behavior.** A test that encodes a bug prevents
  anyone from finding the bug.
- **Mock at boundaries (Mox), real dependencies inside.** Sandbox the
  Repo. `Bypass` for HTTP stubs. The `Grappa.IRCServer` test helper is
  an in-process fake IRC server for session tests — use it, don't mock
  `:gen_tcp` directly.
- **Use production code in tests** — never hardcode strings or
  re-implement logic. If a test needs formatted output, call the
  production formatter.
- **Never weaken production code to make tests pass.** If a test needs
  special setup, fix the test — don't add optional parameters or
  bypass paths to production code.
- Mock data must be realistic — empty structs, missing required fields,
  and zero-length strings cause tests to pass while validating nothing.
- **Property tests via StreamData** for any function with non-trivial
  input shape (parser, pagination boundary, etc.).
- Zero warnings. `mix test --warnings-as-errors` is the only way.
- Test helpers mandatory; names = scenario + outcome.
  (`"GET /messages?before=cursor returns descending page"`).

### Architecture tests

- Use `Boundary` annotations — not string-matching.
- Don't test that `Foo` calls `Bar.baz/1` (implementation detail).
  Test that `Foo` exposes the right boundary contract.

## Session Protocol

### At Session Start

Use `/start` to run the full session-start protocol. It reads the
codebase-review gate, the active checkpoint, todo, and produces a
status report. Full protocol in `.claude/skills/start/SKILL.md`.

### Reviews

Codebase reviews are enforced every 12 sessions or 2 weeks. They cover
code quality, architecture, and trajectory. See
`docs/reviews/codebase/` for past reviews.

### When Asked "What's Next?"

Run `/start` — it checks everything including whether a codebase review
is due. Don't just look at todo.md.

### Development Cycle

0. **Worktree first.** Multiple sessions run concurrently. All code
   changes go in a worktree branch, never main directly. Docs-only
   changes (checkpoints, todo) may commit to main.
   **CRITICAL: `git checkout main` FIRST, then create the worktree.**
   If you're on a feature branch, the worktree branches from THAT
   branch, not main. **Branch from local main, NEVER origin/main.** Local
   main has unpushed commits. Branching from origin loses recent work.
   **Rebase before merge.** Before merging a worktree branch to main,
   rebase it onto main first: `git rebase main` from the worktree.
   **Remove the worktree at merge — not someday.** A worktree is opened
   here (step 0) and MUST be closed at the merge (step 3): once its
   branch is merged to main, remove the worktree
   (`git worktree remove <path>`) and delete the merged branch
   (`git branch -d <branch>`) as PART OF the merge step, never a
   deferred cleanup. Never leave merged worktrees lying around — dozens
   accumulated on the worker host and ate real disk before #296 swept
   them. If `git worktree remove` trips the submodule error, `--force`
   is safe ONLY once the branch is proven merged (`git branch --merged
   main`) AND the worktree is clean (`git status --porcelain` empty).
1. **Fix pre-existing errors first.** Before starting any work, run
   `scripts/check.sh`. If there are existing failures, fix them in the
   first commit. Zero errors is the baseline. NEVER dismiss errors as
   "pre-existing, not from my changes."
2. Design → Implement (TDD: failing test FIRST) → Test → Type check
   (Dialyzer) → **Format** → **Credo** → **Sobelow** → **Commit** →
   **Code review** → Fix → Commit → **Update docs** → **Merge** →
   **Deploy** → Health check → Update checkpoint.
   Code review is NEVER optional.
3. **Merge BEFORE deploy, push BEFORE prod.** Prod is the **m42
   bastille jail** — `scripts/deploy-m42.sh` (server, auto hot/cold)
   / `--cic` (bundle only). The jail pulls origin/main, so: rebase
   worktree onto main → merge to main → remove the now-merged worktree +
   delete its branch (step 0) → **bump the repo-root `VERSION` file as the
   LAST commit** → tag → push origin main → deploy-m42 → verify health. The
   bump rides IN, never after — and **the tag must exist BEFORE the build**,
   because `Grappa.Version`'s git facts are a compile-time snapshot: build
   first and prod reports the unreleased form `X.Y.Z-<sha>` instead of the
   bare `X.Y.Z` that #391's tag-≡-CTCP-VERSION contract promises.
   🔴 **A `VERSION`-only bump is HOT on every substrate (issue 2057,
   2026-09-10) — reversing what this file said from 2026-08-10, which was
   true of the code as it then stood.** It WAS cold, and the reason was one
   coupling: `mix.exs` read `VERSION` to stamp the OTP application vsn, and
   that vsn is the only thing that puts a number into a release's code path,
   so a bump wrote the fresh beams to `lib/grappa-<new>/ebin` while
   `Grappa.HotReload.reload_modified/0` kept walking `:code.lib_dir(:grappa)`
   — the RUNNING node's BOOT directory `lib/grappa-<old>/ebin`. Nothing there
   changed, `/admin/reload` answered `{"failed":[],"reloaded":[]}`, and prod
   served the old number under new code for ~6.5h on 2026-08-13.
   **The app vsn is now the frozen `@otp_vsn` constant in `mix.exs`**: the lib
   directory never moves, the beams land where the node already looks, and the
   round trip is measured end to end on a real `mix release` with a live node
   (bump → `/admin/reload` 200 reloading `Elixir.Grappa.Version` →
   `/api/config` on the new number, no restart). `Preflight`'s `version`
   class (#1287) is GONE with its cause.
   🔴 **Two constraints survive the freeze, and both are silent when broken.**
   (1) Do NOT re-hardcode `@version` in `mix.exs` — it must keep reading
   `VERSION` at build time; re-inlining a literal makes the bump edit
   `mix.exs`, which is COLD via `mix_deps?`. (2) Do NOT give the release a
   `version:` of its own under `releases:` — it MUST inherit the frozen app
   vsn, because `HotReload.audit_code_path/1` compares the booted app vsn
   against the release vsn in `start_erl.data`, and a frozen one beside a
   tracking one diverges forever: measured as a permanent
   `409 {"booted":"0.0.0","built":"1.5.6"}`, the cure inverted into a total
   silent refusal of every hot deploy. Both are pinned by
   `version_single_source_test.exs`. Invoke deploy scripts by ABSOLUTE
   path (`/srv/grappa/scripts/…`) — cwd drift runs another
   checkout's copy. `scripts/deploy.sh` (Docker) drives the LOCAL
   dev stack only; nothing production runs on the pi.
   **Integration CI VERDE prima di OGNI ship — hot/cold, cic/server,
   nessuna eccezione. Il local scoped `--grep` NON basta: gira la suite
   integration COMPLETA (`scripts/integration.sh`) verde prima di ogni
   merge/deploy.** A scoped `--grep #NNN` pass proves ONE spec green
   while the full suite is red — that gap (a red `integration` job
   masking real regressions, shipped through anyway) is the exact
   incident that filed #268. The full `scripts/integration.sh` green is
   the ship gate, not a spot-check of the spec you touched.
4. **Docs before deploy.** Update affected living docs (DESIGN_NOTES,
   patterns/*.md if introduced, todo).
5. Update checkpoint after each feature/fix. Flush before compaction.
6. Done items: remove from todo.md, record in checkpoint.
7. **Context pressure is YOUR problem.** Proactively suggest compact
   when context is heavy. Flush all work to checkpoint first.

### Commit Messages

- Use a HEREDOC via `git commit -m "$(cat <<'EOF'\n...\nEOF\n)"` to
  preserve line breaks. Never echo, never printf.
- One logical change per commit. Message explains WHY.
- Lead line: `<scope>: <imperative summary>` (≤72 chars). Body
  paragraphs explain the WHY, the alternatives considered, the
  tradeoffs accepted.

### What NOT To Do

- **Don't overengineer.** "add X" means add X, not X + Y + Z. If a
  change touches more than ~10 files unexpectedly, stop and confirm
  before continuing.
- **Don't iterate through 10 wrong approaches.** Stop, think, ask.
- **Don't propose split dev environments.** Local dev is one Docker
  Compose stack — no `infra/dev` vs `infra/prod` for development.
  Production is substrate-plural by design: the FreeBSD bastille jail
  (`infra/freebsd/`, prod since the m42 deploy) and the native Linux
  systemd host (`infra/linux/`) are both supported, Docker-free
  production paths — systemd and `mix release` for prod are not
  off-limits, they're already how this ships. Don't propose a *third*
  production substrate without discussing it first.
- **NEVER run raw `docker compose`** — use `scripts/*.sh`. Always.
- **NEVER `mix` on the host** — the container is the runtime.
- **🔴 `_build`, `deps` and `priv/plts` are SHARED BY EVERY WORKTREE on a
  host, BY DESIGN — so a gate result is not automatically attributable to
  your branch.** `scripts/_lib.sh` resolves `REPO_ROOT` to the MAIN repo
  precisely so the caches are shared (`:37-39`), and a worktree run
  bind-mounts its own source on top: *"the container sees worktree code with
  main's cached `_build`, `deps`, `priv/plts`"* (`:54-56`). **Consequence
  measured on #1170: a red `version_test` that belonged to NO branch** — the
  `Grappa.Version` sitting in the shared `_build` had been compiled from
  another worktree's `VERSION`, and three worktrees carry `0.16.0`. Cure
  applied there: `touch VERSION` to force a recompile.
  **So: a red naming a module, constant or version you did not touch is a
  CONTAMINATION suspect before it is a defect.** Confirm it reproduces from
  a forced rebuild (`scripts/mix.sh --env=dev compile --force`) before you
  believe it, and say in the report which of the two you established. The
  COMPILE lane serialises access; it does NOT make the artefacts yours.
  **Opt out with `GRAPPA_CACHE_ID=<id>` (#1263):** the three caches then come
  from `.caches/<id>/` and `MIX_TEST_PARTITION` follows the id, so two ids can
  run `mix` concurrently. Unset changes nothing. A fresh id is COLD — full
  compile plus its own dialyzer PLT, nothing seeded (seeding would import the
  contamination described above). Does NOT isolate the docker stack: compose
  project and ports are still shared, so `integration.sh` / e2e stay
  single-occupancy. See `docs/OPERATIONS.md`.
- **NEVER install hex packages on the host.** Add them to `mix.exs`,
  rebuild the image (`scripts/mix.sh deps.get`).
- **Don't touch the IRC parser without re-running parser tests.**
  Binary pattern matching breaks silently on edge cases.
- **Don't touch supervision tree ordering casually.** Ordering matters
  (PubSub before Endpoint, Repo before sessions). Document the WHY in a
  comment if you change it.
- **Read MORE than 30 lines of logs.** Default to 200+.
- **Document every change.** Update relevant docs in the same commit.
- **Project story lives on.** After significant sessions (new
  features, major refactors, production incidents, hard-won lessons),
  add an episode to `docs/project-story.md`.

## Security

- **Credentials via env vars only.** SECRET_KEY_BASE, RELEASE_COOKIE,
  SASL passwords. Never committed. Never logged.
- **NickServ + SASL passwords** are stored in the DB encrypted at rest
  via Cloak.Vault (AES-GCM, key from `CLOAK_KEY` env). Operator binds a
  network with `mix grappa.bind_network --auth ...`; the cleartext
  never hits a config file. Phase 5 hardening adds HSM-keyed Vault
  (yubico-hsm / TPM / KMS) for operators who want to escape "env on
  disk" key storage.
- **TLS verification on by default (#89, shipped 2026-07-10).** Upstream
  TLS connects use `verify: :verify_peer` against the operator's **system
  CA trust store** (`:public_key.cacerts_get/0`), with `depth: 3`, SNI,
  and RFC-6125 hostname checking (`customize_hostname_check` +
  `pkix_verify_hostname_match_fun(:https)`). Single source of truth:
  `Grappa.IRC.Client.tls_connect_opts/2`. grappa ships no cacertfile and
  pins no cert — the anchor set IS the host OS CA bundle (FreeBSD
  `/etc/ssl/cert.pem` via `ca_root_nss`, Linux `ca-certificates`, macOS
  keychain); operators keep it current the OS way. A private/self-signed
  upstream must have its CA added to the system store, NOT verify_peer
  weakened. Operator strategy: `Client` moduledoc "TLS posture" +
  `docs/OPERATIONS.md`.
  **The ONE exception is per-server and defaults off: `network_servers.tls_verify`
  (#1677).** When false, THAT server drops to `verify: :verify_none` and the
  three opts that are inert without `verify_peer` (`cacerts` / `depth` /
  `customize_hostname_check`) are OMITTED rather than passed and ignored;
  SNI stays, because it selects which certificate is served rather than
  checking it. The column is `NOT NULL DEFAULT 1` and the `Client` opts key
  defaults to `true`, so #89 is unweakened everywhere it holds today —
  Azzurra, Libera and OFTC keep validating, and a row or plan that never
  names the field keeps verifying. **It is NOT a global switch and must not
  become one**: the failure is per-network, and a single knob would silently
  disarm the networks that verify fine. **The argument is not "verification
  is optional" — it is that the workaround it replaces was `tls: false`,
  i.e. CLEARTEXT IRC, which is strictly worse:** cleartext leaks the whole
  stream (SASL and NickServ traffic included) to anything on path, while
  unverified TLS still defeats passive capture. Measured on prod: every
  EFNet leaf with an AAAA record is self-signed or expired, and
  `irc.ircnet.com` serves the certificate of `ircnet.tngnet.nl`, so the
  RFC-6125 check cannot pass from any reachable leaf. Every unverified
  session emits a `Logger.warning` naming the posture at connect (the
  strict one is an `info`, deliberately below the default bar) — **an
  unverified link must never be silent**, or the cure has bought a hole
  nobody can see. Settable OUT-OF-BAND only (`mix grappa.add_server
  --no-tls-verify`); the admin REST write whitelist deliberately does not
  carry it, and the admin payload projects it READ-ONLY so an operator can
  see which servers run unverified.
- **Sobelow is a CI gate** — Medium-or-above findings fail the build.
  Every Phoenix app gets it.
- **`mix deps.audit` is the hard CI gate.** CVE-flagged deps fail the
  build immediately. **`mix hex.audit` is advisory-only** since #147 and
  must not be read as a gate: cowboy/cowlib carry advisories with no
  fixed release at any version, and hex.audit has no per-advisory ignore
  to express that they are unreachable (both enter ONLY via `bypass`,
  `only: :test`; prod serves on Bandit and ships neither). The full
  advisory list, the reachability argument, and what would restore the
  gate live on the `ci.check` alias in `mix.exs` — see #149.

## Docs map

- **CLAUDE.md** (this file): rules, principles, invariants, session protocol.
- **`docs/OPERATIONS.md`**: operator + developer runbook (verbs,
  scripts, deploy, runtime data, monitoring).
- **`docs/TESTING.md`**: how-to-run-tests runbook (every gate, e2e
  triage, gotchas).
- **`docs/DESIGN_NOTES.md`**: chronological decision log — the CURRENT
  month plus the undated preamble. Closed months are archived verbatim
  in **`docs/design_notes/YYYY-MM.md`** (#1537) and indexed from the
  top of the live file; new entries still append to the tail of
  `DESIGN_NOTES.md`, never to an archive. A grep for an old ruling
  needs both paths:
  `grep -rn '<pattern>' docs/DESIGN_NOTES.md docs/design_notes/`.
- **`docs/plans/*.md`, `docs/superpowers/plans/*.md`** — EPHEMERAL
  scratch plans. **Gitignored; never commit them.** A plan is working
  memory for ONE feature: write it, execute it, then DELETE it as part
  of feature completion. Any durable rationale (a design decision,
  invariant, constraint, gotcha) MUST be lifted into
  `docs/DESIGN_NOTES.md` (or the relevant living doc) BEFORE the plan is
  deleted — the decision log is the permanent record; the plan is not.
  Backlog and roadmap live in GitHub issues, not files.

If a rule belongs in the codebase as code, write the code. If a rule
belongs in conversation, write a memory. CLAUDE.md is for the rules
the human will want enforced six months from now without re-explaining.
