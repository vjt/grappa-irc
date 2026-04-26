# Architecture Review — 2026-04-26

**Branch / commit baseline:** `main` @ `bd202c0` (post-S30, Phase 2 COMPLETE + live in prod at `192.168.53.11:4000`).
**Review type:** architecture (concern-based structural analysis).
**Dispatched:** 6 parallel agents, one per concern (abstraction boundaries, responsibility & cohesion, duplication, dependency architecture, type system leverage, extension & maintainability).
**Raw findings:** 83. **Deduped findings:** 30. **Tally:** 1 CRITICAL, 9 HIGH, 13 MEDIUM, 7 LOW.

This is **architecture, not line-level**. Findings are structural patterns. Line-level
bugs go in `docs/reviews/codebase/`.

Codebase shape at review time:
- ~6,000 LOC of Elixir under `lib/`
- 6 properties + 378 tests + 0 failures
- 13 top-level Boundary annotations enforced
- Phase 2 added: `Accounts`, `Networks`, `EncryptedBinary`, `Vault` boundaries +
  REST auth surface + WS connect/3 + GrappaChannel cross-user authz +
  7-task operator mix surface + Cloak vault layer

Phase 3 (cicchetto PWA, separate repo) is the immediate next phase. **The wire
contract grappa exposes IS the cicchetto contract** — wire-shape findings carry
amplified urgency because cicchetto will lock them in by consumption.

---

## Summary table

| ID  | Title                                                                                | Concern             | Severity |
|-----|--------------------------------------------------------------------------------------|---------------------|----------|
| A1  | `Credential.password_encrypted` carries plaintext after Cloak load — name lies, no `Networks.Wire` to gate JSON emission | Boundaries / Type   | CRITICAL |
| A2  | Networks ↔ Session boundary cycle papered over with duplicated registry-key + raw `messages` query | Dependency / Cohesion | HIGH |
| A3  | `IRC.Client` is a god module (530 LOC: transport + handshake + auth + SASL + framing) | Cohesion            | HIGH     |
| A4  | Web → Repo direct preload + over-broad `GrappaWeb` Boundary deps (carried as M2)     | Boundaries / Cohesion | HIGH   |
| A5  | `User` wire shape rendered 2 ways across `MeJSON`/`AuthJSON` — no `Accounts.Wire` (carried as H11) | Duplication / Boundaries | HIGH |
| A6  | Mix tasks bypass `Networks` via `Repo.get_by!(Network, slug: ...)` (4 sites)         | Dependency / Boundaries | HIGH |
| A7  | Error-string casing + envelope inconsistency on REST (carried as M5; Phase 3 surface) | Duplication        | HIGH     |
| A8  | Nick-regex drift across 3 implementations (carried as M3 — operator can persist unbootable credential) | Duplication | HIGH |
| A9  | IRC kind catalog drift across 5+ attribute lists; no central registry                | Extension          | HIGH     |
| A10 | `Session.Server.init/1` resolves config from 3 contexts; `pick_server/1` lives on wrong module | Cohesion        | HIGH     |
| A11 | `Application.put_env(:start_bootstrap, false)` duplicated 6× across mix tasks (carried as M12) | Duplication / Dependency | MEDIUM |
| A12 | `Phoenix.PubSub` used directly — no `Grappa.PubSub.broadcast/subscribe` wrapper      | Dependency / Boundaries | MEDIUM |
| A13 | `IRC.Client` `:dispatch_to => pid()` contract is library-extraction-hostile          | Boundaries          | MEDIUM   |
| A14 | `auth_method` enum atom list duplicated 3× (`Credential`, `IRC.Client`, `OptionParsing`) | Type / Duplication | MEDIUM |
| A15 | `Scrollback.Wire.t()` types `meta: map()` — weaker than the schema's typed allowlist | Type                | MEDIUM   |
| A16 | `safe_line_token?` dual-validation in `Session` + `IRC.Client` (8 callsites)         | Cohesion / Duplication | MEDIUM |
| A17 | Auth surface shape split: REST holds `current_user_id`, WS holds `user_name`         | Boundaries / Cohesion | MEDIUM |
| A18 | Network slug regex drift (32 vs 64 cap; contradicts DESIGN_NOTES 2026-04-26)         | Duplication         | MEDIUM   |
| A19 | IRC numeric magic numbers (`{:numeric, 1}`, `{:numeric, 433}`) — no `Grappa.IRC.Numerics` table | Duplication | MEDIUM |
| A20 | Mix tasks halt-on-changeset duplicated 4× (extracted in 1, re-inlined in 3)          | Duplication         | MEDIUM   |
| A21 | `GrappaWeb` Boundary `deps` lists `Grappa.Repo` + over-broad `Grappa.IRC` export      | Dependency          | MEDIUM   |
| A22 | `Networks.scrollback_present?/1` raw `from(m in "messages", ...)` query bypasses Scrollback | Boundaries / Dependency | MEDIUM |
| A23 | `Session.Server.client_opts/4` returns `map()` — `IRC.Client.opts()` type alias exists, unused | Type            | MEDIUM   |
| A24 | `Session.Server` state is bag-of-keys map, not a `defstruct` with `@enforce_keys`    | Type                | LOW      |
| A25 | `Wire.event` tagged `kind: :message` only — Phase 5 needs union; no consumer-side validation | Type / Extension | LOW    |
| A26 | `MessagesController.preload_networks/2` hand-rolled assoc-mutation trick             | Cohesion / Boundaries | LOW    |
| A27 | `IRC.Identifier.valid_sender?/1` carries non-IRC `<bracketed>` regex (speculative validation) | Cohesion       | LOW      |
| A28 | `IRC.Identifier.safe_line_token?/1` is a security guard sitting in IRC-syntax module | Boundaries          | LOW      |
| A29 | Sandbox setup duplicated 3× across `DataCase`/`ConnCase`/`ChannelCase`               | Duplication         | LOW      |
| A30 | `mix help grappa` returns nothing — no operator-surface index task                   | Extension           | LOW      |

---

## Cross-cutting themes

The 30 findings cluster into 5 themes. Acting on the theme is cheaper than
fix-by-fix because the theme produces multiple findings simultaneously.

### Theme 1 — The wire contract is about to be frozen by cicchetto

A1, A4, A5, A7, A15 (also touches A17). Phase 3 will write the cicchetto PWA
against the existing REST + Channels surface. Every drift in the wire shape
becomes a frozen cicchetto contract the moment cicchetto consumes it. The
cluster shipped as the post-Phase-2 hygiene cluster (M2/M5/H11 in cp08) covers
some of these; the architecture review surfaces additional ones (A1's
`Credential.password_encrypted` JSON-leak risk, A15's untyped `meta` map, A7's
mixed error-string conventions). **Fix this theme BEFORE Phase 3 starts** —
~1 session of focused work. Otherwise Phase 3 hardens the bugs.

### Theme 2 — The Networks ↔ Session cycle is metastasizing

A2, A6, A10, A22 (and A21 partially). The `Networks.unbind_credential/2` →
inlined registry-key + raw `messages` query workaround was Phase 2 acceptable
debt. Phase 3 will add new operator surfaces (rotate password, suspend user,
etc.) that hit the same cycle and copy the same workaround. The CP08-deferred
"invert Session.Server.init to take credential data via opts" is the correct
fix and unblocks A2/A6/A10/A22 simultaneously. **Land this BEFORE Phase 3** —
~1 session. Removes a documented architectural debt and shrinks the Boundary
deps graph by 4-5 edges.

### Theme 3 — IRC subsystem is library-extraction-hostile

A3, A9, A13, A14, A19, A28. The `project_extract_irc_libs.md` memory plans a
`grappa_irc_parser` + `grappa_irc_client` hex extraction post-Phase-5. Today's
shape blocks that: `IRC.Client` is a 530-LOC god module (A3) coupling transport
to NickServ-aware handshake; the `:dispatch_to => pid()` contract (A13)
forces the consumer to be a process; `safe_line_token?` lives next to IRC
grammar validators despite being a security guard (A28); the kind catalog,
auth-method enum, and numerics table are all duplicated across the boundary
(A9, A14, A19). **Defer to Phase 5+** but flag now: every Phase 3/4/5 feature
that touches IRC adds another barrier to the eventual library extraction.

### Theme 4 — Operator surface is sprawling without abstraction

A11, A20, A30 (and A23 partially). Six mix tasks repeat the boot dance, four
re-inline a halt-on-changeset, and there's no top-level `mix help grappa` index.
The CP08-deferred "Phase 5 `Grappa.Operator` CLI lift" is the correct
medium-term answer; in the meantime, a `Mix.Tasks.Grappa.Boot.start_app/0`
helper + lifting `halt_changeset/2` from `bind_network` to a shared module
covers ~80% of the friction at one-commit cost.

### Theme 5 — Type leverage is strong but not total

A14, A15, A17, A23, A24, A25. The codebase is genuinely well-typed — atoms-or-
typed-literals everywhere relevant, no `String.to_atom`, no `\\` defaults,
tagged tuples consistent. The remaining gaps are all "promote a `map()` /
`String.t()` to a stronger type" — the Session.Server state map (A24), the
client_opts return type (A23), the Wire meta shape (A15), the AuthContext
struct (A17). None are correctness bugs; all compound under Phase 3/5 surface
growth.

---

## Findings (deduped)

### A1. `Credential.password_encrypted` carries plaintext after Cloak load — name lies, and no `Networks.Wire` exists to gate JSON emission
**Concern:** Boundaries / Type system
**Scope:**
- `lib/grappa/networks/credential.ex:50,67-75,193-198` (Cloak `:load` decrypts to plaintext-in-memory)
- `lib/grappa/session/server.ex:306` (`password: credential.password_encrypted`)
- `lib/grappa/networks.ex` (no `Networks.Wire.credential_to_json/1` exists)
- `lib/grappa_web/router.ex` (no `GET /networks` route exists yet — Phase 3 will add it)
**Problem:** The Cloak Ecto type decrypts on `:load`, so after `Repo.one!` the field named `password_encrypted` carries **cleartext** in memory. Session.Server reads `.password_encrypted` directly. The DESIGN_NOTES 2026-04-26 entry calls this out as a footgun caught only by `redact: true`. Now: README spec promises `GET /networks`. Phase 3 will write it. Without a `Networks.Wire.credential_to_json/1` with an explicit allowlist, the first naïve controller emits `%{nick: c.nick, password: c.password_encrypted, ...}` — **leaking the plaintext NickServ password to JSON**. `redact: true` only protects `inspect/1`, not `Jason.encode!/1`.
**Impact:** This is the highest-risk Phase 3 boundary footgun. CRITICAL because (a) Phase 3 will write the endpoint, (b) the field name actively misleads, (c) no defense-in-depth `Networks.Wire` exists, (d) the `Scrollback.Wire` precedent with field-allowlist + test exists but wasn't replicated.
**Recommendation:** Two coupled actions, both before Phase 3 starts:
1. Land `Grappa.Networks.Wire.credential_to_json/1` + `network_to_json/1` with explicit field allowlists. Document in moduledoc: "NEVER include `password_encrypted`." Add a unit test asserting output keys never include `password_encrypted` or `password`.
2. Either rename the in-memory accessor (`Credential.password/1` returns the decrypted plaintext, schema field stays `password_encrypted` for the column name) OR add `password_decrypted` virtual field for in-memory reads. Session.Server stops poking `.password_encrypted` directly.
**Severity:** CRITICAL

### A2. Networks ↔ Session boundary cycle papered over with duplicated registry-key + raw `messages` query
**Concern:** Dependency architecture / Cohesion
**Scope:**
- `lib/grappa/networks.ex:264,316-337` (`stop_session_for_unbind/2`, `scrollback_present?/1`)
- `lib/grappa/session/server.ex:131-141` (`registry_key/2` documented as "single source of truth")
- `lib/grappa/session.ex` (the `stop_session/2` Networks should be calling)
**Problem:** Documented in CP08 + DESIGN_NOTES + the source comments themselves. To avoid a Boundary cycle, `Networks` inlines:
- The registry-key tuple `{:session, user_id, network_id}` (a copy of `Session.Server.registry_key/2`'s "single source of truth")
- A raw `from(m in "messages", ...)` query that bypasses `Scrollback`
Two parallel sources of truth dodging two boundary cycles. The "single source" claim is already false.
**Impact:** Phase 3 surfaces will need session lookup from new operator paths (rotate password, suspend user, force re-auth). Each new caller copies the workaround or invents a third helper. The Phase 6 listener facade will need session lookup from a 4th angle.
**Recommendation:** Land the deferred dep-inversion (CP08 line 156-159):
1. `Grappa.Session.start_session/3` takes `(user_id, network_id, %{credential, server, user_name})` — opts contain resolved data.
2. `Bootstrap` resolves credentials via `Networks.list_credentials_for_all_users/0` (already exists), passes per-credential opts.
3. `Session.Server.init/1` becomes pure data consumer — no Repo, no Networks reads.
4. Networks → Session edge becomes legal (no cycle); `Networks.unbind_credential/2` calls `Session.stop_session/2` cleanly.
5. `scrollback_present?/1` calls `Scrollback.has_messages_for_network?/1` (new public function).
6. `pick_server/1` (currently on Session.Server) moves to `Networks` where the policy belongs.
**Severity:** HIGH (was deferred to Phase 5; Phase 3 imminence elevates urgency)

### A3. `IRC.Client` is a god module — 530 LOC fusing transport + handshake + auth + SASL + framing
**Concern:** Cohesion
**Scope:** `lib/grappa/irc/client.ex` (largest module in codebase by ~35%)
**Problem:** Four distinct responsibilities in one GenServer:
1. **TCP/TLS transport** — `do_connect`, `transport_send`, dual-stack `:gen_tcp`/`:ssl` callbacks
2. **Outbound IRC framing** — `send_privmsg/3`, `send_join/2`, `send_part/2`, `send_quit/2`, `send_pong/2`, all with identical `safe_line_token?/1` gating + literal-string framing
3. **Inbound parse-and-dispatch loop** — `process_line`, parser-error logging
4. **Handshake / auth state machine** — `perform_initial_handshake`, `maybe_send_pass`, `maybe_send_cap_ls`, `handle_cap`, `finalize_cap_ls`, `cap_unavailable`, `maybe_send_cap_end`, `maybe_nickserv_identify`, `sasl_plain_payload`, the `:phase` field, the cap allowlist parser
Five auth methods × four phases × CAP LS continuation × SASL 902/903/904/905 + nick-rejection numerics 432/433 all in one module that also owns the socket descriptor. `caps_buffer` lives on the Client struct forever but is only meaningful during `:awaiting_cap_ls`.
**Impact:** Phase 5 reconnect/backoff cannot be added without re-reading 530 lines to figure out which transitions tolerate a fresh socket. Phase 6 IRCv3 listener cannot reuse `Client` because it knows about NickServ. The `project_extract_irc_libs.md` post-Phase-5 hex extraction is currently a rewrite, not a move.
**Recommendation:** Carve into three modules:
- `Grappa.IRC.Client.Transport` (~80 LOC) — owns socket, push `{:line, raw}` to parent
- `Grappa.IRC.Client.Handshake` (~150 LOC) — pure state machine: `(phase, caps_buffer, message) → {[outbound], new_phase, new_buffer} | {:stop, reason}`. Property-testable on the auth_method × incoming-numeric matrix.
- `Grappa.IRC.Client` (~120 LOC) — GenServer composing the two
Collapse the 5 `send_*` guards into one `send_command(verb, args)`. **Defer to Phase 5** (no immediate trigger), but every new IRC feature added before this lift makes the lift more expensive.
**Severity:** HIGH

### A4. Web → Repo direct preload + over-broad `GrappaWeb` Boundary deps (carried as M2)
**Concern:** Boundaries / Cohesion
**Scope:**
- `lib/grappa_web/controllers/messages_controller.ex:39,99` (`alias Grappa.Repo`, `Repo.preload(message, :network)`)
- `lib/grappa_web.ex:13-21` (`deps:` includes `Grappa.Repo`)
**Problem:** `Session.Server.persist_and_broadcast/4` already preloads `:network` and returns the preloaded struct. The controller calls `Repo.preload(message, :network)` defensively — admits the controller doesn't trust the Session contract. `GrappaWeb` carries `Grappa.Repo` as a Boundary dep specifically to authorize this single redundant call. Per CLAUDE.md "no leaky abstractions: each context owns its domain. Return domain types."
**Impact:** Every Phase 3 controller that delegates a write to a context inherits the same "should I preload defensively?" question. The `Grappa.Repo` web dep is permissive — any new controller can copy the pattern.
**Recommendation:**
1. Document `Session.send_privmsg/4` contract: "returns `%Message{network: %Network{}}` ready for `Wire.to_json/1`."
2. Drop `Repo.preload` from `MessagesController.create/2`.
3. Drop `alias Grappa.Repo` from the controller.
4. Remove `Grappa.Repo` from `GrappaWeb`'s Boundary deps. Forcing-function: any future controller that copies the pattern fails compile.
**Severity:** HIGH

### A5. `User` wire shape rendered 2 ways — no `Grappa.Accounts.Wire` (carried as H11)
**Concern:** Duplication / Boundaries
**Scope:**
- `lib/grappa_web/controllers/me_json.ex:14-16` (`%{id, name, inserted_at}`)
- `lib/grappa_web/controllers/auth_json.ex:15-17` (`%{id, name}` — no `inserted_at`)
**Problem:** Two separate JSON renderers each pick fields off `%User{}` directly. No `Grappa.Accounts.Wire` exists (mirror of `Scrollback.Wire`). The two endpoints emit different field sets for the same domain object.
**Impact:** Phase 3 cicchetto will write a TS `User` model from these payloads — inconsistent shapes mean two TS interfaces or one nullable-everything interface. Future fields (display_name, avatar, etc.) require coordinated edits in 2+ files. Future `/users/:id` admin endpoint will be a 3rd inline shape.
**Recommendation:** Extract `Grappa.Accounts.Wire.user_to_json/1` returning the canonical shape. Both `MeJSON.show/1` and `AuthJSON.login/1` delegate. Same pattern as `Scrollback.Wire`. Single source of truth + adding a User wire field = one edit.
**Severity:** HIGH (Phase 3 contract surface)

### A6. Mix tasks bypass `Networks` via `Repo.get_by!(Network, slug: ...)` — 4 sites
**Concern:** Dependency / Boundaries
**Scope:**
- `lib/mix/tasks/grappa.add_server.ex:41`
- `lib/mix/tasks/grappa.remove_server.ex:36`
- `lib/mix/tasks/grappa.unbind_network.ex:34`
- `lib/mix/tasks/grappa.update_network_credential.ex:52`
**Problem:** Four mix tasks alias both `Grappa.Networks` AND `Grappa.Repo`, then reach across the Networks boundary to operate on its `Network` schema directly. `Networks.get_network_by_slug/1` exists but returns `{:ok, _} | {:error, :not_found}`; the bang variant operators want doesn't exist, so callers reach around. Each task's Boundary deps carry `Grappa.Repo` to justify a single line per file.
**Impact:** Networks cannot evolve slug-lookup semantics (case-insensitive, soft-delete filter, telemetry) without four silent-bug sites in mix tasks. Phase 5+ tasks will copy whichever sibling is closest.
**Recommendation:** Add `Grappa.Networks.get_network_by_slug!/1` (raising). Replace all four `Repo.get_by!` calls. Drop `Grappa.Repo` + `Grappa.Networks.Network` aliases from these tasks. Pairs with Theme 4 (operator surface cleanup).
**Severity:** HIGH (operator surface; will multiply with Phase 5 tasks)

### A7. Error-string casing + envelope inconsistency on REST (carried as M5)
**Concern:** Duplication
**Scope:** `lib/grappa_web/controllers/fallback_controller.ex:25-69`, `lib/grappa_web/plugs/authn.ex:61`
**Problem:** Six error-string conventions live on the JSON wire:
- `"bad request"` (space)
- `"not found"` (space)
- `"no session"` (space)
- `"unauthorized"` (single word; Authn plug, NOT FallbackController)
- `"invalid_credentials"` (snake_case)
- `"invalid_line"` (snake_case)
Plus changeset errors use a different envelope (`%{errors: %{field => [...]}}` vs `%{error: "..."}`).
**Impact:** cicchetto needs a switch knowing all six strings AND two envelope shapes. Adding a new error means picking a casing that probably won't match. The space-separated forms are pre-Phase-2 leftovers; the Phase 2 additions chose snake_case (correctly, but inconsistently with what was there).
**Recommendation:** Lock snake_case + a single envelope. Either:
- `%{error: "snake_case_tag", message: "Human readable"}` for tagged + `%{errors: %{field => [...]}}` for changesets
- Or unified `%{error: %{tag, message, fields?}}` for both
Migrate all 6 in one commit (CLAUDE.md "Total Consistency Or Nothing").
**Severity:** HIGH (Phase 3 contract surface)

### A8. Nick-regex drift across 3 implementations (carried as M3)
**Concern:** Duplication
**Scope:**
- `lib/grappa/irc/identifier.ex:26` — `@nick_regex ~r/^[A-Za-z\[\]\\\`_^{|}\-][\w\[\]\\\`_^{|}\-]{0,30}$/` (length 1–31, leading `-` allowed, body uses `\w`)
- `lib/grappa/networks/credential.ex:94` — `@nick_format ~r/^[a-zA-Z\[\]\\\`_^{|}][a-zA-Z0-9\[\]\\\`_^{|}\-]*$/` + `validate_length(:nick, min: 1, max: 30)` (no `\w`, no leading `-`)
- `lib/grappa/accounts/user.ex:46` — `@name_format` (deliberately tighter per DESIGN_NOTES — keep separate)
**Problem:** Two "validates an IRC nick" regexes disagree on length cap (31 vs 30), leading-char allowed set (`-` vs no `-`), and body charset. **A nick that passes the credential changeset can fail `Identifier.valid_nick?` and vice versa.** The operator can already create unbootable credentials.
**Impact:** Operator binds credential with leading-`-` nick → boots → IRC.Client sends NICK → upstream rejects 432 → session crashes in restart loop. Cicchetto Phase 3 may re-implement client-side validation; without single source, no "valid here, valid there" UX.
**Recommendation:** Make `Credential.changeset/2` call `Grappa.IRC.Identifier.valid_nick?/1` (already aliased). Drop `@nick_format` and `validate_length(:nick, ...)`. Single source of nick syntax in `Identifier`.
**Severity:** HIGH (correctness bug surface — operator-creatable bad state)

### A9. IRC kind catalog drift across 5+ allowlists; no central registry
**Concern:** Extension
**Scope:**
- `lib/grappa/irc/parser.ex:67-93` (`@known_commands`)
- `lib/grappa/irc/message.ex:46-72` (`@type command`)
- `lib/grappa/scrollback/message.ex:87-98` (`@kinds`)
- `lib/grappa/scrollback/message.ex:100` (`@body_required_kinds`)
- `lib/grappa/scrollback/meta.ex:69` (`@known_keys`)
- `lib/grappa/session/server.ex:100` (`@logged_event_commands`)
- `config/config.exs:25-70` (Logger metadata allowlist)
**Problem:** Adding a new IRC kind (e.g. `:invite`) touches: Parser map, Message type, Scrollback `@kinds`, possibly `@body_required_kinds`, Meta `@known_keys`, Session `@logged_event_commands`, Logger config, plus tests for each. Only one cross-list drift check exists (`MetaTest "known_keys ↔ Logger metadata allowlist"`); the parser↔scrollback `@kinds`↔Message `@type command` drift is unchecked.
**Impact:** Phase 5 will wire 7 presence events (JOIN/PART/QUIT/NICK_CHANGE/MODE/TOPIC/KICK persistence). 7 events × ~8 sites = ~56 edit points without drift protection. Phase 6 IRCv3 listener adds another consumer of every kind.
**Recommendation:** Centralize in `Grappa.IRC.Catalog` (or `Grappa.Scrollback.Kinds`) declaring `@type kind`, the Ecto enum value list, body-required subset, per-kind meta-key shape, and IRC verb → kind mapping. All 7 sites import from one source. Add `@after_compile` cross-check OR an ExUnit test asserting the catalog is closed under all joins.
**Severity:** HIGH (Phase 5 multiplier; addressing now is ~1/10 the cost of addressing during Phase 5)

### A10. `Session.Server.init/1` resolves config from 3 contexts; `pick_server/1` lives on wrong module
**Concern:** Cohesion
**Scope:** `lib/grappa/session/server.ex:146-170` (init), `:294-308` (`client_opts/4`), `:160` (`pick_server/1`)
**Problem:** `init/1` does:
1. `Accounts.get_user!(user_id)` — fetch user name
2. `Networks.get_network!(network_id) |> Repo.preload(:servers)` — fetch network + servers
3. `Networks.get_credential!(user, network)` — fetch credential
4. `pick_server(network)` — server-selection policy as a private Server function
5. `Log.set_session_context/2` — process metadata
6. `Client.start_link(client_opts(...))` — actual job
Steps 1-4 are config resolution + selection policy. Step 6 is the GenServer's job. Boundary deps reflect: 7 contexts to start one process. `pick_server/1`'s policy (priority asc, tie-break by id, raise on empty) is a Networks domain concern living on Session.
**Impact:** Tests must seed Accounts + Networks rows to instantiate any Session. The Networks↔Session boundary cycle (A2) exists *because* of these init lookups. Phase 5 fail-over wants `pick_server` policy in Networks, not Session.
**Recommendation:** Folded into A2 fix: `Networks.connect_plan(user_id, network_id) :: %{user_name, credential, server, network_slug}` returns the joined-data shape. `Session.Server.init/1` becomes ~25 LOC. Boundary deps shrink from 7 → 3. `pick_server` moves to Networks.
**Severity:** HIGH (folds into A2 — same one-session fix)

### A11. `Application.put_env(:start_bootstrap, false)` duplicated 6× across mix tasks (carried as M12)
**Concern:** Duplication / Dependency
**Scope:** All six `Mix.Tasks.Grappa.*` modules (excluding `gen_encryption_key`)
**Problem:** Identical 2-line dance copied verbatim. Violates CLAUDE.md "**No `Application.get_env/2` outside `config/`**." Application.start reads it; mix tasks mutate it pre-`ensure_all_started`. The contract is implicit, untested, brittle. Adding any future task that transitively starts `:grappa` could race the flag.
**Impact:** New Phase 3+ tasks (cicchetto-feedback admin tools, Phase 5 `mix grappa.delete_scrollback`) propagate the dance. The CP08-deferred Phase 5 `Grappa.Operator` CLI lift overlaps this entirely — the cohesive fix is one helper module.
**Recommendation:** Extract `Mix.Tasks.Grappa.Boot.start_app_silent/0` (or extend `OptionParsing` with `boot_app/0`). Each task's first line becomes `Boot.start_app_silent()`. Forward-compatible with the deferred Phase 5 RPC operator surface. Consider further: lift Bootstrap from `Application` children entirely; have Bootstrap as a separate `Grappa.Bootstrap.start_link/1` only called from production `start/2`.
**Severity:** MEDIUM

### A12. `Phoenix.PubSub` used directly — no `Grappa.PubSub.broadcast/subscribe` wrapper
**Concern:** Dependency / Boundaries
**Scope:**
- `lib/grappa/session/server.ex:341` (`Phoenix.PubSub.broadcast(Grappa.PubSub, topic, ...)`)
- `lib/grappa_web/channels/grappa_channel.ex:42` (`Phoenix.PubSub.subscribe(Grappa.PubSub, topic)`)
- `lib/grappa/pubsub.ex` exports only `Topic`
**Problem:** `Grappa.PubSub` boundary owns the topic vocabulary but NOT the verb. Both broadcast and subscribe go through `Phoenix.PubSub` directly with `Grappa.PubSub` as a magic atom-name. No wrapper, no telemetry seam, no compile-time topic-shape enforcement.
**Impact:** Phase 3 cicchetto will add new event publishers (REST controllers may push status events) and they'll all use `Phoenix.PubSub` directly — established pattern. Phase 5 telemetry ("PubSub events broadcast/sec per topic-class") wants a single seam. Phase 6 listener facade needs the same broadcast verb.
**Recommendation:** Add `Grappa.PubSub.broadcast(topic, event)` and `Grappa.PubSub.subscribe(topic)` thin wrappers taking `Topic.t()` (typed struct, not raw string). Migration is mechanical — ~3 callsites today. Then Boundary enforces only `Grappa.PubSub` callers can publish/subscribe AND topic-shape is enforced at the type level.
**Severity:** MEDIUM

### A13. `IRC.Client` `:dispatch_to => pid()` contract is library-extraction-hostile
**Concern:** Boundaries
**Scope:** `lib/grappa/irc/client.ex:100-111` (opts shape), `:120-131` (`@type t` exposes `:gen_tcp.socket() | :ssl.sslsocket()`)
**Problem:** The contract is "give me a pid; I'll send `{:irc, %Message{}}` into your mailbox." Caller is forced to be a process, forced to handle `handle_info`. No callback module, no behaviour, no adapter — the mailbox IS the output channel. Per `project_extract_irc_libs` memory, `lib/grappa/irc/*` becomes `grappa_irc_client` hex library post-Phase-5; today's contract is a non-starter for a library API.
**Impact:** Phase 6 listener facade can reuse parser + message struct cleanly per design — but cannot reuse Client without inheriting the `:dispatch_to` coupling. Library extraction = breaking change for in-tree caller too. Designing the API NOW such that the in-tree caller is the first consumer of the library-shape API is the cheap moment.
**Recommendation:** Introduce `IRC.Client` callback behaviour: `@callback handle_irc_message(Message.t(), state) :: {:ok, state} | {:stop, reason, state}`. Session.Server implements it. The pid-coupling becomes an internal optimization. Make `Client.t()` `@opaque` and hide the socket field via `@derive {Inspect, except: [:socket]}` + private accessors. **Defer to Phase 5** (no immediate trigger); every IRC feature added before this lift increases the migration cost.
**Severity:** MEDIUM (Phase 5 timing)

### A14. `auth_method` enum atom list duplicated 3× — `Credential`, `IRC.Client`, `OptionParsing`
**Concern:** Type / Duplication
**Scope:**
- `lib/grappa/networks/credential.ex:38` (Ecto.Enum source)
- `lib/grappa/irc/client.ex:96` (init guard)
- `lib/mix/tasks/grappa/option_parsing.ex:16` (`--auth` parser)
**Problem:** Three independent declarations of the same closed set + 3 type aliases. The IRC.Client/Credential dup is forced by the boundary cycle (A2); the OptionParsing copy is gratuitous. CLAUDE.md "Total consistency or nothing."
**Impact:** Adding Phase 5+ auth method (`:certificate`, `:scram_sha256`) requires three coordinated edits. Forgetting one = "operator can bind via mix task but Client crashes at boot."
**Recommendation:** Single source in `Networks.Credential`. Export `Credential.auth_methods/0` returning the list, `@type auth_method` as the public type. `IRC.Client` aliases: `@type auth_method :: Credential.auth_method()`, runtime guard becomes `m in Credential.auth_methods()`. `OptionParsing` calls `Credential.auth_methods/0` for `--auth` validation. Boundary direction is correct: IRC.Client ← Credential (after A2 inversion).
**Severity:** MEDIUM

### A15. `Scrollback.Wire.t()` types `meta: map()` — weaker than the schema's typed allowlist
**Concern:** Type system
**Scope:** `lib/grappa/scrollback/wire.ex:45` (`meta: map()`), `lib/grappa/scrollback/meta.ex:69` (`@known_keys ~w[target new_nick modes args reason]a`)
**Problem:** `Scrollback.Meta` does the work of constraining `meta` to an atom-keyed allowlisted shape. But `Wire.t()` collapses that back to bare `map()`. Dialyzer cannot assert wire payloads carry only allowlisted keys; cicchetto wire contract has no machine-readable type for what `meta` may contain. Per-kind shape (`:kick → %{target}`, `:nick_change → %{new_nick}`) lives in moduledoc only.
**Impact:** Phase 3 cicchetto cannot derive meta key set from the wire spec. Phase 5 starts writing every kind with populated `meta` — moduledoc table promises a shape; nothing tests it. Phase 6 listener will need "given `:kick`, expect `target` field" for `CHATHISTORY` event reconstruction — no machine-readable answer.
**Recommendation:** Promote `Wire.t()` to encode per-kind meta shape as a tagged union (`kind: :privmsg, meta: %{}` | `kind: :kick, meta: %{target: String.t()}`). Folds into A9 (catalog centralization) — solving A9 closes A15 for free.
**Severity:** MEDIUM

### A16. `safe_line_token?` dual-validation in `Session` + `IRC.Client` (8 callsites)
**Concern:** Cohesion / Duplication
**Scope:**
- `lib/grappa/session.ex:139,156,171` (`send_privmsg`, `send_join`, `send_part`)
- `lib/grappa/irc/client.ex:184-225` (`send_privmsg`, `send_join`, `send_part`, `send_quit`, `send_pong`)
**Problem:** Eight functions all open-code the same "validate input or return `{:error, :invalid_line}`" guard. Session pre-validates; Server.handle_call hits Client which validates AGAIN. Server.Server's moduledoc explicitly calls out the redundancy: "forward-compat insurance against a future caller that bypasses the facade." Two validators for the same invariant = if the rule changes (new control byte added to deny set), both must be edited in lockstep.
**Impact:** Phase 3+ outbound verbs (NOTICE, MODE, TOPIC) propagate the pattern. Phase 6 listener will need outbound verbs going the OTHER direction with different framing rules — easy to copy this shape and miss the differences.
**Recommendation:** Pick ONE owner. Most natural: `IRC.Client` is the wire-format authority; it should validate. Remove `safe_line_token?` calls from `Session.send_*/3`. The error tuple `{:error, :invalid_line}` propagates up through `call_session/3` unchanged. Session.Server's `handle_call` catch-clause becomes the legitimate error path, not insurance. Net: -10 LOC, one wire-validation owner.
**Severity:** MEDIUM

### A17. Auth surface shape split: REST holds `current_user_id`, WS holds `user_name`
**Concern:** Boundaries / Cohesion
**Scope:**
- `lib/grappa_web/plugs/authn.ex:33-35` (`current_user_id`, `current_session_id`)
- `lib/grappa_web/channels/user_socket.ex:45-48` (`user_name`, `current_session_id`)
- `lib/grappa_web/channels/grappa_channel.ex:57` (uses `user_name`)
**Problem:** REST controllers consume `conn.assigns.current_user_id` (UUID) for context calls; Channel join compares `socket.assigns.user_name` (string) for topic authz. Two different identifying fields for the same authenticated user. Reason: PubSub topic strings encode slug-style `user_name`, not UUID. Contract is "REST has UUID, Channels have name, both have session_id."
**Impact:** Phase 3 cicchetto needs both surfaces. Bridging events back to REST resources requires JS client to know "the topic name segment IS my user_name" — undocumented contract. Phase 6 listener facade will face the same.
**Recommendation:** Define `Grappa.Accounts.AuthContext` struct `%AuthContext{user_id, user_name, session_id}`. Both `Plugs.Authn` and `UserSocket.connect/3` build the same struct and assign as `:current_auth`. Controllers and channels destructure as needed. Trivial extension when Phase 5 adds `:scopes` or `:roles`.
**Severity:** MEDIUM

### A18. Network slug regex drift (32 vs 64 cap; contradicts DESIGN_NOTES 2026-04-26)
**Concern:** Duplication
**Scope:**
- `lib/grappa/irc/identifier.ex:35` — `@network_id_regex ~r/^[a-z0-9_\-]{1,32}$/`
- `lib/grappa/networks/network.ex:39,51` — `@slug_format ~r/^[a-z0-9_\-]+$/` + `validate_length(:slug, min: 1, max: 64)`
**Problem:** Two regexes both validate "Grappa network identifier." Network.changeset uses cap 64; Identifier.valid_network_id? uses cap 32. **Operator can persist 33-char slug, then a downstream call to `Identifier.valid_network_id?` returns false.** DESIGN_NOTES 2026-04-26 says `^[a-z0-9-]{1,32}$` (no underscore, cap 32) — the live code disagrees with the docs AND with itself.
**Impact:** Slug validation drift. PubSub topic builder + URL routing assume identifier-shape constraints the schema doesn't enforce. Phase 3 client gets confusing "valid in DB, invalid on the wire" errors.
**Recommendation:** Single regex in `Identifier` (`@network_slug_regex`), invoked from `Network.changeset/2` via `Identifier.valid_network_slug?/1`. Drop parallel `@slug_format`. Pick the cap docs commit to (32) and update migration comment if needed.
**Severity:** MEDIUM

### A19. IRC numeric magic numbers — no `Grappa.IRC.Numerics` table
**Concern:** Duplication
**Scope:**
- `lib/grappa/session/server.ex:226` — `{:numeric, 1}` (RPL_WELCOME)
- `lib/grappa/irc/client.ex:387,392,403,409` — `{:numeric, 903}`, `[904, 905]`, `[432, 433]`, `1`
- Test files repeat bare integers
**Problem:** Same RFC numeric (`001` = RPL_WELCOME) is pattern-matched as bare integer `1` in two production files. No `Grappa.IRC.Numerics` module mapping `:rpl_welcome | :err_nicknameinuse | ...` ↔ integers.
**Impact:** Reading case arms requires "what's 433 again?" lookups. Phase 5 reconnect/backoff needs 376/422 (RPL_ENDOFMOTD/ERR_NOMOTD) → coordinated edits across files. Phase 6 listener produces numerics outbound — re-encodes magic integers.
**Recommendation:** Extract `Grappa.IRC.Numerics` with named constants (`@rpl_welcome 1`, `@err_nicknameinuse 433`) + tiny `name(integer) :: atom()` helper for log prettification. Production handlers pattern-match `{:numeric, @rpl_welcome}`. Non-blocking but compounds — Phase 5/6 multiply this 5–10×.
**Severity:** MEDIUM

### A20. Mix tasks halt-on-changeset duplicated 4× (extracted in 1, re-inlined in 3)
**Concern:** Duplication
**Scope:** `bind_network.ex:104-105` already extracts `halt_changeset/2`; `add_server.ex:59-60`, `create_user.ex:45-46`, `update_network_credential.ex:66-67` re-inline the same pattern.
**Problem:** `bind_network.ex` already extracts the helper — proof the pattern was painful enough once. Then three other tasks re-inlined. Half-migrated.
**Impact:** Inconsistent error formatting across tasks. Adding a `--json` mode for scripted operator workflows requires touching every task.
**Recommendation:** Lift `halt_changeset/2` to `Mix.Tasks.Grappa.OptionParsing` or a sibling `Mix.Tasks.Grappa.Output`. Pairs with A11 (Theme 4).
**Severity:** MEDIUM

### A21. `GrappaWeb` Boundary `deps` lists `Grappa.Repo` + over-broad `Grappa.IRC` export
**Concern:** Dependency
**Scope:** `lib/grappa_web.ex:13-22`; `lib/grappa/irc.ex:17` exports `[Client, Identifier, Message]`
**Problem:** Two over-permissive boundary edges:
1. `Grappa.Repo` listed in web deps purely for A4's redundant preload
2. `Grappa.IRC` exports include `Client` — a controller could `Grappa.IRC.Client.send_line/2` directly and bypass Session
**Impact:** Phase 3 — cicchetto adds new endpoints. A controller author can reach `IRC.Client` directly to "save a hop" through Session, and Boundary approves it.
**Recommendation:** Two edges to remove:
1. After A4 lands, drop `Grappa.Repo` from `GrappaWeb` deps.
2. Either split `Grappa.IRC` into `Grappa.IRC.Identifier` (web-safe) + `Grappa.IRC.Client` (NOT web-safe), OR change `Grappa.IRC`'s exports to exclude `Client`.
**Severity:** MEDIUM

### A22. `Networks.scrollback_present?/1` raw `from(m in "messages", ...)` query
**Concern:** Boundaries / Dependency
**Scope:** `lib/grappa/networks.ex:306-314`
**Problem:** Networks runs `from(m in "messages", ...)` — string table name to bypass aliasing the schema, dodging a Scrollback dep cycle. The query duplicates schema knowledge inside Networks; if Scrollback renames the column, sharded the table, or moves storage, the query silently breaks (no schema-time validation).
**Impact:** Phase 5 retention/eviction will likely add a "messages by network with retention metadata" view; same query duplication appears. Phase 6 listener needs to query message presence too.
**Recommendation:** Add `Grappa.Scrollback.has_messages_for_network?/1` (boolean). Networks calls it. Folds into A2 fix (the cycle inversion makes this edge legal).
**Severity:** MEDIUM

### A23. `Session.Server.client_opts/4` returns `map()` — `IRC.Client.opts()` type alias exists, unused
**Concern:** Type system
**Scope:** `lib/grappa/session/server.ex:294` (`@spec client_opts(...) :: map()`); `lib/grappa/irc/client.ex:100-111` (`@type opts :: %{required(:host) => ..., ...}`)
**Problem:** `Session.Server.client_opts/4` is the only producer of `IRC.Client.opts` shape, but its spec lies — `map()` is strictly weaker than `IRC.Client.opts()`. Dialyzer cannot detect a key drift (Session produces `:foo`, Client reads `:bar`) until runtime.
**Impact:** Violates CLAUDE.md "State the contract." If contract is `map()`, the contract isn't stated. The fix is one type alias.
**Recommendation:** `@spec client_opts(...) :: Client.opts()`. Alias already exists; just use it.
**Severity:** MEDIUM (one-line fix; high leverage)

### A24. `Session.Server` state is bag-of-keys map, not `defstruct` with `@enforce_keys`
**Concern:** Type system
**Scope:** `lib/grappa/session/server.ex:90-98` (`@type state :: %{...}`)
**Problem:** Every other long-lived struct in the codebase uses `defstruct + @type t :: %__MODULE__{...}`. Only Session.Server state is a plain `%{}` map. No `defstruct`, no `@enforce_keys`, no compile-time guarantee `state.user_id` exists when read. A typo (`state.user_naem`) silently returns `nil`, then crashes downstream with opaque message instead of `KeyError`.
**Impact:** Hottest GenServer in the system. Phase 5 will add reconnect/backoff state, channel-membership tracking, presence — every new field is open invitation to drift between `@type state` and the map constructor.
**Recommendation:** Promote to `Grappa.Session.Server.State` (or inline `defstruct` inside Server) with `@enforce_keys` on identity fields (`user_id`, `user_name`, `network_id`, `network_slug`, `nick`, `client`). Same shape as `IRC.Client`'s state — established pattern.
**Severity:** LOW (works today; will compound with Phase 5 state additions)

### A25. `Wire.event` tagged `kind: :message` only — Phase 5 needs union
**Concern:** Type / Extension
**Scope:** `lib/grappa/scrollback/wire.ex:48` (`@type event :: {:event, %{kind: :message, message: t()}}`); `lib/grappa_web/channels/grappa_channel.ex:51` (no shape validation on `{:event, payload}`)
**Problem:** Event tagged-tuple hardcoded to `kind: :message`. Channel handler does no shape validation — forwards `payload` verbatim. If a producer ever broadcasts a malformed event, the channel ships garbage to websocket. Wire contract asserted at producer (`Wire.message_event/1`) but not at consumer.
**Impact:** Acceptable today (single producer, single consumer). Becomes a structural problem the moment Phase 5 ships presence events: `Wire.event()` must grow to a `kind: :message | :presence | :state_change | ...` union, every consumer must extend pattern matches in lockstep.
**Recommendation:** When growing this, use tagged-union shape and keep `kind:` a closed atom set so Dialyzer flags exhaustiveness gaps. For now, file as Phase 5 prerequisite — adding kind types BEFORE adding kind values.
**Severity:** LOW (tracker, not actionable today)

### A26. `MessagesController.preload_networks/2` hand-rolled assoc-mutation trick
**Concern:** Cohesion / Boundaries
**Scope:** `lib/grappa_web/controllers/messages_controller.ex:111-113` — `Enum.map(messages, &%{&1 | network: network})`
**Problem:** Manually splatting Network struct into each Message — works because `belongs_to :network` is a normal struct field, but bypasses Ecto's preload mechanism (good for N+1 perf — single network) and reaches into schema struct directly to mutate it. Three pieces of schema-internal knowledge bled out of `Scrollback` into a controller.
**Impact:** Sets a precedent: "if Repo.preload is too slow, hand-construct the assoc field." Phase 3's channel members list, presence will face the same shape and copy this. Right home is `Grappa.Scrollback` — `Scrollback.fetch/5` should take an already-fetched `%Network{}` and return rows with `:network` set.
**Recommendation:** Move `preload_networks/2` into `Grappa.Scrollback` as a public helper. Same fix as A4.
**Severity:** LOW

### A27. `IRC.Identifier.valid_sender?/1` carries non-IRC `<bracketed>` regex (speculative validation)
**Concern:** Cohesion
**Scope:** `lib/grappa/irc/identifier.ex:84-89`
**Problem:** `valid_sender?/1` accepts `<bracketed>` shape ("for non-IRC origins (REST etc.)"). NOT an IRC concept. Identifier supposed to validate IRC syntax. Now it has a third allowlist for non-IRC senders. **No producer in codebase TODAY sets `sender = "<local>"`** — the regex exists for hypothetical REST POSTs. Per CLAUDE.md: "rules for problems we don't have yet."
**Impact:** Phase 6 listener facade reusing this module (per `project_extract_irc_libs.md`) inherits the `<local>` regex it has no use for.
**Recommendation:** Strip `<bracketed>` from `valid_sender?/1`. Add it back, with a separate predicate, the day a producer needs it.
**Severity:** LOW

### A28. `IRC.Identifier.safe_line_token?/1` is a security guard sitting in IRC-syntax module
**Concern:** Boundaries
**Scope:** `lib/grappa/irc/identifier.ex:103-107`; consumed by `Grappa.Networks.Credential.changeset/2`, `Grappa.Scrollback.Message.changeset/2`, `Grappa.Session.send_*/3`
**Problem:** `safe_line_token?/1` rejects bytes that would inject extra IRC commands via CRLF — a wire-protocol-injection guard, semantically the SAME as SQL-injection escaping. Networks imports the module for credential-field validation — Networks now depends on IRC for what is morally a "no control bytes" check that has nothing to do with IRC syntax.
**Impact:** Phase 6 listener facade will need `safe_line_token?` for OUTBOUND-to-PWA-clients fields. Reusing the IRC.Identifier module means the listener facade depends on the upstream IRC client's identifier module. The split-namespace question becomes urgent at hex extraction (`grappa_irc_parser`): `safe_line_token?` is generic wire guard that should travel with parser; `valid_network_id?` (Grappa-internal slug rule) shouldn't.
**Recommendation:** Eventual split: `Grappa.IRC.Identifier` keeps IRC-grammar validators (library-extraction-ready); move `valid_network_id?` to `Grappa.Networks.Slug`. Defer to library extraction milestone.
**Severity:** LOW

### A29. Sandbox setup duplicated 3× across `DataCase`/`ConnCase`/`ChannelCase`
**Concern:** Duplication
**Scope:** `test/support/data_case.ex:23-27`, `conn_case.ex:22-26`, `channel_case.ex:25-29`
**Problem:** Identical 3-line sandbox setup. If sandbox shape changes (Phase 5+ telemetry handler, `shared:` flag semantics shift), three files must move in lockstep.
**Impact:** Low-risk now — sandbox semantics stable. CLAUDE.md "implement once" applies even to test infra.
**Recommendation:** Lift to `Grappa.SandboxSetup` (tiny module exporting `setup_sandbox(tags) :: pid()`), all three templates `import` it.
**Severity:** LOW

### A30. `mix help grappa` returns nothing — no operator-surface index task
**Concern:** Extension
**Scope:** `lib/mix/tasks/grappa.*.ex` — 7 tasks, no `Mix.Tasks.Grappa` index
**Problem:** `mix help` lists every task individually; no narrative grouping for operator surface. README documents them in a long table but in-shell `mix help grappa` returns "task not found" because no task is named bare `grappa`. Operator who learned about `grappa.create_user` from one doc has no way to discover `grappa.update_network_credential` without reading source or README.
**Impact:** Phase 5+ adds more operator tasks. Discoverability problem compounds with task count.
**Recommendation:** Add `Mix.Tasks.Grappa` (no suffix) as help-index task printing all subcommands with `@shortdoc` lines. ~30 LOC.
**Severity:** LOW

---

## Action plan

### Pre-Phase-3 cleanup cluster (~1.5 sessions)

The wire-contract theme is the true gate to Phase 3. Land these as
"cleanup: post-Phase-2 architecture review fixes" cluster commits BEFORE
cicchetto starts consuming the wire shape:

1. **A1** — `Grappa.Networks.Wire` + rename `password_encrypted` accessor (CRITICAL — defends Phase 3 from leaking plaintext NickServ password)
2. **A4** + **A26** — drop web→Repo, push preload into Scrollback (M2)
3. **A5** — `Grappa.Accounts.Wire` mirroring `Scrollback.Wire` (H11)
4. **A7** — lock single error-string casing + envelope (M5)
5. **A8** — single nick-regex sourced from Identifier (M3 — also fixes operator-creatable bad state)
6. **A18** — single network-slug regex sourced from Identifier
7. **A23** — one-line `Session.Server.client_opts/4` spec fix (free leverage)

### Pre-Phase-3 cycle inversion (~1 session)

Land the deferred Networks↔Session inversion BEFORE Phase 3 grows new
operator surfaces that hit the cycle:

8. **A2** + **A6** + **A10** + **A22** — invert the dep, drop registry-key dup, move `pick_server` to Networks, fold A4-related preload into Scrollback

### Theme 4 — operator surface cleanup (~0.5 session)

Bundle as one commit; reduces friction for Phase 3 cicchetto-feedback admin tasks:

9. **A11** + **A20** + **A30** — boot helper + halt-on-changeset extraction + `mix help grappa` index

### Defer to Phase 5 / library extraction

These compound but don't gate Phase 3:

- **A3** (IRC.Client god module split) — Phase 5
- **A9** + **A15** + **A25** (kind catalog centralization + per-kind meta typing) — Phase 5 prerequisite
- **A12** (PubSub wrapper) — Phase 5 telemetry surface
- **A13** (IRC.Client callback behaviour) — pre-library-extraction
- **A14** (auth_method enum unification) — folds into A2 inversion
- **A16** (single safe_line_token? owner) — Phase 5 alongside A3
- **A17** (AuthContext struct) — Phase 5
- **A19** (IRC.Numerics table) — Phase 5 alongside reconnect/backoff
- **A21** (Boundary deps tightening) — alongside A4/A21
- **A24** (Session.Server defstruct) — alongside A3
- **A27** + **A28** (IRC.Identifier split + speculative-validator removal) — pre-library-extraction
- **A29** (sandbox setup helper) — opportunistic

---

## Severity counts by concern

| Concern                       | CRITICAL | HIGH | MEDIUM | LOW | Total |
|-------------------------------|----------|------|--------|-----|-------|
| Abstraction boundaries        | 1        | 3    | 4      | 3   | 11    |
| Cohesion / Responsibility     | 0        | 3    | 3      | 1   | 7     |
| Duplication                   | 0        | 4    | 4      | 1   | 9     |
| Dependency architecture       | 0        | 1    | 3      | 0   | 4     |
| Type system leverage          | 0        | 0    | 2      | 2   | 4     |
| Extension & maintainability   | 0        | 1    | 0      | 1   | 2     |
| **Total (after dedup)**       | **1**    | **9**| **13** | **7**| **30** |

Findings often span multiple concerns — counts above reflect the primary
concern only. Cross-cutting themes (Theme 1 = wire contract; Theme 2 = N↔S
cycle) collapse 5+ findings each into a single fix.

---

## Direction recommendation

The codebase is in **strong** structural shape for Phase 2 maturity (~6,000 LOC,
13 boundaries, 378 tests + 6 properties). The single-source-of-truth modules
(`Wire`, `Topic`, `Log`, `Parser`, `Identifier`, `Meta`, `Catalog` once it lands)
are the right pattern; the gaps are all "promote map() to struct" or
"drop a duplicated allowlist." Dialyzer + Boundary + Credo + Sobelow + property
tests catch most line-level issues.

**Theme 1 (wire contract) is genuinely urgent** — Phase 3 hardens whatever
shape it consumes. The CRITICAL A1 finding (`password_encrypted` JSON-leak
risk via missing `Networks.Wire`) alone justifies the pre-Phase-3 cleanup
cluster. The 5 HIGH wire-contract findings (A4/A5/A7/A8/A18) compound the case.

**Theme 2 (cycle inversion) closes 4 findings with one fix** and was already
queued in CP08 — pulling it forward unblocks Phase 3's operator-surface
extensions.

**Themes 3-5 are deferrable** but flagging now lets Phase 5 design account for
them (the IRC.Client lift + kind catalog + numerics table are all Phase 5
prerequisites that benefit from being designed-in rather than retrofitted).

Recommended sequencing: land cleanup cluster (Themes 1+2+4, ~3 sessions),
land 1 codebase review (CP08 next gate ~CP08 S5), then start Phase 3 with
a clean wire contract and no documented architectural debt blocking new
operator surfaces.
