# grappa-irc — design notes

Companion to [`README.md`](../README.md). The README is the current spec; this file is the chronological **record of decisions** — the conversations that got us here, captured so contributors can see *why* the spec looks the way it does.

Public-safe extract. Many of these decisions happened in open IRC channels and are also summarised on [sindro.me](https://sindro.me/posts/2026-04-20-grappa-irc-reinventing-irc-for-2026/).

---

## One-line mental model

**"grappa is the equivalent of irssi inside tmux."**

— vjt, #it-opers, 2026-04-20. The whole architecture collapses into this sentence when talking to anyone who's been on IRC for more than ten years: a persistent always-on session wrapper, not a second ircd, not a chat-app.

---

## Thesis — IRC as a slow tool

> *"secondo me c'è davvero spazio e desiderio di uno strumento 'lento' come irc"*
> — vjt, 2026-04-23

grappa isn't competing with Slack or Discord. The target audience is people who **want** a tool that's 30 years old, text-only, and indifferent to engagement metrics. No reactions on reactions, no "is-typing", no presence surveillance, no unfurls. Just text, on any device, always on. Counter-reaction to fast-feed churn.

A separate `MANIFESTO.md` will carry this pitch to the public — target audience: *nerd nostalgici* + anyone tired of dopamine-pump chat. Short, punchy, shareable. That document is deliberately not pre-drafted: the key sentence has to come from vjt.

---

## Origins — the Azzurra thread

This is the third instrument built for the same crew over 24 years:

1. **2002 — bahamut-inet6** — forking Bahamut to add IPv6 + SSL because the Italian IRC network needed it. [Post.](https://sindro.me/posts/2026-04-13-bahamut-fork-azzurra-irc-ipv6-ssl/)
2. **2002–2005 — suxserv** — writing IRC services from scratch in C, multithreaded, SQL-backed, because the off-the-shelf ones weren't good enough. [Post.](https://sindro.me/posts/2026-04-14-suxserv-multithreaded-sql-irc-services/)
3. **2026 — grappa + cicchetto** — making the same network liveable on a phone without making it not-IRC. [Kickoff post.](https://sindro.me/posts/2026-04-17-claude-walks-into-it-opers/)

The throughline is "if the existing thing is almost right but not quite, write the thing." Nostalgia is admitted; it is also a feature — the network itself is what persists, and carrying it forward is worth the effort.

---

## Naming

**grappa** (server) + **cicchetto** (client) — the Italian remix of **soju** (Korean distillate) + **gamja** (potato, the accompaniment): an Italian distillate plus the small glass of wine served at a Venetian *bàcaro*. Short, binary, parlante to anyone who's sat in an osteria.

It also doubles as a nod to the [Italian Hackers' Embassy](https://italiangrappa.it/), whose call-sign *Italian Grappa!* has been the shorthand for the Italian village at European hacker camps since 2001. grappa-irc is not affiliated; the reference is in the spirit it was intended — Italian hackers showing up somewhere with a bottle.

*Named 2026-04-20.*

---

## Chronological decision log

Each entry ends with *how to apply* — the durable rule that survives the conversation.

### 2026-04-18 — the pitch

vjt sketched it out in #it-opers: a fleet of processes, one per user, always connected to IRC, exposing an API; plus a web client / PWA that looks as close to irssi as possible. Power users keep their irssi (via a classic bouncer connection); casual users get the PWA and keep their scrollback across disconnects.

**Apply:** the shape is "persistent per-user session + API + irssi-shape PWA." Anything else is a distraction.

---

### 2026-04-19 — rejected: terminal-in-browser + WS-IRC transports

vjt tried several existing bouncers hands-on and didn't like any. Two shapes explicitly ruled out:

- **Terminal in the browser** (weechat-relay + Glowing Bear). Fidelity without abstraction — you're shipping a TTY, not a product.
- **IRC-over-WebSocket** to the web client (soju + gamja's native transport). The client ends up re-implementing IRC protocol state in JS.

**Apply:** the web client does not parse IRC. Ever. REST is the contract; IRC terminates at the server. See README §"Design principles", point 1.

---

### 2026-04-20 — server architecture pitch

Dictated in #sniffo:

- **Server:** Elixir/OTP, one **supervised GenServer per user session**, always connected upstream. Authenticated HTTP API, no server-side UI. Auth via NickServ (SASL login, proxied `REGISTER` signup). State persisted via Ecto+sqlite. Scrollback lazy — pagination on scroll, not firehose. Network-agnostic with sysadmin allowlist. Self-hostable anywhere.
- **Client:** TypeScript-flavoured PWA. Fetches current state on connect, then subscribes to Phoenix Channels for live event push. Visually irssi on desktop; mobile = same irssi shape + touch-ergonomic helpers. No chat-app metaphor.

**Apply:** Phase 1 stack: Elixir + Erlang/OTP + Phoenix + Ecto + `ecto_sqlite3` + own IRC client module (binary pattern matching). Streaming surface is **Phoenix Channels**. Client framework left open (Svelte, SolidJS, lit-html — all integrate with `phoenix.js`, 3KB, framework-agnostic). Themability is a first-class feature (irssi `.theme` grammar is simple, portable to TS).

---

### 2026-04-20 — rejected: forking soju

Verdict: **dead on arrival**. soju's design identity is IRCv3-first — every feature ships as an IRCv3 extension; its WS support is "IRC framing over WebSocket," not REST. A bolted-on REST surface would bifurcate state (IRC message stream vs REST resource tree) and fight the project's DNA; upstream would close the PR with "propose an IRCv3 extension instead."

**Apply:** **read soju for behavior, don't fork it.** Reusable lessons: SASL bridging, scrollback ring-buffer semantics, reconnect/retry policy. The architecture is ours.

---

### 2026-04-20 — IRCv3 is opportunistic, not required

Upstream `CHATHISTORY` is essentially soju + Ergo; not in bahamut-family or ratbox — i.e. absent from the vast majority of deployed networks. grappa must fully function against a classic server speaking only `CAP LS` + SASL; `server-time`, `message-tags`, `labeled-response`, `CHATHISTORY` are bonuses when advertised. Scrollback is **bouncer-owned** (sqlite per user, paginated API; `CHATHISTORY` mapping if/when the IRCv3 listener lands).

**Apply:** never assume IRCv3 on the upstream. The only universal requirements are `CAP LS` + SASL. Everything else is negotiated.

---

### 2026-04-20 — decision: two facades, one store

- **One scrollback store** (sqlite or any KV), shared.
- **Facade A — REST + SSE** — primary, consumed by cicchetto. The design center.
- **Facade B — IRCv3 listener** (`CAP LS` + SASL + `CHATHISTORY`) — secondary, phase 2+. A *view* over the same store for existing IRCv3 mobile clients (Goguma, Quassel mobile). Not a source of truth.
- **No bifurcation rule.** The IRC listener MUST NOT introduce state the REST surface does not also expose. In particular, no server-side `MARKREAD` / read watermark on either facade — per the decision below.

**Apply:** the IRCv3 listener is explicitly **out of scope for v1**, but the scrollback schema must make `CHATHISTORY` a mechanical translation, not a redesign: monotonic msgid, `server-time` on every row, per-channel and per-target indexing, no `MARKREAD` column.

---

### 2026-04-20 — decision: no server-side read cursors

Superseded by the 2026-05-13 "CP29 server-side read-state cluster" entry: read state is now server-owned per (subject, network, channel), and removing the server-side cursor is a breaking change.

---

### 2026-04-20 — decision: the client is the source of truth for UI state

vjt: *"io il server lo terrei puro e semplice / lo stato è lato client / i canali in cui sei è lato client / il server è solo un dispatcher"*. Sonic's counter (*"lo stato è cmq su grappa"*) is correct for **session state** — grappa must persist which networks/channels a user is attached to. The intent is narrower: the **client** owns **UI state** (open channel view, scroll position, theme); the server persists what must survive reconnect.

**Apply:** API exposes *session state* (networks, channels, scrollback), not *UI state* (read cursor, "active channel", unread counts — the client computes those locally).

---

### 2026-04-20 — decision: grappa is not an ircd

> *"grappa NON è un server irc / è un modo per rimanere connessi a irc e accedervi via webapp"*

A classic IRC client bypasses grappa and goes straight upstream. grappa is a persistent-session + REST layer on top of existing IRC — scope control: we do not ship features an ircd would ship.

**Apply:** never pitch grappa as an IRC server. "Always-on session wrapper, consumable from a phone" is correct; "modern IRC server" is wrong.

---

### 2026-04-20 — canonical elevator pitch (vjt's words)

Flagged as *"memorizza queste ultime righe perché sono una bella sintesi efficace di grappa"*. Authoritative phrasing, reusable verbatim:

- *"grappa bnc irc <-> web"* — one-line architecture: bouncer between IRC upstream and web.
- *"cicchetto consuma grappa e mostra UI themabl[e]"* — cicchetto is the client, consumes grappa's API, ships themable UI.
- *"as irssi, mirc, erc, xchat quel che si vuole"* — themability target: parity with classic IRC clients, user picks.
- *"grappa espone anche ircv3 se vuoi usare quassel o simili"* — the phase-2 IRCv3 listener is the downstream facade for mobile IRCv3 clients.
- *"se vuoi usare irssi su grappa praticamente è solo un bnc"* — classic IRC client through grappa = pure bouncer experience.
- *"se invece usi cicchetto o quassel, hai anche la history"* — scrollback is what you gain with cicchetto OR any IRCv3 client.
- *"plain and simple / irc solo irc"* — minimalism as a feature. No images, no voice, no *cagate*.

**Apply:** when describing grappa to a newcomer, lead with `grappa bnc irc <-> web` + `cicchetto consuma grappa`, then fan out: themable UI, IRCv3 facade for mobile, history via cicchetto or IRCv3, *plain and simple* as closer.

---

### 2026-04-25 — decision: Elixir/OTP + Phoenix as the server stack

The 2026-04-20 pitch named Elixir/OTP; pressure-tested before locking Phase 1.

**The four goals (vjt's framing):** multi-decade longevity; excellent client experience (flaky-mobile reconnect, multi-tab); always-on bouncer with per-user fault isolation; a Phase 6 downstream IRCv3 listener on the same scrollback.

**Alternatives rejected:**

- **Rust** (tokio + axum + sqlx + `irc` crate). Plausible; better LLM training corpus (~15-20% more idiomatic first-pass generation, named honestly). Rejected because the architecture grappa needs is BEAM's textbook example — re-implementing supervision + per-user fault isolation + multiplexed pub/sub-over-WebSocket in userspace Rust is ~2300 LOC of plumbing BEAM gives free, plus months of mobile-network polish on a WS client library that doesn't exist.
- **Go.** Would subconsciously drift back toward soju's IRCv3-first DNA, fighting the REST-first design center.
- **Zig.** Too early in 2026; 0.x churn, ecosystem too sparse for HTTP/WS/SQL.

**Why Elixir wins for THIS shape:** (1) one-persistent-supervised-process-per-user IS the runtime — `DynamicSupervisor` + `Registry` + `:transient` ≈ zero LOC of plumbing; (2) **Phoenix Channels >> SSE** — `phoenix.js` handles reconnect-with-backoff, topic re-subscription, network-change events, replay; battle-tested at Discord/Slack scale; no Rust equivalent exists — the single biggest material advantage for the user-facing experience; (3) binary pattern matching makes the Phase 6 IRC parser/state machine pleasant (telecom bytes are what Erlang was built for); (4) BEAM's 35+ year backwards-compat record for long-lived stateful systems (WhatsApp 2009, Discord 2015, Ericsson late-80s code still running); (5) per-process runtime introspection (`:observer_cli`, `:recon`, `:sys.get_state/1`) that `tokio-console` doesn't approach.

**Tradeoffs accepted, named honestly:** vjt OTP ramp 2-4 weeks (concurrent-C experience from suxserv/bahamut transfers); Claude ~15-20% less idiomatic Elixir first-pass — compensated by a **rigid all-mandatory CI gate baseline** (`mix format --check-formatted`, `credo --strict`, `dialyzer`, `sobelow --config --exit-on-medium`, `deps.audit` + `hex.audit`, `doctor`, `test --warnings-as-errors --cover` with a ratcheting floor, `docs`); `exirc` stale on hex → write our own IRC client, ~500-1000 LOC of binary-pattern-match code reusable for the Phase 6 listener parser (advantage, not punishment); larger Docker image (irrelevant — Docker is the deployment target).

**Apply:** Phase 1 stack is **Elixir 1.19 + Erlang/OTP 28 + Phoenix 1.8 + Ecto 3 + ecto_sqlite3 + own IRC client module**. Streaming facade is **Phoenix Channels**, not SSE. Every CI gate is mandatory, none advisory — they exist to compensate the first-pass fluency gap; every gate that fires saves a review round-trip.

---

### 2026-04-25 — sub-decision: hot code reload is NOT load-bearing

Raised and resolved before locking the language. Considered: **nginx-style fd-passing in Rust** (works for the inbound listen socket; fails outbound — rustls can't adopt an in-progress TLS session from serialized state, and IRC protocol state would need bespoke serde; research-project territory); **split-process Rust** (`irc-connd` + `grappa-api` — ~70% of the value, useless when patching IRC handler logic itself); **BEAM hot reload** (free, but rarely used cleanly for stateful long-lived processes).

**Decision: reconnect-on-deploy is acceptable.** Major releases restart cleanly; users see a brief quit/join flood; sysadmins manage release windows. Elixir won on the OTHER axes, not hot-reload.

**Apply:** do not over-invest in zero-downtime upgrade infrastructure during Phase 1-5. Connection-resume on the IRC side is a Phase 5+ concern, not a baseline requirement.

---

### 2026-04-25 — Phase 2 auth = opaque session IDs + sliding 7d, NOT JWT

JWT (any flavour — long-lived bearer, access+refresh, rolling) is the wrong tool for grappa's threat model. JWT was designed for stateless cross-service fan-out, federated identity (OIDC), and edge auth — NOT for a monolithic one-DB app that needs real revocation, an "active sessions" UI, or theft mitigation. Every path to those with JWT (`token_version` on users, `jti` blocklist) reintroduces a DB lookup per request and defeats the stateless win, leaving only the footguns (`alg: none`, HS256/RS256 confusion, key-rotation cascade). Five rounds of "can we just JWT?" all ended at the same place: sliding + revocation = state required.

**Shipped shape:** opaque UUID session ID as bearer (`Authorization: Bearer <session_id>`), server PK lookup per REST request (sub-ms; ~200 lookups/hour for an active user — invisible), `last_seen_at` UPDATE rate-limited to 60s, idle-7d via `now - last_seen_at`, `revoked_at` for explicit revocation. Per WS Channel: ONE lookup at `connect/3`, then zero for socket lifetime (identity pinned in `socket.assigns`). Per inbound IRC PRIVMSG: zero auth lookups (PubSub fans out to already-authenticated subscribers). Deliberately NOT signed Phoenix.Token — signing adds nothing when verification is a DB lookup anyway. The opaque `sessions` table is provider-agnostic: OAuth / WebAuthn / magic-link later each mint an identical session row; JWT couples auth flow to token format.

**Apply:** if stateless tokens are ever genuinely needed (unlikely), use **PASETO**, not JWT — same stateless property, no `alg` field, no algorithm-negotiation footgun.

---

### 2026-04-25 — Phase 2 crypto layering = server-side encryption-at-rest only; e2e is OTR-in-cicchetto

Decided after vjt's pushback on env-key-on-disk: "for real e2e security, none of this is the answer. The answer there is OTR. And cicchetto will support OTR."

| Threat | Defense |
|--------|---------|
| Passive sqlite-file theft (lost backup, stolen Pi, accidental commit) | Cloak.Ecto AES-256-GCM, env key (`GRAPPA_ENCRYPTION_KEY`) |
| Active server compromise (root'd, hostile operator, subpoena) | **OTR / OMEMO in cicchetto, ciphertext-on-wire** |
| Network surveillance (wire-tap on upstream IRC) | OTR + TLS |
| Endpoint compromise (your phone is rooted) | Nothing helps. Game over. |

Server-side encryption-at-rest covers ONLY the first row; it is not pretending to be e2e. Rejected: user-password-derived keys (decrypt NickServ creds only while logged in) — improves passive-theft but restart = mass logout, idle 8d = upstream disconnect; it sacrifices "always-on" for a property that doesn't even defend against active compromise. OTR in cicchetto (Phase 4+) covers threats 2-3: standard `?OTRv3?` PRIVMSG handshake, ciphertext in PRIVMSG bodies, upstream and grappa scrollback both see opaque text, forward secrecy + deniability free. Zero server-side work: `body` stays opaque UTF-8, no new schema, no new endpoint.

**Apply:** server-side crypto schemes for user message bodies ("encrypted messages at rest", "per-user message keys") are NEVER proposed for any future phase — that's OTR's job; route e2e/privacy questions to OTR-in-client. Phase 5+ may add HSM-keyed Vault (yubico-hsm / TPM / KMS) for operators escaping "env on disk"; Cloak.Vault makes that pluggable without code changes.

---

### 2026-04-25 — Phase 2 schema = irssi-shape (network 1:N servers, per-user credentials)

vjt: "let's reuse irssi schema here. server belongs to chatnet, chatnet has many servers." Matches how operators think: round-robin DNS endpoints, plain-6667 vs TLS-6697 are different server rows.

Three-table split: `networks` (integer pk + unique slug), `network_servers` (network_id FK + host/port/tls/priority/enabled, unique `(network_id, host, port)`), `network_credentials` (composite pk `(user_id, network_id)`; nick + realname + sasl_user + `password_encrypted` (Cloak) + auth_method enum + autojoin_channels).

**`networks.id` integer + slug:** text PK rejected (rename = cascade across messages/credentials); UUID rejected (adds nothing — stable lifecycles, non-sensitive list; integer is faster joins, simpler debug).

**Multi-server failover: schema-ready Phase 2, logic-deferred Phase 5.** `priority` + `enabled` ship now; Session uses the first enabled server; Phase 5 adds the round-robin/backoff machine as a pure logic addition, no migration.

**Per-user iso on messages (decision G):** `messages.user_id` UUID FK + index `(user_id, network_id, channel, server_time DESC)`. Each Session.Server writes its own scrollback rows from its own wire view — per-user model, not shared-de-duped (the de-dup key would be fragile under server-time latency variance, and each user's session sees joins/parts/kicks differently).

**Apply:** new IRC-network tables follow the irssi shape (logical network row + many physical endpoints); per-user resources composite-key on `(user_id, network_id[, channel])`; `messages.user_id` is the discriminator for ALL scrollback queries, no fetch path bypasses it; wire payloads NEVER carry `user_id` (decision G3 — client knows its own from `/me`, server filters from authn'd context).

---

### 2026-04-25 — Phase 2 PubSub topic shape break + per-network upstream `auth_method` state machine

**Topic break:** Phase 1 `grappa:network:{net}/channel:{chan}` → Phase 2 `grappa:user:{user}/network:{net}/channel:{chan}`. Phoenix.PubSub topics are global string namespaces, not socket-scoped; without the per-user discriminator, a multi-user instance broadcasts user A's events to user B's subscribers. vjt asked "can't the user be inferred from the session?" — only via a custom dispatch layer filtering every message per subscriber, which loses native ETS fanout + Phoenix.Presence, adds a routing layer of bug surface, and reinvents the wheel. Standard Phoenix shape: the topic string encodes the discriminator; wire surface (REST URLs, JSON keys) unchanged; user never in payloads.

**Single source of truth:** `Grappa.PubSub.Topic` builders (Phase 2 sub-task 2h). NO inline topic string interpolation anywhere; all future topics follow `grappa:user:{user}/...`. **Authz at Channel join:** `socket.assigns.user_id == topic_user_id else 403` — assigns = authenticated identity, topic portion = requested stream; the check ensures you subscribe only to your own.

**auth_method state machine (2f):** enum on `network_credentials`: `auto | sasl | server_pass | nickserv_identify | none`.

| Method | Flow | Networks |
|--------|------|----------|
| `sasl` | CAP LS 302 → REQ :sasl → AUTHENTICATE PLAIN → 903/904/905 → CAP END | ergo, Libera, Snoonet |
| `server_pass` | PASS before NICK/USER; server hands off to NickServ at register_user end | Azzurra (Bahamut), Unreal-with-services |
| `nickserv_identify` | NICK/USER → 001 → PRIVMSG NickServ :IDENTIFY pwd | Rare networks where neither PASS nor SASL works |
| `none` | NICK/USER only | IRCnet, open networks |
| `auto` | Default | Most operators |

`auto`: send PASS first if a password is present, always CAP LS 302 + NICK/USER, then react — sasl advertised → SASL flow; `421 Unknown command CAP` → server already handled PASS via NickServ if configured; 001 → autojoin. NickServ NOTICEs logged but not parsed in Phase 2 (Phase 5 hardens: reply parsing + post-001 `+r`-umode check falling back to `PRIVMSG NickServ :IDENTIFY` — catches PASS-not-bound edge cases and silent failures).

**Bahamut PASS-handoff verified via source dive:** `bahamut-azzurra/src/s_user.c:1273-1278` — at the end of `register_user()`, a stashed PASS triggers a server-side `SIDENTIFY` PRIVMSG to NickServ. Poor-man's SASL: auth at register-time via the legacy PASS field, no race, no post-001 IDENTIFY dance. Bahamut's `CAPAB` strings are server-to-server negotiation (TS3, NOQUIT, SSJOIN, BURST), NOT IRCv3 client `CAP LS`.

**Apply:** operator declares `auth_method` at `mix grappa.bind_network`; `auto` is safe for ~99% of networks; explicit `sasl` forces no-PASS-fallback for operators worried about leaking the password to networks that don't bind PASS to services; `nickserv_identify` is the explicit override for the rare network where neither works.

---

### 2026-04-25 — sub-decision: single sqlite file, not per-user `.db`

Alternative considered: one `.db` per user, lazily started Repos via `put_dynamic_repo`. What it buys: zero cross-user writer contention, per-user delete/export = file ops, sqlcipher option, crash isolation, trivial disk quota.

What it costs: (1) plumbing tax forever — every context fn gains a `user_id` arg + `with_user_repo` wrapper (~200 LOC + 200 risk points); (2) a silent-bug class — one forgotten `put_dynamic_repo` writes alice's messages into bob's DB, and the mitigation ("never start a default Repo") breaks `mix ecto.migrate`, LiveDashboard, and bare iex; (3) custom migration runner iterating all user DBs + schema-drift decisions at boot; (4) cross-user aggregates need fan-out helpers; (5) N× connection-pool memory; (6) the performance argument is fake at this scale — ~83 msg/sec write rate vs sqlite WAL's 10k+/sec on a Pi.

**Coherence beats theoretical isolation.** The codebase IS the instruction set; half-`user_id`-first-args = drift. Privacy-via-file-separation is theater for a single-operator bouncer where the operator can read the file regardless. **Flip-condition, named:** if grappa ever becomes a multi-tenant adversarial-isolation product, per-user `.db` is correct *upfront* — retrofitting privacy after a shared schema is harder than the ergonomics tax. Current spec: single Pi, single operator, trusted few.

**Also rejected: PostgreSQL/MySQL.** A server DB adds a separate process, ~250MB idle RAM on the Pi, dump-based backups, config tuning, a network hop — zero benefit two orders of magnitude under the WAL ceiling. If scale ever flips, Postgres is the upgrade target, not MySQL (better SQL semantics, JSONB, no utf8mb4 trauma, better Ecto integration).

**Apply:** one `Grappa.Repo`, single db file, standard `Ecto.Adapters.SQL.Sandbox` per-test isolation, normal `mix ecto.migrate`. Revisit only on the multi-tenant flip-condition.

### 2026-04-26 — Phase 2 close: User.name format is free-text, not enum

`Grappa.Accounts.User.name` is `:string` with `validate_format ~r/^[a-z0-9_-]{1,32}$/i` — a free-text identifier, NOT an `Ecto.Enum`. The atoms-or-typed-literals rule applies to closed sets the *code* knows about (message kinds, auth methods); the User namespace is operator-extensible at runtime (`mix grappa.create_user`). The format excludes whitespace, control bytes, IRC framing chars (`!`, `@`, `:`, `,`), and locale-dependent normalization (`String.downcase/1` is locale-aware on UTF-8). The 32-char ceiling is below IRC's typical NICKLEN (Azzurra ships NICKLEN=30) so a User.name can be used AS the upstream nick — though the per-credential `nick` field is the canonical IRC identity. What it buys: clean URLs, clean Logger metadata (`user=vjt`), clean topic shapes (`grappa:user:vjt`). The UUID PK stays for FK purposes.

### 2026-04-26 — Phase 2 close: Network.slug is URL- and topic-safe

`Network.slug` is `:string` with `validate_format ~r/^[a-z0-9-]{1,32}$/` — like User.name but lowercase-only, no underscore, slug-safe by construction (RFC 3986 reserved chars + topic delimiters all excluded). The slug rides three surfaces that all require passthrough safety: REST paths (`/networks/azzurra/...`), PubSub topics, operator CLI argv. Free-text would force escaping at every layer. Trade-off accepted: display name lost; a future `Network.display_name` column can ride alongside — the slug stays the load-bearing identifier.

### 2026-04-26 — Phase 2 close: G2 wipe-and-rebuild over migration

Phase 1's `messages.user_id` was free-text (hardcoded `"vjt"`); Phase 2 made it a UUID FK to `users.id`. Chose **wipe + recreate the dev/prod DB** over a backfill migration: the data was throwaway walking-skeleton chatter; backfill was semantically impossible (rows pre-date the operator's account — the FK would be fabricated); 60+ lines of migration scaffolding for data about to be deleted. **Flip-condition:** had Phase 2 landed after any production deploy with real scrollback, the migration would have been mandatory regardless of cost.

**Apply:** from post-Phase-2 close onward, schema changes that touch FK columns get migrations, not wipes.

### 2026-04-26 — Phase 2 close: no `delete_network/1`; cascade-on-empty-unbind only

Superseded twice: the admin-panel B1 cluster added an explicit, doubly-gated `Networks.delete_network/1`; GH #105 (see the 2026-06-28 entry) removed cascade-on-empty-unbind and the `:scrollback_present` rollback — unbind now ONLY detaches the credential, never deletes the network.

### 2026-04-26 — Phase 2 close: IRCv3 CAP ACK gate + Bahamut PASS-handoff verification

`Grappa.IRC.Client`'s registration handshake gates SASL behind a CAP LS / CAP REQ / CAP ACK round-trip. Non-ACK → fall through to `:server_pass` (PASS handoff) when `auth_method: :auto`, OR raise `:sasl_unavailable` when `:sasl` was explicit.

**Why the gate:** per IRCv3.2, sending `AUTHENTICATE PLAIN` after a non-ACK is undefined behavior — servers variously ignore it, 421, or 904. The ACK gate makes the unsupported branch deterministic.

**The Bahamut detail:** Azzurra runs Bahamut 1.4(34). Bahamut accepts `PASS <pw>` BEFORE NICK + USER, stashes it, and post-001 routes it to NickServ via the services protocol (`s_user.c` reference in the 2026-04-25 auth_method entry). Modern Anope/Atheme do the same. `:server_pass` emits PASS first, then NICK + USER, then waits for 001 — exactly the flow Bahamut expects.

**`:sasl_unavailable` rationale:** an operator who explicitly chose `:sasl` picked pre-001 auth (no IRC traffic before auth); silently falling back to PASS-as-NickServ (post-001 — a brief window on the network as the unidentified nick) would change the auth boundary. Fail loud; the operator updates the credential or accepts the weaker boundary explicitly.

### 2026-04-26 — Phase 2 close: NoServerError as exception, not `{:error, :no_server}`

`Grappa.Networks.NoServerError` (post-A2/A10 module moves) is RAISED, not returned, when `Networks.Servers.list_servers/1` returns `[]` at session-init. Under `restart: :transient`, an `{:error, _}` from `init/1` and a raise both make the supervisor retry against unchanging state — the difference is the **operator log**: the tuple yields a one-liner "child failed: :no_server"; the exception yields a stack trace pointing at `Server.init/1` plus the network slug. For an operator-action failure (forgot `mix grappa.add_server`), the stack trace is the better signal. Phase 5 mitigation queued: refuse `bind_credential/3` until at least one Server row exists — invariant at the API surface, not the runtime.

### 2026-04-26 — Phase 3 cicchetto stack: SolidJS + TypeScript + Vite + Bun + Biome

The choice is load-bearing — re-platforming after Phase 4 cements themes + keybindings would cost weeks. **Chosen:** SolidJS 1.9 + TypeScript 6 + Vite 8 + Bun 1.3 + Biome 2.4 + `phoenix.js` 1.8.

**Why:** Solid's fine-grained reactivity matches the workload — every IRC event is a separate Channel push (busy channels: hundreds of events/sec); signals re-render only the changed DOM node, no VDOM diff over thousands of scrollback rows. TypeScript extends the server's typed JSON contracts across the boundary — one contract, two languages, compile-time-checked. Vite is Solid's first-party bundler. Bun replaces npm + node entirely (`oven/bun:1` image matches the `scripts/bun.sh` oneshot wrapper discipline mirroring `scripts/mix.sh`). Biome replaces ESLint + Prettier — one Rust-fast tool, one config, mirroring the `mix format` + credo single-source principle.

**Rejected:** **React** — VDOM cost wrong for the workload; the device that matters is an iPhone on cellular; ecosystem/corpus advantage doesn't outweigh it. **Svelte** — thinner WS ecosystem; phoenix.js maps directly onto Solid signals, Svelte stores need a wrapper layer. **Plain lit-html** — too minimalist; the irssi-shape UI needs enough state machinery that we'd reinvent 80% of Solid. **htmx + SSR** — loses the PWA offline story, the install path, and the WS-push model. **Web Components** — shadow-DOM CSS isolation actively fights the one-global-theme goal.

**Tradeoffs named honestly:** Claude ~10-20% less idiomatic Solid vs React first-pass (same mitigation playbook as Elixir: rigid CI gates + accumulated pattern notes); Bun younger than Node — stick to Bun-first or framework-agnostic packages, Phase 5 item if a dep ever forces Node-only; Biome's thinner plugin ecosystem covers ~95% and the missing 5% (React-specific rules) doesn't apply.

**Apply:** cicchetto lives at `cicchetto/` in THIS monorepo (CP09 correction). NEVER raw `bun`/`npm`/`node` on the host — `scripts/bun.sh` only. CI gates: Biome lint + format, tsc strict, vitest — all mandatory. Future "modernize" temptations (Next.js, Tailwind, pnpm) MUST re-litigate this entry; the rejections don't expire. Prod: `cicchetto-build` oneshot builds `dist/` into the `cicchetto_dist` volume; nginx serves the SPA with `try_files` + reverse-proxies `/auth /me /networks /healthz /socket` to `grappa:4000`; the bouncer container does NOT bundle the frontend.

---

### 2026-04-26 — Phase 2 close: `password_encrypted` redact:true is post-load symmetry

Both the Cloak column `password_encrypted` AND the virtual `:password` field carry `redact: true`; dropping either leaks plaintext in a different lifecycle phase. Cloak's `:load` callback decrypts on fetch — AFTER load, `password_encrypted` holds the CLEARTEXT in memory (and `:password` is nil, being input-only); BEFORE load (changeset shape), `:password` holds the plaintext. The original 2f code missed the encrypted-column half; review I3 caught that `IO.inspect(credential)` after a fetch printed the cleartext.

**Apply:** any Cloak-encrypted column whose load-decrypted value is sensitive carries `redact: true` on the encrypted column itself, not just the virtual input field. Redaction is symmetric with the field's lifecycle, not with its name.

---

### 2026-04-26 — Phase 3 wrap: WS `check_origin` is the defense-in-depth on bearer-in-querystring

The Channels WS connect carries the bearer as `?token=…`; `check_origin` is the second line — Phoenix validates the handshake's `Origin` header against an allowlist BEFORE bearer auth runs. Phase 3 shipped without overriding it, so prod inherited Phoenix's default ("match the endpoint URL host") = localhost — **every real WS connect from `http://grappa.bad.ass` was rejected** until `config/runtime.exs`'s prod block read `PHX_HOST` into both `url:` and `check_origin:`.

**Two layers, both load-bearing:** (1) bearer-in-querystring authn in `UserSocket.connect/3` rejects unknown/expired/revoked tokens; (2) `check_origin` rejects foreign-origin handshakes before the bearer is even read — defense-in-depth against XSS-chain-exfil shapes.

**Apply:**

- Any deployment under a new hostname MUST set `PHX_HOST` in `.env`.
- The `//host` scheme-relative form covers both http + https — keep the form across TLS migration.
- A future feature needing a different host (e.g. a login-free public-status endpoint) lands as a separate Phoenix.Endpoint, not as a relaxation here.
- `filter_parameters` includes `token` AND nginx suppresses `access_log` for `/socket`. Both mandatory; either alone leaves the bearer in a different log file.

---

## 2026-04-27 — vite-plugin-pwa swap-in (CP10 S2)

CP10 review caught two coupled cache-busting bugs in the home-rolled service worker (`cicchetto/public/sw.js`): a static cache name that never bumped, and a shell precache list referencing hashed `/assets/*` it didn't actually pre-cache — after any deploy, installed PWAs stayed pinned to the first-install shell forever. Replaced with vite-plugin-pwa in `generateSW` mode: Workbox embeds the precache manifest into the SW bytes at build time, so any asset-hash bump changes the SW content, the browser detects the update, and activate evicts the prior precache. (CP10 HIGH S2/S3.)

**Apply:**

- Manifest lives in `cicchetto/vite.config.ts` under `VitePWA({ manifest: ... })` — single source, no `public/manifest.json` to keep in sync.
- `registerType: "autoUpdate"` (shell-only cache; stale assets are never useful). `injectRegister: false` with explicit `virtual:pwa-register` registration in `main.tsx` — pinning beats plugin-internal heuristics.
- `navigateFallbackDenylist` (`/auth`, `/me`, `/networks`, `/socket`) covers navigation-mode edge cases only; REST fetches and WS upgrades bypass `NavigationRoute` architecturally — **the denylist is NOT what protects the REST + WS surface**. Add new prefixes in lockstep with `router.ex`.
- **Legacy cache leak (one-shot per device):** Workbox's `cleanupOutdatedCaches` only deletes caches named `*-precache-*`, so pre-CP10 installs carry the old `cicchetto-shell-v1` cache forever — harmless, intentionally NOT cleaned (an `injectManifest` custom SW costs more than the leak).

---

## 2026-04-27 — `init/1` defers connect via `handle_continue` (CP10 S3, C2)

CP10 caught blocking `:gen_tcp.connect` + TLS + handshake inside `IRC.Client.init/1`, and sync `Client.start_link/1` inside `Session.Server.init/1` — a flapping or black-holed upstream froze Bootstrap's sequential reduce over credentials and serialized every `start_child` through the singleton SessionSupervisor. The connect timeout additionally defaulted to `:infinity` — a SYN-dropped router could deadlock boot forever. (CP10 HIGH S1 + S12.)

Fix: both inits return `{:ok, state, {:continue, _}}`; connect + handshake (Client) / `Client.start_link` (Session) moved to `handle_continue/2`; connect timeout pinned to 30_000 ms explicitly on both `:gen_tcp.connect/4` and `:ssl.connect/4`.

**Apply:**

- The `{:continue, term}` carries the connect inputs, NOT stashed on the runtime struct — the struct stays sealed, and Phase 5 reconnect/backoff needs a different continue shape anyway.
- The pre-continue `socket: nil` / `client: nil` window is OTP-safe: `handle_continue/2` runs before any mailbox dispatch; even `:sys.get_state/1` queues behind it.
- **TLS posture warning fires in `init/1`, NOT the continue** — the trap_exit/spawn-based warning test would race the continue (linked EXIT kills the Client before it runs). Load-bearing placement until S24 moves it to Bootstrap.
- **Bootstrap semantic SHIFTED:** connect refusal is now async — Bootstrap reports `started=N failed=0` for any row passing init validation; `:transient` retries to `max_restarts`, then the child terminates permanently. Operators grep `(stop) {:connect_failed, _}` from the Session crash trace.
- **`Session.stop_session/2` race closed:** `terminate_child/2` returns when the child is dead, but the Registry's own monitor may not have processed its DOWN yet. `stop_session/2` now monitors the pid itself, awaits the DOWN (5s budget, `Logger.error` on timeout — a silent timeout would leave the next `start_session/3` racing a zombie `:already_started`), then polls `Registry.lookup` until the entry is gone.
- **Test discipline:** pin the init contract via `Server.start_link/1` directly, NOT `Session.start_session/3` — the supervisor path exhausts `max_restarts: 3` in <100ms on connect-refused and torches every other Session in the test run.

---

## 2026-04-27 — `MessageKind` mirrors server enum, exhaustive switch enforces drift (CP10 S4, C3)

Pre-fix the TS `MessageKind` union carried 3 of the server's 10 `Grappa.Scrollback.Message.kind()` atoms; the renderer's fallback framed everything else as PRIVMSG — Phase 5 presence kinds would have shipped as PRIVMSGs silently, no compile-time signal. Fix, both halves: the union widened to all ten kinds verbatim (snake_case wire strings), and `ScrollbackLine`'s `renderBody/1` switch exhausts the union with a `default` arm `const _exhaustive: never = msg.kind` — any future kind addition is a compile error, no `as` cast, no runtime fallback.

### Five load-bearing apply rules

1. **Wire-shape source of truth is the server.** TS union mirrors `Message.@kinds` verbatim; extend both in the same commit. Never add a client-only kind — no producer exists, and it breaks the server's exhaustiveness invariant.
2. **Atom forms are the wire forms.** Jason serializes via `Atom.to_string/1` — `:nick_change` → `"nick_change"`. No kebab, no camel, no transform; both the Wire moduledoc and the TS docstring pin this.
3. **Framing follows irssi convention:** PRIVMSG `<nick> body`, NOTICE `-nick- body`, ACTION + presence/op kinds `* nick <verb> [target]`. Presence meta fields (mirror of `Scrollback.Meta`'s allowlist) narrow defensively against the wire-side `Record<string, unknown>` so a malformed broadcast degrades to `?` rather than crashing the renderer.
4. **`reasonOf/1` defends against future reshape:** reads `body` first, falls back to `meta.reason` — if the server ever shifts reason into meta (the S29 fix path), the client doesn't silently drop it.
5. **Type-system gate AND runtime contract, in lockstep** — the canonical pattern for any client-side mirror of a server-side closed-set atom enum.

Phase 4 note: the renderer includes the channel name on `:join`/`:part`/`:kick` lines; irssi convention drops it inside a single-channel pane — inline TODO for the buffer redesign.

---

## 2026-04-27 — `Application.{put,get}_env/2`: boot-time vs runtime (CP10 S5, C4)

**The principle:** `Application.{put,get}_env/2` is a boot-time configuration mechanism, not a runtime IPC channel. Allowed: `config/*.exs`, `application.ex` start/2, and mix-task helpers BEFORE `Application.ensure_all_started/1` — the `Mix.Tasks.Grappa.Boot.start_app_silent/0` put_env is the canonical instance, mirror-symmetric with `config/test.exs`; the discriminator is the `ensure_all_started/1` boundary, not the helper name. Banned: GenServer callbacks, controllers, contexts, plug bodies, release tasks — inject via `start_link/1` opts; the supervisor reads env at boot and threads values in.

**What changed:** `lib/grappa/release.ex` dropped `fetch_env!(:ecto_repos)` for a hardcoded `@repos [Grappa.Repo]` — release tasks are runtime (post-`load_app/0`), the iteration was dead Phoenix-template generality, and hardcoding makes the dep edge grep-visible. `boot.ex`'s put_env kept; the review's two alternatives both lost — "exempt this site" grows an exemption list (the discipline failure mode), and injecting `:bootstrap?` through `start/2` either reduces to compile-time config or hand-rolls a duplicate child list. The CLAUDE.md rule was rewritten to the boot-vs-runtime form.

**Why the distinction matters:** the ban targets config-as-IPC — two sites coupled through a global key with no explicit dep edge, hiding drift and making tests order-fragile. Pre-`ensure_all_started/1` put_env has no concurrent reader and sits five lines from the start call. TIMING is the discriminator. Future sites ask "boot-time or runtime?", never "is this module exempt?"

---

## 2026-04-27 — Sub-contexts split by VERB, not by NOUN (CP10 S12, D1/A2)

**The principle:** when a context grows past three or four distinct responsibilities, split sub-modules **keyed by the verb**, not by the shared noun. Schemas stay put (the noun IS the schema); the verbs (CRUD, lifecycle, resolve, render) each get a module; all under one `Boundary` umbrella so the dep graph stays explicit at the context level. This is the concrete shape of CLAUDE.md's "reuse the verbs, not the nouns."

A2: `Grappa.Networks` (501 lines, 17 public fns) had absorbed four verb-shapes — network slug CRUD, server endpoint CRUD + selection, credential lifecycle (Cloak), session-plan resolution — because they all touched the `Network` schema. Split: slim `Grappa.Networks` core (slug CRUD) + `Networks.Servers` + `Networks.Credentials` + `Networks.SessionPlan`; schemas + Wire + NoServerError unchanged. Sub-modules inherit the parent boundary; `exports:` extended. Mechanical move, no behavior change.

**Why noun-keyed was wrong:** moving fields into smaller schemas fragments query bodies while the verbs still pile up somewhere — usually back on the umbrella, defeating the split. Verb-keyed keeps the FK shape stable and gives each responsibility a single point of edit: Phase 5 multi-server failover lands in `Servers`, the credential REST surface in `Credentials`, not the umbrella.

**Load-bearing because** three god-modules surfaced in the same architecture review: `Grappa.Networks` (A2), `Grappa.IRC.Client` (A3), `cicchetto/src/lib/networks.ts` (A4) — each absorbed multiple verbs around a shared noun. The pattern applies to all three; every future "where does this go?" routes to "which verb is this?", not "what noun does it touch?"

---

## 2026-04-27 — Pure-FSM extraction prep (CP10 S13, D2/A3 — corollary to D1/A2)

D2 applied the verb-keyed principle to a state-machine-shaped verb: the ~250-line upstream registration handshake extracted from `Grappa.IRC.Client` into pure `Grappa.IRC.AuthFSM` — no process, no Logger, no socket. `step(state, %Message{})` returns `{:cont, state, [iodata]} | {:stop, reason, state, [iodata]}`; the host GenServer interprets the iodata list and does the I/O via `transport_send/2`.

> **When the verb is a state machine, extract it as a pure module returning `(state, [side_effect_payload])` from a `step/2`-style function; the host GenServer does the I/O.** Payoffs: (1) transition tests without orchestrating fakes; (2) the FSM shape is reusable across host shapes — Phase 6 listener facade, Phase 5 reconnect helper, replay/conformance tools. The FSM does not know which direction the bytes flow or what process owns the socket.

The 4-tuple `{:stop, reason, state, [iodata]}` was the small discovery: the review prescribed a 3-tuple, but the SASL `cap_unavailable` case must flush a final `CAP END` on the way to a stop. A future listener-facade FSM will likely need the same trailing-flush channel (e.g. emit `421` before stopping).

---

## 2026-04-27 — Verb-keyed split is language-agnostic (CP10 S14, D3/A4 — corollary to D1/A2 + D2/A3)

D3 applied the same principle to cicchetto's god store (`src/lib/networks.ts`, 280 lines, 9 concerns: three resources, per-channel scrollback state, unread + selection, the WS join effect, all in one `createRoot`). Split into `networks` / `scrollback` / `selection` / `subscribe`.

> **The verb-keyed principle is language-agnostic; the implementation primitive differs.** Elixir: Boundary umbrella, schemas in shared low-level modules, verbs in per-verb modules, Boundary enforces dep direction. TS/Solid: `lib/` umbrella, wire types in `api.ts` (+ `channelKey.ts` brand), verbs in per-verb module-singletons; tsconfig strict + import discipline stand in for Boundary — acceptable at this codebase size. **The lifecycle primitive is the verb's natural unit-of-isolation:** OTP supervisor + `:transient` pairing in Elixir; `createRoot` + `createEffect(on(token, …))` cleanup arm in Solid (the C7/A1 identity-transition pattern).

Three applications across two languages and three verb shapes (function-shaped, FSM-shaped, module-singleton) validate the principle. The cross-module **ingestion verb** pattern holds in TS as in Elixir: `appendToScrollback` + `bumpUnread` are public verbs consumed by `subscribe.ts`'s WS handler — one producer, each consumer store updates via its own verb; never duplicate the mutation logic in the consumer.

---

## 2026-04-27 — E1 / A6 closure: EventRouter extraction (4th verb-keyed split)

Closes A6: wire, schema, and renderer all advertised 10 message kinds; the producer (`Session.Server.handle_info`) persisted only `:privmsg`. Closed end-to-end:

1. **`Grappa.Scrollback.persist_event/1`** replaces `persist_privmsg/5` — explicit `:kind`, no `\\` defaults, single write-side door for all 10 kinds.
2. **`Grappa.Session.EventRouter`** — new pure module mirroring AuthFSM. `route/2` returns `{:cont, new_state, [effect]}`; effects are `{:persist, kind, attrs} | {:reply, iodata()}`. 10 IRC commands + 4 informational numerics (001 nick reconcile, 332/333 topic backfill, 353/366 names bootstrap).
3. **`Session.Server.handle_info`** delegates; inline transport clauses stay (`:ping` PONG, numeric 1 autojoin — reads `state.autojoin`, which the router doesn't carry). Server gains `members: %{channel => %{nick => [mode]}}` — modes as a list, NOT MapSet (modes survive sort; Q3 per CP10 S16).
4. **`Session.list_members/3`** + `GET .../channels/:chan/members` for the P4-1 nick pane; mIRC sort (@ → + → plain, alphabetical within tier).

4th application of the verb-keyed principle:

| Cluster | Module                           | Split shape                            |
|---------|----------------------------------|----------------------------------------|
| D1 / A2 | `Grappa.Networks` god-context    | Servers / Credentials / SessionPlan    |
| D2 / A3 | `Grappa.IRC.Client` god-module   | Client (transport) + AuthFSM (pure)    |
| D3 / A4 | `cicchetto/lib/networks.ts`      | networks / scrollback / selection / ws |
| **E1**  | `Session.Server` god-handle_info | Server (transport) + EventRouter (pure)|

Documented pattern, not heuristic: when a GenServer's `handle_info` accumulates per-message-kind logic that will only grow, extract a pure classifier returning `{:cont, new_state, [effect]}` — unit-testable without DataCase; future kinds are a test+clause pair.

**Why effects + state, not effects-only (Q1):** the brainstorm's narrow `:ignore | {:persist,...} | {:reply,...}` couldn't express member-state deltas; keeping it would force a SECOND switch in the Server, and two switches drift. Widened to the AuthFSM shape — state derivation in `new_state`, effects side-effects-only. `:reply` is forward-compat for CTCP replies (Phase 5+).

**A20 fold-in deferred:** `persist_and_broadcast/4` deleted (zero callsites), but no Broadcaster module extracted — `apply_effects/2` (inbound) and the outbound `{:send_privmsg, ...}` path share the same shape with different transaction needs (the caller wants the persisted `Message.t()`). Phase 5 consolidation candidate.

---

## 2026-04-27 — P4-1 / A5 closure: three-pane shell + 5th verb-keyed split

Closes A5 (`ChannelsController.index` returned the credential's static autojoin list, not session-tracked joins) and ships the Phase 4 first-ship UI: three-pane responsive shell, two themes, irssi keybindings, members pane, compose with tab-complete + slash commands, mention highlight + badge.

### Server-side (A5 close)

EventRouter gains self-PART / self-KICK semantics: when `sender == state.nick` (PART) or `target == state.nick` (KICK), the channel key is `Map.delete`'d from `state.members` — symmetric with the self-JOIN wipe. **Invariant: `Map.keys(state.members)` IS the live currently-joined-channels set.** Other-user PART/KICK keep inner-nick-only semantics.

`Session.list_channels/2` added; `ChannelsController.index/2` composes credential autojoin ⊕ session-tracked into `{name, joined: bool, source: :autojoin | :joined}` — `:autojoin` wins on overlap (operator intent is durable; a session JOIN is transient). Two new outbound endpoints for slash commands: `POST .../channels/:chan/topic` (sends TOPIC, persists a `:topic` row, broadcasts) and `POST /networks/:net/nick` (sends NICK; `state.nick` reconciles via the existing EventRouter NICK handler when upstream replays).

### Client-side (5th verb-keyed split)

P4-1 adds five stores to D3's four: `theme` (theming + viewport mode), `keybindings`, `members` (REST bootstrap + live updates from the existing message stream), `compose` (per-channel draft + history + slash-dispatch + tab-complete), `mentions` — plus four pure DOM-free helpers (`modeApply`, `slashCommands`, `mentionMatch`, `memberTypes`). Each new store repeated the module-singleton + createRoot + on(token)-cleanup shape; no context-provider boilerplate.

**Q4 was the load-bearing reuse decision:** no new server-side broadcast for member deltas — `members.ts` filters the same `MessagesChannel` stream `subscribe.ts` already consumes. The persist row IS the wire-level evidence of presence change ("implement once" + "one feature, one code path" together).

### Shell / theme / keybindings / compose pins

- Grid `16rem 1fr 14rem`; at ≤768px (single source `--breakpoint-mobile` on `:root`, mirrored in JS via `theme.ts`'s reactive `isMobile()`) side panes collapse to drawers with ☰ toggles, backdrop tap-outside, Esc-close. **Q7: hamburger-only, no edge-swipe** — conflict-free with iOS back-swipe; explicit affordance over gesture discoverability.
- **Q8: single CSS file with `:root[data-theme="..."]` blocks** — both themes in one asset, first-frame paint, no FOUC. `applyTheme()` runs pre-render from `main.tsx`; "auto" clears localStorage and follows `prefers-color-scheme` live.
- Keybindings: vanilla `keydown` + dispatch table, no library. `Alt+1..9`, `Ctrl+N/P`, `/`, `Esc`, `Tab`/`Shift+Tab`. **Q6: tab-completion is members-only** (recent-sender fallback deferred).
- Slash commands: `/me /join /part /topic /nick /msg`; `/raw` dropped (needs a `POST /networks/:net/raw` endpoint that doesn't exist; M-cluster). Tab-complete cycles alphabetical matches anchored to the original prefix, stable across the growing rendered word.

### Trade-offs accepted

- TopicBar topic text is placeholder — a topic store derived from the latest `:topic` row is M-cluster polish; the persisted wire shape is forward-compat.
- **PREFIX ISUPPORT-driven mode-prefix table:** both server EventRouter and cic `modeApply` hard-code `(ov)@+`. Phase 5+ swaps both at once.
- A20 still deferred: `{:send_privmsg|:send_topic|:send_nick}` share the persist-broadcast-send shape — three small contained callsites, consolidation in Phase 5.

---

## 2026-04-28 — text-polish: channels_changed user-topic broadcast + iPhone bug sweep

Closes the four iPhone-acceptance gaps blocking the M2 auth-triangle clusters (CP10 S20).

**Server:** `Session.Server.delegate/2` compares `Map.keys(state.members)` between input and derived states; on keyset diff it broadcasts `{:event, %{kind: "channels_changed"}}` on `Topic.user(state.user_name)` — the first real consumer of the per-user topic (reserved since 2h). EventRouter stays pure: keyset-delta detection at the GenServer boundary keeps PubSub/Topic/user_name out of the router. Direction-agnostic — self-JOIN/PART/KICK all collapse to one heartbeat; the channels-list mutation IS the event. Payload deliberately empty: cic refetches `GET /channels`, keeping REST the single source of truth for the `{name, joined, source}` envelopes.

**cic:** new `lib/userTopic.ts` module-singleton joins `grappa:user:{name}` once per identity and calls `networks.refetchChannels()`; `socket.ts` re-exports the previously-dropped `joinUser/1` (S49 marker honored — first real consumer brings it back). Two iPhone fixes: `Shell.tsx`'s empty-state gains an inline ☰ + ⚙ header (TopicBar, the usual host, was gated on `selectedChannel()` — no mobile escape hatch); `ComposeBox.tsx` drops `disabled={sending()}` from the textarea (kept on the button) — fixes focus loss across submit.

**Trade-offs:** refetch-on-event over per-channel patches (`channelsBySlug` stays a `createResource`; REST canonical, cheaper to reason about); every tab refetches on any tab's mutation — a few-bytes broadcast + one GET per tab, acceptable.

---

## 2026-05-02 — `SessionSupervisor` `max_restarts` bump for cluster-wide flap tolerance

`BootstrapTest` `on_exit` intermittently found the SessionSupervisor already gone. Root cause: the default DynamicSupervisor budget (`max_restarts: 3, max_seconds: 5`) is **GLOBAL across all children**. Teardown chain: test dies → linked fake IRCServer dies → Client gets `{:tcp_closed,_}` and crashes → linked Session crashes → `:transient` restart → fresh connect against the dead port → `:econnrefused` crash → repeat. Cumulative crashes across concurrent tests trip the budget; the supervisor exits `:shutdown` and is restarted empty, so late `terminate_child` calls hit a supervisor with no record of the pid.

The 2026-04-27 test-discipline rule (don't unit-test through the supervisor path) can't apply here — `Bootstrap.run/0`'s contract IS spawning under the supervisor. The fix had to move into the supervisor. First bump (100/60s) left a residual ~30% flake: a dead-port session restart-loops at **~2000 restarts/sec** (refused connect returns in microseconds; captured logs showed >25 crashes in 12ms). A rate-limiting detour (1s sleep before `{:stop, {:connect_failed,_}}`) was tried and REVERTED — it broke the C2 contract test's 1s `assert_receive` budget.

Final: **`max_restarts: 10_000, max_seconds: 60`** — ~167 sustained crashes/sec: absorbs ~5s of full-rate loop plus prod whole-network flaps (dozens of sessions simultaneously), while still tripping on genuinely runaway loops. Per-supervisor change (`SessionSupervisor` only); other DynamicSupervisors keep the conservative default. Phase 5's per-session reconnect/backoff demotes these limits to genuinely-defensive failsafes.

---

## 2026-05-03 — T31 admission control + captcha LANDED (CP11 S22 — closes post-Phase-4 ops)

Three-tier admission cap + Cloudflare Turnstile captcha + per-network circuit-breaker shipped to prod. The original CP11 framing ("max 3 concurrent connections per source IP") was rejected in brainstorm (S21): IP alone cannot split mobile-CGNAT-legit from abuser-on-shared-IP — one IP is thousands of legit users behind a carrier CGNAT.

### Final cap shape

`Grappa.Admission.check_capacity/1` composes three gates in order:

1. **NetworkCircuit** — per-network failure circuit-breaker (lazy ETS GenServer; distinct from S20's per-(subject, network) `Session.Backoff`). Login records successes (resets) and failures (count toward threshold).
2. **Per-network total** — `networks.max_concurrent_sessions` (default `nil` = uncapped); Registry match-spec count of ALL session types — user sessions AND visitor sessions. Operator caveat: vjt's persistent user session counts toward the visitor cap budget.
3. **Per-(client_id, network)** — `networks.max_per_client` (default 1) against `accounts_sessions` rows for the `X-Grappa-Client-Id` header. client_id lives on the session row, NOT the registry key — so this lookup is Ecto, not ETS.

### Captcha gate

`Grappa.Admission.Captcha` behaviour, three impls: `Disabled` (default), `Turnstile`, `HCaptcha`. Provider via `GRAPPA_CAPTCHA_PROVIDER` env (unknown value → Disabled + Logger warning). Fires ONLY at `Visitors.Login` case-1 (fresh anon provision) — cases 2/3 are already password/token-gated. Wire: `400 {error: "captcha_required", provider, site_key}` — `provider` is non-redundant: site_key format alone can't disambiguate Turnstile from hCaptcha, and cic needs it to pick the widget loader.

### Operator-bind verb

`mix grappa.set_network_caps` wraps `Networks.update_network_caps/2` (prod uses the same context fn via `bin/grappa rpc`). A separate verb, NOT a `bind_network` extension: caps live on `networks` (per-deployment shared infra), not `network_credentials` (per-(user, network)) — the 20% mismatch is the domain boundary per "reuse the verbs, not the nouns."

### Three deploy-time bugs — invisible to the unit suite, caught only by real-browser e2e

1. `compose.prod.yaml` had no `environment:` entries for the captcha vars. Compose only consumes `.env` for **substitution**; host env vars don't auto-inject into containers unless listed in `environment:`/`env_file:`. `System.get_env` → nil → captcha silently Disabled.
2. `crypto.randomUUID` is secure-context-gated; on plain-http prod it throws (vitest jsdom IS a secure context, so tests never tripped). Fallback: hand-rolled v4 from `crypto.getRandomValues`, which IS available on insecure origins.
3. Nginx CSP `script-src 'self'` blocked Turnstile JS. CSP stays THE load-bearing XSS defense for the bearer-in-localStorage design; fix = minimal allowlist (Turnstile host on `script-src` + `connect-src` + new `frame-src` — the challenge UI is iframed).

Lesson: env-var→runtime config, secure-context-gated browser APIs, and CSP allowlists are three boundaries ONLY real-browser e2e exercises. The "REAL BROWSER, hard gate" mandate paid for itself.

### W3 supersession

`Visitors.Login.@max_per_ip` + `check_ip_cap/1` retired. Per-(client_id, network) + captcha-on-fresh-anon are the two halves of the replacement — tighter keying on the same anti-abuse intent.

### Deliberately NOT in T31

- **No per-IP cap** (CGNAT carriers fail it).
- **No ASN/MaxMind reputation** (needs the paid GeoIP2 ISP product; captcha solves it cleaner).
- **No datacenter CIDR blocking** (captcha covers it).
- **No canvas/device fingerprinting** — the localStorage `client_id` UUID is the only fingerprint; clearing it is free, and the captcha is what makes that costly.
- **No identity-tier cap exemptions** — the operator's only knob is per-network `max_per_client`.

Micro-followups filed (not blocking): partial index on `accounts_sessions.client_id`, DB CHECK constraints on the two caps, two test-accuracy nits, and the reviewer-template "gates RUN, not asserted from inspection" rule.

---

## 2026-05-03 — NetworkCircuit semantics: lazy expiry + window-vs-cooldown independence

`Grappa.Admission.NetworkCircuit` (T31 P1, refined B4) has two **independent** intervals: the **failure window** (`@window_ms`, 60s — sliding accumulation; resets on the next failure past the boundary while `:closed`) and the **cooldown** (`@cooldown_ms`, 30s ±25% jitter via `Grappa.RateLimit.JitteredCooldown` — minimum `:open` time after threshold breach).

Independence: a failure during cooldown does NOT reset the window — it's silently dropped (no half-open). Clearing happens only via the `:cooldown_expire` cast triggered by `check/1` observing `now >= cooled_at_ms`; the cast carries the observed `cooled_at_ms` as a token — if the circuit re-opened between observation and handler, the token mismatch no-ops it (H6 race fix).

**Lazy expiry:** ETS rows persist until a token-matching expire-cast deletes them; no periodic sweep — table size is bounded by the handful of networks the bouncer talks to (confirm via `:observer_cli`).

**Why distinct from `Session.Backoff`:** Backoff is per-(subject, network) reconnect pacing; NetworkCircuit is per-network all-subjects health gating. Shared `JitteredCooldown` primitive; different failure-source semantics (single session vs aggregated network-wide).

---

## 2026-05-04 — t31-cleanup cluster close-out: 74-finding bundled cleanup, 8 vjt-blessed decisions, sqlite ALTER+CHECK landmine

Bundled paydown of every actionable finding from the post-T31 codebase review (`docs/reviews/codebase/2026-05-03-codebase-review.md`) plus 2 non-T31 HIGH (H2 user-logout-WS-teardown, H12 send_pong NUL asymmetry). Plan-fix-first discipline matured: never silently absorb plan-vs-code divergence.

### vjt-blessed decisions adopted (A–H)

- **A** — runtime `Application.get_env` reads removed; supervisor injects via `start_link/1` opts (boot-time boundary only).
- **B** — captcha duplication kept ONLY where mirroring provider wire shape; shared HTTP client + error-mapping + config-load consolidated into a `Captcha.Provider` behaviour.
- **C** — NetworkCircuit H6 + H7 races fixed via observation-token capture + state-aware window reset; cast handler short-circuits on token mismatch.
- **D** — `Parser.strip_unsafe_bytes/1` rename + NUL strip closes the `send_pong/2` NUL-injection asymmetry (H12); CR/LF/NUL stripped at a single boundary; `strip_crlf/1` removed outright (total consistency, no shim).
- **E** — `Grappa.ClientId` Ecto custom type (storage `:string`, strict UUID-v4 regex); public `regex/0` reused by `Plugs.ClientId` — single source, no parallel literal.
- **F** — the two caps are a **three-valued contract**: positive (set), `0` (lock-down), `nil` (unlimited); `validate_change(&validate_non_negative_or_nil/2)` expresses it; `set_network_caps` gains `--clear-max-*` flags mutex with `--max-*`.
- **G** — `IRC.Message.anonymous_sender/0` is the single source for the `"*"` prefix-less sentinel; `Identifier.valid_sender?/1` routes through it.
- **H** — reviewer dispatch briefs MUST require the reviewer to RUN each gate and paste its literal tail; routed to a user-global memory pin after the plugin-cache skill path proved un-editable.

### Subject-discriminator unification (M-web-1, B6.2)

Conn `:current_subject` reshaped from dual assigns (`:current_user_id` / `:current_visitor_id` — ambiguous when both nil: anon or not-yet-loaded?) to a tagged tuple carrying the loaded struct: `{:user, %User{}} | {:visitor, %Visitor{}}`. `GrappaWeb.Subject.to_session/1` owns the struct→ID-map boundary helper. UserSocket untouched (own `connect/3` auth path; M-web-1 scoped REST).

### Defense-in-depth: DB CHECK constraints + Ecto.Enum at boundary (B5.5)

CHECKs added: both caps `IS NULL OR >= 0`, `messages.kind` allowlist, `network_credentials.auth_method` allowlist. Ecto.Enum already validates at the changeset; the CHECK is the second line for anything that bypasses the schema (future migration, release script, raw map). Deliberate pairing: Ecto for friendly errors, sqlite CHECK for the sidestep case.

### CSP tightening + drift-detector CI test (B6.5/6/7)

`connect-src` dropped the global `ws:`/`wss:` allow for host-scoped entries; security headers extracted to `infra/snippets/security-headers.conf` (included by both `/` and `/sw.js`). New CI test `test/grappa/infra/csp_provider_test.exs` parses nginx.conf + snippet and asserts every non-Disabled captcha impl host appears in the CSP allowlist — drift fires the moment a provider lands without its CSP entry. `infra/` added to `WORKTREE_VOLUMES` in `scripts/_lib.sh`.

### Hard-won lesson: sqlite ALTER + CHECK + WAL — `defer_foreign_keys` is the right tool

sqlite has no `ALTER TABLE ADD CONSTRAINT`; the recipe is rename-old + recreate-new + INSERT-SELECT + drop-old. With FK references in play, two landmines:

1. **`@disable_ddl_transaction true` + `PRAGMA foreign_keys=OFF/ON`** (the canonical sqlite recipe) breaks under Ecto/Exqlite's pool in WAL mode: without a pinned transaction, each `execute()` gets its own pool connection with its own `sqlite_master` snapshot — `CREATE INDEX` after RENAME+DROP saw a stale snapshot and crashed `index already exists`. Reproduced 2× in dev.
2. **Plain transactional migration** — sqlite ≥ 3.25 auto-rewrites dependent FK references to point at `*_old` during the parent RENAME; the dependents then block `DROP TABLE networks_old` with `FOREIGN KEY constraint failed`. First prod deploy failed here.

**The fix:** `PRAGMA defer_foreign_keys=ON` at the top of `up/0` AND `down/0`, migration left in its default transactional shape. FK checks defer to COMMIT, by which time all tables are recreated with fresh CHECK schemas and fresh `REFERENCES "networks"` text. Round-trip clean in dev and prod. Memorialised so the next ALTER-CHECK migration doesn't re-derive it.

---

## 2026-05-04 — Compose decoupled from LAN/IP, second host (voygrappa) brought up on macOS

Bringing up a second host (Mac, `voygrappa.bad.ass`) surfaced that the committed compose stacks were pinned to the canonical Linux deployment: `vlan53` external network + a static IP. Fresh clones bombed at network create, and even on the canonical host the static IP coupled deployment shape to network shape. Compounded on macOS: Docker Desktop runs containers in a hidden VM, so macvlan can't reach the host LAN — the Linux container-on-vlan trick is structurally unavailable.

### Decision

Split machine-specific binding from deployment shape into gitignored personal overrides:

- **Committed base files** are deployment-agnostic: bridge networks + wildcard port publishes (dev `4000:4000`, prod `3000:80`). Clone → `docker compose up` → browse localhost. No LAN, no DNS, no vlan.
- **Personal bindings** in `compose.override.yaml` / `compose.prod.override.yaml` — gitignored, auto-loaded by `scripts/_lib.sh` when present; `ports: !override` swaps the wildcard for an IP-bound publish, plus `PHX_HOST` for prod.
- **Committed examples** (`compose.{,prod.}override.yaml.example`) make the pattern self-documenting.

**Why prod defaults `3000:80`, not `80:80`:** privileged port 80 needs root or `cap_net_bind_service` — friction for cloning operators. The canonical home-LAN override binds `:80` because the DNS A records expect no port suffix; deployment choice, not shipping default.

**Why `!override`, not `!reset`:** `!reset` removes the field entirely (right for `compose.oneshot.yaml`'s strip-all-publishes); for drop-base-and-replace the tag is `!override` — `!reset` produced an empty ports list. Documented in the examples so the next operator skips the misstep.

**CSP de-pinning:** CSP3's `'self'` covers same-origin ws/wss automatically, so the explicit `ws://grappa.bad.ass wss://…` entries were redundant AND hostname-pinned — now `connect-src 'self' https://challenges.cloudflare.com`, deployment-agnostic.

**macOS bash 3.2:** Apple's `/bin/bash` doesn't grok `declare -ag`. All `scripts/*.sh` shebangs switched to `#!/usr/bin/env bash` (Homebrew bash 5 on macOS, system bash 4+ on Linux); bash-4+ requirement documented.

**Healthcheck via container exec:** the `curl http://192.168.53.11/...` probes had to go once host ports became operator-configurable. Now `docker compose exec nginx wget -qO- http://127.0.0.1/healthz` — in-container loopback, independent of host port shape.

**Non-decisions:** `register-dns.sh` stays out of the standard flow (Technitium-specific; depersonalized to env-vars-required). Compose files NOT consolidated via `profiles:` — the dev/prod differences are structural; three files, one concern each, override as the fourth. Historical docs NOT updated — they're frozen chronological records; updating would falsify history.

---

## 2026-05-06 — BUG7 doesn't reproduce in Playwright iPhone 15 emulation

S4's "regression-pin RED on prod head" turned out to be a fixture artifact: the failure was at the page-object's `selectChannel` step, before compose-send was ever reached — the mobile JSX branch (≤768px, matched by the iPhone 15 profile) replaces the desktop sidebar with `<BottomBar />`, so sidebar selectors had no DOM target. After teaching the page-object to branch on viewport, both BUG7 specs went GREEN: the hypothesized root causes (WS suspend on keyboard show, Solid-under-WebKit reactivity, visualViewport overflow) do NOT reproduce in headless WebKit. The real-hardware bug surface lives where the emulator can't follow: actual keyboard chrome occluding the visualViewport, iOS Safari's resize-on-focus, touch-action/momentum quirks. Headless WebKit is "Safari engine without the OS," and the OS shell is where this bug lives.

**Decision:** downgrade the BUG7 specs to positive guard rails — they pin the iOS-shaped input path (tap-focus, per-keystroke type, tap send) round-tripping compose → WS → DOM on every commit. The real-iOS bug is deferred to a session driving a physical device via DevTools-over-USB; not in CI's reach. The plan's hypothesis enumeration stays in the spec header for that investigation. No production code changed.

**Mobile-aware page-object pattern:** `loginAs`, `sidebarWindow`, `selectChannel` branch on viewport; threshold mirrors `theme.ts`'s `MOBILE_QUERY` 768px. Detection via `page.viewportSize()` (synchronous — Playwright sets it when the project picks the profile), not `page.evaluate(matchMedia)` round-trips.

**Test-isolation lesson:** M9 (`/part` via X-button) destroys shared `#bofh` seed state; alphabetical ordering had hidden it, and the old RED-pin masked the missing channel. Fix: `joinChannel()` REST helper in `e2e/fixtures/grappaApi.ts`; M9 restores `#bofh` in `afterEach`. Generalised: **any spec whose action-under-test mutates shared seed state must restore it in `afterEach`** — the seeder sidecar runs once per stack boot, not between specs.

---

## 2026-05-06 — Integration suite wired into GitHub Actions (S6)

`.github/workflows/integration.yml` runs `scripts/integration.sh` on PRs and main pushes touching `lib/**`, `cicchetto/src/**`, `cicchetto/e2e/**`, `config/**`, `priv/**`, `mix.exs`, or `mix.lock`. Failure uploads Playwright traces + HTML report as 14d artifacts. Path-filtered because it's the heaviest job in the repo (cold image pull + browser binaries) — doc-only PRs have nothing for it to verify, and the unconditional `ci.yml` still covers unit-level gates on every push.

`submodules: recursive` works with the default `GITHUB_TOKEN` — the azzurra-testnet submodule URL is public and resolves over HTTPS-with-token. If the testnet ever moves private, provision a deploy key and switch to `ssh-key: ${{ secrets.SUBMODULE_DEPLOY_KEY }}`.

---

## 2026-05-07 — CP15 event-driven window state model

cicchetto used to assume window state: POST `/channels` succeeded → sidebar entry appeared → members fetched once and cached. When IRC reality diverged (invite-only refusal, kick, T32 park, WS reconnect race dropping `members_seeded`), the UI silently lied — the optimistic pattern was structurally incapable of representing JOIN failure or KICK; cic was the source of truth for state it could not observe.

CP15 moved the window-state machine to the server. `Session.Server` owns three sibling maps keyed on channel: `window_states %{channel => :pending | :joined | :failed | :kicked | :parked}`, `window_failure_{reasons,numerics}`, `window_kicked_meta`. Transitions emit typed events on the per-channel topic (`grappa:network:{net}/channel:{chan}`) with `kind: "joined" | "join_failed" | "kicked" | "members_seeded"`, plus the pre-existing `kind: "message"`. cic's `lib/windowState.ts` mirrors the three-map split as signal stores; `subscribe.ts` dispatches. The old `loadMembers` REST verb is GONE — `members_seeded` fires on after_join AND every 366, so cic never calls `GET /members`. `:parted` is intentionally NOT broadcast: cic derives key-removal from the existing `:part` presence message when `sender === ownNick`, and the absent key projects to the archive surface (B4) without a parallel typed event.

### Two patterns pinned for project-wide reuse

**Wire modules.** B6 surfaced a Jason crash: `QueryWindows.broadcast_windows_list/2` sent raw `%Window{}` structs over PubSub; `Phoenix.Socket.V2.JSONSerializer`'s `fastlane!/1` crashed at the WS edge during fan-out, dropping the user-channel process — so a subsequent `close_query_window` push landed on a dying ref and was lost, explaining a long-suspected "closed DM windows stay open server-side" bug pre-dating CP15. Fix: `QueryWindows.Wire.render_grouped/1`, sibling to `Scrollback.Wire`; both the PubSub side and the Channel-push side delegate. STANDARD now: contexts own JSON-encodable wire conversion; PubSub payloads MUST be JSON-encodable; raw `%Schema{}` structs are forbidden because the failure mode is a runtime fastlane crash at the boundary, not a compile error.

**Synthetic sidebar rows keyed on windowState.** The `pendingChannelsForNetwork` projection was too narrow: a failed JOIN landed in `windowStateByChannel` as `:failed` but never reached `channelsBySlug`, so the sidebar rendered NO entry — contradicting the "greyed/dim entry" intent. Renamed `pseudoChannelsForNetwork`, extended to all four non-joined states. Load-bearing piece: **the sidebar projection's authoritative key is `windowStateByChannel`, not `channelsBySlug`** — the live channels list is one input among several. New states inherit the synthetic-row + greyed-class treatment mechanically as long as they land in `windowStateByChannel`.

### Three bug-fix learnings (B6 e2e matrix)

1. **Projection keys on the authoritative store** for the question asked. "What windows exist?" → `windowStateByChannel`, not the live-channels list.
2. **Persisting a struct over PubSub does not auto-render it as JSON.** Wire-shape conversion is per-context responsibility, not implicit in `broadcast/3`.
3. **`join_failed` notice silent on cic:** the `:join_failed` arm persisted a `:notice` row but broadcast only the typed event, never the `kind: "message"` push — the notice hit the DB but not the live view (`loadInitialScrollback` is once-per-channel). Fix: broadcast `Wire.message_payload/1` there too. Rule: typed window-state events and persisted message events are PARALLEL wire channels; every `:persist` effect needs a paired `kind: "message"` push if the row must land in the LIVE scrollback view.

### Stale-bundle reload gotcha

Post-deploy browser smoke initially "reproduced" the kicked-sidebar bug — the prod tab held the pre-deploy bundle. Asset-hash cache-busting works for fresh sessions, not already-open tabs. Mitigation: hard-reload the prod tab post-deploy before browser smoke.

### Deferred: parked (T32) flow + the one flake

The parked-state e2e is BLOCKED on T32 (PATCH `/networks/:slug` + cic `/disconnect` `/connect` arms, landing in channel-client-polish); the synthetic-row treatment for `:parked` is already in place — the e2e is a mechanical addition once T32 ships. `cp15-b6-pending-to-failed-invite-only.spec.ts` flakes on first attempt only (sub-second race between synchronous `setPending` and the `join_failed` broadcast); same render path is reliably green elsewhere; follow-up filed to tighten the wait_for sentinel on the typed event.

---
## 2026-05-08 — CP17 server-side-pending cluster

Theme 2 of the 2026-05-08 architecture review. Closes the CLAUDE.md
hard-invariant violation "cic NEVER originates state — no parallel
client-side state machine."

Pre-CP17 the only cic-originated state mutation was
`cicchetto/src/lib/compose.ts:210`'s optimistic
`setPending(channelKey(...))` fired right after `postJoin(...)`, so
subscribe.ts's pre-subscribe loop could join the per-channel WS topic
BEFORE the upstream JOIN echo. The chicken-and-egg: cic only learns
to subscribe per-channel AFTER seeing `:pending` in
`windowStateByChannel`, and broadcasting `:pending` on the
per-channel topic itself is impossible — cic isn't subscribed yet,
and Phoenix PubSub doesn't replay to late subscribers.

Resolution: broadcast on `Topic.user/1`, which cic joins from boot
via `userTopic.ts`. New verb `Grappa.Session.Wire.window_pending(slug,
channel)` → `%{kind: "window_pending", ...}`. Naming convention:
state-change events on the user-topic carry a window-namespace prefix
(`window_pending`, not bare `pending`) to avoid collision with
channel-namespace verbs that share state names (`joined` etc.).
Single producer: `record_in_flight_join/2` (called from the
`{:send_join, ch}` cast AND the 001 RPL_WELCOME autojoin loop) wraps
BOTH the `window_states[ch] = :pending` mutation and the user-topic
broadcast.

Snapshot path: `get_window_state` / `push_window_state_if_known`
intentionally returns `{:error, :not_tracked}` for `:pending` — the
per-channel after_join can't deliver new info (cic already learned
`:pending` via the user-topic) and would carry a different `kind:`
than the user-topic origin (per-channel topic uses `joined /
join_failed / kicked` for terminal states). Documented design choice.

Idempotency rule: a JOIN for a channel ALREADY `:joined` skips the
`:pending` mutation + broadcast (connected cic tabs must not briefly
flip `:joined` → `:pending`), but the in-flight entry IS still
recorded — a downstream failure numeric (e.g. 443 ERR_USERONCHANNEL)
needs correlation against the in-flight window. Surfaced by the
m11-peer-nick integration failure on initial ship: an afterEach
defensive re-JOIN downgraded `:joined` → `:pending`, bahamut may not
echo a JOIN at all for a re-JOIN, state stuck, MembersPane rendered
"not joined" despite live member events.

cic mirror: `WireUserEvent` union gains a `window_pending` arm
(tsc-exhaustive via `assertNever`); `userTopic.ts` dispatches to the
same `setPending` signal as pre-CP17 (the pre-subscribe loop re-runs
on the signal regardless of who calls it — origin-decoupled by
design); the optimistic `setPending` in `compose.ts:210` REMOVED.

Theme 1 (wire-discipline-sweep) closed CP16; Theme 3
(`Session.Server.WindowState` extraction) next-up — mechanical now
that Wire modules + `:pending` are pervasive server-side.

---

## 2026-05-08 — CP16 wire-discipline-sweep cluster

CP15 B7 elevated to a CLAUDE.md hard invariant: "PubSub broadcast +
Channel push payloads MUST be JSON-encodable — convert structs to
wire shape via a context-owned `*.Wire` module." The 2026-05-08
architecture review found three contexts that didn't comply and
three stale typespecs lying about the wire shape post-CP15 B6. Six
buckets, each TDD + per-bucket format/credo/dialyzer:

  * **B1** — `Grappa.Session.Wire` extracted: nine event payloads
    moved from inline maps (`Session.Server` apply_effects arms +
    `maybe_broadcast_*` helpers + `grappa_channel.ex` push-after-join
    helpers) into one Wire fn per `kind:`.
    `Session.Server.window_state_payload/3` (snapshot path) collapses
    to one-line Wire delegations so snapshot + event-time payloads
    are LITERALLY the same expression.
  * **B2** — `Grappa.Visitors.Wire`: `visitor_to_json/1` +
    `visitor_to_credential_json/1`. Both EXCLUDE `:password_encrypted`
    (the post-Cloak-load plaintext NickServ password — same risk
    class `Networks.Wire` was created to prevent). The
    LoginResponse/MeResponse drift on `:expires_at` becomes EXPLICIT
    through two Wire fns (mirror of `Accounts.Wire`'s
    {full, credential} pattern).
  * **B3** — `Networks.broadcast_state_change/4` inline payload →
    `Networks.Wire.connection_state_changed_event/4` (consistency
    follow-through of the H1 raw-`broadcast/3` bug fix).
  * **B4** — three stale typespecs caught up (`[Window.t()]` →
    `Wire.windows_map()` post-CP15 B6). `Scrollback.Wire.message_payload/1`
    switched `kind: :message` → `kind: "message"`: wire bytes
    unchanged (Jason atom→string), but the server-side discriminator
    type is now string across every Wire fn.
  * **B5** — cic `WireUserEvent` discriminated union in `lib/api.ts`
    covering all 6 user-topic events; `userTopic.ts` if-else cascade
    rewritten as a switch with `assertNever` exhaustiveness (same
    pattern as ScrollbackPane's `MessageKind` switch, CP10 C3); every
    `as ...` cast removed.
  * **B6** — full gate sweep (check.sh + dialyzer + cic biome/tsc +
    vitest + integration).

Consistency-only, no behavior change; six HIGH findings closed.

### Recurring lesson — directions over code

Five separate arch-review concerns surfaced the same wire-discipline
gap: the CP15 B7 invariant landed in CLAUDE.md faster than in code,
and consumers kept building inline payloads because the surrounding
code did. "Total consistency or nothing" closes the drift; CP16
promotes the invariant from prose to function-level enforcement.
Themes 2 (server-side-pending) and 3 (WindowState extraction)
deliberately deferred — they need design discussion, not a typespec
sweep.

---

## 2026-05-08 — CP18 bnd-A2 close + scroll-on-window-switch

Two unrelated clusters: bnd-A2 (the LAST HIGH OPEN architecture row)
+ a user-reported scroll bug.

### bnd-A2 — slug→Network canonical helper

`cicchetto/src/lib/compose.ts` re-derived `network_id` from
`networkSlug` via `networks()?.find((n) => n.slug === networkSlug)?.id`
repeated **14 times** across verb handlers — each site free to
diverge on missing-slug default / fallback behavior. Fix: canonical
helpers in `cicchetto/src/lib/networks.ts` backed by a `createMemo`
Map keyed on `n.slug`: `networkBySlug(slug)` (full record) +
`networkIdBySlug(slug)`. The memo invalidates whenever the `networks`
resource updates (post-/connect, post-/disconnect, bearer rotation) —
no manual cache management. The win is single-source-of-truth, not
perf (n is 1-7 in practice).

Three options weighed: (A) pure helper, (B) Map-keyed memo + helper
[chosen], (C) push resolution up into `slashCommands.ts` dispatch
[larger scope, deferred]. B mirrors the cluster #13 M4
(`networkKey`/`decodeChannelKey`) + M7 (`target_kind/1`)
helper-promotion pattern. Helpers take `slug: string` (NOT
`string | null`) — all 14 call sites hand a guaranteed string; no
nullable widening for scenarios that can't happen.

**Apply rule:** a literal pattern repeated 3+ times across one file's
verb handlers → canonical helper at the data-source module, not a
per-call utility, not a dispatch-time refactor. Memo-backed Map is
the standard shape when the projection is over a reactive resource.

**Audit closure:** architecture HIGH OPEN count = 0 (codebase HIGH
hit 0 in cluster #15); all remaining 72 OPEN rows MEDIUM/LOW.

### scroll-on-window-switch — DOM-reuse race in ScrollbackPane

Opening an empty query window left scrollTop=0; switching back to a
populated channel kept it pinned at the top. Root cause: the
`[data-testid="scrollback"]` `<div>` is the SAME DOM node across
`selectedChannel` changes — Solid's `<Show>` in `Shell.tsx` is
non-keyed, so the element is reused, not rebuilt. The length-effect
only fired when `messages().length` changed; re-selecting a
previously-loaded channel never re-snapped.

Fix: extend the existing on-key effect (already resets banner +
markerScrolled) to snap scroll: marker exists →
`scrollIntoView({ block: "center" })` (user spec: unreads roughly
mid-screen, else bottom); no marker → `scrollTop = scrollHeight`.
Companion: the length-effect's marker branch (the OTHER mount path,
REST page lands AFTER focus) also moves `block: "start"` →
`"center"` — asymmetric UX is worse than no fix. `atBottom` is
set/recomputed so the "scroll to bottom" button doesn't flash
mid-switch.

**Apply rule:** when a Solid `<Show>` boundary isn't `keyed`, the DOM
under it is REUSED across condition changes; effects keyed on signal
IDENTITY (length, ref) won't fire on logical-state transitions that
don't change those signals. Add an explicit effect on the LOGICAL key
(channel `key()`) to reset DOM state. Internal signals reset on key
change; the DOM doesn't unless you tell it to.

Two e2e specs in `cicchetto/e2e/tests/scroll-on-window-switch.spec.ts`
pin both branches (bug repro + marker-centered geometry — stronger
than cp14-b1's `toBeInViewport()`).

---

## 2026-05-09 — CP19 T32 parked-window: derive cic cascade from network connection_state

CP15 B6's brief promised a parked e2e spec was "mechanically
authorable" — wrong on the producer side; CP18 flagged the gap.

**The verified gap:** `Networks.disconnect/2` terminates
`Session.Server` via `DynamicSupervisor.terminate_child/2`; the
GenServer dies and `state.window_states` evaporates — **no
per-channel `:parked` event ever fires.** cic receives the user-topic
`connection_state_changed → :parked` and updates the network record,
but per-window sidebar rows stay `:joined` (last value before the
GenServer died). Net: /disconnect left the UI looking fully
connected.

Two options weighed:

- **Q1.A — emit per-window `:parked` from `terminate/2`.** Pro:
  symmetric with `:joined`/`:failed`/`:kicked`. Con: broadcast logic
  during shutdown is fragile; per-channel topic goes silent on park
  (no replay for offline cic).
- **Q1.B — derive parked from `connection_state ∈ {:parked, :failed}`**
  [chosen]. Zero server-side change; per "Don't duplicate state that
  already exists — derive it", `connection_state` is the single
  source of truth. Per-window rendering becomes a function of
  (window state, network connection state).

The derivation rule, codified:
```
window-effective-state(window) =
  if window.network.connection_state ∈ {:parked, :failed} then greyed
  else windowStateByChannel[window.key] ?? :joined-implied
```

`Sidebar.tsx::isGreyed/2` consults `networkBySlug[slug].connection_state`
FIRST; `isNetworkGreyed(slug)` drives `.sidebar-network-greyed` on
the network `<section>`; CSS cascades to rows via the co-qualified
`.sidebar-network.sidebar-network-greyed li .sidebar-window-btn`
selector — specificity (0,2,1) must match the base rule's, or biome
flags `noDescendingSpecificity` AND the override silently loses to
the base rule. `ComposeBox.tsx` mirrors the derivation. Q2 (network
vs per-channel overlay): BOTH fall out of ONE conditional — no
parallel state map ("lightweight over heavyweight").

Q3 (wake latency on `/connect`): non-issue by code inspection —
`NetworksController.connect/2` already eager-spawns via
`SpawnOrchestrator` on the same HTTP round-trip; network ungreys
immediately on the user-topic event, channels ungrey post-autojoin
(typically <1s) via existing typed window-state events.

Wire shape: `Wire.network_with_nick_to_json/3` gains the credential
as third arg and surfaces `connection_state` +
`connection_state_reason` + `connection_state_changed_at` on
`GET /networks` for user subjects — pre-fix cic's `refetchNetworks()`
on `connection_state_changed` returned a shape with nothing to
derive from. T32 fields come straight off the credential row of
record (DB-persisted user intent); live-vs-configured nick stays
separate (BUG1-FIX `resolve_network_nick/2`). Reason rendered as
network-header `title=` attr; richer tooltip deferred.

E2E: `cicchetto/e2e/tests/cp15-b6-parked.spec.ts`. The afterEach
reconnect-then-poll cleanup pattern is new: the testnet doesn't
reset between specs, and a parked credential cascades 18 downstream
failures across other suites without it (poll 30s × 500ms; test
timeout bumped to 90s).

---

## 2026-05-10 — operator-action-echo unread suppression

**Bug.** `/msg <nonexistent-nick> hi` produced a phantom "1 unread"
marker + sidebar badge on the operator's own query window. The 401
ERR_NOSUCHNICK row — routed by `handle_numeric_with_routing/2` (CP13)
via `NumericRouter` → `{:query, ghost}`, persisted as `kind: :notice`
with `meta = %{numeric: 401, severity: :error}` — was counted as
unread by BOTH `subscribe.ts` (badge) and `ScrollbackPane.rows()`
(in-pane marker).

**Domain class.** Same as BUG5b own-presence suppression: a
server-originated row that exists *because of the operator's own
action* — the operator already saw the action; alerting is a false
positive. Piling client rules would scale poorly — the wire already
carries the discriminator.

**Discriminator: `meta.numeric` presence.** Set iff the row came from
`handle_numeric_with_routing/2` (single production site = closed-set
guarantee). A peer-originated NOTICE (NickServ greeting, another
user's `/notice`) has empty `meta` and STILL bumps unread, correctly.
**Severity-agnostic gate:** error numerics (4xx/5xx) and info
numerics (305/306) are all operator-action feedback — gate on field
presence, not severity.

**Single predicate, two call sites.**
`cicchetto/src/lib/operatorActionEcho.ts` exports
`isOperatorActionEcho(message)`, consumed by `subscribe.ts` (badge
gate, mirrors the BUG5b early return) AND `ScrollbackPane.tsx`
`rows()` (marker count filter). Both signals stay aligned by
construction — a future echo class extends one predicate, not two.

**Why not a server-side filter:** the server CORRECTLY persists +
broadcasts the 401 — the operator must SEE the failure inline in the
query window. The bug is the unread-treatment, a client concern per
the CLAUDE.md "client-side only read position" invariant.

E2E: extended the CP13 S5 spec (same `/msg <ghost>` flow) with
unread-marker=0 + badge=0 assertions; vitest covers no-bump/does-bump
symmetry + predicate edge cases.

## 2026-05-10 (b) — operator-action-echo carve-out for $server window

**Regression.** CP20's blanket `meta.numeric` predicate also
suppressed legitimate unread bumps for numerics routed to the
**`$server` window**: `/away` → 306 RPL_NOWAWAY → routed to `$server`
as `:notice` with `meta.numeric=306, severity=:ok` → predicate fired
→ no badge. The CP13 S8 e2e went RED on the CP20 close commit
itself; CP20 close-out misclassified the CI failure as testnet flake
without per-spec verification.

**Root cause = boundary error.** Two shapes of "row produced by my
action": (1) routed to a window the operator inhabits or just
created (ghost DM after `/msg ghost`) — IS echo, suppress; (2)
routed to `$server` — NOT echo: that window EXISTS to surface routed
server output; suppressing it silences its purpose. The discriminator
is the **routing target**, not the row's `meta.numeric` shape alone.
CP20's "all numerics" answer was right WITHIN its original scope,
wrong outside it.

**Fix.** One extra clause: `if (message.channel === SERVER_WINDOW_NAME)
return false;`. 401-ghost still fires (lands in the ghost-nick query
window); 306-to-$server stops. The two-call-site shape survives.

**Refactor:** the literal `"$server"` was duplicated 6+ times across
compose.ts / subscribe.ts / Sidebar.tsx / BottomBar.tsx; a 7th call
site on a magic string forced promotion to `SERVER_WINDOW_NAME` in
`cicchetto/src/lib/windowKinds.ts` (natural neighbor — owns the
`WindowKind` union), pinning drift against the server-side
`{:server, nil}` fanout. Tests keep the literal in fixtures
(test-data, not logic).

**Lessons.**
- Don't claim LANDED on partial-CI evidence — inspect the named
  failed spec; S8 was a real semantic regression, not a flake
  (memory `feedback_landed_claim_evidence`).
- `meta` shape carries *production-site* info; *destination* requires
  a separate read.
- The right time to extract a constant is when adding a new use, not
  "later" — 6 call sites were already a smell.

---

## 2026-05-10 (c) — channel-client-polish: spec #5 + spec #2 (WHOIS) shipped

Audit of the channel-client-polish backlog (memory
`project_channel_client_polish.md`, 21 specs) against actual `main`:
16 SHIPPED (incl. #1 DM auto-open, which a stale orchestrate-next
pointer claimed was MISSING — verified shipped at `subscribe.ts:396`);
2 PARTIAL (#5 left-click not wired, #2 push helper only); 3
NOT-STARTED (#14 /who+/names, #15 /list, #16 /links — parser stubs
only). #5 + #2 bundled in one cluster (same UserContextMenu /
ScrollbackPane surface, no migration needed).

### #5 — left-click on member-list nick → DM

Lifted the existing UserContextMenu "Query" submenu verb body
(`openQueryWindowState` + `setSelectedChannel`) onto MembersPane's
nick click — both entry points compose the same store mutations
(single code path, two doors). Gotcha: biome's
`useKeyWithClickEvents` rejects bare `<li onClick>` (lists are
non-interactive per WAI-ARIA) — refactored to
`<li><button class="member-name">` styled like the former `<li>`.

### #2 — /whois end-to-end

Mirror of the `mentions_bundle` pattern (CP15 B7 / CP16 B5):
per-target accumulator on `state.whois_pending`, drained on 318
RPL_ENDOFWHOIS into `Wire.whois_bundle/3` broadcast on `Topic.user/1`;
rendered as a per-network ephemeral `WhoisCard.tsx` inline at the top
of the active window's scrollback.

**Why ephemeral, not scrollback-persisted:** WHOIS data goes stale
fast (idle counter, mode flag, channel list are snapshot-at-instant —
persisting surfaces stale state on every re-focus); storing 8 fields
per WHOIS bloats scrollback with low-signal rows; replaying a stored
bundle makes no sense — the user wants the current snapshot. Render
is an inline card (NOT a modal, NOT the $server window — per spec
#2's explicit instruction); `whoisCard.ts` keeps one bundle per
network, replaced in place on each /whois.

**Why `dispatch_ops_verb`** (user-only) despite WHOIS being
read-only: the current handler shape keys off `{:user, user.id}` and
visitor sessions don't reach the session by that subject
discriminator. Visitor WHOIS would need a `{:visitor, id}` arm + a
broadcast on the visitor's `subject_label` topic. Out of MVP scope;
visitors get a quiet "unauthorized".

### Foundational pattern for future info-verbs

The shape (delegated-numeric → per-target accumulator → 318-class
end-marker → ephemeral Topic.user broadcast → cic narrowUserEvent +
per-network store + render component) is the template for #14 (/who
352/315), #15 (/list 321/322/323), #16 (/links 364/365).
`Grappa.Session.NumericRouter`'s `@delegated_numerics` was already
pre-seeded with 311-319, 352, 315, 353, 366, 321-323, 364-365,
375-376 — those short-circuit the `:server` route so they don't
double-persist; the delegated handler now emits the bundle effect
instead of stubbing the path.

### Lessons

1. **Audit-summary staleness** — orchestrate-next prompts that
   transcribe an audit go stale faster than the codebase; at /start
   re-grep for the named artifacts before believing "this is
   missing" (memory `feedback_survives_clear_pointer_staleness`
   extended).
2. **`<li>` is non-interactive per WAI-ARIA** — wrap with `<button>`;
   don't add `tabIndex={0}` (biome `noNoninteractiveTabindex`).
3. **`@typep verb` in IRC.Client is closed-set** — every new
   `Client.send_X/N` MUST extend the verb union or
   `reject_invalid_line(:X)` is a dialyzer contract violation; the
   corresponding `Session.send_X/N` facade `@spec`'s
   `{:error, :invalid_line}` arm gets pruned as extra_range if the
   validator always succeeds — the pre-validator path needs the
   failure leg present.

---

## 2026-05-12 — CP24 bucket A: post-cr-review CRITICAL trifecta (C1+C3 fixed, C2 disputed)

Codebase review 2026-05-12 flagged 3 CRITICAL. Bucket A landed C1 +
C3; C2 was contradicted by live-container probe and downgraded to
NON-FINDING (CRITICAL tally 3 → 2).

### C1 — SASL phase guard

`AuthFSM.step/2`'s clause for `%Message{command: :authenticate,
params: ["+"]}` matched UNCONDITIONALLY for any phase below
`:registered` — a hostile/buggy/MitM upstream sending
`AUTHENTICATE +` while the FSM was in `:pre_register` /
`:awaiting_cap_ls` / `:awaiting_cap_ack` elicited a verbatim SASL
credential reply BEFORE SASL was negotiated. Under Phase-1
`verify: :verify_none` the leak was network-exploitable. Fix: pin
the clause on `phase: :sasl_pending` (the only legitimate phase per
the IRCv3 SASL spec); add a catch-all that silently absorbs stray
pre-handshake AUTHENTICATE, mirroring the post-`:registered`
absorption. 4 regression tests.

### C3 — Visitor WHOIS dispatch carve-out

The "whois" `handle_in/3` clause's comment EXPLICITLY flagged the
bug (don't use `dispatch_ops_verb` for WHOIS) but the implementation
used the rejected path — visitors got `visitor_not_allowed` despite
the documented carve-out (visitors ARE allowed read-only verbs that
broadcast on their own subject_label topic). Fix: new
`dispatch_subject_verb/2` mirroring `dispatch_ops_verb/2` but
resolving the socket identity into a `t:Grappa.Session.subject/0`
tagged tuple — `{:user, id}` or `{:visitor, id}` (from the
`"visitor:<uuid>"` user_name assigned by `UserSocket.connect/3`).
Reject path is `{:error, :no_session}` — same surface as user
sockets, NOT the `visitor_not_allowed` carve-out. 3 regression
tests.

### C2 — FALSE FINDING (FK pragma already ON)

The finding claimed `PRAGMA foreign_keys = OFF` in dev/prod, making
23 migrations' `references(..., on_delete:)` runtime-dead.
Live-container probe contradicted it:
`Grappa.Repo.query!("PRAGMA foreign_keys").rows == [[1]]`, and an
orphan INSERT raises `FOREIGN KEY constraint failed`. Root cause of
the false finding: `exqlite` defaults `:foreign_keys` to `:on` and
`ecto_sqlite3` documents the same — the reviewer read SQLite's
engine default and missed the adapter-side connection-init override.

The `validate_subject_exists/1` pre-flights in
`Accounts.create_session/4`, `QueryWindows.open/4`,
`UserSettings.get_or_init/1` exist for a SEPARATE, REAL ecto_sqlite3
limitation: the engine returns the FK constraint NAME as `nil`, so
`Ecto.Changeset.assoc_constraint/3` cannot pattern-match the raised
exception into a clean changeset error. The pre-flight produces the
changeset error before the insert raises; the FK constraint is the
TOCTOU backstop. Existing source comments already describe this
correctly — no source edits. Docs-only correction; persistence/S7's
"without S1 there is NO backstop" framing inherited the same false
premise — re-validate at bucket B.

### Lessons

1. **Probe before code.** A finding citing runtime behaviour gets
   validated against the running container BEFORE designing the fix
   — a 30-second `Repo.query!` would have caught C2 at review-write.
   Corollary to memory `feedback_orchestrator_autonomy`: "HALT when
   finding contradicts probe."
2. **Adapter defaults matter.** Future SQLite-angle reviews: grep
   the adapter source for `set_pragma\|maybe_set_pragma` before
   asserting a pragma is OFF.
3. **Don't rewrite history; supersede with a correction section.**
   The original C2 text stays in the review doc + persistence draft
   + CP24 with explicit "HISTORICAL — invalidated" markers; the
   audit trail carries the reviewer-process lesson forward.

---

## 2026-05-12 — CP24 bucket B: SQLite production defaults + visitor read-only verbs

Second slice of the post-cr-review mega-cluster: the SQLite
contention + index-gap theme (persistence/S2-S5+S8) + a reviewer
follow-on from bucket A's code review.

### S7 reframe — DROPPED, no source edits

persistence/S7 ("`validate_subject_exists` TOCTOU loses its backstop
without C2 fixed; rewrite 'load-bearing' comments to 'convenience'")
inherited C2's false premise. With C2 a NON-FINDING, the existing
comments in accounts.ex / query_windows.ex / user_settings.ex
already describe the real problem correctly (nil FK constraint name
→ pre-flight for clean changeset errors; FK is the TOCTOU backstop).
Dropped entirely.

### S2 + S3 — busy_timeout: 30_000 + pool_size: 10 doc

`config/runtime.exs` + `config/dev.exs`. SQLite's default
busy_timeout is ~2s; with `pool_size: 10` + WAL + single-writer file
lock, transient write contention (Bootstrap spawning N sessions,
channel-mode batches, last_joined_channels writes) cascades into
`database is locked` before the writer ahead releases — the CP23 S4
e2e flakes were a direct symptom. 30_000ms mirrors
`config/test.exs`, which has carried the value since the Sandbox
cascading-busy investigation. S3: `pool_size: 10` is correct — it's
a READ concurrency cap under WAL (writes serialize at the file lock
regardless); lower would starve cic's per-(user, network) query
fan-out under multi-tab load. Documented in a runtime.exs comment
rather than dropped.

### S5 — partial index on connection_state

`Credentials.list_credentials_for_all_users/0` selects
`connection_state = 'connected'` at boot; without an index the
planner full-scans. New partial index
(`where: "connection_state = 'connected'"`) mirrors the
session_client_id partial-index shape — only `:connected` rows
participate, tiny footprint, direct-lookup plan.

### S8 — last_joined_channels cap at 200

Every self-JOIN/PART/KICK overwrites the per-credential
`last_joined_channels` JSON column; the natural bound is the live
join count (5-50; RFC 2812 has no ceiling) but nothing structurally
bounded the snapshot. Cap at 200 via `Enum.take/2` inside
`update_last_joined_channels/3` — tail dropped on overflow, head
order preserved (StreamData property). The cap is a guardrail, not
workload-shaping.

### Reviewer add-on — read-only verbs to dispatch_subject_verb/2

Post-bucket-A, `who`, `names`, `banlist` were still on
`dispatch_ops_verb/2` — visitors are entitled to read-only verbs
(broadcast on their own subject_label). Migrated mirroring the C3
fix; 9 visitor regression tests. `dispatch_ops_verb/2` retained for
write verbs (op/deop/voice/devoice/kick/ban/unban/invite/umode/mode/
topic_set/topic_clear) where visitor-rejection IS the correct
semantic.

Persistence/S4 (PubSub broadcast inside `Repo.transaction`) deferred
to bucket H per the mega-cluster plan.

### Deploy classification

Per code-review H1: hot-deploy would silently no-op the busy_timeout
fix until pool connections recycle — `busy_timeout` is read by
ecto_sqlite3 at connection-init, and code reload swaps modules, not
pool conns. The new migration also needs a fresh migrate pass.
Deployed via `scripts/deploy.sh --force-cold` so both land in one
stop.

### Lessons

1. **Probe contradicts review → re-eval follow-ons too.** S7 dropped
   after a 5-minute re-read, zero source changes — findings that
   depend on a contradicted finding inherit the contradiction.
2. **Cap = safety belt, not workload-shaping** — don't over-document
   a guardrail as a design choice driving the workload.
3. **Two patterns, copy whichever.** Bucket A's ops/subject
   dispatcher split was principled but partial; "Total consistency
   or nothing" caught it in review and bucket B completed the
   migration. The reviewer-add-on slot exists precisely so a partial
   migration in bucket N becomes complete in bucket N+1.

---

Roll-up of the decisions above as a pre-merge checklist:

- **Wire stays text.** No images, voice, video, file transfer, link unfurl beyond text URLs.
- **Web client never parses IRC.** REST is the contract.
- **IRC terminates at the server.** One parser, on the server, period.
- **No upstream IRCv3 dependency.** `CAP LS` + SASL is the floor.
- **Scrollback is bouncer-owned** and paginated. sqlite is the reference store.
- **No server-side read cursor.** Read position stays on the client.
- **No push infrastructure.** PWA browser push only, if available.
- **No multi-tenant SaaS mode.** Self-hosted only.
- **Mobile is an ergonomics layer on irssi-shape**, not a different shape.
- **Accessibility (TTS/STT, contrast, typography) lives in cicchetto**, not on the server.

---

## Open design questions

Tracked here until resolved in the README or an issue.

- ~~**Client framework:** Svelte vs SolidJS vs plain lit-html. Decision deferred to Phase 3 (client walking skeleton). Criteria: PWA shell ergonomics, service-worker story, bundle size budget (≤200 KB gzip target before optional Vosk/piper drop-ins). Note: any choice integrates with `phoenix.js` (3KB, framework-agnostic) for the Channels client.~~ **Resolved 2026-04-26:** SolidJS 1.9 + TypeScript 6 + Vite 8 + Bun 1.3 + Biome 2.4 + `phoenix.js` 1.8. See dedicated DESIGN_NOTES entry above.
- **KV vs sqlite for scrollback:** sqlite via `ecto_sqlite3` is the chosen default. The pagination-heavy access pattern + per-user row counts + the need for indexed lookup by (channel, server-time) all favour SQL. Revisit only if the sqlite file turns out to be the bottleneck.
- ~~**Session token format:** `Phoenix.Token` short-lived access + long-lived refresh, or single long-lived + revocation list. Phase 2 concern.~~ **Resolved 2026-04-25:** opaque UUID session ID + sliding 7d idle expiry + revocation table. See dedicated DESIGN_NOTES entry above.
- **How to expose multi-network per user in the UI** without descending into tree-view hell. Phase 3 concern.
- **Coverage floor:** start CI at 80%; ratchet up each major release. No exclusion lists — if a file is hard to test, the design needs fixing, not the gate.

---

## 2026-05-12 — CP24 bucket C: IRC outbound + AuthFSM hardening

Third slice: the IRC outbound trust + validation asymmetry theme
(irc/S2-S6), five HIGH findings. All target `lib/grappa/irc/`, which
the Phase-6 listener facade reuses as a library — each fix must be
self-defending at the IRC boundary, not reliant on upstream callers;
also pre-empts the "future REST/admin caller bypasses the schema"
class.

### irc/S3 — `send_privmsg/3` empty-target reject

`""` passed `safe_line_token?/1` and yielded the malformed frame
`PRIVMSG  :body\r\n` — the upstream silently drops it and the
operator sees a no-op with no error path to grep. Fix: `target != ""`
guard (mirrors send_pong's S9 precedent). PRIVMSG deliberately does
NOT require the `#&+!` channel prefix — RFC 2812 allows
nick-as-target; "non-empty" is the right floor.

### irc/S2 — `send_join`/`send_part` `valid_channel?` gate

Un-prefixed targets slipped through, creating `:pending`
window-state entries the upstream can never JOIN; the 403
ERR_NOSUCHCHANNEL reply often carries a normalised channel name that
doesn't match what we sent, so the pending entry never resolves and
the sidebar greys the window forever with no operator breadcrumb.
Fix: `Identifier.valid_channel?/1` gates both, matching the other
channel-targeted verbs (send_topic, send_kick, send_invite, etc.).

**CRIT-1 follow-up:** widening the return contract to
`:ok | {:error, :invalid_line}` left the
`Server.handle_cast({:send_join,_},_)` / `send_part` clauses pinned
on strict `:ok = ...` — a latent MatchError. The only live caller
(channels_controller) pre-gates, but a bypass caller (mix task, IEx,
future CLI verb) would crash the Session. Two-layer fix per "Total
consistency or nothing": (a) `Session.send_join/part` facade gates
`valid_channel?` BEFORE the cast; (b) cast handlers get defensive
`case` arms that log + drop on `{:error, :invalid_line}`. Post-fix
malformed channels never reach the cast, so `record_in_flight_join`
never fires and no wedged `:pending` entry can exist. Facade tests
pin the ordering "shape rejection beats whereis lookup".

### irc/S6 — `:logger_metadata` type tightening

`Client.opts.logger_metadata` was `keyword()` — any key was legal,
but the log formatter silently drops keys not in the config
allowlist, so caller and formatter diverge at format time. The sole
caller today passes `[user:, network:]` (both allowlisted); the risk
is FUTURE callers (Phase-6 facade, per-session children). Fix:
tighten the spec (new `session_metadata` alias) so Dialyzer rejects
out-of-shape calls at compile time; the allowlist stays the runtime
gate. The alias lives on `Grappa.IRC.Client` itself, NOT re-exported
from `Grappa.Log`, so the IRC namespace stays free of that Boundary
dep (parser + client slated for standalone hex extraction
post-Phase-5, memory `project_extract_irc_libs`). The two aliases
mirror by hand; cross-reference comments in both remind maintainers.

### irc/S4 — SASL PLAIN encoder NUL guard

RFC 4616 §2 forbids NUL in any of authzid/authcid/password — NUL is
the field separator. Pre-fix `sasl_plain_payload/1` only checked
`is_binary`; a NUL-bearing field produced a payload the upstream
decoded to one extra field → opaque 904 ERR_SASLFAIL. Fix: explicit
`cond` arm per field raising `ArgumentError` naming the field and
referencing the irc/S5 boundary. Defense-in-depth behind S5's
`new/1` gate; mirrors the H10 pattern (structured
operator-greppable crash beats a malformed wire frame).

### irc/S5 — `AuthFSM.new/1` self-defending CRLF/NUL boundary

Pre-fix only `validate_password_present/1` ran; every line-bound
field (`nick`, `realname`, `sasl_user`, `password`) flowed to the
registration handshake unchecked. Today `Networks.Credential`
validates CRLF/NUL on the write path, but AuthFSM is a pure FSM
reused as a library — the Phase-6 facade or any caller constructing
opts directly bypasses the schema. Fix: `validate_line_safe/1`
delegates to `Identifier.safe_line_token?/1` (the single source of
truth for "no CR/LF/NUL"); error shape
`{:error, {:invalid_line_token, field}}` names the offender.
`:nick`/`:realname`/`:sasl_user` always gated (always emitted);
`:password` only when `auth_method != :none`. The `with` chain
preserves the `:missing_password` short-circuit. `new/1` is the
primary gate; the S4 encoder is defense-in-depth.

## CP24 bucket D — Wire-shape boundary discipline (2026-05-12)

Theme 3 of the 2026-05-12 review: 5 HIGH, all wire-shape discipline.
Bucket D enforces the CP15 B7 CLAUDE.md law ("Wire conversion is
per-context responsibility — context-owned `*.Wire` modules") across
the four drifted sites; adds `Grappa.Cic.Wire` (the codebase's 7th
wire module) and extends `Scrollback.Wire` + `Session.Wire`.

### lifecycle/S10 NON-FINDING

Review claimed `Grappa.Cic.Bundle`'s `exports: []` blocked
`current_hash/0` from web. Reading the Boundary library: for
`top_level?: true` boundaries the module itself IS the exported
surface — `exports:` only constrains submodules. Sibling
`Grappa.WSPresence` (same shape) is called from `AdminController`
cleanly; live compile shows zero Boundary warnings. Third
NON-FINDING in the mega-cluster (A's C2, B's S7) — pattern: re-read
the code, contradict the reviewer with evidence.

### web/S2 — `ArchiveJSON` delegate to `Scrollback.Wire`

`ArchiveJSON.index/1` handcrafted the per-target wire shape inline
with string keys, duplicating the contract. Fix:
`Scrollback.Wire.archive_entry/1` (atom keys, `Atom.to_string/1` on
`:kind`) + `archive_index/1` (REST envelope); atom-keyed Wire output
→ Jason serializes byte-identical string-keyed JSON, existing tests
unchanged.

### web/S3 + web/S4 — `Session.Wire.member/1` unifies REST + Channel

The per-member shape lived NOWHERE: `MembersJSON` returned
`Session.member()` raw (no Wire boundary) and the `members_seeded`
event built `members:` independently — drift hazard, and a future
struct-wrap on `Session.member()` would silently leak
Elixir-internals onto the wire AND re-introduce the CP15 B6
fastlane-crash class on the broadcast path. Fix:
`Session.Wire.member/1` (pattern-matches `%{nick:, modes:}` and
rebuilds, filtering any future extras to the contract) +
`members_index/1`; both REST and Channel funnel through `member/1`.
Envelope shapes stay surface-specific (REST snapshot vs Channel
event with network/channel context); the per-member shape is the
unification point. JSON output byte-identical.

### cross-module/S4 — `Cic.Wire.bundle_hash/1`

`%{kind: "bundle_hash", hash:}` was inline in TWO sites
(`AdminController.cic_bundle_changed/2` +
`GrappaChannel.push_bundle_hash/1`); the review listed only one,
bucket D closed both ("implement once, reuse everywhere" —
principled scope, not broadening). New `Grappa.Cic.Wire` with
`top_level?: true, deps: []` mirrors sibling `Cic.Bundle`
(independent surfaces, no shared context module).

### Reviewer follow-ups / carry-forward

Bucket-Z carry-forward: H-Z1 (`query_windows_list` envelope inlined
in 3 sites — same class as cross-module/S4) + L3 (auth_json
user/visitor `kind:` discriminator inlined, one site per
discriminator). In-bucket: `members_seeded/3` docstring amended
(projection through `member/1` does NOT re-sort) +
filter-to-contract regression test.

## CP24 bucket E — Channel inbound validation + visitor coverage (2026-05-12)

5 HIGH from Themes 4 + 5. Common thread: the OUTER untrusted
boundary (Channel WS inbound, visitor surface) was weaker than the
inner ones; bucket E mirrors bucket C's self-defending discipline at
the WS edge and extends visitor coverage to symmetry with users.

### web/S6 — `topic_set` tagged-tuple gates

The `with`/`else` matched raw `true`/`false` from two different
boolean sources mapped onto the same `else` arms — adding ANY new
boolean check above either site silently flips the user-visible
error message (both branches still return SOME error, just the
wrong one). Fix: helpers return tagged tuples
(`{:error, :invalid_line}` / `{:error, :visitor_not_allowed}`) so
`else` arms match per source. Pinning tests prove the mapping —
pre-fix they passed by ordering coincidence, post-fix by design.

### web/S7 — Channel inbound IRC-shape validation gates

Every `handle_in/3` accepting channel/nick/mask/target_nick trusted
the IRC core to reject malformed input, while REST already gated via
`GrappaWeb.Validation.validate_*` — asymmetric trust at two doors to
the same backend; a hostile cic or compromised user could push
CRLF/NUL over WS. Fix: `validate_args/1` recursive list-of-pairs
validator (channel/nick/nicks/mask/line/params) returning a
closed-set tag enum `:invalid_channel | :invalid_nick |
:invalid_mask | :invalid_line` (stable cic-facing atoms; the tighter
`@spec` also silenced a Dialyzer success-typing warning).
`dispatch_ops_verb` + `dispatch_subject_verb` migrated to arity-3
with a MANDATORY validate_thunk — the old arity-2 fully removed (no
default-arg two-pattern drift). All verbs thread it; 13 boundary
tests pin the specific tags (CRLF channel → `invalid_channel`, not
`invalid_line`).

### web/S5 — Visitor bundle broadcast

`UserSocket.connect/3` skipped `WSPresence.register/2` for visitors
(to keep auto-away user-only) — but the same registry is the source
of truth for `cic-bundle-changed` fan-out
(`WSPresence.list_user_names/0`), so long-lived visitor tabs never
saw the refresh banner and silently rotted on stale bundles. Fix:
register every WS pid (user AND visitor). Auto-away stays user-only
because visitor `Session.Server` doesn't subscribe to
`Topic.ws_presence/1` (the `match?({:user, _}, opts.subject)` guard
in init) — visitor registration is a harmless no-op on that path.
One registry for both consumers; a parallel `list_visitor_names/0`
would be the noun-fork anti-pattern. `client_closing/2`
symmetrically forwarded for visitors (pagehide decrement).

### lifecycle/S1 — Visitor `credential_failer`

Visitor sessions had no equivalent of the user-side
`credential_failer` that `Networks.SessionPlan` injects: K-line /
permanent-SASL exited the Session silently, `expires_at` stayed
future, and Bootstrap respawned the rejected visitor on every app
start with no operator signal (silent-retry anti-pattern, memory
`feedback_silent_retry_anti_pattern`). Fix mirrors the user flow:
`Visitors.mark_failed/2` expires the row (Bootstrap stops returning
it; Reaper sweeps at the next 60s tick; idempotent; `:not_found` on
a delete race), structured operator-visible `Logger.error`, and
`Visitors.SessionPlan.build_plan/3` injects the failer in every
visitor plan. The closure captures the visitor id (not the struct)
so a delete-between-spawn-and-failure race surfaces cleanly via
`:not_found` rather than a stale-row write.
`handle_terminal_failure/2`'s guard already accepted both shapes —
only the injection site was missing.

### web/S8 — `list_members/3` `:uninitialized` state

`{:ok, []}` was ambiguous between "no NAMES burst yet" and "channel
has 0 members" — cic couldn't choose "loading…" vs the empty state.
Design call — add state or derive? `state.members[channel] =
%{own_nick => []}` is structurally identical between
joined-pre-NAMES and joined-alone-post-NAMES; the disambiguating
signal is "did 366 RPL_ENDOFNAMES fire?", which is event flow, NOT
derivable from current state — so a `seeded_channels :: MapSet.t()`
sentinel is the principled fix despite the derive-first rule.
Populated on the 366 `members_seeded` effect; pruned
post-`EventRouter.route/2` against `Map.keys(state.members)` on BOTH
apply_effects routes so self-PART/self-KICK stays consistent.
`list_members` returns `{:ok, :uninitialized}` pre-366;
`MembersController` renders it as HTTP 204 (matters mainly for
non-cic REST consumers); the channel cold-snapshot push skips on
`:uninitialized` (cic's "loading…" holds until the canonical
`members_seeded` event) but pushes a genuinely-empty list. cic
MembersPane needed NO changes — its existing branches now match an
honest server signal. Closes 2/3 open issues in memory
`project_names_ux_silent_bugs`.

## CP24 bucket F — Cicchetto own-nick + nick-comparison + Network type split (2026-05-12)

4 HIGH from Theme 8: cicchetto correctness — put contracts in the
type system (discriminated unions, single-source helpers, boundary
tagging) instead of scattered defensive checks.

### Bucket F H2 — CSP allowlist hCaptcha extension (`security-headers.conf`)

The nginx CSP allowlists covered Cloudflare Turnstile only;
selecting hCaptcha in prod failed silently with the misleading
"ad-blocker" catch-all message (the iframe was CSP-blocked, not
ad-blocked). Fix: add `https://*.hcaptcha.com` to `connect-src` +
`script-src` + `frame-src` + `style-src` (the widget loads an
external stylesheet that the existing `'unsafe-inline'` doesn't
cover; modern hCaptcha needs no `'unsafe-eval'`). Edits live in the
snippet so the `/` location and `/sw.js` override stay in lockstep
with one edit. Verification = browser smoke (network-edge
enforcement; not unit-testable).

### Bucket F H1 — own-nick foot-gun (`Shell.tsx`, `MembersPane.tsx`)

Two callsites re-introduced the `displayNick(me)` foot-gun closed in
cic H3 on 2026-05-08: `displayNick(me)` returns the operator ACCOUNT
name, which diverges from the per-network IRC nick after NickServ
ghost recovery (account "vjt", nick "vjt-grappa") or can match an
unrelated peer's nick. The canonical helper
`ownNickForNetwork(net, me)` already existed in `lib/api.ts` with a
warning block; fix aligns Shell (per-slug `ownNickForSlug` resolver)
+ MembersPane (via `networkBySlug`) with it. Failing vitest pins the
account-name ≠ IRC-nick scenario — pre-fix `ownModes` returned the
PEER's modes.

### Bucket F H3 — case-insensitive nick comparison (`nickEquals` helper)

`members.ts` + `ScrollbackPane.tsx` used bare `===` for nick
comparison while `subscribe.ts` used `.toLowerCase()`. Three bug
classes from the drift: **phantom members** (server emits `Alice` on
JOIN then `alice` on QUIT — casing varies across the round-trip,
especially after NickServ ENFORCE/GHOST; the QUIT row never matched,
member count drifted upward with no recovery short of rejoin);
**missed self-JOIN banner** (row sender casing vs configured own-nick
casing); **ownModes lookup miss** (op-gated context-menu items
disabled for an actual op).

Per RFC 2812 §2.2 nicks are case-insensitive with a custom fold
(`{ } |` are lowercase `[ ] \`), but cic uses ASCII `.toLowerCase()`:
(1) subscribe.ts already did, correct in production for months — a
stricter second policy would silently split behavior at the
boundary; (2) nicks distinguishing `{user}` vs `[user]` are
vanishingly rare. Future stricter casemapping = single helper edit;
every callsite already routes through it. Per "Total consistency or
nothing" EVERY cic nick comparison migrated to `nickEquals` —
including the four already-correct subscribe.ts sites — plus a
`modeApply.ts` follow-up in the same bucket (same class: MODE
silently no-op'd on a casing mismatch between the target arg and
the store). `lib/nickEquals.ts`: `nickEquals(a, b)` +
`normalizeNick(s)` (for Map/Set keys), both null-safe.

### Bucket F H4 — Network discriminated union (UserNetwork | VisitorNetwork)

`Network.connection_state` (+ `nick`, reason, changed_at) were `?:`
optional — matching the wire reality (visitor = bare; user = adds
nick + 3 connection_state fields) but unenforceable: every consumer
wrote defensive `?.connection_state` and the branches drifted.
Mirrors the user-vs-visitor `MeResponse` discriminated union already
in `lib/api.ts` — same domain boundary, same enforcement.

Implementation: `Network` split into `UserNetwork | VisitorNetwork`
with `RawNetwork` as the pre-tag wire shape;
`tagNetwork(raw, subjectKind)` promotes at the fetch boundary
(user-subject contract violations — missing nick or
connection_state — drop the row + log); the networks resource
re-keyed on `user` (was: token) so the tagger knows the subject
kind; `ownNickForNetwork`, `mutateNetworkNick` (visitors can't NICK
— the visitor IS the nick), ComposeBox and Sidebar all narrow on
`kind === "user"`. The server emits NO `kind` discriminator (the
shape difference is implicit in the request auth subject); cic
injects it at the fetch boundary so downstream consumers narrow
instead of probing.

The discriminated-union-at-the-boundary-fetcher shape is the
template for U2 codegen — the kind discriminator is the natural
anchor for generated TS unions from server-side Wire modules.

---

## CP24 bucket G — Cross-surface drift + envelope unification (2026-05-12)

**Theme 7** plus the U1/U3/U4 unification opportunities: 4 HIGH
closed (cross-surface/H1-H4) + 3 unifications (U1 `Grappa.Wire.Time`,
U3 `narrowChannelEvent`, U4 unified 422 envelope). H5 demoted to MED
by the cross-surface agent, stays on the bucket Z list. Every
finding edits the server↔cic wire-shape contract or a
narrowing/projection across it.

### Bucket G U1 — `Grappa.Wire.Time` shared helper

`Networks.Wire` was the only module with a private
`iso8601_or_nil/1` shim; the next nullable-timestamp site would have
re-implemented it with drift inevitable. Extracted to
`Grappa.Wire.Time.iso8601_or_nil/1` in a NEW `lib/grappa/wire/`
directory — deliberately OUTSIDE the per-context Wire boundary
because timestamp formatting is not a context concern
(`inserted_at`/`expires_at`/`connection_state_changed_at` all want
the same wire shape regardless of owning context). Documented as the
FIRST cross-context helper in `lib/grappa/wire/` and the precedent
for future cross-context wire primitives.

### Bucket G H1 — Login.tsx dead `captcha_provider_unavailable` arm

`friendlyMessage` had an arm for a wire token the server NEVER
emits: every upstream captcha-verification failure becomes
`{:error, :captcha_provider_unavailable}`, which FallbackController
renders as 503 with wire body `%{error: "service_degraded"}`. A real
provider outage hit the `default` arm and showed the raw
`"503 service_degraded"` instead of the friendly copy — silent UX
degradation hidden because the dead arm sat next to the live one.
Fix: drop the dead arm; docstring on the `service_degraded` arm pins
where the token comes from and when it fires.

### Bucket G H2+U4 — Unified `validation_failed` envelope

The 422 changeset path emitted `%{errors: %{field => [msg]}}` — no
`error` discriminator, matching neither the canonical A7
`{error: "<token>"}` envelope nor Phoenix's `ErrorJSON` shape. cic's
`readError` chain (`body.error → errors.detail → res.statusText`)
fell through to statusText: every 422 collapsed to "Unprocessable
Entity", losing field-level info. Post-fix:
`%{error: "validation_failed", field_errors: %{field => [msg]}}` —
A7 snake_case discriminator, `field_errors` top-level alongside the
existing `site_key`/`provider`/`retry_after` convention (cic's
`ApiError.info` reads top-level body keys directly). Single emitter
(FallbackController's changeset clause), single client path; cic
gains a `ValidationError` alias and `readError` gets a docstring
pinning the resolution-order contract.

### Bucket G H3 — `WireChannelEvent` consolidation

The per-channel WS event union was duplicated with DIFFERENT
breadth: api.ts declared a one-arm `ChannelEvent`; subscribe.ts
redeclared the full 6-kind union locally. Consumers importing the
narrow type narrowed vacuously; new arms in subscribe.ts surfaced
nowhere — same drift class as bucket F's Network split. Fix: single
canonical `WireChannelEvent` union in api.ts mirroring
`WireUserEvent` (CP16 B5); `assertNever` exhaustiveness catches new
arms at tsc compile time; legacy `ChannelEvent` retained as
`Extract<WireChannelEvent, {kind: "message"}>` so existing callsites
keep working without a rename. Type-only imports from peer leaf
modules keep api.ts effectively leaf load-order-wise.

### Bucket G H4+U3 — `narrowChannelEvent` runtime narrower

subscribe.ts cast the raw Phoenix payload directly as
`WireChannelEvent` — a lie the type system can't enforce (phoenix.js
payloads are unknown-shaped JSON); a malformed server push (kind
valid, required field missing/wrong-typed) would crash a setter or
silently corrupt store state. Same gap the CP16 `narrowUserEvent`
fix closed on the user topic. Fix: `cicchetto/src/lib/wireNarrow.ts`
with `narrowChannelEvent(raw: unknown): WireChannelEvent | null` —
exhaustive per-arm shape validator; null on mismatch → subscribe.ts
drops + logs. Both per-channel handlers narrow BEFORE the dispatch
switch; the cast is gone. wireNarrow.ts is the sanctioned home for
future per-topic narrowers (e.g. `narrowAdminEvent`); a leaf module
— no effects, no reactive imports — trivially testable (31 tests,
valid + malformed shapes per arm).

The H3 canonical union + H4 narrower pair so the SAME type serves
compile-time consumer narrowing (tsc) AND runtime payload validation
(drop-and-log) — single source for both paths.

## CP24 bucket H — Lifecycle correctness + boot perf (2026-05-12)

**Theme 6.** 3 HIGH closed (lifecycle/S2 unify, S3 EXIT
classification, S4 service allowlist); lifecycle/S5 (parallelize
spawn_all) deferred — see below.

### Bucket H lifecycle/S4 — `service_target?/1` closed allowlist

The `*Serv` privacy filter for outbound PRIVMSG used
`String.ends_with?(target, "serv")` after lowercase — ANY target
ending in those bytes silently bypassed scrollback + PubSub
broadcast: channels like `#dataserv`, legitimate nicks like
`Conserv`. The silent drop is the worst kind of bug: nothing in
scrollback, no log to correlate. Fix: closed allowlist of the seven
well-known service nicks (nickserv chanserv memoserv operserv
botserv hostserv helpserv); channel-prefixed targets (`#&+!`) bypass
via dedicated function clauses — services are nicks by definition
(PRIVMSG to a channel goes to the room, not a service bot).

### Bucket H lifecycle/S3 — Client EXIT classification fix

The clean-Client-EXIT clause returned
`{:stop, {:client_exit, reason}, _}` for
`reason ∈ {:normal, :shutdown}` — but `:transient` supervision
classifies anything other than `:normal | :shutdown | {:shutdown, _}`
as ABNORMAL, so the wrapped clean exit triggered an immediate
restart while the comment claimed the opposite. Unreachable in
production today (Client has no self-stop path; parent `:shutdown`
routes via `terminate/2`'s graceful-QUIT handler), but a future
`Client.stop/1` would silently trip restarts. Per CLAUDE.md
"`:transient` sessions don't restart on `:normal` shutdown", clean
Client exit now returns `{:stop, :normal, _}`. Tests probe the
supervisor side: after stopping the linked Client with `:normal` /
`:shutdown`, `Session.whereis/2` MUST return nil — a restart would
re-register a fresh pid under the same via-name. Backoff accounting
unchanged (clean exit doesn't bump, abnormal still does).

### Bucket H lifecycle/S2 — Bootstrap two-pass unification

`Bootstrap.run/0` walked the credential set TWICE
(`validate_credential_servers!/2` + `spawn_all/1`'s
`SessionPlan.resolve/1`), both firing the same SQL against
`network_servers`. Fix: upgrade
`Credentials.list_credentials_for_all_users/0`'s preload from
`[:network]` to `[network: :servers]` — validate reads the
in-memory assoc (zero queries) and resolve's preload becomes a
no-op. Visitor rows (no credential preload) consolidate through new
`Networks.get_network_with_servers_by_slug/1` so Bootstrap stays
Boundary-clean (no direct Repo dep). Verb separation preserved:
validate stays a hard-fail invariant (raise on zero enabled
servers), resolve stays a soft-error resolver
(`{:error, :no_server}`); both now read the SAME data.

### Bucket H lifecycle/S5 deferral — parallelize spawn_all

The attempt (`Task.async_stream` across network_id groups —
per-network serialization preserving cap correctness) passed its own
tests but tripped **6 regression failures** in bootstrap_test under
parallel test pressure: the singleton
`Grappa.Admission.NetworkCircuit` ETS table is application-wide, NOT
sandbox-scoped — one test's spawn failures contaminate circuit state
for the next test hitting the same `network_id` (sqlite-rowid
recycling). Masked pre-change by the strictly-sequential spawn
rhythm. Reverted; the correct fix needs either a per-network
admission lock (heavier than the sequential baseline it replaces) or
NetworkCircuit isolation at the sandbox boundary (test-infra design
surface). Deferred to a dedicated cluster. The perf concern (~50
credentials = O(seconds) boot) is real but theoretical at current
scale; sequential spawn is the SAFE default until the
test-isolation work lands.

## 2026-05-12 — bucket I LANDED-with-caveat: Theme 9 cross-module + docker debt + sensitivity-gate cleanup

1. **CVE close — `decimal 2.4.1 → 3.1.0`.** GHSA-rhv4-8758-jx7v
   (moderate DoS via unbounded exponent in `Decimal.new`) published
   mid-bucket. `doctor 0.22.0`'s `~> 2.0` transitive constraint
   blocks the bump (stale upstream, no fix available), so `decimal`
   declared as a top-level dep with `override: true` — safe because
   grappa has zero direct `Decimal.` call sites (grep-verified).
   Landed first per "fix pre-existing errors first".

2. **cross-module/S1 + docker/H2 — codify long-lived module list.**
   The `scripts/deploy.sh` preflight regex checked `defstruct` lines
   on modules three of which carried state as bare maps
   (structurally blind to its own list), and `Grappa.Visitors.Reaper`
   was missing from BOTH the regex AND the CLAUDE.md hot-vs-cold
   enumeration — two enumerations drifting independently. New single
   source of truth `Grappa.HotReload.LongLivedModules`: `@modules`
   (Backoff, WSPresence, NetworkCircuit, Session.Server, IRC.Client,
   IRC.AuthFSM, Visitors.Reaper) + `@state_helpers` (AwayState,
   GhostRecovery, WindowState), parsed by deploy.sh via a stable
   attribute grep + CamelCase→snake_case translation; each touched
   file is scanned for `defstruct`, `@type t :: %{`, or `def init(`
   markers — covering struct AND bare-map state shapes.

   `defstruct` added to WSPresence + Reaper. `Session.Server` stays
   bare-map (~280 keys with optional fields; struct migration is out
   of scope for a HIGH closure — carry-forward). `NetworkCircuit`'s
   state is `%{}` (data lives in ETS) — a defstruct would be
   vacuous; the `def init(` marker covers future additions. Gotcha:
   structs do not implement Access — six `put_in`/`update_in` sites
   in WSPresence rewrote to `%{state | k: Map.put(...)}` (687 test
   failures on first attempt, 0 after). The `@type long_lived` /
   `state_helper` unions intentionally duplicate the atom lists:
   dialyxir's `:underspecs` fails with `contract_supertype` on any
   divergence, so the duplication is CI-enforced; the shell grep
   targets the `@modules` attribute lines, preserving single-SoT for
   script parsing.

3. **cross-module/S2** — the sole inline-interpolation Logger
   violation in the codebase (`auth_controller.ex` logout-broadcast
   warning) moved `socket_id` to KV metadata; `:socket_id` added to
   the config allowlist. Per memory `project_logging_format`.

4. **Sensitivity-gate — Turnstile placeholder.** `.env.example`
   shipped vjt's actual PUBLIC Turnstile site_key (confirmed public,
   embedded in served HTML — cosmetic, no rotation event). Replaced
   with a placeholder + generic comment. 10+ `grappa.bad.ass`
   hostname references across the repo deferred to a post-Phase-5
   lock-step sweep (default hostname touches fresh-clone deploy
   ergonomics). `compose.prod.override.yaml` confirmed untracked; no
   history rewrite.

5. **Cherry-picked docker MEDs (S2, S6, S7).** Dead
   `LABEL grappa.hot_deployable=true` dropped (CP23 replaced the
   per-image-tag flip with deploy.sh's git-diff preflight; nothing
   reads the label). Dead `dist/` dropped from `.dockerignore` (path
   moved under `runtime/` in CP23). Baked
   `runtime/cicchetto-dist/.gitkeep` + `runtime/bun-cache/.gitkeep`
   so fresh-clone compose doesn't auto-create the bind-mount targets
   as `root:root` (container UID 1000 then fails the write — opaque
   AccessDenied; same class as memory
   `feedback_named_volume_uid_trap`; pre-creating under operator UID
   sidesteps it). `.gitignore` needed explicit re-glob exception
   triplets for the new subdirs (the parent `/runtime/*` ignore +
   `!/runtime/.gitkeep` did not cover them).

### Caveat — ci.yml RED on FIRST RUN (test-infra carry-forward)

integration.yml green on first run; ci.yml red with 1 failure in
`spawn_orchestrator_test.exs:251` — got
`{:error, :network_cap_exceeded}` where the initial spawn should
succeed, meaning the network's `max_concurrent_sessions: 1` cap was
already consumed BEFORE the test's own attempt.

**This is the documented shared-singleton fight** in test infra: the
Application starts ONCE per test process; async cases (`max_cases=2`
+ `async: true`) share singleton GenServers — Backoff,
NetworkCircuit, SessionRegistry — plus their ETS tables, so two
async tests racing the same network's cap keys collide when the
second inherits leftover session state. Same root cause surfaced
repeatedly across the mega-cluster: an earlier ci.yml failure in the
same file (different line), bucket H's BootstrapTest flake series
(the PHASE 1.3 `wait_until_registry_clear` helper patched ONE call
site, not the class), and bucket H's lifecycle/S5 revert. The class
is unfixed and surfaces in whichever async file ExUnit schedules
into the bad slot.

Bucket I content does NOT cause this — its changes are structurally
isolated from the SpawnOrchestrator → NetworkCircuit → ETS path;
local gates green on every commit, integration green, cold-deploy +
healthcheck green. The shared-singleton fix is the principal item
for the post-mega-cluster **test-infra** cluster. Scope (per vjt):
root-cause architectural fix (per-test ETS namespace +
supervised-per-case Backoff/NetworkCircuit/SessionRegistry, OR
sequential-but-correct), mandatory test-suffix on every network slug
+ user id, audit every `async: true` test hitting Application
singletons. Acceptance: ALL ci.yml + integration.yml GREEN ON FIRST
RUN, no exceptions, no `gh run rerun --failed` ever.

Bucket I is LANDED-with-caveat — ci.yml red traceable to the
deferred class. Bucket Z opens for sweep + carry-forward closure +
mega-cluster close; test-infra cluster after Z.
## 2026-05-12 — bucket Z LANDED-with-caveat: carry-forward closures + long-tail sweep + mega-cluster close

Closure batch for prior buckets' carry-forwards + long-tail MED+LOW
sweep + mega-cluster retrospective. Every carry-forward re-evaluated
against current code BEFORE shipping.

### Z-1 carry-forward closures

- **H-Z1 query_windows_list envelope unification** — only the OUTER
  envelope was hand-rolled; per-window body already delegated to
  `QueryWindows.Wire.render_grouped/1`. Lifted to
  `Wire.windows_list_payload/1`; `GrappaChannel`'s `@type` becomes a
  thin alias so typespec/constructor/consumer share one SoT.
- **persistence/S18 `User.password_hash` `redact: true`** — both
  `password_encrypted` fields already redacted; `password_hash` was
  the outlier: `inspect(%User{})` leaked Argon2 algorithm + salt +
  cost params (fingerprintable).
- **L3 `auth_json` `:kind` discriminator — NON-FINDING.** `kind:
  "user"|"visitor"` is a controller-action shape, NOT a Wire concern;
  lifting to a hypothetical `Auth.Wire` would force the auth domain
  into both context Wire modules — boundary violation.
- **persistence/S13 (kind-enum CHECK frozen-snapshot) — NON-FINDING.**
  `check_constraints_test.exs` already reads `Message.kinds()` from
  the prod accessor and asserts every kind passes the CHECK — the
  drift guard exists.
- **persistence/S15 (`EncryptedBinary` field-name lie) — DEFERRED.**
  Renaming `password_encrypted` is a multi-module rename + migration;
  post-Phase-5.
- **persistence/S17 (`:utc_datetime` vs `_usec`) — DEFERRED.**
  Aligning `query_windows.opened_at` needs an `alter table`; post-
  Phase-5.

### Z-2 long-tail sweep

- **`require Logger` hoist** — top-of-module require, placed post-
  alias per Credo's ConsistentAliasOrder. Lesson: trust Credo over the
  "directive goes before aliases" instinct.
- **`async: false` rationale documented** — `LogTest` (mutates
  `Logger.metadata/1`) and `ApplicationTest` (reads
  `:persistent_term`, node-global) are genuinely async-false-required;
  documented at the declaration site so refactors don't re-derive or
  break the constraint.
- **CLAUDE.md PubSub topic shape correction** — CLAUDE.md documented
  non-user-rooted topics but Phase 2 sub-task 2h shipped user-rooted
  ones (cross-user authz at the routing layer). `Grappa.PubSub.Topic`
  was correct; CLAUDE.md was the divergent source and would have
  misled future agents into topics that bypass the authz partition.
  Both point at `Topic` as SoT.

### Caveat — ci.yml RED on FIRST RUN, integration.yml GREEN

Same shared-singleton class as bucket I
(`spawn_orchestrator_test.exs`). Bucket Z touches none of the
admission/backoff/orchestrator/circuit/registry code. Documented as
LANDED-with-caveat, handed to the test-infra cluster — do NOT spend Z
time on it.

### Mega-cluster CLOSED

10 buckets (A–I + Z + H regression cluster) in one day. 37 HIGH
closed; 1 deferred (lifecycle/S5 → test-infra); 0 CRITICAL; ~62 MED +
~58 LOW catalogued.

Worked: per-bucket deploy caught the H regression within 30 min;
sequential (not parallel) buckets avoided merge-hell on
`Scrollback.Wire`/`Session.Server`/`admission/`; reviewer pass after
every LANDED claim; NON-FINDING discipline (verify with live probe +
source read before fixing) avoided 4+ false-fix commits.

Didn't: shared-singleton test class surfaced ~5×, never fixed
(documentation is no substitute for the architectural fix → test-infra
cluster); `deploy.sh` regex structurally blind to bare-map state
shapes — encode the module list in Elixir
(`Grappa.HotReload.LongLivedModules`) and parse from the script, don't
parallel-maintain a shell enumeration; DESIGN_NOTES docgen residuals
left deliberately (rewording would erase original decision phrasing);
~13h duration is a one-day burst, not a cadence — resist repeating.

## 2026-05-12 — Test-infra cluster (CP25): max_cases=1 closes shared-singleton class

### Root cause

The Application starts ONCE per `mix test` process, so
`Session.Backoff`, `Admission.NetworkCircuit`, `WSPresence`,
`SessionRegistry` are app-wide singletons. ExUnit defaults `max_cases
= schedulers_online * 2`; the SQL Sandbox covers the Repo but those
GenServers + ETS tables have no per-test sandbox. Two concurrent tests
colliding on a recycled sqlite rowid (network_id) inherit each other's
session counts / circuit / registry state — intermittent CI failures
whose failing line doesn't predict the offending pair.

### Path chosen

- **Path A (rejected)** — per-test supervised singleton instances +
  injected lookup names. Preserves async perf but invasive: 3
  production GenServer signature changes + per-test scaffolding.
- **Path B (picked, vjt-blessed)** — `config :ex_unit, max_cases: 1`.
  1 line, zero production changes, ~22s → ~42s. Per "Lightweight over
  heavyweight": the problem surfaces ~once per mega-cluster; A's cost
  is heavyweight relative to that.

Defense in depth: each singleton module gains a `## Test isolation`
moduledoc paragraph documenting the `async: false` constraint at the
declaration site, so the class isn't reintroduced if `max_cases` is
later relaxed. TI-3 gotcha: `admin_controller_test.exs` flipped to
`async: false` — cic-bundle-changed tests register fake socket pids
against the `WSPresence` singleton; the prior "no shared state"
moduledoc claim was WRONG.

Closed 2026-05-12: both workflows GREEN on first run where the two
prior docs-only commits had `ci.yml` red with the same signature —
signature-match on docs-only failures + green-on-first-run post-fix is
direct evidence the class is closed.

## CP26 — Message replay on reconnect (2026-05-13)

cic on iOS Safari (and tab-suspending contexts) loses live messages
after a transient WS disconnect; scrollback DB has the rows, only a
full refresh recovers them. Architectural gap (older than the mega-
cluster regression that surfaced it): `PubSub.broadcast/2` is fire-
and-forget — if the WS drops the instant before a row's broadcast, the
payload is silently lost for that cic session. Scrollback DB is
source-of-truth; the live stream is best-effort.

### Server delta — `Scrollback.fetch_after/6`

Mirror of `fetch/6` but cursor on `id > after_id` (NOT `server_time`):
wire shape already exposes `id`; `id` is monotonic so same-millisecond
`server_time` ties become a non-issue; returns ASC so cic appends
without a flip. REST adds `?after=<id>`, mutually exclusive with
`?before=` (both supplied or unparseable → 400; silent precedence
would mask client bugs).

### Cic reconnect-backfill (`reconnectBackfill.ts`)

- `recordSeen(key, msg)` — per-topic monotonic high-water mark, wired
  into `routeMessage` so EVERY rendered row (live AND backfilled)
  updates the cursor through the same site.
- `noteJoinOk(slug, name)` — per-topic join counter; first call =
  initial subscribe, later = re-join. Gotcha: phoenix.js's
  `Push.resend()` does NOT clear `recHooks`, so a single
  `.receive("ok", cb)` keeps firing on every auto-rejoin — the WS
  reconnect lifecycle is the natural detector, no parallel signal
  needed.
- `runBackfill(slug, name)` — GET `?after=<lastSeenId>`, dispatching
  rows through `appendToScrollback` (the SAME verb the live handler
  uses → dedupe-by-id automatic). Concurrency-guarded per key; errors
  log + leave the cursor so the next reconnect retries.

Own-nick-topic backfill recovers self-msgs only (CP14-B3 narrowing);
inbound peer DM gaps ride each per-peer query window's own cursor.

### Bonus — defensive resync on socket-open

Second gap class: a topic added server-side DURING the disconnect
window — the `channels_changed` broadcast dropped on the dead WS;
phoenix.js auto-rejoins known Channels but topics cic never knew about
stay absent until refresh. Fix: a createEffect on
`socketHealth().state` — every post-initial transition into "open"
calls `refetchNetworks()` + `refetchChannels()` (the `prev` filter
masks the initial open so bootstrap isn't double-fired). Covers BOTH
missed-message and missed-topic gaps.

---

## 2026-05-13 — channel-state numerics delegated, 329 RPL_CREATIONTIME wired (CP28 cluster `channel-created-notice`)

Bug: live DB had 94 rows of `kind: notice, body: "1776720934", meta:
%{numeric: 333}` — 333 RPL_TOPICWHOTIME leaking as scrollback noise;
same for 332 RPL_TOPIC (duplicating the typed `topic_changed`).

Diagnosis (brief was wrong): brief proposed a "Bahamut bare-integer
NOTICE" pattern + 329 dropped at the catch-all. Live DB disproved
both: 0 rows meta 329 (Azzurra never emits it), 0 bare-int NOTICE
rows. Actual source: `numeric_router.ex @delegated_numerics` was
missing `324,329,331,332,333` — `Session.Server` persists every non-
delegated numeric as a bare `:notice` row BEFORE delegating, so
EventRouter's correct handlers ran alongside duplicate notice writes.
Per "Challenge the spec", the sibling halted before writing code and
re-scoped on confirmation.

Fix: (1) add 324/329/331/332/333 to `@delegated_numerics`; (2) 329
handler caches a `DateTime.t()` in `state.channels_created` (lifecycle
mirrors `state.topics` — drop on self-PART/KICK), emits
`{:channel_created, channel, dt}`; (3) Server broadcasts via
`SessionWire.channel_created/3` (ISO-8601 string so Jason stays
trivial); (4) cic `JoinBanner` renders "Channel was created on …" and
the existing 333-fed "Topic set by … on …" (store had the data, banner
wasn't rendering it).

Why a separate state field, not extending topic_entry:
`state.channels_created` is a sibling cache — same lifecycle (JOIN-
time, PART/KICK cleanup) but different domain (creation is a channel
property, set-by/set-at a topic property). Per "reuse the verbs not
the nouns": shared execution shape is fine; merging nouns would
pollute a topic-named struct.

Hot-vs-cold: adds a field to `Session.Server`'s `@type t` →
`deploy.sh` auto-classifies COLD.

---

### 2026-05-13 — invariant flip: read state moves server-side

Original Phase 1 CLAUDE.md invariant: *"No server-side `MARKREAD` /
read cursors. Read position is client-side only. Adding it later is
forward-compatible; removing it later would break clients."*
Deliberately flipped in the `server-side-read-state` cluster. Three
forces:

1. **The cp13-S5 race.** `cp13-server-window.spec.ts:171` fails in
   cluster ordering on macOS local, passes on Linux CI. Timeline (logs
   2026-05-13): cic GETs `/messages` (empty), POSTs PRIVMSG, server
   persists + broadcasts the upstream `401 :notice` — and cic's
   Channel JOIN lands ~20ms LATER. The row is lost forever because cic
   has no way to ask "what did I miss since cursor X". With a server-
   side cursor + unified `?after=<id>` + refresh-on-join-ok, the WS
   join becomes exactly that question and recovery is deterministic.
   (The U-line server-config bug investigated 2026-05-12 was a red
   herring — cp13-S5 reproduces with that fix REVERTED.)
2. **Multi-device sync.** Each cic instance is an island; read on
   phone clears no badge on laptop.
3. **Phase 6 IRCv3 facade alignment.** `+draft/read-marker` MARKREAD
   and CHATHISTORY both presume server-side cursor storage; building
   now makes the facade a thin translation, not a redesign.

A fourth bug (operator's own JOIN/PART/QUIT counting against
`eventsUnread` on rejoin) lands in the same cluster (same file
`subscribe.ts`).

**New invariant:**

> Read state is server-owned, per (subject, network, channel). Cursor
> stored as `last_read_message_id` (FK to `messages.id`). cic reads
> the cursor from the subject envelope on login + per-window from a
> topic event; cic POSTs the operator's current position as they
> settle. Phase 6 exposes the same cursor as `+draft/read-marker`
> MARKREAD. Removing server-side cursor is a breaking change.

Schema: `read_cursors (subject, network_id, channel,
last_read_message_id)` with subject XOR check + partial unique indexes
mirroring the `messages` convention. Context: `Grappa.ReadCursor`. cic
`readCursor.ts` replaced (same name, new shape) by a signal-map fed
from `/me` + Channel join replies + `read_cursor_set` events. No
feature flag, no transition period — straight cutover per "total
consistency"; cic state is reconstructable from server state on first
load.

**Apply:** seven buckets (R-1 schema+context → R-2 REST unification →
R-3 POST+envelope+WS push → R-4 cic cutover → R-5 refresh-on-join →
R-6 own-action unread filter → R-Z cleanup). After R-5 the parked
`cluster/numeric-delegation-p0` unblocks.

---

## 2026-05-13 — CP29 server-side read-state cluster CLOSED

Seven buckets R-1..R-Z merged; `0.2.0 → 0.3.0` minor bump for the
invariant flip. Per-bucket integration ran on the branch with the cold
cutover held to R-Z, so production sees the cluster as one atom. R-5
collapsed reconnectBackfill into `refreshScrollback` (closes cp13-S5);
R-6's `isOwnPresenceEvent` predicate (`ownPresenceEvent.ts`) is shared
by the sidebar/bottom-bar badge gate AND the in-pane unread-marker
filter — closing the drift class.

Bugs closed: cp13-S5 (peer DM during WS gap recovered by refresh-on-
join); vjt's own-action unread alert (own
JOIN/PART/QUIT/MODE/NICK/KICK rows no longer surface in the `── XX
unread ──` marker).

Deferred (documented for future readers):
- **Auto-set cursor on operator's own POST** — not wired; the
  `selection.ts` focus-leave model (+ browser-blur arm) is the
  canonical "I've moved on" signal, uniform across own-msg/peer-
  msg/scroll-up. Wiring site if needed: post-`persist_event/1`, before
  broadcast, so the broadcast carries the new cursor.
- **Explicit mark-as-unread UI** — server verb exists
  (`ReadCursor.set/4`, last-write-wins); cic exposure is a follow-up.
- **Scroll-settle cursor derivation** — cic sets cursor to scrollback
  tail on settle; deriving from the actual visible row is a follow-up.
- **Mention-click cursor-rewind** — needs `MentionsBundle` wire
  extension + one-shot scroll-to verb; separate cluster.

---

## 2026-05-14 — CP30 P-0 numeric-delegation cluster CLOSED

6 buckets, 5 typed wire events for previously-leaked Bahamut numerics:
`whois_bundle`, `peer_away` (301), `invite_ack` (341), `lusers_bundle`
(251–266), `whowas_bundle` (314/369/406 with 312 conflict-gate). Slash
commands `/lusers`, `/whowas`, `/invite` (its 341 ack was silently
dropped pre-P-0e/f).

**Mid-cluster route flip (P-0f).** P-0e shipped `invite_ack` on the
TARGET channel's topic — but operators usually invite peers to
channels they are NOT in, and cic only subscribes to joined channels'
topics, so the broadcast landed with zero listeners. P-0f flipped to
`Topic.user/1` + the always-visible $server window; payload unchanged,
`channel` becomes informational. Caught only because per-bucket deploy
mandates real browser smoke at cluster close.

**Bugs surfaced (deferred).** (1) inbound `INVITE <ourNick> <#chan>`
is silent-dropped by the EventRouter fallthrough — P-0e/f addressed
the WRONG direction (operator-issued 341 ack, not inbound INVITE); (2)
the fallthrough is a whole silent-drop class (KILL, WALLOPS, GLOBOPS,
ERROR, CHGHOST, AUTHENTICATE, vendor verbs). Both fold into the next
**no-silent-drops** cluster: fallthrough → structured `:notice`
persist with `meta.raw = %{verb, sender, params}`.

**312 conflict-gate.** Bahamut reuses 312 RPL_WHOISSERVER for both
WHOIS (serverinfo) AND WHOWAS (ctime). The clause prefers
whois_pending; else folds into the most-recent WHOWAS entry; else no-
op. WHOWAS entries stored REVERSED (head = most recent 314) so the 312
fold is O(1) head-prepend not O(n) `++` (Credo's MapInto rejects
`++`); multi-history rendering deferred.

**Cards UX renegotiation flagged.** vjt: "I am not convinced on cards
but we can renegotiate". Kept for consistency with the WhoisCard
precedent; reconsider post-no-silent-drops.

**Cold-deploy required** — P-0c/P-0d added
`whowas_pending`/`lusers_pending` to `Session.Server` state; the
preflight regex misses field additions inside existing struct blocks —
manual `--force-cold` required.

**Phase 5 cleanup.** P-3 "jitter" is ALREADY DONE (`Session.Backoff`
`@jitter_pct 25` since T31) — drop from Phase 5 scoping. P-4 PromEx +
P-5 NickServ Vault HSM deferred.

## 2026-05-14 — CP31 no-silent-drops cluster CLOSED

Surface every event the server produces; close the P-0 silent-drop
class + the broader pattern. 19 commits, 11 sub-buckets. B5 review (8
agents) → 152 findings (1 CRIT + 31 HIGH + ~57 MED + ~44 LOW). CRIT-1:
AUTHENTICATE deny-list at the EventRouter catch-all head (plaintext-
credential leak to `$server` scrollback, same class as the W12
NickServ-leak). HIGH 25/31 closed, 2 NON-FINDING, 1 deferred (H-23
`Scrollback.list_archive/3` perf via generated column → Phase 6
CHATHISTORY cluster, designed AGAINST Phase 6's actual query shape,
not speculatively).

**1. Catch-all-vs-typed-event tradeoff resolved.** B1's `:notice`
catch-all (2026-05-13) closed the visible drop but introduced three
secondary failures: CRIT-1 credential leak; HIGH-2 empty-trailing
verbs dropped by `validate_required(:body)`; HIGH-7 kind reuse —
`:notice` is a CONTENT kind, so catch-all rows leaked into any future
"human content" filter. B6.11 resolved (3) by adding `:server_event`
to `Message.@kinds`, excluded from `@body_required_kinds` AND
`@dm_with_eligible_kinds`. Migration gotcha: the sqlite full table-
recreate for `messages` (precedent 2026-05-04) PLUS a recreate of
`read_cursors` — sqlite ≥3.25 auto-rewrites dependent FK refs during
ALTER TABLE RENAME, which would have left `read_cursors` pointing at
the dropped `messages_old`. **Caught by the code-reviewer agent BEFORE
landing, not by tests.**

**2. Wire-edge runtime allowlists must be exhaustiveness-tested.**
B6.11 shipped `:server_event` end-to-end; vitest passed; then the B2
INVITE-CTA smoke failed. Root cause: `wireNarrow.ts`'s
`VALID_MESSAGE_KINDS` runtime `Set<MessageKind>` was missing
`"server_event"` — the narrower silently dropped every such row at the
WS edge, a silent-drop bug in code shipped to close silent-drop bugs.
Rule: TypeScript unions are compile-time fences; anywhere a runtime
`Set<EnumValue>` mirrors a type union, an exhaustiveness test is
mandatory infrastructure (`wireNarrow.test.ts` loops over all
MessageKind values).

**3. Subagent-driven development.** Mid-cluster drift into linear
single-thread mode — the brief made each bucket feel small, but
migration + cross-surface + cold-deploy was high-stakes. Switching to
the code-reviewer agent for the B6.11 migration design IMMEDIATELY
caught the dangling-FK-ref bug. Codified: Plan agent for design,
Explore for exploration, code-reviewer for migration + cross-surface
buckets, regardless of brief detail.

Remaining public-open blockers: image upload (HIGH-19 needs nginx
`client_max_body_size 16m`), voice (`/voice/websocket`), mobile UI
polish, M3 rate limits, W-16 signing_salt rotation, M-cic-2 strip
`__cic_*` debug globals.

## 2026-05-15 — CP32 visitor-parity-and-NickServ cluster CLOSED

10 commits, 9 production buckets. V8 DROPPED at brainstorm.

### Subject parity invariant

Pre-cluster, every server-side surface branched on `{:user,_}` vs
`{:visitor,_}` and refused the visitor branch. V1–V9 collapse those:
every persistence write builds via `Subject.put_subject_id/2`, every
read via `Subject.subject_where/2`, every controller picks subject via
`Subject.from_assigns/1`. Three subject-scoped tables
(`query_windows`, `push_subscriptions`, `user_settings`) gained the
XOR FK pattern `read_cursors` had since CP29 — `(user_id IS NULL) <>
(visitor_id IS NULL)` CHECK + two partial UNIQUE indexes + ON DELETE
CASCADE to both parents. Deleting a visitor wipes all owned tables in
one Reaper sweep — the DB does the work. **Invariant:** every surface
accepts both subjects and dispatches through `Subject.t()`; any
REMAINING per-subject difference must be explicitly justified — today
only V7's TTL.

### Two-tier identity model

| Subject | Auth proof | Data lifetime |
|---------|-----------|---------------|
| Anonymous visitor | none (visitor row + bearer) | 48h sliding TTL — Reaper sweep + FK CASCADE wipes everything |
| NickServ-identified visitor | NickServ password verified vs upstream `+r` MODE | **infinite** — `expires_at = NULL` |
| Registered user (admin/operator) | local Argon2 (`users.password_hash`) | infinite (`mix grappa.create_user`) |

V7: anon visitors get `expires_at = now + 48h` on every touch;
identified visitors get `expires_at = NULL` at the `commit_password/2`
transition (from the `{:visitor_r_observed, password}` effect on
upstream `+r`). `Visitors.touch/1` no-ops for identified; the Reaper
carries `AND expires_at IS NOT NULL`. `Visitors.Login.login/2`
supports returning-from-new-device: nick + NickServ password matched
against `password_encrypted` REUSES the existing visitor row (no new
id); mismatch → `:invalid_credentials` (uniform with user wrong-
password, no enumeration).

### V8 dropped — NickServ identification IS the permanent identity

Pre-cluster spec carried V8 "promote visitor → registered user with
reparenting transaction". Dropped: NickServ ID with infinite TTL
already provides that tier; capability-equality comes from the V1 XOR
FK migrations. No double-password UX, zero data-migration code, zero
double-account-state classes. "Registered user" exists ORTHOGONALLY as
the admin/operator path, not a promotion target. V8 numbering reserved
for a future optional "admin creates non-IRC accounts".

### V9 NICK rename safety

Pre-V9 the visitor branch at `nick_controller.ex` returned 403. V9
lifts it. Two lines of defense on `(nick, network_slug)` UNIQUE: (1)
pre-check `Visitors.nick_in_use?/3` BEFORE the upstream NICK → 409
(catches >99% of races at the boundary); (2) UNIQUE constraint at the
EventRouter persist site via `Visitors.update_nick/2`, logged +
dropped on collision per no-silent-drops. Users don't carry the
persister (nick lives in `Networks.Credential`); visitors route
through an injected `visitor_nick_persister` fn-ref (mirror of
`visitor_committer`) — the opaque indirection that dodges the
`Visitors → Session` boundary cycle. vjt VETOED the orchestrator's
complex sync-wait + 422-on-433 + `pending_nick_rename` correlation
design: user path stays fire-and-forget 202; 432/433 silently leaves
the DB unchanged via natural EventRouter shape (no echo → no effect →
no write). The pre-existing UX hole around silent 432/433 stays open
(orthogonal).

### HOT-vs-COLD preflight gap (landmine)

V9 added a `Session.Server` field (`visitor_nick_persister`) — the
deploy.sh AST oracle SHOULD have caught it, but the operator ran `git
merge --ff-only` BEFORE `deploy.sh`: the deploy's `git pull --ff-only`
returned "Already up to date", the preflight diff was empty,
classification was falsely HOT. `CodeReloader` accepted the reload but
`_build/prod` corrupted; `--force-cold` then failed compile_env
validation. Recovery: `rm -rf _build/prod && deploy.sh --force-cold`.
**The CLAUDE.md "merge → deploy" canonical workflow IS the broken
case.** Until the script diffs against the actual pre-pull remote (or
persists a last-deployed-SHA marker), manually inspect
`long_lived_modules.ex` + migrations + `mix.lock` after a local merge
and pass `--force-cold` defensively.

## 2026-05-15 — I cluster (image upload) CLOSED

4 buckets on `cluster/images`.

### Key decisions

- **Direct-to-litterbox, no grappa proxying.** Browser POSTs the blob;
  the server never sees the bytes — no bandwidth, no image-storage
  obligation. CSP `connect-src` is the only server surface.
- **Pluggable `ImageHost` interface** (`image-upload.ts`) + litterbox
  first impl. Shape (`upload(blob, opts) → {url, expires_at}` + `name`
  + `default_ttl_seconds`) validated against litterbox / 0x0.st /
  catbox-permanent before locking — vjt: "we DONT KNOW if we stay on
  litterbox thus BUILD INTERFACE".
- **📸-prefix wire shape.** Body is literally `📸
  https://litter.catbox.moe/abc.png` — no IRC tags, no client-only
  namespace, no detection magic. Any IRCv3 listener sees a normal text
  PRIVMSG with a URL; no silent-drop class on the listener side.
- **Per-host localStorage namespacing.** Privacy ack key `image-
  upload-ack:<host-name>`; TTL prefs keyed identically. A new host
  shows the modal once, no ack migration.
- **CSP `connect-src` only, NOT `img-src`.** Cic never renders the
  image inline — the URL is a clickable link via `linkify`; no `<img>`
  ever renders it.
- **Four trigger surfaces** (📸 button, mobile camera
  `capture=environment` at ≤768px, drag-drop, clipboard paste) funnel
  through one orchestrator / privacy modal / auto-send.
- **Auto-send on resolve.** Orchestrator constructs `📸 <url>` and
  calls `compose.send`; operator draft preserved. vjt: "the photo IS
  the message."

### Lessons

1. **CSP empirical pin: response host ≠ request host.** Upload
   endpoint is `litterbox.catbox.moe`; the returned URL lives on
   `litter.catbox.moe` (dropped `box`). BOTH must be in `connect-src`.
   Found via curl — docs don't mention the split.
2. **e2e strict-mode:** `getByRole("dialog")` matched both
   PrivacyModal and SettingsDrawer; fixed with `{ name: /privacy/i }`.
   Future cic dialogs: always give an aria-label or visible `<h2>` so
   e2e can disambiguate by name.
3. **Pre-session uncommitted state can block the deploy chain:** a
   prior `cicchetto-build` oneshot deleted `runtime/cicchetto-
   dist/.gitkeep`; the unstaged `D` stalled `git pull --rebase`.
   Mitigation TBD (preserve `.gitkeep` in the oneshot, or gitignore
   the dir).

---

## 2026-05-16 — T cluster (task harness) CLOSED

Three-cluster arc: T (task harness) → M (admin console) → U (cap
honesty). T first.

Why: live stale-visitor incident — vjt couldn't connect, every cap
slot on azzurra held by debug visitors nobody could cleanly delete.
Adjacent: `scripts/mix.sh` hardcoded `MIX_ENV=dev` (prod-DB tasks
unreachable); no way to attach to the LIVE BEAM (`bin/start.sh` lacked
sname+cookie); `scripts/db.sh` prod readonly; 9 scattered `grappa.*`
mix tasks, no top-level help. Goal: "should be fucking simple to run
an admin task" (vjt).

### Decisions

- **T-A1** `bin/grappa` is host-side, not container-side — no chicken-
  and-egg "how do I get into the container to run bin/grappa".
- **T-A2** Hybrid: boot-time verbs → mix tasks; live-state verbs →
  `--rpc-eval` against the live BEAM. Live-state mutations must
  terminate Session.Server synchronously to free the registry cap
  slot; a fresh BEAM can't see the live tree.
- **T-A3** Keep `scripts/mix.sh` name; drop the `MIX_ENV=dev`
  hardcode; auto-detect from container env with `--env=` override.
  vjt: mix is usable in prod too, so no rename.
- **T-A4** `kebab-case` CLI, `snake_case` mix tasks; per-verb heredoc
  help.
- **T-A5** Bats for `bin/grappa` dispatch + ExUnit for helpers — Bats
  stubs `docker compose` via PATH override, no live container needed.
- **T-A6** Bootstrap honest log → new `Credentials.count_by_state/0`;
  pre-T-4 "no credentials bound" lied when N creds existed all
  `:parked`.
- **T-A7 DESCOPED (phantom bug).** "Login doesn't set expires_at, prod
  has NULL rows" was false: `find_or_provision_anon/3` already sets
  it; prod has 0 NULL rows (verified via `db.sh`); V7 made the column
  nullable specifically for IDENTIFIED visitors. Per "Challenge the
  spec".

### Reviewer-caught bugs (T-3)

1. **`list_credentials_for_all_users/0` silent-filter to
   `:connected`** — parked+failed rows invisible, exactly what a
   triaging operator needs. New `list_all_credentials/0` drops the
   filter.
2. **Registry match spec too loose** — matched any 3-tuple key; would
   crash on a future non-session registration. Fix: pin `:session`
   literal in the head.
3. **`delete_visitor!` success line lied on a concurrent-reaper race**
   — printed "deleted" when `{:error, :not_found}` meant the Reaper
   won. Fix: distinct "already deleted" line.

### Lessons

- **Phantom-bug descope discipline**: when a spec claims a bug, verify
  against current code AND current DB before building — T-A7's
  backfill would have touched ZERO rows.
- **NetworkCircuit ETS leak closed** (B5 action): per-test-file
  `clear_registry_for/1` helpers exhausted their 500ms budget under CI
  load, leaving zombie Session.Servers registered against recycled
  network_ids. Fix: `AdmissionStateHelpers.reset_session_supervisor/0`
  terminates every SessionSupervisor child + raises on converge
  timeout. Loud > silent.
- **Log honesty codified** as a CLAUDE.md rule: fast paths state what
  they observed, not what they did.

---

## 2026-05-16 — M-5 admin networks + reaper + circuit (M cluster bucket)

- `GET /admin/networks` combines DB-row + live circuit ETS projection
  at one endpoint. Composition at the GrappaWeb boundary — the only
  place depping both Networks + Admission; `Networks → Admission`
  would cycle with the existing `Admission → Networks` edge.
- `NetworkCircuit.reset/1` (additive cast) emits
  `[:grappa,:admission,:circuit,:close]` reason `:operator_reset`
  UNCONDITIONALLY — even from no-row or sub-threshold `:closed` —
  because operator intent is "I asked, you did it". `record_success/1`
  keeps its open→closed-only filter so PromEx transition metrics
  aren't skewed.
- `Operator.reap_visitors/0` + `reset_circuit/1` typed siblings (no
  IO) so HTTP renders JSON; `reap_visitors!/0` keeps stdout for
  `bin/grappa`. One feature, one code path, every door.
- PATCH cap whitelist: `max_concurrent_sessions`, `max_per_client`
  only; extra body keys → 400; `nil` clears the cap.

---

## 2026-05-16 — M-6 admin users + credentials (M cluster bucket)

- `GET/PATCH /admin/users` (toggle `is_admin`) + `GET/PATCH
  /admin/credentials` (excluding password rotation). MD2 combined-
  shape continues: DB intent + live BEAM state in one payload
  (`live_session_count`, `live_state`).
- **Wire-shape allowlist CRITICAL:** `Credential.password_encrypted`
  carries the Cloak-DECRYPTED plaintext IRC password after `Repo` load
  (field name describes on-disk, not in-memory, shape).
  `Credentials.AdminWire` projects per-key with
  `:password`/`:password_encrypted` omitted; the controller test
  asserts the response never contains either key.
- Boundary: Accounts stays `[Repo]`-only; Networks gains a typespec-
  only `LiveIntrospection` dep; `GrappaWeb → Repo` stays FORBIDDEN —
  the `:network` preload moved INSIDE
  `Credentials.update_credential/3`.
- `Operator` NOT extended — pure DB writes have no live-BEAM side
  effect; it stays reserved for verbs mutating live state.
- Whitelist stays loud (400 on extra key); auth-method change without
  fresh password → 422; SASL swap with rotation goes through
  `bin/grappa update-network-credential`.

---

## 2026-05-16 — M-7 cic admin drawer entry + admin pane skeleton

- Server `/me` emits `is_admin`; M-7 makes cic's `MeResponse.is_admin`
  REQUIRED (not optional) — a missing arm would be a silent gate
  failure. Forced a uniform 15+ fixture sweep; optional would split
  tests into two patterns.
- One `isAdmin()` predicate (`me.kind === "user" && me.is_admin ===
  true`) gates the drawer entry, the `<AdminPane>` mount, and the
  demote-auto-close effect. Single shape, no parallel state machine.
- Mount is a plain `adminOpen` signal on Shell (symmetric with
  sidebarOpen/membersOpen/settingsOpen) — no hash-routing.
- Demote-mid-session: a `createEffect` on `isAdmin()` closes the pane
  the instant the user resolves non-admin. Correctness depends on
  `networks.ts`'s `createResource` keeping the prior value during
  refetches (a transient `undefined` must NOT close the pane mid-
  interaction) — invariant flagged in a Shell.tsx comment.
- Parity matrix: admin-gated EXEMPT (Playwright covers admin + non-
  admin; visitor covered by vitest).
- Ships NO tabs — outer pane + placeholder only. M-8..M-11 own their
  tab markup so the shape isn't locked before knowing which axis
  serves the operator.
- Deploy: cic bundle via `deploy-cic.sh` (NOT deploy.sh) — the bundle
  is a separate artifact; BundleRefreshBanner prompts connected
  clients on hash mismatch.
- Known gap for M-11: the demote true→false flip isn't exercised in
  vitest (mock `user()` is a plain accessor, not a Solid resource);
  real demote lands in Playwright once M-11 wires
  `grappa:admin:events`.

---

## 2026-05-16 — M-8 cic admin pane: Visitors tab + delete action

- First real tab (Visitors list + per-row inline-confirm DELETE); no
  new server endpoints.
- **Tab nav**: `<div role="tablist">` NOT `<nav>` — biome's
  `noNoninteractiveElementToInteractiveRole` rejects `<nav
  role="tablist">` (nav is a landmark), and the WAI-ARIA APG canonical
  container is a div.
- **Inline-confirm state machine** (MD4 "NO modals"): single
  `confirmingId` signal, sticky (no timeout/cancel/global-click
  reset); switching rows re-arms. Refresh DOES reset `confirmingId`
  (MED-2 fix) to preserve the "armed row exists in `visitors()`"
  invariant M-11's live-events refit depends on.
- **Splice over refetch on delete**: 204 → in-memory filter. Keeps
  scroll, avoids flash; loses concurrent-admin-delete state until
  refresh — accepted; M-11's `grappa:admin:events` ships the live
  refit.
- **U-0 honesty signal**: `live_state === null` (DB intent active,
  BEAM has no pid) renders a red "BEAM has no pid" badge — the orphan
  condition was the entire motivation for M-3/M-4.
- **Visitor mint e2e helper** (`mintVisitor`): POST `/auth/login
  {identifier: nick}` with `GRAPPA_CAPTCHA_PROVIDER: disabled`;
  `adminDeleteVisitor` gives idempotent teardown.
- **CSS**: dropped `var(--mode-deop, #c00)` (HIGH-1 — token defined in
  neither theme, fallback always won). Inline hex until an `--error`
  token earns its keep at a second site.

---

## 2026-05-16 — M-9a admin sessions mutation endpoints (M cluster bucket)

Two server-only operator primitives (M-9b consumes). M-9 split into
M-9a (server: HOT) + M-9b (cic bundle) so reviewer scope stays sharp
and deploy classes don't fight.

- `POST /admin/sessions/:id/disconnect` — T32 park for user sessions
  (QUIT + stop pid + `:parked` + broadcast); for visitors, collapses
  to terminate.
- `DELETE /admin/sessions/:id` — synchronously stops the pid without
  touching the DB row. Distinct from `DELETE /admin/visitors/:id`
  (deletes the row).
- **`:id` shape**: composite
  `"<subject_kind>:<subject_id>:<network_id>"`. Pid in URL rejected
  per the `LiveIntrospection.AdminWire` pid_inspect contract (pid is
  human-display only; cic must NEVER round-trip it). A minted opaque
  id would be parallel state with lifecycle housekeeping — "derive it,
  don't duplicate it". Parse: exactly two `:` → three non-empty
  segments; kind ∈ {user,visitor}; `Ecto.UUID.cast/1`; positive-int
  network_id. Deviation → 400 (distinct from 404 "parse OK, no row").
- **Visitor disconnect collapses to terminate.**
  `Networks.disconnect/2` is user-credential-only; visitors have no
  credential to park. A (PICKED): disconnect ≡ terminate, pid stops,
  row stays, cic shows both buttons regardless of kind. B (rejected):
  422 `:not_supported_for_visitor` forces cic to discriminate UI by
  subject — parallel client state machine. C (rejected): new
  `visitor.is_alive` field — TTL+reaper already handle lifecycle.
- **Idempotency: post-condition over introspection.** Both verbs
  succeed when the post-condition is reached: DELETE on gone pid →
  204; disconnect on already `:parked`/`:failed` → 204 (Operator
  absorbs `:not_connected` rather than 400); disconnect on a user with
  NO credential row → 404 (unknown key). The pre-existing
  `:not_connected` FallbackController clause (used by `/connect`)
  stays untouched.
- **Self-disconnect protection** — admin on their own session →
  `:cannot_disconnect_self` → 422 (not 403: request is well-formed AND
  authz'd; action semantically rejected). Verbs take explicit
  `actor_user_id` (no process-dict, no Plug.Conn reach-in); `nil`
  disables the check — reserved for a future `bin/grappa disconnect-
  session` rpc-eval override. Visitor subjects bypass structurally on
  the pattern match.
- **Logger.info not IO.puts** — context inlined in the message body
  (not metadata, which would need widening the global allowlist).
  Stdout is the wrong door for HTTP-driven mutations.
- Deploy HOT (pure lib/+test/+docs; no long-lived state-shape change).

## 2026-05-16 — M-9b cic Sessions tab + InlineConfirmButton extraction + nginx admin allowlist fix

- `AdminSessionsTab.tsx` — Disconnect/Terminate per row via shared
  `InlineConfirmButton`; singleton mutex key `"<id>:disconnect" |
  "<id>:terminate"` gives per-row AND per-button mutual exclusion in
  one signal. `LiveBadge` three states: alive-with-channel-count;
  "alive unknown" when `"alive"` is in `introspection_degraded` (the
  boolean is unreliable — don't trust it); "pid registered but dead".
- `InlineConfirmButton.tsx` extracted from M-8; "dumb" component,
  parent owns the singleton signal. `AdminLiveState` shared base
  (M-8's `AdminVisitorLiveState` collapses to an alias).

### Nginx admin allowlist — latent M-cluster bug

The nginx allowlist regex (`infra/nginx.conf`, mirrored in
`cicchetto/e2e/nginx-test.conf`) was
`^/(auth|me|networks|push|healthz)(/|$)` — `/admin/*` was NOT
permitted. Latent because M-7 never fetched an admin endpoint and
M-8's Playwright was skipped; M-9b made it unmissable —
`/admin/sessions` returned the SPA shell as `text/html` 200 via the
`try_files` fall-through, and cic's `JSON.parse` threw. Fix: explicit
`^/admin/(visitors|sessions|credentials|networks|reaper|circuit|users|
me)(/|$)` in BOTH prod and e2e confs, both `:80` and `:443` blocks.
Loopback-only verbs (`/admin/reload`, `/admin/cic-bundle-changed`) are
deliberately NOT in the regex — nginx never proxies them;
`Plugs.LoopbackOnly` gates server-side. This DID break M-7+M-8's live
admin surface on prod between M-7 ship and now — unnoticed because
vjt's admin usage was all direct-to-grappa curl, never nginx → cic.

Deploy COLD (nginx change; the hot path doesn't reload nginx,
HIGH-29).

## 2026-05-16 — M-10 cic Networks tab + cap editor + reaper + circuit reset (M cluster bucket)

Third admin tab: per-network cap editor (partial PATCH), Reset Circuit
(clears `NetworkCircuit` ETS), Force Reap (on-demand Reaper sweep).
HOT cic-bundle deploy.

- **MD-1** partial PATCH over PUT-replace — cap edit sends one field;
  empty body 422s. PUT would force round-tripping the full resource
  (the send-the-whole-resource-or-clobber trap).
- **MD-2** Reset Circuit + Force Reap are POST, not DELETE — they
  trigger side-effects, not resource deletion; DELETE would read as
  "remove the circuit object", a false analogy.
- **MD-3** InlineConfirmButton third callsite = stable shape
  confirmed; imported without modification.

## 2026-05-16 — M-11 real-time admin events channel + cic Events tab (M cluster bucket)

Fourth tab; closes the poll-on-refresh gap by streaming admin events
on a dedicated `grappa:admin:events` topic. COLD (new channel
routing). `Grappa.AdminEvents` singleton ring buffer cap=200; 10 typed
event kinds; cic wire-edge exhaustive switch.

- **MD-4** dedicated `grappa:admin:events` topic, NOT a fork of user-
  rooted topics — admin events fan out to N admins, not to the user
  whose session generated them. SoT: `Topic.admin_events()`.
- **MD-5** WS-boundary authz at `join/3`, never per-message. Reviewer-
  caught CRIT-1: pre-fix authz was per-`handle_in`, which would let a
  non-admin socket join and only fail on the (zero) messages it could
  send.
- **MD-6** ring buffer over append-only log — 200 events is a
  diagnostic tail, not an audit trail; persistent storage rejected
  (state-changing endpoints already SoT their effects in the DB).
  Audit-trail is a separate cluster.
- **MD-7** singleton on the `max_cases: 1` lane with the `## Test
  isolation` moduledoc.
- MED-1 (reviewer): `record/1` didn't bump the telemetry counter on
  full-buffer drop; fixed.

## 2026-05-16 — M cluster CLOSED — operator-visible admin pane

Twelve buckets (~4 days). Pre-M-1 every admin op required ssh + Elixir
incantations; post-M-Z the operator flips between the 4-tab cic admin
pane and `bin/grappa` with zero context loss.

Two calls became CLAUDE.md rules: DB state + live state are separate
SoT — `AdminSessionsTab` surfaces BOTH per row + explicit `null` (the
U-0 honesty signal); and `/admin/<resource>` requires the nginx
allowlist in BOTH `infra/nginx.conf` and `cicchetto/e2e/nginx-
test.conf`, both `:80` and `:443` blocks (origin: the M-9b latent
bug). Other collected calls: user-rooted topics + sibling
`grappa:admin:events` (MD-4); WS-boundary authz at `join/3` (CRIT-1);
`AdminEvents` ring buffer (audit log rejected, DB is SoT);
`InlineConfirmButton` lifted once three callsites confirmed the
boundary (reuse verbs not nouns); composite-id URL for
`/admin/sessions/:id` (no natural single PK); visitor disconnect
collapses to terminate.

Lessons:
- **Per-bucket reviewer loops are not optional for cross-surface
  clusters** — they caught CRIT-1 (M-11 WS authz), MED drift inside
  InlineConfirm, and the M-9b nginx-allowlist gap.
- **Pre-existing CI red since M-9a is its own follow-up, not a
  regression** — the `m10-cap-editor` Playwright "Cannot type into
  input[type=number]" + timeout cascade pre-dates M-9a; ship not
  blocked on it.
- **`bin/grappa create-user` does not take `--admin`** — the plan text
  was aspirational; M-12 documented the two-step (`create-user`, then
  remote-shell `update_user/2`).

## 2026-05-17 — U cluster (cap honesty) summary

Seven buckets (U-0..U-6) + one retro fix, closing the T+M+U arc: an
operator who clicks "connect" on a cap-saturated network now gets an
honest 503 + typed cic banner instead of a silent 200-OK with the row
at `:connected`, no Session.Server, and the next REST write 404-ing.

### Buckets

- **U-0** — `NetworksController.spawn_session_after_connect/3` flipped
  to spawn-first / commit-second. Pre-U-0 it committed `:connected`
  BEFORE spawning and swallowed every spawn error while returning ok.
  Now the controller bails on spawn failure, leaves the DB at the
  prior state, and FallbackController surfaces the typed error.
- **U-1** — schema split: `max_concurrent_sessions` →
  `max_concurrent_visitor_sessions` + `max_concurrent_user_sessions`,
  each NULL = unlimited (+ cleared NOT-NULL drift from an earlier mis-
  applied migration).
- **U-2** — subject-aware admission + three typed login-phase timeouts
  + honest Bootstrap log. A saturated visitor pool never blocks
  operator login.
- **U-3** — `:client_cap_exceeded` 429 → 503 + `too_many_sessions`
  body atom; cic `assertNever` exhaustiveness on the typed-error sum.
- **U-4** — device-identity-change test-debt closure (e2e as
  `test.skip` per the visitor-mint cold-start blocker).
- **U-5** — admin Networks tab per-network live cap counters via
  `:cap_counts_changed` telemetry.
- **U-6** — docs sweep incl. the CLAUDE.md "No silent-swallow at
  boundaries" rule.

### Decisions

- **UD1** subject-aware admission via `Subject.t()`: two caps, two
  `Registry.select` count queries filtered by subject shape, two error
  atoms.
- **UD2** audited ALL spawn call sites for swallowed errors:
  NetworksController (fixed U-0); Bootstrap (acceptable boot-time
  skip-and-log); Visitors.Login (already honest); SpawnOrchestrator
  verified.
- **UD3** cap-exceeded → **503 + `{error, retry_after?}`**, NOT 429.
  Resource exhaustion, not rate limit: 503 → "ask admin to bump the
  cap or wait"; 429's "slow down" is the wrong operator action.
- **UD5** device reconnect with different identity: (A) logout
  terminates live sessions for `(subject, client_id)`; (B)
  `Admission.check_client_cap/1` filters by `{client_id,
  current_subject}` so a different subject on the same client doesn't
  count against the old slot; (C) visitor `/quit` routes through the
  logout helper and frees the slot.
- **UD7** login probe timeout split. Pre-U-2 a single 3s budget
  covered TCP+TLS+NICK/USER+RPL_WELCOME; Bahamut's rDNS-blocking 001
  emit (the intermittent raccooncity 504s that motivated UD7) blew it.
  Post-U-2: `connect_timeout_ms` / `rpl_welcome_timeout_ms` /
  `probe_timeout_ms`, each mapped to its own 503 + Retry-After.
- **UD8** migration deploy class is COLD.
- **UD10** codify the CLAUDE.md "No silent-swallow at boundaries"
  rule, generalized to cover BOTH controller error-discard (U-0) AND
  wide `terminate/2` catches.

### Swallow-bug retrospective + meta-lesson

Two swallow-bugs in the same arc; both resolved by boundary fixes, not
safety-net widening.

**Bug 1 — controller error-discard (pre-U-0).**
`networks_controller.ex` committed the `:connected` transition first,
then discarded the spawn orchestrator's `{:error, _}` and returned ok.
Operator-visible: "PATCH /connect 200, row `:connected`, no
Session.Server, POST /messages 404s". Fix is the pattern (spawn-
first/commit-second + `with` + FallbackController), not the instance.

**Bug 2 — wide `terminate/2` catch hiding a raise from a boundary.**
`IRC.Client.handle_call({:send,_},_,_)` used `:ok =
transport_send(...)` — MatchError on the closed-but-not-nil socket,
FunctionClauseError from `:gen_tcp.send(nil,_)` on the nil socket.
Both cascaded into `Session.Server.terminate/2`, whose narrow exit-
catch missed the wrapped MatchError; the supervisor blocked 5s per
dying child; CI's `reset_session_supervisor/0` 15s budget exhausted.
The bug hid for WEEKS under a "shouldn't happen" clause. Fix at the
IRC.Client boundary: return `{:error, :no_socket | :closed | _}`
honestly; callers that don't care (best-effort QUIT in `terminate/2`)
`_ =`-discard.

**Meta-lesson.** Both bugs were called out in code comments long
before they bit. A safety net that catches an impossible exception
silently absorbs the next class of bug. **When a comment says "follow-
up cue against X", file it as a cluster candidate immediately** —
TODO-comments are real signal.

### U-Z cluster close

- Composed REST-only journey spec replaying the cluster: park vjt →
  saturate user cap (=0) → /connect 503 `network_busy` → assert row
  stays `:parked` (the U-0 spawn-first invariant) → bump cap →
  /connect 200 → visitor cap=0 / user cap=10 → /connect still SUCCEEDS
  (UD1 independence).
- Audit per plan §U-Z item 7: grep for `{:error, _} -> :ok` in
  `lib/grappa_web/controllers/` → ZERO matches. Empty audit IS the
  finding — the swallow class is clean; grep documented so future
  readers don't re-run it.
- **Documented but not driven** (e2e is not the right tool for every
  invariant where unit + sibling specs already pin the surface):
  parallel spawn under independent caps (`u-2-admission-
  split.spec.ts`); logout-visitor → login-user same client_id +
  visitor-/quit-frees-slot (unit-tested, e2e `test.skip` per the
  bahamut-test visitor-mint cold-start 504, same blocker as M-8);
  capacity_reject in the Events tab (driven by `m-z-admin-cluster-
  journey.spec.ts`); iptables DROP → `:connect_timeout` phase
  (infeasible in-harness — needs NET_ADMIN + testnet routing; UD7
  phases unit-tested at `login_test.exs`).

**U cluster CLOSED 2026-05-17** (8/8 + U-Z). Two swallow-bugs fixed at
the boundary, not the safety net; the CLAUDE.md "No silent-swallow at
boundaries" rule codifies the pattern. The T+M+U arc is closed.

Next per `project_post_p4_1_arc`: nick-case-sensitivity bug fix → iOS
UI polish cluster → full post-T+M+U+iOS codebase review → bastille
deploy workstream (#8).

## 2026-05-17 — iOS UI polish cluster CLOSED

Four KISS buckets making cic on iPhone Safari feel native. cic-only —
localStorage + CSS + Solid signals, no server changes.

- **iOS-1** `7226cd9` — viewport lock. `maximum-scale=1,
  user-scalable=no` + `html, body { overflow: hidden; height: 100%;
  overscroll-behavior: none }`. Kills pinch-zoom + rubber-band.
- **iOS-2** `3d59036` — safe-area insets. `env(safe-area-inset-*)`
  padding on `.topic-bar`, `.bottom-bar`, `.shell-members`,
  `.settings-drawer`. Desktop unaffected (env() resolves to 0 outside
  notched contexts).
- **iOS-3** `a439bb0` — bottom-bar tab close ×. Shared helper
  `lib/windowClose.ts` so Sidebar + BottomBar call the same PART logic
  (one-feature-one-code-path).
- **iOS-4** `241caa1` — font-size selector (S/M/L/XL/XXL =
  12/14/16/18/20 px). Closed-set `FontSizeKey` union + typeguard
  validated at the localStorage boundary (invalid stored value falls
  back to "M"); boot-apply BEFORE render mirrors `lib/theme.ts` (no
  FOUC).
- **iOS-Z** — `cicchetto/e2e/tests/ios-z-cluster-journey.spec.ts`
  replays all four buckets on `@webkit` iPhone 15. Honest limitation:
  Playwright webkit emulation doesn't simulate the OS-level notch, so
  `env(safe-area-inset-top)` resolves to 0 there; real notch-clearance
  evidence is browser-smoke screenshots from a notched iPhone shape.

Lesson: desktop browser-smoke can't validate iPhone-shape changes —
overscroll feel, notch clearance, pinch-zoom only surface on the
`@webkit` iPhone project + real iPhone smoke.

## 2026-05-17 — UX cluster CLOSED

Three small bugs vjt observed live within 24h of the iOS cluster
shipping. Mini-cluster, KISS to the bone.

- **UX-1** `f59264d` — archive close × + permanent scrollback delete.
  `InlineConfirmButton` two-step confirm; new route `DELETE
  /networks/:network_slug/archive/:target` dispatched by sigil
  (`#name` → channel scrollback drop; `name` → DM drop). Broadcasts
  typed `:archive_changed` on the per-network user-topic so other
  connected clients re-fetch. Smoking-gun e2e assertion: re-JOIN
  post-delete shows empty scrollback (rows ARE gone server-side, not
  just hidden in cic cache).
- **UX-2** `47e38e2` — BottomBar archive chip + full-overlay
  `ArchiveModal` (mobile had no archive access without slash-command
  re-join). Lifted `visibleArchiveForNetwork` into `lib/archive.ts`
  (shared with Sidebar). Modal signal lives INSIDE
  `identityScopedStore` so token rotation closes an open modal
  alongside the `archivedBySlug` flush (reviewer-flagged HIGH
  identity-rotation leak, fixed in-amend).
- **UX-3** `a805fcb` + `ea446e4` — `.shell-empty-toolbar` Dynamic
  Island clearance (iOS-2 missed the cold-load toolbar). Follow-up
  fixed the spec: vite's CSS minifier merges rules with identical
  property values into comma-list selectors, so `selectorText ===
  "..."` exact-equality skipped the merged rule in production. Use
  split-on-comma containment checks.
- **UX-Z** — `ux-z-cluster-journey.spec.ts` replays all three on
  `@webkit` iPhone 15; user-class parity matrix asserted via a CLASSES
  loop (visitor + nickserv documented as annotation skips with unit
  pointers; loop structure preserved for future unblocking).

Lessons:
- Post-cluster operator dogfooding IS the cluster's final review pass
  — budget a mini follow-up cluster after every UX-touching cluster.
- Vite's minifier merges CSS rules across selectors: assert
  containment, not selectorText equality. Live smoke against the
  deployed bundle caught this; dev mode didn't.
- Any signal that REFERENCES identity-scoped data must itself live
  inside the scoped store.

---

## 2026-05-18 — Channel names are case-folded (UX-4)

IRC channel names are case-insensitive, but the scrollback/window
tables were keying them case-sensitively, so `#Chan` / `#chan` /
`#CHAN` forked into separate windows. Fix: channel names are
**lowercased on read AND write** across every channel-keyed table
(`messages`, `query_windows`, `read_cursors`, `last_joined_channels`,
archive, later `channel_directory`), with a one-time backfill
migration (`20260518120000_backfill_lowercase_channels`).

*Invariant (also in CLAUDE.md): any new channel-keyed table or query
MUST downcase the channel key, or it silently forks windows. Nicks are
likewise compared case-insensitively (`nickEquals` on the cic side).*

---

## 2026-05-18 — UX cluster reopened: keyboard saga + chrome-gesture saga + scroll-on-empty

Within 24h of the UX cluster closing, iPhone dogfooding hit a new bug
class: the iOS keyboard, the Safari rubber-band / chrome-gesture
overlay, and touch-pan routing on empty scrollback. Sixteen more
commits shipped in the same session under the `ux-3-*` prefix
(deliberate: don't open a fresh cluster mid-bug-hunt; UX-4 opens once
docs catch up).

### The keyboard-resilience saga

iOS Safari composes the visual viewport differently from the layout
viewport; the `interactive-widget` meta affects keyboard-show layout;
`100dvh` resolves differently with the keyboard open. Shipped stack —
each ingredient necessary: viewport meta
`interactive-widget=resizes-content` + VisualViewport API →
`--viewport-height` CSS var + `window.scrollTo(0,0)` pin + BottomBar
`preventDefault` on pointerdown + flat-flex BottomBar layout. Four
`position: fixed` / `100dvh` attempts all REVERTED (hid the top bar,
broke BottomBar/topic-bar interaction). The Playwright e2e at
`d7f988f` locks the stack against regression.

### The chrome-gesture rubber-band saga (UNDEC, three rounds)

Dragging anywhere on the shell showed the Safari chrome bar +
dismissed the keyboard. `#root { height: 100% }` (kill real root
overflow) and `overscroll-behavior: contain` on scroll containers
weren't enough — contain doesn't catch drag-from-non-scrolling-area.
Final fix (`ff65ad9`): `touch-action: none` blanket on `.shell-mobile`
+ targeted `pan-y`/`pan-x` re-enable per scroll container.

### Z-arch — archive open re-arms per-channel topic subscribe

Opening an archive entry selected the channel but did NOT subscribe to
its Phoenix topic — arriving events silently unreceived. Fix
`e0cdf4b`: archive-row click (Sidebar + ArchiveModal) calls
`openQueryWindowState(...)` BEFORE `setSelectedChannel(...)`.
**Lesson**: "selecting a channel" ≠ "subscribing to a channel" — two
independent cic operations. Side-door entry points (archive revival,
future deep-links) must do BOTH; the window-open IS the subscribe.
Main-flow JOIN paths get it right only because JOIN explicitly opens.

### Z3-R4 — JS-measured overflow gates scrollback touch-action

Permanent `pan-y` on `.scrollback` means iOS treats a non-overflowing
element as "no scroll work here, propagate to viewport" — dragging on
empty/short scrollback still scrolled the chrome. CSS-only attempts
(emptiness-test class; `overflow-y: scroll` to force always-scrollable
semantics) SUPERSEDED — iOS keys on actual content height vs
container. Canonical fix `8a49ea3`: JS DOM measurement (`scrollHeight
> clientHeight`) on messages-change ∪ window-resize ∪
visualViewport-resize toggles a `.scrollback-overflowing` class which
toggles `pan-y`. There is no CSS `:has-overflow` pseudo-class — reach
for this pattern whenever a touch-routing decision depends on actual
layout state.

### Z + Z2 — server-side delete-vs-list asymmetry + close broadcast

`db8650f` (Z) — `Scrollback.delete_for_dm/3` used strict `channel = ?
AND dm_with = ?` while `list_archive` used `COALESCE(dm_with, channel)
= ?` — DM rows the LIST returned could not be DELETEd. Generalize:
**any read/write pair on the same column MUST share the same key
predicate.** When one side coalesces, normalizes, or lowercases, the
other must too. Audit every context module pair.

`ca0acac` (Z2) — `ChannelsController.delete` + `close_query_window`
now broadcast `archive_changed`; before, closing a window didn't
update the archive chip/modal until page reload. Reactive UI drift
from the source of truth = silent UX bug.

### Keyboard-preserve helper evolution (keepKeyboard)

Tapping certain buttons (scroll-to-bottom arrow, archive rows) MUST
NOT dismiss the iOS keyboard. Evolution: per-button wiring →
document-level capture listener (`8313681`) → switch `pointerdown` to
`mousedown` (`c433872`). Non-obvious: on iOS, `pointerdown` is a
gesture-start event that blocks scroll-gesture dispatch; `mousedown`
is a synthesized focus-shift-only event that doesn't. Use mousedown
for "preserve scroll under tap"; pointerdown for "block all default
touch behavior".

### Saga-wide lessons

- **Real-iPhone smoke is non-negotiable for iOS Safari work.**
  Playwright webkit emulation simulates neither the OS keyboard, the
  visual viewport, the chrome rubber-band, nor `touch-action`/`pan-*`
  interpretation. All sixteen bugs were caught on-device, none by
  webkit Playwright. Specs lock fixes once shipped; they cannot
  discover iOS-specific quirks.
- **Documented technical-debt carry:**
  `ArchiveModal.handleConfirmDelete` has a bare `catch {}` — CLAUDE.md
  no-silent-swallow violation, flagged here, left unfixed. First slot
  that touches ArchiveModal closes it.

**Apply**: when a closed cluster reopens within hours-to-days, stay on
the original cluster prefix; open the next cluster fresh only once
docs catch up and a new bug-class emerges. The cluster ID is about
narrative coherence, not commit count.

## 2026-05-21 — UX-6-L: foreground push → in-app beep (SW-suppress Option B)

B2's push dedup (2026-05-14) suppressed the OS notification when cic
was foreground AND on the exact deep-link URL, posting a
`push.suppressed` message the page never listened for — foreground
mentions/DMs were eerily silent (badge bumped, no cue). vjt decision:
broaden the SW gate to suppress whenever **any** window is visible,
and surface the foreground alert as an **in-app beep** wired off the
WS event stream, NOT the push path.

Why decouple beep from push: the WS path is always-live when
foreground and independent of APNs/FCM latency, vendor dedup, and
quota delays; and the same `routeMessage` body that bumps the unread
badge fires the beep — one gate, one source, no second policy layer to
drift from the badge gate (parallel state machines diverge).

- SW gate: pure predicate `shouldSuppressPush(clients)` =
  `clients.some(c => c.visibilityState === 'visible')`, extracted into
  `lib/pushDedup.ts` so vitest can exercise it without the SW global
  scope (same boundary precedent as `lib/pushPayload.ts`). Dropped the
  dead `push.suppressed` postMessage.
- Beep: `lib/beep.ts` `playBeep()` (Web Audio sine 440Hz/80ms,
  lazy-init, non-fatal on audio-context failure), wired at the
  channel-mention path + both DM-listener arms, gated on `sender !==
  ownNick` and `!effectivelyFocused(slug, peer)`.
  `effectivelyFocused/2` is the single focus predicate shared by badge
  gate and beep dispatch — if the rule evolves it changes in one
  place.

APNs/FCM quota caveat — accepted: server still sends every push (~50%
wasted when foreground; the SW just suppresses display). Acceptable at
current scale. Follow-up if quota bites: hybrid — server consults
WSPresence + visibility heartbeat to skip, SW keeps the visibility
re-check as backstop. Deliberately NOT parked as a TODO; re-evaluate
when push volume justifies the engineering.

e2e seam — `window.__cic_dmListenerReady` (Set\<string\>), stamped
after the DM-listener `phx.join()` ack. Fixes a ~20% flake where the
peer's PRIVMSG arrived server-side BEFORE the own-nick topic
subscription completed — broadcast to a topic nobody was on, silently
dropped. Playwright `waitForFunction`s on it; production never reads
it. Same shape as `socket.ts:__cic_dropSocketForTests`.

**Apply**: foreground alerts in PWAs should NOT ride the OS-push path
— WS-driven beeps decouple from push-vendor latency. When a
postMessage has no listener, delete it — dead letters mask the design
gap. E2E against async WS subscriptions needs an explicit readiness
seam; DOM signals are unreliable proxies for "the join roundtrip
completed".

## 2026-05-21 — UX-6-D CLOSED: iOS PWA keyboard saga (11 attempts, 4 research agents)

vjt's iPhone 15 PWA standalone, on compose-textarea focus: topbar
scrolls out of view, BottomBar floats off the keyboard, scrollback
mis-scrolls, drag-to-bottom locks for 1-3s. The first 8 attempts were
CSS+JS band-aids reasoning from inside the web platform; every fix
worked in the desktop CDP probe, none survived the iPhone. After D8
vjt pivoted: "can we do research and rethink the entire thing?" Four
parallel research agents (real-world chat PWAs / WebKit internals /
interactive-widget status / Capacitor escape) returned convergent
ground truth:

1. **`visualViewport.offsetTop` is unreliable** — WebKit bug #297779
   ("a bug in a system component" per Apple engineer); gets stuck at
   24px after keyboard dismiss.
2. **`window.scrollTo(0,0)`-on-every-scroll pin DOES cause the 1-3s
   lock** (WebKit #226689: scrollTo during momentum re-triggers
   scroll, iOS quarantines as fight-detection). BUT the pin is also
   load-bearing for clamping the visual-viewport shift on focused
   input — both halves true.
3. **`interactive-widget=resizes-content` is NOT implemented in
   WebKit** (bug #259770, unassigned, not on Interop 2026).
4. **`100dvh` ignores the on-screen keyboard by CSS spec.** Chrome
   violates spec for usability; iOS honors it.
5. **`focus({preventScroll: true})` is baseline since iOS Safari
   15.5** — we'd never used it.
6. **WebKit's `_zoomToFocusRect` (focused-input auto-scroll) runs at
   the UIKit layer BELOW the web platform** — the page is never
   asked; it cannot be opted out of for tap-focus.
7. **Telegram Web K is the ONLY production chat PWA that works on iOS
   PWA standalone.** Their pattern (`src/scss/base.scss`):
   ```css
   html.is-ios { position: fixed; }
   body { height: calc(var(--vh) * 100); }
   ```
   where `--vh = visualViewport.height * 0.01`, updated on every
   `vv.resize` by JS. One ATOMIC change — neither piece works alone.
   The rest of the chat ecosystem (Element, IRCCloud, WhatsApp, Slack,
   Signal, Discord…) punts to native iOS apps.
8. **The escape hatch is Capacitor** (or any native wrapper): same
   WebKit engine, but UIKit `keyboardWillShow` gives exact pixel
   height + animation curve, and the native shell resizes the
   WKWebView frame directly.

The arc: D1-D8 piecemeal (position:fixed variants, translateY
pre-lift, `--vv-offset-top` cancel) failed or reverted — each
iteration broke a different ancestor in the cascade. D7 dropped the
scroll pin on the half-right "pin causes the lock" hypothesis; D9
adopted the Telegram pattern atomically but without the pin, and the
viewport shift returned. D10 restored the pin as a smart-pin gated on
touch-state (iOS programmatic shift, no touch → snap; user
drag-momentum → no-op; 50ms post-touchend grace after diag proved iOS
fires the shift at +110ms). D11 restored D1's
`:has(:focus){padding-bottom:0}` BottomBar-gap fix + pre-emptive
focusin snap. A per-frame rAF diag probe (focusin → 600ms of 60Hz
snapshots) proved the remaining visible topbar slide is iOS compositor
animation BELOW JS visibility (vvOT=0 + wy=0 throughout the 250ms
slide) — accepted as an iOS PWA limitation.

Final landed surfaces:
- `lib/viewportHeight.ts` — `installViewportHeightTracker` writes
  `--vh` + `--viewport-height` from `vv.height`;
  `installSmartScrollPin` (touch-gated snap, 50ms grace).
- `lib/platform.ts` — `isIos()` UA detection + `applyIosClass()` at
  boot pre-render.
- `themes/default.css` — `html.is-ios { position: fixed; inset: 0 }` +
  `html.is-ios body { height: calc(var(--vh, 1vh) * 100) }` PAIRED
  atomically; `.shell-mobile:has(textarea:focus, input:focus)
  { padding-bottom: 0 }`; `.scrollback { min-height: 0 }` (iOS WebKit
  flex-min-content fix).
- `ScrollbackPane.tsx` — vv/window resize → `scrollToActivation()`
  (canonical UX-4-K marker-or-tail routine).
- `Shell.tsx` — keybinding-driven compose focus uses
  `focus({preventScroll: true})`.
- `DiagFloat.tsx` (flag-gated via `localStorage.cic_diag`, Portal to
  body so it escapes shell transforms) + `AdminDebugTab.tsx` (Admin →
  Debug tab) + `e2e/tests/ux-6-d-keyboard-pattern.spec.ts` asserting
  the JS+CSS contracts.

Accepted residuals: the visible topbar slide during keyboard open
(compositor-level, unfixable in pure PWA — Capacitor escape if
priority rises); channel scroll-position interference deferred
(UX-6-M).

**Apply**:
1. **When research contradicts an existing assumption, RE-READ the
   assumption.** D7's half-right "pin causes the lock" got the wrong
   half acted on; the arc cost 4 iterations.
2. **Telegram-style atomic CSS patterns ship ALL pieces in the SAME
   commit.** Partial adoption = catastrophe.
3. **Per-frame rAF diag is the right primitive when the bug may be an
   animation** — distinguishes layout-viewport motion visible to JS
   from compositor motion below it. It ended the saga.
4. **Diag UI must render OUTSIDE any surface that competes with the
   focus-state under investigation** (it moved out of SettingsDrawer,
   which closed when the keyboard was up).
5. **Honor research evidence over speculation.** The 4-agent pivot
   after attempt 8 returned 30+ citations and capped further
   iterations at four.
6. **Accept what cannot be fixed.** Documenting the acceptance + the
   escape route is more honest than a 12th band-aid.

## 2026-05-22 — UX-6-E: narrow-mode BottomBar Server-tab dedup

On wide screens the network header IS the server-window entry; narrow
BottomBar rendered TWO entries per network (a passive chip span + a
standalone tab labelled literally "Server"). One-feature-one-code-path:
narrow now mirrors wide — single `.bottom-bar-network-header` button
per network, same badge cells, same `(slug, $server)` selection
discriminator, disconnect × affordance mirrored from wide.

`data-network-slug="<slug>"` on the header is the stable e2e contract
(`hasText` filtering on the chip's bare text was substring-fragile).
The fixture's `sidebarWindow(slug, "Server")` special-case routes
legacy callers to the header without renaming every call-site —
ergonomics over purity, comment explains. Migrating callers to the
`SERVER_WINDOW_NAME = "$server"` constant is a flagged future pass.

Selection feedback no-op-is-the-design: `.selected` flips background
AND color-to-accent, but the header's baseline is already accent, so
only background shifts — intentional parity with desktop's sidebar
shape. CSS comment warns "don't fix the color no-op."

Pre-existing failures discovered during smoke (reproduced on `e53000c`
baseline before any UX-6-E edits; NOT regressions; logged in todo.md):
`ux-4-z-cluster-journey:141` (members-pane intercepts backdrop tap on
webkit-iphone-15 — drawer doesn't close) and `ux-z-cluster-journey:86`
(archive modal `#bofh` row never renders).

Lesson: per-bucket discoveries belong in todo.md, not silently in
commit messages — the next bucket picks them up without re-discovery.

## 2026-05-22 — UX-6-I: cic refresh banner single-press fix

The cic bundle refresh banner needed THREE presses to pick up a new
bundle; the click handler was a naive `window.location.reload()`.

Root cause: the SW's `NavigationRoute` serves a *precached*
`index.html` for `request.mode === "navigate"` — including the very
reload the refresh button triggers. The precached shell still pointed
at the OLD bundle hash, so the SW answered the navigate from cache
even though nginx had the new `index.html`. The new SW
installs/activates/claims only after a full navigate cycle: press 1 =
old, press 2 = indeterminate, press 3 = fresh.

Fix — `performRefresh()` now, in order:
1. `await navigator.serviceWorker.getRegistration()`
2. `await reg.update()`
3. Post `SKIP_WAITING` to `reg.waiting ?? reg.installing` (waiting
   alone is a no-op while install is still in flight)
4. Await `controllerchange` with 2s ceiling (purging caches BEFORE
   the new SW activates relied on workbox network-fallback "by
   accident")
5. Purge ALL caches (`caches.keys()` + delete)
6. `window.location.reload()`

Failure modes `console.warn`-logged (no silent swallow in a recovery
chain — devtools evidence if 3-press behavior reappears); the chain
proceeds best-effort.

Test seam: `window.__cic_bundleHash.__refreshProbe` — when set (only
by Playwright), `performRefresh` calls it instead of
`location.reload()`, because `location.reload` is non-configurable on
chromium so prototype patches are silently ignored. Production never
sets it.

Parked follow-up (reviewer M2 → UX-6-I.2): the e2e stubs the SW +
caches — proves the chain WIRING, not real SW + precache behavior.

Lessons: service workers are an invisible navigation layer — any
future hard-reset feature must follow the same SW + caches discipline.
Awaiting `controllerchange` is the right primitive for SW handoff
(`serviceWorker.ready` resolves only on the FIRST activation). Surface
failures even from best-effort chains.

---

## 2026-05-22 — UX-6-J: push notif tap opens source window (B5 carry-debt close)

vjt iPhone-dogfood Bug 10: tapping an OS push opened cic to the
LAST-viewed window, not the channel/DM the push referenced.

Root cause: B4 built the deep-link URL into push payloads
(`/?network=<slug>&channel=<...>` via `Grappa.Push.Payload`'s private
`build_url/2`); B5 half-shipped the cic side — the SW ran
`existing.navigate(url)` on the focused client, but cic is a
route-less SPA: selection lives in the `selectedChannel` signal, not
the router, so navigate reloaded at `/` and dropped the params. The
`payload.ex` moduledoc honestly admitted the gap ("cic itself does NOT
parse `?network`/`?channel` on cold-load yet… until then clicking the
OS notification just opens `/`"). J finishes the other half.

Alternatives: **A — SW postMessage to focused client** (cic listens on
`navigator.serviceWorker`, routes through `setSelectedChannel`; SPA
architecture preserved, one extra global subscription) vs **B — URL as
source of truth for deep links** (cleaner long-term, bigger refactor,
couples selection to the history API). A picked as minimum-surface; B
remains a future cleanup if richer URL-driven navigation is needed.

Implementation:
- `service-worker.ts notificationclick`: after `existing.focus()`,
  `existing.postMessage({type: "navigate", url})`. The `urlMatches`
  dedup check became dead code and was deleted with its tests.
- `parsePushTargetUrl` (in `pushPayload.ts`) extracts `{networkSlug,
  channelName, kind}`; `kind` by RFC 2812 chanstring sigils `#&!+` →
  `"channel"`, otherwise `"query"`. Mirrors the server's
  `build_url/2` + `Identifier.canonical_channel/1`.
- `applyPushTarget(rawUrl)` (new `lib/pushTarget.ts`) routes through
  `setSelectedChannel` — same code path as a sidebar click, so all
  reactivity + subscribe effects fire automatically. Parse failures
  `console.warn` (no silent drop).
- Warm path: `installPushTargetListener()` on the SW→client `message`
  channel. Cold path (`openWindow` on a not-yet-running client):
  `applyPushTargetFromUrl()` reads `location.href` at boot, defers via
  `createEffect(on(networks, ...))` so it doesn't fire against an
  empty store, wrapped in `createRoot` because `main.tsx` calls it
  BEFORE `render()` — Solid warns + never disposes a `createEffect`
  outside a reactive owner. Cleans the URL via
  `history.replaceState({}, "", "/")` after apply so refresh doesn't
  re-trigger.
- Test seam `window.__cicPushTargetApplied` proves the cold-path
  reader fired — without it the e2e could pass for the wrong reason
  (session restore coincidentally landing the same channel).

Reviewer non-findings worth keeping: SW postMessage is same-origin per
spec (no spoofing surface); `navigator.serviceWorker` is an
EventTarget, so e2e `dispatchEvent(new MessageEvent('message', …))`
exercises the real handler.

Deploy: HOT cic-only bundle deploy.

Lessons:
1. **Half-shipped clusters bite later.** A "coming in a later
   sub-task" moduledoc TODO is a cluster candidate — file it
   immediately or it rots until someone taps the notification.
2. **SPA navigation state ≠ URL state.** Deep-link features either
   feed the selection signal directly or commit to URL-as-truth; B5
   tried URL-as-truth without committing and got a silent no-op.
3. **`createEffect` outside `createRoot` is a silent footgun.** The
   explicit window-flag probe pattern is reusable for any boot-time
   effect that conditionally fires.

---

## 2026-05-22 — UX-6-I.2: real-bundle-swap e2e (UX-6-I follow-up close)

Closes UX-6-I's parked M2. The UX-6-I e2e stubs
`getRegistration`/`caches` and uses the `__refreshProbe` seam — it
proves the `performRefresh()` chain WIRING, not that the real SW +
real precache race (where the 3-press bug lived) is gone. A green
stubbed spec is necessary but not sufficient.

`bundle-refresh-real-swap.spec.ts` drives the real
`BundleRefreshBanner` button against a real nginx-served swapped
`index.html` and asserts the reloaded page's script-src carries the
new hash on the FIRST click. Discriminator hand-verified: downgrading
`performRefresh` to a bare `reload()` makes the spec FAIL (SW precache
serves the old shell).

Fixture (`cicchetto/e2e/fixtures/bundleSwap.ts`) — "pre-prepared
bundle-swap" chosen over docker-compose-oneshot fidelity (KISS + e2e
determinism, no CI retries):
- `snapshotBundle()` — copies dist aside for teardown restore.
  **Self-healing**: detects synthetic-bundle leftover from a crashed
  prior run (sentinel `Ux6i2Synth` in index.html) + prior snapshot dir
  → restores BEFORE taking this run's snapshot, otherwise the broken
  state becomes "baseline" and restore leaves dist permanently broken.
- `swapToBundleB()` — rewrites the script-src to a synthetic hash +
  drops a stub ES module at that path. Atomic via same-filesystem
  `fs.rename`; tmpPath includes pid + timestamp as defense-in-depth vs
  parallel workers.
- `restore()` — per-entry try/catch + `console.warn` so one unwritable
  leftover doesn't swallow the spec's primary assertion failure.

Why a stub JS, not a real Vite rebuild: a mid-spec `cicchetto-build`
adds ~30s + bun/node_modules deps in the runner image. The behavior
under test is "post-purge reload converges to whatever index.html
nginx now serves" — asserted on the script-src attribute, not on the
JS executing, so fsync ordering between the JS write and the HTML
rename is not a correctness boundary.

Caveats accepted:
- Spec runs chromium-on-Linux; the source bug is iOS-specific (Safari
  throttles SW activation harder). Green proves the convergence logic
  + cache-purge ordering under nominal SW timing; iPhone timing is
  hand-validated each release. Spec moduledoc carries this banner.
- `BUNDLE_HASH_RE` is inlined in BOTH `src/lib/bundleHash.ts` and
  `e2e/fixtures/bundleSwap.ts` with reciprocal "keep in lockstep"
  comments — shared-module extraction failed (Playwright's native ESM
  loader doesn't resolve imports outside the e2e tsconfig project
  root); the paired-comment regex is cheaper than a build-system
  bridge.

Deploy: none (e2e-only). Carry-forwards: UX-6-M (channel
scroll-position interference, parked on vjt repro — likely non-keyed
`<Show>` reuse of ScrollbackPane across `selectedChannel` changes);
baseline e2e fails ux-4-z:141 + ux-z:86 still parked.

---

UX-6 ships in 11 production buckets (A–L minus H which merged into
D2; plus Z this docs sweep) across `57cd88b`→`7625e13` under autopilot
mandate. UX-5 had closed two days earlier (15 buckets,
`205262d`→`38dc283`) but its README entry was never written — the
per-bucket-update miss the safety-net Z sweep exists for.

### UX-6 bucket inventory

| Bucket | Commit | One-line |
|--------|--------|----------|
| A v1-v6 | `eeb551d` | mobile overlay scroll-leak + iOS PWA rubber-band — final shape is a custom 30-LOC touchmove handler walking the ancestor chain |
| B1 + B2 | `61269eb` + `1b2687f` | embedded image uploader (server stack + cic adapter + admin Settings tab) |
| C | `31932b9` | admin button on mobile drawer footer |
| D1-D12 | `e53000c` | iOS PWA keyboard saga — Telegram Web K pattern |
| E | `0867944` | narrow-mode BottomBar Server-tab dedup |
| F | `91cbc32` | send button → SVG paper-plane glyph |
| G | `a2de04e` | admin pane pan-x on mobile |
| H | (merged into D2) | scrollback follows viewport-shrink |
| I | `22ce80e` | cic refresh-banner single-press SW + caches saga |
| J | `7625e13` | push notif tap opens source window |
| K | `dae54b8` | PM unread-marker advances on focus (cursor-validator divergence fix) |
| L | `eb07e4b` | foreground push → in-app beep |
| Z | (this entry) | docs sweep + UX-5 backfill |

### Meta-lessons surfaced cluster-wide

1. **CSS-only iOS rubber-band fixes are systematically broken.**
   `touch-action` is non-inheriting (CSS UI L4 gotcha); three
   `touch-action`-only iterations failed before v4 added a JS layer
   and v6 converged on the 30-LOC touchmove ancestor-chain handler.
   Rule recorded (`feedback_research_before_attempt_9`): after 3+
   failed iterations on platform-boundary bugs, STOP iterating and
   dispatch parallel research agents.
2. **Telegram Web K's iOS keyboard pattern works only when shipped
   atomically** (`feedback_atomic_css_pattern`) — v9 `479b77d` landed
   ALL pieces in one commit; partial adoption catastrophic.
3. **Half-shipped features hide in moduledocs.** UX-6-J's root cause
   was an honest B5 moduledoc gap admission nobody acted on. A TODO in
   a moduledoc is a cluster candidate; file it immediately or it rots.
4. **Server-side predicate divergence is invisible until something
   reads BOTH paths.** UX-6-K's 422 on cursor write: inbound DMs
   persist at `channel = own_nick, dm_with = peer`;
   `Scrollback.fetch/6` used the OR-shape,
   `ReadCursor.message_belongs?/4` used a literal `channel` match.
   Fix: promote `channel_or_dm_where/3` from `defp` to `def` and
   delegate — the duplication was the bug.
5. **APNs quota tax is the right tradeoff at current scale** (UX-6-L
   Option B); re-evaluate the hybrid WSPresence-driven skip only if
   push volume justifies it.

UX-5 backfill: mobile-polish wave on iPhone PWA, 15 buckets, closed
2026-05-20 — per-bucket breakdown in README "Closed clusters". Its
final two buckets (BV `4959c92`, BD `38dc283`) seeded UX-6-A's overlay
scroll-leak fix.

Carry-forwards: UX-6-M (parked on vjt repro); UX-6-I.2 real-bundle-swap
e2e; baseline e2e fails ux-4-z:141 + ux-z:86. Accepted residuals (do
NOT chase): the visible iOS keyboard slide-in (~250ms compositor
animation below JS, unfixable in pure PWA; Capacitor escape if
priority rises); UX-6-M pending repro.

---

## 2026-05-22 — REV-C: substrate preflight + healthcheck depth (C4 + H20 + H21 + H26)

REV cluster bucket 3 (codebase-review-fixes 2026-05-22): 1 CRIT +
3 HIGH, all in the deploy/boot/healthcheck substrate. Single COLD
deploy.

### C4 — `scripts/deploy.sh` ↔ `LongLivedModules` SoT decoupling

The bash preflight parsed the SoT module list with a grep regex that
matched ANY indented Grappa-module-looking line — benign today
(typespec lines duplicated real entries), but a future
add-to-typespec-forget-`@modules` would silently mistrack. Fix is
**structural**, not a tighter regex: `scripts/deploy.sh` becomes a
thin wrapper around `mix run --no-start -e
'Grappa.Deploy.Preflight.cli([from, to])'` (2026-06-10: the cli now
requires a third substrate arg, `"docker"` | `"jail"` — see the
substrate-scoped entry). New `lib/grappa/deploy/preflight.ex` reads
`LongLivedModules.all/0` directly; the ~150-LOC
`scripts/_extract_state_block.awk` is deleted
(`Code.string_to_quoted/2` + AST walk instead). The SoT module was
always the right authority; the bash regex was the bypass.

### H20 — preflight path-class gaps

`Preflight.classify_paths/1` now covers classes the regex missed:
`compose.override.yaml` + `compose.oneshot.yaml`, `bin/grappa`,
`.dockerignore`, deeper `infra/snippets/*`, ALL `config/*.exs`,
`priv/repo/migrations/*`. The migration class was reproduced live
during REV-B's deploy (preflight returned HOT despite a new migration
file; operator forced `--force-cold`).

### H21 — `SECRET_SIGNING_SALT` compile→runtime

`config.exs` baked `System.get_env("SECRET_SIGNING_SALT") ||
placeholder` into the Endpoint's `@session_options` at compile time —
rotating the salt via `.env` no-op'd until a full image rebuild. Moved
to `config/runtime.exs`; the Endpoint drops `@session_options` for a
custom `:session` plug calling `Plug.Session.call(conn,
cached_session_opts())`, which reads `Application.fetch_env!/2` on
first request and caches in `:persistent_term` — the documented analog
for boot-once readonly under the "runtime env reads banned" rule.
`config_change/2` invalidates via `:persistent_term.put/2` (not
`erase/1` — avoids process-wide GC scan).

Reviewer round 2 caught HIGH-1 in that override:
`Application.config_change/3` delivers an application-scoped keyword
`[{Endpoint, [salt: ...]}, …]`, NOT a flat keyword —
`Keyword.has_key?(changed, :session_signing_salt)` checked the OUTER
key and could never match. Production salt rotation would have
silently no-op'd; tests passed because they bypassed the real shape.
**Meta-lesson**: a wrong-shape predicate that compiles but never
matches in production is exactly the class review exists for — the
tests were rewritten to drive the realistic shape.

### H26 — `/healthz` substrate depth

New `Grappa.Health.check/0`: `:ready` (Application `start/2` marks the
tree ready via `:persistent_term` AFTER `Supervisor.start_link/2`
returns clean), `:repo` (`SELECT 1` round-trip), `:ets`
(`:ets.info/1` on Backoff + NetworkCircuit `table_name()` —
single-sourced table atoms). `HealthController`: 200 `ok` on green;
503 + `{status: "fail", checks: [{name, reason}]}` — surface the
specific failing check. Docker + nginx healthchecks inherit the depth
for free.

### Deploy gotcha — first deploy after touching deploy.sh

The first `scripts/deploy.sh` run after the merge used the OLD
script's preflight (it runs before the new script replaces itself) →
false-HOT → `POST /admin/reload` 500'd because the new modules didn't
exist in the live BEAM. Recovery: `rm -rf /app/_build/prod` in the
container + `--force-cold`. **Standing rule: ANY cluster that touches
`scripts/deploy.sh` MUST first-deploy with `--force-cold`.**

Carry-forwards: `_build/prod` corruption cleanup still undocumented in
the operator runbook (3rd repro — REV-Z target); REV-B MED-2
(`validate_target_name/1` pre-canonical) still open.

Lessons: the reviewer-loop is not theater (round 2 caught a
production-only HIGH the tests were blind to); the AST oracle is the
right authority — the shell parsing was the bypass; conservative bias
— when in doubt, COLD: a 30s false-COLD is cheap, a deferred
shape-mismatch crash is not.

---

## 2026-05-22 — REV-D: silent-swallow at boundaries (H12-H16 + M16/M17)

Bucket 4 of 11. Five HIGHs + two MEDs sharing one theme: an error path
existed on paper but the implementation absorbed, masked, or routed
around it. One COLD deploy.

Five failure classes:

1. **Doc-vs-impl drift** (H12). `Backoff.record_failure`'s moduledoc
   claimed "called from `terminate/2` on any non-`:normal` exit";
   actual call sites were the `{:EXIT, client_pid, _}` handler +
   `do_start_client/2`. Non-Client crash classes bypassed backoff →
   counter stayed 0 → `:transient` respawn with no delay → tight crash
   loop exactly when the ladder mattered.
2. **Sister-function asymmetry** (H13).
   `Accounts.Session.touch_changeset/2` got a backward-clock-skew
   guard; the structurally-identical `Visitor.touch_changeset/2` never
   got the port — clock skew silently shrank visitor TTL → Reaper
   deleted a still-active row.
3. **Lookup-then-update race** (H14). `Visitors.commit_password/2` +
   `update_nick/2` did `Repo.get` → `Repo.update`; a peer delete
   between calls raised `Ecto.StaleEntryError` (500) instead of the
   spec'd `{:error, :not_found}`.
4. **Schema-vs-context cap drift** (H15). `last_joined_channels`'s
   200-cap lived only in the context helper; any bypassing writer
   could grow the JSON column unbounded. Schema is the canonical
   bound; the context cap is a convenience.
5. **Runtime config read** (H16). `PushVapidController.show/2` did
   `Application.fetch_env!/2` per request — the last "boot-time only"
   violation. Pinned via `Grappa.Push.boot/0` + `:persistent_term`
   (mirrors `Grappa.Uploads.boot/1`).

MEDs: M16 — `ChannelsController.delete/2`'s autojoin-removal logged a
warning + returned 202 on failure (next reconnect silently re-joined
the channel the user explicitly left); now propagates via `with` →
FallbackController. M17 — `ArchiveController.delete/2` strict-bound
`{:ok, _} =` turned context errors into MatchError 500s bypassing the
typed envelope; routed through a `with` arm.

### The H12 funnel pattern

Single-source a cross-cutting concern at the terminal door, not at
every site that could trip it. One `terminate/2` catchall clause is
now the funnel through which every abnormal Session.Server exit bumps
Backoff; `terminate(:normal, ...)` (operator intent) and
`terminate(:shutdown | {:shutdown, _}, ...)` (supervisor-driven,
graceful QUIT) are the explicit no-bump exemptions. OTP guarantees the
funnel for every non-`:brutal_kill`, non-BEAM-shutdown exit — and
`:brutal_kill` is an OS-level signal, not a network-instability
symptom. Reasoning surface shrinks from "audit every potential crash
site" to "audit the terminate clauses."

### The H13 split-changeset pattern

`Visitor.touch_changeset/2` served two semantics sharing one column
write: sliding TTL extension (forward; monotonicity guard correct) and
forced expiry from `mark_failed/2`'s k-line response (legitimately
backward by design). Split into guarded `touch_changeset/2` +
unguarded `expire_changeset/2` — different verbs, same noun.

### Boot-time pinning convention (2nd instance — now stable)

`<Context>.boot/0` reads `Application.fetch_env!/2` once at
`Application.start/2` time, stashes via `:persistent_term.put`; the
accessor returns `:persistent_term.get` and raises if `boot/0` hasn't
run (reaching it pre-boot is a bug); `Application.start/2` calls each
`boot/0` BEFORE the supervised Endpoint. Use for any future
per-request env read. (A library may itself read app env at delivery
time — web_push_elixir's signing path does; our call sites observe the
pin.)

### Deploy preflight FALSE-HOT trap (4th repro)

Local `git merge --ff-only` advanced HEAD before deploy.sh's `git pull
--ff-only` ran → "Already up to date" → `prev_sha == HEAD` →
preflight's same-SHA shortcircuit returned HOT → the HOT reload
no-op'd `Application.start`, leaving `Grappa.Push.boot/0` uncalled.
Caught by the H16 smoke; `_build/prod` clean + `--force-cold`
recovered. Mitigation candidate (REV-J/Z): compare against the LIVE
container's deployed SHA, not local `prev_sha == HEAD`.

Carry-forwards: FALSE-HOT mitigation + `_build/prod` runbook doc
(REV-Z); REV-B MED-2 still open; reviewer LOW-1 (H14 test name vs
behavior) documented, not fixed.

Lessons: single funnels beat distributed checkpoints — fewer doors,
fewer places to forget; sister functions with asymmetric guards are
almost always a port-not-made — search by signature shape before
signing off; spec-vs-impl drift is the silent killer (H12's moduledoc
was wrong for months because it was right enough that nobody re-read
it).

---

## 2026-05-22 — REV-E: `:ok = Client.send_*` strict-bind regression sweep (H11)

Eight+ bare `:ok = Client.send_*` matches in `Session.Server` would
crash the session on a dead socket — they predated the U-cluster
boundary fix that widened `IRC.Client.send_line`'s return to `:ok |
{:error, :no_socket | :closed | :inet.posix()}` and had been silently
incompatible since it landed; no live session happened to hit a
dead-socket SEND in the window.

Fix — two shapes, mirroring the post-U-cluster case-match pattern:
- **Propagate-path** (raw `:send_mode` handle_call + chunked-mode
  emission): recursive `flush_mode_chunks/3` halt-on-first-error per
  the collect-or-bail pattern — the old `Enum.each` over chunks
  ignored returns; now the caller's `with` chain surfaces the error.
- **Fire-and-forget path** (apply_effects `:reply` arm, `flush_lines`
  ghost-recovery, AWAY-internal sites): consolidated
  `maybe_log_send_failure/2` — `Logger.warning` with structured
  metadata, no propagation, because the caller is mid-state-mutation
  that must commit regardless.

Reviewer round 1 caught a HIGH: `dispatch_ops_verb/3`'s `with`/`else`
was non-exhaustive — the widened errors would raise `WithClauseError`
in the Channel pid, relocating the crash class from `Session.Server`
to `GrappaWeb.GrappaChannel`. Fixed with a catch-all `{:error,
reason}` arm + `Logger.warning` + typed `upstream_unavailable` cic
reply. New public type `t:Grappa.Session.send_transport_error/0`; all
22 `Session.send_*` wrappers widened to include it. Also noted:
AwayState recovery is overstated — the operator must re-issue `/away`
post-reconnect because a Session crash wipes AwayState.

HOT-deployed with a manual preflight against the deployed SHA BEFORE
running `scripts/deploy.sh`, defusing the FALSE-HOT empty-diff trap.

## 2026-05-22 — REV-F: IRC SASL combined-REQ fallback + dispatch_subject_verb catch-all (H9 + H10)

### H9 — AuthFSM combined `CAP REQ :sasl labeled-response` fallback on NAK

S4.2 made the FSM emit a single combined `CAP REQ :sasl
labeled-response` when CAP LS advertised both (saves a round-trip).
Bahamut and some Solanum variants advertise `labeled-response` in CAP
LS but NAK the combined REQ blob while ACKing `:sasl` alone. Pre-fix a
`:sasl`-required credential against such a server declared
`:sasl_unavailable` on the combined NAK and restart-looped permanently
against the backoff ladder. Latent for all of S4.2's deployment; found
by hand-walking the FSM during the codebase review.

Fix — split the post-REQ wait phase per shape so the NAK clause can
discriminate:
- `:awaiting_cap_ack` — standalone REQs only; NAK still declares
  `:sasl_unavailable` immediately (nothing bundled to fall back FROM).
- `:awaiting_cap_ack_combined` (new) — combined REQ in flight; NAK →
  emit `CAP REQ :sasl` alone, transition to the sasl_only phase.
- `:awaiting_cap_ack_sasl_only` (new) — fallback REQ in flight; NAK
  here genuinely means no SASL → existing `cap_unavailable/1` path
  (`:stop :sasl_unavailable` for `:sasl` auth; PASS-handoff for
  `:auto`). ACK proceeds to AUTHENTICATE PLAIN.

ACK guard widened across all three awaiting phases (identical
semantics); `maybe_send_cap_end/1` recognises the new phases; the
COMBINED→SASL_ONLY transition deliberately does NOT route through
`leave_cap_negotiation/2` (caps_buffer already cleared at the LS
boundary). `:auto` benefits as a side effect: pre-fix a combined NAK
silently lost SASL eligibility even when the server supported SASL
alone; post-fix `:auto` tries the fallback REQ first. C1 phase pin
preserved: the "SASL PLAIN reply only legitimate in `:sasl_pending`"
clause stays pinned exclusively to `:sasl_pending` — new phases
excluded, no credential leak; the C1 catch-all absorbs stray
AUTHENTICATE silently.

### H10 — GrappaWeb.GrappaChannel.dispatch_subject_verb/3 catch-all

Sister of `dispatch_ops_verb/3`: REV-E added the catch-all to the ops
helper, but the subject-verb sibling (whois/who/names/banlist — the
read-only verbs visitors may issue) kept the non-exhaustive
`with`/`else` — same `WithClauseError` crash class, relocated. Fix:
verbatim mirror of REV-E's catch-all, with a comment cross-referencing
it so future audits know the parity invariant. Consistency drift
between sibling helpers was itself the root cause REV-E HIGH-1 fixed.

Procedural: every reviewer brief now mandates literal-paste gate
evidence (run check.sh + dialyzer.sh directly, paste the tail) — that
is what distinguishes a real APPROVE from an implied one. Standing
rule for every cluster, regardless of how small the bucket looks.

---

## 2026-05-22 — REV-G: PWA SW denylist + Solid reactivity + admin WS (H22 + H23 + H24)

### H22 — PWA SW navigation-route denylist gap

The SW's `NavigationRoute` serves the precached SPA shell on top-level
navigations (`request.mode === "navigate"`); REST/WS pass through, but
explicit navigations hit the denylist. It listed the five scopes that
existed when the SW was authored; three later route scopes (`/api`,
`/admin`, `/uploads`) were never reflected back. Concrete bug: opening
a `📸 host/uploads/<slug>.png` link in a new tab got the SPA shell
instead of the image; same for direct `/admin/*` navigation. Fix
broadens the denylist; `/healthz` intentionally omitted (probe URL —
the shell is harmless there).

Structural pin: `test/grappa_web/router_sw_denylist_test.exs` walks
`GrappaWeb.Router.__routes__/0` (the authoritative compiled router) +
regex-parses the SW source, asserting SW denylist ⊇ router prefix set
modulo a documented whitelist (`/`, `/healthz`) — adding a top-level
route scope without updating the SW now fails before deploy.
`scripts/_lib.sh` `WORKTREE_VOLUMES` mounts `cicchetto/src` RO so the
Elixir test reads worktree SW state in oneshot mode (live container
unchanged).

### H23 — `markerRef` `<For>` ref leak in ScrollbackPane

A `let`-bound JSX ref to the unread marker (rendered inside a `<For>`)
kept pointing at the detached DOM node after mid-channel marker
removal (channel-switch had an explicit reset; mid-channel removal had
none). A later `scrollToActivation()` then called `scrollIntoView` on
the detached node.

**The feedback memory's fix recipe was wrong**: "convert to
function-ref signal, SolidJS calls it with `undefined` on unmount" —
that is the REACT contract. SolidJS function-refs are called ONCE on
mount and are NOT auto-nulled on unmount. Round 1 shipped exactly that
plus a smoke test that didn't exercise the regression path; the
reviewer flagged the test-pin quality (MED), and writing a real
spy-based pin exposed that the signal still retained the stale node.

Correct fix: function-ref signal **plus** explicit
`onCleanup(() => setMarkerRef(undefined))` registered inside the ref
function — `onCleanup` fires when the `<For>` row's reactive scope
disposes. The spy-based test now genuinely discriminates pre-fix from
post-fix (0 `scrollIntoView` calls). Gotcha documented at both the
declaration and JSX sites; the `feedback_solidjs_for_ref_leak` memory
needs the both-pieces recipe.

### H24 — admin-channel WS narrower

`adminEvents.ts` registered `channel.on` handlers on TypeScript-only
contracts — zero runtime enforcement, unlike the sibling channels'
`narrowChannelEvent`/`narrowUserEvent` WS-edge validators. A malformed
admin push (version skew, server bug, hostile push) could crash
`ingest()` via a missing-field read or silently corrupt
`liveCountsByNetworkId`. Fix: `narrowAdminEvent` + `narrowAdminSnapshot`
in `wireNarrow.ts`, per-arm field-shape validation for all 13
`WireAdminEvent` arms; snapshot validation is ATOMIC — one malformed
element drops the whole `{events: [...]}` (no partial audit-ring
corruption). `console.warn` + drop on mismatch — no silent swallow.

Procedural: when a reviewer flags test-pin quality on a fix that
"looks right", treat it as potentially signalling an incomplete fix,
not just a weak test — the two are correlated: a weak test often masks
an incomplete fix the worker assumed would work.

---

## 2026-05-22 — REV-H: server-side type tightening Theme A + ServerSettings PubSub single-source (H2-H8 + H25)

Bucket 8 of 11: six wire-shape typespec tightenings (H2, H3, H4, H5,
H7, H8) + one cross-module PubSub single-source restoration (H25).

The pattern (H3, H4, H8): the wire boundary was handed the
already-converted presentation value (stringified atom, pre-encoded
ISO8601, hardcoded `parked + failed` sum) when it should receive the
in-process value and do the conversion itself — mirroring the existing
proof-of-pattern (`Scrollback.Wire.to_json/1`'s `Atom.to_string`,
`Session.Wire.channel_created/3`'s explicit `DateTime.to_iso8601/1`).
Adding a 4th state to a closed-set union is now a single edit per side
instead of a hunt across N call sites.

H2 + H5 — closed-set discipline at the boundary: cic gains a
`ConnectionState` union mirroring the server's
`Credential.connection_state()` atoms + an `isConnectionState` runtime
narrower on every arm carrying one. H5 tightens
`cap_counts_changed.network_slug` from nullable to `String.t()` (the
broadcaster already early-returns on a missing network row — the
nullable arm was dead code on both sides). Surgical scope: other admin
arms (`circuit_open`, `capacity_reject`, `session_terminated`) KEEP
nullable slugs because the deleted-network race CAN reach those paths.

H7 — `Bootstrap.spawn_with_admission` case-matched a hardcoded subset
of `Admission.capacity_error_atoms/0` with no catch-all: a 5th atom
would crash-loop Bootstrap on every boot via `CaseClauseError`. Fix:
catch-all `{:error, other} ->` + Logger.error + "investigate" bucket;
`classify_outcome/3` extracted as a `@doc false` seam so regression
tests iterate the REAL atom list, asserting every current atom routes
to a known bucket and a fake atom lands in the catch-all.

H25 — `Grappa.ServerSettings` predated the `broadcast_event/2` +
`Grappa.PubSub.Topic` invariant: private `@topic`, raw
`Phoenix.PubSub.broadcast/3`, 2-tuple payload, invisible to
`Topic.parse/1`'s grammar (any tooling walking the topic surface would
miss it). Fix: `Topic.server_settings/0` builder + parse arm;
`broadcast_changed/0` routes through `Grappa.PubSub.broadcast_event/2`
with the typed `Wire.server_settings_changed/1` payload (single source
for REST, after-join push, per-user re-broadcast); tests flipped to
the `%Phoenix.Socket.Broadcast{}` shape every other context uses.

### Elixir 1.19 set-theoretic checker × FunctionClauseError tests

Tightening a Wire fn's spec from `map()` to a typed map makes
intentionally-bad-literal tests (`assert_raise FunctionClauseError, fn
-> Wire.f("net", "#c", %{}) end`) compile-fail — the checker correctly
flags the static mismatch, but the test pins the RUNTIME boundary,
which is exactly the contract under test. Workaround: `apply(M, :f,
[args])` defeats the static check (arity opaque through `apply/3`);
the runtime `FunctionClauseError` remains the assertion. Bit 4 times
across REV-H; if it bites a 3rd unrelated bucket it earns a
`feedback_apply_3_*` memory + a CLAUDE.md Testing Standards addition.

Deploy: first server-side REV bucket to auto-HOT —
`Grappa.Deploy.Preflight.cli` found no unsafe markers (function bodies
+ typespecs + tests only; `Session.Server` is long-lived but the edit
was `apply_effects/2` body-only). Validates the preflight's
discrimination; future Theme-A tightenings can follow the same path.
(REV-I touches nginx.conf → container restart; REV-K may shift
wire-shape; REV-Z is docs only.)

---
## 2026-05-22 — REV-I: infra simplification (H19 + H27 + M3 + M6)

Bucket 9 of 11 in the REV cluster. Infra-only. Closes 2 HIGH + 2
MEDIUM. M-triage: M2 subsumed by H19's snippet hoist (same fix);
M1 + M5 coupled to a single compose-anonymous-volumes refactor
(preserve image-baked `_build`/`deps`/cache through the bind-mount,
drop the 180s `start_period` band-aid + the `WORKTREE_VOLUMES`
include-list) → deferred to REV-J; M4 (`!override` vs `!reset`
merge-keyword inconsistency) cosmetic → REV-Z. The vjt mandate is
"most-important MEDs," not "all 50 MEDs."

### H19 — nginx admin allowlist snippet extraction

Since M-9b (2026-05-16) every new `/admin/<resource>` required an
nginx allowlist regex edit in **three** places — `infra/nginx.conf`
(prod) + `cicchetto/e2e/nginx-test.conf` :80 and :443 blocks — and
the LLM was the only one tracking the mirror (the e2e :80 block had
already drifted historically). Fix: hoist the entire location-block
surface (not just the admin allowlist — WS proxy, REST allowlist,
`/sw.js` cache override with re-asserted security headers, SPA
fallback) into `infra/snippets/locations-api.conf`; all three server
blocks `include` it (three include sites, one source file). The
snippet dir was already mounted into both nginx containers for
`security-headers.conf` — no compose surgery. The old "can't include
inside server block" objection in the nginx-test.conf moduledoc was
simply wrong; nginx supports `include` inside `server { }`. The :443
coverage IS the M2 fix, shipped under H19's banner.

### H27 — `in_container` replaces bare `docker exec grappa`

`scripts/deploy.sh` + `scripts/deploy-cic.sh` used bare
`docker exec grappa …` (assumed `container_name: grappa` literally).
Swapped to `_lib.sh in_container` — which refuses to run from a
worktree (the live container mounts main's source; exec there would
run the wrong code). Both scripts run from main + `cd $REPO_ROOT`,
so the guard fits.

### M3 — `bin/grappa` VERBS single-source-of-truth refactor

Pre-M3 verbs were enumerated across five surfaces; bats caught
dispatch-switch drift but not help-banner drift (a verb could ship
undiscoverable to `bin/grappa help`). Fix: single `declare -Ag VERBS`
map (verb → `kind|target|group|description`) + generic
`dispatch_boot`/`dispatch_rpc`/`dispatch_help`; `dispatch()` prefers
a bespoke `verb_<snake>` handler via `declare -F` probe. Adding an
arg-taking RPC verb = one VERBS entry + one function; a nullary RPC
verb = one VERBS entry only.

Bash 4 limitation: associative-array iteration order is undefined, so
`help_top()` walks an explicit `VERB_DISPLAY_ORDER` array — two
sources, documented in-place; no fix without dropping the bash 4
floor. LOC grew 378 → 438; the brief's "−95 LOC" was optimistic (the
reviewer caught it; this entry corrects the record — the refactor is
structural, not size-reducing). New bats regression:
`reap-visitors --extra → exit 64` (arg-taking verb without a bespoke
handler falls through to `dispatch_rpc`, which refuses clearly).

### M6 — `+SDio` floor at BEAM's 10-IO default

`bin/start.sh` defaulted `GRAPPA_DIRTY_SCHEDULERS` to `$(nproc)`,
setting BOTH `+SDcpu` and `+SDio` — on a 1-CPU container the sqlite
WAL pool (dirty-IO) would serialize. Fix: default =
`max(nproc, 10)` (BEAM's own 10-IO default); explicit
`GRAPPA_DIRTY_SCHEDULERS` still overrides both knobs together.

### The deploy-preflight false-HOT recurrence

Operator merged `rev-i` → main locally, ran `scripts/deploy.sh`; the
pull said "Already up to date" so preflight took the same-SHA fast
path → classified HOT → nginx.conf was NOT live. Recovery:
`scripts/deploy.sh --force-cold`. This is exactly
`feedback_deploy_preflight_empty_diff_after_merge` (V9, 2026-05-15) —
the memory existed; the LLM forgot. Right move: manual preflight
FIRST with explicit prev-SHA:

```
scripts/mix.sh run --no-start -e \
  'Grappa.Deploy.Preflight.cli(["399311b", "HEAD"])'
```

Script-level fix (same-SHA + recent merge ⇒ demand `--force-hot`)
carried to REV-J/REV-Z as a candidate.

---

## 2026-05-22 — REV-J: cross-cutting smells (M7-M15 + M18)

Bucket 10 of 11. Lib + test only. 9 MEDIUM closed. M1 + M5 deferred
to REV-J.5 (named-volume-init UID trap bit on first attempt — see
below). M16 + M17 were already closed in REV-D; the brief mis-listed
them.

### Theme — "no convention-as-contract" applied across boundaries

One rule: when an invariant only holds because the next call-site
author remembers it, the rule lives at the wrong layer. Five moves
from "comment + convention" to "structure":

1. **M7** — `Session.Server.handle_info({:EXIT, _, :shutdown|:normal})`
   caught ANY non-Client linked process's clean exit as a Session
   stop. Unreachable today (Client is the only init-linked spawn) but
   only a comment defended it. Now raises, so a future
   `Process.link/1` escape surfaces at the supervisor instead of
   masquerading as planned park. Per CLAUDE.md "Crash boundary
   alignment."
2. **M8** — `cancel_and_drain/2`'s single-shot `receive ... after 0`
   only worked because every call site re-armed the timer after
   cancel (three slots carried the invariant by review discipline).
   New recursive `drain_all/1`: zero correctness obligation on call
   sites.
3. **M12** — `Scrollback.fetch/5` + `fetch_after/5` wrapper arities
   auto-passed `nil` for `own_nick`; the CP14-B3 own-nick-leak fix
   could silently re-emerge through any future controller. Wrapper
   arities that default LOAD-BEARING params carry the same hazard as
   `\\` defaults — callers now state `nil` explicitly.
4. **M11** — `Operator.disconnect_session` emitted
   `:session_disconnected` even on the already-`:parked|:failed`
   no-op branch — the admin events ring falsely claimed a disconnect.
   `disconnect_user_session/3` now returns
   `{:ok, :transitioned | :noop}` and the caller routes the emission.
5. **M13** — `Networks.transition!/3` used `Ecto.Changeset.change/2`,
   bypassing all validations including `safe_line_token` on
   `:connection_state_reason` — a future schema validation would
   silently not fire. New `Credential.connection_state_changeset/2`
   casts only the three transition fields.

### Other closes

- **M15** — folded `connection_state_changed` +
  `home_network_state_changed` (two events on one topic, with a
  temporal window where they disagreed) into ONE event carrying a
  `:network` field. Lockstep cic edits (`api.ts`, `userTopic.ts`,
  dispatcher).
- **M14** — `Session.call_session/3`'s implicit 5s timeout surfaced
  as a Phoenix 500 with no typed envelope. /3 now delegates to /4
  (which catches `:exit {:timeout,_}` → `{:error, :timeout}`);
  FallbackController gains a `:timeout` arm → 504 + `retry-after: 10`.
  Per "no silent-swallow at boundaries."
- **M18** — `UploadsController.disposition_header/1` used
  `URI.encode_www_form/1` (space → `+`); RFC 5987 `filename*=UTF-8''…`
  requires RFC 3986 percent-encoding (space → `%20`). Now
  `URI.encode/2` with the unreserved-char predicate.
- **M9 + M10** — `Visitors.Reaper` schedules `:tick` BEFORE `sweep/0`
  (cadence no longer drifts by sweep duration);
  `NetworkCircuit.reset_sync/1` replaces Operator's
  `:sys.get_state/1` drain with a public synchronous verb, so a
  future refactor of NetworkCircuit can't silently break the
  post-reset snapshot.

### Deploy + M1+M5 deferral

Lib-only → HOT, sessions preserved. Push `57f7cca..e0b8b27`.

M1+M5 (anonymous volumes over `_build`/`deps`/caches + collapse
`WORKTREE_VOLUMES` to a single `$SRC_ROOT:/app`) is mechanically
right but hit the named-volume root-init trap: anonymous volumes seed
root-owned from the image, container runs UID 1000, first compile
denies (`feedback_named_volume_uid_trap`; compose.yaml's comment
block documents why bind mounts were chosen originally). Path to fix:
Dockerfile chown of the cache dirs to 1000:1000 BEFORE the COPY
layers, then re-attempt as REV-J.5.

---

## 2026-05-22 — REV-K: cross-surface naming pay-down (M19 + M20)

Bucket 11 of 11 (codebase-review-fixes, 2026-05-22). Both surfaces;
COLD-deployed. Closes 2 MEDIUM (review § cross-surface S15 + S18).

### M19 — `mentions_bundle.messages[*].sender_nick:` → `sender:`

The mentions bundle used `sender_nick:` while sibling
`ScrollbackMessage` used `sender:` — a "consistency or nothing" debt
from arch review A8, deliberately kept small-but-EXPLICIT in one
place, which is what enabled the one-touch rename now. Renamed across
server wire + push payload doc + cic types/narrowers/render + tests.

Note: `Message.sender_nick/1` (the IRC parser helper extracting nick
from prefix) is intentionally UNCHANGED — same name, different
domain.

### M20 — WS Channel error envelope `%{reason: "<token>"}` → `%{error: "<token>"}`

REST FallbackController uses the canonical A7 `%{error: "<token>"}`
envelope; WS Channel replies used `%{reason: …}` for the same
content, and cic push helpers couldn't branch (opaque unknown →
`[object Object]`). Unified on `error:` across grappa_channel (36
replies) + admin_channel + 33 test assertions.

Cic side adds typed `ChannelPushError` + `channelPushError/1`
extractor mirroring `ApiError`; push helpers now reject with the
typed error carrying the wire `code`. Per
`feedback_no_silent_drops_closed`: the prior `reject(err)` of bare
unknown was a silent-swallow at the cic boundary. The typed class
ENABLES branching; the single current consumer (`compose.ts:601`)
still falls through to a generic string — docstring honestly framed
as "FUTURE consumer pattern" (reviewer LOW-2).

### Reviewer round

APPROVE with 3 LOWs. LOW-1: `ChannelPushError` had only transitive
coverage that would pass even if the extractor returned
`new Error("anything")` — 5 focused unit tests added in round-2
(mutate-tested). LOW-2 addressed above. LOW-3 (`info` field
duplicates `error` key) deferred as cosmetic — `info` IS the full
server reply by design.

### Deploy — COLD (--force-cold)

Preflight classified HOT, but the BUSINESS rule wins: a wire-shape
change desyncs server emit from live connected cic tabs (old-bundle
narrowers expect `sender_nick:` + `%{reason:}`) until the refresh
banner is clicked. Per `feedback_hot_deploy_preflight` "in doubt,
COLD": forced cold, then `scripts/deploy-cic.sh` broadcast the new
bundle hash so surviving tabs auto-prompt. Push `e412c17..8070551`.

Carry-forwards to REV-Z: REV-J.5 still deferred; LOW-3 cosmetic;
`compose.ts:601` ChannelPushError branching consumer.

---

## 2026-05-22 — REV-Z: REV cluster CLOSED — docs sweep + LOW liquidation

Final REV bucket (12 of 12). Docs-only; no deploy.

### Cluster summary

11 fix buckets + 1 docs bucket shipped autopilot within 2026-05-22.
The full codebase review (8 parallel agents) catalogued 4 CRIT +
29 HIGH + 20 gating MED + 27 LOW; the wave fixed all CRIT + all HIGH
+ all gating MED; LOWs opportunistic.

Bucket map with closes:
- REV-A (`ad7565f`) — C1, C2, H1: cross-surface wire arms + flow union
- REV-B (`e21c299`) — C3, H6, H17, H18: persistence pragma + closed-set guards
- REV-C (`84ccc68`) — C4, H20, H21, H26: substrate preflight + healthcheck depth + `signing_salt` move to runtime.exs
- REV-D (`fc5d221`) — H12-H16, M16-M17: silent-swallow at boundaries
- REV-E (`1980035` + `a4d4b22`) — H11: `:ok = Client.send_*` strict-bind regression sweep
- REV-F (`6574f0e`) — H9, H10: IRC SASL fallback + missing dispatch arm
- REV-G (`bc16132` + `99256ed`) — H22, H23, H24: PWA SW denylist + Solid reactivity + admin WS
- REV-H (`f77f46a`) — H2-H5, H7, H8, H25: server-side type tightening Theme A
- REV-I (`1539292`) — H19, H27, M3, M6: infra simplification
- REV-J (`e0b8b27`) — M7-M15, M18: cross-cutting smells
- REV-K (`e4a08bc` + `8070551`) — M19, M20: cross-surface naming pay-down
- REV-Z (this) — docs sweep

REV-A + REV-B have no chronological entries — cluster-summary-only by
choice; future readers follow summary → commit → review finding.

### Meta-lessons from the cluster

1. **Per-bucket reviewer-loop earned its keep** — REV-G round-1
   caught an incomplete fix; REV-K round-1 caught LOW-1/LOW-2.
2. **Wire-shape changes desync server emit from live cic narrowers**
   — force COLD even when preflight says HOT ("in doubt, COLD").
3. **Hand-edited lockstep cross-surface types are not the long-term
   shape.** A third of HIGHs + both REV-K MEDs were server-typespec ↔
   cic-type drift. Structural answer: `wireTypes.ts` codegen from
   `Grappa.*.Wire` typespecs (slotted after flakes triage). The
   hand-edits become the codegen's SOURCE — not wasted.
4. **Substrate fragility is the second-biggest emergent risk.** REV-C
   landed the CP28-class fix: preflight now has an AST oracle
   (`scripts/_extract_state_block.awk`) catching field-additions
   inside existing state blocks that the line-anchor regex missed.
5. **Silent-swallow class stays load-bearing** — REV-D closed five
   boundaries; REV-K extended the pattern into cic via
   `ChannelPushError`.

### Scope + carry-forwards

README closed-clusters entry; REV-G header normalized to the
`## YYYY-MM-DD — TITLE` convention; CP43 opened; MEMORY.md
compressed.

Carry-forwards: REV-J.5 (M1+M5 UID prep); `compose.ts:601` typed-error
branching consumer; REV-K LOW-3 cosmetic; `_build/prod` cleanup
procedure still undocumented in the operator runbook; the 27-item LOW
set stays opportunistic (notable themes: dead clauses in
`Identifier.services_sender?`, empty-reason `send_away/2` accepting
`AWAY :\r\n`, `linkify` regex `\S+` unbounded, image-upload bypass of
`token()` signal, `bin/start.sh` env-fiddling).

### Post-REV ordering (vjt mandate)

Per `project_post_review_ordering_2026_05_22`: 1. e2e flake triage +
fix; 2. wireTypes.ts codegen; 3. bastille deploy workstream (GitHub
#8).

REV cluster: **CLOSED**.

---

## 2026-05-22 — FLAKE-A: e2e baseline triage manifest

First bucket of the FLAKES cluster. Docs-only. Manifest at
`docs/reviews/flake-triage-2026-05-22.md`.

Headline: brief said "45 e2e + 2 server-side classes"; re-baseline at
`bf3ba3a` measures **41 e2e + 0 server-side**. The two server classes
were already closed:

- ETS-singleton-leak (`7bb3caa`, 2026-05-17) — root cause was
  `IRC.Client.handle_call({:send, _})` raising on a dead socket and
  blocking `Session.Server.terminate/2`'s narrow exit-catch; boundary
  fix returns `{:error, :no_socket | :closed}` honestly.
- `AdminEventsTest:197` `assert_receive` race — folded into REV-D +
  U-cluster live-cap-counters work.

Server-side baseline clean (2424 tests, 0 failures). Cluster scope
shrinks to e2e only.

### e2e shape (41 fails, 33 distinct files)

Duration histogram is the diagnostic:

```
27 × 31.x s   → Playwright 30s test-timeout (Class C — load)
 9 × 5-6s     → assertion-fail @ default timeout (Class A)
 3 × <1s      → locator-not-found instant fail (Class A)
 2 × 10-11s   → bumped-timeout assertion fail (Class A/B)
```

27/41 cluster at 31s — attributed to the bahamut load-state shape
(`project_bahamut_load_flake`): after ~40-50 specs of sustained
JOIN/PART/KICK, new JOINs don't get clean handshakes. One root cause,
one fix bucket (FLAKE-B). Remaining 14: NickText cluster (3),
image-upload modal (2), server-window (2), iOS-PWA kb (3), 5
singletons — buckets FLAKE-C…G, plus FLAKE-Z closer with
inline-justified quarantines per `feedback_recurring_e2e_not_flake`.

Hard rules carried from REV: no `gh run rerun --failed`
(`feedback_no_ci_retries_on_first_failure`); quarantines via
`test.skip` + tracking memory only, never silent timeout-bumps
(`feedback_no_silent_drops_closed`).

FLAKE-A: **LANDED**.

---

## 2026-05-22 — FLAKE-B Part 1: desktop fixture rot for `selectChannel(_, _, "Server")`

**Closes:** 6+ spec-rot cases (b0, b2, p0e, cp22-bnames, m2,
ux-2-mobile-archive + downstream sharers of `SERVER_WINDOW_LABEL`).
Does NOT close the "Class C" load class — FLAKE-A's manifest
mis-classified (see Part 2).

FLAKE-A sampled 6 specs in isolation (all passed) and inducted the
rest were load-class too. Wrong: the sampled 6 happen not to use
`selectChannel(_, _, "Server")`; several others fail ALONE.

Root cause: post-UX-4-C the desktop sidebar collapses the per-network
`<h3>` + standalone Server tab into one
`<li class="sidebar-network-header">` whose text is `⚙️ <slug>` —
never the literal "Server". The mobile fixture branch was updated;
the desktop branch kept the pre-UX-4-C
`section.locator("li", { hasText: "Server" })` → 30s timeout.

Fix (`cicchetto/e2e/fixtures/cicchettoPage.ts:190-204`, commit
`c804208`), same shape as the mobile branch:

```ts
if (windowName === "Server") {
  return section.locator("li.sidebar-network-header");
}
return section.locator("li", { hasText: windowName });
```

### Failed hypotheses (do not retry)

1. **Per-spec session-bounce isolation** (park → connect between
   specs). Implemented, reverted on evidence: the bounce hook
   succeeded but test bodies still stalled; late-suite specs cascaded
   to 0ms (the helper itself broke under load); the afterEach log
   proved autojoin restoration ITSELF takes >30s at suite scale —
   exactly what the bounce relies on.
2. **Per-spec channel-name uniquification** — never implemented;
   would cover at most 14 of 26 putative Class C specs.
3. **Autojoin-restore latency as primary root cause** — investigated
   per vjt "find out why join takes 30s do not work around it": the
   30s is the gap between fire-and-forget send_join and bahamut's
   echo; throttle is disabled on testnet; no single mechanism
   explains it universally. Evidence pivoted to per-spec rot.

Evidence: each unblocked spec <2s post-fix (was 30.6s), but
suite-level flake (±10 specs run-to-run) dwarfs the ±4 net delta.
**LANDED-with-two-green-runs deliberately NOT claimed** per
`feedback_landed_claim_evidence` — fix verified in isolation, suite
too flaky to call two green runs. Landed on `c804208`; no deploy
(e2e-fixture-only).

---

## 2026-05-22 — FLAKE-B Part 2: per-spec true-isolation triage

**FLAKE-A's classifications were FALSE INDUCTIONS.** No code —
re-baselines the manifest at `docs/reviews/flake-triage-2026-05-22.md`.

Methodology: Pass 1 batched (38 files × 2 runs, stack reset between
BATCHES of 5) caught always-fails-alone cases but mis-classified 5
files contaminated by prior-spec state within their batch. Pass 2 =
true isolation: `scripts/testnet.sh down && up` before EACH single
spec. Authoritative.

Results:

- **27 files** pass in true isolation = **SPEC-ROT (load class)** —
  upstream isolation failure, not per-spec. Includes FLAKE-A's
  "Class A" NickText + iOS-PWA kb clusters, which pass cleanly alone.
- **7 files** fail in true isolation = REAL BUG candidates:
  `i2-image-upload` (vjt: uploads work in prod → spec wrong),
  `m9-cicchetto-part-x-click`, `members-prefix-regression`,
  `names-ux-n3-cold-load-auto-select`, `nick-case-sensitivity`,
  `p0d-lusers`, `p0e-invite-ack`.
- **4 files** mixed Pass-1 (FLAKE class), not yet re-validated:
  `cp14-b3-dm-history-bidirectional`, `ios-z-cluster-journey`,
  `m9b-admin-sessions-actions`, `ux-6-k-pm-unread-cursor`.

Lessons:

1. **Batched isolation is unreliable** — state leaks across specs on
   the same stack instance. Per-spec full stack cycle is the ONLY
   reliable isolation primitive.
2. **Sampling-based inductions are dangerous** — 6 passing samples
   were taken as evidence for 27; they weren't representative.
   Per-spec validation is required for any classification claim.
3. Most "real-product-bug" calls were spec rot — the UX-4/5/6/7
   sweeps moved enough DOM that specs assert stale selectors.

Next (vjt: "finish this round, we clear and we evaluate each one"):
per-spec triage of the 7 candidates; re-classify the 4 FLAKE files in
true isolation; design an upstream isolation mechanism for the 27 —
NOT session-bounce, per Part 1 evidence.

---

## 2026-05-23 — FLAKE-C + FLAKE-D: per-spec triage close

Closes the FLAKES cluster. FLAKE-C = the 7 "REAL BUG?" candidates
from FLAKE-B Part 2; FLAKE-D = the 4 Pass-1-mixed files.

### FLAKE-C (2026-05-23) — 7-for-7 SPEC ROT

Zero real product bugs. Commit map:

| # | Bucket | Commit | Root cause |
|---|--------|--------|------------|
| 1 | i2-image-upload | `2132bea` | UX-6-B2 flipped default upload host litterbox→embedded; spec stubbed wrong endpoint. Split into embedded + litterbox-with-admin-pin specs. |
| 2 | members-prefix-regression | `5562ae7` | M-cluster seed expansion; vjt-grappa no longer wins +o race. Assert any op tier. |
| 3 | p0d-lusers | `632148f` | UX-4-C "Server" selector rot; routed through `sidebarWindow()` fixture. |
| 4 | p0e-invite-ack | `b05c88e` | Cascade from #2: Bahamut silently drops INVITE from non-op. Join fresh channel first (first joiner = +o). |
| 5 | m9-cicchetto-part-x-click | `1d17010` | UX-4-B/E made empty-state assertion obsolete. Dropped it. |
| 6 | names-ux-n3-cold-load-auto-select | `214fce6` | UX-4-B replaced first-joined auto-select with home cold-load. Spec obsolete by design — deleted. |
| 7 | nick-case-sensitivity | `0a9b7cd` | UX-5 BH `.sidebar` → `.shell-sidebar`. Pure selector drift. |

### FLAKE-D (2026-05-23) — 2 real races, 2 batched-only false-positives

| Bucket | Verdict | Commit |
|--------|---------|--------|
| `cp14-b3-dm-history-bidirectional` | **Real race**: peer PRIVMSG arrives before cic's own-nick DM-listener subscribe → silent fan-out drop | `64d6e0b` |
| `ios-z-cluster-journey` | Batched-isolation false-positive (3/3 green iso) | none |
| `m9b-admin-sessions-actions` | Batched-isolation false-positive (4/4 green iso; destructive specs in OTHER files corrupt ordering) | none |
| `ux-6-k-pm-unread-cursor` | **Same race as cp14-b3** | `0efa550` |

The 2 real races share the root cause UX-6-L already fixed via the
`__cic_dmListenerReady` test seam (set from the DM-listener
`phx.join()` onJoinOk); both predated it. Factored the inline wait
into shared `waitForDmListenerReady(page, slug)` in
`cicchettoPage.ts` — all three peer-driven DM specs use it.

### Cluster-level verdict + carry-forward

0 product bugs across all 11 candidates; **FLAKE-A's manifest was
0-for-11 on real-bug calls** (sampling induction). Remaining
suite-level flake = upstream isolation, not per-spec bugs. The 27
SPEC-ROT (load class) files stay quarantined behind suite noise; the
"upstream isolation mechanism" (per-spec stack cycle inside
`scripts/integration.sh` — slow but the only reliable signal) is
deferred until the pain returns. No deploy (pure e2e). FLAKES cluster
CLOSED on `0efa550`.

---

## 2026-05-23 — GREEN-CI: vjt overrides FLAKES "load class" defer

vjt mandate: CI red on 30 specs; "i want fucking ci green and testing
actual functionality" — overrides FLAKE-B-Part-2's load-class defer.
`@skip` tags disallowed; specs must be deterministic AND exercise the
real contract. Local diagnosis found a single root cause for 26 of
30 cascade failures.

### SPEC-1 (`AdminEventsTest:197`, `ee20035`) — SessionRegistry stale-entry race

Setup registers fake `{:session, _, _}` keys under the test pid;
on_exit's `Registry.unregister/2` runs from a FRESH pid → no-op
(Registry only unregisters entries owned by the CALLING pid), so
cleanup falls back to the async monitor-DOWN. Sandbox rollback means
the next test's `%Network{}` reuses `id = 1`, so stale entries
inflate `Admission.live_counts_for_network/1` → `visitors: 2` instead
of 1. Fix: drain `{:session, _, _}` at setup via bounded poll, then
`flunk/1` with the leftovers so a true hang surfaces clearly. Also
covers the `Task.start_link` + `Process.exit/2` async-cleanup race in
`LiveIntrospectionTest`.

### SPEC-2 (`cic-members-panel-scope:107`, `31c7295`) — asserts unreachable state

"Parked channel suppresses MembersPane" predates UX-4-E's
close-watcher auto-redirect: post-PART, selection moves to MRU, so
the operator CANNOT be focused on a parked channel. The suppression
contract is already covered by the cp15-b6 failed/kicked specs.
Deleted, not quarantined.

### SPEC-3 (`m10-admin-networks-cap-editor:61`, `31c7295`) — two layers of rot

1. U-1 split the cap testid into visitor + user siblings; the spec
   waited 30s on the dead testid — and that 30s burn was the HEAD of
   the cascade timing window for the serial-singleton lane.
2. NULL starting cap (the e2e seeder binds with no cap params) →
   empty input → `+1` sentinel became `NaN` → `fill("NaN")` rejected
   on `<input type=number>`. Handle empty explicitly (sentinel "42").

### SPEC-4 (cascade root cause, `2502d81`) — `.first()` lottery

The big one. `m9b-admin-sessions-actions` +
`u5-admin-networks-live-counts` picked their destructive target via
`[data-testid^='admin-session-…-'].first()`. **Registry insertion
order is non-deterministic; "first" resolved to vjt's session ~50% of
runs.** After vjt was Disconnected/Terminated, every downstream spec
logging in as vjt found an empty sidebar → `selectChannel` 30s
timeouts. 26 of 30 cascade failures shared this locator.

Fix: seed a sacrificial `m9b-victim` user; bump bahamut-test
`max_concurrent_user_sessions` to 10 (default 3 = exactly the seeded
count → reconnect PATCH hit `503 network_busy`); each destructive
spec first reconnects the victim (idempotent PATCH as the victim,
with its captured token) then targets it via `getSeededM9bVictim()`'s
composite session id — vjt + m9b-test stay alive for every downstream
spec. m9b "lists rows" assertion bumped 2 → 3.

### Cluster-level verdict

- **0 product bugs**; all 4 were test-infrastructure rot.
- **The "load class" framing was wrong for 26 of 27 cascade specs** —
  `.first()` lottery, one fix. Per-spec full-stack iso WOULD have
  masked it (each spec passes alone: `.first()` deterministically
  picks the only row). Only cross-file ordering exposed the cascade.
- vjt's "test ACTUAL functionality" overrode the defer correctly —
  load was the symptom, `.first()` the cause.

CI confirms cascade cleared on `2502d81`: integration went
154 passed / 30 failed → 177 / 7; the 7 leftovers share no locator
signature (4 of 7 iOS/webkit, carried forward). No deploy (e2e +
sandbox-test only).

## 2026-05-23 — GREEN-CI cluster batch 2 close (chromium-3 + webkit-iphone + admin-events)

Same-day continuation; 7 residual failures + 1 latent CI flake in 3
commits.

**chromium-3 (`45e69b3`)** — m9b-victim raised the #bofh +o autojoin
race from 2 → 3 candidates, breaking specs that assumed vjt's
op-status was deterministic:

- `b0-invite-from-server-window` — Bahamut silently drops INVITE from
  a non-op inviter → dedicated `#b0-invite-test` channel (vjt joins
  first → +o).
- `members-prefix-regression` — `.member-op` empty when the victim
  won +o then a destructive spec killed its session. Same fix.
- `ux-5-bc2-nick-render` — assertion wrong by DESIGN: MembersPane
  passes `noColor` to NickText (UX-6-A v2), so the span resolves to
  `--fg` = `#000000` in mirc-light → rgb sum 0. Probe moved to the
  scrollback sender (canonical colored site); 2 other latent op-race
  flakes in the file hardened via peer-first dedicated channel.

**webkit-iphone (`85d2b1c`)** — two distinct root causes:

- iOS-3 PART hole: close-× specs PART vjt from #bofh with no
  restoration; downstream webkit specs can't selectChannel. Same
  SHAPE as SPEC-4 cascade, different mechanism. Fix: `afterEach`
  rejoin via REST.
- ux-6-d real bugs: (d) mobile boots into HomePane (UX-4-B `:home`
  default) which has no compose box — selectChannel first; (f)
  `promoteVjtToAdmin` hardcoded a literal non-token string → 401, and
  drove admin via the desktop cog which is off-viewport on mobile —
  replaced with the ux-6-g pattern + the mobile members-drawer admin
  launcher.

**admin-events (`b17fd71`)** — SPEC-1's 500ms drain poll too tight
under CI ETS contention (7 of 10 setups flunked); bumped to 2s
(200×10ms). 2s is the new floor for SessionRegistry drains under
sandbox + load.

Lessons: new memory `feedback_seed_expansion_audit` — when adding
seeded users / sacrificial targets, audit every spec assuming a
deterministic position on a shared resource (op race for first-JOIN,
sidebar insertion order, color slots). Cascade poisoning isn't
chromium-only: any spec mutating shared bouncer state (PART, MODE)
MUST afterEach-restore.

Final CI: integration 184/0 at `85d2b1c`; ci exit-0 at `b17fd71`.
30 → 0 across batches. No deploy.

---

## 2026-05-23 — GREEN-CI-3 Tier 1 e2e suite hardening

vjt: full e2e suite review — "ensure they are solid now and do not
have an occasion to regress ... test actual features and not stupid
internals." 4 parallel review agents over 104 specs + 5 fixtures,
~50 findings. Tier 1 (fix-once-cure-all) shipped; Tier 2/3 deferred
(captured verbatim in the plan appendix).

**B1 (`e2894c9`)** — 4 specs (m4, m5, m6, p0b) raced the own-nick
DM-listener join ack; they predated `waitForDmListenerReady`.
One-line insert each.

**B2 (`243f471`)** — `sidebarWindow` substring match (`hasText`)
collided (`#bofh` ⊂ `#bofh-test`, `peer` ⊂ `peer2`) + Playwright's
default `.first()` on ambiguous locators → non-deterministic row
(SPEC-4 class at the fixture layer). Plan's anchored-regex approach
can't work: badge spans are siblings inside the same `<li>`, so the
parent's textContent = `{name}{badge}…` defeats anchors (channel
names contain digits too). Fix: `data-window-name` attribute on every
sidebar `<li>` + bottom-bar tab (mirrors the existing test-seam
attributes; production behavior unchanged); fixture becomes exact
`[data-window-name="${name}"]`. "Server" and the slug both alias to
SERVER_WINDOW_NAME = "$server".

**B3 (`4afa4e1`)** — globalSetup runs 4 logins back-to-back; one
cold-start 504 (`login_probe_timeout_ms = 3s` vs fresh IRC session,
per `feedback_visitor_mint_e2e_cold_start`) aborted the whole run.
`loginWithRetry` (3 attempts, 2s/4s/8s backoff).

CI at close: integration 183/1. The 1 fail is
`scroll-on-window-switch:141` — vjt confirmed the scroll regression
IS real in prod (passes on a fresh stack, fails on re-runs when the
query window persists in cic state). Pre-existing, NOT B1/B2/B3
(isolated 3× ✓✘✘ on the same head). **This spec is the canary for
UX-8** — it turns green as UX-8 ships. NO spec-side afterEach cleanup
added that would mask the bug.

Lessons: plans are inputs, not contracts (B2's regex → attribute
deviation recorded in the commit body); a spec that passes 1st run +
fails 2nd+ isn't always spec rot — sometimes it's a real prod bug
behind a state-leak path, and the cleanup that "fixes" the spec would
mask it; deferring Tier 2 kept the cluster atomic + reviewable.

No deploy (e2e-only).

---

## What's *not* in this document (on purpose)

- Anything that was decided inside a private channel and hasn't been published elsewhere. The repo is public; private crew chatter stays private.
- Implementation scheduling ("I'll do X next week") — that belongs on the issue tracker, not in-repo.
- Anything that belongs in `CONTRIBUTING.md` or a future issue template — to be added when the project moves past spec-only.

## 2026-05-24 — UX-8 scroll cluster CLOSED

Two sub-clusters, one plan: (a) channel-switch scroll-position
interference + (b) scroll-settle read-cursor update. Sentinel
`scroll-on-window-switch:141` now consistently green; e2e 184 → 187.

### Sub-cluster (a) — DOM geometry race

`queueMicrotask` in `scrollToActivation` + `measureOverflow` flushed
BEFORE the browser's layout pass — `listRef.scrollHeight` read stale
geometry right after a channel switch (Solid had committed the
`<For>` rows but box-heights weren't in `scrollHeight` yet), so
`scrollTop = scrollHeight` landed ~66px short; vjt dogfood-confirmed.
Plan said double-rAF at two sites; reality: a third site
(length-effect tail-snap) needed it too, and even rAF×2 lost the race
against the scrollback STORE reload on the channel-back path. Final:
`lastElementChild.scrollIntoView({block: "end"})` — the browser walks
the actual DOM element, layout-aware even mid-store-update;
scrollHeight math only as the empty-scrollback fallback.

The sentinel was STILL wrong after the fix: seed expansion made
unreads non-deterministic at login, and cic's C7.3 contract CENTERS
the viewport on the unread marker when unreads exist — correct UX;
the spec assumed unconditional bottom-anchor. Rewritten
marker-tolerant: PASS when bottom-anchored OR (marker present AND
scrollTop > 0); the pinned failure mode is "stuck at scrollTop=0".

### Sub-cluster (b) — scroll-settle cursor write

Added scroll-settle as a third cursor trigger (alongside focus-leave
+ browser-blur): when the operator stops scrolling mid-channel, POST
the last-fully-visible row id.

- **Forward-only client gate** (`setCursorIfAdvances/3`): POST only
  if candidate > current cursor. The server supports backward moves
  via last-write-wins (`ReadCursor.set/4` docstring) but cic
  deliberately doesn't exercise them — no "reset unread on scroll-up"
  UX.
- **500ms debounce** in `ScrollbackPane.onScroll` collapses iOS
  momentum-scroll inertia into one POST; timer cleared on every
  scroll; `onCleanup` drops in-flight timers so a channel switch
  can't fire a stale settle for the previous window.
- **`lastFullyVisibleRowId(listRef)`** walks `.scrollback-line`
  children for the highest `data-msg-id` whose bottom edge is
  at-or-above viewport bottom (O(200), sub-ms). Requires
  `data-msg-id` on ScrollbackLine (test-seam, no behavior change).
- **No server change** — the controller, wire contract, and
  `ReadCursor.set/4` were already last-write-wins-tolerant; three
  triggers feed one endpoint.

E2E (`scroll-settle-cursor.spec.ts`): 3 scenarios; the forward-only
invariant (scroll-up does NOT retreat cursor) is the load-bearing
assertion.

Cic-only cluster — HOT deploys + bundle rebuilds; plan deviations in
commit bodies per `feedback_plan_vs_production_reality`. Next per
locked roadmap: wireTypes.ts codegen, then bastille (#8).

## 2026-05-24 — wireTypes.ts codegen cluster CLOSED

4-bucket cluster closing the cic↔server boundary drift surface
STRUCTURALLY — drift between server `Grappa.*.Wire` typespecs and
hand-rolled `api.ts` types was the root cause of 9 REV findings (C1,
C2, H1-H4, H6, M19, M20).

### Architecture

`Mix.Tasks.Grappa.GenWireTypes` walks `lib/grappa/**/wire.ex`, parses
`@type` via `Code.Typespec.fetch_types/1`, emits ONE deterministic
`cicchetto/src/lib/wireTypes.ts`, committed to git. Two CI gates
protect the contract:

1. `mix grappa.gen_wire_types --check` in `scripts/check.sh` —
   typespec ↔ committed-file drift (bucket D).
2. `wireTypesAssert.ts` `Equal<A, B>` type-level asserts — generated
   ↔ api.ts hand-roll drift, fails `bun run check` (bucket C).

Either gate fires on a single side drifting.

### Buckets

- **A** (`569dc41`): session.ex sweep — 17 `kind: String.t()` → atom
  literals; constructors flipped in lockstep (plan kept them strings;
  Dialyzer caught the success-type mismatch).
- **B** (`d2fcf3f`): mix task + generated file + 24-test suite.
  Deviations: WRITABLE_CIC=1 escape hatch (cic `:ro` mount);
  fully-qualified TS naming (collisions on bare `T`/`Event`);
  transitive external-type resolution via fixpoint iteration with a
  depth-limit-8 cycle guard; biome-compatible output.
- **C** (`d001282`): one assert today (`ConnectionState`, closes H2).
  Full api.ts re-export migration deferred — high-risk,
  low-incremental-value since the assert already catches drift at
  compile time.
- **D** (`330e7d4`): check.sh gate; negative test confirmed exit 1.

Deferred: C1/H1/H3-H6/M19/M20 each need a one-line server typespec
tightening + assert add (follow-up buckets); wholesale api.ts
deletion likewise — the asserts already prevent NEW drift.

### Lessons

- Every bucket had plan-vs-production deviations; each recorded in
  the commit body, none needed vjt mid-flight.
- The AdminEventsTest registry flake recurred from a docs-only commit
  too — pre-existing chronic isolation flake, not cluster-introduced.
- HOT deploy corrupted `_build/prod` on bucket A
  (`feedback_hot_deploy_corrupts_build_prod`); force-cold recovered.

---

## 2026-05-24 — BUGHUNT-1 pre-bastille bug-hunt CLOSED

Two user-visible regressions vjt flagged during UX-8 dogfooding,
closed BEFORE bastille so the new prod runtime doesn't inherit them.
Spec at `docs/superpowers/specs/2026-05-24-bughunt-1-design.md`.

### Bucket A — server-side PRIVMSG auto-split

`Grappa.IRC.LineSplit.split_privmsg_body/3` — new pure module
splitting a PRIVMSG body into fragments fitting the wire budget
(`linelen - byte_size("PRIVMSG <target> :\r\n")`). UTF-8-safe
(grapheme boundaries); CTCP ACTION envelope preserved on EVERY
fragment (a naive split emits garbage envelopes); a single oversize
grapheme is emitted as its own best-effort fragment.

Wired via `persist_and_send_fragments/4`: each fragment is its own
`Scrollback.persist_event` + per-channel broadcast +
`IRC.Client.send_privmsg` — matching what other channel members see
(upstream relays each PRIVMSG as a separate row). The HTTP reply
returns the LAST fragment so cic aligns with the final row id.

`Session.Server` gains `:linelen` state (default 512 per RFC 2812;
overridden by `005 RPL_ISUPPORT LINELEN=<N>`, same defensive
garbage-keeps-prior shape as `MODES=N`). State-shape change forces
COLD via `long_lived_modules.ex`.

**Why server-side, not cic**: per CLAUDE.md "one parser, on the
server" + "IRC is bytes; the web is UTF-8" — payload framing belongs
to grappa; cic would need the upstream's LINELEN + envelope shape,
which it doesn't have by design. Out of scope: TOPIC/NOTICE/AWAY
split (single-line verbs, no sighting); `MAXTARGETS` comma-split
(different bug class).

### Bucket B — cic mobile Archive seed-on-open

`ArchiveModal.tsx` opened without ever calling `loadArchive(slug)` —
the only caller was the desktop Sidebar `<details>` onToggle, which
mobile operators never reach. First open showed "no archived windows"
until an `archive_changed` refetch masked the bug. Fix:
edge-triggered `createEffect` in the modal (`lastSeededSlug` guard
prevents re-load on every reactivity tick; same-slug re-open after
close re-fires per archive.ts refresh semantics).
**Mount-component-owns-state**: the modal seeds itself so future
surfaces (deep-link, push) don't each need to remember the load step.

### Process notes

- Plan-vs-production deviations on every bucket (Boundary `exports:`
  needed `LineSplit`; Dialyzer rejected the `pid() | nil` supertype;
  e2e selectors moved). Recorded in commit bodies.
- **Preflight gap recurrence**: `deploy.sh` mis-classified bucket A
  as HOT despite the state-shape change — the AST oracle
  (`scripts/_extract_state_block.awk`) should have caught the
  field-addition but didn't fire. Audit owed
  (`feedback_deploy_sh_preflight_field_addition_gap`).
- Hot-deploy on a state-shape change corrupts `_build/prod`; recovery
  is in-container `rm -rf _build/prod` + `--force-cold`
  (`feedback_hot_deploy_corrupts_build_prod`).
- CI flake on bucket A (2 cic specs) re-observed green in bucket B's
  identical-code run — classified flake per
  `feedback_recurring_e2e_not_flake`.

## 2026-05-24 — BUGHUNT-2 unread-marker cursor-write contract CLOSED

Same-night follow-up: opening a window with unreads flashed the
marker ~500ms then it vanished — UX-8(a3)'s activation
`scrollIntoView` + UX-8(b)'s 500ms settle debounce combined to POST
the tail on bare window open, advancing the cursor past the marker.
Worse, the broader contract was incoherent: window-switch +
browser-blur wrote store-tail regardless of scroll position, so
scrolling up to read history then switching away lost the marker
entirely.

### Contract rewrite (vjt, 2026-05-24)

- Window open / activate: **no cursor write**.
- Switch away (cic→cic): `lastFullyVisibleRowId` of the LEAVING pane,
  measured BEFORE the activation routine touches listRef geometry.
- Scroll-settle: visible-row id, debounced 500ms, **gated on a recent
  operator input event**.
- Browser blur: visible-row id of the focused pane.
- Send: out of scope (narrow hole:
  send-while-scrolled-up-then-close-tab).

Cursor-write ownership moved from `selection.ts` →
`ScrollbackPane.tsx` — the pane owns its DOM geometry (spec:
docs/superpowers/specs/2026-05-24-bughunt-2-cursor-design.md).
Shipped as a1…a7 micro-commits (input-event gate, settle arm, leave
arm, unmount + blur arms, selection.ts deletion, test fixes) + b0…b5
e2e/vitest sentinels; final `1159867`.

### Bucket A gap caught by B1 — the wheel event

`onPointerDown` does NOT cover desktop mouse-wheel rotation: per W3C
the `wheel` event is a real user input but fires no preceding
`pointerdown`. Without an `onWheel` handler the gate stayed null and
desktop wheel scrolling never advanced the cursor (the A1 inline
comment claiming otherwise was factually wrong). B1's sentinel (real
`page.mouse.wheel`) caught it immediately — fixed as b0 BEFORE B1
landed. Rule: "real user input" detection must enumerate the full set
— pointerdown, wheel, touchmove, keydown (touchmove covers iOS
pointerdown unreliability). Candidate memory
`feedback_dom_input_event_complete_set` if a third bucket trips.

### Material plan deviations

- `selectChannel(":home")` semantics didn't exist (waits for a
  self-JOIN that never arrives for Home) — plain exact role-button
  click.
- Playwright `mouse.wheel` emits no pointerdown (above).
- Stack persistence across specs invalidates exact-equality cursor
  assertions: the forward-only gate (cic) + `ReadCursor.set/4`
  (server) drop candidates <= current, so sentinels assert
  `max(prior, visible)` shapes; the load-bearing claims are
  `cursor != store-tail` and `cursor > visibleAtMidList`.
- B2.5: the leave-arm POST races the settle POST from the same
  gesture — wait past the settle window before snapshotting
  baselines.
- B5: `lastFullyVisibleRowId` is module-local and returns null in
  jsdom — negative-only unit test; the scrollback mock needed
  `loadMore` exported or vitest flags an unhandled post-run error.

All gates green (2455 server tests, 1641 vitest, e2e sentinels 3/3 +
3/3). Deploy HOT + cic bundle broadcast; healthcheck ok.

### Lessons captured

- Plan vs production reality fires on EVERY bucket (recurrence from
  BUGHUNT-1); every deviation in a commit body.
- **Sentinel-first development catches contract gaps** — B1's first
  run surfaced the missing onWheel handler that would otherwise have
  shipped as a silent prod regression. "Sentinel passes on first run"
  per `feedback_recurring_e2e_not_flake` was the right halt
  criterion.

---

## Spec audit cluster (2026-05-26)

vjt mandate post-BUGHUNT-3: "in depth review of all specs ... drop
the ones that make no sense such as testing internals and keep all
the ones that test actual user behaviour ... lets make them robust
and faster." 109 Playwright specs scored by 5 parallel agents
(REDUNDANCY / INTERNALS / ASSERTION STRENGTH / SPEED / ROBUSTNESS /
SCOPE); vjt sign-off gated every hard-to-reverse move.

Shipped over 9 commits + cascade-fix:

- **EZ** — 4 strict-subset CONSOLIDATEs (`cp15-b4` → `cp15-b6-PAR`,
  `i2` → `ux-6-b-embedded-upload`, `ios-3` + `ios-4` → `ios-z`).
  −4 spec files, −286 lines.
- **R1** — cursor cluster 4 → 1 parametrized
  `cursor-forward-only.spec.ts` (656 → 407 lines); one assertion
  strengthened (a disjunction was swallowing out-of-band cursor
  jumps).
- **R3** — `ux-z` parity-theatre CLASSES loop (`continue`d 2/3 with
  no side effects) dropped.
- **R5** — `cp13-server-window` unbundled: S5 (compose-driven 401
  routing) + S10 (mIRC bold renderer) extracted to own files.
- **R6** — 4 hardcoded `waitForTimeout(500-2000ms)` → event-driven
  gates.
- **R7** — 4 weak assertions strengthened (named-field over
  `\d+`-regex, branch precondition over SOFT-check, kind=notice over
  kind-agnostic, boundingBox over text-only).
- **Rename batch** — 19 spec filenames got descriptive suffixes;
  cluster IDs preserved for chronological checkpoint backtrace.

Skipped per vjt call: R2 (mobile CSS-shape consolidation — "keep
these alone") + R4 (webkit-iphone-15 CI matrix extension — "ship
SEPARATELY first").

### Cascade root-cause discovery (the real prize)

Mid-audit, CI cascaded 10/11 in `Grappa.AdminEventsTest`
(`SessionRegistry never drained`), unreproducible locally. Traced
back to PROD code: `Grappa.Session.stop_session/2` on
`@stop_down_timeout_ms` (5s) expiry Logger.error'd + demonitored +
returned `:ok` WITHOUT killing the pid. A visitor test's stop got
`:ok` while the Session.Server lived on in reconnect-backoff; the
zombie poisoned SessionRegistry for the next singleton-lane test.
Local repro impossible — faster cores always get the `:DOWN` within
budget.

Fix (`6980dc8`): on timeout escalate `Process.exit(pid, :kill)`
(unmaskable — bypasses `terminate/2`), then re-wait for the kill's
`:DOWN`. Post-condition is now "process WILL be dead". Memory:
`feedback_session_stop_must_force_kill.md`.

Lessons:

- **CI is a fuzzer for prod GenServer teardown latency.** The faster
  the dev machine, the harder the repro. When CI cascades on a
  singleton-lane test doing Registry-draining setup, suspect an
  upstream "best-effort" cleanup that demonitored without killing.
- **"No silent-swallow at boundaries" applies to demonitor too** — a
  function that promises to stop a process and returns `:ok` without
  proving it dead is a silent-swallow shape, even if it logs.
- The audit was scoped to spec robustness; it surfaced a latent prod
  lifecycle bug weeks of folklore hadn't pinned.

## 2026-05-26 — admin polish + X-Forwarded-For with peer-loopback bypass

Pre-bastille polish: five vjt-flagged admin-panel issues; buckets A-D
+ follow-up F shipped. Planned manage-cluster E (admin-UI
create/delete for networks/users/creds) scrapped — `bin/grappa *`
already covers the operator path.

### Trusted-proxy + the `RemoteIpFromProxy` wrapper

`conn.remote_ip` behind the reverse proxy was the docker-bridge nginx
IP — `visitors.ip` audit + captcha verify saw nginx, not the client.
Added `{:remote_ip, "~> 1.2"}` (mature, pure Plug);
`GrappaWeb.Plugs.RemoteIpFromProxy` wired between `Plug.RequestId`
and `Plug.Telemetry`. The default reserved-range list already covers
RFC1918 + docker bridge → no CIDR allowlist needed for the single-hop
nginx→Phoenix topology.

**The peer-loopback bypass is the security half.** Bare `RemoteIp`
only inspects the X-F-F chain — so
`docker exec grappa curl -H "X-Forwarded-For: 127.0.0.1" …/admin/reload`
would rewrite `conn.remote_ip` to loopback and pass
`Plugs.LoopbackOnly`. The fix CANNOT live in RemoteIp config — its
`:clients` option means the OPPOSITE of what the name suggests (it
forces an IP inside the header chain to be treated as terminal, not
"trust this peer's headers"). Tests caught the misconfig pre-commit.
Wrapper:

```elixir
def call(%Plug.Conn{remote_ip: {127, _, _, _}} = conn, _), do: conn
def call(%Plug.Conn{remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}} = conn, _), do: conn
def call(%Plug.Conn{} = conn, opts), do: RemoteIp.call(conn, opts)
```

Loopback peer → skip the rewrite entirely; anything else (including
docker bridge) → delegate. IPv4-mapped `::ffff:127.0.0.1` is
intentionally NOT bypassed — per RFC 4291 it's IPv4-in-IPv6
transport, not loopback, and Bandit surfaces it as
`{0, 0, 0, 0, 0, 0xffff, hi, lo}` which doesn't match. End-to-end
tests assert both the nginx path (peer 172.x, X-F-F honored) and the
container-shell spoof (peer loopback, X-F-F ignored); LoopbackOnly's
moduledoc cross-references the coupling.

**Rule for future Plug wrappers:** if a downstream gate keys on a
conn field a parser-style plug rewrites upstream, the rewrite plug's
config alone is rarely enough — the peer-context behavior often lives
one layer up. Test the end-to-end gate, not the rewriter in
isolation.

### Visitor IP staleness — refresh-on-relogin

`visitors.ip` was set only at row creation; long-lived
NickServ-identified visitors (V7, `expires_at: nil`) froze on their
birth IP. Added `maybe_refresh_ip/2` in
`find_or_provision_anon/3`, three heads: same ip → no-op; nil
incoming ip → no-op (refresh is "fresher value," never "forget" —
protects mix-task paths with no remote_ip); different non-nil →
update. The bearer-token resume path does NOT trigger it — only
explicit logout/login.

### `subject_label` pre-join + orphan-pid honesty signal

`/admin/sessions` labels resolved via controller-side batch lookup
(`get_users_by_ids/1` + `Visitors.get_by_ids/1`, one query per
subject_kind); composition site is the controller because
`LiveIntrospection`'s boundary excludes Accounts/Visitors (pure
live-state). `subject_label: nil` is the gemello of U-0's
`live_state: null` honesty signal: pid exists, DB row doesn't (orphan
pid — raw delete, terminate race, ghost-session class). Cic renders
`<kind> <uuid8> (no DB row)` so operators see the divergence without
remsh.

### Push.SenderTest flake near-miss

check.sh showed 1 failure; initial 5-run iso said worktree-only. Per
`feedback_bisect_sample_size_required` ran 8× both sides: 1-5/8 fail
BOTH. Pre-existing wallclock-dependent flake (req 0.5.18 surface,
documented in sender.ex) — not a regression. Single-sample iso
bisects on a flaky test mis-attribute; 6 extra runs (~3 min) beat
hours of phantom-regression hunt.

## 2026-05-27 — bastille deploy SHIPPED + log routing under runtime/

### Bastille deploy SHIPPED

Native Elixir release (`mix release --overwrite`) in a FreeBSD
bastille jail on m42 (10.66.6.7 + 6 IPv6 addresses for the outbound
rotation pool); irc.sniffo.org / irc.sindro.me live; Docker prod
replaced. Tooling under `infra/freebsd/` (deploy.sh, jail_*.sh,
ndp_keepalive.sh, rc.d/grappa, rc.d/grappa_ndp_keepalive,
grappa.env.example).

Operator workflow:

```
sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh
```

git pull --ff-only → deps.get --only prod → compile
--warnings-as-errors → mix release --overwrite → cic bundle build →
`Grappa.Release.migrate()` → `service grappa restart` with
**epmd-kill between stop + start** (old BEAM doesn't shut down epmd;
next start fails `name grappa@grappa in use`) → /healthz poll. No
hot-reload — releases swap the BEAM wholesale; sessions reset on
every deploy. (`bastille_deploy_pipeline_hardened` memory.)

### Log routing under runtime/

First pass (over-engineered, reverted): an Elixir-side
`:logger_std_h` file sink PLUS the run_erl stdout tee — same lines on
disk twice, two rotation sets. Kept the OTP-canonical sink only
(run_erl tee in releases; Docker json-file driver in dev compose).

Two bugs from the first pass earned fixes that survived the revert:

1. **Relative `runtime/log` crashed prod** — `mix release` CWD is
   `_build/.../rel/grappa/`, not the repo root, so
   `File.mkdir_p!("runtime/log")` raised `:eacces` under the grappa
   user. `config/runtime.exs` now derives all on-disk defaults from
   `Path.dirname(database_path)` (already absolute). Footgun exists
   only in release builds — dev `mix phx.server` hides it behind a
   sensible CWD.
2. **`RELEASE_TMP='…' . envfile && cmd` doesn't persist** — POSIX
   `VAR=val cmd` binds only for the single `cmd`; when cmd is `.`
   (source) the binding dies with it (confirmed via `procstat -e`).
   Fixed with a separate `export RELEASE_TMP='…';` statement in
   `rc.d/grappa`'s `grappa_runas/1`.

Second pass (final): `RELEASE_TMP=runtime` — NOT `runtime/log`,
because run_erl ALWAYS creates its own `log/` + `pipe/` subdirs under
RELEASE_TMP (the nested value produced `runtime/log/log/`). Final
layout:

```
runtime/
├── log/erlang.log.*          ← run_erl tee of BEAM stdout
├── pipe/erlang.pipe.1.{r,w}  ← run_erl named pipe (bin/grappa remote)
├── grappa_prod.db (+ -shm + -wal)
├── uploads/  bun-cache/  cicchetto-dist/
```

rc.d declares `pidfile=$grappa_runtime_tmp/pid` but `service grappa
status` delegates to `bin/grappa pid` (epmd query) — the file is
unused.

### CI flake side-fix

`admin_events_test.exs` setup flunked 10 consecutive times on GHA
(`feedback_ci_cascade_rotating_set` pattern — green locally, fails
under coveralls load): `Session.stop_session/2` returns once the
worker pid is dead but the Registry's OWN monitor-DOWN cleanup runs
asynchronously; the 50ms post-force-stop sleep was too tight on a
loaded runner. Replaced with the 200×10ms (2s) poll.

### Lessons

- `mix release` and `mix phx.server` are NOT interchangeable boot
  paths for on-disk defaults — a relative mkdir_p silently works in
  dev and `:eacces`-crashes in a prod release. Derive from
  already-absolute env-driven paths.
- Two parallel log sinks for one stream is always a smell — pick the
  OTP-canonical one (run_erl tee in releases, Docker logs in
  containers) and drop the other.
- `VAR=val cmd` POSIX assignment is per-command; when `cmd` is `.`
  (source), the assignment dies with the source. Use `export VAR;`
  when the binding must survive to a later command.

---
## 2026-05-27 — post-bastille runtime fixes: visitor rejoin, zombie respawn gate, VAPID-as-state

Three production-discovered classes, all cold-deployed to m42 same day.

### Visitor channels rejoin: schema-parity with users

Visitor sessions respawned but joined ZERO channels (users fine):
`Visitors.list_autojoin_channels/1` read a `visitor_channels` table with
no writer, and `Session.Server.persist_last_joined/4` silently no-op'd
visitor subjects. Fix: migration `20260527123810` adds
`visitors.last_joined_channels` (JSON array, same shape as
`network_credentials.last_joined_channels`), DROPs `visitor_channels`;
`Visitors.SessionPlan.build_plan/3` wires the canonical
`last_joined_persister` closure.

**Apply rule:** when `{:user, _}` and `{:visitor, _}` share an
architectural verb (autojoin persistence, scrollback, read cursor), they
MUST share a code path. A discriminant `case` on subject_kind inside the
verb is a boundary violation — one class silently degrades while the
other keeps working.

### `Session.Server.init/1` subject-row-present gate

Incident: a visitor pid alive with NO `visitors` row, undeletable,
backoff at 25 min. Cause: `Session.Server` is `:transient` under
DynamicSupervisor; a crash (typ. 433 nick-in-use) schedules a restart,
and operator `DELETE /admin/sessions/:id` → `Session.stop_session/2`
races the restart window (`whereis → nil` between pids, returns `:ok`),
then the new pid registers with cached `init_opts` referencing a deleted
DB row — loops at backoff forever. Same mechanism poisoned the CI
singleton-lane `AdminEventsTest`.

Fix: `init/1` consults an optional `subject_row_present?` closure;
`false` → `:ignore` (NORMAL-shutdown signal to `:transient`, so the
supervisor drops the child PERMANENTLY). Both SessionPlans supply it.
Spawn chain: `SpawnOrchestrator` gains `{:ok, :ignored}`;
`Bootstrap.Result` counts `subject_row_gone`; `NetworksController` maps
`:ignored` → `{:error, :not_found}`; `Visitors.Login` →
`:upstream_unreachable`.

**Apply rule:** any `:transient` GenServer whose `init/1` depends on DB
state MUST verify that state at init — never trust cached `init_opts`
across restarts. The restart is a fresh process; treat it as one.

### VAPID keys are state, not deployment config

Post-bastille, push failed (FCM 403 / Apple 400) on every subscription:
the jail got a FRESH keypair from `mix grappa.gen_vapid`, but
`push_subscriptions` rows were firmed against the Docker prod keypair —
push services reject deliveries whose VAPID JWT is signed by a different
key than the subscription was created against. Fix: copied the Docker
keypair into the jail env.

**Apply rule:** the VAPID keypair is application STATE (alongside
`GRAPPA_ENCRYPTION_KEY`, `SECRET_KEY_BASE`, `RELEASE_COOKIE`), not
per-host config; cross-substrate migration copies it verbatim.
`mix grappa.gen_vapid` is first-install-only — running it against an
existing DB invalidates every push subscription with no recovery short
of forcing every user to re-subscribe.

## 2026-05-27 — `refresh_plan` closure ends the zombie-respawn-with-stale-state class

Azzurra incident: visitor boots as `kazam02`, `/NICK kazamobile` + two
joins (both persisted), upstream `:ssl_closed` → crash → `:transient`
restart replays the CACHED `init_opts` (old nick, autojoin=[]). DB and
live state diverge; empty sidebar. Root cause:
`DynamicSupervisor.start_child/2` caches the child spec at spawn;
restarts never re-read the DB — the documented Phase 1 punt.

Fix: generalize `subject_row_present?` into `refresh_plan`:

```elixir
# Was: (-> boolean())                        — "is the row still here?"
# Now: (-> {:ok, plan} | {:error, :not_found})
```

`init/1` runs it on EVERY init (boot AND restart). `{:ok, fresh}` →
`Map.merge(opts, fresh)` — DB values win on shared keys (`:nick`,
`:autojoin_channels`, `:password`, `:host`, `:port`, `:tls`), opts-only
keys (`:network_id`, `:notify_pid`, test fixtures) survive.
`{:error, :not_found}` → `:ignore` (same drop, one mechanism). The
closure re-fetches the row and re-invokes `resolve/1`, so `pick_server!`,
Cloak decryption, and `merge_autojoin` see current data.

Why not a manual `Session.refresh/2` verb: the zombie sits until an
operator notices. The closure rides the supervisor's existing restart
trigger — recovery is automatic on the next crash cycle.

**Apply rule:** per-session state derived from DB rows flows through
`refresh_plan` — never bake it into the child spec at spawn. Producers
own resolution; Session.Server consumes opaque closures.

---

## 2026-05-31 — admin panel CRUD cluster CLOSED

Closes the gap where mix tasks were the ONLY mutation surface — admin
REST was read-only-plus-narrow-PATCH. Six buckets, all hot deploys, no
migration; mix tasks retained for scripting, REST shares the same context
functions. (`delete_network/1` refuses `:credentials_present` /
`:scrollback_present`; user delete cascades sessions + scrollback +
credentials atomically; credentials CRUD carries wire field
`session_action:`; 11 AdminEvents.Wire constructors gated by
`validate_admin_actor/2`, cic mirrors with `assertNever`-enforced 4-way
parity.)

Design decisions with durable WHY (rest of A-1..A-9 are mechanical):

- **A-2 (credential update lifecycle):** password / auth_method change on
  a live session → `Session.stop_session/2` (operator re-`/connect`s); a
  `nick` change leaves the session alone and returns
  `session_restart_required: true` (rename is `/nick`-routed, not
  credential-routed); cosmetic edits leave it silently.
- **A-4 (last-admin invariant):** refuse demoting/deleting the SOLE admin
  (`{:error, :last_admin}` → 422) — else the deployment locks itself out.
  Self-demotion fine when another admin exists. The guard counts other
  admins BEFORE the update; SQLite's single-writer serializes the
  demote-the-last-two race — Postgres would need an advisory lock (caveat
  in the `update_admin_flags/2` moduledoc).
- **A-5 (network delete):** 409 when credentials bound; no `?force=true`
  cascade (a footgun).

Deploy batching: B1-B4 deploy independently (backwards-compatible); B5+B6
ship together (UI needs B4 events). The cic bundle rolls back
independently of the BEAM release (`scripts/deploy-cic.sh` decoupled) —
the two-deploy cadence keeps rollback granularity at the
server-vs-client seam.

---

## 2026-05-31 — Visitor session sharing via one-time link

Multi-device for anonymous users: second device + same nick previously
409'd `anon_collision` (`(nick, network_slug)` unique). Visitors have no
password, so the link IS the auth. Model: SHARING, not transfer — device
A mints a signed token, device B redeems, both hold distinct
`accounts_sessions` rows pointing at the SAME `visitors.id`; A's bearer
stays alive.

Token storage: **Phoenix.Token + supervised ETS one-shot set**
(`Grappa.Visitors.ShareTokens` owns `:visitor_share_tokens_used`; boots
before Endpoint with the other ETS singletons so consume can't race a
missing table). ETS over DB because the threat model is benign, TTL is
10 min, and losing the consumed-set on restart opens at most a
TTL-bounded reuse window for already-signed tokens. DB-backed hardening
is a mechanical migration if the threat model shifts.

Endpoints: `POST /me/share-token` (`:authn`, visitor-only, user → 403;
returns `{token, expires_at}`; `Phoenix.Token.sign(endpoint,
"visitor-share-v1", visitor.id)`, `max_age: 600`) and
`POST /auth/share/consume` (UNAUTHENTICATED — the token is the
credential): verify → 401 bad sig / 410 `share_token_expired`; atomic
`:ets.insert_new/2` → 410 `share_token_consumed` on collision; visitor
reaped → 404; then `Accounts.create_session` mints a fresh bearer. The
two 410 atoms split deliberately — cic copy + telemetry must tell them
apart; lifted at the controller boundary so the ETS module's
`{:error, :already_consumed}` stays oblivious to HTTP wire strings.

cic: visitor-only share button; modal mints per open (re-open orphans the
previous URL — acceptable vs silently invalidating a clipboard URL). SPA
route `/share/:token`; auto-consume on mount, `installSharedSession()`
writes token+subject (symmetric with `login()`), navigates to `/`.

Multi-device WS fan-out is automatic: both bearers resolve to the same
visitor row → same `user_name = "visitor:<id>"` → same PubSub topics;
channel join authz passes both sockets. No channel-auth changes.

Out of scope: no rate limit beyond the global baseline (verify is
HMAC-only — invalid tokens do zero DB work); no "list active tokens"
admin surface (the signed-token-only design can't enumerate — needing it
is the signal to go DB-backed); no mint/consume broadcast (shared
scrollback IS the signal).

**HOT-vs-COLD (load-bearing):** zero migrations, but the NEW supervised
child is the classic HOT-deploy footgun: `Phoenix.CodeReloader.reload!/1`
recompiles but never re-runs `Application.start/2`, so a newly-added
child is NOT spawned on hot reload — first consume would crash on the
missing ETS table. This diff class requires `--force-cold` despite
passing the deploy.sh preflight (which checks schema/@type patterns, not
supervision-tree shape).

## 2026-06-02 — Scrollback scroll paths are INSTANT, never `behavior:"smooth"`

The `[data-testid="scrollback"]` div is the SAME DOM node across
`selectedChannel` changes (Shell.tsx non-keyed `<Match>`, required for
the BUGHUNT-2 leave-arm cursor write). Anything ASYNC on that node
survives a window swap and races the next window's `scrollToActivation`
snap. `scrollToBottom` (C7.4 button) used `scrollTo({behavior:"smooth"})`
— the animation outlives the tap; on real iOS Safari (momentum) it failed
to reconcile with the return snap → blank pane until manual scroll.

**Apply rule:** every scroll write in ScrollbackPane is INSTANT
(`scrollIntoView({block:"end"})` or `scrollTop = scrollHeight`), never
`behavior:"smooth"` — instant completes synchronously, so nothing is in
flight when content swaps. Do not reintroduce smooth scrolling on the
shared node.

NOT reproducible in Playwright (chromium OR webkit-iphone-15) — its
WebKit doesn't model real iOS scroll physics; verify scroll/touch fixes
on a real device (`feedback_playwright_webkit_not_ios_scroll`).

## 2026-06-03 — Fresh-channel open baselines the read cursor to the backlog tail (RC2)

Badges derive purely from the server-owned cursor (`unread_count` = rows
with `id > cursor`; nil = whole backlog). RC2 closes
`m2-irssi-to-chan-defocused`: a channel visited then DEFOCUSED before its
200-row REST backlog hydrated left the cursor nil → badge "201" instead
of "1". Fix (`loadInitialScrollback`): after merging the loaded page,
baseline the cursor to the page's MAX id when `getReadCursor === null`.
Two non-obvious constraints:

- **Tail comes from the loaded REST page, never the store-after-merge.**
  A live WS PRIVMSG can append during the load; a store-derived baseline
  would mark it read. The REST page and WS append are disjoint paths, so
  the page max excludes concurrent arrivals — they stay unread.
- **The baseline is load-bearing on "fresh open scrolls to the newest
  row."** Marking the whole backlog read is only honest because a fresh
  open auto-scrolls to bottom. If a future change lands a fresh open
  mid-history (jump-to-first-unread, deep-link), this over-marks —
  revisit both together; the cursor-honest invariant couples them.

Gated on `=== null` (not `sendMessage`'s forward-only gate) so an
existing read position survives re-open (the `── XX unread ──` marker
persists). Fires on load COMPLETION (beats the leave-race); fires only on
focus, so unfocused new DMs stay unmarked.

## 2026-06-03 — Per-server fixed outbound source address

Nullable `source_address` on `network_servers` pins the outbound TCP
source IP per server entry. Spec:
`docs/superpowers/specs/2026-06-03-per-server-source-address-design.md`.

**Why per-server:** source binding is a TCP-layer decision at connect
time against a specific host:port — not the network (groups alternatives)
nor the credential (auth identity). Two entries for one network can pin
different IPs or mix pinned/pool-delegated.

**Validation:** strict literal IPv4/IPv6 only
(`:inet.parse_ipv4strict_address/1` / `parse_ipv6strict_address/1` —
reject hostnames, CIDRs, zero-padded octets, empty). Stored canonical via
`:inet.ntoa/1`. NULL = kernel default or the outbound IPv6 pool.

**Connect path — hard mismatch error, no silent fallback.** `IRC.Client`
derives the family from the literal and resolves the host via
`:inet.getaddr/2` in that family; mismatch →
`{:error, {:source_family_mismatch, source, host, family}}` through the
connect-fail throttle — loud, never a fallback to the unbound path. The
NULL-source pool path keeps `:inet_res.lookup/3` (pure DNS); the
fixed-source path deliberately uses `:inet.getaddr/2` — for a numeric
literal or /etc/hosts host, `:inet_res.lookup/3` returns [], which would
spuriously trip the mismatch guard every connect. Both paths share
`ifaddr:` on `:gen_tcp.connect/4`.

**Visitor-pool exclusion — subtract, never assert.**
`OutboundV6Pool.apply_exclusions/1`: effective pool = raw_pool −
fixed_sources (tuple-normalized, idempotent); Bootstrap collects all
configured sources and passes the reduced pool. Silent subtraction —
overlap excluded without noise, fixed-not-in-pool harmless. Computed ONCE
at boot: adding a pool-overlapping fixed source to a running node writes
the DB row but does not refresh the live pool — the IP leaves rotation on
the next restart (workflow: add-then-restart; the mix-task notice flags
the overlap).

Guarantee scope caveat: the exclusion protects the POOL only. The bind is
per-server, so ANY session via a pinned server row uses that IP — visitor
or user. Keeping visitors off dedicated-operator IPs is operator
configuration responsibility (point visitor provisioning at networks with
no `source_address`).

Config: `mix grappa.add_server --source <ip>` / `bind_network --source
<ip>`, same changeset, invalid input halts loudly; informational notice
on pool overlap.

## 2026-06-04 — Prod deployment: vjt on a dedicated source (`::42`)

First prod use of `source_address`: vjt's outbound IRC from
`2a03:4000:2:33c::42` (rDNS `m42.openssl.it`), visitors keep rotating the
pool. Runbook in `docs/OPERATIONS.md` (m42 section); decisions here.

**Why a second network row (`azzurra-vjt`):** `source_address` is
per-server and `pick_server!/1` picks ONE server per network — vjt and
visitors on one row can't get different sources. Visitors are
compile-pinned to `:visitor_network = "azzurra"`
(`Application.compile_env!`) — changing that needs a cold rebuild.
Cheaper: `azzurra-vjt` (same endpoint, `source_address=::42`), rebind
vjt, leave visitors on `azzurra`.

**Scrollback is per-subject, so the move is migratable:**
`messages`/`read_cursors`/`query_windows` keyed by `network_id` + subject
id; vjt's history re-keyed net 1 → 2 via `Repo.update_all` filtered on
`user_id`. Message ids stable across the re-key → cursor FKs survive.
Done live after `stop_session` quiesced.

**`unbind_credential/2` can't drop the last user on a network with
scrollback** — latent gap: it hits the cascade-on-empty path (no
user-credentials left → try delete network) and rolls back
`:scrollback_present` (visitor messages; `messages.network_id` FK
`:restrict`). A visitors-only network looks "userless" to the check.
Workaround: delete the credential row directly + `stop_session`.
(Candidate follow-up: count visitor presence in unbind, or a "detach
user, keep network" verb.)

**Sharing the host's primary IP into a shared-IP jail is safe** —
validated empirically: `jail(8)` only removes addresses it ADDED at jail
start; an address the host owned before the jail starts survives
teardown. rc.conf assigns `::42` at boot before bastille → the jail never
owns it. Added as `vtnet0|::42/64` — match host prefixlen; a `/128` would
collide with the host's on-link `/64` route.

**Incident:** `service grappa restart` aborted boot — `name grappa@grappa
… in use` (stopping node hadn't released the sname) — ~2 min outage until
a plain `start`. Lesson in OPERATIONS: prefer stop→verify-clean→start over
`restart` on this substrate. (Separately: a mid-session password rotation
left vjt's cic client looping on a dead token, tripping host fail2ban
`http-404` — looked like a hung BEAM, was an IP ban; see OPERATIONS
fail2ban note.)

## 2026-06-23 — shottino: click-to-preview media (text-only rule lifted, scoped)

vjt asked for image/video previews in `shottino` (C/ncurses client) —
intersecting CLAUDE.md's **"IRC stays text only"** rule. Per the rule's
own escape hatch, vjt explicitly authorized lifting it **for shottino
only**. Why the lift doesn't erode the invariant:

- **Scrollback stays text** — URLs remain clickable links; the preview is
  an explicit user-initiated modal (click → full-screen frame → any key
  dismisses). No autoplay, no on-arrival cards, no lightbox.
- **Nothing crosses the wire** — pure client-side affordance over the
  same typed JSON; no server surface or payload change; cic untouched.
- **No new client IRC parsing** — reuses existing `find_url` /
  `looks_like_image_url` heuristics.

Implementation: render via external tools, not vendored decoders —
`ffmpeg` fetches/decodes/extracts a frame to temp PNG (video uses the
`thumbnail` filter); `chafa` renders it, auto-detecting the terminal
graphics protocol (Kitty > iTerm2 > Sixel > symbols). Both optional
runtime deps probed on PATH; missing → fall back to `xdg-open`. Avoids
linking image libs + reimplementing an HTTP client (security surface).
Subprocesses via `fork`+`execvp` (argv array, no shell) so the URL can't
be injected. Click, not hover: shottino repaints every 50 ms — xterm-1003
hover-to-render fights the repaint and smears graphics. Trade-off
accepted: 1003 motion reporting suppresses native text selection while
shottino runs (Shift-drag still works in most terminals). Modal leaves
ncurses (`def_prog_mode`+`endwin`) so chafa sees a real tty, then restores
with a forced full repaint.

If a future cluster wants the same in cic, it does NOT inherit this lift
— cic's text-only scrollback rule stands until separately specified.

## 2026-06-08 — Unread-divider freeze contract (cic) + read-cursor cadence relocated here

Relocated from CLAUDE.md (over-specified there, gone stale). CLAUDE.md
keeps the durable invariant (read state server-owned per (subject,
network, channel); `last_read_message_id` FK; removing the server-side
cursor is breaking). Mechanics live here.

### Read-cursor write cadence (cic ↔ server)

cic HYDRATES the cursor from three sources: `/me` envelope at login,
per-channel Phoenix join reply (refresh on every rejoin/reconnect), and
live `read_cursor_set` WS events (cross-device sync). cic WRITES
forward-only (`setCursorIfAdvances` → POST → `Grappa.ReadCursor.set/4`,
last-write-wins) on settle events: scroll-settle (500ms debounce, gated
on recent operator input), focus-leave, browser-blur, and
send-in-focused-window. The server's `read_cursor_set` broadcast feeds
the new id back to BOTH originator and peers — single applier path.
Phase 6 exposes the same cursor as `+draft/read-marker` MARKREAD.

### The divider FREEZE contract (the actual decision)

Symptom (vjt): scrolling through an unread block yanked the "── N
unread ──" divider under your eyes — `rows()` read the LIVE cursor, so a
scroll-settle advance (or cross-device set) re-ran it mid-read.

Decision: the divider is FROZEN for the lifetime of a focus session,
derived from snapshot signal `markerCursorId` (frozen BOTTOM boundary),
sibling to `sessionTopId` (frozen TOP). The snapshot re-latches on focus
acquisition — channel-switch and visibility-return — AND on an own send
(see the 2026-06-09 send-relatch entry). Chose (b) "any step-away-and-back
advances it" over (a) "channel-switch only". Only the DISPLAY is frozen —
the live cursor keeps advancing + POSTing, so sidebar badges +
`selection.ts` counts stay current. PASSIVE advances (scroll-settle echo,
cross-device `read_cursor_set`) never re-latch: that IS the freeze.

Deliberate asymmetry on visibility-return: `sessionTopId` (top) is
PRESERVED — a brief blur is not "leaving the window", hidden-arrival
messages stay live-read, no fresh marker — while `markerCursorId`
(bottom) is RE-LATCHED so the divider settles where the cursor reached.

Why not suppress the broadcast instead (vjt asked): the echo keeps cic
mirroring server-owned state ("cic never originates state"). Killing it
breaks cross-device sync and re-focus advance — the originator's signal
goes stale until reload, freezing the divider PERMANENTLY. Freeze the
display, not the transport.

Cross-device tradeoff (accepted, vjt: "consistency"): cic cannot
distinguish an own scroll-settle echo from a peer's set at the applier
boundary (same wire bytes, no client_id tag), so the freeze is uniform —
a peer reading the window reflects on your next refocus. client_id
tagging (server + wire change) rejected as heavier than the problem.

REVISES the CP29 R-4 "Bug A" contract (divider vanished immediately on any
live advance). Implementation: `cicchetto/src/ScrollbackPane.tsx`.

## 2026-06-08 — Optimistic forward-only read-cursor advance

Two unread bugs, one root cause: (1) leaving a caught-up channel flashed a
sidebar badge for a frame; (2) an own-sent message sometimes rendered
above the divider after stepping away and back. The local cursor signal
was round-trip-only — advanced only on the server's `read_cursor_set`
echo. The POST→echo interval is a stale-cursor window, and two reactive
readers fire inside it: the focused-window badge suppression in
`perChannelUnread` (drops synchronously on `selectedChannel` flip) and the
`markerCursorId` re-latch on focus acquisition (reads the stale pre-send
cursor when a return beats the echo).

Fix: `setReadCursor` advances the local signal optimistically,
forward-only, before the POST — one place, every write path inherits it;
the advance lands in the same synchronous Solid flush as both readers.

Composes with the freeze contract, does not reverse it. The broadcast
stays — the server-owned source every device mirrors, the carrier for peer
sets, and the only path that moves the cursor backward (last-write-wins).
The originating device merely skips its own round-trip latency; the
display freeze is untouched (divider reads frozen `markerCursorId`, never
the live signal).

Tradeoff: a failed POST leaves the local cursor ahead of the server. NOT
reverted — a revert would clobber a concurrent forward advance (the race
forward-only exists to avoid). cic only writes ids it has already read, so
drift is bounded to already-read rows and re-aligns on the next forward
write or `/me` / join-reply hydration.

## 2026-06-08 — Multiline compose → one PRIVMSG per line

Drafts/pastes can hold embedded line breaks (Shift+Enter). Pre-fix the
whole body went as one PRIVMSG → server rejected `:invalid_line` (CR/LF
are IRC frame delimiters, forbidden inside a frame) → operator saw
"invalid", nothing sent.

A multiline body means one message per line. cic splits client-side:
`splitMessageLines` (`messageLines.ts`) splits on EVERY line-ending form
(CRLF, lone CR, LF) and drops blank lines (an empty PRIVMSG is itself
invalid). Shared `sendBodyLines` covers the three free-text send sites:
privmsg, /me (one ACTION per line), /msg.

Division of labor, deliberate: the CLIENT owns newline splitting (only it
knows the operator meant separate messages); the SERVER keeps owning
512-byte length splitting (`lib/grappa/irc/line_split.ex` — only it knows
per-target frame overhead). The server's `:invalid_line` guard stays as
the backstop that cic can never smuggle raw CR/LF onto the wire.

Accepted edges: (1) sends are sequential, non-transactional — a
mid-fan-out failure leaves earlier lines sent, surfaces the error with the
full draft preserved (retry re-sends delivered lines); IRC has no atomic
multi-send. (2) An empty `/me` sends nothing instead of a degenerate empty
ACTION.

## 2026-06-09 — Send-relatch: hide the in-pane unread marker on a focused send

vjt prod report: a divider that didn't disappear on sending in the focused
channel. NOT a regression — the freeze contract working as written:
re-latch happened only on focus acquisition, and a send is neither. Both
halves are vjt's: "don't move the divider while I read" (freeze) vs "hide
it when I send". Both can't be served by watching the cursor — a send and
a passive scroll-settle advance it through the same `setReadCursor`. The
send has to mark itself.

Decision: a focused own send re-latches the marker like a focus
acquisition. `sendMessage` publishes its channel-key on a new
`lastOwnSend` signal — the one fact not otherwise represented ("this
advance was a send"); `ScrollbackPane` runs the identical re-latch when
the key matches THIS pane. Keyed, so a `/msg` to another window can't
collapse this pane's divider; fired ONLY from the own-send path, so
passive advances never trigger it.

`lastOwnSend` is an EVENT signal (`equals: false`), not a state cell: two
sends to the same channel write the same key string, and `Object.is` dedup
would drop the second — the marker wouldn't re-hide after send → switch
away → peer messages → switch back → reply. Bare channel-key string (no
`{key,id}`): the effect re-latches to the LIVE `getReadCursor`, never the
send id.

Why a signal, not a derivation (vjt pushed): the this-device advances are
leave-arm, blur, scroll-settle, send — the first three are the PASSIVE
ones the freeze deliberately keeps frozen, so "did the cursor move" can't
tell a send apart. Deriving from an own-nick row at the tail would ALSO
fire on a cross-device own send (frozen by choice) and needs prev-tail
diffing.

REFINES the freeze entry (amended to list the own send as a third
re-latch trigger).

## 2026-06-09 — Own /me classified :action (issue #14) + full mIRC render

Issue #14 was triaged as a cic display gap; it wasn't. Root cause,
server-side and outbound-only:
`Session.Server.persist_and_send_fragments/4` (self-echo persist for OWN
sends) hardcoded `kind: :privmsg`, never checking the CTCP envelope. The
INBOUND path (`EventRouter.privmsg_default`) classified correctly all
along — the two halves had drifted, and M10's green masked it (M10
exercises the inbound function). Outbound is target-agnostic, so own `/me`
broke in channels AND queries.

The "is this a CTCP ACTION?" predicate existed as TWO inconsistent private
copies: `EventRouter.ctcp_action?/1` (lenient, prefix-only) and
`LineSplit.ctcp_action?/1` (required trailing `\x01` — so a leading-only
ACTION over the fragmentation budget took the NAIVE split path, "garbage
on the wire"). Collapsed onto `Grappa.IRC.CTCP.action?/1` (lenient —
CTCP's closing delimiter is optional), called from inbound classify,
outbound classify (the fix), and envelope-preserving split. Single source
for a wire-format question the Phase 6 listener facade will also ask.
`Scrollback.dm_peer/4` gets the real `kind` — `:action` is dm-eligible, so
own action-DMs thread their peer.

Division of labor: the SERVER classifies the kind (owns the wire); cic
renders by kind (owns the display). Raw `\x01` stays in the stored body
(round-trip fidelity); cic strips at render.

### Full mIRC inline formatting render (Part B)

`mircFormat.ts` extended from toggles + 16-color `\x03` to the full
de-facto set: `\x04` hex color (`\x04RRGGBB[,RRGGBB]`, bare/partial =
reset), `\x1e` strikethrough, `\x11` monospace, `\x03` extended palette
16-98, code 99 = explicit default.

Design move: COLOR RESOLUTION MOVED INTO THE PARSER. A Run previously
carried a palette index resolved in `renderRun`; `\x04` hex would have
forced a second color representation and pushed the palette into the
render layer. A Run now carries an already-resolved CSS color string in
`fg`/`bg` — `renderRun` is a dumb applier, the palette lives in the parser
(no leaky abstractions); everything resolves to `#rrggbb` before the DOM.

Underline + strikethrough both want `text-decoration` (one property, last
class wins) → a higher-specificity
`.scrollback-mirc-underline.scrollback-mirc-strikethrough` selector
composes them. Formatting composes with linkify + ACTION-strip — all
render-time-only transforms on a body whose raw bytes stay in scrollback.

## 2026-06-09 — cic build to zero warnings (vite 8 / rolldown)

`scripts/bun.sh run build` emitted three warnings. Two fixed at source,
the third deliberately left:

1. **`INEFFECTIVE_DYNAMIC_IMPORT`** — SettingsDrawer both statically
   imported `./lib/push` and `await import`ed it; a module already in the
   main chunk can't split out. Folded into the static import.
2. **`[PLUGIN_TIMINGS]`** — rolldown's `pluginTimings` fires only under
   host load: a non-deterministic perf advisory, poison for a
   zero-warnings gate. Disabled via
   `build.rollupOptions.checks.pluginTimings = false` (dev-only check;
   every correctness check stays on).
3. **`inlineDynamicImports option is deprecated`** — left as-is.
   `vite-plugin-pwa` (≤1.3.0) hardcodes the SW rollup output as
   `inlineDynamicImports: true`. The warning comes from rolldown's
   module-level consola logger — bypasses `onwarn`/`onLog` entirely
   (filter tried, dead) — and the plugin's `output` is a hardcoded literal;
   only patching the dep silences it. A `bun patch` WAS verified to zero
   it, then **dropped** because of the **bun ≠ npm toolchain split**: prod
   (m42 jail) has no bun and builds with npm via
   `infra/freebsd/jail_cic_build.sh`; npm ignores bun's
   `patchedDependencies` and, with no committed lockfile, resolves `^1.2.0`
   fresh. Making prod clean would need a SECOND patch mechanism — heavier
   than a cosmetic deprecation warrants. CI doesn't build cic at all
   (ci.yml is pure Elixir; see `feedback_cic_check_gate_masks_tsc`). Lifts
   when vite-plugin-pwa migrates to `codeSplitting`.

Sobelow's 8 Low-confidence Traversal findings (uploads.ex, reaper.ex,
version.ex — server-managed paths) left as-is: below the configured
`exit: "Medium"` gate.

### e2e full-suite reds: cp15-b6 + m6 `/msg` own-render (NOT a cascade)

Both specs passed 3/3 in isolation → first read "cascade". A bisect
disproved it (prefix runs green; projects don't interleave). Two distinct
causes:

**m6 — first read "genuine timing", SUPERSEDED.** The 5s→15s timeout bump
"fixed" it, but the row was ABSENT, not late — a real cic production bug
(own-send read-cursor poison, issue #50, next entry). The bump is kept as
harmless slow-Pi headroom but was never the fix.

**cp15-b6 — the DM-listener race; a bigger timeout never fixes it.**
`selectChannel` awaits the *channel* topic join, not the *own-nick* topic
join. `/msg` before the own-nick subscribe completes broadcasts to ZERO
subscribers → query window never opens. Exactly the race
`waitForDmListenerReady` exists to close (docstring cites ~20% suite
flake); 7 sibling DM specs call it — cp15-b6 was the lone omission. Fix:
the barrier after `selectChannel`, before the first `/msg`. Test bug only
— the bouncer persists + pushes correctly once a subscriber exists.

## 2026-06-09 — cic `/msg` to a new nick — own-send cursor poison (issue #50)

The m6 flake masked a real bug: `/msg <new-nick>` with no existing query
window could leave the fresh window stuck on "no messages yet" — the own
row never rendered until reload. Intermittent, surfaces under load.

**Root cause — own-send poisons the recovery cursor.** Three delivery
paths, all defeated for a brand-new window: (1) `loadInitialScrollback`
fires *before* the POST → empty page, marks load-once. (2) The live WS
append needs the `(slug, peer)` topic subscription, joined reactively
after the window appears in `queryWindowsByNetwork`; if the server
broadcasts first, Phoenix drops it (no replay for late subscribers). (3)
`refreshScrollback` (CP29 R-5 join-ok recovery) should backfill — but
`sendMessage` had already advanced the cursor to the just-sent row's own
id; `getResumeCursor` falls back to the read cursor when `lastSeenIdByKey`
is empty → fetches `?after=<own-id>` → empty → never recovered.

The read cursor lied: "read up to N" before N ever rendered. Every OTHER
writer only advances to a row that IS in the pane; `sendMessage` was the
lone path advancing past the rendered tail.

**Fix — gate the advance at its source, not at the recovery.** In
`sendMessage`, only advance when the pane already holds a rendered row
(`scrollbackByChannel()[key]?.length > 0`). Empty pane → cursor stays →
`getResumeCursor` null → refresh resumes from id 0 and recovers the send.
Established channels unaffected (`lastSeenIdByKey` shadows the read cursor
once anything rendered).

**Rejected the issue's own proposed fix** (clamp `cursor = 0` inside
`refreshScrollback` on empty pane): the channels loop joins EVERY channel
eagerly while `loadInitialScrollback` is focus-only, so an unfocused
channel with a `/me`-hydrated cursor R has an empty pane when its join-ok
refresh fires — the clamp would fetch `?after=0` (oldest 200, ASC),
pulling ancient history and leaving an unreachable gap on later focus. The
source-gate touches only the own-send path. (Spec inherited a bug;
"challenge the spec".)

Known narrow corner (accepted): device A `/msg`-opens a window device B has
focused with content → A's send no longer writes the cursor, so B's badge
drops a beat later instead of instantly. The pre-fix code "helped" B only
by poisoning A's recovery.

## 2026-06-09 — cic: split "log out" into "detach" vs "quit" (issue #43)

The single "log out" button was ambiguous about the bouncer:
`auth.logout()` revokes the bearer but never touches the IRC session — by
design, but it surprised the operator ("logged out", IRC kept filling
scrollback). Fix — two affordances for `getSubject()?.kind === "user"`:

- **`detach`** — today's `logout()` flow relabelled: bearer revoked, IRC
  session stays; reconnecting cic picks it back up.
- **`quit`** — destructive two-tap `InlineConfirmButton` wired to the
  PRE-EXISTING `quitAll(null)` composite (park every user network via
  `PATCH /networks/:id {connection_state:"parked"}`, then `logout()`).
  Parked persists across restart (Bootstrap skips `:parked`) — the correct
  "stays off until I reconnect" semantic.

Wiring, not new infra — `quitAll` already backed `/quit` and the visitor
sidebar ×; server unchanged. Visitors + the not-yet-loaded null subject
keep the single "log out": gating on `kind === "user"` (not
`!isVisitor()`) keeps the loading/null subject on the safe single button.

Disarm-on-close: the drawer stays mounted across open/close (CSS `.open`
toggle, not `<Show>`), so an armed `quit` would survive a close→reopen one
stray tap from killing the bouncer — `createEffect` disarms on every
close.

The Playwright spec deliberately does NOT fire the destructive confirm or
a real detach — vjt's seeded token + IRC session are shared suite-wide;
parking or revoking would cascade-fail downstream specs.

## 2026-06-09 — video + document uploads (uploads-2 cluster)

Upload pipeline generalizes image-only → image / video / document. Spec:
`docs/superpowers/specs/2026-06-09-video-doc-uploads-design.md`. Emoji
prefixes on the wire: 📸 / 🎬 / 📄 — IRC stays text only; the emoji is the
whole media-type signal.

**Per-type caps, no read-fallback.** `upload.per_file_cap_bytes` →
`upload.{image,video,document}_per_file_cap_bytes` (10/50/10 MiB) — a
50 MiB video ceiling must not gift 50 MiB to raw images. DML migration
renames the row; deliberately NO read-fallback on the old key, so a missed
migration surfaces as the compiled-in default, not a silent legacy read.

**Server MIME→category map** (`@mime_categories` in UploadsController):
video mp4/quicktime/webm; document pdf/txt/odt/ods/docx/xlsx (no
macro-enabled variants). Category derived per request, picks the cap,
NEVER stored — no schema change.

**cic: ImageHost → UploadHost.** `categoryOf()` (`uploadCategory.ts`) is a
1:1 ordered mirror of the server map — adding a MIME touches both files in
one commit. One orchestrator with a pre-upload transform hook (video →
transcode, else identity). The spec typed `maxFileSizeBytes` as a `Record`
— amended to a function of category after review caught a latent bug: the
embedded host's cap pre-check captured `serverSettings()` once at module
init while its comment claimed reactivity. A literal can't be reactive; the
function shape reads the signal at call time.

**mediabunny for the transcode.** One dep, MPL-2.0, no wasm. Rejected:
ffmpeg.wasm (25 MB, COOP/COEP isolation, mobile memory death) and
hand-rolled mp4box.js + WebCodecs + mp4-muxer (three deps and we own the
frame loop). Two non-obvious findings encoded in code + tests:
`Conversion.init` COPIES input metadata tags unless given an explicit empty
`tags: {}` — load-bearing for "metadata-free by construction" — and
mediabunny scales to the requested box unconditionally, so target height is
clamped to source display height to never upscale.

**Transcode-always + adaptive resolution + policy ceiling.** When the
capability gate passes (WebCodecs + avc encodable), every video is
transcoded — uniform mp4, GPS/creation-time dead with the container.
Bitrate budget = (0.95 × cap × 8) / duration − 128 kbps audio; ≥ 2 Mbps →
720p, else 480p. The 2-minute ceiling is POLICY, not capability: duration
read via `<video>` `loadedmetadata` (works without WebCodecs), so it binds
on every path.

**Fallback-to-original decision trail.** vjt initially chose strict-reject
on unsupported platforms; reverted to fallback-to-original for
compatibility. Capability failures fall back to uploading the original
under the same policy gates; `too_long` hard-rejects everywhere. The
fallback original keeps its metadata — known accepted leak, documented; #39
(server-side strip) generalizes.

**#49 root cause + fix.** `lastAttempt` (retry payload) was written only
after pre-checks passed, so an oversize rejection left the PREVIOUS file as
the retry buffer. Fix: record the latest selection unconditionally, before
any gate — retry always retries what the error box shows.

**Plug.Parsers latent 8 MB bug.** Multipart `:length` default is 8_000_000
— a 9 MB upload 413'd at the parser while the admin cap said 10 MB was
fine. Raised to a 64 MB ceiling scoped to `:multipart` only (a top-level
`:length` would raise the JSON body ceiling 8× on memory-constrained prod).
Policy stays in per-type caps.

**Lazy-chunk split.** mediabunny was 60%+ of cold-start main bundle for a
feature most sessions never touch. `videoTranscode.ts` (the only importer)
behind a dynamic `import()`; `videoPolicy.ts` (ceiling, budget math, probe)
stays static. Main chunk ~800 → ~304 kB.

**e2e** deliberately transcode-agnostic — Playwright's chromium may lack an
avc encoder; the documented fallback uploads the original. Harness gotcha:
`VideoEncoder` is `[SecureContext]`-gated — the skip-probe must run on the
app origin; probing `about:blank` false-skips.

## 2026-06-10 — uploads Range/206 + the lost-'self' CSP rule (playback saga, layer 4)

Uploads landed and transcoded correctly but the 🎬 link never played on the
dogfood iPhone. Two independent delivery-layer defects:

**1. No byte-range support.** `GET /uploads/:slug` answered every request —
including `Range:` — with a 200 full body. iOS/macOS Safari hard-require 206
from a media origin; without it playback is refused entirely. Fix:
`GrappaWeb.ByteRange` (RFC 9110 §14 single-range parser, `{:ok, {offset,
length}}` / `:unsatisfiable` / `:ignore`) + controller wiring (206 +
`content-range`, 416 without the freshness grant, `accept-ranges: bytes`,
full 200 for ignorable headers).

*Altitude decision*: BEAM-side `send_file/5` over nginx-native
X-Accel-Redirect. The nginx route gets Range + edge caching free but costs a
per-substrate uploads-path config (jail vs Docker vs e2e vs
dev-without-nginx, which still needs the Phoenix path as fallback — two code
paths for one resource). One controller path works on all four substrates,
and `send_file/5` is still zero-copy (Bandit hands offset+length to
`:file.sendfile/5`). Multi-range deliberately unimplemented — browser media
players never send it; full-200 is the spec fallback.

**2. The lost-'self' CSP regression class.** The same-day `media-src blob:`
fix silently REVOKED self-hosted media: declaring a fetch directive REPLACES
the `default-src 'self'` fallback rather than extending it, and direct
navigation to an /uploads mp4 renders in a media document governed by the
response's own CSP. Fix: `media-src 'self' blob:`, plus the general rule
hoisted to the top of `security-headers.conf`: every new fetch directive
must restate 'self' unless its absence is deliberate and commented
(frame-src is the documented exception). Known gap: e2e nginx-test.conf
serves no CSP header, so a ranged 206 through the nginx chain stays unpinned
(ConnTest can't see a proxy-layer Range strip) until the CSP-parity todo.

## 2026-06-10 — server-side metadata strip (#39): privacy is a server guarantee

vjt's architectural call: **privacy = server guarantee; client transcode
decision = pure performance.** GPS/metadata presence must never sit in the
client's transcode-or-not path, because the server strips ALWAYS.
Supersedes the uploads-2 spec's "always transcode … metadata-free by
construction" constraint (amended at the source): the transcode carried a
privacy job it can't own — the fallback path uploaded originals with GPS
intact, and litterbox uploads never saw a strip. A guarantee that holds only
on the happy path is not a guarantee.

**Where:** `Grappa.Uploads.MetadataStrip.run/2`, inside `Uploads.create/3`
before the file write — context-level so every door (REST today, future
facades) inherits it. The row's `bytes` is the STORED (stripped) size,
keeping `live_bytes_sum/0` cap accounting honest.

**Tooling (verified empirically, not from docs):** `exiftool -all=` for
images (jpeg/png/gif/webp/apng) and QuickTime video (mp4/mov) — lossless
container rewrite; ffmpeg would RE-ENCODE jpeg (quality loss), why "one tool
for everything" was rejected. Verified on GPS-tagged samples: EXIF APP1, PNG
`eXIf`, `udta` `loci`/`©xyz`, `mdta` Keys all removed; moov-before-mdat
(faststart) preserved — reordering would silently break iOS progressive
playback (layer-4's hard lesson). webm is the one allowlisted type exiftool
cannot write → ffmpeg stream-copy remux (`-map_metadata -1 -map_chapters -1
-c copy`).

**Fail-closed.** Strip failure (garbage bytes, missing binary, media mime
without a tool mapping) rejects the upload — 422 `metadata_strip_failed`;
reason logged server-side, never echoed (tool stderr leaks tmp paths). The
unmapped-mime clause is deliberate: a future allowlist addition without a
strip mapping must break loudly in tests, not store-with-leak. Documents
pass through byte-identical (vjt scope: images + videos; PDF/office metadata
is a known accepted class).

**Deps.** Dockerfile `apk add exiftool ffmpeg`; jail needs `pkg -j 6 install
p5-Image-ExifTool ffmpeg` BEFORE deploy (OPERATIONS "Jail package
dependencies") — fail-closed means missing binaries reject every media
upload.

**Fixtures.** Committed GPS-tagged binaries (`test/support/fixtures/uploads/`
+ `generate.sh`): marker-string assertions pin presence in the fixture AND
absence in the stored artifact, tool-independent. Byte-arithmetic tests
moved to `text/plain` (passthrough keeps sizes exact); the old
`"PNG-FAKE-BYTES"` tests exercised zero image semantics and cannot survive a
fail-closed boundary.

## 2026-06-10 — substrate-scoped preflight classes (the Dockerfile-colds-the-jail defect)

**Trigger.** The metadata-strip deploy cold-restarted prod — ALL IRC
sessions dropped — because the diff touched `Dockerfile`. The jail never
reads the Dockerfile (its substrate is `mix release` + rc(8)). On an
always-on bouncer a false-COLD is every user's IRC session, incident-grade.

**Decision.** `Grappa.Deploy.Preflight` classifies per-substrate:
`classify_paths/2` / `classify/5` / `cli([from, to, substrate])` take an
explicit `substrate :: :docker | :jail` — no default argument (CLAUDE.md
ban): missing substrate is a usage error (exit 2), unknown atom raises. Flat
Class-4 COLD list split:

- **4a `:image_substrate`** (`Dockerfile`, `.dockerignore`, `compose.*` as a
  PREFIX class, `bin/start.sh`, `bin/grappa`) — COLD only for `:docker`;
  jail sees HOT. `compose.*` is a prefix, not an enumeration: H20 proved the
  enumeration failure mode twice (compose.override.yaml + compose.oneshot.yaml
  both missed).
- **4b `:rc_d`** (`infra/freebsd/rc.d/grappa`) — COLD only for `:jail`. New
  reason atom. Scoped to the grappa wrapper only: sibling
  `rc.d/grappa_ndp_keepalive` is a DIFFERENT rc(8) service — cold-restarting
  the BEAM wouldn't refresh it, so it stays HOT and rides the cold-path
  installer.

Everything else stays substrate-independent; deploy orchestrators stay
excluded from COLD on both substrates.

**Exit-code contract at the shell boundary.** Both orchestrators previously
collapsed every non-zero preflight exit into COLD — which would turn "loud
usage error, exit 2" into a silent session-dropping restart. Both now case:
0 → hot, 3 → cold, anything else aborts loudly. COLD moved from 1 to 3
because a crashed mix oneshot exits 1 — a crash must never be readable as a
verdict.

**The jail preflight had NEVER produced a verdict.** `mix run` under
`MIX_ENV=prod` evaluates runtime.exs, which raises on missing `DATABASE_PATH`
— the daemon gets env from rc.d, but `run_as_grappa`'s `su -l` shell does
not, so every jail auto-mode preflight since it shipped crashed exit 1,
indistinguishable from COLD. (Past cold deploys also contained
legitimately-COLD classes — why nobody saw it.) Fixed: the jail deploy
sources `/usr/local/etc/grappa/grappa.env` for the preflight oneshot
(abort-if-unreadable); the 1-vs-3 split makes future crash classes abort
instead of silently colding.

**rc.d refresh.** The jail cold path now runs `jail_install_rcd.sh`
(idempotent installer) BETWEEN stop and start: old daemon stops through the
wrapper that started it, new one boots through the new wrapper. Closes the
loop where an rc(8) PATH fix shipped in the repo but prod kept 422ing until
hand-copied.

**Re-exec guard fixed (was dead code).** The 2026-05-31 guard compared
`${REPO_ROOT}/infra/freebsd/deploy.sh` against `$0` — the SAME path under
the documented invocation, so it never fired. Now re-execs when the pulled
diff range contains `infra/freebsd/deploy.sh`, threading the pre-pull SHA via
`DEPLOY_PREV_SHA` (the re-exec'd run re-pulls a no-op and would otherwise see
prev==new and exit "nothing to do").

**Deploy completion marker + reload honesty (live-repro'd).** The shipping
deploy was killed mid-flight between `mix release` and the reload POST: fresh
beams on disk, stale BEAM live — and every re-run exited "nothing to do" (the
fast path equated "pull was a no-op" with "deployed"). Three fixes: (1) the
jail deploy writes `runtime/last-deployed-sha` as the FINAL step of both
paths; nothing-to-do requires same-HEAD AND marker==HEAD. (2) `POST
/admin/reload` returning 200 with `"failed":[...]` no longer prints "hot
deploy complete" — the hot path greps for `"failed":[]` and aborts otherwise.
(3) The endpoint couldn't reload a module TWICE between restarts
(`:code.load_file/1` fails `:not_purged` — hit live). Logic moved to
`Grappa.HotReload`: `:code.soft_purge/1` then load. Soft, not hard — hard
purge KILLS processes executing old code (= dropped IRC sessions from the
endpoint that exists to avoid restarts); refusal surfaces as `{mod,
:old_code_in_use}` and the deploy aborts honestly.

**Hot deploys that ADD a module (third live repro, same day).**
`:code.modified_modules/0` compares only LOADED beams against disk — a
brand-new module is invisible; releases run embedded mode, so the first call
into it 500'd `:undef`. Second trap: OTP 26+'s cached code path doesn't see
files added to a dir after boot — `:code.load_file/1` reports `:nofile` for a
beam demonstrably on the path. `reload_modified/0` now also walks the app
ebin for never-loaded beams and loads via `:code.load_abs/1` (bypasses the
path cache). Recovery one-liner: `jail_release.sh rpc
':code.load_abs(~c"<ebin>/Elixir.Mod.Name")'`.

**Acceptance gotcha.** The deploy SHIPPING this change runs the old deploy.sh
bytes, whose 2-arg `cli` call against the new 3-arg module exits 2 → old
`if`/`else` reads COLD; so it goes `--force-hot`. Dockerfile-only diffs now
classify HOT-on-jail / COLD-on-docker.

## 2026-06-11 — cic text selection dead (two stacked causes, one per platform)

One symptom (selection dead on desktop AND mobile), two independent root
causes:

**Desktop: keepKeyboard's mousedown preventDefault.** The UX-3
preserve-keyboard listener (document-level capture, `lib/keepKeyboard.ts`)
preventDefaults every mousedown outside an input while an input has focus.
Its header claimed "No-op on desktop" — false: the install was
unconditional, and mousedown's default action is ALSO the start of a
text-selection drag; with compose autofocused every drag-select died at
capture. Fix: gate the handler on `isIos()`. The gate sits in the HANDLER,
not at install, for test isolation: the capture listener has no uninstall
path, so an install-time gate would leak an ungated listener from an iOS-UA
test into later desktop-UA tests.

Two conscious scoping decisions: Android also has an on-screen keyboard but
was never validated (no dogfood), so the gate scopes to the documented
target; widens by one clause if Android dogfood shows keyboard drops.
iPad-with-trackpad stays imperfect: `isIos()` is deliberately true there, so
a hardware-pointer drag still gets preventDefaulted while compose is focused
— fixing that needs keyboard-visibility detection (the UX-6 D tar pit);
waits for an actual complaint.

**iOS: the half-copied Telegram pattern.** UX-6 D9 adopted Telegram Web K's
keyboard pattern including `html.is-ios { -webkit-user-select: none }` —
Telegram pairs the global kill with a selective re-enable on message text;
the copy took the kill, skipped the re-enable, making ALL of cic unselectable
on iOS. Fix: complete the counterweight as a single policy block in
default.css (`html.is-ios .scrollback, .topic-modal-text, input, textarea {
user-select: text }`) — new copyable surface = one selector there. Inputs get
an explicit re-enable because some WebKit ranges honor inherited `none` inside
inputs. Deliberately excluded: mentions rows (navigation buttons) and the
`[Join]` invite CTA inside `.scrollback`. App chrome stays unselectable — the
global rule's actual point. `-webkit-touch-callout: none` stays (link
long-press callout is a separate deliberate decision).

Review near-miss: the day-separator and unread-marker labels declared only
UNPREFIXED `user-select: none`, which iOS Safari <18.4 doesn't parse — under
the new prefixed re-enable on the ancestor they'd become selectable exactly
where the comment promised not. General rule for this theme file: any
`user-select` declaration ships prefixed + unprefixed, or the iOS cascade
splits from the spec one.

Lesson (recurring shape): copying a reference pattern partially is worse than
not copying it — the kill switch arrived without its counterweight. Read the
reference implementation COMPLETELY.

## 2026-06-11 — media links: in-app viewer modal (the in-scope navigation trap)

iOS standalone PWA dogfood: plain website links FINE (out-of-scope → Safari
view with controls); MEDIA links opened a bare window without controls, and
returning forced a full reload. Root cause: own upload URLs are SAME-ORIGIN,
the manifest has no `scope` key and `start_url: "/"`, so the whole origin is
in-PWA-scope — and iOS standalone navigates in-scope links IN PLACE
regardless of `target="_blank"`. The PWA window itself became the raw media
document (no chrome); "reload on return" was cic cold-booting after its
window was navigated away.

Decision (vjt): on-CLICK in-app viewer modal for media URLs — X-close +
"open in browser" — NOT a generic iframe modal for all links
(X-Frame-Options blocks most of the web, iframe history unreliable, needs a
`frame-src` CSP loosening). Plain web links untouched. Does NOT lift "IRC
stays text only": that rule bans on-ARRIVAL rendering; a click is the user
opening the resource — the modal is just WHERE.

Mechanics. `lib/mediaLink.ts` (pure, linkify-style) classifies a URL given
the preceding text segment: same-HOST `/uploads/<26-char-base32>` + trailing
📸/🎬 → image/video (the slug carries no extension — the emoji prefix is the
only type signal on the wire); same-host media-extension URL → kind by
extension; cross-host → null, ALWAYS — two reasons: the CSP (`img-src 'self'
data:`, `media-src 'self' blob:`) would block the modal's media element (the
viewer ships with ZERO CSP changes), and cross-host links never had the bug.
📄 documents excluded: in-modal PDF needs `<embed>`/`<iframe>` (the rejected
design); a same-origin 📄 link still navigates in place — known residual.

HOST-equality, not full-origin equality — the e2e spec's first run caught
why: the harness anchor rendered `http://localhost:4000/…` on an
`https://nginx-test` page. Prod had the SAME defect: `Endpoint.url()` =
`http://irc.sniffo.org` — runtime.exs declared `url: [host: …, port: 80]`
with no scheme, so every upload link ever posted is http:// on an https PWA.
A strict origin check would have dead-lettered the entire upload history.
Fix, both ends: (a) runtime.exs roots `url:` at `https://PHX_HOST:443`, gated
on PHX_HOST presence (empty-string-guarded — dev compose passes
`${PHX_HOST:-}` and Elixir treats `""` as truthy); prod mints honest https
links from its next cold deploy — safe to batch because (b) the classifier
matches on host and returns the page-origin-rooted href, so historical
http:// bodies render without mixed-content blocks. The `--cic` deploy path
doesn't move `runtime/last-deployed-sha`, so the pending runtime.exs change
stays inside the next server deploy's diff range — the marker machinery makes
"commit now, cold later" safe.

The anchor KEEPS its href + `target="_blank"` — copy-link, middle-click,
long-press all behave; only plain click is intercepted.

Review fixes (same session): modifier/aux clicks bypass the intercept
(browser-native new-tab); the classifier returns `{kind, href}` with the
origin-rooted href (path+query+hash — `#t=` fragments survive) instead of a
separate normalize step a future call site could forget; `mediaViewer.ts`
joined `identityScopedStore` (token rotation closes a lingering viewer); the
Escape listener registers only while the viewer is open; and the third
verbatim copy of the modal overlay-lock boilerplate triggered extraction into
`createOverlayLock(isOpen, selector)` — which also fixed a latent leak ALL
copies shared: a same-task open→close popped (clamped at zero) before the
microtask-deferred push fired, stranding the refcount at 1 — permanent iOS
scroll-lock until reload. ArchiveModal + PrivacyModal migrated in the same
commit (total consistency or nothing). Server side: PHX_HOST is now mandatory
in prod (raise, same contract as DATABASE_PATH) — the old `|| "grappa.bad.ass"`
fallback minted equally-dead links quietly, and PHX_HOST was read three times
with three different empty-string semantics; one read now feeds both roles.

Known residual (deferred): the 📸/🎬 type signal lives in message TEXT, read
from the linkify segment within one mIRC formatting run — control codes
interleaved between emoji and URL (colorizing relay bridge) split them into
separate runs and the link falls back to the plain anchor (navigate-in-place
returns for those rows). cic's own mints are always plain `📸 <url>`, so
today's real surface is zero; the durable fix is server-side minting of
`/uploads/<slug>.<ext>` so the URL itself carries the type (todo).

## 2026-06-11 — media viewer dogfood: the escape hatch had the bug it escaped

First device dogfood, two defects. Defect one indicts un-dogfooded comments:
the modal's "open in browser" anchor — the deliberate leave-the-PWA
affordance — NAVIGATED THE PWA IN PLACE. The shipped comment claimed
`target=_blank` "deliberately leaves the PWA"; false by this cluster's own
root cause: iOS standalone ignores `target` for in-scope links. No anchor
attribute escapes in-scope navigation.

The only same-origin escape is the `x-safari-https://` scheme handoff (real
Safari, iOS 17+, inert on 16; `window.open(url, '_system')` is Cordova
folklore, not WebKit). Mechanism matters as much as scheme — the v1 fix
rewrote the anchor HREF, which breaks long-press → Copy Link (dead x-safari
URL) and contradicts the click-intercept-preserve-href contract. Final shape:
href stays the live URL + `target=_blank`; plain primary clicks delegate to a
shared `maybeEscapePwaClick` — modifier guard, gate, preventDefault,
SAME-WINDOW `location.assign` (a scheme handoff needs no new browsing context,
and the new-window path is the one WebKit popup policy can swallow).

Review's altitude catch: the bug CLASS is "any same-host link tapped in the
standalone PWA", not "the modal's anchor" — 📄 documents (rejected by
`classifyMediaLink`) and the emoji-split-run fallback rows carried the
identical defect. ScrollbackPane now routes plain clicks on same-host
NON-media links through the same escape handler; `sameHostHref` is the
extracted host-match + origin-re-root half of `classifyMediaLink` — exactly
one implementation of "is this ours and what URL do we actually use". The
composed gate lives once in platform.ts as `escapePwaHref` — the `isIos()`
half is load-bearing (Android/desktop installs are standalone too; an
x-safari URL is inert there), exactly the recomposition mistake a second call
site would have made from exported halves.

Defect two — no loading feedback — grew three review corrections: (a) media
state transitions only leave `loading` (a transient mid-playback
MEDIA_ERR_NETWORK must not unmount a playing element; a late `suspend` must
not resurrect a failed one); (b) `suspend` terminates the spinner — iOS Low
Power Mode / Data Saver downgrades `preload=metadata` and fires neither
`loadedmetadata` nor `error` before a play gesture, so the spinner would spin
forever on exactly the target platform; (c) `pointer-events: none` on the
spinner overlay, which otherwise sits on the video's centered native play
control and swallows the tap that starts the deferred load.

Testing boundary worth recording: jsdom's `window.location` is unforgeable
AND unimplemented — `location.assign` can be neither spied nor run. The split
that works: decision logic pinned pure (`escapePwaHref` gate matrix),
component wiring via a partial module mock of `maybeEscapePwaClick`, the
assign line owned by device dogfood.

## 2026-06-11 — #39 round 2: the strip ate Orientation (whitelist, not blanket wipe)

Dogfood found the over-reach: `exiftool -all=` removes EVERY tag, and EXIF
Orientation is a tag — every portrait phone photo since the strip shipped
renders sideways (browsers honor the tag via `image-orientation: from-image`;
pixels are stored unrotated). Privacy tags and presentation tags died
together.

Fix shape per vjt: an explicit ALLOWLIST of presentation-critical tags copied
back after the wipe — exiftool's own idiom, `-all= -tagsfromfile @
-Orientation` (no-op when absent). `@kept_tags` starts with Orientation only.
Bar for an entry: rendering data with no provenance payload, AND a committed
fixture pinning both directions (privacy markers die / kept tag survives).
ICC_Profile (iPhones shoot Display P3; stripping washes colors) is the named
next candidate but stays OUT until a profiled fixture exists — an untested
whitelist entry is a privacy hole nobody pinned (in todo).

Video rotation needed no entry — asymmetry worth recording: QuickTime
rotation lives in the tkhd track display matrix — container STRUCTURE, not
metadata — so `-all=` never touched it; webm out of MediaRecorder has pixels
already upright. Hence sideways photos but normal videos.

Already-stored sideways uploads are NOT migrated: the Orientation bytes are
gone; reconstructing from pixels is guesswork. Re-upload is the fix.

Review addenda: the copy-back is gated to image/* mimes — on the video path a
bare `-Orientation` resolves against ALL groups of the original (XMP, EXIF
blocks in QuickTime atoms): a believed no-op nothing pinned, a latent
surprise for future @kept_tags entries; video keeps the blanket wipe. The
whitelist test gained an exiftool GPS read-back on stripped output — byte
markers cannot see EXIF GPS (binary rationals), so without the probe a
copy-back widened beyond the allowlist would pass green. Rejected alternative,
recorded so it isn't re-proposed: physically auto-rotating pixels (jpegtran)
then stripping everything — jpeg-only (PNG/WebP still need the tag path, so
the whitelist survives anyway), "lossless" rotation requires MCU-aligned
dimensions, and it adds a fourth binary dep for zero privacy gain over a 1-8
integer. Also: a stripped JPEG that kept Orientation carries exiftool's
mandatory IFD0 companion defaults (YCbCrPositioning=1 — fixed default, NOT
copied from source); a privacy audit grepping stripped output should expect
that minimal APP1 shape.

## 2026-06-11 — prod outage (~15 min): three stacked deploy defects, found live

Applying the parked runtime.exs PHX_HOST cold change surfaced defects #7–#9
of the deploy-honesty saga, each forcing the workaround that tripped the next:

**#7 — preflight diffs the wrong range.** deploy.sh classifies
`prev_sha..new_sha` where `prev_sha` is the PRE-PULL jail HEAD — not
`runtime/last-deployed-sha`. But `jail_deploy_cic.sh` ALSO pulls: every
`--cic` deploy advances jail HEAD without applying server changes, so any
server-side commit landing between two cic deploys vanishes from every future
server deploy's preflight range. The runtime.exs commit entered via a cic pull
→ next server deploy classified a range no longer containing it → HOT verdict,
cold change silently skipped. The cp63 assumption "the cold change rides the
next server deploy's diff range automatically" was false. Fix shape: preflight
base = marker when present, pre-pull HEAD as fallback.

**#8 — `--force-cold` can be silently swallowed.** The nothing-to-do fast path
(same HEAD + marker match → exit 0) ran before the force flag was consulted —
an operator explicitly demanding a restart got "nothing to do". Fix shape:
fast path applies in auto mode only.

**#9 — rc.d restart races the drain.** The manual fallback `service grappa
restart` hit: stop returned while the old node was still DRAINING WebSockets,
the new BEAM died on `name grappa@grappa … in use` — and rc.d printed
"Starting grappa." and walked away. That unsupervised boot failure WAS the
outage; recovery was a plain `start` once the old node was gone. Fix shape:
stop must wait for BEAM exit + epmd name release (or start retries on
name-in-use), and a boot that dies within seconds must be loud.

## 2026-06-11 — deploy defects #7–#9 fixed: marker range, force wins, stop means stopped

The fix dispatch for the outage above.

**#7 — preflight base = `runtime/last-deployed-sha`.** When the marker exists
and is a real commit (`git cat-file -e`), it is the range base; pre-pull HEAD
is the fallback ONLY when no marker exists (fresh install). A garbage marker
(truncated write, rewritten history) aborts loudly with a fix-it hint —
deliberately NOT a silent fallback, which would re-open the exact range hole
the marker closes. The re-exec guard keeps the pre-pull range ("did THIS run's
pull change the bytes I'm executing?"). The Docker substrate
(`scripts/deploy.sh`) is explicitly NOT ported — it has no marker
infrastructure at all; folded into the existing REV-I todo. Docker drives the
LOCAL dev stack only.

**#8 — the nothing-to-do fast path applies in auto mode only.** An explicit
`--force-hot`/`--force-cold` is an operator order; the skip log states what was
observed and, when forced past, which flag overrode. The "re-driving" message
now names the common benign cause (cic deploys advancing HEAD) instead of
implying every marker gap is a died-mid-flight deploy.

**#9 — `infra/freebsd/jail_beam_wait.sh`, one implementation of the stop/start
race lore.** Two verbs: `wait-stopped <node> <timeout>` (blocks until beam.smp
exits AND epmd drops the name; escalates — SIGKILL after timeout, epmd restart
only AFTER the BEAM is confirmed dead, preserving the 2026-05-31 lesson that
pkill'ing epmd under a live BEAM re-races the registration) and `wait-name-free
<node> <timeout>` (pre-start guard, NO escalation — the name's owner may be a
live draining node that must not be shot). Call sites: rc.d `grappa_stop` (stop
now means STOPPED), rc.d `grappa_start` (refuses a registered name, polls the
release `pid` RPC, treats a vanished beam.smp as an immediate loud boot
failure), and deploy.sh's cold path. The deploy.sh call site is load-bearing
forever: rc.d wrappers are refreshed BETWEEN stop and start, so any deploy
shipping an rc.d fix stops through the PREVIOUSLY installed wrapper. New
rc.conf.d knobs: `grappa_node`, `grappa_stop_timeout`, `grappa_start_timeout`,
`grappa_name_wait_timeout`, `grappa_beam_wait`.

Testing: new `test/infra/*.bats` pin the decision logic. The rc.d wrapper
needs rc.subr (FreeBSD-only): verification is the next real cold window on
m42.
## 2026-06-14 — user@host on join/part/quit (irssi-style presence lines)

Real clients show `nick [user@host] has joined`; Grappa rendered only the
nick. Carry the parsed `{:nick, nick, user, host}` prefix to the scrollback
row + cic. `prefix_userhost/1` reads `msg.prefix` directly — NOT the
`userhost_cache` (different lifecycle; PART/QUIT prefixes carry user@host on
the wire anyway) — returning `%{sender_user, sender_host}` only when BOTH
present: a `+x`-cloaked prefix yields nothing rather than a misleading
partial (mirrors the cache's half-populate rule).

Storage = meta, deliberately not a column: the keys join `Scrollback.Meta`
`@known_keys` — no migration, hot-deployable. But the A18 sync test forces
the mirror into the `config/config.exs` Logger `:metadata` allowlist, which
made `Deploy.Preflight` classify the diff COLD (Class 7) — over-conservative
(these keys are never emitted as Logger metadata), so shipped `--force-hot`
+ `--cic`.

cic renders ` [user@host]`, empty string when meta lacks it, so cloaked /
pre-feature rows render unchanged — deploy-order-independent.

Tooling self-heal: `scripts/bun.sh` auto-runs `bun install` when
`cicchetto/node_modules` is absent (per-worktree); `scripts/bats.sh`
auto-inits the `vendor/bats-core` submodule — fresh worktrees work
first-try.

## 2026-06-14 — IRC-centric custom keyboard (opt-in, in-page, replaces the native iOS keyboard)

Phone-portrait MVP; landscape/iPad, channel-switch keys, emoji search, skin
tones deferred. IRC-first affordances the native keyboard can't give: arrows
→ input history + caret, a Termius-style accelerator pill (`Tab` / `/` / `#`
+ arrows + close), an emoji layer. Opt-in per device (`localStorage`,
`lib/keyboardPref.ts`) — NOT server-backed `userSettings` (keyboard is a
per-device display choice, not a cross-device IRC pref).

**`inputmode="none"` is the load-bearing decision.** While enabled the
compose `<textarea>` gets it, so tapping focuses without the native
keyboard; our keyboard renders in-page. An in-page keyboard never shrinks
the visual viewport, so it SIDESTEPS the `--vh`/visualViewport/
`position:fixed`/smart-scroll-pin machinery (UX-6 D9, 8 failed iterations) —
that exists for the NATIVE keyboard and stays dormant. `--vh` was not
touched.

**Reservation caveat the spec missed.** Naive
`.shell-mobile { padding-bottom: var(--irc-kb-height) }` fails: the keyboard
is always docked AND the textarea stays focused, so the existing
`.shell-mobile:has(textarea:focus) { padding-bottom: 0 }` rule (native-kb
inset collapse) zeroes the reservation exactly when needed. Fix: fold
`--irc-kb-height` into BOTH bottom-inset declarations —
`max(env(safe-area-inset-bottom), var(--irc-kb-height,0px))` on the base
rule, `var(--irc-kb-height,0px)` on the `:has(...)` rule. Var is `0px` when
off, so both resolve byte-for-byte to prior values. This is the only edit to
`default.css`'s mobile machinery; keyboard CSS lives in `keyboard.css`.

**Extraction boundary (hard invariant, grep-guarded).** Everything under
`cicchetto/src/keyboard/` imports ONLY from within it. Boundary type
`KeyboardIntent` (renamed from the spec's `KeyboardEvent` to avoid the DOM
global). Sole cic-coupled file: `KeyboardHost.tsx` — resolves the live
compose textarea, applies intents via the EXISTING `compose.ts` paths, gates
mounting on opt-in + mobile + coarse-pointer. The reservation rule lives in
cic's `default.css`, keeping the module pure. Grep guard: `from "../…"` in
`src/keyboard` production files must return nothing.

**Locked gesture semantics (iOS-exact).** Long-press opens the variation
strip; highlight tracks the finger's X, FREEZES above the strip top,
sticky-CANCELS below the pressed key; release commits. Engine
(`gesture.ts`) pure/DOM-free. Strip highlight passed as `s().highlight()` —
Solid compiles a reactive getter so the active cell tracks the drag
(regression-pinned).

**Execution gotchas kept.** `moveCaret` collapses an active selection to its
near edge (iOS selection persists under `inputmode=none`). Under
`noUncheckedIndexedAccess` the convention is optional chaining on indexed
array access — every task ended with `bun.sh run build` (tsc), not just
vitest. The EmojiPicker test mocks the dataset to a few entries: rendering
~1900 buttons took ~9s in jsdom and timed out under parallel load; the full
dataset is covered by `emoji-data.test.ts`.

**Flagged OUTSTANDING** (resolved next entry): caret stability under
`inputmode=none` (Solid re-render may clobber it) and the height reservation
/ grey tuning. Follow-up: `CELL_WIDTH = 44` duplicated in `KeyCap.tsx` +
`VariationStrip.tsx` — drift misaligns the highlight.

## 2026-06-14 — IRC keyboard: on-device dogfood fix round (real iPhone)

Supersedes the "OUTSTANDING" caveats above where they conflict (reservation
now MEASURED, not a tuned constant).

**Native keyboard appeared on focus (critical).** `inputmode="none"` was set
imperatively by a Shell `createEffect` keyed on `ircKeyboardEnabled()` — it
ran only when the opt-in CHANGED, so a textarea re-created on channel switch
carried no attr → native keyboard + woken `--vh` machinery. Fix: bind
declaratively on the ComposeBox textarea
(`inputmode={ircKeyboardEnabled() ? "none" : undefined}`). **General rule: a
one-shot imperative attr-set on a reactively re-created element is always a
latent bug — make the attr part of the render.**

**Magnify + variation strip invisible.** `.kbd-root` carries `transform`
(slide animation); a transformed element is the containing block for
`position:fixed` descendants, so the magnify + strip anchored to `.kbd-root`
and rendered off-screen. Fix: Solid `<Portal>` to `document.body`. `--kbd-*`
vars still cascade (`:root`).

**fn-key white borders / tiny spacebar.** fn keys + space are `<button>`s
and inherited UA border/appearance/font. Button reset on `.kbd-key`
(`appearance:none; border:0; …; font-family:inherit` — NOT the `font`
shorthand, which clobbers font-size).

**Key-sizing model.** Rows used `flex:1` → fewer-key rows got WIDER keys.
Stock iOS keeps LETTER width constant and centers short rows:
`--kbd-key-w = (row − 9 gaps) / 10`, letters 1u, fn keys `1.5u + ½gap`,
spacebar `flex:1 1 auto`, `justify-content:center`.

**Arrow order** ◀ ▲ ▼ ▶ (vjt); intents unchanged. **Emoji layer** bound to
`--kbd-body-h` (4 rows + 3 gaps) instead of a fixed `260px`.

**Focus-driven show/hide replaces always-docked (vjt).** ✕ only blurred,
leaving it docked. New model: `wantKeyboard` open-intent set on compose
`focusin`, cleared on ✕ or when another text field gains focus;
`visible = mountable && wantKeyboard`; Keyboard stays mounted so the slide
animates both ways. Channel switch keeps it open by re-focusing the
re-created textarea.

**Reservation is MEASURED.** `--irc-kb-height` moved to `KeyboardHost`, set
to the keyboard's live `offsetHeight` when visible (0 hidden); the
undershooting `KB_HEIGHT_PX ≈ 290` constant is gone. Keyboard-off layout
still byte-for-byte prior values.

Still to verify: lollipop magnify SHAPE; exact spans/greys/radii vs
reference PNGs; caret stability while typing; `CELL_WIDTH=44` dedup.

### Round 2 (same day) — four more dogfood fixes

The caret reactivity gamble lost: fast typing DID drop characters.

- **Dropped keys → edit through the draft store, not `ta.value`.** The
  textarea is Solid-controlled by `draft()`; a keystroke burst leaves
  `ta.value`/caret stale mid-re-render. Split into pure
  `editText(intent, text, sel) → {text, caret}` + host `applyEdit` that
  reads `getDraft` (synchronous, authoritative), writes `setDraft`, restores
  the caret next microtask. **General rule: never read a controlled input's
  `.value` as the source of truth — read the store that drives it.**
- **Variation strip never closed on cancel** — teardown was glued to the
  commit path. `KeyCap` gains `onCloseVariants`, called the instant the
  gesture cancels and unconditionally in `finish()` — ONE teardown owner.
- **Emoji layer still overflowed → `min-height:0` on the grid.** A flex item
  with `min-height:auto` refuses to shrink below content — the classic
  flexbox-overflow trap.
- **Send button collapsed the keyboard (#59).** `type=submit` stole focus;
  `onPointerDown` preventDefault stops the steal, click still submits — same
  trick as the keyboard keys + image-picker.

## 2026-06-19 — #62: visitor `/away` un-gated + channel-push errors get human copy

Visitor `/away` returned a bare `Send failed`.

**Defect A — the gate had a bogus rationale.** The channel `"away"` arms
short-circuited visitors with `visitor_no_away`, justified as
"`set_explicit_away/3` only routes to user sessions" — factually wrong: it's
`is_subject/1`-guarded and accepts `{:visitor, id}`. Each visitor owns a
PRIVATE `Session.Server` + upstream connection, so `away_state` is
per-connection. The gate conflated explicit `/away` with WSPresence-driven
AUTO-away (genuinely user-only: visitor sessions don't subscribe to
WSPresence). Fix: delete the gate; dispatch via the existing
`resolve_subject/1` (the C3 WHOIS carve-out pattern) — one code path.

**Defect B — `compose.ts` swallowed every channel-push code.** The submit
catch ran `friendlyApiError` only for `ApiError`; a `ChannelPushError` fell
to generic `"send failed"` — violates no-silent-swallow. Fix: sibling
`friendlyChannelError.ts`, same closed-union-token → human-copy discipline
(loud `err.message` fallback for unmapped arms). The dead `visitor_no_away`
token is deliberately NOT mapped — a dead arm is silent UX rot (cf.
`captcha_provider_unavailable`). ZERO channel-level `/away` tests existed
before — which is why this shipped.

## 2026-06-20 — #31: visitor `/invite` un-gated (third carve-out, C3 lineage)

Same shape as #62. `handle_in("invite", ...)` routed through
`dispatch_ops_verb/3`, which rejects visitors. INVITE was bucketed with
op/kick/ban but doesn't mutate state — it sends an invitation the target may
ignore; upstream is the authority on whether the issuer may send it.
`Session.send_invite/4` already accepts subjects, so the fix is the
mechanical C3 migration `dispatch_ops_verb/3` → `dispatch_subject_verb/3`. A
visitor without a live session now gets `no_session` (the real reason)
instead of `visitor_not_allowed`.

Recurring lesson (C3 WHOIS → #62 → #31): the "ops verb = visitor-rejected"
bucket conflated *transport entitlement* (does this subject own a session?)
with *IRC-protocol authority* (will the server accept it?) — the second is
upstream's job. The moduledoc's blanket "all ops verbs reject visitor
sockets" was the drift source; rewritten to enumerate the state-mutating set
and name the carve-outs.

## 2026-06-21 — PWA home-screen icon badge (one predicate, three doors)

Badge = "how many unread messages did the operator choose to be notified
about", capped at 99, fully derived from read cursors + the notify predicate
— **no new persisted state**.

**One predicate, never reimplemented.** The count is the EXACT set Web Push
fires on: rows passing `Grappa.Push.Triggers.should_notify?/4` — badge and OS
notification can't disagree by construction. `Push.BadgeCount.count/1`
fetches the bounded unread tail per cursor (capped, early-bail at 99) and
maps the REAL predicate — NOT a second SQL-shaped copy (the
predicate-divergence bug class). A SQL-COUNT fast path was sketched and
rejected: the cap keeps predicate-reuse cheap. The cic foreground mirror
(`pushTriggers.ts` `shouldNotify`) and the Elixir original are pinned by a
SHARED truth-table JSON fixture both ExUnit and vitest consume.

**Boundary inversion (load-bearing).** BadgeCount deps
Networks/ReadCursor/Visitors → transitively Session, and Session deps Push —
folding the counter into `Push` closes a cycle. So BadgeCount is its OWN
`top_level?: true` boundary above Push (pattern: `Visitors.Reaper`). Door #1
— the push-payload badge, dispatched deep in `Session → Push.Triggers` —
would re-open the cycle with a static edge, so it resolves the counter at
RUNTIME via a `Grappa.Push.BadgeSource` behaviour wired in `config.exs`
(never a module literal in Push). Deploy corollary: a HOT reload doesn't
re-run `config.exs`, so `:badge_source` is briefly absent; `count/1` returns
`nil` (not a crash, not a wrong `0`) and door #1 omits the badge field — the
push still fires; badges resume once config is live.

**own_nick is the configured nick, off-Session** — credential nick /
`visitor.nick` via `Networks.configured_nick_index/1`, NEVER live
`Session.current_nick`: door #3 runs on every read-cursor settle, and a
GenServer round-trip per network on that hot path is unacceptable (`/me`
takes the same stance). Accepted staleness after `/nick` until the next
reconnect rewrites the credential — bounded, self-correcting.

**Three doors, one signal.** (1) push payload gains `badge`; (2) `/me` gains
`badge_count` (boot seed); (3) `read_cursor_set` gains `badge_count`
(reading anywhere refreshes every client). cic `badge.ts`: one signal →
effect driving `navigator.setAppBadge` (feature-detected) + the
`document.title` mirror `(n) <base>`. The SW stamps the icon on push receipt
even when the foreground toast is suppressed.

**Increment scope (honest limitation).** The foreground optimistic bump
reuses the existing mention path (focus- and own-echo-gated) —
channel-MENTION only. Non-mention triggers are NOT bumped optimistically:
cic has no global notification-prefs signal to feed the full `shouldNotify`
at message-arrival; they surface on the next server sync.
Server-authoritative, so under-counts self-heal.

**Verification.** The title mirror is the only surface headless browsers see
(`pwa-badge-title-mirror.spec.ts`). The icon badge needs an installed PWA
with notification permission — device dogfood only.

## 2026-06-21 — empty `/away` reason rejected (un-away footgun closed)

Reason `""` built `AWAY :\r\n` — RFC 2812 §4.6's bare-AWAY *un-away* line:
setting away with an empty reason silently CLEARED away.
`safe_line_token?/1` only screens CR/LF/NUL and the channel boundary only
screens `body_too_large`, so a crafted WS push reached the wire.

Fixed at two layers, deliberately:
- **`Session.set_explicit_away/3,4`** (primary boundary): guards
  `reason != "" and safe_line_token?(reason)` → `{:error, :invalid_line}`,
  covering BOTH internal byte paths (labeled send_line and plain
  `Client.send_away`).
- **`Client.send_away/2`** (byte boundary, defense-in-depth): also guards
  `!= ""`, completing the symmetry its siblings
  (`send_privmsg`/`send_part`/`send_oper`/`send_pong`/`send_raw`) already
  had — so a non-cic caller (test harness, Phase 6 listener) can't slip a
  malformed frame past even bypassing the facade. `send_away` was the lone
  exception; the docstring already *claimed* it mirrored `send_pong`.

The guard is `!= ""`, NOT `String.trim/1`: a whitespace-only reason is a
valid blank-looking set, not the un-away line. Facade-test-pinned so a
future change can't tighten to trim-semantics.

cic (`slashCommands.ts`): `/away :` mapped to `reason:""` — pre-fix a silent
un-away; collapsed both empty-reason cases into `reason === "" → unset`.
Also fixed a pre-existing (CI-invisible — cic vitest is local-only) red: the
`vi.mock` block omitted `ChannelPushError`, so #62's `instanceof` threw for
every non-ApiError rejection.

## 2026-06-21 — login 433 surfaces as `:nick_in_use` (#40)

An in-use nick at the landing page returned generic `connect_timeout` copy.
`Visitors.Login` blocks on `{:session_ready, ref}` (001); a 433 never
reaches 001. Passwordless sessions have no ghost-recovery, so AuthFSM stops
the Client with `{:nick_rejected, 433, _}`; `Session.Server` re-raises stop
reason `{:client_exit, {:nick_rejected, 433, _}}`. That term already rode
the monitored DOWN to the login waiter — Login just *discarded* it and
flattened every crash to `:upstream_unreachable`.

Fix is pure classification, no new state: `classify_down/1` maps that term →
`:nick_in_use`, everything else → `:upstream_unreachable`. The 409
`nick_in_use` envelope already existed (V9 rename collision); only the login
surface needed wiring — an explicit `visitor_error_response` allowlist arm
(the catch-all would 500 it) + a `friendlyApiError` case. 432
ERR_ERRONEUSNICKNAME deliberately NOT mapped — `validate_nick/1` already
gates shape, so a 432 reflects upstream-specific rules.

Registered visitors unaffected: their 433 drives `GhostRecovery`, whose FSM
stays `:cont`, so the exit reason is never `:nick_rejected`.

## 2026-06-21 — single NickServ IDENTIFY site on login (#27)

A registered visitor's login put `PRIVMSG NickServ :IDENTIFY <pw>` on the
wire twice (double acceptance NOTICE):

1. `IRC.AuthFSM.maybe_nickserv_identify/1` at 001 — the canonical site:
   fires for **every** `:nickserv_identify` spawn, including Bootstrap
   crash-respawn where `Visitors.Login` never runs. Emitted inside
   `IRC.Client` (bypasses `NSInterceptor`); the password is staged for the
   +r observer via `Session.Server.maybe_stage_pending_password/1`.
2. `Visitors.Login.preempt_and_respawn/4` sent a second post-readiness
   IDENTIFY — pure redundancy: a case-2 visitor is *always*
   `:nickserv_identify` (visitor `auth_method` is only
   `:none | :nickserv_identify`, no SASL), so path (1) already produced the
   same NOTICE and +r.

Fix: delete the post-readiness send + dead helpers. Side benefit: that was
the one place login threaded the cleartext password through
`Session.send_privmsg` — a cleartext-handling site removed.

Regression guard: `login_test.exs` asserts IDENTIFY on the wire **exactly
once**. Counting needs a TCP-order barrier — the `IRCServer` fake reads
asynchronously, so a naive count races. The test pushes one more line
(`PRIVMSG NickServ :HELP`) and waits for it; `packet: :line` +
`active: :once` deliver in order, so once the barrier is buffered every
earlier line is too.

## 2026-06-21 — orphaned PWA icon badge reconciled on foreground

The icon badge could stick at a stale non-zero count after everything was
read; prod rpc showed `BadgeCount.count/1` = 0 — the drift was purely the OS
icon-badge SURFACE.

Root cause: two writers sharing no state. The SW push handler
(`applyIconBadge`, door #1) calls `navigator.setAppBadge` directly while
backgrounded — never touching the in-page `badgeCount` signal.
`mountBadgeSync` only re-applies when the signal *changes value* (Solid
`===`), so on a warm foreground where server count already equals the signal
(0-over-0), the effect never re-fires and the SW-set badge is orphaned. Cold
launch was fine (the `/me` seed reconciles); warm resume (the common iOS PWA
case) had no reconcile point.

Fix: `mountBadgeReconcile` — on every `visibilitychange` → visible, re-pull
`/me` `badge_count` and `reconcileBadge` force-applies it to both surfaces,
bypassing the equality short-circuit. Reconciling to the SERVER count (not
the first-instinct blind clear-to-0) is load-bearing: a mention that arrived
while backgrounded must KEEP its badge. The signal stays the single source
of truth.

Accepted tradeoffs: an in-flight `/me` can resolve stale and briefly clobber
a newer `read_cursor_set` count — transient, self-heals; a sequencing guard
would be heavier than a one-round-trip flicker. Relies on `visibilitychange`
firing on iOS standalone-PWA foreground — true on iOS 16.4+ (the Badging API
floor), not reproducible in Playwright webkit; verified by on-device
dogfood. The listener is app-lifetime (bare in `main.tsx`, disposer dropped
— production PWA updates full-reload, so listeners never accumulate; the
disposer exists for unit-test cleanup).

## 2026-06-21 — own nick change surfaces on $server (#61)

Own nick change produced no visible confirmation with zero shared channels:
`EventRouter`'s `:nick` clause fans out `:nick_change` rows per shared
channel (empty fan-out → nothing), and the separate `own_nick_changed` STATE
event patched the displayed nick silently.

Fix: when `old_nick == state.nick`, emit one additional `:nick_change`
persist on the synthetic `"$server"` window, independent of membership —
`$server` always exists, so confirmation is guaranteed. Reuses the existing
typed event + `$server` convention; no cic change. Gated on the self check
(NICK-other never reaches `$server`); visitors get it too.

Behaviour note (kept on purpose): the `$server` row counts as a cic "event"
in the cursor-derived unread until viewed. The `$server` handler is
installed with `ownNick = null` so `isOwnPresenceEvent` can't suppress there
— and the live nick wouldn't help: the row's sender is the OLD nick
post-`own_nick_changed`. The events indicator IS the confirmation #61 asked
for; the notify badge ignores it (presence kinds fail `should_notify?`).

## 2026-06-21 — sender grade glyph snapshotted at send time (#25)

cic's `prefixFor` derived the `@`/`%`/`+` glyph at RENDER time from the LIVE
members store, so an op/deop re-prefixed every old line. The glyph must
reflect the grade AT SEND time. Fix: snapshot (not a flag-history timeline)
— server captures `meta.sender_prefix` at PERSIST time; cic renders
content-row senders from the frozen value.

Server — one capture rule, both doors:
  * `EventRouter.build_persist/6` merges `sender_prefix` for content kinds
    (`:privmsg`/`:action`/`:notice`) on a sigil-shaped channel where the
    sender is a tracked member with a non-plain grade (guards exclude
    services-`$server` reroutes and DMs).
  * `Session.Server.persist_and_send_fragments` mirrors it for the
    operator's OWN outbound.
  * `Grappa.IRC.Identifier.member_prefix/1` is the shared sigil-precedence
    reducer (`@` > `%` > `+`), matching cic's `memberSigil`.
  * `Scrollback.Meta` allowlists `:sender_prefix`; the A18 sync test forces
    the `config.exs` Logger mirror → COLD deploy (accepted, batched as the
    session's one cold change).

cic: `prefixFor` returns the snapshot for the content row's OWN sender;
presence-row senders and the kick TARGET keep the live members join (they
describe a "now" event). An absent snapshot (plain sender or pre-feature
row) renders NO glyph, never a live-derived guess. Timing is genuinely "send
time": `state.members` is updated by MODE/353 handlers the FIFO mailbox
processes before the next PRIVMSG routes.

## 2026-06-23 — +k autojoin: dismissable stuck tab (#38) + members-seed guard (#16)

Two +k bugs, run to ground with a deterministic e2e against the real testnet
bahamut (static investigation couldn't reproduce either).

**#16 — members pane stuck "loading…" after keyed JOIN — already fixed.**
bahamut sends 353/366 on a keyed JOIN; the cold-subscribe race is covered by
CP15 B3's after_join `push_members_if_seeded`. New e2e proves it live AND
after a page reload (the deterministic cold WS resubscribe). Closed
already-fixed.

**#38 — a +k autojoin channel can't be dismissed with ×.** grappa
deliberately does NOT persist +k keys: the 001 autojoin loop sends
`send_join(client, channel, nil)`, so every reconnect re-JOINs keyless → 475
→ not joined. That lights BOTH sidebar sources: GET /channels' autojoin
merge (`channelsBySlug`) AND the 475 `join_failed` event
(`windowStateByChannel = :failed`). The render dedup shows the LIVE branch,
whose × routed through `closeChannelWindow` → `postPart` only. Root cause:
for a never-joined channel the upstream PART is a 442 no-op, so NO self-PART
echo arrives — and that echo is the ONLY caller of `setParted`, the verb
that clears windowState. The orphaned `:failed` entry re-emerges as an
un-dismissable greyed pseudo-row the instant `channelsBySlug` drops the
name.

Fix: `closeChannelWindow` also calls `setParted` — the close action's local
effect must not depend on a server echo that only fires for actually-joined
channels. Idempotent with the echo; clearing a key can only emit FEWER
pseudo-rows. Shared helper → mobile BottomBar × fixed too. General class:
any channel in both `channelsBySlug` and a non-`:joined` windowState.

Escape hatches: × dismisses; `/join #chan KEY` re-joins. Auto-rejoining +k
channels (Cloak-encrypted key persistence) is deliberately deferred (vjt
2026-06-23) — storing channel passwords warrants its own design pass.

## 2026-06-23 — Nick completion: irssi-exact + keyboard-free (double-tap)

Goal: nick completion on a STOCK mobile keyboard (no Tab). Rejected an
`@`-mention popup: `@` is the op sigil in NAMES, not a mention trigger —
Slack/Discord muscle memory. Minimal path: a touch trigger on the existing
`compose.ts` `tabComplete` cycle + a semantics fix.

**`tabComplete` rewritten to irssi-exact semantics:**
- Positional suffix: `": "` when the completed word is the first token,
  `" "` mid-sentence.
- Cycle space `[match0 … matchN-1, <typed>]`: forward past the last match
  restores the originally-typed text, THEN wraps. The old code wrapped
  forever with no revert.
- Continuation detected by an anchor RANGE (`cursor ∈ [anchorStart,
  anchorEnd]` AND the anchored span equals the last insertion), not word
  equality — which broke the instant a suffix landed after the caret; the
  range also lets a re-tap INSIDE the inserted nick count as the same cycle
  (load-bearing for the tap path).

**Latent bug fixed: in-app cycling never worked.** `setDraft` nulls the
cycle anchor (correct — a real edit breaks the cycle), but BOTH callers
called `setDraft(result.newInput)` right after `tabComplete`, nulling the
anchor every time — the 2nd Tab always re-entered fresh. The old unit tests
"passed" only because they called `tabComplete` directly, bypassing
`setDraft` — mirror tests on the wrong path. Fix: `tabComplete` writes the
draft itself via `writeState` (does NOT null `tabCycle`); callers only place
the caret. Discard-on-keystroke needs no new code: every real keystroke
flows `onInput → setDraft`, which nulls the cycle.

**Double-tap trigger.** **[SUPERSEDED 2026-06-24 by swipe-right — see next
entry. Dogfood confirmed the word-select collision was real, so the trigger
was swapped. Completion semantics unchanged.]** Two taps within 300ms/24px
fired `tabComplete(…, selectionEnd, true)`; we let the OS word-select happen
then overrode value + caret (iOS `preventDefault` on the system gesture is
unreliable).

**Dogfood checklist (device-only).** iOS, stock keyboard, IRC keyboard OFF,
≥2 prefix-sharing nicks: (1) prefix at line start, trigger → `nick: `; (2)
trigger again → next match; again → reverts to typed text; (3) prefix
mid-sentence → `nick ` (no colon); (4) mid-sentence with trailing text after
the caret → cycle continues on a 2nd trigger; (5) any character typed → next
trigger starts a fresh cycle.

## 2026-06-24 — Nick completion trigger: double-tap → swipe-right

Dogfood confirmed the collision: iOS recognizes double-tap as word-select
before our handler. Rejected (a) preventing the selection — iOS
double-tap-select is a system gesture recognizer that can't reliably be
`preventDefault`'d; (b) broadening to the scrollback — that's
`user-select: text` for copy (Dispatch-1) and completion targets the compose
draft. vjt: **swipe-right** — a gesture the OS does not overload.

**Implementation** (`ComposeBox.tsx` + pure `lib/swipe.ts`; `doubleTap.ts`
deleted). **TOUCH events, not pointer:** only `touchmove.preventDefault`
reliably suppresses iOS native scroll AND drag-to-select. **Crucial Solid
gotcha (code review):** Solid *delegates* `touchstart/touchmove/touchend` to
a single `document` listener, and a document-level touch listener is
`passive: true` per the WHATWG intervention — a JSX `onTouchMove`
`preventDefault()` silently no-ops. So the three listeners are bound on the
textarea element via `ref` + `addEventListener`, `touchmove` explicitly
`{ passive: false }`. Once the drag commits to the horizontal axis we claim
it and preventDefault every subsequent `touchmove`. Caret placed at
`touchstart` (never prevented). Gated to `!ircKeyboardEnabled()` (the custom
keyboard owns the caret + has Tab). **NB: vitest/jsdom does NOT enforce
passive-listener semantics, so the delegation bug passed the unit suite
green — only catchable by reading the framework or dogfooding.**

**Same-day regression + fix (touch-action).** Dragging from the input
dragged the WHOLE shell. Latent hole: `.compose-box textarea` was the one
touchable control with no explicit `touch-action` (default `auto`). The
shell's chrome-gesture block (`.shell-mobile { touch-action: none }`, UX-3
UNDEC R3) defends against chrome/overscroll reveal; inner scroll containers
re-assert their axis. The textarea, being chrome, should have been `none`
all along. Fix: `touch-action: none` on the textarea (tap/focus/caret are
pointer events, unaffected). **Lesson: any new touchable surface in the
mobile shell MUST declare its `touch-action` — `auto` is a chrome-drag
hole.**

**Vertical swipes added (2026-06-24).** RIGHT = Tab, UP = ArrowUp
(`recallPrev`), DOWN = ArrowDown (`recallNext`) — the three keyless
affordances a stock keyboard lacks. Reducers unified to `swipeDirection` +
`dragAxis`; the handler locks to ONE axis on the first move past the slop.
`left` is classified but unmapped (reserved for back-cycle). Vertical swipes
are conflict-free precisely because of the `touch-action: none` fix.

**Synthetic windows must not fetch `/messages` (2026-06-25, grappa-irc#81).**
The selection effect fired `loadInitialScrollback(slug, name)` for *every*
focused window — for `$home` a 404. Harmless alone; lethal in production:
the m42 jail's fail2ban `http-404` filter counts each one, installs a pf
block, and the `pf` jail escalates into `recidive` — a real operator got
locked out at the network layer from one IP. A server-side `ignoreregex`
stopgap protected users during rollout; this is the client root-cause fix.

The symptom was `$home`, but the bug is a *class*: the same fetch 404s for
`$admin` and `mentions` (empty `channelName`). The fix gates on the
**positive** set: `kindHasScrollback(kind)` (`lib/windowKinds.ts`), true
only for `channel`/`query`/`server`. `$server` IS scrollback-backed (the
`NumericRouter` writes its rows), so the issue's "skip any `$`-prefixed
window" heuristic was wrong — it would suppress real server-pane history.
The discriminator is "has a real `(network, channel)` identity" — the same
property that makes a window restorable across reload. The predicate is an
exhaustive `Record<WindowKind, boolean>` — a new `WindowKind` fails to
compile until classified. Single source for the scrollback-fetch gate, the
`saveLastFocused` restore gate, and the two `ScrollbackPane` mount guards.
If a future kind needs scrollback-backed-but-not-restorable, split the
restore gate into its own predicate rather than letting the literals
diverge.

*Lesson: a client-side 404 is not a client-side problem. On a host with an
edge security stack (fail2ban/pf/recidive), a bogus repeated request is an
amplification primitive — one mis-routed GET becomes a network-layer
self-DoS against the real user.*

**Channel directory `/list` — server-side populating snapshot (2026-06-26, #84).**
Upstream `LIST` discovery is a *server-owned* per-`(subject, network)`
snapshot, same posture as scrollback. New `channel_directory` table
(subject-XOR FK like `query_windows`, keyed `(subject, network, channel)`);
`captured_at` NULL until `RPL_LISTEND (323)` finalises, so "has a snapshot"
= "any row has non-nil `captured_at`." `Grappa.ChannelDirectory` owns the
lifecycle (`replace_start` → `ingest` → `finalize`) and server-side
sort/search/keyset-paginated `list/3`; cic never sorts, filters, or
paginates.

**Why per-subject, not network-global.** A shared snapshot forces a
secret-channel-leak apparatus: an opered session sees `+s`/`+p` channels and
`RPL_LIST` carries no modes so they can't be filtered (plus a just-joined
race and stripping the issuer's own memberships). Per-subject isolation
deletes the class by construction. Cost: no LIST dedup across users (~1 LIST
/ 48h / user — fine at small scale).

**Why no background/periodic refresh.** Upstream `LIST` is widely
throttled/abuse-flagged and periodic refresh needs an elected issuer per
network. So: lazy 48h TTL — auto-refresh ONLY on an empty snapshot; `>48h`
serves stale with an indicator; the manual refresh button always nukes +
restreams.

**LIST intercepted only while a refresh is in flight.** `Session.Server`
gains a `directory_refresh` tracker; a dedicated `handle_info` for 321/322/323
sits ABOVE the generic numeric handler, guarded by
`%{directory_refresh: %{}}`. No refresh in flight → numerics fall through to
`$server` scrollback, so a manual `/LIST` is undisturbed. 323 flushes,
finalises, cancels the watchdog (`cancel_and_drain/2`, which also drains a
late timer message). The buffer is reversed before ingest (DB order = wire
order), but `list/3` always re-sorts.

**Populating-window model.** Progress = three pings on the user topic —
`directory_progress`/`directory_complete`/`directory_failed` (atom `kind`,
the `Session.Wire` convention); cic re-GETs its current page on each ping
with scroll preserved, reusing the `"list"` `WindowKind`. No new streaming
surface.

**Watchdog timer + handler ship together.** `Session.Server` has no
catch-all `handle_info`; arming `:directory_refresh_timeout` without its
handler would crash the session on first timeout — arm and handler land in
one commit.

**Config + Boundary.** TTL (48h), timeout, throttle, batch are
`config :grappa, Grappa.ChannelDirectory` keys via
`Application.compile_env`, spec'd `:: unquote(@ttl_ms)` for `:underspecs`
(the `Session.Backoff.base_ms/0` precedent); `config/*.exs` ⇒ COLD deploy.
`Session.Server` → `ChannelDirectory` would close a
`Networks → Session → ChannelDirectory → Networks` cycle, so
`ChannelDirectory` declares `Grappa.Networks.Network` as `dirty_xref`
(schema-only), mirroring `Scrollback`.

*Lesson: a "discovery" feature is a snapshot-plus-stream, not
request/response — a fast `GenServer.call` arms it, the 322/323 burst fills
it asynchronously, the window populates over the existing user-topic
fan-out.*

## 2026-06-26 — visitor PART tab never dismisses (#87): the snapshot the leave path forgot

Prod: `last_joined_channels = ["#italia", "#sniffo"]` while live members
were `["#sniffo"]`. The × sent the PART, the server echoed it, the tab
stuck; re-× drew a 442. The #38 fix closed this for **users** and we assumed
it was closed; it never was for **visitors**.

**Root cause — the leave path bypassed the only snapshot persister.**
`GET /channels` = `union(autojoin-source, live members)`; the autojoin
source is `Credential.autojoin_channels` (users) vs
`Visitor.last_joined_channels` (visitors — also their only rejoin list). The
snapshot is written in exactly one place,
`Session.Server.maybe_broadcast_channels_changed/2` — but the explicit leave
path (`handle_cast({:send_part, _})`) called `broadcast_channels_changed/1`
directly, skipping the persist. Users were masked (their source is pruned by
the controller on DELETE); for visitors the source IS the stale snapshot →
the tab never left. The same staleness made BOTH subjects rejoin the parted
channel on reconnect (`state.autojoin` seeded from the snapshot at boot).

**Fix — one root, two doors, no second-class visitor.**
1. *Session (subject-agnostic).* Extracted `maybe_persist_last_joined/2` as
   the single persister; BOTH the organic path and the `send_part` cast
   route through it. The cast keeps its UNCONDITIONAL broadcast (forces
   cic's refetch even on a no-op eager wipe, per #38/UX-4-H) but now persists
   on a real keyset change — closes case (a) (leaving a live-joined channel)
   for both subjects and kills the reconnect-rejoin.
2. *Controller (symmetric leave).* `remove_from_autojoin/3`'s visitor branch
   was a no-op; now removes from `Visitor.last_joined_channels` via
   `Visitors.remove_autojoin_channel/2` — mirror of the user-side verb.
   Closes case (b): dismissing a stale autojoin entry the visitor is NOT
   live-joined to.

The keyset-change gate means case (a) for one channel never clobbers a
sibling still in the snapshot.

*Lesson: when one struct field doubles as two concepts (live snapshot AND
rejoin source), every write path must funnel through one function — a second
hand-rolled mutation path silently drifts the half nobody watches.*

## 2026-06-26 — `/msg` to a channel-shaped target rejected (#12)

`/msg #x hello` opened an unclose-able phantom window whose message never
rendered: `compose.ts` routed the channel-shaped target through the QUERY
path (`openQueryWindowState` keyed by a CHANNEL name). cic's own-send render
is WS-driven on the per-channel topic (no optimistic append) and cic only
subscribes for JOINED channels, so a `"#x"` query window heard nothing.
`/msg` is for nicks.

**Fix — cic-only parser reject.** The `msg:` parser rejects any IRC channel
sigil (`# & ! +`, per `channelKey.ts`) with `err(verb, "/msg to a channel is
not supported")` — compose.ts hits `case "error"` before `case "msg"`, so no
window opens. Services shortcuts (`/ns` `/cs` …) unaffected.

**Why cic-only (vjt).** Heavier options — a one-shot send + `$server` echo
store, or a server-side reject — rejected as too much code for a dead corner
case on a single-client system. Server `send_privmsg` left as-is.

*Lesson: a window keyed by the wrong kind of name is a silent dead end —
reject the malformed intent at the parser boundary rather than opening a
window the render path can never feed.*

## 2026-06-27 — audio uploads + non-modal mini-player (GH #115)

Audio is a fourth upload category: grappa hosts the bytes, IRC carries a
`🎵 <slug-url>` link, cicchetto plays it.

**A fourth `:audio` category, not "map audio → document" (vjt).** Own cap
(25 MiB — above image's 10, below video's 50), own `🎵` emoji, own player.
MIME set = what modern browsers reliably play: mp3, m4a/m4r
(`audio/mp4` + `audio/x-m4a` + `audio/aac`), wav, flac. **opus/ogg deferred
OUT** — Safari support is patchy and vjt dogfoods on iPhone.

**octet-stream → canonical-MIME extension sniff (scoped breach of the closed
MIME-only allowlist).** iOS/macOS upload `.m4a`/`.flac` as
`application/octet-stream`, which a MIME-only allowlist 415s. `validate_mime`
normalises a generic octet-stream to its canonical audio MIME *by extension*
— audio set ONLY; every other octet-stream still 415s. Serve-side motivation
too: `GET /uploads/:slug` serves `row.mime` as Content-Type, so normalising
at the door makes the served type one the browser plays.

*Follow-up (iPhone dogfood): the server rescue alone was not enough.* cic
gates uploads on `categoryOf(file.type)` BEFORE the request — a file the
browser couldn't type (`.m4r` → empty/octet-stream) was rejected client-side
and never reached the rescue. `normalizeUploadFile` (mirroring
`@audio_ext_canonical_mime`) re-labels such a File at `triggerUpload`; the
server rescue stays for non-cic clients. *Lesson: a leniency added on one
side of a mirrored boundary is dead code if the other side rejects first.*

**Audio is NOT metadata-stripped in v1 (accepted ID3/iTunes leak).** Rides
`MetadataStrip`'s generic pass-through; the strip lockstep pins only
`[:image, :video]`. Documented v1 scope, pinned by `metadata_strip_test` so
a future "strip audio too" is a conscious edit.

**No seed-row migration.** The plan's "video-doc cap migration pattern" does
not exist — those caps are born from code defaults. `read_cap` returns the
default when no row exists; a migration would only force a needless COLD
deploy.

**Docked non-modal mini-player reconciles "mini-player" with "IRC stays text
only".** The invariant bans inline render; the image/video modal is wrong
for audio (you keep reading while it plays). A `🎵` click routes
`kind:"audio"` to a single docked transport bar (`AudioMiniPlayer.tsx` + the
`audioPlayer.ts` identity-scoped store, mirror of `mediaViewer.ts`) pinned
above the compose box — NOT inline, NOT modal. One `<audio>` singleton; a
new click swaps the source. Mounted inside the `kindHasScrollback` Match so
playback survives channel↔query↔server switches; leaving chat stops it
(acceptable v1 — a Shell-root mount is the upgrade).

**The mirror is type-enforced.** Adding `"audio"` to cic's `UploadCategory`
turned every exhaustive `Record<UploadCategory, …>` into a compile error
until each grew an audio arm — tsc flagged surfaces grep missed, including
the `userTopic.ts` WS-payload narrower that would have silently dropped
`audio_per_file_cap_bytes`.

*Lesson: when a closed allowlist must bend, bend it at exactly one named,
extension-scoped door and say why in the moduledoc.*

## 2026-06-27 — Visitor NickServ identify capture: full grammar + single choke point

A prod visitor identified to NickServ yet never upgraded to the infinite-TTL
identified tier. Two gaps in the `+r`-observed commit rendezvous:

1. **`NSInterceptor` matched only `IDENTIFY|GHOST|REGISTER`.** The visitor
   used **`ns id <pass>`** — `ID` wasn't in the alternation → `:passthrough`
   → nothing staged → the `+r` arrived with nothing to commit.
2. **The `{:send_raw}` / cic `/quote` path bypassed capture entirely** —
   capture ran only inside `{:send_privmsg}`.

**Fix.** `NSInterceptor` now covers the full, source-verified azzurra
identify set, anchored `^` so a channel PRIVMSG merely *containing*
"identify"/"pass" can't false-capture; and all three outbound-line paths
(`{:send_privmsg}`, `{:send_raw}`, `flush_lines/2`) funnel through one choke
point in `Session.Server` (`stage_if_ns_identify/2`, renamed
`capture_outbound_ns_secret/2` in #131) — `NSInterceptor.intercept/1` is
called from exactly one site.

**Source-verified identify inventory** (azzurra `bahamut-azzurra` ircd +
`services`):

| Wire form | Path |
|-----------|------|
| `PRIVMSG NickServ[@host] :IDENTIFY\|ID\|SIDENTIFY\|GHOST\|REGISTER …` | direct to services |
| `NS\|NICKSERV IDENTIFY\|ID\|SIDENTIFY\|GHOST\|REGISTER …` | services command alias |
| bare `IDENTIFY\|ID\|SIDENTIFY …` | ircd `m_identify` builds `IDENTIFY <pass>` → `m_ns` |
| `PASS <pass>` / `PASS <nick> <pass>` (post-connect) | ircd `m_pass` → `m_identify` |

Password is the **last** whitespace token for IDENTIFY/ID/SIDENTIFY/GHOST/
PASS; the **first** for REGISTER (`REGISTER <pass> <email>`). The args group
requires a leading non-space (`(\S.*?)`) so a verb-only line is
`:passthrough`, never an empty capture.

**`+r` MODE stays the commit trigger — NOT the "Password accettata"
NOTICE.** `do_identify` emits the `+r` SVSMODE **only when `sameNick`** —
identifying for a protected nick while force-renamed to `Guest…` fires the
NOTICE *but no `+r`*. The NOTICE false-positives on a foreign-nick identify;
the `+r` does not.

**RECOVER/RELEASE deliberately NOT captured; GHOST matched but does not
commit.** They take a password but don't set `+r` — the follow-up IDENTIFY
on the reclaimed nick commits. GHOST's staged capture times out unless the
follow-up IDENTIFY restages (latest-wins via FIFO mailbox). The 10s
`@pending_auth_timeout_ms` is unchanged — the `+r` is synchronous inside
`do_identify`; the timer was never the blocker.

*Lesson: a capture that lives on one of several equivalent code paths is a
capture that doesn't exist — sit at the single choke point every door
funnels through, not the door the happy-path test happened to use.*

## 2026-06-28 — Autojoin recovers +i / +k channels via ChanServ self-INVITE (GH #116)

When bring-up autojoin hits 473 (invite-only) or 475 (bad key),
`Session.Server` sends `PRIVMSG ChanServ :INVITE #chan` and records the
channel in a per-session `awaiting_invite` MapSet. If ChanServ relays an
inbound INVITE (only when the identified account holds ≥VOP), `EventRouter`
emits `{:rejoin_invited, ch}` and the session re-JOINs **keyless**. One
attempt per channel per session (the set is monotonic, never cleared).

**Keyless JOIN works after INVITE (source-verified
`bahamut-azzurra/src/channel.c` `can_join` ~:1919).**
`if (invited || IsULine || IsUmodez) return 0;` is the FIRST check,
short-circuiting BOTH the `+i` test (:1940) AND the `+k` test (:1968) — one
mechanism covers 473 and 475; no stored key needed.

**ChanServ INVITE wire (source-verified `services/src/chanserv.c`).**
`PRIVMSG ChanServ :INVITE #chan` — exactly one arg (a second token errors);
the caller invites *themselves*. Channel must be registered AND caller ≥VOP.
Success: `:ChanServ INVITE <ournick> #chan`. No access / unregistered → a
NOTICE (no INVITE) → window stays `:failed`.

**Autojoin-vs-manual is derived, not flagged.** The retry triggers only when
the failing channel is in `state.autojoin` (set once at boot) — no origin
flag or parallel structure. A manual `/join` of a +i/+k channel hits the
same numerics but isn't in the set → stays `:failed`, cic shows the `[Join]`
CTA.

**HOT-reload safety.** `awaiting_invite` is read via
`Map.get(state, :awaiting_invite, MapSet.new())` / written via `Map.put`, so
a HOT reload of a pre-#116 process (state lacks the key) doesn't crash — same
contract as `in_flight_joins`.

**Inbound `:invite` routing.** In the awaiting set → `{:rejoin_invited, ch}`
(keyless `send_join` + `record_in_flight_join`, `:failed → :pending` →
`:joined` on echo); otherwise → the existing `:server_event` persist path,
preserving the `[Join]` CTA for non-autojoin INVITEs.

**Scope vs #113 and #38.** The no-access / unregistered case is **#113** (key
storage / `/cs info` key-fetch), deferred. This supersedes **#38**'s
stuck-row problem for the has-access case; ×-dismiss remains the answer for
no-access.

*Lesson: when the ircd source shows one mechanism short-circuits multiple
lock types, don't handle 473 and 475 differently — collapse to one code path
and document the source reference.*

## 2026-06-28 — Login attaches to an existing live session for the same identity (GH #117)

When a **registered** visitor logs in and a live `Session.Server` already
serves their identity, `Visitors.Login` now **attaches** instead of
stop-and-respawn — the natural bouncer model (one session, N attached
clients). Makes share-session unnecessary for identified users (it stays for
unidentified guests, whose link IS their auth mechanism).

**The attach verb already existed; #117 just routes to it.** Attaching =
what share-token consume and `Login.issue_token/2` do: mint a fresh
`accounts_sessions` row for the *same* visitor; the new client subscribes to
the visitor's user-rooted topics and rides the live session. Login's Case 2
gained a `Session.whereis/2` branch ahead of `preempt_and_respawn`. No new
mechanism, no new noun.

**Session key = identity = `{:visitor, visitor.id}`** — per
`(nick, network_slug)`, so the same NickServ account re-resolves to the same
registry key from any client. Derived from the existing visitor row — no
account/identity table.

**Attach routed BEFORE the capacity gate; password-first before both.**
Capacity verbs gate *new session spawns* — an attach spawns nothing, so
gating it is wrong: a returning identity already counted would be blocked at
the visitor cap, and a circuit-open would block an attach the live session
proves reachable. Case 2 now: (1) check the password (auth first — leak no
cap/circuit state to a wrong-password attempt), (2) branch on `whereis`:
live pid → attach (ungated); `nil` → capacity gate + `preempt_and_respawn`
(unchanged).

**Attach does NOT revoke prior tokens; the respawn path still does** —
multi-client semantics require other attached clients' tokens to stay valid;
the respawn path keeps revoking tokens pointing at a dead session.

**#116 autojoin is not re-run on attach — automatically:** no spawn →
`init/1` never fires. Satisfied by the absence of a spawn, not a flag.

**Users already attached:** `AuthController.mode1_login` only mints a token;
user sessions are Bootstrap-managed. #117's scope was purely the visitor
Case 2 path.

*Lesson: when a second use case already has a verb in the codebase, the
feature is a routing decision, not a new mechanism — find the branch point
and keep the old path's gates (capacity = spawn-gate) from leaking onto the
new one.*

## 2026-06-28 — Multi-file paste/drag-drop upload: sequential queue (GH #118)

**The finding first.** #118 ("paste & drag-and-drop upload") was already
shipped — commit `8f1a76b` (2026-05-15) wired `onPaste` +
`onDrop`/`onDragOver` → the shared pipeline six weeks before the issue was
filed, multi-category, with progress/cancel/retry. The issue's "splice the
URL into the draft at the cursor" *contradicts* the shipped invariant — vjt
confirmed **auto-send stays, no draft splicing**.

**The one real gap:** every entry point uploaded the **first file only**,
and the orchestrator is single-slot per channel
(`inflight: Map<ChannelKey, ActiveUpload>`) with re-trigger *aborting* the
in-flight upload — so multi-file is not "loop the handler".

**Decision (sequential queue, not parallel).** Per-channel FIFO `queue` in
`uploadOrchestrator.ts`: a batch uploads one at a time through the unchanged
`dispatchUpload` pipeline; each settle pumps the next; each success
auto-sends its own emoji-URL (N files → N messages). Parallel multi-slot
rejected — needs an inflight list + multi-row progress UI + per-row
cancel/retry addressing, heavier than the problem.

**Settle semantics:** success → pump next; **error** → *pause* the batch
(dismiss = skip-and-continue, retry = re-run at queue front); **cancel** →
stop the whole batch; **decline the privacy modal** → cancel the whole batch
(never silently re-dispatch queued files).

**Deliberate behavior change:** re-triggering during an in-flight upload now
**queues** instead of abort-and-replace — the first upload is never lost.
The #49 contract holds: a fresh selection *after a failed upload* supersedes
the error — so an error entry does NOT count as "active" in `isActive`
(counting it broke #49 and leaked a stale batch total).

**Privacy gating stays per-file.** The ack persists in localStorage on first
upload, so a batch never re-prompts; a user who declined "remember" is asked
per file — honoring their explicit choice. No per-batch ack state to
housekeep.

*Lesson: "challenge the spec" caught a feature that post-dated its issue.
Reuse the verbs; add only the queue.*

## 2026-06-28 — One rfc1459 nick casemapper everywhere (GH #121)

**Bug (P0):** a visitor reconnecting with a different-case nick was not
recognised: the visitor lookup was case-SENSITIVE `Repo.get_by`, so it
provisioned a SECOND visitor/session, the orphan held the nick, and
`/nick Mezmerize` bounced 433.

**Root class, not the instance.** Nicks were folded THREE inconsistent ways:
visitor table not at all; `query_windows` + the WHOIS/userhost/whowas caches
+ `dm_peer` + numeric_router via ASCII-only `String.downcase`; event_router
self-detection via exact `==`. None handled azzurra's real casemapping:
**bahamut = rfc1459** — besides `A-Z` it folds `[ ] \ ~` → `{ } | ^`. Fix
unifies EVERY server-side nick comparison — "total consistency or nothing".

**`Grappa.IRC.Identifier.canonical_nick/1`** — single source of truth.
**ASCII-only** byte-level fold, deliberately NOT Unicode `String.downcase/1`:
rfc1459 is defined over ASCII and bahamut compares byte-wise; and the
migration backfill computes the same fold in pure SQL
(`replace(...lower(x)...)`) where SQLite `lower()` is ASCII-only — a Unicode
fold would diverge from the stored index. UTF-8 multibyte passes through
untouched.

**Storage: derive, don't denormalise.** First cut added a `nick_folded`
column; vjt rejected the parallel state (every write path would have to sync
it). Final shape mirrors the existing `lower(target_nick)` index: a UNIQUE
**expression index** on the rfc1459 fold of the existing column (SQLite can't
fold brackets in `lower()` but can in an expression index via nested
`replace()`s). Both `visitors` and `query_windows` got it; lookups fold at
query time via `Identifier.nick_fold/1` — an Ecto fragment macro kept
**character-identical** to the migration SQL so the query stays
index-eligible. The migrations dedup pre-existing case-variant rows before
swapping the index (visitors: keep identified > permanent > newest;
query_windows: keep MAX(id)). Two migrations → COLD deploy.

**In-memory sweep.** `EventRouter.normalize_nick/1` (cache keys), the paired
`Session.Server` key sites, `PartCleanup`'s userhost eviction,
`numeric_router.nick_eq?/2`, `Scrollback.dm_peer/4` + self-DM +
`delete_for_dm`, and the ghost_recovery/chanserv service-nick checks all
route through `canonical_nick`. Self-detection moved from exact `==` to
nil-safe `nick_eq?/2`; the self-nick MODE clause dropped its exact-match
dispatch **guard** (you can't fold in a guard) and branches in the body.

**Scope boundary (deliberate).** The in-memory members map keys and
`state.nick`-as-identity are NOT folded: identity preserved from the
authoritative upstream stream (self-consistent about case within a session),
not case-insensitive MATCH sites. Folding them is a members-map restructure
(`{folded => {display, modes}}`), filed as follow-up, not smuggled into a P0.

**Reattach (#117).** Once `lookup_visitor` folds, a different-case reconnect
resolves to the same `visitor.id`, so the #117 attach path reattaches
instead of duplicating.

*Lesson: when the key is a pure function of a column you already have, an
expression index derives it with zero drift — the existing
`lower(target_nick)` index was the pattern to copy.*

## 2026-06-28 — GH #105: unbind never deletes the network (cascade-on-empty removed)

`Credentials.unbind_credential/2` now ONLY detaches the credential row and
stops the live `Session.Server` — no "last binding?" computation, no network
delete on empty, no scrollback consult, no transaction; return narrowed to
`:ok`. **Reverses the cascade-on-empty + scrollback-gate** of the 2026-04-26
entry (annotated superseded). `Grappa.Networks.delete_network/1` remains the
single explicit operator verb that drops a network row, still refusing on
`{:credentials_present, n}` and `:scrollback_present`. Unbind = per-user
detach; delete = deployment-wide teardown.

**The bug.** Visitor scrollback lives under `messages.network_id` with a
`:restrict` FK. Unbinding the LAST user credential from a network still
carrying visitor scrollback made the cascade try to delete the network; the
FK blocked, `Repo.rollback(:scrollback_present)` fired, and the WHOLE unbind
aborted. Worked around in prod with a direct row delete.

**Why drop rather than fix the gate (vjt).** Simpler, and the real win: no
conflation of "no user credentials remain" with "delete the network" —
different questions. A zero-binding network is a valid state: shared
per-deployment infra; visitor scrollback follows the visitor lifecycle, not
the credential lifecycle.

**Invariant dropped on purpose.** The 2026-04-26 "networks rows exist iff ≥1
binding" property is gone — ghost networks are accepted; the operator runs
`delete_network/1` deliberately.

Kept (live machinery behind `delete_network/1`, not dead code):
`Scrollback.has_messages_for_network?/1` and the FallbackController
`:scrollback_present → 409` clause.

## 2026-06-28 — Featured channels: on-display read, not a /me snapshot (#85)

Operator-curated featured channels per network (`network_featured_channels`,
mirroring `network_servers`), surfaced read-only (HomePane one-click-join,
visitors, `featured` label on `/list` rows). Admin CRUD under
`/admin/networks/:id/featured_channels`.

**Delivery decision (vjt).** #85 said "deliver in `/me`". Rejected:

1. **`home_network_row/2` is shared by the cold `/me` AND the live
   `connection_state_changed` broadcast.** Featured in that row means the
   broadcast must preload + re-send it on every connect/park/fail, or cic's
   full-row overlay (`home.ts`: `live[slug] ?? row`) **wipes** featured on
   reconnect — static curation riding a dynamic heartbeat.
2. **Config has its own lifecycle.** A `/me` snapshot is login-time; an
   operator edit wouldn't reach a connected user until next login. The fix
   is not a PubSub push (overkill for rarely-changing config) — it is
   **re-reading current config when the surface displays.**

**What shipped:** on-display read, never in `/me`, never on the
connection-state event. HomePane fetches `GET /networks/:network_id/featured`
on home display (mount = re-read). The `/list` directory response gains
`featured: boolean`, re-derived server-side from the current enabled set on
every fetch; `ChannelDirectory.Wire.index_payload/2` takes a downcased-name
`MapSet` (channel fold == downcase; the boundary has no `IRC` dep). No
top-pinning — sort unchanged. `home_network_row` + broadcast untouched. The
public endpoint rides `:resolve_network` + the existing nginx `networks`
allowlist alts — no nginx change.

**No admin PubSub events for featured CRUD** (unlike `ServersController`):
featured config never touches a live `Session.Server` — no session-count on
delete, no live-state another admin must see mid-edit; the panel refetches
on its own action. Deliberate divergence, not an omission.

**Case-fold.** `network_featured_channels.name` stored lowercased
(`Identifier.canonical_channel/1`); `(network_id, name)` unique on the
stored fold.

## 2026-06-28 — `/list` directory rework: overlay back, shared topic render (#125)

Cic-only rework of the `DirectoryPane` (`$list`). Four durable decisions:

**Topic colors ride the ONE mIRC renderer.** `MircBody` (+ private
`renderRun`) moved from `ScrollbackPane.tsx` into `MircText.tsx`;
DirectoryPane consumes it for the topic (raw server string with `\x03` bytes
→ same `parseMircFormat` → `renderRun` path as bodies). One-parser invariant
at the display layer: cic never parses IRC *framing*; `parseMircFormat` only
expands already-received wire bytes. Exactly one display-time mIRC module.

**`$list` is a transient overlay with a one-deep back pointer.** Close must
restore *the window active when it opened*. `selection.ts` keeps a single
`backTarget: SelectedChannel`, captured **only** on the genuine
non-list → list transition (inside `setSelectedChannel`, after the
idempotency guard) so background selection churn can't clobber it.
`closeToPreviousWindow(fallbackSlug)` restores it iff `selectionIsRestorable`
(channel/query must still be live; home/server/admin/mentions always;
`list`/`null` never), else the shared fallback chain. NOT a history stack —
one pointer, reset on identity rotation. The directory is excluded from MRU
(`mru.ts`); the back pointer is the only "return here" state.

**One fallback chain, shared.** The close-window picker (UX-4 bucket E)
already computed MRU → the network's server window (if connected; visitor
networks always count connected) → home; extracted as
`resolveFallbackWindow(excludeKey, fallbackSlug)`, called by BOTH bucket E
and `closeToPreviousWindow`. Deliberate divergence: `selectionIsRestorable`'s
`server` case is NOT `connection_state`-gated (restoring the prior window
beats bouncing to home; bucket D pre-empts the parked case).

**Responsive layout, zero horizontal scroll.** `.directory-row-join` is a
CSS grid: mobile 2-row, desktop (`min-width: 40rem`) 3-column. No-h-scroll is
structural: `minmax(0, …)` track + `min-width: 0` on grid children +
`overflow-wrap: anywhere` + `overflow-x: hidden` backstop. Topic wraps
fully; sort stays user-count DESC; featured labelled, not pinned.

## 2026-06-28 — register→auth-code +r promotion: untimed second capture slot (#129)

The captured secret was held in `pending_auth` for ~10s and committed on
`+r`. Correct for **identify** (`+r` is synchronous); wrong for **register**:
services email an auth code and flip `+r` only minutes-to-hours later on
`/ns AUTH <code>` — the timer discarded the register secret first, so a
freshly-registered nick stayed ephemeral forever. (The issue's framing —
"register doesn't trigger capture" — was wrong: `NSInterceptor` already
captured REGISTER; the secret *expired*.)

**In-memory hold, no DB / no migration.** An unconfirmed register password is
in-flight work, not truth — it becomes truth only on `+r`, where the
**existing** `Visitors.commit_password` → `expires_at = NULL` path persists
it. Held in GenServer state, never written unconfirmed;
`password_encrypted set ⟺ permanent` stays pristine.

**Two slots, one commit verb (reuse the verbs, not the nouns).** The shared
verb is "commit on the `+r` transition"; the 20% that differs is retention
lifecycle:
- **identify** → `pending_auth` + 10s timer, unchanged — still the
  wrong-password guard (a wrong identify never gets `+r`, times out).
- **register** → new **untimed** `pending_registration_secret`, held until
  `+r` (commit + clear) or `terminate` (GC with the session).

That lifecycle difference is the domain boundary, so it earns separate state
— a timed/untimed type-flag on one field would be the "shared data model
with a type flag" anti-pattern. `NSInterceptor` returns
`{:capture, :identify | :register, password}`; `Session.Server` maps verb →
slot.

**One `+r`-observation primitive, register wins.** `EventRouter` emits
`:visitor_r_observed` from a single `+r` site reading BOTH slots; if both
populated, register wins (correct-by-construction: a wrong register never
gets `+r`; a stale wrong identify could still be inside its 10s window).
`apply_effects/2` commits the winner and clears BOTH slots;
`:pending_auth_timeout` clears only the timed slot. Same primitive #90
(post-registration `+r` fallback) must share — one detector, not two.

**Known limitation (transition, not state).** If the connection drops
between `/ns register` and `/ns auth`, the in-memory secret is lost and the
later `+r` is not auto-persisted. Recovery is NOT in-place: after `/ns auth`
the user is already `+r`, so an in-place identify emits no new `+r`
(`do_identify` guard) — the user must quit and log back in via the cicchetto
login form (identify-at-001 → a real `+r` transition → captured in the 10s
window). Accepted: a DB-backed cross-restart hold would reintroduce the
unconfirmed-secret-at-rest problem this design avoids.

## 2026-06-28 — activation scroll flicker: hide-until-settled, NOT remove the double-rAF (#130)

Cic-only. On window activation the scrollback briefly painted at the wrong
scroll offset, then snapped: `.scrollback` is the SAME DOM node across the
swap (non-keyed `<Match>`), so `scrollTop` carries over; the correcting
scroll runs inside `scrollToActivation`'s **double-rAF** — after the browser
painted the new rows at the stale offset.

**The double-rAF is load-bearing — do NOT "simplify" it away.** Synchronous
pre-paint scrolling has been tried: the activation `createEffect` runs BEFORE
Solid's `<For>` commits the new rows (effect creation order), so a
synchronous read sees stale geometry; `queueMicrotask` fires before layout
settles. Both observed leaving the pane ~66px short of true bottom (CI
sentinel + prod dogfood, 2026-05-23). rAF×2 is the only reliable "rows
committed AND layout settled" point. There is no Solid `useLayoutEffect` — a
React concept.

**Fix the *visibility*, not the *timing*.** An `activating` signal sets
`visibility: hidden` (NOT `display: none` — layout/`scrollHeight` must stay
readable) synchronously at activation and clears it inside the rAF body once
the scroll lands. Cost: ~2-frame hidden window. Guards: cold/empty windows
skip the hide (the length-effect owns their first snap; they can't strand
hidden); the reveal runs in EVERY rAF-body exit path; both activation
triggers (key-change + visibility-return) share `scrollToActivation`.

## 2026-06-28 — bare /whois /w in a channel window self-whoises (#132)

Cic-only follow-up to #122 (bare `/whois` defaulted to the active QUERY
partner, errored elsewhere). A channel window's obvious default is self:
`resolveBareWhoisNick` in `compose.ts` branches query → partner; channel →
self via `ownNickForNetwork(net, me)` (the canonical resolver, NOT
re-implemented); other window kinds → inline error (deliberately out of
scope). The context default lives in the compose consumer, never the parser
— `slashCommands.ts` still emits `{nick: null}` for the bare form, so `/w`
and `/whois` inherit through the shared handler with zero parser change.

## 2026-06-28 — in-session NickServ SET PASSWD kept in sync (#131)

An in-session NickServ password change through cicchetto must update the
stored credential, or the next auto-identify fails. This is the
**capturable slice** of #124 (split-brain on stale password); #124 stays the
record for the uncapturable cases (`RESETPASS`, out-of-band changes),
recovered by the re-auth-on-identify-failure prompt.

**Capture — one parser, extended not forked.** `NSInterceptor` (#129's choke
point) gains a third verb class `:set_passwd` matching
`PRIVMSG NickServ :SET PASSWD <new>`, `NS|NICKSERV SET PASSWD <new>`, bare
`SET PASSWD <new>`. Two Azzurra facts, source-verified:
- The verb is `SET PASSWD`, **not** `SET PASSWORD` — `do_set` only routes
  `PASSWD`. The regex matches the literal; `SET PASSWORD …` falls through
  untouched (unit-pinned).
- The new password is **rest-of-line**, not a token — Azzurra parses
  `strtok(NULL,"")`, so it may contain spaces; never split on the first
  space.

cic needs zero changes: `/ns set passwd …` already emits a `PRIVMSG NickServ`
body the server captures (one-parser invariant). A pre-validating cic
affordance was scoped OUT for v1.

**Commit — optimistic on-send, NOT a +r rendezvous (the crux).** `SET PASSWD`
from an identified session emits **no `+r` transition**, and NickServ
success-NOTICE scraping is **banned** (#91 — fragile per-network text
parsing). With no confirmation signal, the capture commits **immediately**
when the well-formed line leaves the wire: the user is authenticated, it's
their own deliberate change, success is the common case. That commit-now vs
stage-against-`+r` difference is why `:set_passwd` is a distinct kind, not a
flag on an existing slot.

**Reuse the commit verbs, both homes — but NOT the +r promotion verb for
visitors.** Users: new `Credentials.commit_password/3` via a narrow
`Credential.password_changeset/2` (only `password_encrypted`, keeping the
`safe_line_token` wire-hygiene guard — the value is re-interpolated into the
next IDENTIFY/PASS). Visitors: NOT the +r path's `commit_password/2` — that
verb also flips `expires_at = NULL`, only safe behind the `+r` proof of
identity. A SET PASSWD carries no such proof, so reusing it would pin an
unidentified anon visitor permanent and un-reapable on a line services never
accepted (an unauthenticated self-promotion vector; flagged in review).
Visitors get identity-gated `Visitors.rotate_password/2`: rotates only for an
already-identified row, `{:error, :not_identified}` for anon. The choke point
(renamed `stage_if_ns_identify` → `capture_outbound_ns_secret` for honesty —
it now commits as well as stages) dispatches on subject via injected
`visitor_password_rotator` / `credential_committer` — the same
Boundary-cycle-avoiding function-reference indirection as `credential_failer`.
Both commit verbs carry the H14 `Ecto.StaleEntryError → {:error, :not_found}`
guard: they run synchronously inside the send handler, so a concurrent
unbind/delete must not crash the session.

**Backstop for the stale-stored-password window.** An optimistic commit that
didn't take (Azzurra rejects — insecure / over-`PASSMAX` / same-as-current —
or grappa's send fails after the commit) leaves the stored password ahead of
services. Both are the stale-password case #124's re-auth prompt already
recovers — the accepted, bounded cost of no confirmation signal. (cic length
pre-validation deferred; Azzurra's `PASSMAX` is the authority, not a
fabricated client constant.)

## 2026-06-28 — whois/lusers cards float in an overlay, not the scroll flow (#133)

WHOIS/WHOWAS/LUSERS cards and the peer-away banner rendered as flex siblings
BEFORE `.scrollback`; mounting one shrank the scroll list and moved the
reader's `scrollTop`. chan-reported.

**Fix — one overlay layer, not the named two.** All four move into a single
absolutely-positioned `.scrollback-overlay` (`top/left/right: 0`,
`z-index: 5` — above the scroll list, below the scroll-to-bottom button at
10). The issue named only whois/lusers, but the **general class** was
"top-pinned ephemeral affordance in the scroll flow shifts the reader's
anchor" — all four shared it. Reuse the verbs, not the nouns.

**What stays inline.** Invite-ack rows are NOT chrome: message-stream content
interleaved by wallclock into `rows()`. The overlay holds only top-pinned
lookup/context affordances; a new stream row does not belong there.

**Click-through + bound.** Container `pointer-events: none` (taps fall
through to uncovered scrollback); each direct child re-enables its own box.
`max-height: 100%` bounds the layer to the pane — the ComposeBox is a sibling
OUTSIDE `.scrollback-pane` — so a pathologically tall card can at most cover
the scroll list, never intercept compose taps; `overflow-y: auto` scrolls
overflow rather than clipping the close affordance.

**Close (×) tap target.** ~14px glyph → the project's 44px Apple-HIG standard,
one shared rule over all four `*-close` classes; negative block margins pull
the button back out of the compact header (margins don't shrink the hit
area).

**Test shape.** jsdom computes no layout, so the structural contract (card
inside `.scrollback-overlay`, scroll list outside) is the unit assertion;
real-geometry claims (containment + the 44px box) are pinned in the c2
Playwright spec via `boundingBox()`.

## 2026-06-28 — route channel-scoped traffic by channel reference; inbound INVITE opens an `:invited` window (#78, folds #128)

**The bug as filed was misdiagnosed.** #78 framed cic as routing by sender
and called for a `subscribe.ts` fix. cic routes purely by subscription topic,
mirroring the server's persisted `message.channel` — the misrouting was two
**server-side** decisions in `EventRouter`; the channel reference was
destroyed before cic saw it.

**Case (a) — services PRIVMSG to a channel.** `privmsg_default` re-keyed
*every* services-sender PRIVMSG to `$server`. That override exists to
suppress cic's dm-listener query-auto-open for **NICK-targeted** traffic — a
channel target can't auto-open a query, so it must not apply. Now gated on
`not channel_target?(channel)`: services PRIVMSG to `#chan` lands in `#chan`,
symmetric with the channel-NOTICE arm. `channel_target?/1` is a pure prefix
predicate kept byte-identical to the NOTICE arm's inline `when` guard (Regex
is illegal in guards, so the two decisions share the prefix shape, not
`Identifier.valid_channel?/1`).

**Case (c) — inbound non-awaiting INVITE → new `:invited` window state.**
Previously fell through to `:server_event` on `$server` (#128's complaint).
Decision (vjt): **open the invited channel's own window** — persist the
INVITE row AT the channel (`persist_raw_event(msg, state, channel)`) and emit
`{:invited, channel}`; `apply_effects` flips `window_states[channel] =
:invited` and broadcasts `window_invited` on `Topic.user/1` — the same
chicken-and-egg user-topic origination as `window_pending` (cic joins the
per-channel topic only AFTER seeing the state). Guard skips flip + broadcast
when already `:joined` (a stray INVITE must not grey a joined tab), though
the persist row still lands.

`:invited` is a genuine **new window state**, not a reuse: `:pending` implies
our own JOIN in flight, `:failed`/`:kicked` carry reason/kicker, `:parked` is
the T32 idle placeholder — none model "a not-joined channel someone invited
me to." Threaded server→cic per the invariant: `WindowState.set_invited/2`,
`Wire.window_invited/2`, `apply_effects`; cic `windowState.ts`
(`setInvited`), `api.ts`, `userTopic.ts`, and the `subscribe.ts`
pre-subscribe loop (now joins on `"invited"` as well as `"pending"`). The
Sidebar greyed pseudo-row + the `renderRawEvent` INVITE `[Join]` CTA are
inherited for free.

**UX shape (vjt):** NO foreground on receipt — the window opens silently as a
greyed tab carrying the one persisted INVITE row as its unread item.
`to_wire/3` returns `:not_tracked` for `:invited` (same as `:pending`):
learned via the user-topic broadcast, not the cold-reconnect snapshot.
Durability across reload is bounded — the row persists in scrollback and
surfaces via the archive if the live tab is lost; a durable invited-set
judged out of scope for v1.

**Deploy note:** the reframe makes this a server change — full prod deploy,
not the cic-bundle-only path #78 assumed.

---

### 2026-06-28 — #140: /names is a client modal over a buffered names_reply, not a scrollback dump

`/names [#chan]` used to drain the 353/366 burst into TWO persisted
`:notice` rows — a stale snapshot persisted as bouncer wire history,
replaying as noise on reconnect.

**Decision:** `/names` joins whois (#133) and `/list` (#84) as an
**ephemeral query response** — buffered server-side, emitted as ONE typed
event, rendered client-side, NEVER persisted. The buffer already existed
(`names_pending`, mirroring the whois accumulator); the change is the
emission tail — the 366 drain emits one `{:names_reply, channel, roster}`
broadcast on `Topic.user/1` instead of the two persisted notices.

**The gate (load-bearing):** grappa consumes 353/366 on EVERY JOIN to seed
the member map. The names accumulator is GATED on a pending explicit
`/names` — `drain_names_pending` no-ops unless `names_pending[downcase(chan)]`
exists. One parser, two consumers: seeding ALWAYS fires on JOIN; `names_reply`
only when the operator asked. `members_seeded` stays authoritative for the
sidebar; `names_reply` is a parallel VIEW carrying the same roster shape,
tier-sorted via the same `member_sort_tier`. cic never parses IRC —
prefixes split server-side (`split_mode_prefix` → `%{nick, modes}`).

**Render — overlay modal, NOT a message-area row (vjt, against #140's literal
wording).** Injecting a row into `rows()` is exactly the scroll-anchor
problem #133 fled. `NamesModal` is a centered, backdrop-dimmed, scrollable,
dismissable dialog (mirrors `ArchiveModal`/`ShareSessionModal`), fed by a
per-network last-write-wins store (`namesModal.ts`, mirrors `whoisCard.ts`):
grouped Operators/Halfops/Voices/Users sections with counts. "Consistent with
whois #133" means consistent in *ephemerality*, not *placement* — the roster
is large and clickable, so a modal, not a top-pinned card.

**Deploy:** hot (pure module swap) + a cic bundle. The dead
`:names`/`:names_target` Logger-metadata allowlist keys are RETAINED:
removing them touches `config/config.exs`, forcing a COLD deploy — batched
into the next cold window rather than dropping every live session for two
dead atoms.
## 2026-06-29 — NamesModal mobile fixes: overlays anchor to the visible viewport, not `inset: 0` (#143)

Three mobile defects on the #140 `NamesModal`, all cic-only.

**Keyboard occlusion.** `.names-modal-backdrop` was `position: fixed;
inset: 0` — the full LAYOUT viewport — while the VISIBLE region
(`visualViewport.height`) is shorter with the iOS keyboard up, so
`align-items: center` parked the modal's centre at the layout-viewport
midpoint, dropping its lower half behind the keyboard. The `max-height`
cap bounds size, not ANCHOR. Fix: backdrop spans only the visible region
— `top: 0; height: var(--viewport-height, 100dvh)` instead of `inset: 0`.

**No `offsetTop`, deliberately.** Re-anchoring with
`visualViewport.offsetTop` is the approach UX-6-D (2026-05-21) buried
after 11 attempts: `offsetTop` is WebKit-broken (#297779, stuck at 24px
post-dismiss) and the `translateY(offsetTop)` cancel failed across D6/D8.
`installSmartScrollPin` already clamps `vv.offsetTop`→0, so `top: 0` +
`--viewport-height` is sufficient AND landmine-free. This is the reusable
mechanism for any keyboard-aware overlay (e.g. the #66 message-list):
consume `--viewport-height`; do NOT reintroduce an `offsetTop` track or
the `vv.scroll` listener D9 dropped.

**Cosmetics:** denser roster rows (irssi columnar, vjt ask); close ×
bumped to the project-standard 44px Apple-HIG tap target (#133 precedent).

**Test honesty.** chromium's layout viewport == its visual viewport (no
OS keyboard), so `names143-modal-mobile.spec.ts` asserts the CSS CONTRACT
with `--viewport-height` pinned to a keyboard-shrunk value; real
occlusion needs Mezmerize dogfood before final close. cic-only deploy.

---

## 2026-06-29 — #78 redo: the `:invited` e2e gate was vacuous; pin it to a `data-window-state` seam

Reopened complaint: `:invited` "does not work in practice,"
`b2-inbound-invite-cta` suspected a false positive. Verified empirically:
the full chain (server `do_route(:invite)` → `{:invited, ch}` →
`window_invited` on `Topic.user/1` → cic `setInvited` → Sidebar greyed
pseudo-row) is intact — #140's EventRouter refactor never touched the
`:invite` clause. **No broken derivation to fix.**

**The gate was weak, not the feature.** The assertion checked only
`.sidebar-window-greyed`, shared across EVERY not-joined state
(`pending`/`invited`/`failed`/`kicked`/`parked`) — it could not
distinguish `:invited`.

**Fix.** The pseudo-row `<li>` now carries
`data-window-state={row.state}` (same stable-seam pattern as
`data-window-name`/`data-kind`); the spec asserts
`data-window-state="invited"` BEFORE the generic greyed check. Mobile
`BottomBar` renders no pseudo-rows at all (pre-existing gap for every
not-joined state, out of scope); the seam lives only on the desktop
`Sidebar`, its sole renderer — nothing half-migrated. cic-only deploy.

---

## 2026-06-29 — #146: a tapped DM notification must OPEN the query window, not just select it

**P0: tapping a push notification stopped landing on the conversation
that fired it.** Channels were fine; the DM branch was broken. Both
deep-link paths — warm `applyPushTarget` (SW→page navigate) and cold
`applyPushTargetFromUrl` — did only `setSelectedChannel`. Correct for a
channel (a highlight implies joined); wrong for a DM: the server never
auto-creates a `query_windows` row for an inbound DM (only cic's
`open_query_window` push does). A DM tapped when no query window exists —
the canonical case, DM arrived while cic was closed — selected a window
never opened: dead selection, "tap did nothing."

**Root cause = a skipped verb.** Every OTHER DM-open site (compose
`/msg`+`/query`, NamesModal, UserContextMenu, subscribe.ts inbound-DM)
calls `openQueryWindowState` BEFORE `setSelectedChannel`. **Fix: reuse
the verb.** A shared `routePushTarget/1` handles both call sites — for
`kind:"query"` it resolves the network, canonicalises the nick,
`openQueryWindowState`, then selects. DRY across warm + cold so the
open-then-select contract can't drift. (Cold-path push is safe
pre-WS-join: `joinUser` sets `_userChannel` synchronously and Phoenix
buffers the push until the join ack.)

**E2E and the harness ceiling.** `notif-tap-focus.spec.ts` covers channel
+ DM on both drives; DM cold path reproduced RED. Driving the real SW
`notificationclick` is not achievable headless (proven:
`showNotification` rejects even after `grantPermissions`;
`focus()`/`openWindow()` need transient activation) — substitutes: COLD =
`page.goto(deepLink)` (exactly the SW's `openWindow` branch), WARM =
replay the navigate message onto the real `installPushTargetListener`.
cic-only deploy.

---

## 2026-06-29 — #148: `/oper` is visitor-eligible (the gate relaxes for oper ONLY)

**P0: let a VISITOR socket issue `/oper`.** Pre-#148 the shared
`dispatch_ops_verb/3` chain ran `check_not_visitor/1` →
`visitor_not_allowed`. Live repro: Mez was `+r` but IRC-side identify
does NOT swap the cic WS token visitor→user (that promotion gap is
grappa-irc#129); #148 sidesteps #129 by relaxing the gate directly.

**Why safe:** Registry keys carry the FULL subject tuple, so
`{:visitor, uuid}` gets its OWN `Session.Server` (the "visitor pool" is
an IP pool, NOT a shared IRC session) — opering authenticates only its
own upstream link, and the upstream O:line is authoritative; the bouncer
gate was belt-and-suspenders.

**Fix:** route `oper` through the visitor-eligible
`dispatch_subject_verb/3` (`resolve_subject/1` → subject-shaped thunk);
`Session.send_oper/4` already accepted `subject()`.

**→ Superseded 2026-07-01 by #153 (below).** The "only oper moved" scope
no longer holds: #153 removed the identity gate for ALL verbs and DELETED
`dispatch_ops_verb/3` + `check_not_visitor/1`; the visitor-op boundary
test was flipped to assert the verb ships upstream.

---

### 2026-06-29 — #142: every user-text surface routes through the one mIRC renderer

mIRC control bytes (`\x02 \x03 \x04 \x0f \x1d \x1f \x1e \x11 \x16`)
leaked RAW into the DOM on presence/system lines and inline cards; the
channel buffer already rendered correctly.

**Invariant — one renderer, no raw `{body}`.** Every user-originated text
surface in cic MUST render through `MircBody`
(`cicchetto/src/MircText.tsx` over `parseMircFormat`). A new
text-emitting surface MUST use `<MircBody body={…} />`, never a bare
`{body}`/`{reason}`/`{trailing}` interpolation — a raw drop silently
re-opens this bug. Chrome around the text stays plain; the four
paren-wrapped reason/trailing sites (PART/QUIT/KICK reason, KILL
trailing) share one `reasonSuffix` helper in `ScrollbackPane.tsx`.

**Purely a cic sweep — VERIFIED.** The server preserves IRC bytes
verbatim end-to-end: `strip_unsafe_bytes/1` removes ONLY `\x00 \r \n`;
the whois wire path (`whois_trailing/1` = `List.last/1`, plain `Map.get`)
is byte-preserving. No server change.

**Surfaces wrapped:** `ScrollbackPane.tsx` (KILL trailing,
INVITE/default fallbacks, reasons, TOPIC body, server_event fallback);
`TopicBar.tsx` (strip + modal body; the `title` tooltip is
plain-text-only, so it gets `mircPlainText/1` — de-formatted via the ONE
parser, NOT a second lossy stripper); `WhoisCard.tsx`; `WhowasCard.tsx`
(realname); `MentionsWindow.tsx` (row body + own away reason, found by
defensive grep). Audited + excluded as genuinely structured:
names/MembersPane (`NickText`), LusersCard + lusers numerics (already on
the NOTICE path), AdminCredentialsTab realname, WhowasCard
server/logoff_time.

**Follow-up (same day, vjt prod) — the "structured" exclusion was
wrong.** The first pass excluded WhoisCard umodes,
actually_host/actually_ip, server_info as "structured server-identity".
Prod whois leaked codes there: on azzurra a services-set colored vHost /
swhois and a formatted server description carry mIRC bytes straight
through — those fields ARE services-influenced free text, now wrapped.
The rest stay plain (`user@host`, server, idle/signon, channels, target).
**Lesson: never exclude a whois field as "structured" without real-wire
evidence — services let users colorize identity fields.** Pinned in
`WhoisCard.test.tsx`; a real-wire e2e can't reproduce (the testnet ircd
emits clean 326/378).

**Tests.** `issue142-quit-mirc-render.spec.ts` (QUIT reason
bold+red+reset; RED pre-fix). Gotcha: the mIRC classes only touch
font-weight/style/decoration/family/filter — none set
`display:inline-block` or `white-space:pre` — so inline spans inherit the
topic strip's `nowrap`/`ellipsis` truncation. cic-only deploy, zero `.ex`
changed.

---

## 2026-06-29 — the visitor landing experience: CRT loading splash + reworked home pane (#134 + #135)

Bundled — same surface, both **cic-only**. The welcome text is a static
cic string (operator-editable per-network welcome split to #136).

**#134 — retro CRT loading splash (LOADING-ONLY).** Replaced the bare
`<Switch fallback>` placeholder in `Shell.tsx` with `CrtSplash.tsx`
(pattern mirror of `InstallSplash.tsx`; theme-aware,
`prefers-reduced-motion`-aware). Load-bearing constraint: **loading-only,
not a persistent empty state.** The fallback only renders while
`selectedChannel()` is null — the cold-load window before the auto-select
effect lands on `$home` — so the fallback IS the loading state.
`CrtSplash` self-gates on the **same predicate the auto-select effect
waits on** (`!user() || channelsBySlug() === undefined`; createResource
is `undefined` while loading, a resolved `{}` is loaded), so it clears on
the same reactive tick as the handoff — no parallel "still loading"
notion to drift, no infinite spinner.

*Why a component test, not an e2e:* a transient loading screen is
e2e-hostile — gone the instant the page loads (the #78 vacuous-gate
failure mode). `CrtSplash.test.tsx` drives the predicate both ways.

**#135 — visitor home pane = welcome + featured + directory link.**
Three sections: refreshed welcome copy; the #85 `FeaturedLinks`
(optional `heading`, gated on has-links); the new "📇 Browse channels"
affordance — reuses `ConnectedRow.onBrowse` EXACTLY (a `kind:"list"`
deep-link into the #84 `DirectoryPane`, keyed on `visitorSlug()`), NOT a
new navigation path. Sections 2+3 gate on `visitorSlug()` so a null slug
can't dispatch a network-less `$list`. Tests: `HomePane.test.tsx` (RED
without the browse control) + `issue135-visitor-home-landing.spec.ts`.
cic-only deploy, zero `.ex` changed.

## 2026-06-29 — `--full-restart`: bind a new jail vhost in ONE bounce

**Problem.** Binding a NEW jail vhost needed TWO session-drop windows: a
normal cold deploy AND a host `bastille restart grappa` — twice the
downtime, plus a half-applied state between.

**Shape.** `deploy.sh --defer-restart` (cold-path only) runs the cold
path through `vite build → migrate → stop → wait-stopped →
jail_install_rcd`, then prints a staged message and exits 0 — release +
rc.d wrappers on disk, daemon NOT running. The host wrapper
`deploy-m42.sh --full-restart` then does ONE `bastille restart grappa`,
booting the staged release through the NEW wrapper and binding the vhost.

**Order is load-bearing (unchanged).** stop→wait→rc.d-refresh→start
exists so the OLD daemon stops through the wrapper that started it
(2026-06-11 defect #9); `--defer-restart` cuts AFTER the rc.d refresh, so
the host bounce is just the deferred start.

**The marker moves to the host.** `runtime/last-deployed-sha` signals a
COMPLETED deploy to the next auto deploy's nothing-to-do guard; on the
defer path the deploy is intentionally incomplete, so deploy.sh must NOT
write it. The host wrapper writes it only AFTER its post-bounce
healthcheck, reading the jail's OWN HEAD (not a host-passed sha — a
sibling push could race the host's view).

**Defer is cold-only.** It defers a *stop*; the hot path has none. Both
`--force-hot --defer-restart` and an auto-classified-HOT run abort, exit
64.

**Scope.** Host-side `jail.conf`/`grappa.env` vhost edits stay manual.
Never rehearsed against prod; proven by bats only
(`test/infra/deploy_jail_test.bats`, `deploy_m42_test.bats`). First real
run is the next genuine cold deploy.

---

## 2026-06-29 — #156: the in-pane unread divider needs an ANCHORED fetch when unread exceeds the window

**Symptom.** Channel with unread > the initial page (~50): the divider
slams to the TOP with a window-sized count and no read-context — or fails
to inject.

**Root cause.** `loadInitialScrollback` fetched a TAIL-ONLY page. The
divider derives from the FROZEN `markerCursorId` snapshot (freeze
contract, 2026-06-08) + `sessionTopId`; when the cursor is OLDER than the
oldest loaded row, the anchor rows are not in the loaded set — every row
has `id > cursor`, so the count is the whole window and the marker
injects at index 0. The freeze contract was never the problem; the loaded
ROWS were.

**Fix (cic-only — REST verbs existed).** With a cursor present, fetch
AROUND it: `listMessagesAfter(cursor, 200)` (unread region, capped at
server `@max_http_limit`) + `listMessages(cursor + 1)` (last-read row +
~50 rows context; integer ids, so strict `< cursor+1` is `<= cursor`).
Both merge via `mergeIntoScrollback`; the no-cursor arm keeps tail-only.

**Gate signal: cursor presence, NOT a server unread count.** The count
exists only in `selection.ts` (`serverSeedCounts`); reaching it from
`scrollback.ts` means an import cycle or signature threading — heavier
than one extra small GET per open. Worse, a count-vs-window gate couples
cic to the server's ~50 page-size constant, and the seed count measures a
different row set than the marker's filtered count. Unconditional
anchored fetch is window-size-agnostic; a fully-read channel's
`after(...)` returns 0 rows.

**>200 cap (known edge).** With true unread > 200 the after-page stops at
`cursor + 200`; divider stays anchored, count caps at the loaded window
(honest about what's loaded). **CORRECTION (#161, 2026-07-01 below):**
the original claim that rows past `cursor + 200` "stream in via the
join-ok `refreshScrollback`" was WRONG — that fetches from the SAME
resume cursor with the SAME cap, and there was no forward-paging handler.
The newest rows were UNREACHABLE, not deferred; #161 adds `loadNewer`.
The divider-anchoring reasoning stands.

**Tests.** Unit RED→GREEN (`scrollback.test.ts`,
`loadInitialScrollback.test.ts`); e2e
`unread-divider-beyond-window.spec.ts`, proven RED against tail-only.

---

## Lifecycle verbs — detach / disconnect ⇄ reconnect / quit (#126, 2026-06-29)

Two lifecycle actions were conflated, and **detach was broken**. vjt
standardized the full **(web client × upstream IRC)** matrix:

|              | upstream UP                          | upstream DOWN                              |
|--------------|--------------------------------------|--------------------------------------------|
| **web UP**   | normal                               | `disconnect` (drop upstream, stay in cic) ⇄ `reconnect` |
| **web DOWN** | `detach` (leave cic, keep upstream)  | `quit` (close cic + tear down upstream)    |

**Subject classes split by NickServ identity:** registered **user**
(`connection_state` column), registered **visitor**
(`visitors.password_encrypted` non-nil ⟺ permanent), **ephemeral**
visitor (Reaper-swept). detach + disconnect/reconnect are
persistent-identity-only; quit is universal.

**Two bugs, one root.** Pre-#126 `DELETE /auth/logout` tore down the
upstream for EVERY subject, and never transitioned `connection_state` nor
broadcast — the credential stayed `:connected` with the live pid gone
(violating "DB state and live state are separate sources of truth").
Fix: **detach is the ABSENCE of teardown.** Logout only revokes the web
session + closes the socket; the lone exception is the ANON visitor,
which keeps the W11 co-terminus teardown (stop + `purge_if_anon`) — no
persistent identity to come back to. An ephemeral visitor's "quit" IS
this anon logout.

**One disposition core, every door.** teardown =
`Session.stop_session/3`; respawn = `SpawnOrchestrator.spawn/4` (the same
cores `Networks.disconnect/2` / `NetworksController` use). Routing:
**user** — detach = logout; disconnect/reconnect = the existing
per-network `PATCH /networks/:slug {parked|connected}` (a user has many
networks; a whole-session verb is ambiguous); quit = `quitAll` (park all)
+ detach. **Registered visitor** — detach = logout; new
`POST /session/{disconnect,reconnect}` (registered-visitor-gated); quit =
disconnect + detach (row + scrollback KEPT — `purge_if_anon` no-ops a
registered visitor). **Ephemeral visitor** — quit only; the rest withheld
(403 server-side + cic-gated).

**#152 seam.** #152 (ident live-apply) needs "tear down upstream, respawn
preserving row + scrollback" — exactly `Visitors.reconnect_session/3`'s
shape with a CHANGED plan at the resolve step. Seam left open. New
`Admission` flow `:visitor_reconnect`.

**Visitor connection surface.** Visitors have NO `connection_state`
column, NO broadcast — live status is whereis-derived. `GET /me`
(visitor) gained `connected: boolean` from `Session.whereis/2` (a cheap
`Registry.lookup`, NOT a `GenServer.call` — `/me` stays off blocking
Session calls) + derived `registered: boolean` as the cic gate. NO schema
change, NO new PubSub event; the verb handler refetches `/me`.
Sibling-tab consistency is best-effort — acceptable for a deliberate
single-tab action.

**Terminology.** Canonical everywhere: detach / disconnect / reconnect /
quit. User-facing "logout" is RETIRED; `DELETE /auth/logout` stays as
plumbing (it IS detach). `delete account` (#157) is the separate
irreversible wipe — quit NEVER wipes a persistent identity.

**Tests.** Server: detach-keeps-the-session (no `:DOWN`, pid +
`connection_state` survive) for user + registered visitor; anon
stop+purge unchanged. E2E `issue126-detach-lifecycle.spec.ts`. The
registered-visitor round-trip is server-+vitest-covered, not e2e — it
would need the full NickServ REGISTER dance on the testnet (more flake
than the gate is worth); the user-analog has
`cp15-b6-parked-disconnect-reconnect.spec.ts`.

## delete account — the irreversible nuke (#157, 2026-06-29)

`quit` PRESERVES a persistent identity; **`delete account` is the ONLY
self-service door that destroys it** — distinct verb, affordance,
confirm; the server NEVER wipes on quit.

**Subject routing (`Grappa.AccountDeletion.delete_account/1`)** —
forbidden cases pattern-matched FIRST so wipe clauses carry no negated
guards: **admin user → `:forbidden`** (an operator removes an admin via
`DELETE /admin/users/:id`, which keeps the last-admin lockout guard);
**non-admin user →** stop ALL live `Session.Server`s, then
`Accounts.delete_user/1`; **anon visitor → `:forbidden`** — nothing
persistent (server-side defense-in-depth, not reliance on the cic gate);
**registered visitor →** `Session.stop_session/3` then
`Visitors.delete/1`.

**Teardown → wipe ordering** mirrors `Operator.delete_visitor/2`: stop
the live session BEFORE `Repo.delete` so an in-flight scrollback persist
can't trip a `*_id` FK and the GenServer drains via `terminate/2`.
`ON DELETE CASCADE` on every subject-keyed FK (verified at the
migrations) wipes dependents in one transaction.

**Two doors, one core.** The wipe primitives existed;
`Operator.delete_visitor/2` (admin door) adds admin-event emission +
actor attribution, `AccountDeletion` (self-service) adds self-only gating
and emits NO admin event. The new top-level boundary module owns the
cross-context orchestration so no existing context grows the others'
deps.

**The door: `DELETE /me`** (subject-routed, thin). Chosen over a new
`/account` prefix because `/me` already rides the nginx allowlist + SW
navigation denylist — no proxy/SW change. Socket close is shared via the
extracted `UserSocket.disconnect_subject/1` (one socket-teardown path).

**The irreversibility gate is cic-side.** A two-tap
`InlineConfirmButton` is too weak: `DeleteAccountModal` keeps the button
DISABLED until the operator types their exact account name/nick
(`displayNick(me)`, no trim/casefold). `lib/lifecycle.deleteAccount`
PROPAGATES errors (unlike quit/logout's best-effort swallow) so a failed
wipe does NOT clear the local bearer. The drawer affordance shows only
for a registered non-admin user or registered visitor (reactive `/me`
flags — a mid-session demote flips it).

**Tests.** `Grappa.AccountDeletionTest` — including the **#126 boundary
asserted explicitly**: a registered visitor's row SURVIVES
detach/`purge_if_anon` but is WIPED by `delete_account`;
`me_controller_test`; `issue157-delete-account.spec.ts` (user wipe
RED-provable; registered-visitor visible wipe hits the same NickServ wall
as #126 — server-unit + vitest instead).

---

## 2026-07-01 — #146 recurrence: the SW→page navigate swallows on a rejecting `focus()`

**vjt: tapping a push notification again opens no window.** The June fix
(cic ROUTING) is live and correct in prod; the recurrence is one layer
lower — SW→page DELIVERY. `focusOrOpen`'s warm path did
`await existing.focus(); existing.postMessage({type:"navigate",url})`.
`WindowClient.focus()` **rejects** (`InvalidAccessError`) when
`notificationclick` lacks transient activation — iOS/WebKit reject even a
genuine tap — and the rejection threw **before** `postMessage`, so the
deep-link never reached the page. A no-silent-swallow violation:
`focus()` is a nicety, never a gate on navigation. (Cold path
`openWindow` has no `focus()`, so the original DM-while-closed case kept
working.)

**Fix.** SW-safe, vitest-testable `lib/swNavigate.ts`
`deliverNavigate(client, url)`: post FIRST, then focus best-effort in
`try/catch`. Cold path unchanged.

**Why the June e2e missed it.** It drove COLD via `page.goto` and WARM
via a synthetic MessageEvent — both bypass the real `focusOrOpen`. The
June "undrivable headless" verdict was half-wrong: the handler CAN be
driven — dispatch a real `notificationclick` into the live SW via
`context.serviceWorkers()[0].evaluate(...)` with a synthetic
notification. `notif-tap-sw-handler.spec.ts` does that (RED against the
old ordering); `swNavigate.test.ts` pins
post-fires-even-when-focus-rejects; `notif-tap-sw-controlled.spec.ts`
guards SW-controlled precache serving of the deep-link. cic-only deploy.

---

## #160 — virtual-tab read-cursor POST bans legit users via fail2ban (2026-07-01)

**Prod incident (P0).** Selecting the Home/directory tab made cic
`POST /networks/$home/channels/$home/read-cursor` (and `$admin`/`$list`).
Those pseudo-windows have no server row, so the POST 404s/400s; nginx
feeds the 4xx to m42's fail2ban `http-404`/`http-400` jails
(`maxretry 20`) — a user idling on Home gets banned, then escalated into
`recidive` (long-bantime **pf** block cutting the IP off the whole host,
**web AND IRC**). At least one legit beta user hard-banned.

**Root cause.** `ScrollbackPane` is a single non-keyed instance with
reactive getter props bound to `selectedChannel()`. Selecting a
non-backed tab disposes the pane; its `onCleanup` cursor-flush reads
`props.channelName` — which by then already points at the VIRTUAL
selection — and POSTs there. The comment claiming props "won't change
before unmount" was false for this shared mount shape. The read side
(`/messages`) was already gated by `kindHasScrollback` (grappa-irc#81);
the write side had no twin.

**Fix.** Guard at `setReadCursor` — the single chokepoint all six
settle/blur/leave/unmount call sites funnel through. New
`isVirtualWindowName/1` in `windowKinds.ts` (write-edge twin of
`kindHasScrollback`): true for `$home`/`$admin`/`$list`/`mentions("")`.
`$server` is deliberately EXCLUDED — a real `NumericRouter`-backed target
the server accepts, so cic must still write its cursor. Nicks and
channels (`#/&/+/!`) can never collide with `$`-sentinels. Guarding at
the POST boundary makes the invariant robust against future writers:
"never emit a channel-scoped request for a window with no server-side
row," enforced on BOTH edges.

**Not fixed (flagged, latent, pre-existing).** The same leak means
leaving a real channel FOR a virtual tab doesn't flush the real channel's
cursor on that transition. The settle timer already advanced it, so
impact is a lost last-scroll within the 500 ms settle window — benign.
Proper fix = snapshot the displayed `(slug, channel)` for `onCleanup`;
follow-up.

**Defence-in-depth.** fail2ban `ignoreregex` for `/read-cursor` 40[04]
added to both jails on m42 — a safety net; the cic suppression is the
real fix. The server route is NOT changed — virtual tabs correctly have
no cursor.

**Test.** Unit `setReadCursorVirtualGuard.test.ts` (no POST for the four
virtual names; POST for `#chan` and `$server`); e2e
`issue160-virtual-tab-no-cursor.spec.ts`, RED against the disabled guard.
cic-only deploy.

---

## 2026-07-01 — #159: activation/visibility/reconnect freshness re-fetch (silent one-channel message loss)

**The bug (P0, prod).** One channel silently STOPPED rendering new
messages — rows on the server, no error, quiet pane; only recovery was
force-close + reopen. Silent loss is worse than a visible error: the
operator trusts an empty pane to mean "nothing new."

**Root cause.** The only catch-up verb, `refreshScrollback` (resume
cursor, `?after=<id>` capped 200, id-deduped, never touches the frozen
divider), was called from **only** the per-channel join `"ok"` callbacks.
Activation ran the load-once-gated `loadInitialScrollback` (re-selecting
fetched nothing); visibility/focus refreshed badge COUNT, mentions,
scroll — never CONTENT; the socket-open resync skips `joined.has(key)`
and relied on phoenix.js re-firing each join `"ok"`. **Net:** any
delivery gap NOT coinciding with a (re)join — socket stays `"open"`, one
channel's fan-out severed — had no recovery except a full reload.

**Fix — one verb, three new call sites (reuse, not duplicate).** All
through `refreshScrollback` (idempotent, per-key in-flight-guarded):
1. **Activation** (`selection.ts`) — for windows ALREADY LOADED before
   this activation (a re-select). (Shipped unconditional; narrowed to
   re-select-only hours later — the unconditional fire starved a
   just-opened query window's join-ok safety net. See the regression
   entry below.)
2. **Visibility** (hidden→visible) — deliberately NOT folded into
   `scrollToActivation`: that routine early-returns on an empty pane,
   precisely the gap case to heal; the fetch must run independent of pane
   geometry.
3. **Reconnect** (socket-open resync) — for EVERY key in `joined`, so
   recovery is cic-driven, not dependent on each rejoin's `"ok"`.

**Untouched by design.** The load-once gate and the #156 anchored-fetch /
frozen-divider contract stay — the gap was the ABSENCE of a re-fetch. The
freshness fetch never re-baselines the read cursor.

**Test.** `freshness-on-activation.spec.ts` covers the socket-STAYS-open
gap the two socket-drop specs don't, via a new test seam
(`__cic_suppressChannelDeliveryForTests`) silencing one topic; asserts
the missed row becomes VISIBLE after re-select and after hidden→visible —
the rendered row, never a fetch spy. RED against the disabled call sites.
cic-only deploy.

## 2026-07-01 — #159 regression: activation refetch vs a fresh query-window's live delivery

**The regression (P0, CI).** The #159 ship turned
`cp13-s5-msg-ghost-401.spec.ts` FLAKY (~1 in 3): `/msg <ghost>`
intermittently dropped the 401 ERR_NOSUCHNICK notice in the just-opened
query window. It slipped because the worker ran
`integration.sh --grep <own-spec>` — the exact gap behind the full-suite
mandate.

**Mechanism (proven by instrumentation — NOT a clobber).** Both fetch
verbs are append-only id-deduped merges; the notice was NEVER FETCHED OR
DELIVERED. The 401's two paths into a fresh ghost window: the live WS
push, and the join-ok `refreshScrollback` REST safety net. #159's
activation refetch fired FIRST on a fresh open — before the server
round-tripped the 401 — grabbing the per-key in-flight lock and returning
`[]`; the join-ok safety net then found the lock HELD and returned early.
When the live push was ALSO missed (broadcast before the subscription
wired), both paths were lost. Traces of a red run confirmed: one
`?after=0` GET returning `[]`, no join-ok GET, no live push — while the
join reply's `unread_count: 2` proved the 401 was persisted and any later
fetch would have found it.

**Fix (preserve #159; guard ONLY item 1).** The #159 gap is specifically
"RE-selecting an ALREADY-LOADED tab"; a FRESH open is covered by
`loadInitialScrollback` + live WS + join-ok refetch and must NOT fire the
activation refetch. `scrollback.ts` exposes a synchronous
`wasLoaded(slug, name)` probe over its own `loadedChannels` Set (single
source of truth — no parallel tracker, per "derive, don't duplicate"),
captured BEFORE `loadInitialScrollback` — which adds the key
SYNCHRONOUSLY, so a post-call `has` read is always `true` even on a first
open; the naive guard does not work. Items 2 and 3 unchanged: both fire
only for already-established windows, never a settling fresh open.

**Tests.** cp13-s5 flaky-red → reliably green (12× repeat-each);
`freshness-on-activation.spec.ts` stays green. Full chromium suite with
NO `--grep` is the merge gate. cic-only deploy.

## 2026-07-01 — #163: off-by-one unread — last message never stays read when pinned to bottom

**Symptom (vjt prod, P1).** Channel A read at the bottom → select B → A's
badge returns to **1 unread**, and re-selecting A re-injects the divider.

**Root cause — the leave-arm never ran (a Solid `on`+`defer` trap), NOT
geometry.** The cursor write for the LEAVING window on a
channel↔query↔server switch (pane stays MOUNTED — one shared
`kindHasScrollback` Match, so no `onCleanup`) lived inside the activation
effect `createEffect(on(key, …, {defer:true}))`, guarded by
`prevKey !== undefined && prevKey !== newKey`. But Solid's
`on(deps, fn, {defer:true})` skips the mount call and returns **before**
assigning its internal `prevInput` (verified in `solid-js/dist/solid.js`),
so the FIRST real key change after mount gets `prevKey === undefined` —
the guard skipped the first genuine leave after every mount AND remount.
No cursor written → phantom "1 unread." Proven by runtime
instrumentation: on `#bofh → $server` the leave-arm logged once with
`prevKey` undefined and zero cursor POSTs. "Pinned to bottom" is just
where a skipped write is *visible*.

An earlier hypothesis — a strict-`>` fractional off-by-one in
`lastFullyVisibleRowId` — was refuted as the repro (the walk landed on
the true tail in the runner); it remains a real but browser/zoom-dependent
hazard.

**Fix.** (1) **Split the leave-arm into its OWN
`createEffect(on(key, …))` WITHOUT `defer`** — a non-deferred effect runs
at mount (the guard skips it) AND Solid assigns `prevInput`, so the first
real change carries a defined `prevKey`; the activation effect keeps
`defer:true` (its mount run would clear the auto-focus scroll — the bug
was piggy-backing the leave-arm on it). (2) **Choose the id from the
leaving pane's own snapshot — `id = snapshotted ?? storeTail`, NOT
`atBottom()`.** `atBottom()` is unreliable here: the sibling activation
effect runs in the SAME key-change batch and `setAtBottom(true)`s first —
instrumentation caught it true with the pane 407px off the bottom, which
regressed `cursor-forward-only.spec.ts`. The captured onScroll
`visibleTailSnapshot` is the honest source (a post-hoc DOM walk can't be
used — `<For>` has already swapped rows); absent (pure auto-follow) fall
back to store-tail. (3) **Kept the `lastFullyVisibleRowId` at-bottom
short-circuit** (DOM true tail within `SCROLL_BOTTOM_THRESHOLD_PX`) —
correct-by-construction against the fractional drop, and load-bearing for
(2): it makes the snapshot equal the true tail at the bottom.

**Invariants preserved.** `setCursorIfAdvances` stays forward-only. Read
state stays server-owned — this only changes which id cic COMPUTES on
leave. #156 and #159 contracts untouched.

**Test.** `unread-off-by-one-on-leave.spec.ts` (badge 0 + no re-injected
marker — rendered outcome, never a cursor spy; RED pre-fix). Full
`integration.sh` (NO `--grep`) is the merge gate. cic-only deploy.

---

## 2026-07-01 — #161: the newest messages were unreachable after the #156 anchored fetch — no scroll-to-bottom forward-paging

**Symptom.** Unread > 200: the divider anchors correctly, but scrolling
to the BOTTOM never reveals the newest messages — the pane bottoms out at
`cursor + 200`.

**Root cause.** #156's after-page stops at `cursor + 200`; its claim that
the rest streams in via the join-ok `refreshScrollback` was WRONG
(corrected at the #156 entry) — same resume cursor, same cap. And NO
forward-paging handler existed: `loadMore` pages OLDER rows only.
`[cursor+200 .. true newest]` was unreachable.

**Fix (cic-only).** `loadNewer` (`lib/scrollback.ts`), the mirror of
`loadMore`: on scroll-to-bottom, if not at the live tail, pull
`listMessagesAfter(highestLoadedId, 200)` and merge via the same
`mergeIntoScrollback`. `onScroll` fires it near the bottom
(`distance ≤ LOAD_MORE_THRESHOLD_PX = 200`, mirrored). NO scroll restore
— forward rows APPEND below the viewport (loadMore prepends above, which
is why only it needs the height-delta correction).

**The growing-tail latch (the 20% NOT symmetric to loadMore).**
`loadMoreExhausted` is permanent because the older end never grows; the
newer end GROWS via live WS appends, so a permanent latch would strand
rows — but the naive "invalidate on every append that advances max" is
worse: every WS row would clear the latch, auto-follow would re-fire
`loadNewer`, `after(newMax)` returns empty → one REST GET per message.
Resolution rests on an invariant: ordinary live appends are CONTIGUOUS —
each appended row IS the server's newest — so `after(max)` stays empty
and the latch stays CORRECT as `max` advances. The ONLY way a forward gap
re-opens after latching is a `refreshScrollback` batch that hit its
200-row cap (a >200-message reconnect); so the latch is invalidated at
exactly ONE site — a capped refresh page
(`page.length === REFRESH_LIMIT`) — and NOWHERE else. After invalidation
auto-follow drains the gap page-by-page until an empty page re-latches: a
bounded cascade, not a per-message storm.

**Why it can't fight #156 or #163.** `loadNewer` only changes which ROWS
are loaded — never the cursor or the frozen
`markerCursorId`/`sessionTopId` snapshots. Forward-paged rows have
`id > sessionTopId`, excluded from the divider's `(cursor, sessionTopId]`
count — the freeze contract holds. Per the #163 lesson, the gap is
derived from loaded-id vs the fetched page, NOT from the unreliable
`atBottom` signal.

**Tests.** Unit RED→GREEN (`scrollback.test.ts`: fetch shape, concurrency
guard, asymmetric latch). E2E `issue161-forward-paging.spec.ts` (260
seeded rows, early cursor, scroll-to-bottom pages to the true newest; RED
against unmodified code). cic-only deploy.

---

### 2026-07-01 — #153: every state-changing verb is visitor-eligible (the identity gate is gone)

**P0 (vjt): visitors and users alike send every command.** #148 relaxed
`/oper` only; #153 generalizes to EVERY verb (`/op /deop /voice /devoice
/kick /ban /unban /umode /mode /topic_set /topic_clear` + `/quote`).
Pre-#153 those hit `check_not_visitor/1` → `visitor_not_allowed`.

**The issue's own mechanism was wrong — challenge-the-spec.** The body
said "drop `check_not_visitor`, KEEP `safe_get_user`." But
`safe_get_user/1` resolves a `users` row and a visitor's `user_name` is
`"visitor:<uuid>"` → `user_not_found`; and every thunk hard-built
`{:user, user.id}`, targeting a session a visitor doesn't own. De-gating
per the spec just moves the rejection one line down.

**Correct fix = consolidate onto the ONE visitor-eligible helper.** Every
ops verb now routes through `dispatch_subject_verb/3` (the helper #148
and #31 already used): `resolve_subject/1` (`"visitor:"<>id →
{:visitor, id}`, else `safe_get_user` → `{:user, id}`) hands the thunk
the SUBJECT. This PRESERVES every validation — `validate_args`
(identifier/CRLF/NUL), `with_body_check` BodyLimit on
kick/umode/mode/topic, the REV-E/REV-F `upstream_unavailable` catch-all —
and keeps `safe_get_user` (the spec's "keep" meant keep that VALIDATION).
All `Session.send_*` facades already accept `subject()`.
`topic_set_dispatch/5` de-gated the same way. Users are byte-identical.

**Dead code removed (mandatory for green).** `dispatch_ops_verb/3`,
`check_not_visitor/1`, `visitor?/1`, and the two unreachable
`:visitor_not_allowed` else-arms deleted — Dialyzer flags unreachable
arms and `--warnings-as-errors` fails on the orphan.
`dispatch_subject_verb/3` is the SOLE dispatch path for every
`handle_in/3` verb.

**`/quote` now passes EVERYTHING — intended.** A visitor can send
adminserv/stats/rehash and any raw line. Deliberate: the ircd O:line +
services are the real authority; the bouncer keeps only the CRLF/NUL
frame-safety gate (`validate_args`), which runs BEFORE identity
resolution.

**Tests.** The visitor `visitor_not_allowed` tests FLIPPED to assert the
verb ships upstream (never assert removed behavior); the
visitor+invalid_channel test pins validate_args-runs-first. E2E
`issue153-visitor-state-verbs.spec.ts`: an independent peer client
WITNESSES the `/quote PRIVMSG` and `/mode +m` arriving from upstream —
the visible upstream effect, not a client spy.

**Deploy:** server change — COLD (drops live IRC sessions), night-batched
per the no-daytime-cold-deploy standing order.

## 2026-07-02 — #155: native /stats + /rehash (cic-only sugar over the #153 raw path)

**CIC-ONLY.** `/stats [query] [server]` and `/rehash` become native cic
parser commands whose dispatch builds the raw frame via the existing
`pushRaw` (the path #153 de-gated), with its `.receive(ok/error)`
no-silent-drop contract (#154). Native-parser sugar over an existing
transport, like the #20 services shortcuts. NO server change: the
`NumericRouter` scan-then-server fallback already routes the STATS
numerics (211–219, 240–250) and 382/481 — not delegated/active — to the
`$server` window as `:notice` (the same mechanism as #148's 381).
Empirically confirmed on the testnet.

**Build-defer.** Rides #153 (merged, not yet deployed): build + test +
merge + push, ship in the same night pass after #153 goes live.

**The NON-oper e2e flushed out a real bahamut bug.** The first `/rehash`
e2e opered first and reproducibly SIGSEGV'd the testnet leaf. Root cause
(GH #164, fix PR azzurra/bahamut#26): bahamut's custom `irc_printf`
(src/ircsprintf.c) reads `%d/%i/%u` with `va_arg(ap, unsigned long)` — a
64-bit read of a 32-bit int; on LP64 the garbage high bits make a small
value ~14 digits, whose backward itoa underflows the global
`char num[12]` and clobbers the adjacent `KList1`; REHASH →
`clear_conf_list(&KList1)` frees the garbage → SIGSEGV. `-O2`-only
(layout adjacency). Verdicts: `/rehash` by oper CRASHES; via adminserv
CRASHES; `/stats` by anyone does NOT (all 22 letters survive). So the e2e
never opers: a visitor's `/stats u` renders 242 and `/rehash` renders 481
ERR_NOPRIVILEGES (proves frame shipped + reply rendered), both in
`$server`; RED pre-fix. Keeps the suite green.

**Testnet pinned to the fix.** `cicchetto/e2e/infra` pins `BAHAMUT_REF`
to `refs/pull/26/head`; revert to `master` once #26 merges (GH #165).

---

## 2026-07-02 — #154: MODE-family reliability (no-silent-drops + own-nick MODE render)

Two bugs Mez hit on a visitor socket, one cluster.

**(1) Ops-verb errors swallowed (cic, `--cic`).** The nine
`pushChannel{Op,…,Umode}` helpers were fire-and-forget — no `.receive`,
and `compose.ts` set `result = {ok:true}` synchronously, so a server
`{:error,_}` (or WS-down) painted a green ✓ on a dropped state-changing
frame. The server already replies for every one of these. Fix: a shared
`pushUserChannelVerb/2` gives all nine the `pushOper`/`pushRaw` promise
shape (typed `ChannelPushError`); compose arms `await` → shared catch →
`friendlyChannelError` inline banner; known-code union extended with the
ops-verb tokens. `banlist` stays fire-and-forget (read-only, numerics
pipeline); `invite` left as-is (noted follow-up).

**(2) Own-nick MODE produced no visible feedback (server, COLD).**
EventRouter's user-MODE-on-self branch DELIBERATELY dropped the echo, so
`/umode +a`, the connect burst, +r at IDENTIFY, and services-pushed +a
all rendered nothing. Reversed with vjt's sign-off: the self-branch now
persists EVERY own-nick mode transition as a `:mode` row on the synthetic
`"$server"` window — GENERAL, not per-mode-letter (Mez's explicit ask) —
keeping the orthogonal `:visitor_r_observed` effect. Direct mirror of the
NICK self-rename `self_server_effects` (#61). cic renders the `"$server"`
form as "sets user mode +x"; no real channel is ever named `"$server"`
(reserved `SERVER_WINDOW_NAME`), so the routing target is an unambiguous
discriminator. `:mode` is a presence kind on both sides → no unread
badge / OS notify.

**What the guardrail proved.** A static end-to-end trace first
established 221 RPL_UMODEIS and channel MODE ALREADY render — the only
gap was the own-nick echo the server dropped, flipping #154 from
`--cic`-only to **COLD + `--cic`**. "cic can't EMIT own-nick MODE" was a
MISDIAGNOSIS: the emit paths exist end-to-end; the perceived failure was
absence of *feedback* (bug 2 + the bug-1 swallow). No new emit code.

**Deploy coupling.** Rides the #153/#155 night window: #153 +
#154-server fold into ONE cold restart (zero extra session drops), then
#155 + #154-cic ship `--cic`. Build-deferred.

---

### 2026-07-02 — #168: one always-bottom scroll authority (P0 regression fix)

**Symptom (P0 regression).** After sending, the pane yanked UP to the
unread divider. The unread-anchor cluster (#156/#161/#163) left
`ScrollbackPane` with **two** authorities writing `scrollTop`, racing —
the scroll-to-marker anchor won on activation (parking mid-pane,
`atBottom=false`), so a send didn't follow to the tail.

**The scrollTop writers, and what became of each:**
- **`scrollToActivation`** (switch, visibility, resize): marker branch +
  tail branch → **collapsed** to always-tail. *(Rescoped 2026-07-03 —
  this over-reached: it also killed the jump-to-marker on a deliberate
  channel-SWITCH; a `mode` param restores it for that trigger ONLY, via a
  one-shot `querySelector`, no `markerRef`; see the 2026-07-03 entry.)*
- **length-effect `on(rows().length)`**: first-render marker branch +
  atBottom tail-follow → **collapsed** to the tail-follow only.
- **#130 channel-switch reset** — reuses `scrollToActivation`, inherits.
- **`scrollToBottom`** (floating button) — already tail-only, kept.
- **`onScroll` loadMore/loadNewer scroll-restore** — pagination
  bookkeeping, semantically distinct; untouched.

The `markerRef`/`markerScrolled` signals fed only the deleted marker
branches — deleted. The REV-G H23 stale-ref machinery stays dead even
after the 2026-07-03 rescoping: the restored switch-only jump uses a
one-shot `querySelector` inside the settled-geometry rAF — no long-lived
DOM pointer.

**Final scope (vjt + Mez).** ALWAYS scroll-to-bottom; NO event-type
branching. irssi-shape: new content ⇒ bottom, the operator pages up
manually. `atBottom` (derived scroll-position state) still gates the
tail-follow.

**Reconciliation with the divider-freeze contract (2026-06-08).** #168
SPLITS its two facets: (1) *scroll-position* — the tail (rescoped
2026-07-03: divider is a scroll anchor ONLY on a deliberate SWITCH);
(2) *divider-display* — the `── XX unread ──` row still renders at its
frozen `markerCursorId` position (freeze untouched). No read-state
invariant changed; mark-all-read falls out via the EXISTING
send-optimistic cursor advance — no second cursor writer.

**A read-context PREPEND corrupts `atBottom` (the non-obvious part).**
When a channel opens with a mid-buffer cursor, the newest rows load
first, the length-effect snaps to that tail, then the read-context
(`before(cursor+1)`) page merges — PREPENDING ~50 rows ABOVE the
viewport. `scrollHeight` jumps while `scrollTop` stays put, so
distance-to-tail balloons; the prepend fires a `scroll` event and
`onScroll`'s `setAtBottom(distance <= threshold)` flips `atBottom` FALSE;
the next length-effect aborts its snap and the pane strands mid-buffer.
Instrumented trace nailed it (`ab:true->false input=null` →
`LEsnap ABORT`).

Three rejected attempts, each disproven: (1) a `following()` predicate
(`atBottom() || lastInputEventAtMs() === null`) — broke `cp14-b2`, whose
loadMore test scrolls to top PROGRAMMATICALLY (no input event); (2)
reversing the `loadInitialScrollback` merge order — irrelevant, the
newest region comes from `refreshScrollback`; (3) `overflow-anchor: none`
— the trace showed `scrollTop` already stayed fixed.

Root-cause fix: **`onScroll` flips `atBottom` false only on a real scroll
UP (`scrollTop` DECREASES vs last observed); reaching the tail always
re-arms it.** A content-grow-above keeps `scrollTop` put, so it can no
longer masquerade as "the operator left the bottom" — while cp14-b2's
programmatic scroll-to-top and a real wheel-up both DECREASE scrollTop,
so loadMore-preserve and paged-up-to-read are untouched. `lastScrollTop`
is a single `let`; no new signal.

**Send is unconditional (#168 acceptance).** A send re-enters follow mode
even if paged up: `lastOwnSend` → `scrollToBottom()`. Not event-type
branching — the send resets the follow-STATE; the one authority scrolls.

**Consequence.** Activation lands at the tail and `onScroll` fires
`loadNewer` near the bottom, so >200 unread auto-forward-pages toward the
live tail (bounded by the existing latches) — intended.

**Tests.** `issue168-scroll-authority.spec.ts` (RED→GREEN). Two specs
pinning the *removed* scroll-to-marker behavior were inverted; the REV-G
H23 vitest pin replaced by a #168 display-only-divider pin. cic-only,
build-deferred onto the night `--cic` batch (a daytime `--cic` would push
#154/#155 cic before their server halves).

## 2026-07-02 — #169: /who returns a typed who_reply modal, not a scrollback dump

Pre-#169, on 315 RPL_ENDOFWHO the EventRouter drained the accumulator
into **N+1 `:persist :notice` rows** into the target channel's window (or
`$server`) — transient query output polluting permanent scrollback; cic
had no `who_reply` arm, so the structured `meta.who` payload was dead
weight. `/names` already did it right (#140): buffer → ONE typed event →
dismissable modal, nothing persisted. `/who` now mirrors it.

**Server (COLD).** The 315 drain emits a single
`{:who_reply, target_display, users}` effect; the N+1 loop +
`format_who_reply/2` deleted. The channel-vs-`$server` routing
distinction disappears — a who_reply is always a user-topic modal, even
for a `/who` on a joined channel. `server.ex` broadcasts
`SessionWire.who_reply/3` on `Topic.user(...)` — ephemeral, mirroring
`:names_reply`. No sort tier: the WHO row is a superset of `member`, so
the sigil-tier sort doesn't fit; the table shows server WHO order.

**Untouched (load-bearing).** The 352 route + `who_fold/3` accumulator
reused AS-IS (only addition: per-row `channel` for the modal + a future
354 slot). Critically the 352 route STILL upserts `userhost_cache` (feeds
`/ban` mask derivation) — orthogonal to scrollback; only the 315 drain
was the hack.

**Wire contract.** `who_reply_payload/0`/`who_user/0` types + builders in
`wire.ex`; `:who_reply` in the kind union; each row projected through
`who_user/1` (explicit projection like `member/1`). `wireTypes.ts`
regenerated (drift-gated).

**cic (`--cic`).** `whoModal.ts` store (copy of `namesModal.ts`,
last-write-wins per network) + `WhoModal.tsx` (NamesModal scaffolding,
flat table); `userTopic` arm → `narrowWhoUsers` (one malformed row drops
the whole payload) → `setWhoReply`. **WHOX (354) out of scope**, row
shape left extensible for it. COLD + `--cic`, rides the night batch.

---

### 2026-07-02 — #127: /info, /version, /motd render one typed server_reply modal

**Same buffered-drain-to-modal shape as #169/#140.** `/info` (371→374),
`/version` (351), `/motd` (375/372/376, or 422 ERR_NOMOTD) buffer
server-side and drain ONE ephemeral user-topic event; cic renders a
dismissable `ServerReplyModal`, persists NOTHING.

**ONE event, not three (implement-once).** The commands differ only in
title and content, so they share `{:server_reply, source, lines}` with
`source :: :info | :version | :motd` as the typed discriminant. One
store, one `userTopic` arm, one modal, one CSS block. Per
`feedback_no_localized_strings_server_side` the server ships only
`source` + raw lines; cic maps `source` → human title. Three
near-identical stores/modals would be copy-paste-with-tweaks.

**The MOTD gating decision (the one real fork).** MOTD is dual-purpose:
auto-sent on registration AND replying to `/motd`, SAME numerics.
Connect-time MOTD has always landed as `:notice` rows on `$server`, and
that is right — a modal on every reconnect would be obnoxious. So the
modal is gated on an explicit request: `Session.Server` primes
`motd_pending` when the user issues `/motd`; EventRouter drains into the
modal ONLY when set, else falls through to the legacy `$server` persist.
Same idiom as `whois_pending`/`in_flight_joins`. **General rule: a
pending flag set by the outbound command distinguishes an on-demand query
from a server-initiated burst.** INFO/VERSION get the same
`{info,version}_pending` for uniformity (no connect-time source, so
unprimed = "unsolicited" → `$server`, never silently dropped). 422 folds
its own line before draining so a no-MOTD `/motd` resolves the modal.

**Delegation.** 371/374/351/422 join 375/372/376 in
`NumericRouter.@delegated_numerics` (delegated numerics skip
auto-persist; the clause chooses modal-vs-`$server`). The 400–499
channel-prefix property test had to exclude 422.

**IRC stays text-only.** Monospace pre-wrapped lines; retro chrome is
pure CSS; `prefers-reduced-motion` disables the blink. SERVER → COLD;
also `--cic`; build-deferred to the night cold batch.

### 2026-07-03 — #171: the one per-actor cap is per-(source-IP, network)

**The bug.** `Admission.check_capacity/1` had no per-source-IP dimension.
Visitor logins carry `client_id: nil`, so `check_client_cap/2`
short-circuited to `:ok` **by construction** — one IP could open
arbitrary concurrent visitor sessions. Seven from a single IP observed
live: a connection-flood / resource-exhaustion vector.

**The decision (vjt): drop per-client entirely, collapse to per-IP.** The
first cut added a per-IP cap *alongside* per-client, both reading one
knob — coupling the dimensions (loosening one loosened the other).
Rather than a second knob, vjt cut per-client: **visitors have no stable
client identity, so the source IP is the only durable per-actor handle;
users are capped per-IP too.** `check_capacity/1` is now circuit →
network-total → per-(source-IP, network). Renames:
`networks.max_per_client` → `max_per_ip`,
`default_max_per_client_per_network` → `default_max_per_ip_per_network`,
`effective_max_per_client/1` → `effective_max_per_ip/1`;
`:client_cap_exceeded` retired for `:ip_cap_exceeded`. `client_id`
removed from `capacity_input` (stays on the session row for the #117
attach path + audit); `Telemetry.capacity_reject/4`'s 4th arg is now
`source_ip`.

**`accounts_sessions.ip` is the count source — derive, don't duplicate.**
The `ip` column is already populated at session creation, so the per-IP
count is plain SQL — NO new column, NO ETS tracker.
`count_subjects_for_ip_on_network/4` keeps the two disjoint subject-kind
clauses, `count(_, :distinct)`, the non-revoked filter, and the UX-5-BC
self-exclusion — a visitor + a user on one IP are two independent
budgets. **Gotcha: the `source_ip` handed to `check_capacity/1` MUST come
through the SAME `GrappaWeb.RemoteIP.format/1` formatter login stores, or
the string won't match and the count silently reads 0.** Login flows
carry pre-formatted `input.ip`; the two raw-conn surfaces
(`NetworksController.orchestrate_spawn/4`, `SessionController`
`:visitor_reconnect`) format the conn; cold-start Bootstrap +
`subject_reset` carry `nil` (no HTTP conn → cap skips).

**Real client IP in prod.** The cap keys on `conn.remote_ip` *after*
`GrappaWeb.Plugs.RemoteIpFromProxy`. Prod nginx is same-jail loopback +
XFF, so the plug rewrites `remote_ip` to the real client IP (the cp52 S2
mechanism; also what #160 fail2ban bans on). The docker/e2e stack proxies
via the non-loopback bridge and surfaces the bridge IP — a test-substrate
artifact, not prod.

**`source_ip` is a required nil-or-binary `capacity_input` field**,
enforced by `check_ip_cap/2` clause patterns (`%{source_ip: nil}` skips;
`is_binary` counts) — an omitting construction site is a loud
`FunctionClauseError`, never a silent nil-skip.
`:ip_cap_exceeded → too_many_sessions` (same 503 envelope), so cic is
unchanged.

**NAT/CGNAT is a deliberate consequence.** At the default 1, legitimate
users behind one address share a slot — exactly why the cap is a tunable
per-network knob, not a hardcoded 1.

**Migration.** `ALTER TABLE networks RENAME COLUMN` (in-place, no
table-recreate → no FK-ref refresh, no `messages`-column-drift trap).
SQLite 3.25+ rewrites the CHECK expression but NOT the constraint name —
`max_per_client_non_negative` keeps firing against the renamed column
(same pattern as the U-1 rename). COLD.

**E2E (the shared-IP interaction).** The serial suite funnels many
distinct subjects through two IPs (e2e nginx + runner); at default 1 the
2nd subject 503s, cascading. Fix in dev/test config, NEVER the production
default: `config/dev.exs` raises the default to 10 (e2e boots
`MIX_ENV=dev`; `config.exs` base 1 stays for prod); `azzurra` seeds
`max_per_ip: 100`. The #171 e2e drives the cap deterministically (patch
to 1, two-visitor probe, restore). `u-3` still saturates; `u-4` REMOVED
(its cap-independence assertion ran through an ungated login → vacuous;
property stays unit-covered); `ux-5-bc` reframed to prove the gated
`/connect` self-excludes the returning subject.

### 2026-07-03 — #168 regression + completion: marker on switch AND cold-mount/app-startup, post-send stays bottom, 307 race fixed

**Symptom (P0, vjt prod-confirmed).** After #168, clicking a channel with
unread landed at the TAIL, not the divider. #168's collapse over-reached:
the channel-SWITCH `on(key)` effect reuses `scrollToActivation`, so a
deliberate switch inherited always-tail.

**Activation triggers, deliberately divergent (scoped):**

| trigger | lands at | why |
|---|---|---|
| deliberate channel-SWITCH into an unread window | the **MARKER** | the operator chose to open it — show them where they left off |
| COLD-MOUNT / app-startup into an unread window | the **MARKER** | **updated 2026-07-03b (vjt point-2)** — launching the PWA onto a window you left unread lands where you left off, same as a switch. Reverses the #46 cold-mount-tail wontfix. No unread → tail. |
| post-send / live-append while following | the **BOTTOM** | irssi-shape, the just-sent line must be visible (#168 acceptance) |
| visibility-return / resize | the **TAIL** | #46 resume family; a brief tab-blur / keyboard-open is not a window activation |

> **2026-07-03b note — the cold-mount row was originally TAIL** (the #46
> wontfix); vjt reversed it in the completion below.

**The scoping mechanism.** `scrollToActivation` takes a
`mode: "marker-or-tail" | "tail-only"`. The switch effect passes
`"marker-or-tail"`; visibility-return and resize pass `"tail-only"`. In
marker mode it reads the RENDERED frozen divider — one-shot
`listRef.querySelector('[data-testid="unread-marker"]')` inside the
settled-geometry rAF×2 — and `scrollIntoView({block:"start"})`s it,
deriving `atBottom` from the resulting distance. It reuses the divider
node the `rows()` memo injected (no second cursor-geometry computation),
introduces no `markerRef` (REV-G H23 stays dead — the lookup lives and
dies in one activation). Divider ABSENT → tail.

**Why this does NOT re-open the #168 send-race** (03a scoping): the
length-effect stays TAIL-ONLY; post-send goes through
`lastOwnSend`→`scrollToBottom`; and a switch that parks on the divider
sets `atBottom=false` first, so the length-effect yields. One trigger,
one scroll target.

**COMPLETION (2026-07-03b) — vjt's GENERALIZED rule + the 307-race root
cause.**

> **vjt's rule (authoritative — supersedes any "fills the viewport"
> wording).** The landing criterion is one question: *did a COMMAND
> produce scrollback in THIS window?*
>   - **Yes → SCROLL-TO-BOTTOM.** A send of ANY length (the short-send
>     caveat is WITHDRAWN; no length condition).
>   - **No (pure activation: app-startup / switch / cold-mount) →
>     UNREAD MARKER** (if unread exists; else bottom).
>   - **Neither (loadMore / loadNewer pagination) → PRESERVE** the
>     operator's position. Never marker, never bottom.
> Reverses the #46 cold-mount-tail wontfix by vjt's explicit call.

Extending the marker branch to cold-mount surfaced the REAL bug behind
the intermittent `scroll-on-window-switch:307` failure: **the marker jump
was a one-shot that did not survive the NEXT rows recreation.**
`<For each={rows()}>` is ref-keyed and the memo rebuilds fresh wrapper
objects, so EVERY rows change re-creates the list DOM and resets
scrollTop to 0 — the length-effect + `scrollToActivation` exist precisely
to re-establish position pre-paint after each recreation. After a switch
parked on the marker (`atBottom=false`), the post-switch catch-up
`refreshScrollback` — or a late read-cursor hydration inserting the
divider — recreated the DOM; the only re-establish path (the
length-effect) was `atBottom`-gated and suppressed, stranding the pane at
scrollTop 0.

Fix: a `markerActivationPending` latch (set by the SWITCH key-effect AND
cold-mount `onMount`; cleared on real operator input or an own send)
drives the length-effect to RE-ASSERT
`scrollToActivation("marker-or-tail")` on every rows recreation while
active (`withHide=false` — rAF×2 corrects pre-paint). No re-opened
send-race: `lastOwnSend` CLEARS the latch before `scrollToBottom`; a
scrolled-up operator clears it via the input gate.
Visibility-return/resize stay `tail-only` one-shot.

**Pagination is excluded from BOTH paths (the cp14-b2 oscillation
canary).** loadMore/loadNewer are neither a command nor an activation —
they PRESERVE position. The fix is in the RE-ASSERT GATE: re-assert only
when `markerActivationPending()` AND a rendered unread divider EXISTS. No
divider → fall through to the `atBottom` tail-follow, which resolves both
no-marker cases with one rule (cold-mount `atBottom=true` tails; a
scrolled-up loadMore prepend does nothing, so the height-delta restore
preserves). Two REJECTED approaches, documented so the oscillation isn't
re-explored: (1) a transient `paginating` flag skipping the length-effect
— Solid fires the effect AFTER the scroll handler + its `.finally`, so
the flag is already reset (RED, tail); (2) synchronously clearing the
latch in the loadMore block — the ref-keyed `<For>` scrollTop-0 reset on
a SWITCH fires `onScroll` at the top boundary during the activation's own
transient, clearing the latch before the jump settles (RED, 307
re-stranded). The marker-EXISTS gate sidesteps both. `cp14-b2` scenario 2
is the canary; the marker, send→bottom, and loadMore-preserve specs are
gated together — no blind trading.

**Freeze contract unchanged.** The divider still derives from the frozen
`markerCursorId` snapshot (2026-06-08); the switch jump is a DISPLAY-side
scroll, not a cursor write — the programmatic `scrollIntoView` fires no
operator-input event, so the scroll-settle gate does not advance the
cursor and the divider survives the jump.

**Tests (03a + 03b).** `scroll-on-window-switch.spec.ts` scenario 3 is
the SWITCH→marker RED→GREEN; 03b makes it deterministic and FLIPS the
cold-mount specs (plus a post-`page.reload()` sibling for genuine
app-startup); `issue168-scroll-authority` keeps its post-send→bottom
assertions. This zone is DOM-scroll behavior, e2e-only. 03a shipped HOT
`--cic` same day (vjt override); 03b is BUILD-DEFER-NIGHT with #123
(deploy HELD while main carried device-confirmed regressions).

### 2026-07-03 — #123: boundary-claim the compose swipe so slow drags scroll the textarea

**The hijack.** `ComposeBox`'s swipe affordances (UP = older history,
DOWN = newer, RIGHT = tab-complete) were gated on DISPLACEMENT only:
`onTouchMove` claimed + `preventDefault`ed at the 8px slop — killing
native scroll for ANY drag — and `onTouchEnd` dispatched purely on the
40px floor. A slow deliberate vertical drag meant to SCROLL a long draft
(the textarea is `rows=1`, overflow scrolls internally) got hijacked into
history recall (#123, vjt P1).

**Both halves were the bug.** `.compose-box textarea` was
`touch-action: none` (UX-3 UNDEC R3 — guarding iOS's chrome gesture).
`none` blocks ALL pan, so even with the JS fixed the slow drag could not
scroll natively.

**First attempt — velocity-claim — REWORKED the same day.** Claiming
mid-drag on `isFastSwipe` at the first 8px crossing regressed BOTH ways
on device: a real flick ACCELERATES from rest and at 8px still reads
below 0.3px/ms → a genuine swipe abandoned irrevocably; and iOS COALESCES
touchmoves — a scroll-drag's first delivered move can jump ~20px in one
frame and read above threshold → claimed, scroll suppressed. Same root:
instantaneous velocity sampled on the ramp tracks iOS event delivery, not
human intent. (The old e2e stayed green: `slowMs:0` synthetic events →
`elapsedMs<=0` → `isFastSwipe` unconditionally true — hollow vs device;
the `feedback_playwright_webkit_not_ios_scroll` trap.)

**The rework — BOUNDARY claim + touchend-only velocity.**
`claimAxis(start, current, boundary)` in `lib/swipe.ts` claims only a
drag native scroll CANNOT consume: any horizontal drag (pan-x blocked by
`touch-action`, would only select text), or a vertical drag PAST an edge
— up while `atTop`, down while `atBottom` (boundary sampled at
touchstart). A short non-overflowing draft is at BOTH edges, so its
flicks always claim (the stock-keyboard affordance). Vertical with scroll
room → null → no `preventDefault` → native `pan-y` scrolls. Model: scroll
to the edge first, THEN a second flick recalls. Velocity is judged ONCE,
at touchend, over the WHOLE gesture — displacement + elapsed both large
and reliable. The 8px slop and 40px floor still bound displacement.
(`performance.now()` is fine in cic runtime — the `Date.now` ban is a
workflow-script rule.)

**Threshold.** `SWIPE_MIN_VELOCITY_PX_PER_MS = 0.3` (~300px/s): above a
deliberate read-drag (<~150px/s), below a natural flick (>~500px/s). A
defensible default, vjt calibrates on-device. No longer the CLAIM
discriminator, so a mis-judgement can at worst drop a recall — never
abandon or hijack a scroll.

**CSS.** `.compose-box textarea` → `touch-action: pan-y` +
`overscroll-behavior: contain` (same guard as `.scrollback`). KNOWN
device-test item: a SHORT non-overflowing draft at `pan-y` may still fall
through to iOS chrome-reveal on a slow drag — accepted; re-open with a JS
overflow-toggle only if it bites on-device.

**Gates.** Pixel-scroll + velocity feel are NOT webkit-reproducible and
synthetic TouchEvents don't drive native scroll, so the load-bearing
gates are the `lib/swipe.ts` UNIT tests; the e2es
(`issue123-compose-swipe-velocity.spec.ts`) guard WIRING + CSS
(fast/slow touchend pair, `defaultPrevented` boundary probe, `@webkit`
computed-CSS contract). DEVICE test = vjt post-ship. cic-only,
BUILD-DEFER-NIGHT: rides the #171 night batch (a daytime `--cic` would
rebuild cic from main HEAD, which expects the not-yet-deployed
`max_per_ip` server API).

### 2026-07-03 — #79: let scrollback selection start with the keyboard open (keep-keyboard skips selectable surfaces)

> **SUPERSEDED 2026-07-04 (see next entry).** This v1 fix — an
> *unconditional* skip of the preventDefault on `.scrollback` — was
> device-tested FAILING by vjt: it did not deliver long-press selection
> (the freed focus-shift closed the keyboard mid-press; the reflow tore
> the long-press down before iOS committed a selection), and its only
> observed effect was that a plain TAP now closed the keyboard. vjt chose
> to KEEP tap-to-close and gate the preventDefault on press DURATION. The
> v1 mechanism is history; the shipped behaviour is the 2026-07-04
> rework.

vjt iPhone dogfood: tap-hold selection in the scrollback worked only with
the keyboard CLOSED.

**Root cause — the unfinished half of Dispatch-1 (2026-06-11).** That arc
had two stacked causes: (a) desktop, keepKeyboard's document-level
capture mousedown `preventDefault` cancelling the selection-drag — fixed
by gating on `isIos()`; (b) iOS, the blanket `user-select: none` — fixed
by re-enabling `user-select: text` on `.scrollback`/`.topic-modal-text`.
But (a)'s gate scoped the fix to *desktop*: on iOS the handler STILL
preventDefaulted every non-input mousedown while compose was focused —
including on the very surfaces (b) had just marked selectable. The
2026-06-11 note even flagged the class (iPad-with-trackpad) but filed it
as a niche edge; #79 was the same defect on the mainline touch path.

**v1 fix.** `handleMouseDown` skipped the `preventDefault` when the
target sat on a selectable-text surface (`el.closest(...)` structural
allowlist — the same set the CSS re-enables, minus
`.scrollback-invite-join`; computed-style detection isn't
jsdom-testable). The two-site allowlist (`default.css` +
`keepKeyboard.ts` `SELECTABLE_TEXT_SURFACES`) and its keep-in-sync
invariant carry forward into the 2026-07-04 rework.

**Deploy.** cic-only, BUILD-DEFER-NIGHT (same #171/#123 batch).

### 2026-07-03 — #172: long-press to confirm window close (kill spurious taps; keep the bottom bar)

**Symptom.** A bare tap on the BottomBar window-picker close `×` closed a
window instantly — on mobile a fat-finger tap lost a window. Owner
direction: KEEP the bottom bar, make closing DELIBERATE — a longer hold;
a short tap must not close. All three close verbs (`closeChannelWindow`,
`closeQueryWindow`, `disconnectNetwork` in `lib/windowClose.ts`) were
wired directly to `onClick` on both surfaces.

**Placement (the crux — challenge the spec).** The issue suggested the
gate "likely lives in/around `windowClose.ts`." One shared point is
right; the placement is wrong: `windowClose.*` is a synchronous
STATE-PUSH layer with no pointer/timer context — a gesture timer there
would be a boundary violation and untestable. The shared point is the
button-INTERACTION layer: pure gesture core + thin Solid handler factory
`lib/holdToClose.ts`, wrapped by one `<CloseButton>` component BOTH
surfaces attach to, calling the existing `windowClose.*` verb ON CONFIRM
("reuse the verbs, not the nouns"). The pure core (`HoldToCloseGesture`)
mirrors `keyboard/gesture.ts` `KeyGesture`: no DOM, no timer (the factory
owns the `setTimeout`), unit-testable.

**Touch-gated, not all-pointers (the key UX decision).** Spurious-close
is a mobile fat-finger problem; a desktop MOUSE click on `×` is already
deliberate — forcing a 500ms hold there would be a regression. The hold
applies ONLY to touch/pen (`e.pointerType !== "mouse"`); mouse click and
keyboard Enter/Space confirm instantly via native `onClick`. The gate
keys off `pointerType`, not the device — so the e2e drives it identically
on both surfaces with synthetic touch pointer events.

**Synthetic-click swallow.** A touch tap/hold fires a trailing synthetic
`click` after `pointerup`, which would confirm behind the gesture's back.
The factory sets `swallowClick` on any gated pointerdown and eats the
next `click`; a mouse/keyboard click has no gated pointerdown, so it
flows through. The flag resets on every `pointerdown`, so a persistent
button (the registered-user disconnect `×`) can't get wedged.

**Which verbs are gated.** All, via `<CloseButton>`: channel close, query
close, AND the network-header `disconnectNetwork` — the most destructive
(visitor `quitAll`). The Sidebar pseudo-row dismiss rides `<CloseButton>`
too, for TOTAL consistency (one `×` code path, no half-migrated second
pattern) — though the touch gate is a no-op on that desktop-only surface.
Distinct from `InlineConfirmButton` (the two-click archive-delete
affordance) — that stays; #172 is the owner's preferred HOLD approach.

**Constants (FEEL knobs).** `HOLD_TO_CLOSE_MS = 500` — longer than the
300ms `LONG_PRESS_MS` because a destructive confirm wants more
deliberation; vjt tunes on-device. Slop reuses `keyboard/gesture`
`MOVE_SLOP_PX` (~10px — drifting past it is scrolling, cancel);
`pointercancel`/`pointerleave` also cancel. Pointer events (not `touch*`)
sidestep Solid's passive-touch delegation
(project_solid_touch_passive_delegation); `touch-action: none` on the
close buttons stops a hold being stolen by the bottom bar's `pan-x`
scroll. A short tap silently no-ops; a `.close-holding` class tints the
`×` warning-red WHILE a touch hold is in progress (immediate, not a timed
fill, so the 500ms constant isn't duplicated in CSS).

**Gates.** Playwright drives synthetic pointer TIMING, not real
long-press feel. Load-bearing: the pure-core unit test + the BottomBar
component test (RED→GREEN: short tap no longer closes; a held press
does); `x172-longpress-close-confirm.spec.ts` (chromium + `@webkit`) is
the wiring guard. Real feel = vjt device test post-ship. cic-only,
BUILD-DEFER-NIGHT (same #171/#123/#79 batch).
## 2026-07-03 — #123 (attempt 3): the compose swipe was a nested-scroll boundary handoff, not a velocity/claim heuristic

Two prior fixes failed on device: the velocity-gate (659aa06) sampled speed
on the acceleration ramp; the boundary-claim rework (4e828a2) had the right
idea, wrong mechanics. Symptom: swipe fired only at `scrollTop === 0`, plus a
"double-swipe" (first drag scrolls the textarea to its edge, second fires).

**Root cause — two bugs in the claim path.** (1) **Frozen touchstart
snapshot:** the boundary was sampled once in `onTouchStart` and `claimAxis`
read that snapshot for the whole touch — never re-read after the textarea
scrolled to its edge mid-touch. The design comment codified this as intent
("scroll to the edge first, THEN a second flick recalls") — that was the bug,
not the contract. (2) **Inverted direction→edge mapping:** `claimAxis`
claimed finger-UP at `atTop` / finger-DOWN at `atBottom` — physically
backwards (finger-UP increases `scrollTop` toward the BOTTOM edge). "up while
atTop" is unreachable by a continuous drag on an overflowing draft, so it
only ever claimed on non-overflowing drafts — the case that appeared to work.

**Fix — the standard nested-scroll / bottom-sheet handoff.** The textarea
(inner surface) owns the drag while it has room in the drag direction; on
hitting its wall (finger-up → `atBottom`, finger-down → `atTop`) it cedes the
rest of THIS touch to the gesture. Read the boundary LIVE on every
`touchmove`; correct the mapping. `claimAxis` still returns null while
there's room, so a deliberate scroll-drag is never hijacked.

**Rejected: re-baselining the gesture anchor at handoff.** The velocity gate
measures the WHOLE gesture at touchend (coalescing-robust); re-baselining
reintroduces the attempt-1 fragility (a coalesced touchmove at the boundary
would swallow most of the flick). Whole-gesture: a brisk drag hands off and
fires; a slow read-drag grazing the edge stays below the flick threshold.

**iOS unknown.** Whether iOS honours `preventDefault` mid-touch once `pan-y`
compositor-scrolling began is not provable in webkit-playwright
(feedback_playwright_webkit_not_ios_scroll); with `overscroll-behavior:
contain` there's no rubber-band, so the claim firing is the win even if
visual suppression is partial. `ComposeBox` emits per-touch telemetry
(`lib/diagLog.ts` ring buffer → `DiagFloat`, `cic_diag`-gated) for real
on-device numbers.

**Gate reality.** `issue123-compose-swipe-velocity.spec.ts` asserts the
handoff via `event.defaultPrevented`, both directions, plus a LIVE-read
regression guard changing `scrollTop` BETWEEN touchstart and touchmove (a
frozen snapshot fails it). The prior test asserted the inverted mapping — it
encoded the bug and was rewritten. e2e necessary, NOT sufficient: ship gate
is device dogfood; #123 OPEN. Deploy: cic-only, rides the BUILD-DEFER-NIGHT
COLD+`--cic` batch with #171 + #79 + #172 (a daytime `--cic` would rebuild
from main HEAD carrying #171's undeployed admin-rename); supersedes the
attempt-2 cic in that batch.

### 2026-07-04 — #79 rework: tap-to-close vs long-press-select, split by press DURATION

The 07-03 v1 (unconditional preventDefault-skip on `.scrollback`) failed on
device: a plain TAP now closed the keyboard (vjt asked to KEEP that), but a
tap-HOLD still gave no selection. Root cause: freeing the mousedown default
let the focus-shift proceed → iOS dismisses the keyboard → the reflow moves
the pressed text out from under the finger before iOS's ~500ms long-press
commits. (Proof: keyboard closed → selection works; open + v0 preventDefault
→ dead, cancels the drag; open + v1 skip → dead, reflow tears it down.)

**The conflict lives in TIME:** short tap must close the keyboard, long-press
must select — a single mousedown-time decision cannot distinguish. vjt chose
**Option 2: long-press threshold** (feel change accepted, device-judged; the
deeper unknown — whether `touch-action: none` on a non-overflowing
`.scrollback` also blocks the gesture — deferred to dogfood, not pre-probed).

**Mechanism — no timer, no async.** iOS dispatches the compat `mousedown` on
finger-RELEASE, so held duration is already known: a passive capture
`touchstart` listener stamps `performance.now()`, subtracted at mousedown.
On a selectable surface: `held < LONG_PRESS_MS` (500) → TAP → leave the
default → keyboard dismisses; `>= 500` → LONG-PRESS → `preventDefault` the
focus-shift → keyboard stays → the selection iOS began survives. 500ms
matches iOS's own long-press convention — below it iOS wouldn't have started
a selection anyway. Chrome (tabs/arrows/send) UNCHANGED: not selectable →
preventDefault regardless of duration (UX-3). No `pointerdown`, no
`touch-action` change (that regression risk stays out of scope).

**Two-site allowlist still holds:** the duration-gated surfaces
(`.scrollback` / `.topic-modal-text`, minus `.scrollback-invite-join`) stay
duplicated in `default.css` (the `user-select: text` re-enable —
load-bearing) and `keepKeyboard.ts` (`SELECTABLE_TEXT_SURFACES`); only the
ACTION changed. A `cic_diag`-gated `diagPush` (`held=Xms → HOLD | tap`)
gives on-device observability — the dogfood is the SOLE real gate (webkit
playwright is blind to actual selection handles). e2e
`issue79-ios-select-keyboard-open.spec.ts` asserts the three-way
discrimination; unit test carries the threshold boundary cases. #79 OPEN
until device-confirm. Deploy: cic-only, HOT `--cic`.

## 2026-07-04 — #119: unified stacked error-banner region (WS + connectivity + bundle-refresh, no overlap)

**The bug.** Top banners were independent `position: fixed; top: 0`
components. A fixed element does NOT participate in normal flow, so the old
CSS comment's "document order handles stacking" was false — banners
OVERLAPPED when both fired; #120 would have added a third.

**The fix — ONE owner + a DERIVED typed registry.** `ErrorBanners.tsx` is
the sole owner: one fixed flex-column container whose `BannerSlot` children
stack in normal flow. State is derived, never stored: `errorBanners.ts
activeBanners()` reads the existing source signals (`socketHealth`,
`connectivity`, `bundleHash`) and projects typed entries — no parallel
store; each source stays the single owner. `source`/`severity` are
closed-set string-literal unions with runtime guards + a `sanitizeBanners`
boundary. Per-source differences are entry FIELDS, not a type flag (WS +
connectivity auto-clear; bundle-refresh carries an `actionHint`, persists
until reload). **#120 slots in as ONE `BannerSource` member + one
`activeBanners()` push — the enum + derivation are the whole seam.**

**Deleted a false cause (vjt).** The WS banner's `origin_rejected` arm
guessed "origin misconfigured" on a 1006 close — FALSE (1006 with no reason
usually means no connection at all); a wrong cause is worse than none.
`classifyFailure`, `SocketFailureKind`, `browserOrigin` DELETED; the WS
entry surfaces only the real close code + reason. `connectivity.ts`
(`navigator.onLine` + online/offline events) is the honest replacement.

**Connectivity-driven reconnect — phoenix native vs our delta.** phoenix.js
`Socket` ALREADY auto-reconnects (default `reconnectAfterMs` backoff, not
overridden; channels auto-rejoin) — we reimplement NONE of it. The delta:
phoenix never listens to browser online/offline. `socket.ts` adds two window
listeners — `offline` → `disconnect()` (halt futile retries, reset backoff);
`online` → `disconnect()`+`connect()` (immediate reconnect instead of
waiting out the backoff). Pure `kickReconnect`/`haltForOffline` seam
(unit-testable, fake socket); no-ops with no socket. `connectivity.ts` owns
the UI signal; `socket.ts` owns the reconnect — no cross-import.

Bundle-refresh flow UNCHANGED (became a registry entry; its two e2e specs
green with only a selector migration to
`.error-banner[data-source="bundle-refresh"]`). Unit tests mock ONLY the
jsdom-undriveable `bootBundleHash` DOM boundary. e2e
(`error-banners.spec.ts`, anti-hollow-green): WS-down AND bundle-mismatch
SIMULTANEOUSLY — both slots visible AND bounding boxes not intersecting.
Deploy: cic-only, HOT; no wire touch. #119 OPEN; #120 next.

## 2026-07-04 — #120: surface service-worker registration failure in the #119 stacked error region

**The bug.** `main.tsx` called `registerSW()` bare — a registration failure
was SWALLOWED SILENTLY (console only); SW-dependent features (push, offline
shell, badge) silently don't work with no in-app cause. The CLAUDE.md
"no silent-swallow" anti-pattern; surfaced verifying iOS SW registration on
prod (#94).

**The fix — extend the #119 seam, verbatim as promised:** new source signal
`cicchetto/src/lib/swRegistration.ts` (module-singleton, mirrors
`socketHealth`/`connectivity` exactly: record fns +
`shouldShowSwRegBanner()` + `__resetForTests` + `window.__cic_swRegistration`
hook; single owner, `errorBanners.ts` reads it). `main.tsx` →
`registerSW({ onRegisterError, onRegisteredSW })` — `onRegisteredSW` is the
non-deprecated success callback; `onRegistered` (which the issue named) is
`@deprecated` and only fires when `onRegisteredSW` is absent. Success is
recorded for devtools/#181 only, no banner; registration TIMING unchanged.
`errorBanners.ts` gained ONE member (`sw-registration`, hyphen form matching
`bundle-refresh`) + one gated push, `warn` ordered error→warn→info;
closed-set guards reject near-misses (`sw_registration`/`service-worker`).

**Severity `warn`, no actionHint:** the app keeps working, only PWA
capability degrades; diagnostic, not a user action (vite-plugin-pwa exposes
no clean re-register; a reload re-attempts). STICKY: nothing clears it for
the page lifetime — only explicit reset (tests) or a later successful
registration.

**The #181 diagnostic lever (load-bearing):** the signal captures the ERROR
DETAIL — `{ name, message }` normalized from the Error/DOMException — NOT a
boolean. The push cluster (#181) reads WHY registration failed via the
accessor / window hook; the banner text is merely the human view.

Unit tests drive the signal via its record fn (jsdom-driveable, no mock);
e2e extends #119's spec (drive `recordError` → slot visible with
name+message + hook exposes same detail + second no-overlap proof). Deploy:
cic-only, HOT; no wire touch. #120 OPEN until eyeball-confirm.

---

## 2026-07-04 — #181: push subscription survives an SW-swap re-subscribe; ghost rows superseded on re-subscribe (NOT prune-on-410)

**Symptom (live iOS debug, 2 devices).** Push "silently re-disables": toggle
OFF, delivery stops; re-enabling restores — until it drops again. Server
shows a *subscribed* device that receives nothing (ghost).

**Evidence-first on live prod.** The brief claimed (client) no auto
re-subscribe + (server) "dead subscriptions never pruned". The server half
was FALSE: the old Apple ghost rows all had fresh `last_used_at` — bumped
ONLY on a `{:ok,_}` send → **Apple still returns 2xx for the ghosts**; logs
showed the 410-prune (`Push.Sender` → `{:error, :expired}` →
`Push.delete_dead/1`, B2 2026-05-14) correct and firing. But it
*structurally cannot* touch these ghosts: the client dropped its browser
subscription (iOS SW-swap / storage eviction) WITHOUT `unsubscribe()`, so no
410 ever arrives. Prune-on-410 is a backstop for vendor-invalidated
endpoints, not silently-dropped ones. (Escape-hatch report went back before
building — "challenge the spec"; the spec inherited a wrong half.)

**The real bug — two client defects:** (1) `disablePush` bailed on a null
`getSubscription()` — it forgot the stashed server-row id WITHOUT DELETEing
the row; every silent-drop → off → on cycle orphaned the old row and minted
a new one. (2) Nothing re-subscribed after the drop, so the toggle
(correctly reflecting `getSubscription()`) sat at OFF.

**Why NOT server-side dedup keyed on subject/UA.** The server has zero
signal a still-2xx endpoint is undeliverable; and this user owns 6 devices
incl. TWO iPhones with IDENTICAL `user_agent` — dedup by (subject[,UA])
would delete a REAL device. The only deterministic safe signal is
**client-authoritative**: the client knows the exact endpoint it replaces.

**The fix (client + server, one deploy window).**
- **SERVER — supersede-on-(re)subscribe.** `Push.create/2` accepts optional
  `:supersedes` (previous endpoint; optional body field). Present and ≠ new
  endpoint → transaction subject-scoped-deletes it, then inserts.
  Subject-scoped ⇒ can only supersede own rows; same-endpoint is a no-op so
  the unique-constraint 422 replay survives. 410-prune + DELETE unchanged.
- **CLIENT — renew on the SW-update/resume seams.** `disablePush`'s
  null-branch now DELETEs the stashed row. `ensurePushSubscription`
  (RENEW-ONLY — never prompts; acts only when permission granted + a stashed
  endpoint proves prior opt-in + live subscription null) re-subscribes via
  the same VAPID path, POSTs with `supersedes: <old endpoint>`; a 422 replay
  counts as present. `installPushResubscribe` wires it on
  `controllerchange`, `visibilitychange`, and boot; single-flight guarded.

**Boundary vs #182:** #181 is subscription survival + ghost supersession
only; presence-gating is #182. **No `pushsubscriptionchange` SW handler:**
it fires inside the SW (no bearer token to POST) and iOS doesn't fire it
reliably — renewal is page-driven on `controllerchange`, where the token
lives. **Residual:** ghosts the client can't name (localStorage cleared
pre-fix) aren't deterministically reapable; superseded on next re-subscribe
or rot via vendor TTL; operator reap deemed optional (can't distinguish
live-vs-ghost among identical-UA iPhones).

`push` has no `wire.ex` (hand-written type) — `gen_wire_types --check`
green. The server half was pure BEAM → auto-classifier deployed HOT (pid
unchanged, sessions preserved), batched with the `--cic` bundle. #181 OPEN
until device-confirm.

---

## 2026-07-04 — WS subprotocol / transport allowlist inheritance (closing #97)

#97 closed as **already covered** — the constraint is the last bullet of the
*2026-04-26 — Phase 3 wrap: WS `check_origin`* section. Restated so it isn't
lost in a closed issue:

**Guardrail.** A new WS subprotocol or alternate Channel transport inherits
the existing `check_origin` allowlist by construction. A feature that needs
a *different* host lands as a **separate `Phoenix.Endpoint`**, never as a
relaxation of `check_origin` in `runtime.exs` — relaxing the shared
allowlist for one feature widens the authz-on-handshake surface for every
socket. Pre-emptive; no action until a future transport is added.

## 2026-07-05 — #180: enlarge the CRT loading-splash text +30%, proven by a FROZEN-splash e2e

Device report: CRT splash (`CrtSplash.tsx`, #134) text too small. Pure bump:
`.crt-splash-boot` 0.8→1.04rem, `.crt-splash-status` 1.4→1.82rem (×1.3,
splash-scoped; the rem base untouched).

**The reusable bit — how to e2e a loading-ONLY component.** The splash lives
only before `/me` resolves; jsdom can't resolve rem→px. The e2e
(`crt-splash-font.spec.ts`) freezes it deterministically: seed a bearer
(RequireAuth gates on token PRESENCE, not `/me`) so Shell mounts, then HANG
`/me` (never-resolving `page.route`) so the `user` resource stays PENDING →
splash persists under real Chromium; assert the rem-RATIO (computed text px
÷ root font px — layout-independent). Hang, NOT `abort()`: an aborted
resource ERRORS and Solid re-throws on read (trips ErrorBoundary, kills the
splash); a 401 fires `on401` → token cleared → bounce to `/login`. Pending
is the genuine cold-load state. Pattern for any future loading-only /
transient-overlay e2e.

## 2026-07-05 — #182: server-side foreground push-suppression (one visibility signal, two consumers, two timings)

**The bug.** Push delivered while the PWA was on-screen (iOS). The existing
suppression was client-side in the SW (`shouldSuppressPush` →
`clients.matchAll().visibilityState`) — predicate correct, but
`clients.matchAll` is UNRELIABLE on iOS PWAs (empty/non-"visible" while
foregrounded). Fix: suppression moves SERVER-side, driven by page-context
`document.visibilitychange`, which IS reliable on iOS.

**The signal.** cic's `reportVisibility` (`socket.ts`) pushes `{visible}` on
the user channel — on every `visibilitychange` AND every user-channel
(re)join (a fresh transport pid defaults `:hidden`, so a reconnect
re-reports). `GrappaChannel.handle_in("visibility", …)` →
`WSPresence.set_visibility/3` keyed by `socket.transport_pid` — the same pid
`UserSocket.connect` registered, so DOWN cleanup is automatic.

**The store — WSPresence EXTENDED, not duplicated** (vjt: "non reinventare
la ruota"). Map: `%{user_name => %{pid => :visible | :hidden}}`;
`ws_count`/`list_user_names` still derive from pid keys. Default on register
= `:hidden` (DELIVER-leaning: erring hidden never suppresses a wanted push —
the SW re-check backstops a false delivery; defaulting `:visible` risks
losing a notification to a backgrounded iOS device). No second GenServer —
a parallel store monitoring the same pids = duplicated housekeeping that
drifts.

**One raw bool, TWO consumers, TWO timings (the crux).**
- **Push suppression — RAW, immediate.** `Push.Triggers.evaluate_and_dispatch`
  gates fan-out: `should_notify?/4 and not WSPresence.any_visible?(label)`.
  `should_notify?/4` stays PURE (no IO). No debounce — a debounced gate
  would miss a mention landing right after you set the phone down. Keyed by
  `subject_label` (WSPresence stays Accounts-free); applies to visitors too.
- **IRC auto-away — DEBOUNCED 30s.** Trigger moved from "all sockets
  disconnected" to "no VISIBLE device": WSPresence fires `:ws_visible` /
  `:ws_all_hidden` on the `any_visible?` TRANSITION (renamed from
  `:ws_connected`/`:ws_all_disconnected`; sole consumer is
  `Session.Server`). Existing 30s debounce + real upstream `AWAY` reused.

**REAL behavior change (intended):** backgrounding the PWA >30s now marks
you `/away` to other network users — iOS holds the socket while
backgrounded, so a live socket is no longer proof of presence. SUPERSEDES
the earlier S3.x auto-away note ("last socket gone → away"): the trigger is
visibility, not connection. Auto-away stays USER-only; the push gate applies
to visitor subjects.

**The SW client re-check is RETAINED** as a backstop (the just-connected
window before a fresh tab reports; non-iOS where `matchAll` is trustworthy);
the stale "hybrid until quota bites" notes in
`service-worker.ts`/`pushDedup.ts` were corrected at source. Never weaken
`shouldSuppressPush`.

**e2e.** The old `push-server-fires-regardless-of-focus.spec.ts` encoded the
now-reversed contract → reworked into `push-foreground-suppression.spec.ts`
(visible → DM → nothing; hidden → delivered). A shared `setPageVisibility`
fixture overrides `document.visibilityState` + dispatches `visibilitychange`
(drives the PRODUCTION reporter), blocking on the `window.__visibilityAck`
seam so the trigger can't race. Away-transition coverage in
`server_test.exs`, firing `:auto_away_debounce_fire` directly (no 30s wait).

## 2026-07-05 — #184: STATS reply numerics are server-directed → `$server`, never a query window

`/stats <letter>` output rendered in a bogus QUERY window named after the
stats letter (a DM "o" for `/stats o`) instead of `$server`, and leaked into
Archive.

**Root cause was SERVER-side** (`Grappa.Session.NumericRouter`); cic
faithfully mirrors the routing target. The STATS family (211–219 + 240–250)
was in NEITHER `@active_numerics` NOR `@delegated_numerics` → fell to the
`scan_params/2` param-scan. Every `/stats` terminates with **219
RPL_ENDOFSTATS `[own_nick, <letter>, …]`**; the bare letter is nick-shaped
(`valid_nick?("o")` true, no dot, ≠ own_nick) → `{:query, "o"}` → persisted
`:notice` on `channel="o"` → query tab + Archive leak via `list_archive`'s
`COALESCE(dm_with, channel)`. The **exact same disease** as the UX-4 004/042
connect-storm ghost: a nick-shaped middle param that is metadata, not a
destination.

**Rule (invariant): STATS replies are server-directed — always
`{:server, nil}`.** Fix folds 211–219 / 240–250 — the set Azzurra's bahamut
actually emits — into `@active_numerics` via `@stats_numerics`; their
nick-shaped middles are all data (stats letter, O/I/K/C-line class, link
name, host mask). We deny the OBSERVED range, not universal coverage — other
ircds put STATS numerics in 220–239 too; add them if a bound network emits
them. Verified disjoint from `@delegated_numerics`; 250 already routed to
`$server`, zero connect-storm change.

**#155's e2e MASKED this** (the #78 hollow-green lesson): it asserted only
242 RPL_STATSUPTIME → `$server` — 242 is trailing-only, routed correctly by
ACCIDENT, while the sibling 219 silently forked a "u" query window the test
never looked for. #155's `compose.ts` "No server change" comment inherited
the same false premise; corrected at source.

**e2e** (`issue184-stats-window-routing.spec.ts`): `/stats u` → 219 renders
in `$server`; NO sidebar window "u"; decisively, server-side
`GET /channels/u/messages` returns `[]` (ordered after the 219 lands). All
three legs RED pre-fix. Deploy: SERVER change → COLD.

---

## 2026-07-05 — #187: last-open-window restore for visitors (kind-gate + decide-once race)

**Contract reaffirmed: last-open-window restore is CLIENT-owned, keyed on
the subject's `/me` id** (`localStorage["cic.lastFocusedChannel.<id>"]`,
written on every focus change, re-selected on cold load in `Shell.tsx`). The
server owns read-cursors and `last_joined_channels`, NOT which window was
focused. A visitor's `/me` `id` is a stable `Ecto.UUID`, keying the same
slot across refreshes like a user's.

**Bug 1 — the restore READ was gated `kind === "user"`** (#34/#35, on the
wrong assumption visitors are fresh-per-visit). The WRITE was never gated —
visitors reliably FILLED a slot the read refused to consult; every refresh
fell to `$home`. Fix: drop the gate; key on `m.id` for any subject.

**Bug 2 — the restore was DECIDE-ONCE.** A user's saved channel is an
autojoin — always in the FIRST `channelsBySlug` snapshot. A visitor's is
runtime-joined: `GET /channels` can snapshot mid-reconnect WITHOUT it, the
channel arriving a beat later via refetch. The old arm latched after the
first snapshot and never re-checked. The asymmetry is
autojoin-in-first-snapshot vs runtime-joined-arrives-late, NOT the subject
kind per se.

Fix: the cold-load restore arm is **reactive, not decide-once**. It lands
`$home` PROVISIONALLY (never a blank screen), keeps re-attempting as the
tracked resources update (each branch reads exactly the resource that will
gain the target, so Solid re-runs when it arrives), overrides the
provisional `$home` when the saved window appears, and stops the instant the
operator navigates (a real non-`home` selection latches `coldLoadDone`;
`provisionalHome` distinguishes placeholder from operator-chosen home). If
the window never returns, `$home` is the correct terminal fallback. No
thrash: the effect writes only `selectedChannel`, which feeds none of its
tracked resources, and `setSelectedChannel` short-circuits same-tuple writes.

Unit: visitor restores; and the decide-once regression net — a channel
landing AFTER the first resolve still overrides the provisional `$home`
(the mock's `channelsBySlug` became a real mutable signal to drive it). e2e
(`issue187-visitor-window-restore.spec.ts`): join, focus, reload → row
`.selected` again (the race proof is the unit test — forcing a split
`/channels` snapshot in-browser is impractical). Deploy: cic-only.

---

### 2026-07-05 — #188: "while you were /away" mentions panel restyle + open-button + clear-on-away

POLISH pass — the server path (`maybe_broadcast_mentions_bundle` →
`mentions_bundle` on the user topic) and row-click-jumps-to-message contract
untouched.

**Restyle (`MentionsWindow.tsx` + `.mentions-*`).** The pane mirrors the
`/list` directory pane (flex-column frame, fixed header, scrollable list) so
the two read as siblings. Heading: `while you were /away — N messages in M
channels`; away interval + reason as a muted sub-line, reason still through
`MircBody` (#142). Rows grouped under muted per-channel labels
(`groupByChannel/1`, pure first-seen-order — server returns
`server_time ASC`). `.mentions-row` mirrors the `.directory-row-join` reset
— properties COPIED, not class-shared, because the row layout differs from
the directory grid; the close-x IS a literal `.directory-close` reuse. Touch
has no `:hover`, so `:active` carries the tappable feedback.

**Close-x + the backTarget gate.** Reuses `closeToPreviousWindow` (#125) —
but that restores the pre-overlay window only if `setSelectedChannel`
recorded `backTarget` at overlay-open, and the recording was gated
`kind === "list"` alone. Extended to `kind === "list" || kind === "mentions"`
(with an overlay→overlay guard): both are transient network-context
overlays, so they remember their opener identically; without this the
close-x fell through the MRU→server→home fallback. `MentionsWindow` stays
presentational (`onClose` callback; Shell wires it).

**Open button.** A `@` button next to the Settings cog opens the panel via
the SAME verb the return-from-away auto-open uses. Network derives from the
current selection like the archive button (`archiveSlugForSelection()`);
rendered ONLY when `mentionsBundleBySlug()[slug]` has a bundle. NOT
mobile-gated (unlike archive): the mentions panel has no sidebar equivalent.
`archiveSlugForSelection()` returns null while the panel is open, hiding the
redundant re-open button.

**Clear-on-away lifecycle.** Bundle SET on return-from-away, now CLEARED on
going away again: `away_confirmed` calls `clearMentionsBundle(network)` when
`state === "away"` — NOT on `"present"`, which IS the return path (clearing
there would wipe the bundle the instant it arrives). Per-network delete;
siblings untouched.

E2E (`issue188-mentions-panel-polish.spec.ts`) drives the REAL path (two
channels, `/away`, peer PRIVMSGs both, return → server aggregates → panel
auto-opens) and asserts restyle, row-click, re-open, close-x, and the button
disappearing after going `/away` again. Deploy: cic-only.

## 2026-07-06 — #192: presence folds window focus, not just Page Visibility (a #182 regression)

**Symptom.** Phone + desktop: the phone never got push while the desktop tab
was open. Root cause: #182's `reportVisibility()` reported off
`document.visibilityState` alone — on desktop that stays `"visible"` when
the window is on-screen but UNFOCUSED. The auto-away FSM never armed, and
since #182's suppression is per-user across all devices (`any_visible?`, by
design — no push-endpoint→socket-pid map), one un-minimized desktop tab
pinned presence and suppressed the whole fan-out.

**Fix — reuse the existing focus-aware signal.** `lib/documentVisibility.ts`
already exported `isDocumentVisible` (= `visibilityState === "visible" &&
document.hasFocus()`, already listening to visibilitychange + focus/blur,
already consumed by `subscribe.ts` + `selection.ts`); the #182 reporter was
the one consumer that bypassed it. Two edits: `reportVisibility()` folds
`&& document.hasFocus()` into the reported bool (kept as a fresh imperative
DOM read — fire-and-forget, decoupled from signal timing, unit-testable);
`main.tsx` replaces the raw listener with `createRoot(() => createEffect(()
=> { isDocumentVisible(); reportVisibility(); }))` — reusing the signal's
one listener set, firing on every transition. Initial state still reported
on user-channel join. Server FSM/debounce/gate unchanged; a brief
blur→refocus within 30s is absorbed by the debounce; mobile unaffected.

**Test-isolation footnote:** reading `hasFocus()` exposed a latent
order-dependency in `socket.test.ts` (the #182 cases relied on jsdom's
default `hasFocus()===true`, which another file could flip); fixed by
pinning focus in the describe's `beforeEach` — precondition now explicit.

**E2E** (`push-focus-suppression.spec.ts`): `visibilityState` pinned
`"visible"`, a `setPageFocus` fixture overrides `hasFocus()` + dispatches
focus/blur, blocks on `__visibilityAck`: focused → no delivery; blurred →
delivered (the fix); refocused → suppressed. Deploy: cic-only.

**2026-07-08 — follow-up: the desktop-FOCUSED case is intentional, not a
bug.** vjt re-opened #192 ("desktop PWA open → never away → breaks push").
Live diagnosis against prod (`:sys.get_state` on WSPresence + each session's
`away_state` via release rpc): he was correctly `:away_auto` with one
`:hidden` socket — the fix was already working; the earlier report was the
old bundle pre-refresh. The ONLY remaining case is a genuinely **focused**
desktop: `any_visible? == true` → no `/away`, push suppressed everywhere.
**That is #182 working as specified** — a mention you can see on a focused
screen shouldn't also buzz your phone. vjt chose keep-as-is, declining
per-device gating (kills the cross-device suppression, redundant buzzes) and
a focus-idle timeout (machinery for a narrow case). **No per-device push, no
idle-away timer — WON'T-FIX by design.** Latent sharp edge: the auto-away
FSM is edge-triggered (`:ws_all_hidden` fires only on a visible→hidden
TRANSITION); a socket `:hidden` from birth produces no edge — not hit here,
but relevant if a future change lets a session sit `:present` with only
hidden sockets.

---

## 2026-07-10 — #89: upstream TLS `verify_none` → `verify_peer` (system CA store)

The Phase-1 expedient (`verify: :verify_none` in `Grappa.IRC.Client`) is
closed: upstream TLS now uses `verify: :verify_peer` against the operator's
**system CA trust store**, with `depth: 3`, SNI, and RFC-6125 hostname
verification.

**The lockout risk, and why it didn't bite.** A wrong flip is catastrophic —
if the upstream cert doesn't validate, grappa can never reconnect after a
restart. vjt: probe azzurra's cert BEFORE any code change; hard-stop rather
than flip blind. The probe: `irc.azzurra.chat:6697` round-robin (2×A +
2×AAAA); openssl chain-probe of EVERY pool member against the system store —
all validate (Let's Encrypt YE1 → ISRG Root), and, critical for round-robin
under a hostname check, **every** member carries `DNS:irc.azzurra.chat` in
its SAN (leaf CNs are per-server). Decisive proof was **real OTP**:
`:public_key.cacerts_get/0` (119 anchors) + `:ssl.connect(verify:
:verify_peer, …)` via the LIVE prod release rpc — handshake OK. Intermittent
`:closed`/`unsupported_record_type,58` on rapid probes was azzurra
**rate-limiting** (a transport drop BEFORE cert verification — identical
under verify_none), confirmed by spacing probes 6s apart; probing stopped
immediately to avoid throttling grappa's real IP.

**The four opts (`Client.tls_connect_opts/1`).** `verify: :verify_peer`
plus: `cacerts: :public_key.cacerts_get()` (OTP 25+ platform bundle — no
cacertfile to ship/rotate; RAISES if no store exists — the honest loud
failure, never a silent downgrade); `depth: 3` (chain is depth 2 + headroom
for a cross-signed root); `server_name_indication` +
`customize_hostname_check` with `pkix_verify_hostname_match_fun(:https)` —
without the hostname check, verify_peer alone would accept any
publicly-trusted cert for any host (the MITM-with-any-leaf class).

**Operator trust-store strategy.** The anchor set is the host OS CA bundle
(FreeBSD `/etc/ssl/cert.pem` via `ca_root_nss`; Linux `ca-certificates`;
macOS keychain); grappa pins nothing. A private/self-signed upstream must
have its CA added to the system store — grappa is never weakened to a
per-network `verify_none`. Documented in the `Client` moduledoc "TLS
posture", `CLAUDE.md` Security, `docs/OPERATIONS.md`.

e2e unaffected (the bahamut testnet binds `--no-tls` on 6667). The `init/1`
verify_none `Logger.warning` became a `Logger.info` recording the posture.
The AuthFSM's historical SASL-blob-leak comments stay as-is — the phase-pin
guard (C1) is the real fix; verify_none only widened the blast radius, and
that context stays accurate as a record.

---

## 2026-07-10 — #205: iPad standalone-PWA layout broke because it renders the DESKTOP shell, not the mobile one

Reported on #it-opers: cicchetto as an iPadOS Home-Screen PWA rendered
clipped in both orientations, top chrome painted UNDER the iOS status bar,
settings cog dead to touch. The suspected naive cause (missing
`viewport-fit=cover` / `env(safe-area-inset-*)` / `100vh`) was ALREADY in
place — for the mobile shell.

**Root cause: the breakpoint, not the insets.** `isMobile()` is
`matchMedia("(max-width: 768px)")` (`lib/theme.ts`); an iPad is WIDER than
768px in BOTH orientations, so `Shell.tsx` renders the DESKTOP `.shell`
branch — and every safe-area/dynamic-viewport rule in `default.css` was
scoped to the mobile shell. The desktop `.shell` shipped a bare
`height: 100vh`, zero insets; with the `black-translucent` status bar the
cog landed in the status-bar reservation zone: clipped and non-interactive
because iOS captures touches there (the exact failure the mobile shell's
UX-3 BIS comment documents: "insets on the container, not the bars"). The
desktop shell simply predates iPad-as-PWA dogfooding.

**Fix (mirror the mobile shell onto the desktop shell):** (1) `.shell` gets
`env(safe-area-inset-*)` padding on all FOUR edges (container-level:
`box-sizing: border-box` consumes the inset from the height, pushing the
whole shell inside the safe area — cog clears the bar AND stays in the hit
region; left/right matter in landscape) + `height: 100dvh` (visible
viewport, vs `100vh`'s taller layout viewport that overflowed) with a
`@supports not (height: 100dvh)` 100vh floor for Safari < 15.4. (2) The base
`.shell-members` `env()` insets RELOCATED into the mobile override: on
desktop the members aside is a grid child of the now-padded `.shell`, so its
own insets double-counted the top inset; the mobile drawer is
`position: fixed` (escapes the container padding box) so it genuinely needs
its own. Values byte-identical → mobile unchanged.

**Double-inset audit:** every other `env(safe-area-inset-top)` consumer is
`position: fixed` itself or a child of a fixed backdrop — each establishes a
viewport-relative containing block, none double-count. Desktop browsers
resolve `env()` to 0 and `100dvh == 100vh` → visual no-op.

**Why no e2e.** Playwright chromium/webkit does NOT reproduce iPadOS
safe-area/dvh physics (`env()` → 0, no status bar) — a clickability e2e
would pass on both broken and fixed code: hollow. Regression guard is a
source-level vitest (`ipadSafeArea.test.ts`): viewport-fit present, four
insets on `.shell`, no bare clipping `100vh`. On-device confirmation stays a
manual dogfood (#111).

---

## 2026-07-10 — #207: error banners were sticky → per-source × dismiss with recovery re-arm

**P0 (vjt).** The #119 region had no dismiss. `ws` + `connectivity`
auto-clear on recovery, but `sw-registration` and `bundle-refresh` have NO
auto-clear event — once shown they stayed up forever, obscuring the UI.

**Fix: a × on every banner, dismissed-state client-local, with re-arm.**
Constrained by two invariants:
- **Never fabricate server state.** The source signals remain the single
  owners of *active*. Dismiss is a pure render filter: `visibleBanners()` =
  `activeBanners()` (untouched) minus a client-local
  `dismissed: Set<BannerSource>` signal.
- **A dismiss must not permanently silence a recurring fault**
  (`feedback_silent_retry_anti_pattern`) — a forever-× would let an operator
  dismiss a WS banner and never see the NEXT break. Dismiss is scoped to the
  **current episode**: `rearmDismissed(active)` (run by the owner in a
  `createEffect` on every re-derivation) drops any dismissed source no
  longer active; when it recovers and later re-fires, its banner returns.

**Why NO auto-dismiss timer** (the issue's other option): a timer hiding
`ws`/`connectivity` *while the fault persists* masks a live problem;
`sw-registration` is the #181 diagnostic surface (a clock loses the lever);
`bundle-refresh` is user-actionable. None wants a clock — the × with re-arm
is the whole fix.

**Reactivity note.** `rearmDismissed` reads `dismissed` via `untrack`, so
the effect depends only on the active set, not its own write; converges in
≤2 runs. The intermediate empty-active state between recover and re-fire is
observed because those arrive as separate signal writes (Solid flushes
between them). `BannerSlot` stays pure (optional `onDismiss`; the owner
holds the state).

**E2E:** click-× + recover-then-re-fire tests via the `__cic_socketHealth`
injected-event hook — no real backend op, so the shared testnet is never
poisoned (the #204 cascade lesson).

## 2026-07-11 — #210: suppress server PING/PONG keepalive from the `$server` status window

**Symptom:** ~1 protocol-noise row/min in `$server` as a `:server_event`.

**Root cause (traced, not assumed).** Two flows: (1) inbound server PING is
answered by the dedicated `Session.Server` clause (`params: [token | _]`) —
already silent, not the noise. (2) **Our OWN liveness probe:** `IRC.Client`
sends `PING :grappa-liveness` after 60s inbound silence (the #100 half-open
watchdog); upstream answers PONG; there was **no `:pong` handler**, so it
fell through the catch-all → `EventRouter.route` → `:pong` not in
`@no_persist_verbs` → `route_unhandled_command/2` persisted a
`:server_event`. THAT is the ~1/min row.

**Fix:** one line — `@no_persist_verbs` gains `ping pong`
(`event_router.ex`). `pong` closes the real leak; `ping` is belt-and-braces
(a malformed param-less `PING\r\n` misses the `[token | _]` guard and would
hit the same catch-all).

**Why this is the correct gate:** `do_route/2` clause order is
numeric-catchall → inbound-INVITE (#78) → `@no_persist_verbs` guard →
persisting catch-all; both cases reach the guard first. Same suppression
point as the `authenticate`/`pass`/`oper` credential-leak deny-list (B6.1
CRIT-1) — one allowlist, one reason: verbs with no user-facing content that
must never touch scrollback.

**Tests:** unit — `:pong` + param-less `:ping` assert `{:cont, ^state, []}`.
Integration (`server_test.exs`): inbound PONG through the `Grappa.IRCServer`
fake, then a server PING; when the outbound PONG reply appears on the wire
the mailbox-ordered inbound PONG is already processed, so `$server`
scrollback deterministically observes `[]` — the user-visible absence is the
real guard.

---

## 2026-07-11 — #152: ident + realname user-settable, live-applied via internal reconnect

**The ask:** split the three IRC identity fields grappa collapsed onto one
(`nick == ident == userid`) so `ident`/`realname` are independent +
user-settable; applying to a LIVE session must not force manual quit/relogin.

**Challenge-the-spec (three findings that shrank the work):** `realname` was
already half-built (Credential column + validation + `effective_realname/1`
fallback into USER — net-new: the visitor side's hardcoded
`"Grappa Visitor"`, a cic field, live-apply). `ident` is the one genuinely
net-new field (the USER username slot was a mechanical nick copy) —
symmetric with the existing `realname`/`sasl_user` pattern. Live-apply
genuinely requires a reconnect (confirmed, no cheaper path): ident/realname
ride ONLY the once-per-registration `USER` command (a second USER →
`462 ERR_ALREADYREGISTRED`); but the reconnect primitive existed (#126):
`Session.stop_session/3` + `SpawnOrchestrator.spawn/4`, and `Server.init/1`'s
injected `refresh_plan` already re-reads the DB row on respawn. Live-apply =
persist → stop → respawn — derive, don't duplicate.

**vjt's binding rulings.**
- **B — ident validation:** STRIP a leading `~` (sanitize, don't reject),
  cap length **10**, shape `^[A-Za-z0-9._-]{1,10}$`. **Stripping the tilde
  IS the anti-spoof guard:** grappa runs no identd, the ircd tilde-prefixes
  unverified idents; a user-supplied `~` must not present as identd-checked.
  Strip only ONE tilde so `~~evil` → `~evil` then FAILS validation
  (strip-all would silently accept `evil`). realname: only the CR/LF/NUL
  `safe_line_token` guard — free-form, no anti-spoof (not an identd
  surface). Single source: `Identifier.{sanitize_ident,valid_ident?}/1`.
- **C — both subjects, same storage:** ident on `Credential` (users),
  `ident`+`realname` on `Visitor`. NO new identity schema. Non-unique, no
  fold, no conflict target — free-form attrs, NOT keys (multiple users may
  share one ident).
- **D — no new event:** the reconnect's natural re-emission of existing
  events + the #204 connecting view suffice.
- **E — visitor defaults unchanged:** realname unset → `"Grappa Visitor"`;
  ident unset → nick.

**Fork A + the Boundary constraint (Option A).** Ruling A wanted two thin
per-subject reconnect wrappers; building the user one surfaced a hard
Boundary collision: `SpawnOrchestrator` deps `Admission`, `Admission`
formally deps `Networks` — a `Networks → SpawnOrchestrator` edge closes the
cycle `Networks → SpawnOrchestrator → Admission → Networks`. (The VISITOR
wrapper is clean only because `Admission` reaches Visitors via `dirty_xrefs`;
this is also why the user `/connect` path keeps spawn orchestration OUT of
the Networks context — the WEB layer calls the orchestrator.) With Fork-C
deferring the registered-user cic surface, the user wrapper had NO caller.
Resolution: build ONLY the visitor wrapper (`Visitors.update_identity/2`);
user ident rides the EXISTING admin credentials PATCH — which does NOT
live-apply an ident change: like its sibling `realname` (unlike
`password`/`auth_method`), `ident` is not in `classify_session_action`'s
auth-touching set, so an ident-only edit is `:left_alone` and applies on the
NEXT reconnect. Deliberate + consistent, not a bug; the deferred user-cic
follow-on's reconnect wrapper (web layer, never the Networks context) is
what makes user ident live-apply.

**Shape.** Data: `Credential.ident` + `effective_ident/1`; `Visitor.ident` +
`.realname` + `identity_changeset/2`; migration adds three nullable columns
→ **COLD**. Handshake: `AuthFSM` gains `:ident` on
struct/opts/`@line_bound_fields` (CRLF self-defense fires on it too); USER →
`USER #{ident} 0 * :#{realname}`; threaded through BOTH SessionPlans,
`Session.start_opts`, `Server.{init_opts,client_opts}`, `Client.opts` —
total consistency, both subjects. Live-apply: `Visitors.update_identity/2` =
validate+persist → (if live) stop → spawn; scrollback +
`last_joined_channels` survive (DB-backed), 001 re-JOINs. Persist-only when
no session live; returns `{:ok, visitor}` — the reconnect is best-effort
(identity IS saved; a cap-blocked bounce is logged, not surfaced). Doors:
`PATCH /me/identity` (visitor-only, 403 users; rides the `/me` nginx
allowlist — no proxy change); admin creds whitelist gains `ident`;
Login-Advanced carries `ident`/`realname` onto the fresh anon row BEFORE
first spawn (bad ident → `:malformed_ident` 400, row purged). cic:
Login-Advanced fields + SettingsDrawer visitor identity editor; registered
user self-service deferred.

**Evidence:** the REAL e2e (`issue152-ident-realname.spec.ts`) has a peer
IRC client witness `nick!~grp@host` after login-Advanced, then
`nick!~grp2@host` after a settings live-apply reconnect (the `~` proves
bahamut tilde-prefixed the unverified ident; the new prefix + a
post-reconnect marker prove re-registration AND rejoin).

## 2026-07-11 — #200: decouple self-JOIN auto-focus from the per-channel WS sub lifecycle

**The leak.** Per-channel Channel subs in `subscribe.ts`'s `joined` Map were
only `.leave()`d on token rotation; on own-PART the Channel + handler +
fastlane sub stayed alive forever. Bounded by distinct channels
joined-then-parted per session lifetime; **benign** — a parted channel's
topic goes silent server-side (the session drops it from `state.members`),
so the dangling sub is inert. Resource hygiene only.

**The trap (why the naive fix was reverted).** S19 (`7a1cecdf`) added the
obvious teardown on own-PART; REVERTED (`81c0e90a`) because it regressed
part→re-JOIN auto-focus: the old "BUG4" auto-focus fired on the per-channel
`kind:"join"` message; teardown forced a fresh `phx.join()` whose subscribe
RACED the upstream JOIN echo — when the echo won, Phoenix does not replay to
a late subscriber, BUG4 never fired, the rejoined pane wasn't focused.

**Challenge-the-spec.** Window STATE was ALREADY replayed on every (re)
subscribe (`push_channel_snapshot/4` re-seeds topic/modes/members/state;
`join_reply/1` re-seeds the cursor) — the only missing piece was the
interactive-`/join` auto-focus TRIGGER. And you can't replay the JOIN
message unconditionally: the snapshot fires on cold-reconnect auto-rejoins
too — unconditional replay would yank focus on every reconnect, and the
server cannot tell interactive from auto-rejoin — that distinction is
cic-side. Decisive second finding: **every this-device join site ALREADY
focuses explicitly and race-free at the issuing boundary** (`compose.ts`
`/join` — CP17 moved focus there precisely because the per-channel path
raced; `HomePane.tsx`; `ScrollbackPane.handleJoinChannel`; `DirectoryPane`
deliberately does NOT, #125). BUG4 was REDUNDANT for this-device joins,
reliably firing only for cross-device/raw-REST re-JOINs on a still-live sub.

**vjt's rulings (GO Option 3):** (a) focus-intent is cic-LOCAL — acceptable
under "cic NEVER originates *window-state*" because focus is a SELECTION
concern, always cic-owned; (b) PER-DEVICE focus, no cross-device sync.

**The fix (cic-only):** remove BUG4's per-channel `setSelectedChannel` (the
per-channel WS handler no longer originates selection) + re-apply S19's
teardown — safe now precisely because auto-focus is decoupled: on re-JOIN
the race-free user-topic `window_pending → joined` chain (CP17/F1, delivered
on the boot-joined user topic — cannot race a subscribe) drives state
recovery + re-subscribe, `refreshScrollback` backfills the JOIN row, focus
comes from the issuing boundary.

**Behavior change (per ruling b):** an external/cross-device re-JOIN no
longer auto-focuses on a device that didn't issue it — more correct
(per-client focus, irssi-like). The one e2e leaning on the old behavior
(`r6-own-action-no-events-badge`) now selects explicitly. Deploy: cic-only →
HOT.

## 2026-07-11 — #211 phase 1 (L2 epic): Credential becomes subject-polymorphic (XOR FK) + `networks.visitor_enabled`

First phase of the #211 L2 epic (unify visitor identity onto the user
Credential model → visitors ≈ users, multi-network visitors). **L2 confirmed
by vjt; L3 (full `subjects`+`subject_id` merge) DEFERRED.** Phase 1 is
**schema EXPAND only** — no behavior cutover, no drops; rode a combined COLD
window with #152 + #200, so: strictly expand-only, rollback-safe, backfill
idempotent + zero-loss on real prod visitors.

**What landed.** `network_credentials` promoted to the subject-XOR shape:
nullable `visitor_id` (FK visitors, ON DELETE CASCADE) as the XOR partner of
`user_id` — the established `Grappa.Subject` pattern of the 8 downstream
tables (NOT a role/type flag; Rule-6 not triggered by XOR-FK). Enforced at 3
layers mirroring `ReadCursor.Cursor`: schema `validate_subject_xor/1`, DB
CHECK `network_credentials_subject_xor`, two partial unique indexes
(`(user_id,network_id) WHERE user_id IS NOT NULL` + visitor twin). Plus
`networks.visitor_enabled BOOLEAN NOT NULL DEFAULT false` — the runtime
allowlist that will replace the compile-time `:visitor_network` pin; phase 1
lands ONLY the column + `false` default ("play safe", vjt); read + admin
toggle are phase 3.

**Why the composite PK had to go.** The table was
`PRIMARY KEY (user_id, network_id)` with `user_id NOT NULL`; a composite-PK
column cannot be NULL, but a visitor credential has `user_id IS NULL`, and
sqlite rejects `ALTER TABLE ADD CONSTRAINT` / in-place PK drops. So the XOR
promotion is a **table-recreate** (the `20260515005117_xor_fk_user_settings`
template) swapping to a surrogate `id INTEGER PK AUTOINCREMENT`, matching
every other XOR table. Invisible to callers: every callsite keys by
`(subject_id, network_id)`, never PK identity; uniqueness moved to the
partial indexes. Notably `network_credentials_user_id_network_id_index` —
which the changeset's `unique_constraint/3` already referenced but NO
migration ever created (the composite PK provided the uniqueness) — is
finally created here.

**The identity columns already existed** on Credential
(`nick`/`ident`/`realname`/`sasl_user`/`password_encrypted`/`auth_method`/
`last_joined_channels`) — net-new columns exactly TWO (`visitor_id` +
`visitor_enabled`). The shared identity-tuple extraction is phase 2.

**Backfill (`20260711125000`, prod-critical, idempotent, zero-loss).** One
Credential per existing visitor (`network_id` from `visitors.network_slug`;
`auth_method` = `nickserv_identify` iff a committed password exists else
`none`, mirroring `Visitors.SessionPlan.auth_method/1`; `sasl_user` = nick).
Decisions: **`password_encrypted` is a raw ciphertext byte-copy in SQL** —
both columns are the same Cloak `EncryptedBinary` under the same vault, so
copying stored bytes preserves encryption-at-rest with NO decrypt/re-encrypt
(test asserts byte-identity AND vault round-trip). **Timestamps COPIED from
the visitor row**, not stamped `now` — already in the exact ecto_sqlite3
`:utc_datetime_usec` storage shape, guaranteed round-trip; a hand-built
`strftime` risks a drift surfacing only as a load crash; semantically the
binding age IS the visitor age. **Idempotent** via `WHERE NOT EXISTS`
(dry-run against a prod-DB copy == real run). **`expires_at`/`ip` STAY on
the visitor row** (identity/TTL lifecycle, not per-(subject, network)).
**Orphan-slug visitors skipped** (JOIN drops them, no error) —
`Bootstrap.validate_visitor_networks!` remains the loud boot signal.

**Expand→contract boundary.** `Visitor` UNTOUCHED: keeps `network_slug`, the
`(fold(nick), network_slug)` folded-unique index (#121), all identity
columns — ~30 readers still assume `network_slug` non-null; drops are phase
7. The rfc1459 folded-nick uniqueness stays on `visitors` and migrates to
the Credential only at phase 7 (where it must reuse `Identifier.nick_fold`
char-identical SQL). Rollback: `down/0` reverts to the composite-PK
user-only shape, discarding backfilled visitor credentials — visitor rows
untouched, no data loss; up→down→up verified.

**Deploy class: COLD.** Design comment: issue #211 comment 4945661060.

## 2026-07-11 — #211 phase 2 (L2 epic): extract the shared IRC-identity tuple (`Grappa.IRC.Identity`)

**Pure behavior-neutral refactor** — the de-duplication the epic exists to
enable. No storage/migration/wire/cic change, no column dropped. Rides the
end-of-crank COLD window; NOT deployed on its own.

**The duplication it kills:** the identity tuple's validators +
`effective_*` fallbacks were pasted verbatim into `Networks.Credential`,
`Visitors.Visitor` (four validator copies), and `Visitors.SessionPlan`
(private `effective_ident/realname` with the `"Grappa Visitor"` default) —
the #152 pain where one review-fix bug had to be patched three times. The
validators were already thin adapters over `Grappa.IRC.Identifier`
primitives; the duplication was the CHANGESET-LEVEL wiring.

**Shape — shared VERBS, not an embedded schema (challenge-the-spec).** The
epic said "extract into ONE embedded schema / changeset pipeline"; both
framings rejected: an `embedded_schema` forces the flat columns into a
nested map column = a storage change = out of scope (and unwanted even at
phase 7) — the codebase uses ZERO `embedded_schema` today. A single bundled
pipeline is insufficient: `Credential` applies `safe_line_token` to
non-identity fields too (`sasl_user`, `password`, `auth_command_template`,
`connection_state_reason`), so that verb must be standalone regardless; a
bundle-plus-verb surface = two ways to do the same thing (the half-migrated
trap). "Reuse the verbs, not the nouns" — literally: shared unit = the
validators; each schema keeps its own cast/required/unique_constraint wiring
(the nouns genuinely differ — a visitor row has no
`sasl_user`/`password`/`auth_method`).

**The module.** `Grappa.IRC.Identity` (`lib/grappa/irc/identity.ex`),
exported from the `Grappa.IRC` boundary alongside `Identifier`. Boundary
rationale: `Grappa.IRC` is the acyclic sink and both `Networks` and
`Visitors` already dep it — zero graph change, no cycle (`Identifier`
already couples IRC to Ecto via `nick_fold/1`). Surface: `sanitize_ident/1`;
`validate_nick/2`, `validate_ident/2`, `safe_line_token/2`
(`validate_change/3` callbacks, error strings verbatim);
`effective_{ident,sasl_user,realname}/2` — value-level fallbacks on plain
strings (NOT structs), so the module depends on neither schema.

**The `effective_realname` divergence is a PARAMETER, not two impls:** user
→ nick fallback, visitor → `"Grappa Visitor"` (ruling E) — one rule, a
fallback argument. `Credential.effective_*` stay as thin struct-accessor
wrappers delegating to the shared verbs (domain-accessor contract preserved;
`Networks.SessionPlan` call sites unchanged).

**Behavior-neutral proof:** existing credential/visitor/session_plan tests
are the characterization lock; `IdentityTest` pins the shared verbs; a
review agent enumerated the full `(binary | nil)²` input space for every
`effective_*` verb against its deleted original — byte-identical (including
the unreachable both-nil `FunctionClauseError`). e2e
`issue152-ident-realname` + `admin-credentials` realname edit green.

**Deploy class: COLD** (end-of-crank; NO standalone deploy). Design comment:
issue #211 comment 4946480803.

## 2026-07-11 — #211 phase 3 (L2 epic): multi-network entry + runtime `visitor_enabled` allowlist + the visitor read-cutover to Credential

First **behavior-changing** phase: the visitor connect chain resolves
identity from the per-`(subject, network)` **Credential**, the compile-time
`:visitor_network` pin becomes the runtime allowlist, the admin toggle
lands. All 7 forks ruled by vjt (recommended option on each). End-of-crank
COLD window.

### Piece A — runtime `visitor_enabled` allowlist replaces the compile pin

`Application.compile_env!(:grappa, :visitor_network)` GONE from BOTH sites
(`Visitors.Login` + `AuthController`); config key removed. Which networks
accept visitors is the DB flag, read at login — hot, admin-togglable,
CLAUDE.md-compliant vs app-env. New readers: `Networks.list_visitor_enabled/0`
+ `get_visitor_enabled_network_by_slug/1`.

**Login network selection (fork 1).** `Login.login/2` gains an OPTIONAL
`:network` slug. Present → must be enabled (else
`:network_not_visitor_enabled` → 403). Absent (today's cic) → default to
the SOLE enabled network: exactly-one = backward-compatible; zero =
`:network_unconfigured` (503); more-than-one = `:network_ambiguous` (400 —
can't happen until an admin enables a 2nd network; cic sends a slug once the
phase-6 picker ships). SUBSUMES #42 (closed).

**Continuity seed (fork 2).** The flag defaults `false`, so a naive cutover
breaks every visitor login. Migration `20260711130000` is
**derive-from-reality** (NOT a hardcoded slug): enable every network that
currently holds visitor credentials. Idempotent, expand-only, any
deployment.

### Piece B — admin `visitor_enabled` toggle (no new route, no nginx change)

Rides the EXISTING `PATCH /admin/networks/:slug` (behind `:admin_authn`,
already nginx-allowlisted). `Networks.update_network_caps/2` renamed
`update_network_settings/2` — one verb owns the editable-settings surface; a
"caps"-named verb that also flips `visitor_enabled` would mislead. Body
allowlist widened; `AdminWire` surfaces it. cic UI deferred to phase 6
(fork 7).

### Piece C — the READ-CUTOVER (the heart)

`Visitors.SessionPlan.resolve/1` stops reading `%Visitor{}` identity columns
and reads the visitor's `(visitor_id, network_id)` Credential. Cutting that
ONE resolver cuts the whole chain — all three callers (Login spawn,
Bootstrap respawn, reconnect) + `refresh_plan` route through it (total
consistency, no split reader).

**Two resolvers, shared fields-only builder (fork 3).** Extracted
`Networks.SessionPlan.base_plan/6` — the ~14 identity/connect fields
byte-identical for user and visitor credentials; each resolver merges its
OWN subject-specific callbacks (they genuinely differ, live in different
contexts). Phase 2's ruling again: shared verb = the field-flatten;
per-subject wiring = the callbacks. The `realname` fallback is a `base_plan`
PARAMETER (user → own nick; visitor → `"Grappa Visitor"`) — fork 4.
One-resolver unification is a phase-5/7 endgame, NOT forced here.

**Fields converge (why the cutover is clean):** the phase-1 backfill made
`credential.auth_method` == the derived value, `sasl_user` == nick,
`autojoin_channels='[]'` so `merge_autojoin` == the pre-cutover list; only
the realname fallback diverged (the param). `session_plan_test`
characterization lock stays green — behavior-neutral because the
write-through keeps Credential == visitor row.

**Write-path maintenance + reconcile (forks 5, 6).** ONE idempotent
choke-point, `Credentials.upsert_visitor_credential/3` (primitives, no
`%Visitor{}` — Networks needs no Visitors dep; the FK stays a dirty_xref),
reused by BOTH: the per-mutation write-through (`Grappa.Visitors` calls it
after EVERY visitor identity mutation via private `sync_credential/1`) and
the bulk reconcile at `Bootstrap.run/0` via
`Visitors.reconcile_credential/1`. MOOTS the phase-1 dormant-drift concern;
self-heals at boot; `resolve/1` also self-heals a missing credential on
first use (`Visitors.resolve_credential/2`). The subject-scoped reader
`Credentials.get_visitor_credential/2` (`WHERE visitor_id ==`, never
`user_id ==`) keeps a visitor out of the user resolver's
`Accounts.get_user!(nil)` crash BY CONSTRUCTION — the phase-1
subject-blind-reader class (`feedback_xor_fk_promotion_audit`).

### What STAYS (phase-7 hold — HARD rule)

No visitor column dropped: all identity columns DUAL-WRITTEN through the
transition; the folded-unique index stays the identity guard; visitor wire
untouched (dropping `network_slug` from the wire is phase 6);
`Bootstrap.validate_visitor_networks!` still reads the scalar. Standard
expand→contract; phase 7 removes the duplication.

**Deploy class: COLD.** Design comment: issue #211 comment 4947161594.

## 2026-07-11 — #211 phase 4a (L2 epic): auth-gate read-cutover to the Credential

vjt LIFTED the phase-7 hold this crank ("i do not want to carry shit over
for ages") — the epic completes 4→7 in one crank, still expand→contract:
every reader cuts over BEFORE any column drops; the contract migration is
dry-run against a prod-DB copy multiple times before the window. Phase 4
split: **4a** auth-gate cutover (behavior-neutral, NO migration); **4b**
folded-nick index expand; **4c** identity-key cutover + accretion.

**The cutover.** `Visitors.Login.dispatch/4` previously discriminated
registered-vs-anon on the `visitors.password_encrypted` scalar and
`secure_compare`d against it. 4a moves BOTH the discriminator AND the
compare onto the visitor's `(visitor_id, network_id)` Credential secret via
the self-healing `Visitors.resolve_credential/2` (the same reader
SessionPlan uses — a drifted credential is rebuilt before the compare). The
auth-side twin of phase 3: phase 7's column-drop becomes a pure column-drop,
not an auth-logic change. Clauses became: nil row → provision (unchanged);
one `%Visitor{}` clause resolving the credential → `dispatch_registered/5`
(secret present) or `dispatch_anon/3` (secret nil).
`Plug.Crypto.secure_compare/2` stays the gate; the DB read happens in both
branches BEFORE the split — no new differential-timing oracle.

**Behavior-neutral proof:** dual-write keeps the stores equal, so the
login_test corpus stays green. Two NEW divergence tests mutate the
credential directly (bypassing the write-through) so the read source is
observable: credential-set + scalar-nil → case 2 + `:password_mismatch`
(dispatch chose case 2 from the credential AND compared its secret);
credential-nil + scalar-set → `:anon_collision` (the gate ignores the
scalar).

**Subject-blind-reader audit (the phase-1 CRITICAL class):** the gate reads
`WHERE visitor_id ==` — never compares against a User credential or another
visitor's; cross-network impossible (keyed by the same `(visitor, network)`
the row lookup resolved).

**What STAYS until phase 7:** the scalar (dual-written) — only the AUTH read
moved. The LIFECYCLE gates that read it as a proxy for "persistent identity"
(logout-anon-purge, `require_registered_visitor`,
`maybe_bump`/`purge_if_anon`) read a persistence property that canonically
lives in `expires_at IS NULL` — re-homed at phase 7 with the column-drop (a
different concern, not smuggled into a behavior-neutral turn).

**Deploy class: COLD.** Design comment: issue #211 comment 4948330894;
ruling 4948477338.

## 2026-07-11 — #211 phase 4b (L2 epic): credential-side folded-nick unique index

Schema EXPAND: partial unique index
`network_credentials_visitor_folded_nick_network_id_index` on
`(fold(nick), network_id) WHERE visitor_id IS NOT NULL` (migration
`20260711131000`) + matching `unique_constraint(:nick, ...)` on
`Credential.changeset/2`.

**Why:** mirrors the `visitors`-table `(fold(nick), network_slug)`
folded-unique index (GH #121, `20260628100000`) onto the Credential, keyed
by `network_id`. Prerequisite for 4c (credential-first login lookup +
accretion collision guard) and 7 (the `visitors` index can drop once
identity lives on the Credential).

**Additive — nothing dropped.** The `visitors` index STAYS through every
functional phase. During transition BOTH hold — the write-through keeps row
and credential in sync, and a visitor NICK rename hits the `visitors` index
FIRST (`Visitor.nick_changeset`), erroring before the credential write, so
the two never disagree.

**Partial + rfc1459-folded.** `WHERE visitor_id IS NOT NULL` — users are a
separate operator-bound identity space, so a user and a visitor credential
may share a nick on one network (proven by test). The fold SQL is
character-identical to `Identifier.nick_fold/1` and `20260628100000`'s
`fold/1` (`lower()` + the four bracket `replace()`s) or SQLite won't use the
index — the #121 invariant. A defensive duplicate-collapse DELETE runs
before the index create (survivor: connected > identified > newest) so a
drifted prod DB migrates rather than aborting; no-op on a clean DB.

Tests (`credential_xor_test.exs`): two visitors can't share a folded nick
per network; collision is rfc1459-folded (`Mez[1]` == `mez{1}`); the SAME
visitor MAY hold the nick on TWO networks (accretion); user + visitor may
share. **Deploy class: COLD** (new migration; end-of-crank window).

## 2026-07-11 — #211 phase 4c (L2 epic): identity-key cutover + multi-network ACCRETION

The core multi-network capability (F7 + #166). NO migration (4b added the
index).

**Identity resolution — credential-first.** `Login.lookup_visitor/2` moves
from the visitor-row `(fold(nick), network_slug)` lookup to
`Credentials.fetch_visitor_credential_by_nick/2` →
`Visitors.resolve_identity_by_nick/2` → the `%Visitor{}` by `visitor_id`.
Phase-7-ready (the scalar drops then, so the row query must go);
behavior-equivalent during transition (write-through sync; login_test corpus
green); reader visitor-scoped so a user credential with the same nick never
resolves.

**`SessionPlan.resolve/2` — network-explicit.** Added `resolve/2` taking an
explicit `%Network{}` (`resolve/1` delegates with the pinned slug). The
injected `refresh_plan` closure now re-resolves the SAME network the session
was spawned for (captures `network.id`, reloads fresh) — NOT the primary
slug — so a network-B session's `:transient` restart re-resolves B.

**Accretion — the new verb.** `Visitors.accrete_network/3` (registered
visitor, target slug, source_ip): gate `visitor_enabled` → idempotency
(`:already_attached`) → attach a NEW `(visitor_id, network)` credential via
the SAME `upsert_visitor_credential/3` choke point (identity's
nick/ident/realname, ANON on B — the visitor hasn't identified there; B's
`+r` observer commits B's secret if they do) → resolve the plan for B →
spawn via the SAME `SpawnOrchestrator.spawn/4` core (flow `:login_fresh`,
cap+circuit gated). The identity stays ONE `%Visitor{}`; accretion attaches
a credential, never a second visitor row. Surface: `POST /session/networks
{network}` (registered-visitor-only; rides the `/session/` nginx allowlist);
errors via `FallbackController` (`:already_attached` → 409;
`:network_not_visitor_enabled` → 403). cic picker is phase 6.

**Bootstrap — respawn PER credential.** `spawn_visitor/2` now enumerates ALL
the visitor's credentials (`list_visitor_credentials/1`), one Session.Server
per credential via `resolve/2`, so a reboot restores every accreted network;
the `reconcile_credential/1` bulk pass still runs first.

**Cross-phase note (NOT a 4c bug — scoped to phase 6/7).**
`Visitors.sync_credential/1` (+ the `+r` `commit_password/2` write-through)
still targets the PRIMARY `network_slug` credential — an IDENTIFY observed
on an ACCRETED network commits the secret to the visitor row + primary
credential, NOT the accreted network's. Accreted networks are ANON-by-design
this phase; per-network password commit is F4, addressed at phase 7 when the
scalar drops and the write-through goes per-credential. Flagged so 6/7
closes it deliberately.

**Auth-risk audit:** both credential readers are `WHERE visitor_id ==` —
never resolve onto a user's or another visitor's identity. Accretion gated
to a REGISTERED visitor (bearer proves identity) + allowlist + idempotency;
the 4b folded index guards cross-visitor collisions on the accreted network.

**Per-network `last_joined_channels` (code-review CRITICAL, fixed in 4c).**
Review caught a real regression: the rejoin list was read+written through
the SINGLE `visitors.last_joined_channels` scalar — two concurrent sessions
(A + B) would CLOBBER each other's snapshots. Root cause: a per-network list
on a single-network scalar. Fix (root-cause; `base_plan` already read
`cred.last_joined_channels` per-network, so write + read become symmetric):
all three visitor channel-list sites now key on `(visitor_id, network_id)` —
the session persister (captures THIS session's `network.id`), the
`GET /channels` visitor branch, cic dismiss — via new per-network
`Visitors`/`Credentials` verbs. `credential_attrs/1` (identity
write-through) STOPPED carrying `last_joined_channels` — an identity
mutation must not reset a live session's per-network list to the stale
scalar. The three dead scalar helpers REMOVED (zero callers; phase-7 cleanup
pulled forward); the COLUMN stays write-dead for the phase-7 drop.
Regression guard: `credential_write_through_test` "per-network channel
isolation" (A + B distinct; dismiss on B leaves A; a nick-change does NOT
clobber the set).

**Deploy class: COLD** (end-of-crank window). Design comment: issue #211
comment 4948330894; ruling 4948477338.

## 2026-07-12 — #211 phase 5 (L2 epic): reconnect symmetry (F6) — shared `SpawnOrchestrator.reconnect` bounce verb

Grounded against shipped phases 1-4, F6 turned out a SMALL behavior-neutral
refactor with one load-bearing challenge-the-spec finding. NO migration, NO
schema/wire/cic change.

**Challenge-the-spec: F6 conflated two distinct intents.** F6 (written
pre-phase-4) pictured the disconnect⇄reconnect CONTROLLER verbs
(`POST /session/reconnect` + user `PATCH {:connected}`) as atomic
stop-then-spawn bounces to collapse onto one verb. In the code they are NOT
bounces — they are **connect-after-separate-teardown**, idempotent-*keep* on
a live session: `/session/reconnect` is the reconnect half of the #126 pair;
`PATCH {:connected}` is the connect half of `{:parked}`⇄`{:connected}`, its
moduledoc documenting concurrent-PATCH safety RELYING on `:already_started`
being a no-op keep. The ONLY atomic stop-then-spawn in the tree was
`Visitors.maybe_reconnect_after_identity/1` (#152) — a bounce is *required*
there because ident/realname ride the once-only USER line. Two intents, two
verbs (never one verb with a `keep_if_live` type-flag): **connect / keep** =
`spawn/4`; **bounce** = the new `reconnect/5`.

**The verb (ruling R1).** `SpawnOrchestrator.reconnect/5` =
`Session.stop_session/3` (graceful QUIT) THEN `spawn/4` (admission →
`Backoff.reset` → `start_session`). Signature `reconnect(subject,
network_id, plan, capacity_input, quit_reason)`, same `spawn_outcome/0`;
like `spawn/4` it does NOT resolve the plan — the caller passes a
pre-resolved plan, keeping the orchestrator subject-agnostic and
Boundary-clean (deps stay `[Admission, Session]`). Properties: **never
`:already_started`** (`stop_session/3` completes its `:DOWN` wait +
registry-unregister poll BEFORE the spawn — the definitional contrast with
the keep verb); **single Backoff reset** (stop never touches Backoff; the
one reset lives in `spawn/4`); **idempotent teardown** (stop returns `:ok`
with no live session); `quit_reason` required (no `\\` default) and
`safe_line_token?`-guarded (CR/LF/NUL crashes loud).

**R1: only the #152 site collapses.** `maybe_reconnect_after_identity/1` now
calls `reconnect/5`. The connect controller paths KEEP `spawn/4`: routing
them through the bounce would convert their documented idempotent-keep into
a spurious drop+rejoin AND regress the concurrent-PATCH double-spawn safety.
R2 (route them too, per the literal F6 bullet) rejected for that behavior
change; R3 (a mode flag) rejected as the type-flag anti-pattern.

**Behavior-neutral proof:** the #152 characterization lock
(`operator_test.exs`) stays green. One conscious, strictly-safer delta: the
plan resolves BEFORE the stop (was stop-then-resolve), so a pathological
plan-resolve failure now leaves the working session ALIVE; the identity is
persisted either way. The `whereis`-live-pid guard + `changed?` no-op gate
retained so a persist-only update never bounces.

**Retires the #152 user-reconnect follow-on:** the phase-6 registered-user
identity editor's live-apply thin-wraps `reconnect/5` (resolve the user plan
in the controller → shared verb) instead of re-inlining stop + spawn. Phase
5 does NOT build that wrapper (no caller until phase 6); it establishes the
verb. Tests: `spawn_orchestrator_test` (LIVE session → FRESH pid, never
`:already_started`; no-live → no-op stop then fresh spawn; admission
rejection propagates; single Backoff reset); end-to-end proven by the
existing `issue152-ident-realname` peer-witness e2e.

**Deploy class: COLD** (end-of-crank window). Design comment: issue #211
comment 4948892801.

## 2026-07-12 — #211 phase 6 (L2 epic): web/wire/cic — visitors ≡ users on the whole surface

The largest phase: visitors equal to users across web/wire/cic. **COLD**
(one small expand migration `networks.visitor_autoconnect`; the
visitor-COLUMN drop stays phase 7). vjt ruled all 11 forks in issue #211
comment 4949196440. Core tension: phase 4 made the visitor MULTI-network on
the server, but the WIRE + cic still assumed single-network — phase 6 moves
every reader of the singular `visitors.network_slug` scalar to the
credential-list model, so phase 7's column-drop is mechanical.

### Ruling A — visitors converge onto the user row (list-shaped /networks)
`GET /networks` visitor branch → `Credentials.list_visitor_credentials/1`
(one row per attached network), twin of the user branch. New
`Networks.Wire.visitor_network_to_json/3` (kind: :visitor, per-network
live-nick + connection_state) — identical to `network_with_nick_to_json/3`
bar the discriminator; the bare `network_to_json/1` + `network_json` type
REMOVED (dead). `resolve_network_nick/2` generalized to a
`Session.subject()` tuple — one live-nick-with-fallback reader for both
subjects. cic's `VisitorNetwork` converged onto the `UserNetwork` twin;
`ownNickForNetwork` resolves per-network from `net.nick` for both kinds.

### Ruling B — drop network_slug from the visitor WIRE
`Visitors.Wire.*`, `AuthJSON.subject_wire`, `MeJSON` visitor type dropped
`network_slug`; the singular `/me` `connected` scalar dropped too
(per-network status lives on `/networks` rows). wireTypes regenerated. cic
lockstep gotcha: `auth.ts` `isValidSubject` had to drop the network_slug
guard — else every persisted visitor subject fails validation → logout loop.
The COLUMN stays dual-written (dropped phase 7); only the WIRE stopped
exposing it.

### Ruling D — visitors carry a REAL connection_state (the epic override)
**Epic role-boundary OVERRIDE (recorded, not asked):** the epic said
"visitor TTL/Reaper vs user connection_state — two distinct verbs, DON'T
merge"; vjt overrode: visitors get `connection_state` (the column already
existed on visitor credentials, unused). The derive-don't-duplicate concern
still holds — `expires_at` (identity lifetime, whole visitor) and
`connection_state` (per-network session state) are INDEPENDENT AXES, neither
derived from the other. `Networks.connect/1` + `disconnect/2` +
`broadcast_state_change` + preload are subject-polymorphic (`subject_of/1`/
`subject_label_of/1` from the XOR FK); the `connection_state_changed`
broadcast's `user_id` is nullable (nil for a visitor — cic acts on
`payload.network` only); `mark_failed/2` stays user-only (visitor terminal
failure is the orthogonal Reaper/TTL axis). `PATCH /networks/:network_id` is
subject-agnostic (dropped `require_user_subject`), resolving the plan per
subject. **Persistent visitor park across reboot** (vjt: "of course cazzo"):
`Bootstrap.spawn_visitor_credential` skips `:parked` per credential —
mirrors the user path.

### §1 headline — the ResolveNetwork visitor cutover (accretion was half-dead)
`GrappaWeb.Plugs.ResolveNetwork`'s visitor branch gated EVERY
`/networks/:id/...` route on slug-equality with the singular
`visitor.network_slug` — an accreted visitor could NOT open network B's
channels over REST (404 at the plug). Cut over to
`Credentials.get_visitor_credential/2` (subject-scoped), mirror of the user
branch. Not a fork — a mandatory cutover the six pieces missed; without it
the 4c capability was half-dead on the wire.

### Ruling C — NO picker, NO extra login step (visitor_autoconnect)
Admin flags networks `visitor_autoconnect` — a SEPARATE new boolean, a
SUBSET of `visitor_enabled`: `visitor_enabled` = "visitors allowed" (the
AVAILABLE tier, shown on home for on-demand connect); `visitor_autoconnect`
= the subset auto-dialed at login. One EXPAND migration (`20260712120000`) +
a derive-from-reality continuity seed (`20260712120100` — autoconnect=true
where visitor_enabled AND already has visitor credentials, preserving
today's single-network behavior). Login stays SYNCHRONOUS on ONE anchor
network (the identity proof, as before); `Login.maybe_autoconnect/3` fires
`Visitors.autoconnect/3` ASYNC under `Grappa.TaskSupervisor` for the rest,
reusing `accrete_network/3` per network so semantics fall out: new →
attach+spawn; live → `:already_attached` skip; PARKED → skip (parked stays
parked across re-login). With one autoconnect network it's byte-identical to
before. Anon accretion allowed (follow-up 2): `POST /session/networks`
relaxed to `require_visitor`; the allowlist + per-IP cap stay the abuse
gate.

### Retired: POST /session/{disconnect,reconnect} (ruling C follow-up 3)
The #126 verb pair is GONE (routes + actions + `resolve_network_id/1` +
`Visitors.{disconnect,reconnect}_session`). Visitors park/reconnect each
network via the subject-agnostic `PATCH /networks/:id` like users; global
disconnect = client-composed park-all (`quit.ts` `quitAll` parks BOTH
subjects — the `require_user_subject` 403 filter is gone). cic lifecycle +
api verbs retired; SettingsDrawer toggle removed; `me.connected` dropped.

### Home convergence (ruling A) — ONE HomePane
`Networks.home_data_for_visitor/1` (twin of the user verb); `MeJSON` visitor
branch populates `home_data` (was nil), which gained `available_networks`
(visitor: `visitor_enabled − attached`; user: `[]`). cic collapsed the two
HomePane branches into ONE data-driven `HomePaneBody`: visitor-only welcome
copy + `AvailableNetworks` (one-tap accretion via `api.addNetwork`);
networks list + reconnect/jump rows subject-identical. `HomePaneVisitor` +
the `visitorSlug` bridge removed.

### Ruling E — per-network identity editor (subsumes original #211)
`PATCH /networks/:network_id/identity {nick?, ident?, realname?}` —
subject-agnostic, writes the `(subject, network)` credential via
`Credential.identity_changeset/2` (folded-nick constraints apply).
Live-apply bounces the LIVE session via `SpawnOrchestrator.reconnect/5`
through a WEB-LAYER wrapper (`NetworksController.live_apply_identity` —
resolves the plan in the controller, NEVER the Networks context: that closes
the `Networks → SpawnOrchestrator → Admission → Networks` Boundary cycle,
per the #152 note). Visitor primary-network dual-write: when the edited
network is the primary `network_slug`, the visitor-row scalar is synced
(login-lookup consistency until phase 7). Scoping: the cic USER editor UI is
deferred — the user credential's ident/realname aren't yet on a cic-readable
wire shape (that wire change belongs with the phase-7 convergence); server
capability + `api.updateNetworkIdentity` ship now; the visitor editor keeps
`PATCH /me/identity`. The two doors converge when the scalar drops.

### Ruling F — two-parallel-azzurra-testnet e2e matrix
The e2e seeder gained azzurra2 (enabled + autoconnect) + azzurra3 (enabled,
NOT autoconnect), same bahamut leaf — a second NETWORK row, not a second
ircd, is what the matrix exercises. `issue211-phase6-matrix.spec.ts`: fresh
visitor auto-connects BOTH; per-network park keeps the other live +
reconnect restores; one-tap connect azzurra3. `mintVisitor` resolves the
anchor slug from the list-shaped `GET /networks`. Reboot-persistence +
per-network-identity-peer-witness are covered server-side (container reboot
is outside the Playwright harness).

### Phase-7 reader enumeration (the DROP surface)
To drop at phase 7:
`visitors.{network_slug,nick,ident,realname,password_encrypted,last_joined_channels}`
+ the `visitors_nick_folded_network_slug_index`. Server-internal
`network_slug` readers: `Visitors.find_or_provision_anon`/`by_folded_nick` +
`get_by_nick_and_network` (case-1 login provision — the reason the identity
editor dual-writes the visitor scalar), `auth_controller.collision_network_slug`,
admin `list_all_with_live_state`/`mark_failed` log/`reap_by_network_slug`,
`bootstrap.validate_visitor_networks!`, `admission` visitor cap, `reaper`,
`identifier`, `visitors/admin_wire`. The `+r commit_password` write-through
still targets the PRIMARY credential (F4 per-network password closes at
phase 7 when the write-through goes per-credential).

**Deploy class: COLD** (expand migration + cutovers; end-of-crank window).
Design comment: issue #211 comment 4949196440.
## 2026-07-12 — #211 phase 7 (L2 epic): THE CONTRACT — visitor row → pure identity/TTL

Final phase of #211 (visitors ≡ users): phase 4 made the visitor
multi-network server-side, phase 6 moved wire+cic to the credential-list
model, phase 7 DROPS the now-unused `visitors.*` per-network scalar
columns. The `%Visitor{}` row becomes PURE identity/TTL — `{id,
expires_at, ip, timestamps}`; ALL per-network identity lives ONLY on
`network_credentials`. **COLD + IRREVERSIBLE** (the column drop); no
standalone deploy — rides the end-of-crank window, gated on fresh prod
backup + dry-runs. Design comment: issue #211 comment 4949196440.

Dropped: `network_slug, nick, ident, realname, password_encrypted,
last_joined_channels` + `visitors_nick_folded_network_slug_index`. Kept:
surrogate `id` (every `visitor_id` FK points at it), `expires_at`, `ip`,
timestamps.

**Migration technique — native DROP COLUMN, NOT the phase-1
table-recreate.** The plan called for rename-aside + CREATE +
INSERT…SELECT + DROP + rename. UNSAFE here: `visitors` is a PARENT with
SEVEN inbound FKs, and SQLite ≥3.25 AUTO-REWRITES every child's
`REFERENCES visitors` → `REFERENCES visitors_old` on the parent rename —
after the final DROP all seven children carry dangling FKs. The phase-1
recreate was safe ONLY because `network_credentials` had zero inbound
FKs. Instead: drop the expression index FIRST, then native `ALTER TABLE …
DROP COLUMN` (SQLite ≥3.35) — no rename, no child-FK rewrite. Migration
`20260712130000`. (Challenge-the-spec: the spec's technique inherited an
assumption that didn't hold for a parent table.)

**registered/permanence is DERIVED from the credentials (vjt ruling).**
`Credentials.visitor_registered?/1` = holds ≥1 credential with a
committed NickServ secret on ANY network — NOT a stored flag.
`commit_password/3` no longer clears `expires_at`; the TTL is purely the
anon sliding clock, overridden by the registered subquery wherever
"permanent" matters. Kills the drift class "derive, don't duplicate"
forbids: with a stored flag, unbinding the last NickServ credential would
leave a permanent+un-reapable row. Composed into every consumer
(list_active/list_expired — Reaper excludes registered —
count_active_for_ip, touch, purge_if_anon, AccountDeletion, logout
teardown, the wire `registered` + admin `identified` fields). Legacy
permanent rows carry `expires_at IS NULL` AND ≥1 NickServ credential;
both guards keep them alive.

**Per-network +r closes F4.** The `+r` observer, `SET PASSWD` rotator,
and NICK self-echo persister commit to the CREDENTIAL of the network the
session was spawned on: `SessionPlan` closures capture `network.id` and
delegate to the network-explicit `commit_password/3` /
`rotate_password/3` / `update_nick/3` (also flipping `auth_method` to
`:nickserv_identify`). Session callback arity unchanged — the Session
boundary never learned about the split.

**Login provision was already credential-first since 4c** (no hard fork):
phase 7 just made provision create a bare visitor row + anon credential
atomically (transaction — a raced folded-nick collision rolls back) and
dropped the visitors-table folded index; the phase-4b credential-side
UNIQUE index is the guard now.

**Subject wire slimmed (vjt rulings).** The `/me` + auth-login subject
wire dropped `nick`/`ident`/`realname` (a multi-network visitor has no
one nick); carries `{id, expires_at, registered}`. `GET /networks` rows
gained `ident`+`realname`; `PATCH /me/identity` +
`Visitors.update_identity` RETIRED — identity editing moves to the
subject-agnostic `PATCH /networks/:id/identity`. cic `displayNick`
resolves from the anchor network row.

**Retired:** `Visitors.{update_identity,persist_identity_scalar,
get_by_nick_and_network,reconcile_credential,reap_by_network_slug}`; the
visitor identity/password changesets; `maybe_dual_write_visitor_scalar`;
`MeController.update_identity` + `visitor_connected?`;
`Bootstrap.validate_visitor_networks!` (FK `ON DELETE RESTRICT` makes the
orphan impossible); `mix grappa.reap_visitors --network`. `admin_events`
`visitor_deleted`/`visitor_reaped` dropped `network_slug`; admin visitors
reshaped to an identity-wide envelope + per-network list; labels use the
lowest-network_id credential nick.

**Latent multi-network bugs fixed in passing:** account_deletion / reaper
/ operator `stop_visitor_session` resolved ONE network from the scalar
slug — now enumerate ALL credentials;
`Admission.count_subjects_for_ip_on_network`'s visitor clause now joins
`network_credentials` (mirror of the user clause).

### Pre-ship cross-phase review — the `NOT IN`-NULL Reaper CRITICAL (caught, fixed)

The pre-ship pass over the WHOLE undeployed cold diff caught a CRITICAL
the per-phase reviews missed. `registered_ids_subquery/0` selected
`c.visitor_id` from every credential with a password — but USER
credentials carry `visitor_id IS NULL`, injecting a NULL, and
`list_expired/0` consumes it as `v.id NOT IN (subquery)`: SQL
`x NOT IN (…, NULL)` is never TRUE, so a single user password silently
ZEROED the Reaper — every expired anon row (plus CASCADE deps) would leak
forever. The test corpus masked it: isolated sandboxes rarely seed a
user-credential-with-password ALONGSIDE an expired anon visitor, and
`x NOT IN ()` is TRUE. **Fix:** scope the subquery to
`not is_nil(c.visitor_id) and not is_nil(c.password_encrypted)`;
regression test seeds the exact poisoning shape. General rule (memory
`feedback_xor_fk_promotion_audit_subject_blind_readers`): a
polymorphic-FK subquery feeding a `NOT IN` is NULL-poisonable — scope it
to the subject column, and never trust an isolated-sandbox corpus to
surface the coexistence. Also fixed: `Operator.list_visitors_text!/0`
computed `identified` from the retired `is_nil(expires_at)` flag; stale
`Visitor`/`MeJSON` moduledocs.

### Post-merge re-review + multi-network reconnect coverage (2026-07-12)

A second adversarial pass on the FINAL MERGED state found zero new
CRITICAL/HIGH/MEDIUM; survivors were phase-7 cutover drift:
`AdminVisitorsTab.renderExpires` still keyed "indefinite (NickServ)" off
the RETIRED `expires_at === null` model — a registered visitor now
carries `identified: true` AND a sliding future `expires_at`, so the
operator saw a bogus countdown; now keyed off the derived `identified`
(regression-locked), plus stale docs re-asserting the dropped-scalar
model. General rule: per-phase reviews miss cross-phase drift; one
on-final-state pass over the whole undeployed diff is the gate.

**Multi-network reconnect e2e (gap closed).** No spec proved ONE subject
on TWO networks surviving a real WS drop — and azzurra/azzurra2/azzurra3
all pointed at the SAME `bahamut-test` leaf (one nick namespace, not a
second network). Two live upstreams for one visitor there is a trap:
`attach_credential` copies the anchor nick → the 2nd upstream dials the
same ircd with the same nick → 433 → `:transient` respawn loop → bahamut
anti-flood AUTOKILLS the source docker IP; the k-line hits every session
and `mark_failed/2` EXPIRES the visitor row mid-test (verified via
`KEEP_STACK=1` + container logs — the runner log doesn't carry the k-line
lines); a distinct-nick dance still trips the autokill. Fix: a standalone
second ircd — `bahamut-test2` (hub role, no S2S link → independent nick
namespace); seeder points azzurra2 at it. New spec
`issue211-phase7-multinet-reconnect`: live sessions on both, nick edit
via the phase-7 door on a live session, WS drop with peers speaking on
BOTH (new `IrcPeer.connect({host})` override), per-network backfill
asserted.

## 2026-07-12 — login card: scroll reachability + matrix-depth emphasis

Two cic-only `/login` changes (direct vjt asks).

**Scroll bug.** `.login` was centered flex + `overflow:hidden`; with the
Advanced disclosure open the form (~643px) overflows a short viewport and
BOTH ends spill — Connect + fields unreachable by any wheel/touch. The
`overflow:hidden` is deliberate (the iOS document-drag-chrome guard, same
family as the `html,body{overflow:hidden}` pins that cost 8 iterations in
UX-6-D), so the fix could NOT delete the clip. Fix: split the two jobs —
`.login` stays the clip frame; a new inner `.login-scroll`
(`overflow-y:auto; overscroll-behavior:contain; height:100%`) owns the
scroll. The card centers with `margin:auto`, NOT
`justify-content:center` — **centered flex clips the TOP of an
overflowing child**, whereas auto margins collapse to 0 under overflow so
both ends stay reachable. General rule for any full-viewport
centered-and-clipped surface: the clip frame and the scroll container
must be different elements, and centering an overflowable child uses
`margin:auto`, never `justify-content:center`.

Test honesty gotcha: the first e2e used `scrollIntoViewIfNeeded()` and
PASSED on the broken code — programmatic scrollTop bypasses
`overflow:hidden`, which a real gesture cannot. A reachability test for a
clipped layout MUST drive the real gesture (`page.mouse.wheel` +
`expect.poll`). See `login-advanced-scroll-reachability.spec.ts`.

**Matrix emphasis (vjt pick: "layered depth + glow").** Kept PURE CSS (no
canvas/RAF — preserves the e2e-stability + no-teardown invariant the
original was chosen for): three drift layers at distinct speeds/tile
sizes (each travels exactly one tile height per loop for a seamless
repeat) + a static radial glow behind the card. Reduced-motion freezes
all three layers; pseudo-elements inherit `pointer-events:none` so the
backdrop stays transparent to the login scroll gesture.

## 2026-07-12 — #219: hold scrollback position for the WHOLE media-overlay lifetime, not just its open edge

#196 (2026-06-11) restores scrollback `scrollTop` only on the media
overlay's open/close EDGE (`viewerScrollSnapshot` + rAF×2). #219 is the
residual: the pane jumps to the BOTTOM mid-overlay. While the fullscreen
viewer covers the pane, two authorities can still move it: (1) on mobile,
opening a fullscreen modal changes the visualViewport → the onMount
`resize` listener → `scrollToActivation("tail-only")` tail snap; (2) a
message arriving runs the length-effect's `atBottom` tail-follow. Either
strands the reader at the tail on close.

Fix: don't fight each authority with more restores — GATE them at the
source. While `viewerScrollSnapshot !== null` (the exact window #196
already holds open), both `scrollToActivation` and the length-effect
early-return. One gate key, no new signal. General rule: **no scroll
authority may move a pane that a fullscreen overlay is covering — freeze
it for the overlay's whole lifetime, not just the transition edge.**

Audio (docked mini-player) deliberately OUT of scope: non-modal, doesn't
cover the pane; gating it would break legitimate
channel-switch-while-playing scroll. Not reproduced; no speculative
change. e2e `issue219-overlay-scroll-hold.spec.ts` drives the
window-level `resize` while the viewer is open — the same authority the
mobile visualViewport change fires (real iOS can't be emulated per
feedback_playwright_webkit_not_ios_scroll).

## 2026-07-12 — #217: user-configurable message-timestamp format (closed-set keys, not strftime)

Message-row timestamp format is now a Settings preference, default WITH
seconds. Supersedes #208 (which hardcoded `HH:MM` for gutter space —
that economy is now the operator's choice).

**Spec challenge — closed-set keys, not a strftime string.** The issue
proposed a persisted strftime pattern: exactly the
untyped-string-for-a-closed-set anti-pattern CLAUDE.md bans. The real
axis is seconds/no-seconds, so the setting is a two-key union
(`"hms" | "hm"`) — typed AND 10x simpler (no strftime engine to
write/parse/sanitize). New formats land as an additional key + one
formatter arm, never a parsed pattern.

**One formatter, both message-row sites.** `lib/timeFormat.ts`:
localStorage-persisted key backed by a module-singleton Solid signal.
The signal is the deviation from theme.ts/fontSize.ts — those apply at
boot as a DOM write, but a timestamp format is consumed at RENDER time; a
bare `getItem` in the render path wouldn't re-run on change.
`ScrollbackPane.formatTime` and `MentionsWindow.formatMs` both delegate —
pre-#217 they were two hand-rolled formatters that had already DRIFTED
(`HH:MM` vs `HH:MM:SS`). Day-separator dates, WHOIS signon, and audio
transport times are NOT message-row times; untouched.

Client-only (display pref, `feedback_no_localized_strings_server_side`
family). The stale #208-era test pinning "never emits seconds" was
rewritten to the new contract, not left asserting superseded behavior.

## 2026-07-12 — #213 pinch-zoom the media-viewer image, confined to the modal

Pinch-to-zoom + pan the modal image on touch, confined to the viewer.

**Why hand-rolled.** iOS-1 (2026-05-17) locked the viewport
(`maximum-scale=1, user-scalable=no`) so cic feels like an app — that
kills native pinch APP-WIDE, and it is a viewport-level property with NO
per-element opt-out. Only option: synthesize the gesture (two-finger
distance → scale → CSS `transform` on the `<img>` alone). Element-scoped
transform + `preventDefault` on every touchmove + `overflow:hidden` clip
= confinement by construction.

**Split: pure geometry vs DOM wiring (swipe.ts precedent).** Math in
`lib/pinchZoom.ts` (DOM-free): `applyPinch` (zero-distance divide guard),
`applyPan`, `toggleZoom` (double-tap fit⇄2×), and the load-bearing
`clampTransform` — scale clamps to `[1,4]` FIRST, then translate to
`±max(0,(scale-1)*axis/2)`; clamping scale first re-confines a pan that
was legal at the larger scale, and an un-zoomed image has bound 0 so it
can't pan for free. `ZoomableImage` owns only gesture state + wiring.

**Passive-listener trap (same as compose-swipe #123).** Solid delegates
touch events to a single PASSIVE document listener, so a JSX
`onTouchMove`'s `preventDefault` silently no-ops. Listeners bind
element-level via ref + `addEventListener` with `touchmove`
`{passive:false}` (+ onCleanup); `touch-action:none` on the zoomable
media hands the raw stream to our handlers. NB vitest/jsdom does NOT
enforce passive semantics — the delegation bug would pass the unit suite
green; only element-level binding + the e2e `defaultPrevented` assertion
catch it.

Tests split per what's provable where (issue123 precedent): chromium
synthesized TouchEvent proves wiring + `defaultPrevented` (webkit's Touch
constructors unreliable); `@webkit` iPhone 15 asserts the
`touch-action:none` CSS contract. Pinch FEEL is a device dogfood call.
Client-only.

## 2026-07-12 — #212: linkify scheme-less `host.tld/path` bare domains

cic only linkified explicit-scheme URLs or `www.`; a pasted
`github.com/vjt/grappa-irc/issues/113` rendered as plain text.

**The anchor is a slash-after-TLD, and that guard is the whole design.**
Linkifying any `word.word` floods prose with false links (`1.2.3`,
`e.g.`, `node.js`, bare `example.com`). The practical discriminator is a
PATH. New alternative: ≥1 label + alphabetic TLD (`[a-z]{2,}`) + a
required `/`:

```
/(?:https?:\/\/|ftp:\/\/|www\.)\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi
```

Deliberate consequences, all pinned by tests: bare `example.com` (no
path) NOT linkified — a scheme or path is required; `1.2.3` / `1.2/3`
rejected (last label before the slash must be ≥2 letters); `node.js`
rejected (no slash); `report.txt/section` DOES match — accepted false
positive rather than shipping a TLD allowlist (the linkifier exists
precisely to avoid pulling `linkify-it`).

**The scheme alternative is listed FIRST so a qualified URL wins whole**
(the alternation short-circuits; the bare-domain branch never fires
inside a matched `https://…`). `toHref` inverted: prepends `https://` to
everything admitted UNLESS already `http(s)://`/`ftp://` — one href
builder, so the media-link classifier and iOS-standalone escape get a
scheme-qualified href with no change on their side (pinned by a
linkify×mediaLink integration test).

IDN caveat: the bare-domain alternative is ASCII-anchored on host+TLD, so
a scheme-less non-ASCII host still needs a scheme — acceptable; widening
the host class risks matching more prose. Client-only; RED-proven e2e
(`b4-linkify-url-anchor-wrap.spec.ts`).

---

## 2026-07-12 — admin Visitors tab: per-network cell CSS + connection-state emoji (ADMIN-LAYOUT-FIX)

vjt reported the Visitors tab per-network line rendering as one glued run
(`pelucheazzurraconnected` instead of `nick · slug · state`).

**Root cause = #211-phase-7 cutover drift.** The per-network render
became a `<ul>` of `<li>`s (LiveBadge + three adjacent spans), but NO CSS
was ever shipped for them — UA defaults gave disc bullets + edge-to-edge
spans. jsdom is blind to this (no default list chrome, no visual-spacing
assertions), so vitest was green the whole time — a textbook
`feedback_cicchetto_browser_smoke` gap. Fix: pure CSS in
`themes/default.css` (list-style none, flex, gap, `·` separator via
`::before`).

**vjt requirement: connection-state renders as an EMOJI.** Closed set =
`Credential.connection_state()` `:connected | :parked | :failed`, plus
`null` (the honesty neutral). New pure `lib/connectionStateEmoji.ts`:
`Record<ConnectionState,{glyph,label}>` with an explicit `⚪`/"unknown"
fallback so null or any future server value degrades VISIBLY, never
throws. 🟢 connected · ⏸️ parked · 🔴 failed · ⚪ unknown; the word as
`title` + `aria-label` (a11y + the vitest seam — assert the label, not
the codepoint). **SEPARATE truth from the `LiveBadge`:** emoji =
`connection_state` (DB intent), badge = `live_state` (live pid), per the
DB-vs-live-state rule; neither derives from or replaces the other.

**Challenge-the-spec: the reported second defect did not exist.** The
brief read the screenshot's far-left `✕` column as overflowing Delete
buttons. Real-browser screenshots at four widths showed Delete renders as
right-aligned TEXT everywhere; the `✕` were the SIDEBAR's own close
buttons peeking from behind the overlaid admin pane — a screenshot
artifact. No code change; the layout e2e keeps a cheap delete-button-box
guard (`admin-visitors-layout.spec.ts`, RED-provable by stashing the
CSS). Client-only.

## 2026-07-13 — #220: per-surface link-vs-surface event routing (cicchetto)

**Bug (P0).** A linkified URL inside a tappable surface double-fired: one
tap both performed the surface action AND browsed the link. Three
surfaces wrap `MircBody` in a `<button>`: the `/list` directory row
(join), the topic bar strip (open modal), the mentions-while-away row
(jump). Nothing called `stopPropagation`. The issue named the first two;
the mentions row is the same class — found in review, fixed per "fix root
causes, not examples".

**Two policies (the crux — not one shared flag):** `/list` + mentions
rows → LINK wins (a link tap just browses, never fires join/jump; the
rest of the row still does). Topic bar → SURFACE wins (a tap ALWAYS opens
the modal; the bar never navigates; links work INSIDE the modal).

**Fix — reuse the verb, not the noun.** Shared mechanism, per-surface
policy: one closed-set knob on the renderer — not copy-pasted handlers,
not a boolean (three states):

```
export type LinkPolicy = "navigate" | "link-wins" | "surface-wins";
MircBody: { body: string; linkPolicy?: LinkPolicy }   // default "navigate"
```

`"navigate"` = pre-#220 behavior, the genuine config default for all 20+
non-tappable sites (zero behavior change). `"link-wins"` = the anchor
`stopPropagation()`s after its media/escape side-effects (modifier clicks
too — cmd-click opens a tab, still no surface action). `"surface-wins"` =
the anchor `preventDefault()`s its own navigation and lets the click
bubble to `openModal`; the modal's own `MircBody` stays `"navigate"`.

**Click vs touch delegation (re-checked).** These are `click` events —
Solid's delegation honors `stopPropagation` while walking the composed
path, observable in jsdom. UNLIKE the #213/#219 lesson (touch → passive
document listener → JSX `preventDefault` no-ops, needs element-level
`{passive:false}`). Click has no passive trap → no element-level binding,
and the e2e is chromium-only (click routing is engine-identical).

`issue220-link-double-fire.spec.ts` is the authoritative real-tap e2e,
RED-proven by reverting the surface wirings.

**Fixture note.** Added `IrcPeer.topic(channel, text)` — pass the RAW
text: `client.raw` adds the IRC trailing-param `:` itself; a manual
leading colon lands as the double-colon `TOPIC #c ::text` trap (found via
`E2E_PEER_DEBUG=1`). The channel creator auto-ops, which beats default
`+t` — no `/oper` needed for a fresh channel.

Client-only; rides the hot `--cic` bundle.

## 2026-07-13 — #219-general: freeze scrollback position across EVERY covering overlay, not just the media viewer

vjt generalized the #219 invariant: ANY UI interaction that covers the
pane — opening OR closing a modal/overlay — must not move the reader's
scroll position. Message-follow (#168 tail-follow + jump-on-SEND) is
EXPLICITLY untouched — that's the user following the conversation, not UI
chrome. Root cause identical to #219, just wider (visualViewport resize
tail snap + length-effect tail-follow, under ANY covering modal).

**Generalize the KEY, not the mechanism.** There is already a central "an
overlay is open" source: `lib/overlayScrollLock.ts`'s refcount, which
every covering modal + drawer already pushes into. Keying the freeze on
`overlayCount() > 0` SUBSUMES #219 — no per-modal flag (derive, don't
duplicate). Three changes: (1) back the refcount with a Solid signal so
`overlayCount()` is a TRACKED source — a plain-`let` read would let the
freeze memo go stale (API + iOS touch-lock semantics unchanged); (2)
`viewerScrollSnapshot` → `overlayScrollSnapshot`, both gates through one
`isOverlayFrozen()` predicate; (3) `TopicBar` — the ONE covering surface
not registered with the refcount — wired via `createOverlayLock`.

**KEY-GUARD (the delta that is NOT a mechanical rename).** A covering
modal can switch the window on close (a nick click in /names opens a
query AND dismisses in one gesture); ScrollbackPane persists across
channel↔query, so a blind restore would stamp the LEAVING channel's
scrollTop onto the switched-to window. The snapshot is pinned to the
channel key it was captured on (`overlaySnapshotKey`); freeze + restore
both require `overlaySnapshotKey === key()`.

**Link clicks were already safe** (verified, not re-gated): plain links
are `target=_blank`; same-origin media links open the now-gated viewer;
same-host non-media go through `maybeEscapePwaClick`. No link path moves
the pane on its own.

E2e `issue219-general-overlay-scroll-hold.spec.ts`: a resize under the
/names modal (a covering NON-media modal) holds the offset; a regression
guard proves message-follow still works. Client-only, `--cic`.

## 2026-07-13 — #216: channel modes visible on join + /mode viewer/editor modal (SHAPE 2 + full ISUPPORT)

**The P0 (root cause).** ircds do NOT send `324 RPL_CHANNELMODEIS`
unsolicited on JOIN, and grappa never issued the bare `MODE #chan` query
that elicits it — the whole 324→cache→broadcast→cold-snapshot→cic
pipeline existed; only the query was missing. Fix:
`Client.send_channel_modes/2` (bare `MODE #chan`) called from the
`{:joined, channel}` apply-effects arm — every join path funnels through
the self-JOIN echo, so one call covers them all; a dead-socket send is
non-fatal via `maybe_log_send_failure/2` (a cosmetic query must never
crash the session). Makes #216 a SERVER change.

**Full ISUPPORT plumbing (vjt's decision over a cic static table).** The
modal's toggles come from the real `005 RPL_ISUPPORT`
`CHANMODES=`/`PREFIX=`, replacing the compile-time EventRouter constants
("deferred to Phase 5" — this is that lift):
- New pure `Grappa.Session.ISupport`: `default/0` (the exact former
  constants — bahamut/Azzurra), `merge_isupport/2` (malformed tokens
  ignored so a misbehaving server can't corrupt classification),
  `takes_param?/3` (RFC-2811: type A/B always, type C on `+` only, type D
  never — the `-l`-consumes-no-arg correctness point), `user_prefix/2`.
  Classes are plain lists, not MapSets (dialyzer `contract_with_opaque`
  fights an opaque type in a literal-returning spec; sets are <20 chars
  and directly JSON-encodable).
- **Total consistency:** both EventRouter MODE walkers now read
  `state.isupport` via ISupport; the two `@`-constants are DELETED. A
  router state without `:isupport` falls back to `default/0` — pre-#216
  parsing byte-identical.
- `Session.Server` holds one `ISupport.t()`, folds 005, broadcasts typed
  `isupport_changed` on the user topic; `get_isupport/2` facade + a
  cold-WS-subscribe snapshot (`push_isupport_if_live`) close the
  always-on-session race where every 005 fired before any client
  subscribed.
- **Wire payload is FLAT** (`chanmodes_a..d` top-level lists): the
  wire-type codegen emits nested maps in an indentation biome reflows, so
  the two check.sh gates disagree on a nested shape.

**cic.** `lib/isupport.ts` (store by network id + DEFAULT fallback);
`lib/channelModes.ts` — the static mode-DESCRIPTION table (UI copy lives
in cic per the no-localized-strings rule; ISUPPORT supplies letters +
arity, cic supplies meaning) + `availableModes/1`, which EXCLUDES PREFIX
membership modes and type-A list modes (not boolean toggles).
`ModeModal.tsx`: edit gate ← own-nick's `@`/`%` via the exact MembersPane
`ownModes` derivation (no parallel state); toggling pushes the SAME
`mode` WS verb `/mode #chan +s` uses (one feature, one code path);
registers `createOverlayLock` (#219-general contract). Param modes (k/l)
read-only in this MVP; explicit `/mode #chan +k secret` still works.
Three entry points by argument shape: `/mode #chan` / bare `/mode` →
modal; the `.topic-bar-modes` indicator is now a `<button>`
(keyboard-reachable, the #220 noStaticElementInteractions lesson);
`/mode` WITH args executes directly.

**Deploy.** SERVER deploy (auto-hot), not just `--cic`. MODE-on-join
fires only for channels joined after the reload; already-joined channels
populate on next join/reconnect — acceptable for a cosmetic P1.

**Hot-reload field-add hazard (fixed before deploy).** #216 adds a NEW
`Session.Server` state field `:isupport`. A hot module reload does NOT
run `code_change/2` or rewrite live state, so the ~29 always-on procs
keep their OLD keyless map — a bare `state.isupport` read OR a
`%{state | isupport: …}` update KeyErrors, crashing the `:transient` proc
→ respawn = IRC reconnect = session DROP; cic reconnects its WS
routinely, so a rolling crash-wave, not zero-drop (orchestrator caught
pre-deploy). Fix: every server.ex access uses `Map.get(state, :isupport,
ISupport.default())` for reads and `Map.put/3` for writes — never the
`%{state | …}` form, which requires the key to pre-exist. Guarded by a
hot-reload-safety test that strips `:isupport` via `:sys.replace_state`
and asserts the proc survives (same pid).

E2e `issue216-channel-modes-on-join.spec.ts`: a peer sets `+t` BEFORE the
join so the indicator can ONLY be populated by the join-time query — RED
(query disabled) then GREEN.

## 2026-07-13 — #230: wheel-up loads older scrollback when content underfills

**Bug (P0 desktop).** When the loaded window is SHORTER than the
container, `.scrollback` emits NO native `scroll` event on wheel — and
the CP14-B2 scroll-to-top `loadMore` trigger lives inside `onScroll`. The
operator was stuck with no path to older history. Same family as the
login-scroll fix: a container that only owns-scroll on overflow strands
reachability when it doesn't.

**Fix.** `onWheel` reacts to wheel-UP (`deltaY < 0`) on an underfilled
pane (`scrollHeight <= clientHeight`) by firing the SAME top-of-buffer
`loadMore`; both call sites delegate to one shared `maybeLoadOlder()`
closure (threshold gate + loadMore + the prepend position restore).
`loadMore` idempotency (per-key in-flight Set + exhausted-page latch)
makes the extra call safe; the `setLastInputEventAtMs` marker-stamp is
preserved.

**The underfill gate is load-bearing, not an optimization (review
catch).** On an OVERFLOWING pane `onScroll` already owns loadMore with
the CORRECT post-scroll geometry; `wheel` fires one tick BEFORE the
native scroll is applied, so a wheel-path loadMore there would capture a
STALE pre-scroll `scrollTop`, win the in-flight race, and restore to the
wrong anchor. Gating on `scrollHeight > clientHeight` keeps `onScroll`
the single scroll-restore authority on overflow; the wheel is purely the
underfill rescue.

**No `preventDefault` (deliberate).** `.scrollback` is the SOLE scroll
container (ancestors `overflow:visible`, html/body hidden +
`overscroll-behavior:none`), so an unconsumed wheel-up has nothing to
chain-scroll — a plain passive/delegated JSX `onWheel` is correct. (Had a
scrollable ancestor existed, a JSX `onWheel` could NOT `preventDefault` —
Solid routes wheel through a passive delegated listener — and the handler
would need an element-level `{passive:false}` binding.)

E2e `issue230-wheel-underfill-loadmore.spec.ts`: a tall viewport makes
the tail load underfill (asserted precondition — anti-vacuous-green); a
real `mouse.wheel` must grow the row count. cic-only, hot `--cic`.

---

## 2026-07-13 — #229 umode viewer/editor modal (1:1 mirror of #216)

`/mode <nick>` / `/umode` (and a tap on the network-header umode
indicator) open a modal of the operator's OWN user modes, editable,
populated FROM CONNECT. vjt: "stesso e identico comportamento" as #216.
The #216 pipeline transposed cleanly; verified divergences:

1. **Emit point is 001 RPL_WELCOME, not the `:joined` arm** — umodes are
   per-session. `Client.send_umode_query/2` (bare `MODE <nick>`, using
   the server-authoritative `welcomed_nick`) fires from the numeric-1
   handler, non-fatal. ircds don't report own umodes unsolicited.
2. **221 RPL_UMODEIS was UNPARSED.** New EventRouter clause treats it as
   a full authoritative snapshot (REPLACE, like 324). Delegated in
   NumericRouter so it doesn't persist as a `$server` `:notice` leaking
   the raw "+iwS" (same disease as the 324/332/333 family).
3. **Reuse the existing self-MODE branch (#154b), add the noun** — the
   +/- delta folds into the `umodes` set INSIDE that branch (mid-session
   `/umode +x` and services-set +r/+a both flow through it); no parallel
   detector. `apply_umode_string/2` is a flag-only walker (umodes take no
   params).
4. **Cold-snapshot rides the USER topic, not per-channel.** #216's
   isupport snapshot could ride the per-channel push because isupport has
   a bahamut default; umodes have NO default and are reachable with ZERO
   channels — the snapshot fans one `umode_changed` per bound network
   (new subject-generic `Credentials.list_networks_for_subject/1`). E2e
   witness: set `+i`, RELOAD — only the cold snapshot can repopulate;
   RED (snapshot stashed) then GREEN.
5. **cic: sibling UmodeModal, NOT a param'd ModeModal.** The data sources
   fork completely (no ISUPPORT source — the static `umodeModes.ts`
   table IS the available set; no channel, no edit gate, no params). A
   shared-data-model-with-a-type-flag would be a boundary violation
   (design-discipline #6); the sibling reuses the VERBS (the
   `.mode-modal-*` CSS, overlayScrollLock, store shape). Services-managed
   umodes (o/r/a/A/S) render read-only. `/mode <nick>` opens the modal
   ONLY for the operator's own nick (ownNickForNetwork + nickEquals);
   another user's is a friendly error.

**Hot vs COLD → COLD** — the new `:umodes` Session.Server state field
trips the deploy preflight `state_shape` check exactly like #216's
`:isupport` (SoT: `lib/grappa/hot_reload/long_lived_modules.ex`). All
reads `Map.get(state, :umodes, [])`, writes `Map.put` regardless —
guarded by a `:sys.replace_state`-strips-the-field survival test. Server
part batches into an attended cold window; cic part rides `--cic`.

Scope: "all modals close on ESC" split out to #232 — NOT done here.

## 2026-07-13 — #231: /lusers card routes to the CURRENT window, not always $server

**Bug.** `/lusers` surfaced its card ONLY in `$server`, regardless of
where issued — every other lookup affordance (WHOIS/WHOWAS) mounts in the
current window.

**Root cause (one gate).** `LusersCard` is a pinned overlay card
(WhoisCard family, not a modal). Its siblings mount UNCONDITIONALLY and
self-null when no bundle exists; LUSERS alone was wrapped in
`<Show when={props.kind === "server"}>`.

**Fix (pure-client, one edit).** Delete the Show-wrapper, mount bare —
the WhoisCard mechanism: only ONE ScrollbackPane is mounted at a time and
the store keys by networkSlug (last-write-wins), so the card renders in
the active window. Subtleties honored (documented, NOT bugs): (1) the
connect-time auto-emit renders in whatever window is active at connect —
acceptable; a "welcome-emit stays quiet" change would be a SEPARATE
issue. (2) Network-scoped, not window-scoped — the same snapshot shows in
every window of that network, exactly mirroring WhoisCard; per-window
keying would be a boundary change + scope-creep. (3) Card only on
kindHasScrollback windows — already correct.

The old `p0d-lusers-card-server-window.spec.ts` asserted the buggy
contract — renamed `issue231-lusers-current-window.spec.ts`, rewritten to
issue `/lusers` from a channel and assert the card there. RED then GREEN.
HOT, rides `--cic`.

## 2026-07-13 — #222: hide join/part/quit/nick-change on large channels by default, per-channel opt-in to re-show (cicchetto)

On large channels J/P/Q (+ nick-change) is noise. cic suppresses those
rows CLIENT-SIDE by default once a channel is "large"; a per-channel
toggle re-shows; the choice persists. grappa STILL delivers the events —
cic decides whether to RENDER. Client-only, no wire/server change (#217
precedent + `feedback_no_localized_strings_server_side`).

**Four defaults:** (1) "large" = `LARGE_CHANNEL_THRESHOLD = 50` members —
ONE named constant in `lib/presenceFilter.ts`, one-line tune. (2) Toggle
scope = per-channel CLIENT preference, localStorage — NOT a server/shared
setting. (3) NICK changes ARE in the suppression set. (4) Persistence
keyed by `channelKey` — case-folds, so `#Chan`/`#chan` share one pref
(the channel-fold invariant).

**The precedence rule (the "tough" part) is a TRI-STATE, not a boolean:**
`"show" | "hide" | unset`. A boolean can't express "no explicit choice —
follow the live size default" and would lose auto-hide-on-growth.
`resolvePresenceVisible(pref, memberCount)`: show → true, hide → false,
unset → `memberCount < THRESHOLD`. Explicit choice WINS; unset follows
the live count; any toggle pins the channel regardless of size.

**Render-layer filter, NOT a store drop.** The filter lives in
ScrollbackPane's `rows()` memo — suppression is purely visual; the store
stays intact so unread-counting, the read-cursor divider, and own-JOIN
auto-focus (which reads `messages()`, not `rows()`) keep working. Reading
BOTH the pref signal AND the member count inside the memo makes it
reactive to the toggle and to threshold-crossing.

**Narrow suppression set — NOT `PRESENCE_KINDS`.**
`SUPPRESSED_PRESENCE_KINDS = {join, part, quit, nick_change}`. The
existing `PRESENCE_KINDS` also holds mode/topic/kick/server_event — those
are NOT noise and MUST stay visible; reusing it would be a bug.

**Own presence suppressed uniformly** (incl. the operator's own
join/part) — simpler, and `isOwnPresenceEvent` already excludes it from
unread counts. E2e consequence: with presence hidden, the own-nick JOIN
line the `selectChannel` fixture gates on is ALSO hidden → the
post-reload re-focus uses `awaitWsReady: false` + a persisted PRIVMSG row
instead.

**UI.** A `presence-toggle` `<button>` (👁/🙈) in TopicBar; flips the
CURRENTLY EFFECTIVE visibility and always writes an EXPLICIT pref, so one
tap pins the channel. A `<button>`, not a `<span>` — static-element
onClick trips biome `noStaticElementInteractions` (#220 lesson) and loses
keyboard access.

**Tests.** `presenceFilter.test.ts` owns the size-default + precedence
truth table. The size-default MATH is NOT e2e'd — 50 real peers from one
IP risks bahamut flood/autokill
(`feedback_e2e_multinet_live_needs_distinct_nicks`) and there is no
member-count seam in the harness; `issue222-presence-filter.spec.ts` owns
the interactive path.

**Known minor edges (accepted).** (a) Before `members_seeded` lands,
memberCount = 0, so a large channel with an unset pref briefly shows
J/P/Q, then auto-hides — self-correcting. (b) The in-pane unread-marker
derives from the FILTERED rows, diverging from the sidebar events badge
(unfiltered store) — badge = "something happened", divider = "where you
were reading".

HOT — pure-client, rides `--cic`.

## 2026-07-14 — #221: Libera/solanum upstream query gaps (WHOIS numerics, on-connect usermodes, /who <mask>) + a real solanum CI node

Multi-network shipped (#211) and Libera.Chat runs **solanum**, whose
numeric/usermode surface diverges from the Azzurra bahamut the parser was
built against. Three gaps reported against a live Libera upstream. The
authority for every fix is the solanum source (validated against tag
`a4998b5`), NOT observed traffic or bahamut assumptions.

### Gap (a) — WHOIS numerics mis-parsed / misrouted

`NumericRouter.@delegated_numerics` listed only the bahamut WHOIS codes.
Solanum's extras — 330 RPL_WHOISLOGGEDIN, 338 RPL_WHOISACTUALLY, 671
RPL_WHOISSECURE, 276 RPL_WHOISCERTFP, 320 RPL_WHOISSPECIAL — fell
through to `scan_params/2`, whose nick-shaped scan routed each to a bogus
`{:query, <target-nick>}` notice window: the localized trailing text
leaked into a phantom DM named after the WHOIS target.

Fix, two layers: (1) *typed folds* into the `whois_pending` accumulator.
Structural difference: solanum puts data in MIDDLE params where bahamut
used localized trailing — 330 account = `params[2]`; 338 carries the
client IP only (`actually_ip`) and is a DIFFERENT numeric from Azzurra's
378 RPL_WHOISACTUALLY (solanum's own 378 is RPL_WHOISHOST, not folded);
671 → `secure: true`; 276 → `certfp`; 320 → `extra_lines`. (2) *Generic
future-proofing* (fix root causes): `NumericRouter.route/2` reads a
`whois_targets` set (derived from `whois_pending` keys) and returns
`:delegated` for ANY numeric whose `params[1]` targets an in-flight
WHOIS — a numeric solanum adds next year folds into `extra_lines` with
ZERO code change instead of misrouting. No pending entry → no fold
(unsolicited numerics flow to the catch-all as before).

Wire: `whois_bundle_payload` gains
`account`/`secure`/`certfp`/`extra_lines` — defaults chosen so a bahamut
bundle marshals unchanged; `extra_lines` prepended LIFO, reversed on
emit. Rendering the new fields in the card was declared out of MVP — data
relayed only. (That debt became the REOPEN below.)

### Gap (b) — on-connect usermodes: already generic, NO change

`apply_umode_string/2` + `walk_umodes/3` (#229) are letter-agnostic — no
allowlist, no ordering assumption — so solanum's distinct letters fold
correctly via both the 221 snapshot and the on-connect self-MODE echo.
Characterization tests lock it in. Honest TDD outcome: expected RED went
GREEN immediately, proving the concern was already handled.

### Gap (c) — `/who <mask>` returned total silence

Two independent breaks. *Break 1 — outbound gate:* `Client.send_who/2` +
the GrappaChannel "who" handler validated the target as a CHANNEL,
rejecting a mask before it left the bouncer; WHO accepts a channel OR a
host/nick mask (RFC 2812 §3.6.1). The gate is now a single wire token
(`safe_oper_token?` — non-empty, no whitespace/CRLF/NUL): a mask
forwards; a space (extra WHO slots) or CRLF (injection) is still
rejected; `Session.send_who/3` no longer assumes a channel
(`canonical_channel/1` is a no-op on a mask). *Break 2 — inbound
correlation:* solanum sets the 352 channel field to `"*"` for a mask WHO
(`m_who.c:507`) while 315 echoes the ORIGINAL mask — `who_fold` keyed on
the per-row channel, so rows accumulated under `who_pending["*"]` but 315
drained `who_pending[<mask>]`: key mismatch, whole reply dropped. Now:
exact channel-key match first (channel WHO, concurrent-safe), else
single-in-flight fallback (mask WHO — WHO is mailbox-serialized). Even a
zero-match mask surfaces an empty modal (solanum always emits 315) —
feedback, not silence. No wire-type change.

### Gap (d) — a real solanum node in CI

The azzurra2 upstream (the standalone second network from #211 phase 7)
now runs **solanum**, at `cicchetto/e2e/infra-solanum/` (NOT the
azzurra-testnet submodule — different conf format + meson build). Build
gotcha: `libltdl-dev` (build) + `libltdl7` (runtime) — solanum dlopen's
its modules via libltdl; without it meson fails at `ltdl not found`. Conf
is standalone + plaintext-only (grappa dials `--no-tls`) with
deliberately raised connection/flood/throttle limits — the suite drives
many connections through ONE source IP and solanum's stock
`number_per_ip=10`/`throttle_count=4` would throttle-flake unrelated
specs. `compose.yaml`: service renamed `solanum-test2` but the
**`bahamut-test2` network alias is retained** — the azzurra2 seed and the
#211 phase-6/7 specs resolve unchanged; zero topology blast radius. The
gap-(a) extras (330/671/276) need TLS + services the plaintext node
lacks → those folds stay unit-proven; the node's integration value is the
numeric ROUTING via the WHO round-trip.

### Deploy classification (per part)

lib/ fixes: HOT (whois_pending/who_pending are Map.get-defaulted
GenServer state; no state-shape change, no new child, no migration) + a
`--cic` bundle for the wire-type/narrower change. Solanum node: CI infra
only, never deployed to prod.

## 2026-07-14 — #221 REOPENED: WHOIS account/secure badges never reached the modal (cic render debt) + 671 cipher captured

**Symptom (live Libera).** WHOIS of an account-logged-in + TLS user: the
raw 330/671 lines correctly no longer leak, but the modal showed no
registered/SSL badge, no account name, no TLS string — info at least
visible pre-fix as raw lines was now silently dropped.

**Root cause — the drop point was cic `WhoisCard.tsx`, NOT the parser.**
Traced end-to-end; the server side was correct. The prior #221
"rendering is out of MVP" debt WAS the regression. `collectTags` badged
"registered" off `is_registered` (307 — bahamut-only) and "SSL" off
`using_ssl` (275 — bahamut-only); solanum signals the SAME facts via 330
→ `account` and 671 → `secure`, so neither badge fired on Libera, and
the card had no rows for account/secure_cipher/certfp at all.

**Fix (at the drop point).** `collectTags`: registered fires on
`is_registered || account !== null`; SSL on `using_ssl || secure` — both
ircds map to one badge, bahamut path unchanged. New `<dl>` rows render
account, the TLS-protocol string, and certfp via the shared `MircBody`
path.

**671 TLS-protocol string was ALSO discarded server-side.** solanum
appends a bracketed `[<version>, <cipher>]` when the whois'd client is
local and the cipher is oper/self-visible. New
`parse_secure_cipher_trailing/1` (end-anchored `\[([^\]]+)\]\s*$`)
captures it into a new `secure_cipher` field through the whole pipeline;
the fixed English prefix is dropped
(`feedback_no_localized_strings_server_side`); a bare trailing folds
`secure: true` only.

**Tests that encoded the bug — inverted (never-assert-buggy-behavior).**
The 671 unit test used the WRONG trailing shape (parens, not solanum's
brackets) and asserted only `secure: true` — capturing suppression, not
the payload; rewritten. `WhoisCard.test.tsx`'s baseBundle carried the
fields but nothing asserted they RENDER — added. Also fixed pre-existing
breakage in `userTopic.test.ts` (mock bundle omitted required fields; cic
vitest is NOT in `check.sh`, so it slipped past). E2e: the plaintext CI
node cannot emit 330/671/276, so `issue221-whois-badges.spec.ts` drives a
REAL `/whois` and uses Playwright `routeWebSocket` to augment THAT
server-emitted frame with the four fields — only the values the node
physically cannot produce are injected; framing, decode, narrow, store,
render are all production code.

Deploy: HOT server reload + `--cic` bundle (the 671 capture is a
Map.get-defaulted accumulator + Wire projection field — confirmed against
`Grappa.Deploy.Preflight`). No COLD, no migration.

## 2026-07-14 — #233 read cursor is monotonic (advance-only); kills the scroll-to-bottom jump-back

**Symptom.** Tap scroll-to-bottom with unread above → view jumps to
bottom, then ~2s later snaps back UP to the old read marker; more taps
eventually stick.

**Root cause (confirmed in source).** `ReadCursor.do_set/4` was
**last-write-wins** — any different id, including a LOWER one, was
written unconditionally. The sequence: cic taps scroll-to-bottom while
the newest page is still loading (measured 1578ms); the read-cursor POST
carries the currently-loaded bottom (a LOWER id); the server writes it
backward and broadcasts `read_cursor_set` ~1–2s later; every cic instance
(including the originator) applies it and snaps back. cic is already
forward-only locally (`lib/readCursor.ts`) and adopts a backward move
only via the server echo — the server was the single authoritative
regressor.

**Fix — monotonic clamp in `do_set/4`.** Write ONLY when
`message_id > current`; at-or-below is a no-op returning the EXISTING
cursor (the `<=` boundary subsumes the old equal-id no-op). `nil` still
inserts. Read-then-compare over atomic `update_all(where: … < ^id)`:
SQLite is single-writer so writes serialize, and it returns the
`%Cursor{}` struct cleanly, preserving `set/4`'s contract; a
concurrent-POST TOCTOU can only race two ADVANCES (higher wins) —
acceptable.

**`is_integer(current)` in the guard is LOAD-BEARING (review catch).**
`last_read_message_id` is `REFERENCES messages(id) ON DELETE SET NULL`,
and the archive-delete path (`Scrollback.delete_for_channel/3` /
`delete_for_dm/3`) bulk-deletes messages, leaving the cursor row alive
with NULL (the migration explicitly designs for recovery-on-next-set). In
Elixir term order a number sorts before any atom, so `message_id <= nil`
is TRUE for every id — a bare guard would freeze a NULL'd cursor forever
AND hand `broadcast_set/5` a nil that crashes its `is_integer` guard
(→ 500). Guarding `is_integer(current) and message_id <= current` lets a
NULL cursor fall through and recover. Regression test nils the cursor via
the real `delete_for_channel/3` purge, then asserts the next set
advances.

No controller change: on a stale (lower) POST the broadcast now
RE-AFFIRMS the current (higher) id instead of regressing it. Only the
moduledoc prose changed (it described last-write-wins — now a lie).

**Mark-as-unread escape hatch intentionally NOT built (YAGNI).** Verified
@ d2fcaed1: no mark-as-unread feature exists — `set/4` → `do_set/4` is
the ONLY cursor write path; a reserved `mark_unread/4` would be
speculative API with zero callers. Documented in the ReadCursor moduledoc
"Semantics" so no one "fixes" the guard away — do NOT relax `<=` to `<`
to pre-empt it; a future mark-as-unread adds its OWN explicit path, THEN.

Two tests asserted the bug — deleted + inverted
(never-assert-buggy-behavior): the "lower id moves the cursor backward"
unit test and its HTTP twin became monotonic-clamp assertions.

**Deploy: HOT** — pure logic in one private function (contrast #223, COLD
for a new child). Out of scope: cic persisting only the true-newest id
after the newest page loads — not needed; the server clamp is
authoritative.

---

## 2026-07-14 — #244 (P0): directory /list tap now foregrounds the joined window (amends #125)

**Bug.** Tapping an UNjoined `/list` row fired the JOIN but left the
operator in the previous window. #125 had deliberately made a
directory-driven join JOIN-only, no auto-open; #244 amends that **for the
user-initiated tap only**: you asked for the channel, you land in it
(irssi-like).

**Fix.** `DirectoryPane.onJoin`: after the awaited `postJoin` resolves,
`setSelectedChannel({networkSlug, channelName, kind: "channel"})` — the
SAME verb + shape `compose.ts` `/join` uses, at the same issuing boundary
(focus originates from the user's TAP, not from the join completing).
Placed after the await inside the `try`, so a failed join (e.g. `+i`)
surfaces its inline error and never foregrounds a phantom window.

**Why the #200/#125 automatic-rejoin-no-steal invariant stays intact (the
crux).** A completion-driven focus (setSelectedChannel in the WS
`joined`/`window_pending` arms) would ALSO fire on AUTOMATIC re-joins —
reconnect auto-rejoin, cross-device/server-originated join,
pending→joined — re-introducing the exact focus-steal #200 removed. The
WS window-state arms remain pure state mirrors that NEVER originate
selection; the tap is the ONLY new focus origin. Verified negatively
(unit + e2e): an out-of-band REST join does NOT move the selection.

The #125 test asserting no-open-on-tap was inverted
(never-assert-buggy-behavior) + a "does NOT foreground when postJoin
fails" case; `userTopic.test.ts` gained guards re-asserting that
`joined`/`window_pending` do not originate selection. Deploy: `--cic`
only, HOT.

---

## 2026-07-14 — #239 (P0): hidden control messages left the unread counter stuck

**The bug (regression from #222).** The #222 filter is render-only, but
the unread derivation (`selection.ts` `perChannelUnread`) counted every
STORED row past the cursor — a hidden control message inflated the events
badge, and because the row never renders, no settle event advances the
cursor over it: the badge stayed stuck > 0 with no way to clear it. The
pre-fix `rows()` comment even documented the divergence as intentional —
that rationale WAS the bug.

**The fix — reconcile to ONE shared predicate (one feature, one code
path), two facets:**

- **Facet A — count over VISIBLE rows.** `perChannelUnread` skips
  filter-hidden rows via the single shared
  `presenceFilter.presenceRowVisible(key, memberCount, kind)` — the SAME
  predicate `ScrollbackPane.rows()` now filters through. Badge and pane
  can no longer disagree; fixes the local badge immediately.
- **Facet B — advance the server-owned cursor over the trailing hidden
  run.** A debounced ScrollbackPane effect (channel hiding presence + tab
  visible) walks from the live cursor: `trailingHiddenAdvanceTarget`
  returns the tail id when the whole post-cursor tail is hidden, else the
  id just before the first VISIBLE unread (a real unread keeps its badge
  + divider). Forward-only via the existing `setCursorIfAdvances` path —
  closes the cross-device/reload gap (the server seed computes over
  stored ids and can't know the client-only filter; only advancing the
  cursor makes the server agree).

**Read-state-server-owned invariant intact:** cic does NOT compute or own
a count — it derives the badge as before; Facet B supplies the
read-position signal through the ONE existing server-owned cursor path.
No parallel client-side count state machine.

**Interactions respected.** #233 monotonic clamp: Facet B only advances —
compatible. Divider freeze: the divider reads the FROZEN `markerCursorId`,
never the live cursor, and Facet B stops before the first visible unread,
so a real unread's divider survives. The debounce coalesces netsplit
storms to one POST; the timer is cleared+reset BEFORE the early-return
guards so a stale schedule never fires against a switched-to window.
Mark-as-unread: no such feature exists — flagged in the Facet B comment,
NOT built.

No test encoded the old behavior (the existing selection test seeds a
small channel — stayed valid). `issue239-hidden-msg-unread.spec.ts`:
hidden join does not bump the badge, visible privmsg does, reading
clears. Deploy: `--cic`, HOT.

## 2026-07-14 — #230 REOPENED (P0, mobile): touch underfill → no load-older

**The bug (mobile half of #230).** The earlier fix rescued underfill only
for the desktop WHEEL; mobile is touch-driven, so on an underfilled pane
(`touch-action: none`, non-scrollable → no native scroll event) there was
still no path to older history on iPhone (vjt reopen).

**The fix — one decision seam, two input paths.** Pure exported
`shouldRescueUnderfillLoadOlder({scrollHeight, clientHeight, scrollTop,
revealOlderIntent, thresholdPx})`; wheel supplies `revealOlderIntent =
deltaY < 0`, touch supplies `dragDy > 0` — a finger drag DOWN the screen
(content scrolls up → older revealed) is the touch analogue of wheel-up.
Both funnel through the decision AND the ONE `maybeLoadOlder` closure —
no forked load-older, no second position-restore. The
`!nativelyScrollable` guard is LOAD-BEARING and mirrored for both: on
overflow, `onScroll` owns loadMore with correct post-scroll geometry;
wheel/touch fire one tick before and would restore to a stale anchor.

**Element-level `{passive:false}` listeners, not JSX `onTouch*`.** Solid
delegates touch to a passive document listener
(project_solid_touch_passive_delegation), and iOS PWA UIKit can still
claim a touch as a page-pan even under `touch-action: none` (see
`lib/overlayScrollLock` moduledoc — CSS-only proved insufficient). So
touchstart/move/end/cancel bind directly on `listRef` in onMount,
`touchmove` `{passive:false}`, `preventDefault` called ONLY when the
rescue fires (overflowing case → native pan-y proceeds). The
element-level `touchmove` also stamps `lastInputEventAtMs` (the
settle-gate job the removed JSX handler did).

**touch-action audit.** Base `.scrollback` is already `touch-action:
none` (UX-3 Z3 R4); `.scrollback-overflowing` flips to `pan-y`. `none` is
correct for underfill: it rejects the iOS chrome-drag AND still delivers
the touch events to JS (touch-action gates default browser behavior, not
event delivery). No CSS change; a `@webkit` e2e guards the contract.

**The webkit e2e cannot prove the iOS fix** — Playwright webkit doesn't
reproduce real iOS scroll physics
(feedback_playwright_webkit_not_ios_scroll). Core proof is the vitest
decision + wiring tests; e2e guards are synthetic-touch wiring on
chromium + the CSS contract on @webkit. **Deploy: `--cic` only, HOT — but
do NOT ship on automated gates alone; HALT for a real-iPhone dogfood
first** (webkit can't confirm the physics).

## 2026-07-14 — the `integration` suite was red because #233 hardened the cursor, not because of #222

**Wrong attribution disproved.** The chromium e2e workflow had been red
since ~#222 and shipped past ~6 times; a handoff blamed #222. A
30-second sanity check disproves it: the #222 filter only fires at ≥50
members and the seeded `#bofh` has ~3 — `presenceRowVisible` is a no-op
there. Directions over code.

**Real root cause: #233.** Every e2e cursor/divider/scroll spec PLANTS a
mid-page (backward) cursor via the production `POST /read-cursor`, which
became advance-only — a backward seed silently clamps to whatever tail a
prior spec left → no divider → deterministic red. #233 inverted two UNIT
tests but never touched the e2e seeding path; its CI was already
ignored-red, so the breakage rode in unnoticed. Four deterministic
failures: `cursor-forward-only:switch-away`, `issue168` ×2,
`unread-divider-beyond-window`.

**Resolution — restore the test capability WITHOUT weakening
production.** `ReadCursor.force_set/4` (insert-or-update, no clamp; still
validates `message_belongs?`) behind a TEST-ONLY
`POST .../read-cursor/force` (`GrappaWeb.TestReadCursorController`),
compile-gated to dev/test exactly like `TestResetSubjectController` —
absent from the prod release. `do_set/4` and `force_write/4` share one
`upsert_cursor/5` (the ONLY difference is the clamp guard). The force
controller broadcasts via `broadcast_set/5` because cic adopts a backward
move ONLY through its authoritative `read_cursor_set` WS echo. **Do NOT
relax `set/4` to `<`, and do NOT wire `force_set` into any production
controller** — mark-as-unread, when it ships, gets its own surface with a
real caller.

**Invariant clarification.** The read cursor is now "the newest row the
operator has read", advance-only server-side; backward e2e seeding is a
test-only force. Every spec that force-seeds mid-page MUST restore
`#bofh` to the tail in `afterAll`/`afterEach` (a forward move, production
endpoint) — `feedback_cascade_poisoner_pattern` bites harder now that the
seed actually LANDS (pre-#233 a dropped backward seed accidentally left
the tail; `scroll-on-window-switch` relied on that and needed a restore).

**Residual** — a pre-existing rotating 2-3 failures/run pool
(`b0-invite, marker-target-window, archive-desktop-only,
slash-commands-bundle, issue188-mentions`): never the same set twice, two
failing on untouched baseline = test-order pollution / environmental
flake (`feedback_recurring_e2e_not_flake`), not a deterministic
regression.

### 2026-07-15 — chronic e2e flake pool: root-caused + stabilised

Not one phenomenon — five distinct root causes, five real fixes, no
masking, no `test.skip`, no sleeps. Suite `0 failed` across three
consecutive full chromium runs.

**Method note — partial-grep pollution is a real trap.** Running a subset
via `--grep`/`--repeat-each` INTRODUCED failures that never occur in the
full suite (grouped specs mutate the shared `#bofh` cursor they don't
restore; stale uncleaned `#m188` rows let awaitWsReady false-pass).
Verify a flake fix against the FULL suite, not a hand-picked grep.

* **cp14-b2:** the helper's synthetic `el.scrollTop=0;
  dispatchEvent("scroll")` fires onScroll but never onWheel, so
  `lastInputEventAtMs` is never stamped and the #168
  `markerActivationPending` latch stays armed — tail snap on the prepend.
  Fixed with a REAL `page.mouse.wheel`. Test-only.
* **archive-desktop-only:** a one-shot `getComputedStyle` caught the
  button mid-swap (detached node → `""`). Fixed with `expect.poll`
  re-querying each tick. Test-only.
* **b0-invite:** identical to the green `p0e-invite-ack` sibling except a
  5s wait vs 10s; the full WS round-trip regularly exceeds 5s under load.
  Ceiling matched — a wait-for-condition, not a sleep.
* **issue188:** constant mention bodies + `#m188` outside `_vjtReset`'s
  truncation → stale prior-iteration rows false-passed the render-wait
  and the aggregation under-counted. Fixed with a per-invocation `runId`
  suffix so every wait gates on the message it asserts. Test-only.
* **marker-target:** a query window has NO self-JOIN scrollback line to
  await, so a `composeSend` before the async `phx.join` ack missed the
  own `/msg` echo. Fixed with a production-inert `__cic_queryWindowReady`
  seam in `subscribe.ts`'s query-window `onJoinOk` (mirroring
  `__cic_dmListenerReady`; corrects that seam's stale "overkill" note —
  query windows DO lack a pre-event DOM signal). The only cic-src change;
  the seam only stamps `window.*`, never read in production.
* **slash-commands /q:** a pollution victim (40/40 isolated, green in all
  full runs); the selection-steal trigger stayed unpinned. No code
  change; monitored — recurs → capture the full-suite artifact.

The #221 solanum-leaf topology was NOT the cause of any of these; the
#233 force-cursor fix + its four specs stayed green throughout.

---

## 2026-07-14 — #228 per-subject vhost (source-bind) selection

**What shipped.** A per-SUBJECT layer above the per-server source-bind: a
subject (user OR visitor, post-#211) can be admin-pinned to a fixed
outbound source address or self-select from an allowed set. The connect
path (`IRC.Client.source_bind/2` + the AAAA/ifaddr/force-`:inet` dance)
is **byte-for-byte unchanged**; only the value resolving into the plan
changed: `SessionPlan.base_plan/7` sets `source_address:
Vhosts.effective_source(subject, server.source_address)` — the one place
both resolvers flatten a credential.

**Resolution precedence (per connect):** pin > selection∩allowed (random
per connection, per spec) > `server.source_address` > nil → rotation pool
/ kernel default. Re-resolved on every `Session.Server.init/1`, so a live
vhost change takes effect on the next (re)connect — no auto-bounce (a
preference, not an operator disconnect). Selection is authz-clamped to
the allowed set at write AND re-clamped at read, so a revoked grant can't
leak a stale pick.

**Model (DB-driven, ZERO env var — vjt reshape 2026-07-14).** The spec's
first draft enumerated the out-of-pool slice via a NEW env var (which
would have forced COLD). vjt's better shape: the candidate universe is
the host's bound addresses (`Grappa.Net.HostAddresses` via
`:inet.getifaddrs/0`, loopback + link-local filtered — in the m42 jail,
exactly the jail's `/128`s); the DB curates everything. Two tables:
`vhosts` (address + `in_pool` + `generally_available`; `in_pool` REPLACES
the `GRAPPA_OUTBOUND_V6_POOL` env var — the rotation pool is now
DB-driven) and `vhost_grants` (subject-XOR FK, `pinned` flag; visitor
grants CASCADE on reap — no separate lifecycle). User selection persists
in `user_settings` (`vhost_selection` key). Shared `Grappa.Net.IpLiteral`
(strict literal + `:inet.ntoa/1` canonicalization) so `Vhost` and
`Server` validate through ONE helper.

**`OutboundV6Pool` is now a thin persistent_term cache.** `pick/0` stays
lock-free so `Grappa.IRC` deps only `OutboundV6Pool`, never `Vhosts` —
that would close the cycle `IRC → OutboundV6Pool → Vhosts → UserSettings
→ IRC`. The DB→persistent_term sync is pushed IN via `apply_pool/1` from
callers that already dep `Vhosts` (Bootstrap at boot, the admin
controller on inventory edits). Effective pool = `in_pool` vhosts MINUS
every per-server `--source` fixed address (spec §3 safety net: an
auto-allocated session can never pick a dedicated address;
canonical-string set-difference so `::9000` vs `0:0:..:9000` can't slip
past).

**Surfaces.** Admin `/admin/vhosts` (+ `/:id/grants`) behind
`:admin_authn`; user `/me/settings/vhost` (both subjects), multi-select
limited to the allowed set, a pin renders read-only; `forbidden_vhost` is
a distinct 403 tag. nginx: `vhosts` added to the shared admin alternation
snippet; `/me/settings/vhost` rides the `/me` allowlist.

**Deploy: HOT.** Removing the env var killed the only COLD trigger — no
new config key, no supervised child, no Session.Server state field. Two
migrations (create tables + seed the current env-var pool as `in_pool` so
prod behavior is byte-identical at deploy); a migration alone rides the
hot path.

**⚠️ Cross-layer drift flagged (NOT fixed — deliberate).** The FreeBSD
m42 jail runs a separate operator daemon,
`infra/freebsd/ndp_keepalive.pl`, that reads `GRAPPA_OUTBOUND_V6_POOL`
from `grappa.env` to keep the pool `/128`s' NDP neighbour-cache entries
warm (persistent `ping -6 -S <src>` per address). The bouncer no longer
reads that env var, but the daemon still does — the env var STAYS in
`infra/freebsd/grappa.env.example` + the rc.d daemon as the NDP-keepalive
source of truth. Follow-up (out of #228 scope): teach the daemon to read
the pool from the DB, or accept separate operator maintenance. Until then
the two lists can drift: adding an `in_pool` vhost via the panel requires
ALSO adding it to `grappa.env` for NDP keepalive. Documented so no one
"cleans up" the env var from the FreeBSD side and silently breaks NDP.

---

## 2026-07-14 — #223: auth-session housekeeping GC (Accounts.Reaper) — bound unbounded `sessions` growth

**The report.** One long-lived prod user had 39 `sessions` rows with
`revoked_at IS NULL`, oldest ~2 months — every login / WS reconnect
INSERTs a row; nothing ever pruned them.

**Spec challenge FIRST.** The issue claimed "a two-month-old session can
still authenticate a WebSocket" — **verified FALSE in code @ d2fcaed1**:
`Accounts.authenticate/1` → `check_idle/1` already rejects rows idle past
`@idle_timeout_seconds` (7d), and EVERY auth path routes through it (REST
`Plugs.Authn`, WS `UserSocket`, `Visitors.Login`); no
`Repo.get(Session, …)` bypasses the gate. So #223 is NOT a security
bypass — it is the missing housekeeping cron the code already foresaw
(the `create_sessions` migration's `last_seen_at` index comment names
exactly this cron). Collapses to a growth/hygiene fix.

**Table is `sessions`, not `accounts_sessions`** — the `Visitors.Reaper`
moduledoc's prose name is WRONG (cosmetic, left untouched). No new
migration: the `sessions(last_seen_at)` index pre-exists and the sweep
predicate is covered.

**Design — reuse the VERB, not the NOUN (rule 6).** New sibling
`Grappa.Accounts.Reaper` mirroring the `Uploads.Reaper`/`Visitors.Reaper`
shape (`:permanent` GenServer, `sweep/0`, `:interval_ms` default 60s,
tick-schedules-BEFORE-sweep); delegates to
`Accounts.delete_expired_sessions/0` ({:ok, count}, one set-based
`Repo.delete_all`). Folding the sweep into `Visitors.Reaper` (the literal
suggestion) **rejected as a boundary violation** — a visitor-domain
process depending on `Grappa.Accounts`, reaping two unrelated domains
through one tick. Boundary `deps: [Grappa.Accounts]`, `top_level?: true`.

**TTL = the EXISTING `@idle_timeout_seconds` (7d), single source.** The
GC threshold IS the auth idle gate — the reaper materializes exactly the
policy `authenticate/1` enforces, so the two can never drift. vjt chose
7d over a 30d margin: a row is deleted the moment it becomes
un-authenticatable. Sliding-vs-absolute was already answered by the
model: `last_seen_at` is a sliding timer bumped on every use, so a stale
timestamp is proof-of-non-use.

**DELETE, not soft-revoke — and `revoked_at` is NOT in the predicate.**
Soft-revoke alone doesn't bound growth. `last_seen_at` is the sole
liveness signal: a revoked row is dead regardless, so an
already-soft-revoked stale row is GC'd too. No audit-trail arm — expired
bearer tokens, nothing operator-actionable.

**Visitor sessions OUT of scope — `user_id IS NOT NULL` guard.** A
visitor's rows are removed by `Visitors.Reaper` via
`sessions.visitor_id ON DELETE CASCADE`; the Accounts sweep must NOT
double-own that lifecycle. Reaping a stale row can never hit a reusable
one — any use refreshes the timestamp out of the window first.

**Supersede-on-reconnect: NOT built** (a separate additive mechanism; the
reaper alone bounds growth — "add X means add X"). **No AdminEvent
(deliberate divergence from the siblings):**
`AdminEvents.Wire.event_kind` is a CLOSED, cic-mirrored wire contract —
adding `sessions_reaped` would force a cic wire change for a server-only
ticket, and session GC has nothing operator-actionable. Instead one
`:info` log per productive sweep, suppressed on count=0 (avoids 1440 idle
lines/day at the 60s cadence).

**Hot vs COLD → COLD** — driven purely by the new supervised child
(hot-reload does not add supervised children safely; no migration).
Placed after Endpoint alongside the other reapers. Tests cover the
strict-`<` boundary, the visitor-domain guard, revoked-stale still
deleted, idempotence, and the scheduled-tick path.

---

## 2026-07-14 — #196 REOPEN: image-preview overlay loses scrollTop when a message arrives mid-overlay (desktop)

**Symptom.** Scroll up, open an inline image's preview, close → the list
jumps ("re-reading old messages as if new"). #196's fix (14daadce) +
#219-general's `overlayCount()` freeze held only the QUIET-channel case
(the shipped preserve e2e opens/closes on a fully-read #bofh and passes).

**The hole.** #196's restore is an ABSOLUTE-pixel snapshot asserted only
on the CLOSE edge (the original commit admitted the desktop perturbation
"could not be pinned by static reading"). The unpinned perturbation: a
message arriving while the overlay is open mutates rows(), making the
ref-keyed `<For>` recreate the list DOM and reset `scrollTop` to 0; the
length-effect that would re-establish position BAILED on
`isOverlayFrozen()`, so the covered pane sat at 0 for the overlay's whole
lifetime. When the scrollTop=0 artifact spuriously fired `maybeLoadOlder`
(prepend), the absolute snapshot went stale and the close-edge restore
landed on the wrong content — the observed jump (confirmed instrumented:
3694 → 0 on peer message, recovered ~2 frames after close).

**Root-cause fix — reuse the existing freeze discipline, no parallel
path** (`ScrollbackPane.tsx`):
1. **Length-effect RE-ASSERTS instead of bailing while frozen.** On a
   rows() change under a covering overlay, re-assert
   `overlayScrollSnapshot` — synchronously (the effect runs after `<For>`
   reconciliation; a snapshot is an absolute offset, no post-layout read
   → no transient-0 frame), then again across rAF×2. Position survives
   EVERY rows recreation, not just the close edge. (Bailing outright was
   the bug; tail-follow while frozen stays — correctly — forbidden per
   #219.)
2. **onScroll skips ALL side-effects while frozen** — every scroll event
   under a covering overlay is an artifact of the `<For>` recreation, not
   operator intent. Blocks the spurious `atBottom` flip, the
   loadMore/loadNewer whose prepend would stale the snapshot, the bogus
   visible-tail capture, and the cursor advance.

Both reuse `isOverlayFrozen()` + `overlayScrollSnapshot` + the refcount —
no forked scroll-preserve path
(feedback_new_covering_modal_must_push_overlay_refcount).

**Why the existing e2e didn't catch it:** it never mutates rows() while
the overlay is open — a hollow-green for the live case. New sibling
`issue196-preview-scroll-live-arrival.spec.ts` has a peer line arrive
WHILE the overlay is open (RED pre-fix, delta 3694). It scrolls up
(advancing the shared #bofh cursor mid-page), so it restores the cursor
to the tail in `afterEach` — NOT afterAll: under `--repeat-each` the
sibling spec interleaves between repeats and would inherit an unread
marker (feedback_cascade_poisoner_pattern). Non-overlay scroll/cursor
specs are inert to the change (gated entirely on `isOverlayFrozen()`).
Deploy: `--cic` only, HOT.

---
## 2026-07-15 — #246 (P0): outbound split budget must reserve the worst-case RELAYED source prefix

**The silent data-loss bug.** `Grappa.IRC.LineSplit.split_privmsg_body/3`
budgeted long-body splits against only the CLIENT-side framing
(`"PRIVMSG <target> :" + CRLF`). But the server relays each line to the
other members as `:nick!user@host PRIVMSG <target> :<body>\r\n` and holds
THAT frame against `LINELEN` — a fragment ≤ 512 on grappa's wire overran
512 once relayed, the server truncated the tail, and grappa's next
fragment resumed past the pre-truncation offset: a **silent hole of
~(source-prefix length) bytes at every split boundary**. Invisible on
grappa's own echo (no prefix there); only recipients saw it. Repro: a
600-byte body lost 26 bytes (part 2 resumed at 493 instead of
468 = 512 − 44 relayed overhead).

**Fix — reserve the WORST-CASE relayed framing, not the live prefix.**
`host`/cloak length can grow between messages (rebind, oper cloak, IPv6
vs rDNS), so budgeting against the current `state.nick`/userhost
under-reserves the instant it grows. New pure
`LineSplit.relay_frame_overhead/1` reserves fixed, documented maxima:
**nick ≤ 30** (`Identifier` `@nick_regex`, Azzurra `NICKLEN=30`);
**ident ≤ 10** (`@ident_regex`, common `USERLEN` — assumes the server
counts its `~` no-identd prefix WITHIN `USERLEN`, true on
bahamut/solanum); **host ≤ 63** — the `HOSTLEN` of the DEPLOYED ircds
(bahamut, solanum), covering cloaks + bracketed IPv6. NOT universal: an
ircd with `HOSTLEN` > 63 (e.g. InspIRCd default `maxhost=64`)
under-reserves and RE-OPENS this exact silent data loss —
`@max_host_bytes` MUST be raised before targeting such an ircd.
Over-reserve is safe; under-reserve is the bug. The RFC/DNS ceiling of
253 was declined only to avoid tripling fragmentation. Sigils + space =
4 bytes → `@source_prefix_reserve = 107`. Feeding `NICKLEN`/`HOSTLEN`
from 005 ISUPPORT was considered and NOT added — the fixed worst case is
always safe and avoids threading identity state into a pure splitter.

**UTF-8.** Codepoint bisection was already impossible (splits on
`String.graphemes/1`; an oversize grapheme is emitted intact); a new
StreamData property (`String.valid?/1` per fragment) locks it in. CTCP
`\x01ACTION\x01` keeps the envelope per fragment.

**Tests.** RED-first headline repro builds the concrete worst-case
relayed frame from the documented ceilings — independent of the
production formula, so it catches an off-by-one (failed pre-fix at
619 > 512); property: byte-identical reconstruction + relay-safe
fragments. **Invariant for future outbound framing: reserve the
worst-case RELAYED frame (server-prepended source prefix included),
never just the client-side line.**

_Deploy: COLD — `lib/` framing-math change, not hot-reload-safe.
Server-only._

### Drive-by: a pre-existing mentions property flake (unrelated to #246)

`Grappa.MentionsTest`'s `aggregate_mentions/6` property generator
(`string(:printable, min_length: 1)`) occasionally emits `" "`, which
`Scrollback.Message`'s `validate_required(:body)` rejects (blank after
trim) → helper MatchError. Fixed at the root in its own commit: the
generator filters blank-after-trim bodies (can't exist in production).
Independent of the #246 diff.

## 2026-07-15 — #243 (P1, cic): re-tapping the active channel jumps scrollback to bottom

irssi-parity "jump to latest": tapping the ALREADY-active channel
(desktop sidebar row + mobile bottom-bar entry) scrolls it to the newest
message; a window-switching tap is unchanged.

**Seam — no second scroll authority.** Tap handlers fire
`requestScrollToBottom()` when `isActiveSelection(target)`; the re-tap
predicate and the idempotent setter's short-circuit both route through
ONE `sameSelection/2` (exact tuple equality; null↔non-null is a
transition) so "is re-tap" can never drift from "is no-op set".
`lib/scrollToBottomCommand.ts` (new): a monotonic module-singleton nonce
— a counter, NOT a boolean, so back-to-back re-taps each register a
transition Solid's `===` would swallow; not identity-scoped (a stale
value after rotation just means "no new request"). Sole subscriber
`ScrollbackPane` (`createEffect(on(…, { defer: true }))`) reuses the
EXISTING `scrollToBottom()` the floating button uses; `defer: true`
means a channel switch or stale nonce never fires a spurious jump. Only
one ScrollbackPane is mounted, so the command lands on the active
scrollback; a re-tap on a non-scrollback window bumps the nonce
harmlessly (no subscriber mounted).

**Invariants respected.** #196 overlay hold + #230 underfill anchors
untouched; the scroll fires from the TAP handler, never a WS event
(#200/#125 no-steal); pure client-side, no window STATE originated.

**Testing.** vitest pins the seam up to the nonce; jsdom is blind to
scroll geometry, so `issue243-tap-active-scroll-bottom.spec.ts` (desktop
+ `@webkit` mobile) proves nonce → actual scroll.

_Deploy: **--cic HOT** — client-only; no BEAM restart, no migration._

## 2026-07-15 — #248 (P0, cic): connect-welcome LUSERS no longer auto-surfaces the card over the message view

**Bug.** On connect cic auto-opened the LUSERS card in the top-pinned
overlay (#133), covering the message view — onboarding users read it as
"my sent messages aren't showing up".

**Root cause — client-only.** Bahamut auto-emits LUSERS at registration.
grappa NEVER self-issues LUSERS (`Client.send_lusers` reachable only via
the operator `/lusers` path) and broadcasts the same
`{:lusers_bundle, accum}` either way — the server makes NO surface
decision. The auto-surface was purely client-side: `userTopic.ts` stored
every bundle and `LusersCard` renders whenever a snapshot exists.

**Fix — per-network solicited-request gate in `lusersBundle.ts`.** Every
solicited bundle is preceded by a client `/lusers`; the welcome burst
never is — that difference is the whole signal. `markLusersRequested`
set on `/lusers` in compose; `applyLusersBundle` surfaces only when a
request is pending (consume-once `Set.delete`), else drops silently. The
raw `setLusersBundle` export is removed so the gate can't be bypassed;
flags are non-reactive control state cleared on identity rotation.
Manual `/lusers` unchanged — still surfaces the card in the current
window (#231). **Why a client flag, not a server `solicited:` field:**
the client is the sole originator of solicited `/lusers`, so it already
holds the distinction with zero new server state or wire change — and
keeps the deploy `--cic` HOT.

**Testing.** `lusersBundle.test.ts` pins the gate;
`issue248-lusers-no-auto-surface.spec.ts` reproduces via park→Reconnect
(re-sends the welcome LUSERS): no auto-surface; operator `/lusers` still
surfaces (positive control).

_Deploy: **--cic HOT** — client-only; no BEAM restart, no migration._

## 2026-07-15 — #251 vhost self-service V1 (server + coupled cic)

**The principle (vjt).** *Admin decides AVAILABILITY; the user decides
SELECTION.* No admin hard-pin, no admin default. V2 (the cic sub-page
consuming the new `granted` marker) is a separate follow-up.

**Change 1 — `in_pool` is now self-selectable (the P2 root cause).**
`Vhosts.allowed_vhosts/1` was `generally_available OR granted`; the pool
is seeded `in_pool=1, generally_available=0`, so a no-grant user had an
EMPTY allow-set ("can't set my vhost"). Now `generally_available OR
in_pool OR granted`; `PUT /me/settings/vhost` accepts a pool address
(was 403).

**Change 2 — the admin hard-pin is dropped entirely.** #228's `pinned`
grant (admin-forced, top of `effective_source/2` precedence) removed
end-to-end (fns, grant option, params, both wire shapes). A grant now
means ONLY "available to this subject"; existing `pinned=true` rows
become ordinary availability grants (intended).

**Change 3 — a per-option `granted` marker.** Options become
`{address, in_pool, granted}`; `granted` = an explicit grant row exists,
NOT allow-set membership (they differ after change 1). V2 buckets:
exclusive (`granted`) / in-pool (`in_pool && !granted`) / out-of-pool
(`!in_pool && !granted`, necessarily generally-available — so
`generally_available` is NOT on the wire; V2 derives it).

**Change 4 — coupled cic.** Removing `pinned` touched `AdminVhostsTab`,
`SettingsDrawer` ("Pinned by admin" branch gone), `userSettings.ts`,
`api.ts`, the e2e — a REMOVAL forced by change 2, not V2 work.

**The `server.source_address` decision — opt1 (keep), NOT abolish.**
vjt's directive PREFERRED abolishing per-network
`network_servers.source_address`, with the criterion: *clean removal →
abolish; touches non-vhost paths → opt1.* Evidence (main @ 74355599):
`source_address` is the per-network operator "force egress from X"
mechanism, flowing `session_plan.ex` → `effective_source/2` →
`Client.source_bind/2` verbatim; only `nil` reaches
`OutboundV6Pool.pick/0`. **Decisive:**
`seed_vhost_pool_from_env.exs:13-16` documents a live prod account
egressing from a dedicated /128 via `source_address` — abolishing the
fallback would make it pool-pick a RANDOM address (its /128 already
pool-subtracted → unused), breaking operator force-egress, which the
issue says stays unchanged and which is NOT vestigial (per-network force
vs per-subject grant+selection are different granularities the grant
model cannot express). By vjt's own criterion → **opt1**: drop only the
pin branch. New precedence: selection (∩ allowed, random per connect) →
`server_source` → `nil` (pool-pick); `source_bind/2` unchanged. This
follows the issue's INTENT over its literally-written order (selection →
pool → source_address), which would itself break force-egress — the spec
inherited that inconsistency.

**Caveat — force-egress is the no-selection DEFAULT, not a hard
guarantee.** Changes 1+2 together mean a force-egress account's subject
CAN now self-select a pool/granted address, overriding the mandate (the
mandated /128 itself stays unselectable — pool-subtracted + not
granted); under #228 that subject had an empty allow-set or an admin
pin, and #251 removes both levers. Direct, intended consequence of the
principle + vjt's explicit "drop the pin ENTIRELY" — the operator no
longer has a per-subject hard-force. A future hard per-account egress
need requires a NEW mechanism (e.g. a per-network "exclude subjects
from self-selection" flag) — out of V1 scope, recorded so the gap is a
deliberate decision, not a silent regression.

**Dead columns.** V1 stays HOT: no migration. `vhost_grants.pinned` is
left a dead no-op column (schema no longer declares it; SQLite applies
the default) — a trailing COLD cleanup migration drops it later.
`network_servers.source_address` is UNTOUCHED (live feature).

_Deploy: **HOT — server logic + `--cic`.** No migration in V1; the dead
`grant.pinned` column drop is deferred to a trailing COLD migration._

## 2026-07-15 — #235 jump-to-next-active (Alt+A)

irssi's `Alt+A` in cic: button + keybinding jumping to the NEXT window
with unread activity, cycling, mention/highlight channels AND query (DM)
windows first, then ordinary traffic. Client-only.

**Reuse-vs-rebuild.** The prior Ctrl+N/P walked sidebar order, excluded
DMs, had no tiers. Rather than a parallel verb, the ordering was
extracted into ONE pure fn `orderUnreadWindows` (`lib/activeWindows.ts`)
— Ctrl+N/P, Alt+A, and the button are the SAME verb ("reuse the verbs,
not the nouns"); Ctrl+N/P strictly upgraded. NOTHING new is stored:
unread from `selection.unreadCounts`, mention tier from
`mentions.mentionCounts`, query tier from `queryWindowsByNetwork`,
activity time from the newest local scrollback row `id` (monotonic
sqlite PK, globally ordered; a seed-only window sorts as `0` = oldest,
correct for pre-session backlog). No parallel activity store.

**Ordering.** Filter `unreadCounts > 0`; sort by (1) tier — mention OR
query first; (2) activity ascending (clear backlog in arrival order);
(3) flat sidebar index tie-break. Tier trumps time. Focusing zeroes
unread so repeated taps drain to empty. **Scope:** channel + query only;
`$server` excluded (not an "activity window" in the irssi sense).

**Placement (vjt: no strong opinion).** Desktop = sidebar bottom-left;
mobile = floating overlay at the bottom bar's right edge; ONE
`NextActiveButton`. Auto-hides via `<Show when={hasActiveWindows()}>` —
badge count and hide condition derive from the same list, so they can
never disagree. Alt+A matches `e.code === "KeyA"` (NOT `e.key`): macOS
Option+A composes "å".

**Known tradeoff — Alt+A swallows macOS Option+A ("å").** No
`isTypingTarget` guard, unconditional `preventDefault` (same as
`Alt+1..9`) — typing "å" in compose window-jumps instead. Accepted
deliberately for irssi parity: you're often typing when you want to
jump, gating would defeat it, and special-casing Alt+A would diverge
from every other chord + couple the pure keybindings layer to app state.
Press-and-hold-A still gives the accent popup.

_Deploy: **HOT — `--cic` only, client-only.**_

## 2026-07-15 — #237 topic inline on join + change (cic, client-only)

vjt ruling: **OPT1, app-wide** — print the FULL topic INLINE in
scrollback, irssi-style, on JOIN (when a topic exists) AND on every
change, every viewport. Complaint (P0): the mobile TopicBar truncates,
so post-JOIN the topic is unreadable.

**Dependency check (decides deploy class).** On TOPIC change, the
`EventRouter` `:topic` arm ALREADY persists a real `:topic` scrollback
row + emits `:topic_changed`; cic already renders it inline — the
on-change leg needed ZERO new code (the e2e asserts it as a regression
guard). On JOIN, the backfill numerics `332`/`333`/`331` emit only
`{:topic_changed, …}` with NO persist (documented there: 332 rows would
spam scrollback on every reconnect/rejoin; also in NumericRouter's
`@delegated_numerics` so the catch-all doesn't double-persist); the
event lands in `topicByChannel` (`channelTopic.ts`) with full text +
`set_by`/`set_at`, and only the TopicBar consumed it → the gap. So:
`--cic` HOT, client-only.

**Rendering: presentational row (option a), NOT a persisted kind.** A
`TopicRow` in `ScrollbackPane`'s `rows()` memo — the same mechanism as
day separators / unread marker / invite-acks (string `id`, NOT a
`ScrollbackMessage`). Option b (persist a join-time `:topic` row
server-side) rejected: a server change AND exactly the reconnect-spam
the server avoids. Read-state safety: not a `"message"` row → never
enters the `unreadCount` filter nor the `data-msg-id` cursor walk /
ring-cap — no faked scrollback id, no unread/divider corruption; own
testid (`topic-join-line`, NOT `scrollback-line`) keeps it out of line
counts.

**Placement + derivation.** Derived pure (`channelTopic.topicJoinLine/2`
+ `topicJoinMeta/1`) from `topicByChannel()[key]`, anchored after the
operator's LAST own-JOIN row (channel windows only) — exactly one line,
re-printed on part/rejoin; reactive (seeds on the 332, updates on
change). Rendered via the shared `MircBody` + muted `— set by … at …`
when 333 supplied it; wraps, so readable on narrow viewports.

**Deliberate boundaries (documented, not bugs).** Shows the CURRENT
cached topic, not a frozen at-join snapshot (no per-join topic history);
on RELOAD the line reprints only if the own-JOIN row is in the loaded
window (a reload is a re-subscribe, not a new JOIN); on a
presence-suppressed channel the own-JOIN row (and thus the line) is
hidden by the presence filter — the TopicBar still surfaces the topic.

_Deploy: **HOT — `--cic` only, client-only.** The on-change inline row
is pre-existing server behavior._

## 2026-07-15 — #254 own-echo live render (query + channel-iOS)

**Symptom (real iOS dogfooding).** The operator's OWN outbound message
doesn't appear in their own live view — delivered and persisted; only
the sender's LIVE render lost. Surfaces: (QUERY) first `/msg` to a
freshly-opened query window after (re)opening the app; (CHANNEL) typing
after the iOS PWA was backgrounded/re-foregrounded. P1, no data loss.

**Confirmed root cause (server-side adversarially ruled out).** cic
renders an own outbound line ONLY on the server's WS echo (no optimistic
render — by design). If the topic's subscription isn't LIVE at broadcast
time, the echo fastlanes to zero subscribers and is gone. Two necessary
conditions: **(A) echo dropped** — QUERY: the `(slug,target)` topic is
joined LAZILY by a reactive effect gated on the `open_query_window`
round-trip, while `/msg` POSTs immediately; the echo (persist →
broadcast, synchronous + ordered in `Session.Server`) fires strictly
before the topic is joined. CHANNEL/iOS: an iOS background/foreground
can silently tear the WS with NO `online` event, and `kickReconnect` was
wired ONLY to `window "online"`. **(B) refresh recovery can't save it**
— the #159 refresh-on-activation works for INBOUND rows but not an
own-send: the send advances the read cursor to the own row's id, and
with no prior live arrival `getResumeCursor` = own id →
`?after=<own-id>` skips the very row. (The #50/m6 gate protects an empty
fresh query — which is why the bug bites windows WITH history.)
Rule-out: a zero-subscriber broadcast returns `:ok` and the POST still
201s — no server race; purely client-side subscription readiness.

**Design constraint (vjt direct order) — NO optimistic render, NO 2nd
source of truth.** "Optimistic append of the POST row" REJECTED: a
second source of truth to reconcile — the same reason
`server.source_address`'s fallback was abolished in #251, and per "cic
NEVER originates state". The fix makes the SUBSCRIPTION ready; the
echo-driven path stays the sole writer; the #50/m6 anti-poison gate is
untouched.

**Fix (per surface).** QUERY — **subscribe-before-send**: `/msg` awaits
`ensureQueryTopicJoined(slug, target)` (join ACK) BEFORE the first POST.
Reuses the same join path as the reactive query-windows loop (refactored
to call the SAME verb — no double-join, no parallel path); own-nick
skipped (the DM-listener loop owns that topic); bounded 4s so a wedged
WS (#193) can't hang the send — past the cap the send proceeds and
reconnect self-heal recovers. Decoupled via a leaf `queryTopicJoin.ts`
(importing subscribe.ts into compose booted the whole WS `createRoot` in
jsdom); subscribe.ts registers the impl at boot, the default no-op is
correct pre-boot + in unit tests. CHANNEL/iOS —
**visibility-driven reconnect**: socket.ts adds a
`visibilitychange`→visible `kickReconnect`, twin of the `online` handler
(no-op on a healthy socket) → phoenix rejoins → the socket-open
self-heal fires `refreshScrollback`.

**Scope.** Targets the reported `/msg` (open+send in one). `/query` then
plain-type is lower-risk (typing latency covers the join) and NOT
covered — flagged for the device-verify batch.

**Verification HOLD.** Playwright can't reproduce the real iOS timing;
both e2e RED→GREEN are seam-forced deterministic (query: a synchronous
fetch wrapper snapshots `__cic_queryWindowReady` at the POST call frame
— a Node-side `page.route` snapshot yields the event loop and masks the
race; channel: `__cic_dropSocketForTests` holds the socket down until
the visibility kick reconnects). CI green NECESSARY BUT NOT SUFFICIENT —
HOLDS for the real-iOS device batch (#245/#250/#253/#254/#255).

_Deploy: **HOT — `--cic` only, client-only.** Server broadcast/persist
confirmed correct as-is._

## 2026-07-15 — #255 (P2, cic): close-× orphaned `touch-action: none` blocked bottom-bar swipe

**Symptom.** On iOS the bottom bar couldn't be swipe-scrolled if the
swipe STARTED on a tab's × close button.

**Root cause — orphaned CSS.** `.bottom-bar-close`/`.sidebar-close`
still carried `touch-action: none`, added by #172 (`d3e8446`) for the
hold-to-confirm long-press; #195 (`4ab4ef0`) removed that gesture (× is
a plain `onClick` button) but LEFT the CSS. `touch-action` does NOT
inherit and a child value OVERRIDES the ancestor's, so a touch on the ×
disabled panning BEFORE any JS ran — the parent's `pan-x` never
scrolled. The comments still referenced the removed gesture.

**Fix — align each × to its PARENT's scroll axis** (more explicit than
`auto`, and lets the e2e assert a precise value): `.bottom-bar-close →
pan-x`, `.sidebar-close → pan-y`; comments rewritten. Tap/close
unchanged — `touch-action` governs pan/zoom, not taps.

**Verification.** Playwright/WebKit can't reproduce real iOS touch-pan
physics, so the CI contract is the computed value consulted before JS:
`issue255-close-x-touch-action.spec.ts` asserts `pan-x`/`pan-y` (pre-fix
both `"none"`, RED→GREEN). CI green NOT SUFFICIENT — real-iOS pan verify
rides the device batch.

_Deploy: **`--cic` HOT (client-only)** — CSS + e2e only._

## 2026-07-15 — #245 (P1, cic): iOS PWA scroll jams in ALL tabs after a bundle refresh until each tab is reopened

**The bug.** On an installed iOS PWA, after every client bundle refresh
scroll was JAMMED in every channel tab until each was opened a SECOND
time. Verified on device; not reproducible on desktop Chrome →
WebKit/iOS-specific. Distinct from #230/#196/#46.

**Confirmed mechanism.** `.scrollback` is `touch-action: none` in its
base rule ("default-deny pan"); only `.scrollback-overflowing` flips to
`pan-y`, and ScrollbackPane JS-measures it (`measureOverflow()`:
`scrollHeight > clientHeight`). The defect: `isOverflowing` depends on
`clientHeight` (viewport-derived via `--vh`/`visualViewport.height`),
yet `measureOverflow` ran ONLY on mount + message-length change — NEVER
on a viewport resize (the resize listener re-ran `scrollToActivation`
but not the measure). The refresh is a FULL page reload; on an installed
iOS PWA `visualViewport.height` is transiently wrong at boot and settles
a few hundred ms later. The cold mount measured against the transient
(too-large) height and latched `isOverflowing=false` → `touch-action:
none` → jammed; opening the tab again REMOUNTS the pane, re-measuring
after settle — the workaround.

**Fix — reuse the existing resize seam, no new machinery.** onMount
`onResize` now calls `measureOverflow()` alongside the existing
`scrollToActivation("tail-only", true)`. The general fix, not just the
incident: `isOverflowing` SHOULD track the viewport (orientation,
split-view, keyboard). Safe: it only toggles the class — never touches
`scrollTop`/`position:fixed`/keyboard, so it cannot regress the
#66/#219/#230/#243 machinery.

**Testing — WIRING-ONLY, honestly labelled.** Playwright webkit cannot
reproduce iOS post-reload reflow/touch physics; jsdom is blind to
geometry. `issue245-scroll-remeasure-on-resize.spec.ts` (`@webkit`)
stubs `visualViewport.height` smaller + dispatches `resize`, asserts the
class/`pan-y` flip (RED pre-fix) + a grow-back assertion. GREEN does NOT
close #245 — device-proof is vjt on a real iOS PWA.

_Deploy: **--cic HOT** — client-only; no BEAM restart, no migration._

---

## 2026-07-15 — #250 (P0, cic): nick selectable under Android touch drag-selection

Follow-up to #179 (closed in error). On **real Android (Chrome)**,
drag-selecting a message from the timestamp EXCLUDES the author nick;
iOS + desktop include it. The platform split IS the whole story.

**Root cause.** The nick is a `<button class="scrollback-sender
nick-clickable">` — an interactive element Android's native
touch-selection engine skips. Desktop uses mouse-selection (no
touch-selection engine); iOS forces the row selectable via
`html.is-ios .scrollback { user-select: text }` (Dispatch-1,
2026-06-11), scoped to `is-ios` ONLY — there is no `is-android` class —
so on Android `.nick-clickable` computes `user-select: auto` and the
button is skipped.

**Fix.** `user-select: text` (+ `-webkit-`) UNCONDITIONALLY on
`.nick-clickable`. Minimal lever: tap-to-query intact, iOS
`position: fixed` machinery untouched. Rejected the broader alternative
(add `html.is-android` + extend the `.scrollback` re-enable): desktop
proves the container computes `auto` and still selects fine — only the
interactive `<button>`'s own `user-select` is implicated, not a
platform-scoped container policy.

**keepKeyboard sync.** The Dispatch-1 policy pairs the CSS re-enable
with `keepKeyboard.ts`'s `SELECTABLE_TEXT_SURFACES` allowlist (a new
selectable surface on iOS must land in BOTH or the gate drifts). No
change needed: `.nick-clickable` is inside `.scrollback` (already
allowlisted) and not in `SELECTABLE_TEXT_EXCLUDE` — iOS unchanged.

**Why #179 was closed in error.** It closed on a `Range`-based
Playwright assertion; a DOM `Range` serializes the whole subtree on
EVERY engine, so it passes without exercising Android's native
touch-selection handles — a green `Range`/mouse-drag e2e is a FALSE
NEGATIVE for this bug. The new spec
(`issue250-android-nick-select.spec.ts`) asserts only the computed-style
WIRING (chromium `user-select: text`, RED as inherited `auto` pre-fix;
`@webkit` twin reads `webkitUserSelect`) and states plainly it does NOT
prove the real Android fix — that needs a physical device
(device-verified post-ship).

_Deploy: **--cic HOT** — client-only; no BEAM restart, no migration._

## 2026-07-15 — #253 keyboard/viewport resize no longer yanks a scrolled-up reader to the tail

**Symptom (device-reported, iOS PWA).** Focusing compose opens the soft
keyboard → shrinks `visualViewport.height` → fires `resize` → snapped
the list to the BOTTOM, losing a scrolled-up reader's position and the
unread marker they were parked on.

**Confirmed root cause** (`ScrollbackPane.tsx` onMount): the resize
handler was an unconditional `scrollToActivation("tail-only", true)` on
both `window.resize` and `visualViewport.resize` — it never consults
`atBottom()`. This was the accepted UX-6 **D9** starting tradeoff (vjt:
"start with symmetry, reset scroll marker later"); #253 IS that deferred
work.

**The minimal lever — reuse the length-effect follow rule.** Gate:
`if (atBottom()) scrollToActivation("tail-only", true)`. At bottom →
following live → re-pin (unchanged). Not at bottom → PRESERVE: do
nothing — a viewport SHRINK never clamps scrollTop (max scrollTop only
grows), so the browser holds the position; no snapshot/rAF machinery.
The exact follow rule the length-effect uses for live arrival.
`atBottom()` flips false ONLY on a real operator scroll-up, so it's an
honest signal at the resize site — unlike the `~:1593` leave-arm caveat
(a key-change batch racing `setAtBottom(true)`); a resize is not a key
change. `window.resize` (desktop resize/zoom) rides the same gate.
General across keyboard open AND close, orientation, zoom.

**#245 onResize overlap (batched into ONE --cic bundle).** #245 (held)
also edits this handler (unconditional `measureOverflow()`). Reconcile
at batch-merge to: `const onResize = () => { measureOverflow(); if
(atBottom()) scrollToActivation("tail-only", true); };` —
`measureOverflow` unconditional, only the scroll gated. Semantically
non-conflicting.

**e2e is seam-only, NOT device-proof.** Playwright webkit has no OS
keyboard (`feedback_playwright_webkit_not_ios_scroll`).
`issue253-kbd-resize-scroll-preserve.spec.ts` stubs `vv.height` +
dispatches `resize`, asserts scrollTop held (RED pre-fix: yanked
~3000px) + an at-bottom positive control; two webkit quirks compensated
in-file (no `scroll` event for programmatic scrollTop writes; `atBottom`
flips only on a real upward move). GREEN proves the WIRING; closing #253
needs real-iOS dogfood.

_Deploy: **--cic HOT** — client-only; no BEAM restart, no migration._

## 2026-07-16 — #259 install-hint: iOS ⋯ misdirection → per-platform hybrid

**The bug (P0, vjt screenshot IMG_9559).** The "Install Cicchetto"
splash misdirected iOS users: the step text said "tap ⎙ Share, then Add
to Home Screen" — skipping that on iOS Safari the entry point is the
**⋯ (More) menu** in the bottom-right chrome. Worse, the #204 hint arrow
was an in-card centered `↓` directly above the "Continue from browser"
button — pointing at the wrong thing.

**Fix — HYBRID per platform (three mutually-exclusive branches in
`InstallSplash.tsx`, capability-detection order).**
(1) `beforeinstallprompt` fired → native Install button (Chromium
family; captured at boot, `.prompt()`) — no arrow, no manual steps.
(2) else iOS Safari + NOT standalone → corrected manual path: "tap ⋯
More, then Share, then Add to Home Screen" (⋯ emphasized), arrow
re-anchored to the viewport bottom-right pointing `↘` at Safari's ⋯
chrome — the real target; gated on `!isStandalonePwa()` (an installed
PWA has no chrome to point at). (3) else → graceful hide (Firefox
Mobile, Samsung Internet, desktop Firefox/Safari): a manual-menu HINT
replaces the pre-#259 permanently-disabled dead "Install app" button.

**Supersedes #204's "quiet nudge."** #204 deliberately muted the arrow
(opacity 0.7); #259's premise is that the subtle hint FAILED, so target
+ arrow are now emphasized. Deliberate reversal, recorded here.

**Testing.** vitest asserts logic/text/branch;
`issue259-install-hint.spec.ts` asserts the per-platform BRANCH
(`beforeinstallprompt` supplied/suppressed via `addInitScript` —
headless Chromium doesn't fire it reliably). Real RED→GREEN both
projects.

**DEVICE-VERIFY (held, do NOT close on CI green).** Neither harness
reproduces Safari's chrome geometry nor the Android native prompt. Owed
on device: the arrow-to-⋯ offsets (first cut, tuned on-device) and the
Android prompt firing. Rides the batched device-verify hold.

_Deploy: **--cic HOT, client-only. No migration.**_

## 2026-07-16 — #74 inline topic edit from the topic bar (cicchetto-only)

Two changes: (1) the topic strip clamps to **two lines** instead of a
one-line ellipsis; (2) clicking the strip on an **editable** window
edits the topic in place — an inline `<input>` seeded with the raw topic
replaces the strip; Enter submits, Escape/blur cancels. No separate
dialog for the edit path (per the issue).

**Reuse the existing doors — no new server surface.** cicchetto-only;
submit routes through the SAME doors as the `/topic` slashes: non-empty
→ `postTopic` (REST), empty → clear via `pushChannelTopicClear` (the WS
verb — `postTopic` rejects an empty body). No optimistic write: the
strip repaints only on the relayed `topic_changed`. A server reject
(WS-down / 482) surfaces inline and PRESERVES the editor + draft (S21
no-false-success), mapped via `friendlyError`.

**FORK 1 — click behaviour.** Pre-#74 a click always opened a read-only
modal. Resolution: click → inline editor when the operator CAN set the
topic; the modal is retained only as the non-editable fallback (not
joined, or +t and not op). Consequence: set_by/set_at metadata surfaces
only in the fallback modal — accepted tradeoff of the dialog-less path.

**FORK 2 — permission gating (derivable, no invented model).**
Editability = `windowIsJoined && (!topicLocked || ownIsEditor)`; the op
check reuses ModeModal's editor-sigil derivation, extracted to the
shared `ownHoldsChannelEditorSigil`. Degrades CLOSED (false until own
membership seeds), consistent with ModeModal; the ircd's 482 surfaced
inline is the authority safety net — a momentarily-strict gate only
briefly hides the affordance, never a silent failed set.

**Two DRY extractions** (both call sites migrated — no "half-migrated,
two patterns"): `lib/friendlyError.ts` (compose submit catch + TopicBar)
and `lib/channelEditPerm.ts` (ModeModal + TopicBar). The editor is
single-line (an IRC TOPIC is one wire line); the two-line clamp is
display-only (`-webkit-line-clamp: 2`), invisible to jsdom — proven in
the e2e.

_Deploy: **HOT — `--cic` (bundle only).**_

## 2026-07-16 — #218 STATUSMSG notice routing (channel notices to `@#chan`)

**Symptom (P0).** A NOTICE to a STATUSMSG target — a membership sigil
prefixing a channel, `NOTICE @#grappa :…` (ops) or `+#grappa` (voice) —
landed in `$server` (or a per-peer query window) instead of `#grappa`.

**Root cause (`Grappa.Session.EventRouter`).** The `:notice` clauses
dispatch on the target's first byte against `["#","&","!","+"]`.
`@#grappa` fails the channel guard → non-channel arm. `+#grappa` was
broken the OTHER way: byte0 `+` ∈ sigils → persisted to a bogus literal
`+#grappa` window. `PRIVMSG @#chan` shared the class
(`channel_target?/1`). The remaining STATUSMSG gap of the #78/#128
route-by-target class.

**Fix — strip the statusmsg sigil BEFORE the channel-prefix test.**
`route/2` peels a leading statusmsg sigil off a `:notice`/`:privmsg`
param-0 target BEFORE `canonicalize_channel_params/1` (so the peeled
`#Chan` still case-folds) and before `do_route/2`; the underlying
channel flows through the existing channel arm. NO widening of
`Identifier.canonical_channel/1`'s sigil set (shared with
`Scrollback.target_kind/1`; widening would mis-tag other contexts).
**General rule + the `+` collision:** a leading sigil is STATUSMSG only
when (a) in the network's advertised set AND (b) a channel sigil
(`#&!+`) IMMEDIATELY follows — `+#chan` is a voiced statusmsg but bare
`+chan` is a real channel, never mis-stripped. Reuses
`channel_target?/1` so it agrees byte-for-byte with the dispatch guard.
Unit tests + two StreamData properties.

**STATUSMSG sourced from ISUPPORT, not hardcoded.**
`Grappa.Session.ISupport` (#216) gains `:statusmsg` (default = bahamut
`@+`; `merge_token` parses the 005 token). The strip stays a pure fn of
`(msg, sigil_set)` rather than consuming `state()` — an earlier
`state()`-typed spec made Dialyzer prove `state.nick` always-binary and
flag the existing `nick_eq?(_, nil)` guard as dead: a design signal the
strip should not depend on the full state shape.

**Hot-reload safety (mirrors #216).** The field lives inside
`ISupport.t()` on a long-lived `Session.Server`; every read is defensive
(`Map.get(map, :statusmsg, @default_statusmsg)`; writes via `Map.put`,
not `%{acc | …}`), so a running session with a pre-#218 map degrades to
`@+` (correct for Azzurra) instead of a KeyError, until its next 005.
`ISupport` deliberately NOT added to `Grappa.HotReload.LongLivedModules`
— the defensive reads make it hot-safe.

**cic untouched.** Once the row persists with `channel = "#grappa"` it
fans out per-channel like any notice. The optional "ops-only" badge
(statusmsg LEVEL in `meta`) is DEFERRED; if picked up it ships
one-feature-three-doors (a `Grappa.Scrollback.Meta` allowlist key + cic
badge + tests).

_Deploy: **SERVER — no migration, no `--cic`.** Preflight classifies HOT
(the field-add nested inside `ISupport.t()` is the exact
field-add-inside-@type gap the preflight misses); HOT is nonetheless
SAFE because every read defaults defensively. COLD-server is the free
belt-and-suspenders alternative (reseeds every session's isupport).
Either is fine for a batch deploy._

## 2026-07-16 — #252 vhost-selector V2 (rDNS names + mobile sub-page)

V2 replaces the interim #228 native `<select multiple>` of bare IPv6
literals with (a) server-side resolution of each address to its human
**name** and (b) a mobile-friendly cic settings SUB-PAGE (customize
toggle + 3-section tap-select). Builds on #251's `granted` marker.
**Deploy: HOT — server logic + `--cic`, NO migration.**

**NAME source = rDNS/PTR; the DNS is the source of truth (vjt).** No
`name` column, no DNS copy persisted. Options become `{address, in_pool,
granted, name}` (wire built inline in
`UserSettingsController.vhost_view/1` — no `*.Wire` module, the existing
pattern). `name` is ALWAYS a string: the resolved PTR name, or the raw
IP fallback.

**New (`lib/grappa/net/`):** `Grappa.Net.PtrResolver` —
`reverse_dns_name/1` (pure, unit+property tested) + `resolve/1` (thin
`:inet_res` glue, NOT unit-tested — network boundary, injected away);
`Grappa.Net.IpLiteral.to_tuple/1`. `Grappa.Net.PtrCache` — ETS-backed
GenServer singleton (supervised BEFORE Endpoint; in the `Grappa.Health`
`:ets` check), TTL-clamped per-entry cache.

**Cache strategy: LAZY, non-blocking (over warm-at-boot+schedule).** The
GET must NOT block on a cold cache. `names_for/1` is a lock-free ETS
read: fresh → name; cold/expired → `nil` (raw-IP fallback) + an
out-of-band `{:ensure, _}` cast so the NEXT read is warm; the resolve
runs in the cast handler (dedup via ETS re-check), never on the request
path. WHY lazy: the allowed set is PER-SUBJECT, so warm-at-boot would
STILL need a lazy path for fresh grants PLUS a scheduler whose
housekeeping can drift ("lightweight over heavyweight"); cic re-reads on
entering the sub-page, so steady state shows names. Negative cache:
`:nxdomain` → `:none` for `negative_ttl_ms`; resolver error → `:none`
for the shorter `error_ttl_ms` + one `:warning`. Defaults in `config
:grappa, :vhost_ptr_cache`; the resolver is injected at boot
(`:vhost_ptr_resolver`; tests wire an offline stub — the suite never
touches real DNS).

**No-PTR fallback (implemented; PENDING vjt sign-off).** `name` falls
back to the raw IP; cic renders `name` bold + the `/128` as a muted
subline, omitted when `name === address`. ALTERNATIVE not taken: a
"(no reverse DNS)" placeholder — raw-IP is honest, non-empty, actionable
(the operator sees which `/128`); a placeholder hides that. Flagged for
vjt's call.

**cic sub-page (`VhostSettingsPage.tsx`, new)** — a reusable settings
SUB-PAGE capability (`SettingsDrawer` gains a `settingsPage` signal +
nav row + back button). Pure presentational (server owns allow-set +
selection): a "customize" toggle — OFF (default = empty selection) =
random pool pick; turning OFF PUTs `selection = []`. Three tap-select
sections bucketed from `granted`/`in_pool` (empty sections hidden);
options are `.mode-modal-toggle` buttons (REUSED from the mode modals),
names wrap never truncated; tap toggles → immediate PUT. Identical for
visitor + registered.

**Evidence split.** The name≠IP proof lives in the controller test + the
`VhostSettingsPage` vitest (deterministic offline resolver); the e2e
(`issue252-vhost-selector.spec.ts`, supersedes `vhost-editor.spec.ts`)
proves the real-browser wiring and gates on the raw-IP fallback (no real
DNS in the test container).

---

## 2026-07-15 — #215 (P0): structured session-lifecycle logging + two disk-backed admin surfaces (Option B)

**Problem.** The app logs carried only Phoenix web-layer events — zero
IRC session-lifecycle. A user disconnect (the `H\mob` "Read/Dead Error"
that prompted #215) left no trace; every disconnect/expiry investigation
was blind.

**HALF 1 — the single emit path.** `Grappa.SessionLog.emit/3` is the ONE
path every `Session.Server` lifecycle transition routes through. Fires
synchronously in the caller's process (reliable even at BEAM shutdown —
no async hop): a greppable Logger line with structured KV metadata AND a
`[:grappa, :session, :log, <event>]` telemetry event. Events:
`:connected`, `:registered` (001), `:identified`/`:deidentified` (a new
`EventRouter` effect `{:session_identity_changed, :acquired | :lost}` on
the +r bit flip in the own-nick self-MODE branch — where both prev+next
umode sets are in hand), `:disconnected` (all three `terminate/2`
clauses, with reason + `clean` + `duration_ms`), `:backoff` (folding its
former ad-hoc Logger.info into the single path). `session_id` is the
greppable composite `<kind>:<uuid>:<network_id>` — the Registry key in
string form (NOT the auth bearer id, which is a secret). The
pre-existing `emit_lifecycle` telemetry feeding `AdminEvents`
cap-counting is UNTOUCHED — #215 uses its own namespace + sink.

**HALF 2 — expose (vjt DESIGN DECISION = OPTION B).** Two persisted
admin surfaces, both visible, NOT a merge:
(1) **New session-lifecycle log** — a `Grappa.SessionLog` GenServer sink
(sibling to `AdminEvents`) persists each event to `session_log_events`
(typed columns — uniform shape), prunes to a bounded on-disk ring
(retention 5000), broadcasts on `Topic.session_log/0`. Three doors:
`GET /admin/session_log` + `AdminChannel` live push
(`session_log_event`) + the cic `AdminSessionLogTab`.
(2) **Existing Events tab → disk-backed.** `AdminEvents` mirrors its
in-memory ring to a new `admin_events` table (`payload` as JSON `:map` —
a heterogeneous ~23-kind union, so a JSON column beats 30+ mostly-null
typed columns) + reloads on boot. The in-memory ring stays the live
serving source; the DB is durability.

**Impl decisions:** sqlite/Ecto for both (codebase idiom; no flat file).
No new JSON *console* backend ("JSON DESCOPED" stands): "structured
JSON" = the persisted rows served as JSON by REST + KV-metadata Logger
lines; the config change is a Logger `:metadata` allowlist extension.
Two SEPARATE stores (session-lifecycle ≠ operator-audit) — shared
execution framework, separate data models (reuse the verbs, not the
nouns). Both sinks persist from their singleton pid → a Repo write on a
foreign sandbox connection in unrelated tests; gated by
`persist`/`attach_*` flags OFF in test env (mirror of
`attach_admin_telemetry`); the persistence tests flip them on +
`Sandbox.allow/3`. The AdminEvents JSON round-trip yields a string-keyed
reloaded map — byte-identical over the wire and never atom-matched
server-side (the ring is opaque, serialized straight to cic).

**Testing.** Unit + integration via the in-process `IRCServer` fake;
`issue215-session-log.spec.ts` proves emit → persist → REST → cic
render end-to-end.

_Deploy: **COLD** — config Logger allowlist + two new supervised sinks +
two migrations. A cluster+migration combo cannot ride the hot path._

## 2026-07-16 — #262 mobile topic-bar height clamp (cic, client-only)

**Bug.** The mobile `.topic-bar-topic` strip was NOT height-bounded — a
long topic grew to full height (measured 367.5px, ~43% of an 852px
viewport), pushing the message log far down.

**Root cause — a regression from #74.** #74 (same day) replaced the old
1-line `white-space: nowrap` clip with `-webkit-line-clamp: 2`. But the
clamp only engages when the clamped runs are the DIRECT line-box content
of the `display: -webkit-box`; the strip is a `<button>` wrapping
`<MircBody>` (a button so a link tap can "surface-wins" bubble, #220),
and WebKit wraps a button's children in an internal anonymous box, so
the clamp never engages — and #74 ALSO dropped the `nowrap` clip, so
there was NO height bound at all when it failed (worse than pre-#74).

**Fix — a hard `max-height` cap, independent of the line-clamp.**
`max-height: 2.5em` (2 lines × `line-height: 1.25`) + the pre-existing
`overflow: hidden`. `em` is relative to the element's own font-size, so
the cap holds at every font-size preference (S–XXL, `lib/fontSize.ts`)
for free; border-box equals content-box here (`padding: 0`, `border:
none`), so it caps at exactly two line boxes. The full topic stays
reachable via the read-only modal + `title` tooltip — no information
lost.

**Why global, not `@media`-mobile.** The clamp-on-`<button>` failure is
an ENGINE behaviour, not a viewport one — fix the general rule. Where
the line-clamp engages the cap is a no-op; where it fails it bounds the
unbounded — zero desktop regression. Placed on the base rule (a
single-declaration addition, no new selector) so there is no
cascade/specificity tie to lose (cf. #260). The inline edit `<input>` is
untouched: topics are one wire line, the editor inherently single-line.

**Witness.** `issue262-topic-clamp-mobile.spec.ts` (`@webkit`): asserts
the topic is RENDERED (anti-false-green — `textContent` is unaffected by
`overflow: hidden`) then `.topic-bar-topic` ≤ 60px, `.topic-bar` ≤
120px. RED→GREEN proven (reverted fix: 367.5px). jsdom is blind to
layout — the e2e is the SOLE gate (vitest justified-skip).

_Deploy: **--cic HOT, client-only.** Pure CSS._

## 2026-07-16 — #260 sticky network tab on the mobile bottom bar (cicchetto-only)

**Intent (P1, vjt chat).** Scrolling the mobile bottom bar scrolls the
network label out of view. Desired: the current network's tab pinned at
the leading edge while its channels scroll, displaced by the next
network's tab — always exactly ONE network tab visible. The horizontal
analogue of a sticky list section header.

**Approach — CSS-first, no JS.** The DOM already groups tabs per network
(`.bottom-bar-network` flex rows inside the `.bottom-bar` scroller,
header first since UX-6-E) — the textbook sticky-header shape:
`position: sticky; left: 0` (the sticky element is constrained by its
containing block — the group — so the next group PUSHES the current
header out; the displace falls out of the CSS spec for free);
`z-index: 1`; and an opaque `background: var(--bg-alt)` in a SEPARATE
rule `.bottom-bar-network-header:not(.selected):not(:hover)`. Code
review caught that the header shares `(0,1,0)` specificity with
`.bottom-bar-tab { background: transparent }`, declared LATER — so a
plain `background` on the base rule is DEAD (verified: computed
`rgba(0,0,0,0)`, tab text bled through mid-scroll). The `:not()` pair
raises specificity to `(0,3,0)` to beat `.bottom-bar-tab` while yielding
to selected/hover. An e2e assertion (`backgroundColor !== transparent`
AND `===` the bar's) locks this against a future `.bottom-bar-tab` edit
silently re-breaking it.

**Pre-existing, deliberately NOT fixed (flagged for separate triage).**
The same `(0,1,0)` source-order tie means `.bottom-bar-tab` ALSO defeats
the header's authored `color: var(--accent)` + `font-size: 0.75rem`
(UX-6-E intent) — a pre-existing UX-6-E cascade bug. Restoring it is a
UX call beyond a "sticky tab" ticket; #260 fixes only the opacity its
own feature requires.

**Why CSS, not a scroll-driven JS translate.** A JS `scrollLeft →
translate` shadow would be a parallel client-side state machine over the
existing grouping — what "cic NEVER originates state" forbids. Pure
presentation; mobile-only (the bar renders solely in Shell's mobile
branch).

**Testing.** `issue260-sticky-network-tab.spec.ts` (`@webkit`; chromium
run intentionally empty — mobile-only): a computed-style contract plus a
behavioural test (one visitor on TWO networks — the #211 phase-7
topology, so no 433 autokill) driving programmatic `scrollLeft` + rect
assertions: always exactly one header at the edge. No synthetic touch
swipe: sticky is driven by `scrollLeft` however it moves; the #123/#255
caveat is TOUCH PAN PHYSICS, deliberately not attempted. No vitest
(CSS-only, jsdom blind). Real RED→GREEN. **DEVICE-VERIFY held** — the
"feel under a finger" check rides the pending device batch.

_Deploy: **--cic HOT, client-only.** CSS-only (one rule) + e2e._

## 2026-07-16 — #232 every cic modal closes on Esc (shared overlay ESC stack, cicchetto-only)

**Invariant shipped:** EVERY modal closes on `Esc` through ONE shared
mechanism — a new modal inherits it automatically.

**The real defect (audited at `4c1c644e`).** Esc was ad-hoc and
inconsistent: nine modals wired an ELEMENT-scoped `onKeyDown` on the
dialog div, firing only with focus INSIDE the dialog — none moved focus
in on open, so with focus in the compose textarea (the normal state
after `/mode`, `/names`, `/info`) Esc never reached the handler.
MediaViewerModal had its own document-level listener; ConfirmModal
worked only via autofocus-Cancel; ShareSessionModal had no Esc at all.
The issue's "Today" note (NamesModal/WhoModal lack Esc) was stale — the
defect was the inconsistency + the focus-scoping bug.

**Plan-vs-reality correction (load-bearing).** The build plan said
SettingsDrawer had "no Esc" and prescribed a NEW document-level listener
in `overlayScrollLock`, explicitly NOT touching `keybindings.ts`. Both
wrong: `lib/keybindings.ts:51` ALREADY owns a global window keydown
listener whose Esc branch calls `closeDrawer()` — the drawers already
Esc-closed, and a SECOND global listener would double-close (Esc on a
modal opened FROM the drawer would close both at once). vjt confirmed
the corrected design before build.

**Design U (chosen) — single Esc authority, no new listener.**
`overlayScrollLock` gains an ordered `onEscape` stack (opaque per-lock
token) + `runTopmostOverlayEscape(): boolean`; `createOverlayLock(
isOpen, selector, onEscape?)` registers/unregisters on the SAME
deferred-push/release edges as the scroll-lock refcount — one leak-safe
lifecycle, no drift (the ESC stack is a SUBSET of pushed overlays, not
derivable from the refcount, hence a separate structure bolted to the
same lifecycle). `keybindings.ts`'s existing Esc branch:
`if (runTopmostOverlayEscape()) return; else closeDrawer()` — ONE global
listener, the sole ESC authority; topmost-first precedence falls out
free. Rejected shape B (a dedicated `useModalEscape` hook with its OWN
stack + listener): a second "which overlays are open" registry to keep
in sync → drift risk, plus a second global listener racing the
keybindings one.

**Migration (total consistency or nothing).** All 12 covering modals
route Esc through `onEscape`; every per-dialog handler DELETED
(MediaViewerModal's private document listener included; Confirm/
DeleteAccount/Share migrated off direct `pushOverlay`/`popOverlay`;
ShareSessionModal GAINS Esc for the first time). TopicBar's read-only
topic modal was the 12th — it already called `createOverlayLock` for
the #219 scroll-freeze but lacked `onEscape`: caught in code review as
the exact half-migration the invariant forbids. The two drawers
(Settings, Members) stay scroll-lock-only, NOT in the ESC stack — they
remain the `closeDrawer` fallback (zero regression).

**Out of scope (documented classification).** The inline pinned CARDS
(`LusersCard`, `WhoisCard`, `WhowasCard`) are NOT modals (no backdrop,
inline × close) — deliberately excluded. A future covering modal MUST
call `createOverlayLock` with `onEscape` to inherit the invariant (and
the #219 scroll-freeze refcount). `InstallSplash` ALSO excluded: a
blocking install gate with no neutral "dismiss" verb for Esc to map to.

**Precedence guard.** No inner-widget Esc currently conflicts: TopicBar's
inline topic editor (#74) handles Esc at its own input level (not an
overlay); tab-complete and ModeModal's param input consume none. A
future inner Esc-consuming widget inside a modal must `stopPropagation()`
to win before the document handler.

**Testing.** vitest: the shared mechanism (topmost-first, register/
unregister edges, scroll-lock-only overlays stay out) + a keybindings
integration test (Esc from a focused textarea; `closeDrawer` fallback);
per-modal tests drive `runTopmostOverlayEscape`. e2e
`issue232-modal-esc.spec.ts`: Esc with focus PARKED IN THE COMPOSE
TEXTAREA (the condition the old handlers failed). RED→GREEN proven by
reverting the fix files under the spec.

_Deploy: **--cic HOT, client-only** — no server, schema, or wire
change._

## 2026-07-16 — #241 (P0, cic): animated spinner on the send button while a send is in flight

The send button's paper-plane glyph swaps for a CSS spinner while a send
is in flight, reverting on resolve. `<Show>` keyed on the pre-existing
`sending()` signal — no new state.

**Design fork — POST-scoped vs echo-scoped "settle" (the real
decision).** `sending()` is POST-scoped: resolves on the **201**. grappa
persists+broadcasts atomically, so the 201 is a real server ack, and the
WS own-echo has a live listener before the POST fires (#254
subscribe-before-send; channels already subscribed). Echo-scoped settle
(clear only when the sent row paints) REJECTED: needs cross-module
sent-row-id plumbing PLUS a timeout fallback (a lost echo would hang the
spinner forever; a timeout reintroduces the artificial delay the spec
forbids) — a mechanism heavier than the problem. POST-scoped is honest,
non-optimistic (never fakes a sent row), snappier; empirically verified
the echo does not lag the 201 before choosing the simpler path.

**Spec deviation — spinner colour is `currentColor`, NOT
`var(--accent)`.** The issue asked for the lime accent, but the button's
own background IS `var(--accent)` — a lime ring on a lime button is
invisible; the spec inherited a wrong assumption. `currentColor` matches
the arrow's stroke it replaces, inheriting the on-button contrast in
every theme. Reuses the `.login-spinner` ring recipe; fixed footprint so
the button never reflows; added to the `prefers-reduced-motion` freeze.
`aria-busy={sending()}` exposes the in-flight state (both glyphs
decorative).

**Testing.** vitest drives the real send path with the mocked submit
held pending. e2e (`issue241-send-button-spinner.spec.ts`) HOLDS the
POST via `page.route` so the in-flight window is non-transient —
deliberately NOT the issue254-style `addInitScript` fetch-frame
snapshot, because Solid may batch the `sending()` write so the spinner
DOM isn't committed at the synchronous fetch call frame. The revert on
the real 201 validates the POST-scoped design in-browser.

_Deploy: **--cic HOT, client-only.**_

## 2026-07-16 — #242 (P1, cic): admin Sessions tab shows the network slug, not the raw FK

The tab rendered the network column as the bare integer FK — two
networks on one account were distinguishable only by an opaque integer.

**Client-only — no server change.** The `/admin/sessions` wire already
carries `network_id`, and the tab ALREADY fetches `/admin/networks` in
parallel on every refresh (for the cap summary) — the slug was already
in hand. Fix: a `createMemo` `Map<network_id, slug>`; the cell renders
`networkSlugById().get(s.network_id) ?? String(s.network_id)`.

**Challenge-the-spec + a consistency tradeoff on record.** The build
brief hypothesised a server-side field-add; the client-side resolve is
the lighter path for a `--cic` HOT fix. `network_id` must stay on the
wire regardless — load-bearing for `adminSessionId/1` → the
disconnect/terminate mutation URLs. Honest counterweight (code review,
on record): the admin-sessions wire is the odd one out — every sibling
admin wire ships the denormalised slug directly — so a server-side
`network_slug` field-add would make it consistent and remove the
client-side join. Deliberately kept client-only per the issue scope, at
the cost of a two-endpoint join pattern not present elsewhere; a
follow-up server field is a reasonable cleanup. cic originates nothing
(pure display join of two server-authoritative reads).

**Honesty fallback.** An unresolved `network_id` (deleted-network race)
renders the raw id, never a silent blank.

**Testing.** vitest: slug resolution + raw-id fallback. e2e (`#242` case
in `m9b-admin-sessions-actions.spec.ts`) asserts the cell reads
`bahamut-test` via a positional locator — deliberately not the new
testid, so the RED run (fix stripped, testid absent) still fails on a
VALUE mismatch.

_Deploy: **--cic HOT, client-only.**_

## 2026-07-16 — #256 AdminVhostsTab: in_pool auto-sets + disables generally_available (cic-only)

**Ask (vjt).** Ticking `in_pool` auto-sets + disables
`generally_available` (an in-pool vhost is by definition available to
every subject); re-enable on un-tick.

**Design decision — READ-SIDE DERIVE (A); the UI mirrors existing
server law.** `Grappa.Vhosts.allowed_vhosts/1` already ORs the flags at
the single read boundary, so an in-pool vhost is available REGARDLESS of
its stored `generally_available` flag — the stored flag is cosmetic
while in_pool is on. Exactly "don't duplicate state — derive it": ONE
source of truth (the read-side OR); #256 must NOT store a second copy.
The tab does display-only enforce-forward: `checked = in_pool ||
generally_available`, `disabled = in_pool` (helpers
`effectiveGenerallyAvailable/2` + `generallyAvailableLocked/1`, reused
by the per-row toggle and the create form). No PATCH writes the derived
value; no changeset coercion; no migration.

**Why not write-side coerce (B).** Coercing `generally_available :=
true` when in_pool would (1) store a value the read-side already derives
— two sources of truth; (2) require a backfill of existing seed rows to
be honest — a COLD window. Neither is needed: the OR makes existing rows
correct today, and un-ticking in_pool re-reveals the operator's HONEST
stored flag instead of a coerced `true`. The optional DB-honest backfill
can ride a future cold window purely for tidiness — NOT required, out of
scope.

**Defense in depth.** The UI disable is UX only, never a security
boundary; the server authority is the read-side OR (unit-tested) plus
the write-time authz clamp in `set_selection/2`. Because the OR is
pre-existing, the availability leg cannot go RED→GREEN for a cic-only
change; the e2e RED→GREEN proves the UI enforce-forward leg.

**Testing.** vitest covers helpers + component states; e2e
`issue256-vhost-inpool-enforce.spec.ts` seeds a vhost via REST and
drives the row: tick → checked + disabled; un-tick → re-enabled.

_Deploy: **--cic HOT, client-only.** The read-side OR already ships in
prod (#251)._

## 2026-07-16 — #263 move topic editing into the modal (cicchetto-only)

Supersedes the #74 inline-strip editor. Tapping the topic strip now
**always opens the topic modal, for everyone** — the inline `<input>` is
gone; the strip is view-only (the #220 `surface-wins` link handling
preserved: a link tap opens the modal, never navigates). Editing lives
**inside** the modal: `canEditTopic` shows a **✏️** toggle → multi-line
`<textarea>` + **❌ cancel** + **✅ save**. ❌ discards the draft,
reverts to read-only, keeps the modal open; ✅ closes on success; a
server reject surfaces inline and preserves draft + editing state + open
modal (S21 no-false-success). A non-op sees a read-only modal only.

**WHY (vjt).** #74's dialog-less edit was a single-line strip `<input>`;
#263 wants a roomy multi-line surface and ONE discoverable place to
edit. There is now one topic window — the modal is no longer a
"non-editable fallback", it is THE topic surface.

**Reuse, not duplication.** ✅ reuses the EXISTING doors verbatim —
`postTopic` (REST) for non-empty, `pushChannelTopicClear` (WS) for an
empty clear, exactly as the `/topic` slashes and #74. The
`editing`/`draft`/`editError`/`saving` signals MOVED from the strip
editor to the modal editor; the divergent inline-strip path (input,
`onStripActivate`, error span, CSS, `topic-editor` testid) DELETED — no
two edit paths (total-consistency). No optimistic write: repaint only on
the relayed `topic_changed`.

**Domain gotcha — flatten to one wire line.** An IRC topic is a SINGLE
wire line; the server does NOT sanitise, it **REJECTS** any body with
`\r`/`\n`/`\x00` via `Grappa.IRC.Identifier.safe_line_token?/1` →
`{:error, :invalid_line}` (guards in `Session.send_topic/4` +
`IRC.Client.send_topic/3`) — a raw multi-line textarea submit would
ALWAYS fail. `flattenTopicNewlines/1` (`lib/channelTopic.ts`,
`/[\r\n]+/g` → `" "`) collapses every newline run to ONE space (words
never fused), applied on the non-empty set path before the send door. A
textarea cannot produce `\x00` — out of scope client-side.

**#232 interaction — edit-aware onEscape.** The modal joins the shared
Esc stack via `createOverlayLock`. #232 assumed the editor was OUTSIDE
the modal; a naive `onEscape = closeModal` would close + discard the
draft, violating "cancel reverts + stays open". The onEscape is
edit-aware: while editing, Esc runs `cancelEdit` (revert, stay open);
read-only, Esc runs `closeModal`. No element-level keydown fights the
stack; **Enter in the textarea stays a newline** (save is the ✅ button
only). The in-flight S21 guard (`if (saving()) return`) sits on both
`closeModal` and `cancelEdit` so ✕/backdrop/Esc racing an awaited send
can't tear down the editor.

**Supersedes the #232 precedence-guard note.** #232's claim that
"TopicBar's inline topic editor handles Esc at its own input level" is
STALE on both counts: no inline strip editor exists, and the topic
editor's Esc now rides the shared stack. The #232 rule that a future
inner Esc-consuming widget must `stopPropagation()` still holds.

**Testing.** `TopicBar.test.tsx` rewritten for the modal flow (mock
keeps the REAL `flattenTopicNewlines` via `importOriginal` so the
flatten wiring runs production code). e2e
(`issue263-topic-modal-edit.spec.ts`): Esc-while-editing = cancel, a
multi-line value flattened to ONE wire line witnessed by a second
in-channel `IrcPeer` (a regressed flatten is rejected upstream → the
peer never sees the topic → the spec fails — that's the proof), and the
S21 reject (413 via the 8192-byte `BodyLimit` cap → draft preserved).

_Deploy: **--cic HOT, client-only.**_

## 2026-07-16 — #265 (cic): activity/next-active indicator counts messages only, not presence churn

The #235 "next active window" affordance gated on
`selection.unreadCounts` — the TOTAL, messages **plus** events — so a
window with only JOIN/PART spam or a MODE flip lit it though nothing was
said. Field report: an "unread activity" signal firing on presence churn
is noise.

**Fix — one memo re-point, no new state.** The unread accounting already
splits content from presence at a single source: `api.ts`'s
`CONTENT_KINDS = {privmsg, notice, action}` + `selection.ts`'s three
derived memos (`messagesUnread` / `eventsUnread` / `unreadCounts`).
`activeWindows.ts` was the sole consumer gating on the total; it now
gates on `messagesUnread`. `orderUnreadWindows` is a pure fn taking
`unread` as a param — the scoping decision lives entirely at the call
site. One source, one gate, every door: the count, Alt+A, Ctrl+N/P and
the auto-hide all inherit it.

**NOTICE counts by default (the issue's open question).** Default ==
`CONTENT_KINDS` == PRIVMSG + NOTICE + ACTION; reusing `messagesUnread`
gives NOTICE-by-default for free, consistent with the sidebar message
badge. The preference toggle is explicitly out of scope (YAGNI). If
NOTICE is ever wanted EXCLUDED, that is an app-wide `CONTENT_KINDS`
change (moves every unread badge in lock-step) and belongs in its own
issue, NOT a fork of the activity gate.

**Badges unaffected.** Sidebar/BottomBar already render `messagesUnread`
and `eventsUnread` as two separate badges — presence churn is still
surfaced there, it just no longer lights the "go read something"
affordance.

**Testing.** The pure-fn vitest is agnostic to which memo feeds
`orderUnreadWindows`, so it CANNOT catch this fix (a false-green trap) —
behavioural coverage is `issue265-activity-messages-only.spec.ts`: a DM
with one inbound PRIVMSG + #bofh with ONLY a peer JOIN (event badge
verified accrued first, so the pre-fix failure is a clean count
mismatch); asserts `.next-active-count` is "1".

_Deploy: **--cic HOT, client-only.** A single memo re-point + e2e._

## 2026-07-16 — #268: green the `integration` suite + CI-green-before-ship rule

The `integration` CI job had been RED on main for 4+ commits with a
DIFFERENT failing spec nearly every run (the flaky-suite signature), and
batch-0716 shipped on that red base. A chronically-red suite MASKS real
regressions. Closed on two fronts: a persistent deploy-discipline RULE
and real fixes for the broken specs.

**The rule (CLAUDE.md §Development Cycle step 3).** Integration CI VERDE
prima di OGNI ship — hot/cold, cic/server, nessuna eccezione; the FULL
`scripts/integration.sh`, never a scoped `--grep`. The proximate cause
was a scoped `--grep #NNN` local pass proving ONE spec green while the
full suite was red.

### Target 1 (reliably red): `slash-commands-bundle.spec.ts` `/topic #chan <body>` cross-window (#23)

**NOT a grappa bug — bahamut fake-lag.** The test JOINs a fresh channel
then immediately `/topic`s it; both leave grappa's SINGLE upstream
socket for `(vjt, bahamut-test)` — shared by EVERY spec in the run.
bahamut's per-connection flood-throttling delays the TOPIC echo —
grappa's SOLE topic-persist path (the optimistic persist was dropped in
the #22 fix; `EventRouter`'s unsolicited-TOPIC handler is the only
writer) — until the penalty drains. Proven with data: the topic row
persisted at **+5.013s** after the POST, ~9ms past
`assertMessagePersisted`'s 5s ceiling; the self-JOIN was already
persisted (refuting the "TOPIC before JOIN → 442" hypothesis — both are
serialized in-order on one socket); the sibling test on already-joined
`#bofh` round-tripped in ~1.0s; iso `--repeat-each 5` trended 1.3→5.8s
as penalty accumulated.

**Fix (deterministic, NOT a blind bump).** `timeoutMs: 15_000` on the
topic assert — `assertMessagePersisted` is ALREADY a condition-poll
(returns the instant the row lands), so this is headroom, not a sleep;
15s sits above the proven ~5s and bahamut's ~10s fake-lag bank cap.
Validated: chromium full suite 308/308 green twice.

### Target 2 (~44% flaky): `issue254-own-echo-live.spec.ts` query subscribe-before-send (#254)

**A test-helper race, NOT a product bug.** `/msg` synchronously switches
selection to the fresh query window BEFORE awaiting the join + POST;
`composeSend` resolves as soon as the textarea reads empty — but the
freshly-mounted query window's textarea is ALREADY empty, so it can
return before the POST fires, and the spec read `__i254_readyAtPost`
prematurely (`null`). Instrumented `--repeat-each 25`: all 11 failures
showed no POST yet; server-side the join ALWAYS preceded the send — the
product guarantee holds. **Fix:** `page.waitForFunction` on the seam
flipping null→boolean at the POST call frame, then assert `=== true`.
Not masking: a genuinely-missing POST still times out red. 25/25 green.

### Target 3 (listed intermittent, SAME class as #23): #220 link-double-fire

`issue220-link-double-fire.spec.ts` carries the identical latent flake:
`/join` fresh channel → `/topic` → wait (was 10s) for the topic strip,
painted from the SAME fake-lag-delayed unsolicited-TOPIC echo; 10s sat
exactly at the fake-lag cap. Green in re-runs is the same weak signal
this incident condemns — "green N times ⇒ stable" is NOT sufficient in a
rotating-red suite. Same 15s condition-wait headroom.

### Target 3b (surfaced by the full-suite DoD run, SAME fake-lag class): #263 topic-modal-edit

`issue263-topic-modal-edit.spec.ts` failed intermittently at
`peer.waitForTopic` (5000ms) — the same delayed TOPIC round-trip, on the
peer-witness path. "Fix the general rule, not the example": the shared
`fixtures/ircClient.ts` `TOPIC_TIMEOUT_MS` raised 5s → 15s at the source
— both `IrcPeer.topic` and `waitForTopic` are TOPIC-echo condition-waits
and both fake-lag-exposed. The three non-scroll flakes (#23, #220, #263)
are ALL the one bahamut-fake-lag-on-TOPIC-echo root cause, fixed
consistently.

### Target 4 (listed intermittent): ux-5-bm mobile hamburger — genuinely stable

Asserts static DOM layout, no upstream round-trip → not fake-lag-
exposed. `--repeat-each 12` + two full webkit passes, zero failures. No
change.

### #253 webkit keyboard-scroll — full-suite-context flake, ROOT CAUSE PROVEN + fixed

Failing in full-suite context (2/3) but 15/15 iso. Instrumented run:
`atBottom` stayed FALSE throughout (no yank — the gated
`scrollToActivation` never fired); scrollHeight grew 1048px and
scrollTop grew the SAME 1048px = browser **scroll-anchoring after an
infinite-scroll loadMore prepend** — the visible position was preserved;
only the absolute offset moved, which the absolute-scrollTop assertion
misread as a yank. Full-suite-only because #bofh renders SHORT there
(`max ≈ 609px`), so the 30% park point (182px) landed inside
`maybeLoadOlder`'s `scrollTop <= 200` gate and the scroll-up itself
fired the prepend. Not a product bug; a TEST park-point straying into
the loadMore zone. **Fix:** `parkTop = Math.max(Math.floor(max * 0.3),
LOAD_MORE_THRESHOLD_PX + 60)` (≥ 260 provably prevents the prepend); the
assertion then measures the real contract, and a genuine keyboard-yank
is still caught. NOT a masked assertion.

### Target 5 (the CI gate-blocker): #188 mentions-panel — a REAL cic ordering bug (fixed client-side)

`issue188-mentions-panel-polish.spec.ts` failed at the count assertion
(expected "2 messages in 2 channels", got 0/0). NOT test timing — a
genuine latent **cic-side event-ordering bug** (server accounting
correct). Proof chain: the panel OPENING proves a non-empty
`mentions_bundle` arrived and was stored (the server broadcasts only
when `messages != []`, and only the bundle handler moves selection to
the mentions window); rendering 0/0 proves the store was WIPED after the
set; the only reachable wipe is `clearMentionsBundle` in the
`away_confirmed:"away"` arm of `userTopic.ts`.

**Root cause: two away-lifecycle events ride different-latency channels
and reorder.** The return-from-away `mentions_bundle` is broadcast
SYNCHRONOUSLY on the un-away command; `away_confirmed` is emitted ONLY
on the upstream 305/306 echo. Under fake-lag the going-away's 306
arrives AFTER the un-away's bundle; the handler cleared it, clobbering
the fresh bundle → 0/0. Unreachable in real usage (away periods dwarf
306 latency); the e2e compresses the cycle.

**Fix (client-side, root cause — vjt: "risolvilo sul serio lato
client").** Move the clear off the reorder-prone echo onto the user's
own GOING-away action: compose's `/away` (set) now calls
`clearMentionsBundle`; the `away_confirmed` arm no longer clears (still
drives the `[away]` badge). Causally ordered with the user's own
commands — a fresh bundle can never be wiped by a stale echo. The bundle
is a client-ephemeral render store, so clearing on a user action does
NOT violate "cic never originates state". **Accepted tradeoff (NOT
fully benign — corrected per code review):** auto-away and cross-device
going-away no longer clear the bundle, and the server suppresses the
broadcast when a return has zero new matches — so a prior cycle's digest
can SURVIVE (the `@` button stays lit showing a stale digest after a
specific multi-cycle sequence). A lingering stale digest, not data loss
(header timestamps disclose the age) — strictly less harmful than a
fresh bundle silently wiped. A robust clear would need the server to
sync-broadcast `away_confirmed` on command instead of on the echo — the
server-side alternative vjt explicitly steered away from; tracked as the
follow-up if the stale `@` ever annoys (the cross-device delta is
arguably MORE correct regardless). Unit-covered in `compose.test.ts` +
`userTopic.test.ts`; the e2e spec is UNCHANGED — the original flaky spec
now passes on the fixed behaviour.

### Target 6 (reproduced in full-suite run): #268 /q — composeSend early-return races the send-in-flight guard

`/q on a query window closes that window` failed: textarea stuck at
`"/q"`. NOT a product bug — a sibling of #254: `composeSend("/msg <peer>
hello")` returns when the textarea reads empty, but `/msg` switches
selection synchronously, so the textarea empties while the send is still
in flight; the deliberate ERR_NOSUCHNICK 401 round-trip under fake-lag
keeps `sending()` (the #241 guard) true past the early return, and
ComposeBox's `if (sending()) return` DROPS `/q`'s submit. The guard is
CORRECT product behaviour (anti-double-submit); only the test assumed
`composeSend` waits for completion. **Fix (test-only):** before `/q`,
wait for `compose-send-spinner` to leave the DOM (`toHaveCount(0)`) —
proof `sending()` is false. Condition-poll; 15s ceiling covers the 401
round-trip under fake-lag.

### Target 7 (the rotating-tail blocker): #79 own-echo drop — WS channel-subscribe race (fixed at the shared fixture)

`issue79-ios-select-keyboard-open.spec.ts` failed in DoD run #3: the
just-sent PRIVMSG's own-echo row absent. Pre-existing member of the
`feedback_ws_subscribe_race_pattern` class (siblings:
`__cic_userTopicReady`, `__cic_dmListenerReady`,
`__cic_queryWindowReady`).

**Proven LOST, not delayed — two independent sources.** Host trace: the
POST 201'd + persisted (row in the DB) but never rendered; cic renders a
sent message ONLY via the WS own-echo (no optimistic-on-POST —
#254/#251). Server code (`persist_and_send_fragments`): the channel
own-echo is generated LOCALLY on POST — persist → immediate synchronous
broadcast, NOT gated on any upstream echo (bahamut never echoes PRIVMSG
to the sender). So a >5s absence means the fastlane hit a socket NOT YET
subscribed — PubSub has NO replay to late subscribers; the echo is gone
forever. A timeout bump would NOT help. (Why #79 is a DIFFERENT root
cause from the fake-lag class: TOPIC is upstream-echo-gated and merely
delayed; the channel own-echo is local — delivered instantly or
dropped.)

**Why the pre-#79 gate was insufficient.** `selectChannel`'s
`awaitWsReady` waited for the self-JOIN scrollback line, believing it
proved both REST and the WS subscription. It doesn't: the self-JOIN is a
boot-persisted row served by the initial REST page, rendering while the
channel `phx.join()` ACK may still be in flight — it proved REST-landed,
never WS-subscribed. The `subscribe.ts` channels-loop comment even
asserted the loop "doesn't need" a ready seam because the JOIN line was
its signal — that assumption was the bug, corrected in-code.

**Fix (test-only seam on a real production ACK; GENERAL, not
per-spec).** `subscribe.ts` stamps `window.__cic_channelReady` (a
`Set<ChannelKey>`) in the join-ACK callback of BOTH channel-topic join
paths — the channels-loop AND the pending pre-subscribe loop (a
mid-session `/join` goes pending→subscribed there and the channels-loop
then skips it via the `joined` guard, so BOTH must stamp).
`cicchettoPage.ts` adds `waitForChannelReady`, folded into
`selectChannel` ADDITIVE to the JOIN-line wait: signal 1 proves REST
landed, signal 2 proves the socket is SUBSCRIBED. Every
selectChannel-then-send spec is race-free at the shared fixture — this
kills the whole "own-echo dropped because the subscribe wasn't live"
tail class, not just #79 (which inherits the fix through the fixture).
The seam is a test-only observation of a real production join ACK
(never read by prod); a never-ACK'd channel times out LOUDLY. No
production code changed — "never weaken prod for a test."

_Deploy: **mixed.** #188 (`compose.ts`, `userTopic.ts`) and #79
(`subscribe.ts`) ship together as a **`--cic` bundle**; everything else
is CI/test/docs only. No `lib/` — no server COLD/HOT. The gate this
unblocks is CI itself._

---
## 2026-07-16 — #273 (P0): read-cursor POST was ~10x slower than messages — badge fold moved off the write path

**Symptom.** `POST .../read-cursor` ~200ms vs ~20ms for `GET .../messages`; a
dropped slow write left the cursor stale, so reload scrolled back to the old
unread divider.

**Root cause (measured, not guessed).** `ReadCursor.set/4` 69µs,
`broadcast_set/5` 1µs, but `Grappa.Push.BadgeCount.count/1` **10,264µs
(148×)**. `EXPLAIN QUERY PLAN`: the per-window unread tail is `WHERE id >
after_id ORDER BY id ASC LIMIT 100`, and the composite `(user_id, network_id,
channel, server_time)` index is server_time-ordered — it can't serve an
id-range + id-order without a temp sort, so SQLite falls back to the
single-column `network_id` index (S33) and filters `channel`/`kind`
row-by-row across the whole network partition above the cursor, once PER
cursored window (default prefs make channel messages non-notify-worthy, so the
badge-cap early bail never triggers). The synchronous fold was the entire 10×.

**Fix — defer fold + broadcast off the write path.** Only the upsert is
request-critical (validated + #233-monotonic-clamped synchronously). `create/2`
defers badge + broadcast to a supervised fire-and-forget Task under the
EXISTING `Grappa.TaskSupervisor` — reusing that supervisor is load-bearing: a
new `application.ex` child would NOT start on a hot reload (`start/2` doesn't
re-run), so the change stays a pure controller edit and hot-deployable.

**Contracts preserved.**
* **Monotonic advance-only (#233):** the Task broadcasts the value `set/4`
  RETURNED — captured on the request path, threaded into the closure, **never
  re-read** (a re-read could observe a concurrent later write and emit an id
  inconsistent with this request's advance).
* **`:invalid_message` 422** stays synchronous (gates the write itself).
* **Broadcast reorder caveat (code review):** the async move WIDENS an existing
  reorder class — a fast fold for a later advance can overtake a slower fold for
  an earlier one, and a passive peer (cic `applyReadCursorSet` is
  last-write-wins, no receive-side guard) can transiently regress. Benign: the
  server clamp is the sole monotonicity authority (no broadcast carries a value
  below the committed cursor), the originating device advances its own signal
  map forward-only pre-POST, the peer's in-pane divider is frozen, and the next
  settle re-broadcast self-heals.

**Covering-index verdict — measured, then declined.** A covering `messages
(subject_col, network_id, channel, id)` index would fix the fold's absolute
cost, but (a) it's unneeded once the fold is off the critical path, and (b) it's
a MIGRATION → COLD deploy. Recorded as a future optimization if the background
fold ever becomes a pool-contention problem.

**Apply:** any new "compute + fan-out" following a cheap authoritative write
belongs OFF the request path under `Grappa.TaskSupervisor` — but capture the
write's returned (clamped) value and pass it into the task; never re-read
authoritative state inside the deferred closure.

_Deploy: server, HOT (pure controller edit)._

---

## 2026-07-16 — #80 (P1, cic): confirm dialog before a multi-line paste (flood guard)

A big multi-line paste + Enter floods a channel. By design, not a bug: on submit
`compose.ts` sends one PRIVMSG per line (`splitMessageLines` — an embedded LF
can't ride one IRC frame; the server bounces `:invalid_line`), so a 40-line
paste is 40 messages.

**Decision — confirm popup (spec option a), reusing the existing confirm
dialog.** The store-driven confirm singleton (`lib/confirmDialog.ts` +
`ConfirmModal.tsx`, #195) already carries the overlay scroll-lock, the #232
shared Esc-to-close, and Cancel-is-safe. The whole feature is one
`requestConfirm(...)` in `ComposeBox`'s `onPaste` — a new covering modal would
need its own `createOverlayLock` refcount (#219) + #232 Esc wiring ("reuse the
verbs, not the nouns"). Option (b), a review/edit area, rejected — materially
more surface for the same outcome; the textarea already IS editable once the
paste lands.

**Threshold — guard when a paste has > 3 lines.** Spec said "e.g. >2-3"; 3 is
the upper bound, biasing toward fewer interruptions. The count normalizes every
line-ending (CRLF, lone CR, LF), strips ONE trailing newline (common copy
artifact), and COUNTS blank interior lines — the count the operator SEES land,
deliberately distinct from send-time fan-out (`splitMessageLines` drops blanks).
One knob: `PASTE_FLOOD_LINE_THRESHOLD` in `lib/pasteFlood.ts`.

**Copy is target-neutral + honest.** `channelName` is a peer nick on a DM, so
"flood the channel" would misdescribe it; "one message per line" over-claims
(blanks drop at send).

**Disjoint from file-paste upload.** `onPaste` handles clipboard FILE items
first (own `preventDefault` + `triggerUploads`); the text guard only fires for
plain-text pastes with no uploadable items.

**Insertion mirrors native paste.** On confirm: splice at the caret (replacing
selection), caret after, textarea refocused. Cancel does NOT restore focus —
intentional asymmetry (accept = keep typing; cancel = changed your mind).

**Out of scope.** The spec's optional "send line-by-line vs single message" is a
separate ComposeBox-submit decision — not built here.

_Deploy: cic-only (`--cic`)._

---

## 2026-07-16 — #257 admin vhost-grant subject autocomplete (unified users + visitors)

Replaces the vhost-grant form's `user | visitor` type-select + raw `subject_id`
UUID input with ONE autocomplete over both subject kinds: type-tagged "network -
nickname" results.

**Unify vs type-select (vjt 2026-07-15): UNIFIED.** The tagged-union endpoint
stayed clean, so the type-select fallback is gone. Clean because each leg is
scoped to its OWN subject column and merged in Elixir — never one polymorphic
query with a nullable FK in a `NOT IN` (the #211-p7 NULL-poisoning class).
`Grappa.SubjectSearch.search/2` composes `Accounts.search_users/2` +
`Credentials.search_visitor_credentials_by_nick/2` into a `SubjectSearch.Result`
tagged union `%{type: :user | :visitor, id, network, nick}`.

**Stable key, never the nick.** A visitor is multi-network (#211) — nick is not
a stable identity key; the result's `id` is the surrogate user/visitor id,
mapping 1:1 onto the grant body `{subject_type, subject_id}`. A multi-network
visitor with the same nick yields N rows. A user has no single network: `network:
nil`, displayed "account - name" (no fabricated network).

**Nick fold + LIKE hygiene.** The visitor leg rfc1459-folds BOTH sides (GH #121
— `Identifier.canonical_nick/1` on the query, `nick_fold/1` fragment on the
column). Folding runs BEFORE the LIKE-escape so a `\` in the query (folds to `|`)
never collides with the escape char. New `Grappa.Ecto.Like` leaf util is the
single source of `% _ \` escaping — underscore is a legal nick char and must
match literally. Leading-`%` pattern is not index-eligible; fine at
operator/visitor scale.

**Endpoint path + nginx.** `GET /admin/vhosts/subject_search?q=…` nests under
`vhosts` deliberately: the existing nginx allowlist alt in
`infra/snippets/locations-api.conf` ALREADY matches → no nginx edit → pure hot
server + `--cic`. A top-level `/admin/subject_search` would have needed a snippet
edit + reload. If reused beyond the grant form, promote to a top-level path +
allowlist entry then.

**cic contract.** `SubjectAutocomplete` owns only TRANSIENT search state; the
SELECTION lives in the parent grant form, so a post-grant reset clears the chip
with no component-held state to desync.

_Deploy: HOT server + `--cic`, no migration._

---

## 2026-07-16 — #264 mobile next-active button: keyboard-safe circle (cic, client-only)

**Bug.** The mobile "jump to next active window" pill (`NextActiveButton`
variant="mobile", #235) was `position: absolute; bottom: 0.5rem`. `.shell-mobile`
is NOT a positioned/transform containing block (the "transform containing-block"
note in Shell.tsx is stale — no transform exists), so the button anchored to the
LAYOUT viewport, which iOS does NOT shrink on keyboard open → button under the
keyboard exactly when the compose box is focused (its primary use case).

**Fix reuses an existing primitive.** `.shell-mobile`'s height already tracks
`--viewport-height` (lib/viewportHeight.ts, re-written on every
`visualViewport.resize`); `.settings-drawer` / `.shell-members` already ride the
keyboard via `position: fixed` + that var. The button just wasn't using it.

**Design — fork A + B combined.**
- **(A) Keyboard-aware geometry.** `position: fixed` (self-contained — NOT
  `position: relative` on `.shell-mobile`, which would re-anchor other absolute
  descendants), anchored `top: calc(var(--viewport-height, 100dvh) - 3.5rem -
  var(--nab-lift))`. The var shrinks with the keyboard → the button rides above
  it. Derives from existing state, no parallel tracker.
- **(B) `:has(...:focus)` focus lift.** `.shell-mobile:has(textarea:focus,
  input:focus)` bumps `--nab-lift` to clear the bottom bar. SECOND job:
  testability — headless WebKit raises no soft keyboard, so `--viewport-height`
  alone wouldn't move on focus; the focus rule makes the reposition observable in
  the e2e.

**Shape.** Symmetric `3.5rem` circle (`border-radius: 50%`), glyph centered at
`1.75rem`; `min-width/height: 48px` keeps the ≥44px HIG tap target at the
smallest `--font-size`. Count moves to a corner badge so the body stays a pure
circle. **Pure CSS — NO markup change**; desktop unchanged.

**Device-only deferral (justified, NOT a silent skip).** Real soft-keyboard
geometry is not Playwright-reproducible (headless WebKit has no soft keyboard).
Queued for the real-device batch.

_Deploy: --cic HOT, client-only._

---

## 2026-07-16 — #234 (P0, cic): honor the OS rotation lock — drop the manifest orientation pin

**Bug.** An installed Android PWA re-laid-out between portrait and landscape even
with the OS auto-rotate lock ON — cic was overriding the OS preference.

**Root cause + fix (one line).** The PWA manifest pinned `orientation: "any"`
(`cicchetto/vite.config.ts`, VitePWA block). ANY pinned `orientation` — even
`"any"` — makes an installed Android WebAPK assert control and IGNORE the OS
rotation lock. The fix DELETES the key (not set to `"portrait"`/`"natural"` —
removing it is what returns control to the OS). A tree grep confirmed this was
the sole override: no `screen.orientation.lock()` anywhere, no orientation meta
in `index.html`. Manifest-only.

**Responsive layout unchanged.** When the platform DOES rotate, cic still
re-lays out via its existing resize/orientationchange listeners.

**WebAPK re-mint nuance.** Removing the key changes the manifest hash; Android's
hash-keyed WebAPK minter mints a fresh WebAPK. Because `id: "/cic"` is stable
it's the SAME app — existing installs pick up the change on Android's periodic
async re-mint (propagation nuance, not a deploy blocker). `id` deliberately
untouched — mutating it orphans installs and forks a parallel WebAPK.

**e2e-ability call.** Playwright can't emulate OS rotate-lock or install a
WebAPK; a viewport-resize "rotation" spec passes with OR without the fix (hollow
green) — deliberately not written. What IS testable is the artifact: assert the
served manifest has `id === "/cic"` and no `orientation` key (catches a re-pin
regression). Rotation BEHAVIOR verified on a real device.

_Deploy: --cic HOT, client-only (manifest-only)._

---

## 2026-07-17 — #275 (P0, cic): stack channel modes below the name in a width-capped clickable box

**Change.** In `TopicBar.tsx` the channel name and compact mode string were two
independent flex siblings on one row — cramped on a width-limited bar. #275
stacks the modes on a second line below the name inside one width-capped box, and
makes the whole box a click target opening the /mode modal.

**Reuse-the-verb, not a new modal.** The box's `onClick` calls the EXISTING
`openModeModal(networkSlug, channel)` (`lib/modeModal.ts`) — same open-verb as
`/mode #chan`, bare `/mode`, and the old inline indicator. `ModeModal.tsx`
untouched.

**No button-in-button.** The box is the `<button>` (`.topic-bar-namebox`); name
+ modes are `<span>`s inside it. This keeps `.topic-bar-modes` (now a span) a
valid click path: issue216/issue240 `.click()` that selector and stay green
because the click bubbles to the enclosing button.

**Width cap — annotated default, tunable.** `.topic-bar-namebox` is a flex column
with `max-width: 18%` — mid-point of the spec's 15–20% band, a SINGLE annotated
CSS token. `flex: 0 1 auto` + `min-width: 0` + child `max-width: 100%` + ellipsis
so a long name/mode clips, never blows the box. Mobile-first (≈70px box on a
~393px bar, topic keeps ~80%); `.topic-bar` stays `align-items: center` so a
two-line box balances a two-line topic. Desktop doesn't regress.

_Deploy: --cic, client-only._

---

## 2026-07-17 — #278 (P1, cic): mobile next-active circle overlapped the send button, keyboard-open

**Regression from #264.** With the keyboard open, the next-active circle sat on
top of the compose send button; keyboard closed was fine.

**Root cause.** #264's focused `--nab-lift: 4rem` clears ONLY the `.bottom-bar`
(`min-height: 3rem`). The `.compose-box` (~3.5rem; `rows=1` textarea, `resize:
none`, never grows) stacks ON TOP of the bottom bar, and the send button is an
in-flow flex child with no stacking context — so the 4rem lift dropped the
`z-index: 40` circle into the compose-row band on the shared right edge, covering
send.

**Decision — forward-fix, NOT a revert.** Reverting re-buries the circle under
the keyboard. The 20% #264 got wrong was the lift MAGNITUDE, not the mechanism.
Same keyboard-open signal (`:has(textarea:focus, input:focus)` — no parallel
tracker), focused lift `4rem → 8rem` (3rem bottom bar + ~3.5rem compose +
margin). **Known residual (accepted, MVP):** ComposeBox renders variable-height
strips below the form (upload-progress/error/not-joined) that push send UP; worst
case they re-touch the circle. Fully fixing means anchoring to the compose
GROUP's variable height (JS/layout-ref, beyond MVP); the residual is strictly
better than 4rem. Considered + rejected: (a) raising send's `z-index` (still
visually stacked — tap ambiguity, not a fix); (b) a `transform` on `.shell-mobile`
as containing block (breaks #264's viewport-anchored keyboard-ride — forbidden by
the Shell.tsx comment); (c) bottom-LEFT (collides with the paperclip upload
button / covers the textarea).

_Deploy: --cic, client-only._

---

## 2026-07-17 — #276 (P0, grappa + cic): suppress away-ack scrollback noise at the server; 💤 away indicator

**Problem.** Every away toggle wrote a chatty `$server` line ("You have been
marked as being away" / "no longer marked"); auto-away/back cycles (WSPresence)
accreted pure noise — the away STATE already rides a separate typed signal cic
renders as an indicator. Also: vjt wants the indicator to read 💤.

**Root cause (server).** The lines are the trailing text of ack numerics **305
RPL_UNAWAY / 306 RPL_NOWAWAY**, which sat in `NumericRouter`'s `@active_numerics`
→ routed `{:server, nil}` → persisted a `:notice` row on `$server`. The away
STATE rides a separate correct path: EventRouter's 305/306 clauses fire the typed
`{:away_confirmed, :present | :away}` effect → `Topic.user` broadcast → cic
`awayStatus.ts`. Cleanly separable.

**Fix (server, not a cic band-aid — cic never originates state).** Moved 305/306
to `@delegated_numerics`: delegated numerics are owned by an EventRouter handler
and NOT persisted, so the effect still fires with no `$server` row.

**Labeled-response subtlety (the general-case root cause).** `route/2` checked
the `labeled-response` label override FIRST, and `labels_pending` is populated
SOLELY by the away command — 305/306 are the only labeled replies grappa ever
receives. A labeled away-ack would hit the label override, route to its origin
window, and resurrect the very row being suppressed. So delegation now WINS over
the label override — behaviour-identical for every other numeric (none is ever
labeled) and closes the latent double-persist any future labeled delegated
numeric would hit. Priority is now **delegated > label > active-deny >
param-scan**.

**cic — 💤 label.** The away indicator lives in one place: `Sidebar.tsx`'s
collapsed network-header badge. Visible glyph 💤 rendered as `role="img"
aria-label="away"` (+ `title`) — the canonical accessible-emoji pattern: screen
readers announce "away", not the glyph name; `role="img"` also makes the
accessible name valid (a bare `<span>` has the generic role, which prohibits
naming — biome a11y flags it).

_Deploy: server (HOT-eligible — verify preflight) + --cic, run BOTH._

---

## 2026-07-17 — #271 (P0, grappa): outbound sessions all pin ONE v6 leaf — own the leaf choice (self-resolve AAAA + random pick + IP-tuple connect), rotate on fail

**Symptom.** Every outbound grappa session landed on the SAME upstream v6 leaf:
Azzurra opers saw ~40 grappa connections on one of `irc.azzurra.chat`'s two v6
leaves, zero on the other — no distribution, and one leaf down takes every
session with it instead of 1/N.

**Root cause (verified against code + prod DNS).** `Grappa.IRC.Client` handed the
**hostname** to `:ssl.connect`/`:gen_tcp.connect`. With no inet override,
resolution goes through getaddrinfo, which applies **RFC-6724 destination-address
sorting** (Rule 9: longest-prefix-match toward the source) — with the source pool
in `2a03:4000:2:33c::/64`, the same AAAA wins the sort on EVERY connect,
regardless of DNS round-robin order. The client threw the server-side rotation
away at the sort. `resolve_and_ifaddr/1` already did `:inet_res.lookup(host, :in,
:aaaa)` — but only as a presence check, discarding the set and still dialing the
hostname: it resolved but never *picked*.

**Fix — grappa OWNS the leaf choice.** New `connect_with_rotation/6` between
`source_bind/2` and the socket call:
1. `resolve_targets/3` — resolve the full RR set for the family `source_bind/2`
   chose (injected resolver), then `Enum.shuffle/1`. An IP-literal host
   short-circuits (no DNS — keeps IP-literal upstreams and the `Grappa.IRCServer`
   harness off the resolver). An empty answer falls back to `[host]` (no worse
   than pre-#271).
2. Dial the **IP tuple** as the connect target → bypasses the getaddrinfo
   RFC-6724 sort entirely.
3. `connect_rotating/7` tries the shuffled set in order; a dead leaf rolls to the
   next before the `:transient` give-up; on exhaustion the last `{:error,
   reason}` surfaces verbatim into the existing connect-fail throttle + give-up
   chain (rotation never swallows a real give-up). Three-clause recursive.

Applies to BOTH `source_bind/2` paths (pool and fixed-source) via shared
`do_connect/5`. Accepted redundancy: the pool path's AAAA *presence* lookup and
`resolve_targets/3`'s *set* lookup are two queries per reconnect — cheap,
resolver-cached, backoff-paced; kept rather than threading a second return shape
out of `source_bind/2`.

**#89 TLS invariant PRESERVED (the explicit guard).** Dialing an IP tuple strips
the hostname TLS needs for SNI + RFC-6125 verification. `transport_connect/7`
keeps `target` (the IP dialed) separate from `host` (the hostname threaded into
`tls_connect_opts/1`), so `server_name_indication` + `customize_hostname_check`
stay anchored to the hostname, never the IP — had they followed the IP,
verify_peer would fail every TLS connect. Dedicated regression test.

**DI shape.** Resolver + connect fun injected via a `deps` map through
`do_connect/5` (real funs wired in `handle_continue/2`; NO runtime
`Application.get_env`, no `\\` defaults). Tests substitute via the existing
`__*_for_test__` seam convention.

**Scope.** #271 only. #93 (server-level failover across `network_servers` rows by
priority + backoff) is folded as a joint work-unit, queued separately.

_Deploy: server HOT, no --cic, no config. A HOT reload does NOT reconnect live
sessions — rotation applies on the NEXT (re)connect, expected + correct; do not
force-cold to "demonstrate" it._

---

## 2026-07-17 — #269: admin Visitors-tab Disconnect ⇄ Reconnect toggle (Sessions-tab parity)

**What.** The Visitors tab gains a per-`(visitor, network)` Disconnect ⇄
Reconnect toggle (Sessions tab already had Disconnect). Per-network by design: a
visitor holds sessions on several networks — the control acts on ONE, never a
global "disconnect everywhere".

**Route decision — reuse, no new nginx prefix.** Disconnect already worked: `POST
/admin/sessions/:id/disconnect` parses the composite `"<kind>:<uuid>:<network_id>"`
id and `Operator.disconnect_session/4` handles `{:visitor, _}` (collapses to
terminate — visitors have no `:parked`). Only Reconnect was missing → `POST
/admin/sessions/:id/reconnect` on the same controller. Nesting under
`/admin/sessions/` rides the existing nginx allowlist AND the e2e
`nginx-test.conf` — no proxy change.

**Verb reuse.** `Operator.reconnect_session({:visitor, id}, network_id)` →
`Visitors.SessionPlan.resolve/2` → `SpawnOrchestrator.spawn/4` (`flow:
:visitor_reconnect`, `source_ip: nil`, requester self-excluded from the per-IP
cap) — the SAME connect core the visitor `PATCH /networks/:id` path drives.
Idempotent (`:already_started → :ok`); resolve failures → 500; unknown → 404;
admission/spawn errors propagate verbatim to FallbackController.

**Visitor-only (by design).** Users park/reconnect their OWN sessions via `PATCH
/networks/:id`, so a `{:user, _}` composite id on reconnect is 400. The Sessions
tab is registry-driven (live pids only) so a downed session never shows there —
the toggle belongs on the Visitors tab, which lists DB-canonically with
per-network `live_state`.

**DB-vs-live honesty (CLAUDE.md invariant).** The toggle keys off LIVE truth
(`net.live_state`), NOT DB `connection_state`: a visitor disconnect collapses to
terminate (pid gone, credential stays `:connected`), so the row honestly shows
the divergence — `live_state: null` badge alongside the `:connected` glyph — and
the toggle reads Reconnect because the pid is gone. `Visitors.AdminWire.network_json/0`
gained `network_id` (raw FK) so cic builds the composite id; hand-mirrored in
`api.ts`, NOT codegen'd (`admin_wire.ex` is outside the `wire.ex` glob — no drift
gate).

**Scope.** MVP = the parity toggle. No `session_reconnected` admin event (would
cascade across the AdminEvents wire enum + cic union + renderer); the Visitors
tables are refresh-driven, so reconnect surfaces via the post-action refetch
regardless — the event is a clean follow-up.

_Deploy: --cic + server HOT, no migration._

## 2026-07-17 — #88 (P2, grappa): terminate/2 graceful QUIT — best-effort against a socket-close race

**Core was already shipped** (`d3c7286`/`fd96891`/`18aa3b9`): `terminate(:shutdown
| {:shutdown, _})` sends a graceful upstream `QUIT :grappa shutting down`;
`terminate(:normal)` deliberately does NOT QUIT (the operator path already
emitted its own QUIT before the `:normal` stop). This entry is the residual tail.

**Root cause — a socket-close race, NOT the `:normal`-clause gap #88 first
guessed.** A clean `server_test.exs` run reproduced the `tcp_closed terminating`
crash signature 10×: `GenServer.call(client, {:send, "QUIT …"})` exiting `**
(EXIT) :tcp_closed` inside `terminate/2`. When the upstream socket has just
closed, the linked `IRC.Client` stops with `:tcp_closed`/`:ssl_closed`; if that
stop lands while the QUIT call is in flight, the call exits `{:tcp_closed |
:ssl_closed, {GenServer, :call, _}}`. The U-cluster boundary fix (`{:send, _}`
returns `{:error, :no_socket}` on a nil/closed socket) handles *dead-before-call*
— not this *dies-during-call* race, whose exit reason was missing from
terminate/2's catch allowlist.

**Fix (MVP).** Extend the `terminate(:shutdown)` catch allowlist with the two
socket-already-gone reasons (`:tcp_closed` / `:ssl_closed`, bare + call-wrapped).
A QUIT against a closed socket is a no-op — must not crash terminate/2. **Narrow
allowlist only, NOT a widened `:exit, _`** (CLAUDE.md "no silent-swallow at
boundaries": swallowing everything hides the next bug). The `:normal` clause is
untouched (item 1 was a red herring); item 2 ("close socket explicitly") stays
out of scope — link teardown already closes it. Whole-file crash-signature count
10 → 0.

_Deploy: server HOT (extra catch clauses only)._

### 2026-07-17 — #270 (cic): peer-away banner rendered in-flow, not floating

**Bug.** In a fresh DM to an away user, the first message you send rendered
directly underneath the peer-away banner — visual overlap.

**Root cause.** The banner mounted inside `.scrollback-overlay` — the #133
top-pinned overlay (`position: absolute; top: 0`) that keeps lookup cards from
shrinking the scroll list / shifting the reader's anchor. `.scrollback` reserves
NO top space for the overlay, so its first row paints at `y = 0` under the banner.
Ephemeral lookup cards tolerate this; the peer-away banner is *persistent* and
appears *precisely when the scrollback is empty*, so the overlap is very visible.

**Decision — B over A.** (A) reserve dynamic `padding-top` while the banner shows
— needs a magic-number banner-height measurement (message wraps to variable
height), and conditional top padding is itself a scrollTop shift, partially
re-introducing the #133 anchor-shift. (B) render the banner **in-flow** at the
top of the scroll list — reserves its own space by construction, no measurement.
Chose B.

**Why B doesn't re-introduce the #133 anchor-shift.** #133 was ephemeral cards
mounted as flex siblings *before* `.scrollback`, shrinking the list mid-read.
Peer-away differs: DM-contextual + persistent (semantically the first line of the
conversation); appears as a consequence of the operator's own `/msg`
(bottom-anchored composing, not scrolled-up reading); placing it *inside*
`.scrollback` adds content rather than shrinking the container. It never fed the
overlay-freeze machinery either (the `pointer-events: none` banner never
contributed to `overlayScrollSnapshot`).

**In-flow but NOT woven into `rows()` (B2, not B1).** The P-0e invite-ack
synthetic rows live in `rows()` only for wallclock timeline-weaving; injecting the
banner as a Row would make its appear/dismiss toggle change `rows().length`,
tripping the #196/#230 tail-follow effect keyed on it. Instead the mount moved
from the overlay to the first child inside `.scrollback`, gated `<Show when={kind
=== "query"}>`, reactive to `peerAwayBySlug()` only — out of `rows()` and the
anchor machinery.

**Accepted trade.** An in-flow banner scrolls with the buffer, so in a long DM it
scrolls out of view (the overlay stayed pinned). Fine: away context matters most
at the start of a DM; irssi treats an away notice as an ordinary buffer line. If
pinning is ever wanted, `position: sticky; top: 0` reserves space AND pins — out
of scope.

_Deploy: cic-only (`--cic`)._

## 2026-07-17 — #281 (P1, cic): account switch replayed the previous session's fetches → 404 self-ban; purge network resources on identity change

**The incident.** Detach account A, log in as account B → a ~30-request burst of
`GET /networks/<A-net>/channels/<chan>/messages?after=0` + `/networks/<A-net>/featured`
under B's bearer, all 404 (B isn't attached to A's networks). The burst tripped
the m42 host's aggressive `http-404` fail2ban jail → firewall-banned the client's
public IP. A routine account switch self-banned the user.

**Root cause (confirmed by reading Solid, not guessed).** cic's network tree is
three token-keyed `createResource`s in `lib/networks.ts` (`user` → `networks` →
`channelsBySlug`). The moduledoc claimed "no `on(token)` cleanup needed —
createResource re-fetches on rotation." That is the bug: re-fetch ≠ **clear**.
Solid 1.9.12's `load()` RETAINS the last resolved value when the source signal
goes falsy. On detach (`tokA → null`) all three keep A's data; on re-login (`null
→ tokB`) the token-tracking effects in `subscribe.ts` (channels / query-windows /
dm-listener / server-window loops) and the `HomePane` featured fetch re-run
against A's STALE network/channel list under B's bearer — before the resources
refetch — producing the burst.

**Fix — reuse the verb, not a new noun.** Every other identity-scoped store
already resets via the shared `identityScopedStore` factory (`createRoot` + an
`on(token)` reset arm); `networks.ts` was the sole gap (hand-rolled bare
`createRoot`, no reset). Wrapped in the factory + an `onIdentityChange` purge that
`batch`-mutates all three resources to empty. The factory's `prev != null && t
!== prev` filter fires on the real transitions (logout, rotation) and masks
initial registration + cold login. `batch` so no dependent computed observes a
half-purged (new-token, stale-networks) state that could re-fire a fetch.

**`user` is the root — clear it, the rest cascade.** The two replay arms have
different gates: the subscribe.ts loops key off `networks()`, but the featured
fetch keys off `user()` via `homeData`. Clearing `user` stops BOTH. All three are
purged explicitly anyway (batch atomicity). General rule (any stale-identity cache
outliving the switch), not the specific instance. NB: purging `networks` alone
would leave the featured 404s firing — a trap the code comment calls out.

**Deferred defense-in-depth (separate deploy classes, filed as follow-ups).** (b)
SERVER — return 200 + empty page instead of 404 for a well-formed history request
against an unattached net/chan; (c) INFRA — whitelist the API vhost from the
aggressive `http-404` jail (or raise its threshold) so ANY 404-emitting client
bug can't self-ban a real user. The client purge removes the burst at the source,
so the self-ban is fixed without them.

_Deploy: cic-only (`--cic`)._

---

### 2026-07-17 — #285 (P0, cic): iOS-PWA cold-reload scroll lock — overflow gate now follows real geometry via ResizeObserver

**Symptom.** Installed iOS PWA, after full-page reload / cold boot: `.scrollback`
completely unpannable in EVERY tab; unblocks only on tab switch or a height change
(keyboard open). Longstanding, not a regression; not reproducible off-device.

**Root cause.** Touch pan is gated by a JS-toggled class, not native overflow:
base `touch-action: none` (default-deny, else iOS falls through `pan-y` to a
chrome-reveal gesture when not overflowing), and only `.scrollback-overflowing`
enables `pan-y`. That class is bound to `isOverflowing`, set ONLY by
`measureOverflow()` (double-rAF `scrollHeight > clientHeight`) on three triggers:
mount, message-length change, and window/visualViewport `resize` (#245). No
`ResizeObserver` — the gate never followed actual geometry. On an iOS-PWA cold
reload the mount measure reads a too-tall `clientHeight` (`--viewport-height`
unsettled at boot) → gate latches false → scroll dead. When the viewport settles
the container SHRINKS — a real geometry change — but **without a `resize` event
this pane catches** (a CSS/safe-area settle fires no JS `resize`; or `vv.resize`
fires before the pane's listener attaches). So #245's resize→remeasure never runs
and the false latch never corrects. The workarounds fit: tab switch remounts;
keyboard-open IS a `vv.resize`.

**Why #245 wasn't enough.** `onResize` already calls `measureOverflow()`
unconditionally and the P0 still reproduced — the gap is not a missing trigger;
the corrective settle produces geometry change WITHOUT an event. Of three
hypotheses, h1 (no/late resize event) held. h2 (zero clientHeight) is a
false-POSITIVE direction (zero makes the gate OPEN, not the reported jam), and a
retry-on-zero guard would spin an unbounded rAF loop in jsdom — rejected. h3 (boot
var read) is the upstream trigger but the wrong lever: the observer makes the gate
self-correcting regardless of the boot value ("derive, don't chase the boot
race").

**Fix.** A `ResizeObserver` on the scroll container, created in `onMount` (guarded
on `typeof ResizeObserver`, mirroring the `visualViewport?.` guard + the #230
create-in-onMount / disconnect-in-onCleanup discipline), callback →
`measureOverflow()`. Fires on ANY container height change independent of events.
Loop-free: `measureOverflow` toggles only a `touch-action` class (no box-size
change → no RO re-fire). The three existing triggers stay.

**Deliberately NOT done (scope discipline).** No cold-boot zero-guard (h2) and no
`viewportHeight.ts` boot-read hardening (h3 — the observer subsumes it). "Add X
means add X"; lightweight over heavyweight.

_Deploy: cic-only (`--cic`)._

---

### 2026-07-17 — #285 REOPEN (P0, cic): the ResizeObserver was necessary but not sufficient — FAIL-OPEN the scroll gate + harden the boot viewport read

**Reopened.** The RO fix shipped and the P0 STILL reproduced on-device on a full
PWA **kill + relaunch** (not just a reload) — scroll locked, mainly in tabs with
no unread-messages marker.

**Refined root cause.** A `ResizeObserver` fires only on a container **box
change**. On a cold relaunch the boot read latches an INFLATED `--viewport-height`
(pre-settle), the container BAKES to it, and — because
`installViewportHeightTracker` re-reads `visualViewport.height` only on a `resize`
event, which the silent settle never fires — **no box change ever occurs**. RO
never fires → `measureOverflow` never re-runs → the default-deny gate stays `none`
forever. The prior entry's assumption ("the observer subsumes the boot race") does
not hold when the boot race produces a permanently-frozen container with no event
to derive from.

**Why "tabs without an unread marker" is the tell.** The gate compares
`scrollHeight` to the inflated `clientHeight`. The unread-marker element adds
`scrollHeight`; tabs with it clear the inflated threshold, tabs without sit just
under it → gate stays closed. Same root cause, content-height-dependent
manifestation.

**The core defect: the gate FAILED CLOSED.** One wrong pre-settle read produced a
permanently dead scroll, and the only correction path depended on an event the
scenario never emits.

**Fix — layered, in vjt's blessed order.**
1. **Fail open (primary — kills the whole bug class).** Invert the gate: base
   `.scrollback { touch-action: pan-y }`; `.scrollback-locked { touch-action:
   none }` locks ONLY when the pure seam `shouldLockScrollGate({scrollHeight,
   clientHeight})` proves the content fits a **trustworthy** clientHeight (`> 0`;
   a 0/negative/NaN read NEVER locks). Default = pannable from the first frame. A
   false-positive pannable pane is harmless (worst case iOS reveals chrome); the
   P0 is the false-negative dead scroll.
2. **Harden the boot read.** `installViewportHeightTracker` RE-READS
   `visualViewport.height` on a post-boot timer schedule (`[100, 400, 900]` ms),
   event-independently, so the settled height overwrites the inflated boot value
   even with no `resize` — un-baking the container (→ RO fires → gate recomputes).
   Each re-read reads the LIVE `vv.height`, so overlapping a genuine keyboard
   resize never writes a stale clobber.
3. **Defensive post-mount settle re-measure.** `onMount` schedules
   `measureOverflow()` on `[150, 500]` ms timers (cleared in `onCleanup`) —
   belt-and-suspenders for the no-box-change settle.

**Why a local inflation heuristic can't be the fix.** The gate cannot detect a
*relative* inflation from one measurement: `.scrollback` is ALWAYS shorter than
the document, so comparing to `documentElement.clientHeight` never flags it.
Inflation is corrected at the SOURCE (2) and on SETTLE (3); the gate stays simple
and fails open (1).

**Apply.** A binary UI gate whose WRONG value is catastrophic (dead scroll) and
whose RIGHT-but-idle value is harmless MUST fail open: default to the harmless
state, switch to the strict state only on a measurement you can TRUST. Never gate
a critical affordance on a single early/derived read whose only self-correction
depends on an event the failure scenario suppresses.

_Deploy: cic-only (`--cic`)._

---

### 2026-07-17 — #280 (P1, cic): "next" + scroll-to-bottom buttons coexist via a shared, container-anchored float stack

Follow-up to #264/#278. Keyboard open, the "next" circle overlapped the
scroll-to-bottom button; the two were different sizes; "next" jumped on keyboard
show/hide.

**Root cause — two independent anchors, two reference frames.** scroll-to-bottom:
inside `ScrollbackPane`, `position: absolute` to `.scrollback-pane`, 2rem square.
next-active (mobile): mounted in `Shell`, `position: fixed` to the visual viewport
with the discrete `--nab-lift: 8rem` focus bump (#264/#278). Keyboard-open, the
lift shoved the viewport-fixed circle into scroll-to-bottom's band on the shared
right edge. No shared floating layer; the keyboard shift of one anchor collided it
with the other.

**Fix — one container-anchored float stack, owned by ScrollbackPane.** The
alternative (coordinate the two components' bottom offsets off a shared CSS var)
CANNOT satisfy item-1 ("position CONSTANT relative to the message container, no
jump on keyboard"): viewport-anchoring fundamentally needs a keyboard lift to
clear the compose box, and any lift IS the jump. Only container-anchoring delivers
constancy. `ScrollbackPane` already owns the scroll container → it owns
`.scrollback-float-stack` (`position: absolute` in `.scrollback-pane`,
flex-column, right-aligned, gap). Both buttons render into it same-size, "next"
ABOVE scroll-to-bottom. The stack rides above the compose box + soft keyboard, so
both positions are constant regardless of keyboard state; the `:has(textarea:focus)`
lift is neutralized inside the stack via `.scrollback-float-stack
.next-active-btn-mobile { position: static }` (the lift only affects `top`, inert
under static) — no new variant, and the viewport-fixed placement survives for the
non-scrollback path.

- **One component, N placements.** `NextActiveButton`: desktop → sidebar; mobile
  scrollback windows → the pane's float stack; mobile NON-scrollback windows
  (home/mentions/list/admin — no pane, no collision) → Shell's viewport-fixed
  mount, gated `!kindHasScrollback(selKind())` so exactly one mobile instance ever
  mounts.
- **Size parity.** scroll-to-bottom bumped to the 3.5rem/48px box on mobile only
  (`.shell-mobile` scope); desktop keeps 2rem.
- **Badge color derives from the EXISTING tier — #267 deferred.**
  `activeWindows.nextActiveKind()` classifies the ordered-list head via the SHARED
  `isPriorityWindow` predicate (extracted from `orderUnreadWindows` so the two
  can't diverge): RED for query/mention (tier 0), BLUE for an ordinary channel
  (tier 1). The issue's server-side-counter note is #267's domain — the COLOR only
  needs the target's KIND, derivable client-side.

**Apply:** two floating affordances over the same edge belong in ONE
container-anchored stack owned by the scroll authority — never two
independently-anchored boxes off different reference frames (the keyboard shift of
one WILL collide the other). A badge color that maps to an existing tier derives
from the tier's single source of truth (shared predicate) — no parallel counter.

_Deploy: cic-only (`--cic`)._

## 2026-07-17 — #284 (P1, cic): password field always-visible + optional on the main login form (drop the password-behind-Advanced gating)

Login hid the password inside the collapsed Advanced disclosure (a hangover from
the abandoned "two-step" login design that would have probed for a pre-existing
credential first). #284 cancels the gating: password moves onto the main form,
always visible, labelled `Password (optional)`. Advanced keeps only ident +
realname (#152).

**Why the gating was pointless (verified in server code, no change needed).** The
worry — "don't ask for a password we'd waste" — is false: grappa already fires an
entered password to NickServ as IDENTIFY on first connect even with no
pre-existing credential (`visitors/login.ex` threads it through the fresh-visitor
path; `session_plan.ex` `with_login_identify/2` rewrites a fresh anon plan to
`auth_method: :nickserv_identify`; `auth_fsm.ex` sends `PRIVMSG NickServ :IDENTIFY
<pw>` at 001; `session/server.ex` persists via `Visitors.commit_password/3` on
`+r` MODE). Empty password → anonymous login (`auth.ts` omits the key when blank);
non-empty → IDENTIFY at 001. Both paths pre-existed; #284 is purely the form
layout catching up.

**Apply:** when a conditional UI gate exists "to avoid wasting user input," verify
the downstream actually wastes it before keeping the gate. An always-visible
optional field beats a two-step probe that guards nothing. The identify decision
stays server-side (empty vs non-empty at `/auth/login`).

_Deploy: cic-only (`--cic`)._

---

### 2026-07-17 — themes subsystem (#75, SERVER sub-task)

Server-owned, security-hardened theme gallery: users author colour/font/background
schemes, publish, copy others', pin one active (cross-device). This is the SERVER
subsystem; the cic UI + #291 are later sub-tasks, so #75 stays `cooking` until the
whole feature lands.

**Closed token vocabulary IS the sanitizer.** A theme drives CSS, and CSS is code
(exfil via `url()`/`@import`, fake-UI overlays); a published theme renders in every
viewer's browser, so an unsafe theme is stored-XSS-via-CSS. Defence is
safe-by-construction: the only thing that crosses the wire and lands in the DB is
`Grappa.Themes.TokenModel`'s closed vocabulary — 27 strict `#rrggbb` colours, one
allowlisted font-family, a background `{image_id, opacity}`. `sanitize/1` drops
everything else at the `Theme` changeset boundary, so the DB can never hold
attacker-controlled CSS. cic generates scoped CSS from the sanitized map; it NEVER
consumes raw `.theme`/CSS. Font *size* is deliberately NOT a token (fork-3) — a
per-client setting, avoiding two sources of truth.

**KISS data model — every theme is an independent full copy.** No copy-on-write,
no shared storage, no refcount gating lifecycle, no delete-in-use guard. Copy
inserts a fresh owned row from the source's payload; deleting a copy can never
affect anyone else. All themes are public by id (share-link target); `published`
only controls gallery listing.

**`apply_count` is analytics, not a refcount.** `copy_theme/2` bumps the source's
count in the same transaction — a popularity metric sorting the gallery. It gates
nothing (copies carry no back-reference); never blocks a lifecycle op.

**Authz in the context (owner-or-admin), one code path every door.**
`Themes.{update,delete,publish,unpublish}_theme` take the rich subject and route
through one `authorize/2`: admin any, owner own, else forbidden. Built-ins are
read-only by CONSTRUCTION, not a special case — owned by the reserved `"system"`
user (idempotent data migration); no non-admin can be that owner, so the generic
check refuses them. Create/copy rate-limited ~5/day/subject via
`Grappa.RateLimit.DailyQuota` (ETS per-(bucket, subject, day) counter), checked
BEFORE the insert so a malformed request never burns a slot.

**Active theme = server-persisted per-subject pointer (fork-1: vjt chose
cross-device over localStorage).** `UserSettings.active_theme_id`;
`get_active_theme/1` fails SOFT to nil on a dangling id (cic falls back to
default); `set_active_theme/2` persists only once the target is confirmed
readable. `GET /me/theme` returns the fully-resolved wire (or JSON null), not a
scalar id.

**Built-ins are curated, not parsed (fork-2).** `Grappa.Themes.Builtins` = ~12
hand-authored token maps; NO irssi `.theme`-corpus parse in v1 (separate
follow-up). Each payload is canonical (`sanitize/1` is the identity, pinned by
test). `mix grappa.seed_themes` upserts them system-owned + published via the
`(owner_id, name)` unique index — idempotent, safe on every cold deploy.

**Background-image pipeline — raster in, canonical PNG re-hosted.** Threats: a
polyglot file (valid image AND script) and SSRF via fetch-by-URL. Defences in
order: (1) source is a `Plug.Upload` or a URL through `Grappa.Themes.ImageFetcher`
— SSRF-guarded (`Grappa.Net.Ssrf.resolve_safe/1` is rebind-safe: resolve →
range-check → connect to the RESOLVED ip; block the whole host if ANY address is
private/loopback/link-local/metadata/ULA/v4-mapped), size-capped, no redirects;
(2) decode + re-encode via ffmpeg (`-frames:v 1`, PNG) under the shared
`Grappa.Sys.HardenedCmd` (wall-clock `timeout -s KILL`, scrubbed env) — a fresh
flat PNG drops any polyglot bytes; (3) re-host via `Grappa.Uploads.create/3` with
forced `image/png` and NO expiry (`expires_at` NULL → the Reaper never sweeps
theme backgrounds). Served `Content-Type: image/png` + `nosniff`. No SVG
(scriptable). `HardenedCmd` was extracted from `Uploads.MetadataStrip` so both
external-tool sites share one hardening.

**Wire discipline + a codegen fix.** `Themes.Wire.to_wire/2` is the single source
of the wire shape (derives viewer-relative `mine` + `built_in` from the preloaded
owner; no raw `%Theme{}` crosses the wire). The viewer subject is inlined into the
`@spec`, NOT exposed as a public `@type` — otherwise `grappa.gen_wire_types` would
emit a TS type dragging the full `User`/`Visitor` structs (password_hash
included!) into the client. The wire's `payload: map()` was the first bare-`map()`
Wire field and exposed a latent codegen bug (strip phase crashed on `:any` args) —
fixed to emit `Record<string, unknown>`.

**Apply:** producer-authored styling/config rendered in other users' browsers = a
closed, server-side-sanitized token vocabulary — never raw CSS/HTML on the wire,
never client-side sanitization as primary defence. Reuse the verbs
(authz-in-context, rate-limit, `HardenedCmd`, `Uploads`, `UserSettings`, `*.Wire`).
A popularity metric is not a refcount. A fetch-by-URL always needs a rebind-safe
SSRF guard on the RESOLVED ip.

_Deploy: batched, NOT yet shipped — REST surface dormant until the cic UI + #291
land. `mix grappa.seed_themes` must run on the target at ship._

### 2026-07-17 — themes CONSUMER UI + #291 mobile home button (#75, cic sub-task)

The consumer path only (browse built-ins → apply → persists cross-device); the
producer path (editor, fonts, background upload UI) deferred.

**One footer, two buttons (#75 + #291 batched).** Both add a launcher to the
mobile drawer footer, so they ship together. `mobilePanel.ts` gains `openHomePanel`
(🏠) and `openThemesPanel` (🎨). Footer launchers enlarge to ≥44px via a scoped
rule — the base `.shell-chrome-btn` (shared with the top bar) untouched.

**Deep-link into a settings sub-page.** `settingsNav.ts` is a one-shot channel:
`requestSettingsPage("themes")` → the drawer's open-transition effect consumes it
(falls back to "main"). No parallel client state — the drawer's own `settingsPage`
signal is the single target.

**Apply engine = inline CSS custom properties over the base cascade.**
`customTheme.ts` maps the token payload to `--bg`/`--nick-color-N`/… on
`document.documentElement.style`, cascading OVER the `:root[data-theme]` blocks
with no rebuild and no FOUC (boot applies the localStorage-cached payload
synchronously). Active theme stays SERVER-owned: `mountCustomThemeSync` re-fetches
`GET /me/theme` on every `token()` change; `activateTheme` writes `PUT /me/theme`
then applies the AUTHORITATIVE payload the server returns (not the optimistic
client copy); logout clears to base. localStorage is a pure offline FOUC mirror —
the e2e clears it before reload to prove the round-trip goes through the server.

**Gallery preview = derived swatch, not a screenshot** (matches the server's
no-screenshot-column decision): palette chips from the payload. Manage ops gate on
owner|admin (`canManageTheme`); everyone browses + copies + applies. The gallery
renders inside the already-locked drawer — no extra `createOverlayLock`.

**Deferred (flagged, not silent):** the background-image VISUAL layer. The engine
SETS `--theme-bg-image`/`--theme-bg-opacity` but compositing ships with the upload
UI; no built-in carries an image, so the vars are dormant.

_Deploy: batched/HELD — partial feature; #75 + #291 stay `cooking`. Full ship =
SERVER COLD (themes table + system-user migration) + `--cic` + `mix
grappa.seed_themes`._

### 2026-07-17 — themes PRODUCER UI: editor + fonts + background (#75, cic sub-task)

Completes the client half of #75 (create/edit → publish/share, curated font,
uploadable background). No server work — drives the existing REST verbs.

**Editor = covering overlay with LIVE preview + snapshot/restore.**
`ThemeEditor.tsx` edits a draft `TokenPayload` and re-applies on every change via
`applyCustomTheme` — the "changes visible LIVE" requirement, CLIENT-only (cic
never originates the server active theme). On open it snapshots the applied
payload; Save persists → `activateTheme` (server round-trip → authoritative
re-apply); Cancel/ESC/backdrop restore the snapshot so an abandoned edit leaks no
draft. Snapshot source is `customTheme.getAppliedThemePayload()` — the localStorage
FOUC mirror, which live preview deliberately never writes, so mid-edit it still
holds the pre-edit theme. The overlay rides the shared `createOverlayLock`
refcount (a new pane-covering modal MUST, or it yanks iOS scroll).

**No hand-copied palette constant (orchestrator directive).** "New theme" seeds
from the built-in the gallery already fetched (`newThemeSeedPayload` prefers
`irssi-dark`; null → entry disables itself) — two copies of the 27-key palette
would drift. `getAppliedThemePayload` is strictly the snapshot source, not the
seed.

**Self-hosted curated fonts (fork 3).** A RUNTIME CDN/Google-Fonts fetch is banned
(per-render beacon / IP leak, same class as a remote `url()`) — woff2 are
vendored, not linked: `scripts/vendor-fonts.sh` copies latin 400+700 woff2 from
npm devdeps into `public/fonts/<family>/` (committed, same-origin); `@font-face` in
`default.css` binds each slug (= what `customTheme` writes into `--font-mono`).
Sourcing all-npm (@fontsource + official `hack-font`). **iosevka intentionally
skipped** (vjt: latin subset ~1.9MB, too heavy) — stays in the picker, resolves to
the fallback mono stack. Total vendored 264KB; standard latin `unicode-range` so
non-latin glyphs fall through instead of tofu.

**Background = a scoped wallpaper layer, gated on a class.** `applyCustomTheme`
toggles `theme-has-bg` (CSS can't branch on a var being `"none"`); `default.css`
paints `--theme-bg-image` at `--theme-bg-opacity` on `.scrollback-pane::before`
(`isolation` makes the pane a stacking context so the layer sits below the
transparent scrollback text). Confined to the reading pane — sidebar/chrome/
ComposeBox stay opaque for legibility. Still **never an `<img>`** (text-only
scrollback) — CSS `background-image` only.

_Deploy: batched/HELD. SERVER COLD (themes table + system-user migration) + `--cic`
+ `mix grappa.seed_themes`._

### 2026-07-17 — sux.theme built-in: the actual final #75 piece (hard req)

The producer addendum's "#75 user-done" was superseded within the hour: vjt made
alk's irssi **`sux.theme`** a hard requirement for v1 — #75 is NOT complete until
it ships in the built-in gallery.

**Extract the colours, defer the layout.** An irssi `.theme` is mostly
format-string/row-layout templates (that surface is #293, out of v1), but its
colour choices are extractable. sux is green-on-black: black bg, white text/nicks,
bright-green accent, grey delimiters, yellow highlight-for-me, red errors — mapped
onto the base tokens. sux does NOT colour op/halfop/voice or define a nick palette,
so those tokens are COMPOSED from its own palette (op=red, halfop=amber,
voice=green, plain=white; nicks = the proven dark-bg set) — flagged, not
fabricated.

**No new conversion machinery.** The 12 built-ins are hand-authored canonical token
maps; the issue's fork-2 "conversion script" was aspirational for a future bulk
import (#293). Rather than a one-off irssi parser contradicting the shipped
pattern, `sux` is a 13th hand-authored entry, colours extracted offline +
human-reviewed — pinned canonical by the sanitize-identity check.

_Deploy unchanged: batched/HELD, SERVER COLD + `--cic` + `mix grappa.seed_themes`
(the seed step publishes `sux`). With `sux` seeded, #75 + #291 move `cooking →
soon`._

## 2026-07-18 — #289 (enhancement, cic): mobile floating buttons translucent so message text shows through

Fast-follow to #280: the two mobile floating buttons (next-active circle +
scroll-to-bottom) coexisted cleanly but were fully opaque — any line wrapping
behind a button was unreadable.

**Fix — one rule on the stack's children:** `.shell-mobile
.scrollback-float-stack > * { opacity: 0.75; }`

**Why whole-element `opacity`, not a per-color alpha.** `color-mix`/rgba per
`background` would need a translucent variant baked per theme (13 built-ins +
user-authored) — a new token surface — and would leave glyph/border/shadow opaque.
Whole-element opacity is theme-agnostic (translucency is an interaction constant,
NOT a color — it does NOT belong in the per-theme token maps) and fades the control
uniformly. 0.75 = text legible behind, control still clearly tappable.

**Why ONE rule on `> *`, not two per-button rules.** Both are direct children of
the float stack: one rule keeps the pair consistent BY CONSTRUCTION and any future
stack child inherits the default. Scoped to `.shell-mobile` + the stack — desktop
stays opaque. Specificity (0,3,0) beats `.scroll-to-bottom-btn:hover` (0,2,0) so a
stray mobile hover can't exceed the base.

_Deploy: cic-only (`--cic`). HELD for the batched COLD ship._

## 2026-07-18 — #294 (P0, cic): built-in background picker (v1 — 8 cover backgrounds)

Follow-up to #75: curated system-owned, read-only background images in the theme
editor alongside the custom-upload path. v1 = 8 full-bleed `cover` backgrounds (4
dark / 4 light, 1920w WebP, ~888KB total); the seamless-tile set is a follow-up.

**Payload shape (the load-bearing decision).** `background` grows from the 2-key
`%{image_id, opacity}` to the canonical 4-key `%{image_id, builtin, size,
opacity}`:
  * `builtin` — a key from the **closed** `Grappa.Themes.BuiltinBackgrounds`
    catalog, or nil. **Mutually exclusive** with `image_id` (`reject_dual_source/2`
    fails a payload setting both). Discriminated shape, NOT an overloaded
    `image_id` — reusing the uploads-slug field would break its `[a-z2-7]{26}`
    invariant and conflate namespaces (the CLAUDE.md "shared data model with a type
    flag = boundary violation" rule).
  * `size` — `"cover"` (v1 default + every upload) or `"repeat"` (reserved, wired
    now so the deferred tile set needs no second wire-contract change).

**Backward-compat is a feature.** `sanitize_background/1` reads `builtin`/`size`
via `Map.get` with defaults (nil / `"cover"`), so a pre-#294 payload (old theme
row, #293 import, old localStorage FOUC cache) sanitizes forward cleanly. cic's
`tokenToCssVars` mirrors the defense. Themes tests still feed 2-key inputs as a
standing forward-compat guard.

**Serving: static assets, NOT `/uploads/`.** Phoenix serves ZERO static files (no
`Plug.Static`) — nginx serves everything from `cicchetto/public/**` (the
`/fonts/**` precedent). The 8 WebP live at `cicchetto/public/backgrounds/` →
`/backgrounds/<key>.webp`, with a long-cache `location /backgrounds/` block in
`infra/snippets/locations-api.conf` (`expires max`). Deliberately NOT `/uploads/`
(Phoenix-served, `max-age=3600`, per-subject DB-registered — wrong ownership
model), and NOT `/assets/` (would collide with the Vite dist mount).

**Catalog is server-owned, cic consumes it.** `GET /themes/backgrounds` (route
declared BEFORE `/themes/:id` so the literal wins) serves `BuiltinBackgrounds.all/0`.
The picker fetches it — cic never hard-codes the closed set (would drift from the
sanitizer's allowlist). `builtin` → URL is a pure convention (`/backgrounds/<key>.webp`)
so `customTheme` resolves it synchronously at boot without a catalog fetch.

**CSS.** The #75 `::before` already painted `cover`; #294 makes it
`var(--theme-bg-size, cover)` / `var(--theme-bg-repeat, no-repeat)` so the tile
mode slots in with no further CSS. `theme-has-bg` engages for an upload OR a
built-in.

_Deploy: COLD (server route + payload-model change) + `--cic`. No migration
(payload is a JSON blob; the sanitizer defaults old rows forward). HELD for the
batched COLD ship._

## 2026-07-18 — #292 (P1, cic): refresh bar shows current vs available version

The refresh banner goes from "New version available" to `current <X> → available
<Y>`. The issue assumed version strings already existed in bundle metadata — **they
did not** (challenge-the-spec): the cic bundle had NO semver anywhere
(`cicchetto/package.json` was a never-wired `0.0.1` placeholder; the only build
identity was the opaque Vite asset hash). The server's `@version` (`mix.exs`,
`Grappa.Version`) is the **bouncer** version — semantically wrong as "the cic
version". So this bucket had to ESTABLISH a cic-bundle version scheme.

**Decision (vjt): Option A + a short hash suffix for trivial changes.** Primary
version = the `cicchetto/package.json` semver, bumped per cic release. But a semver
alone goes dead the moment a rebuild ships without a bump — so the bar appends the
short (7-char) bundle hash whenever the two semvers match or one is missing:
`current 0.1.0 (4f2a9c1) → available 0.1.0 (9c1bd3e)`; a real bump shows clean
semvers. The hash mismatch remains the banner **trigger** (`shouldShowRefreshBanner`
unchanged); the version is display enrichment only.

**Cross-side source: ONE `<meta name="cicchetto-version">` in `index.html`.**
Vite's `transformIndexHtml` bakes the package.json semver into the shell HTML. cic
reads it for the RUNNING version (`bundleHash.readBootBundleVersion`); the server
reads the SAME tag from the **deployed** dist (`Grappa.Cic.Bundle.current_version/0`)
— NOT the source `package.json`, which would be a second source of truth and wrong
in prod (source can lead the deployed dist).

**Wire: the semver rides the existing `bundle_hash` event, optional key.**
`Cic.Wire.bundle_hash/2` gains `version`; nil/empty **omits the key** rather than
shipping null, and cic's `userTopic` narrower normalises absent → null. Codegen
caveat: `gen_wire_types` can't emit optional keys, so the generated
`CicWireBundleHashPayload` shows a required `version: string` — unused; the
consumed type is the hand-written `WireUserEvent` arm in `api.ts`.

**Going forward:** cic releases bump `cicchetto/package.json`; the appended hash
keeps unbumped rebuilds honest.

_Deploy: `--cic` only (bundle + the server-side wire read). HELD — batched into the
next cic bundle ship._

## 2026-07-18 — #299 (post-ship, themes): visitor producers + real usage count + tap-card UI

Follow-ups on the shipped themes gallery (#75/#291), folded into #299 and promoted
to a **COLD** epic because item 8 reshapes a table. Items 1/2/3/6 landed earlier
(owned-in-gallery, admin un-stranding, legacy selector drop, footer launcher
removal); items 8/9/7 below.

### Item 8 — visitors are first-class theme producers (XOR-FK promotion)

v1 let only USERS own themes; vjt's call: visitors are producers too (copy / edit /
publish / keep), same as every subject-scoped resource post-#211 — so `themes`
joins the XOR-FK family.

**Storage.** `20260718120000_xor_fk_themes.exs` — the table-recreate dance (sqlite
can't ALTER nullability or ADD a CHECK), mirroring `xor_fk_user_settings`:
`owner_id` → nullable `user_id`, add `visitor_id` (ON DELETE CASCADE), the
`themes_subject_xor` CHECK, two partial unique indexes replacing the composite.
**Critical deviation from the network_credentials recreate: the INSERT carries `id`
VERBATIM** — theme ids are POINTER TARGETS (`user_settings.data.active_theme_id` +
share-links); fresh AUTOINCREMENT ids would dangle every active-theme pointer.
Writes route through `Subject.put_subject_id` (the XOR-table invariant);
`seed_builtins` upserts via the partial-index `:unsafe_fragment "(user_id, name)
WHERE user_id IS NOT NULL"`.

**Guards.** Daily quota applies to BOTH subjects. A **50-total owned-theme cap for
VISITORS only** (users uncapped) — a pure count checked BEFORE the recording quota
so a capped visitor never burns a daily slot. New `:theme_cap_reached` → 429 with a
distinct wire string (cic renders a cap-specific hint vs the daily "try tomorrow").

**Author model B (vjt-locked).** A visitor-owned theme renders `author: "guest"` —
a fixed label, never a nick (`Themes.Wire.guest_author/0`). Rejected: attributing
the visitor's current nick (impersonation risk + a reaped visitor's nick is
meaningless).

**Author model A (amendment, 2026-07-18 — SUPERSEDES model B).** vjt reversed: a
visitor-published theme is credited to the **visitor's nick, snapshotted at PUBLISH
time and PERSISTED** as `themes.author_nick` (nullable, expand-safe add-column
migration riding the same HELD COLD batch). vjt saw and ACCEPTED the impersonation
caveat. Wire attribution prefers `author_nick` whenever present, regardless of
current owner: `author = author_nick || user.name || "guest"`. That ordering is
load-bearing — the reaping re-home (below) flips a published visitor theme to
`user_id=system`, so a live-owner read would render "system"; the snapshot keeps
crediting the original nick. `built_in` is now a pure ownership predicate (system
user), decoupled from `author` — a re-homed row is `built_in: true` AND
nick-credited. Legacy NULL `author_nick` keeps "guest".

_Spec-vs-code deviation recorded:_ the brief said to read the nick from "the
Visitor row / subject", but #211 phase 7 DROPPED the row's nick — it lives
per-network on `network_credentials`, and `current_subject` carries no nick. The
snapshot derives from `Networks.Credentials.representative_visitor_credential/1`
(the identity-anchor = lowest-`network_id` credential's nick), keyed off the
THEME's `visitor_id`, NOT the caller subject (an admin may publish another
subject's theme). Raw nick, NOT rfc1459-folded — a display LABEL, not a fold-MATCH
site (consistent with the raw-cased members map / `state.nick`). `author_nick` is
written ONLY server-side via `set_published/3`'s `Ecto.Changeset.change/2`, NOT in
the public `cast/3` allowlist — a user-supplied author string would widen the
surface past the accepted "publish under a nick you hold" caveat. Themes gained a
one-way `Grappa.Networks` boundary dep. Follow-up (separate ticket): editable
author label.

**Reaping re-home (the one non-CASCADE dependent).** A reaped visitor's PUBLISHED
themes survive as gallery contributions; private ones die.
`Themes.rehome_visitor_published_to_system/1` moves published rows to the system
user (`user_id=system, visitor_id=NULL`, de-duping names) BEFORE the delete so they
escape the `visitor_id ON DELETE CASCADE`. Wired into the shared
`Visitors.destroy_visitor/1` choke point — BOTH `delete/1` (reap + operator +
AccountDeletion) AND `purge_if_anon/1` (anon co-terminus logout). Re-home runs
SEQUENTIALLY before the delete, NOT inside `Repo.transaction`: its leading SELECT
would start a deferred (read) sqlite txn that upgrades to a write on the DELETE, and
that read→write upgrade throws `SQLITE_BUSY` under concurrent writers (integration
CI hit exactly this). Sequential single-statement writes take the write lock
immediately (busy_timeout waits, never upgrade-fails). Atomicity isn't needed —
re-home is idempotent (`visitor_id = ? AND published`), so a crash between steps
self-heals. `Grappa.Visitors` gained a one-way `Grappa.Themes` boundary dep. A
voluntarily self-deleted USER's themes all CASCADE — voluntary deletion is a full
wipe; only involuntary visitor reaping preserves public contributions. Deliberate
distinction.

### Item 9 — "0 applied" was a lie; show real in-use count

`apply_count` only bumps on COPY, so a widely-ACTIVE theme still read "0 applied".
Added derived `in_use` = subjects with the theme currently active, alongside the
retained `apply_count` (copy popularity + gallery sort). `active_theme_id` is a
JSON key in `user_settings.data`, so the count is a `json_extract` predicate:
`UserSettings.count_active_theme_users/1` (single) + `active_theme_counts/0` (one
grouped pass — the batched list readers use to avoid an N+1). Counts users AND
visitors. `in_use` is a DERIVED wire field passed into `Themes.Wire.to_wire/3` as
an explicit arg — NOT stored on the struct: a virtual field populated post-query
over a list doesn't type cleanly (Dialyzer `missing_range`), and the count is
`UserSettings`' domain (a correlated subquery from Themes would leak the table
across the boundary).

### Item 7 — tap-to-apply cards with progressive disclosure

The card is ONE tap target: tapping applies the theme live AND reveals its action
row (copy + owner/admin edit/publish/delete); only the selected card's actions
render. Structure: a `<button class="theme-card-select">` holds swatch + meta; the
action row is a SIBLING `<Show>`, never nested inside the button (no
nested-interactive elements, no `stopPropagation`). Tap targets are ABSOLUTE 44px
(Apple HIG) on both `.theme-card-select` and `.theme-action` — never rem (html root
font-size is 14px). A fresh copy auto-selects so its owned card is revealed on
reload.

_Deploy: COLD (themes table reshape migration) + `--cic`. HELD — batched into the
next COLD window. `mix grappa.seed_themes` is idempotent and already-run; no
re-seed needed (the migration carries built-in rows forward with their ids)._

## 2026-07-18 — #290 (P1, cic): dedicated services console modal

A bare services command — `/ns`, `/cs`, `/ms`, `/os`, `/hs`, `/rs` — opens a
dedicated services console modal (titled by the service, mirrors that service's
NOTICEs nick-stripped, bottom `>` prompt). A bare `/ns` is treated as `/ns help`,
so the multi-NOTICE help wall lands in the modal instead of flooding the server
window. A full command WITH args (`/ns identify <pass>`) stays the inline `msg`
path — no unsolicited popup for power users. **cic-only**; no server change.
Register-wizard-on-home + per-network profile + quick-action buttons (the #290
refinements) are DEFERRED — this is the raw-console MVP.

- **Bare vs args is a parser split, mirroring `/mode` and `/umode`.**
  `parseServiceShortcut` emits `{kind:"service-modal", service}` when `rest === ""`,
  keeps `{kind:"msg", target, body}` otherwise. compose.ts's arm calls
  `openServiceModal` then fires `help` via the shared `sendBodyLines` (now exported
  — a 4th consumer, not a copy).
- **The notice-mirror is DERIVED from `$server`, not a duplicated buffer.**
  Services NOTICEs already route server-side to `$server` (`Identifier.services_sender?`
  allowlist + EventRouter persist); cic already subscribes, so `ServiceModal`
  derives its body as a reactive memo over `scrollbackByChannel[$server]`, filtered
  `kind === "notice" && nickEquals(sender, service)`. CLAUDE.md "don't duplicate
  state — derive it": zero capture/correlation state, and "mirror not move —
  nothing lost" falls out free (the rows stay in `$server`).
- **"Capture only while open" = a `sinceId` high-water mark.** `serviceModal.ts`
  captures the max `$server` message id at open; the body filters `id > sinceId`.
  Ids are monotonic, so post-open NOTICEs always show, stale ones stay hidden —
  while-open semantics with one integer of state, still derived.
- **Display-only, content untrusted (spec hard rule).** The modal never drives an
  auth action off notice content — the source nick is spoofable on a network
  without nick protection (phishing through the modal); opening only on a user
  command + capturing only while open shrinks the surface.
- **Nick stripped structurally.** Each line renders only `<MircBody>` — no sender
  chip (the service name is in the title).

_Deploy: `--cic` only. HELD — batched into the next COLD window with #299, NOT
shipped solo._

## 2026-07-18 — #282 (P2, cic): explicit vhost Reconnect button

The vhost sub-page (#252) PUTs the source-address selection on every toggle, but
the change is INERT until reconnect — `Grappa.Vhosts.effective_source/2` resolves
the bind per connect. #282 adds a single sticky "Reconnect to apply" footer button.

- **Teardown path — reuse the per-network park→reconnect, NOT the #281 purge.** The
  spec framed this as "the clean path #281 establishes" — a category mismatch:
  #281's purge is the `identityScopedStore` client purge keyed on a TOKEN ROTATION.
  A same-account vhost reconnect never rotates the token, and #281's 404-storm risk
  doesn't arise. The genuinely-clean same-account path is the home-page Reconnect: a
  per-network `PATCH /networks/:slug {connection_state}` bounce.
  `reconnectConnectedNetworks` (`lib/reconnect.ts`, sibling of `quit.ts`)
  park→reconnects every `:connected` network concurrently (`Promise.allSettled`; a
  failed park never reconnects that net; the first failure re-throws so the button
  surfaces it). Only `:connected` nets are bounced — a `:parked`/`:failed` net was
  left down deliberately and picks up the new vhost when the user reconnects it from
  home.
- **Always-available, NOT "disabled until pending" (autopilot D2 — deviation from
  the written spec).** The vhost is account-level with NO server field exposing
  live-bound vs selected address, so pending-detection is only a fragile client
  dirty-flag — and gating a heavyweight, externally-visible action on unreliable
  detection is itself a least-astonishment hazard. Ruling (vjt autopilot
  2026-07-18): always available; the static "Reconnect to apply" label communicates
  intent. No dirty-flag hint in v1.
- **Two-tap confirm arm (`InlineConfirmButton`), NOT single-tap (code review
  2026-07-18).** The button bounces EVERY connected network, so it fires through the
  shared two-tap arm like the drawer's other disruptive actions (`quit`, visitor
  "apply identity") — which also answers the accidental-fire concern. An arm is
  neither a disable nor a pending-detection gate, so the always-available D2
  contract holds. The `armed` flag is LOCAL to `VhostSettingsPage` (unlike the
  drawer-owned `quitArmed`/`identityArmed`): the sub-page unmounts on ‹ back, so the
  arm auto-resets.
- **Explicit only — never implicit on back/close.** ‹ back navigates, fires
  nothing. A single sticky footer instance (a duplicated disruptive action invites
  accidental double-fire).

State + orchestration live in `SettingsDrawer`; `VhostSettingsPage` stays
presentational (props in, `onReconnect` out).

_Deploy: `--cic` only. HELD — batched into the next COLD window with #299/#290, NOT
shipped solo._

---
## 2026-07-18 — TopicBar CSS batch (#304 + #305 + #307, cic-only)

Three top-bar tweaks batched because they touch the same surface
(`TopicBar.tsx` + `.topic-bar-*` / `.shell-chrome-btn` / tokens in
`default.css`); three commits, one per issue. Pure CSS + minor JSX; no
server change.

### #304 — separators (pure CSS)

`border-left` + `padding-left` on `.topic-bar-topic`
(longhand-after-shorthand so it beats the `border: none` / `padding: 0`
reset) + a `border-bottom` under the channel name splitting it from the
`+modes` line; both `var(--border)`. The name is ellipsized, so the underline
spans only the visible clipped width — intentional.

### #305 — chrome-button sizing: shared base + tokens (the DRY ask)

Tiny glyph + sub-floor tap target shared one root cause: sibling chrome
buttons re-declared size per-selector instead of adopting `.shell-chrome-btn`.
Fix (maintainer: "don't patch each selector"): two theme-independent `:root`
tokens — `--chrome-icon-size: 1.4rem` + `--chrome-tap-min: 48px` (HIG floor,
absolute px on purpose: root font-size is 14px, a rem target would
under-size — `feedback_cic_tap_target_rem_pitfall`); the base drives
font-size + min-sizes from them, and hamburger + presence toggle adopt the
base, deleting per-selector sizes. **Cascade gotcha:** `.shell-chrome-btn`'s
`display: inline-flex` is declared LATER than `.topic-bar-hamburger`, so at
equal specificity it would show the hamburger on desktop — the desktop-hide +
mobile un-hide are bumped to `.topic-bar .topic-bar-hamburger` (0,2,0) to
beat the base regardless of source order.

### #307 — topic strip clips with no ellipsis: button → non-button clamp host

`.topic-bar-topic` is a `<button>`; WebKit/Blink wrap a button's children in
an internal box, so the clamped runs are never DIRECT line-box content of the
`-webkit-box` → `-webkit-line-clamp` never engaged → only the #262
`max-height` clipped, no ellipsis. Fix: move the clamp onto a non-button
inner span (`.topic-bar-topic-text`) whose direct children ARE the MircBody
runs; click + a11y stay on the real `<button>` — chosen over
`div[role=button]` to keep native button semantics. The #262 max-height stays
on the span as belt-and-suspenders. e2e witness: engaged clamp →
`scrollHeight ≈ clientHeight` (the `…` is a rendered glyph, not DOM text).

_Deploy: `--cic` only. HELD — #299 COLD batch._

### 2026-07-18 — #302: mobile float-stack buttons — lower opacity + kill sticky-`:hover` latch

- **Opacity 0.75 → 0.5** (#289's 0.75 still too opaque over wrapped text).
  Kept on the ONE stack-child rule so the pair stays consistent by
  construction (#280 "same box") — never split per-button; 0.5 sits above the
  e2e `TAPPABLE_FLOOR` (0.4).
- **Sticky-`:hover` latch:** touch has no real hover, so after a tap the
  `:hover` accent invert latched on release and read as "selected". Press
  feedback moved to `:active`; the `:hover` invert gated behind
  `@media (hover: hover)`. Desktop unchanged.

e2e note: webkit-iphone-15 emulates a hover-less pointer AND `.hover()` still
triggers `:hover` — a real RED→GREEN witness. A `<= 0.6` ceiling was added to
the #289 opacity spec (its `< 1` band alone never witnesses the lowering).

_Deploy: `--cic` only. HELD — #299 COLD batch._

### 2026-07-18 — #301: umode description table — Azzurra semantics + missing letters

`UMODE_DESCRIPTIONS` (`umodeModes.ts`, #229) shipped generic-ircd conventions
for three letters that differ on Azzurra/bahamut. Authority: Azzurra's own
`helpserv umode` helpfile, NOT other ircds. UI copy, cic-only, never on the
wire.

- `+d`: "deaf" → IRCop: receive DEBUG messages; settable true → **false**
- `+g`: "caller ID" → IRCop: receive GLOBOPS; settable true → **false**
- `+S`: "network service" → connected via SSL (stays read-only)

The `settable` flip is the load-bearing correction: IRCop snomask-style
RECEIVE flags, not user filters — shown read-only. Also filled the missing
Azzurra letters (`b c e f F h I j k K m n y z`), all `settable:false`. Shapes
untouched — data edit. Tests key on phrases (`/debug/i` etc.), not exact
strings, so copy stays tunable; #229 e2e extended to the rendered modal.

_Deploy: `--cic` only. HELD — #299 COLD batch._

### 2026-07-18 — #306: default.css audit + SAFE cleanup (dead rules + tap-target token)

Systemic follow-up to #305: entropy audit of `default.css` (7421 lines,
single stylesheet, 3 palettes in-file). Full audit is a comment on #306; only
the SAFE set was applied.

**Removed — 6 dead rules**, each proven to match no element in `src/**`,
`e2e/**`, `index.html`, including runtime class construction:
`.sidebar-unread` + `.bottom-bar-unread` (pre-C7.5 single-badge remnants),
`.sidebar-footer`, `.compose-box-image-ttl`, `.admin-pane-placeholder`,
`.home-pane-directory-link` (superseded by `.home-pane-network-browse`).
Looks-dead-but-live runtime variants (`error-banner-${severity}` etc.) were
checked against their component enums and KEPT.

**Extracted `--tap-min: 44px`** (Apple-HIG floor, 28 hard-coded sites) beside
#305's `--chrome-tap-min`; the theme blocks and the runtime custom-theme
system (closed `THEME_CSS_VARS` colour set) never touch it, so it resolves to
44px in every theme. Absolute px on purpose. Complete atomic adoption — 0
literal 44px remain, no two-pattern drift; the theme-editor swatch square is
a different semantic (fixed size, not a tap floor) and stays.

**Deferred (VETO list on #306):** the ~21-button quartet consolidation
(shifts cascade — wants its own issue, not a behaviour-preserving pass); the
23 baseline `noDescendingSpecificity` warnings (reordering can change which
rule wins — untouched); a float-button opacity token (0.5 conflates
mobile-idle vs `:disabled` semantics).

jsdom is blind to CSS — no unit gate; the net is regression: full
`integration.sh` + theme-gallery smoke in a light and a dark palette
(`--border`/`--accent` contrast varies per theme).

_Deploy: `--cic` only. HELD — #299 COLD batch._

### 2026-07-18 — #318: web push suppressed for a stale-`:visible` iOS PWA (P0)

**Root cause (verified on prod).** A backgrounded/closed iOS PWA kept its WS
open, but iOS does not reliably fire `visibilitychange` on the PWA
background/terminate lifecycle. The pid stayed `:visible` in
`Grappa.WSPresence`; `any_visible?/1` read the user present; `Push.Triggers`'
foreground-suppression gate (#182) skipped the entire push fan-out until the
zombie socket died on its own (~90 min, no user action).

**Fix.** Server (COLD): each pid carries `{visibility, last_visible_at}`
(monotonic ms); `any_visible?/1` counts a pid present iff `:visible` AND
fresher than `stale_ms` (default 60s, injected via `start_link/1` opts).
Read-time derivation — no sweep, no timer state ("derive, don't duplicate");
`Push.Triggers` unchanged — the fix flows through the one existing gate.
Client: `visibilityHeartbeat.ts` re-reports visibility every 30s while
foreground via the existing `reportVisibility` verb; it re-reads live
`document.visibilityState`/`hasFocus()` each call, so the tick catches a
SILENT iOS hide (property flips with no event). Foreground push-suppression
preserved by construction; a backgrounded app goes stale in ~60s instead of
~90 min.

**Scope.** PUSH only. Auto-away keys off the `any_visible?/1` TRANSITION (an
emitted event); a pid aging out emits nothing, so a stale `:visible` does not
trip auto-away — deliberate non-goal, flagged as follow-up.

**★ iOS efficacy caveat (device-verify owed).** Cannot confirm off-device
whether a backgrounded PWA stops sending fresh `visible` reports — the prod
socket survived ~90 min under Phoenix's default 60s WS idle timeout, implying
JS timers kept running backgrounded. If timers run AND `visibilityState`
stays "visible", the fix is a no-op (never worse than today); the
load-bearing hope is the silent-property-flip path, decidable only on a real
device. Shipped as a safe backstop; on-device confirmation owed post-deploy
(vjt / #sniffo).

**Diagnostic — `GET /admin/ws_presence`** ("debugging tools are
infrastructure — build an endpoint, not a throwaway"): exposes
`WSPresence.snapshot/0` (per-pid visibility, `age_ms`, freshness,
`any_visible?`, `stale_ms`) so the device run reads back from the server.
Behind `:admin_authn`; one `infra/snippets/locations-api.conf` edit covers
prod + e2e nginx (shared snippet). Test seam: `mark_stale_for_test/2`
(Mix.env-guarded) backdates a stamp — a deterministic gate without sleeping
the window; the iOS-specific behaviour is deliberately NOT asserted anywhere
(no test encodes the unproven assumption).

_Deploy: **COLD** — WSPresence state-shape change (tracked in
`HotReload.LongLivedModules`) + cic bundle. HELD — #299 batch; the window
MUST include the iPhone efficacy verification via `/admin/ws_presence`._

### 2026-07-18 — #249: drive the cic /umode modal from the server-advertised umode set

**Gap.** `UmodeModal` rendered togglable letters from a STATIC bahamut table
— the umode twin of #216's server-advertised CHANMODES modal. The
supported-umode set lives in 004 RPL_MYINFO param index 3, which the server
deliberately did NOT parse — 004 is on the connect-storm deny list
(`NumericRouter.@active_numerics`), routed to `$server` with params ignored
(the bucket-I ghost-routing fix); `umode_changed` (#229) carries only the
ACTIVE set (221), not availability.

**Fix — mirror the #216 ISUPPORT plumbing.** A new `EventRouter` clause folds
004 param 3 into per-session `supported_umodes` + emits
`supported_umodes_changed` — INSIDE the generic numeric handler, AFTER the
`$server` persist, WITHOUT touching `NumericRouter` (004 still displays;
ghost-routing preserved, guarded by `numeric_router_test`).
`parse_supported_umodes/1` is DISTINCT from `apply_umode_string/2`:
availability advertisement, not a `+/-` delta — same wire shape, different
meaning. `Session.Server` gains a hot-reload-safe `supported_umodes` field
(default `[]`); typed broadcast on `Topic.user/1`; a
`push_supported_umodes_if_live/2` cold-WS-subscribe snapshot closes the
always-on-session race (mirror of `push_umodes_if_live/2`). cic: a
`supportedUmodes` store renders one toggle per ADVERTISED letter, static
table only as fallback for an empty set; an active letter the server omitted
still renders (never hide the operator's own state). #301's descriptions
unchanged — #249 changes WHICH letters, not what they mean.

**REPLACE, not union:** union would reintroduce the static guess and offer
toggles the server may reject. 004 is the ircd's authoritative list;
Azzurra's real 004 carries the full settable set. A partial 004 dropping a
settable letter is an accepted degradation (`/umode +x` by hand still works).

_Deploy: **COLD** — Session.Server state-shape change (tracked in
`HotReload.LongLivedModules`) + cic bundle. HELD — #299 batch._

### 2026-07-18 — #310: persist the read cursor on the scroll-to-bottom BUTTON tap

**Gap.** The scroll-to-bottom button jumped to the newest line, then ~2s
later SNAPPED BACK to the read marker (#233 regression). A MANUAL scroll to
bottom persisted the cursor fine — only the button (and the #243 re-tap, same
helper) broke, so the bug is cic-side, not the #233 server clamp.

**Root cause — two coupled defects** in the pure `scrollToBottom()` helper:
(a) never advanced the cursor — the button is a sibling OUTSIDE
`.scrollback`, so its tap emits no input event on `listRef` and the
input-gated scroll-settle (`setCursorIfAdvances`) never arms → no cursor
POST; (b) never released the `markerActivationPending` latch (only operator
input or an own send cleared it), so the NEXT `rows()` recreation re-asserted
`scrollToActivation("marker-or-tail")` — the ~2s snap-back.

**Fix — one shared `scrollToBottomGesture`** for button + #243 re-tap,
matching a manual scroll: clears `markerActivationPending` AND advances the
cursor via the EXISTING forward-only `setCursorIfAdvances` POST. The newest
id is read AFTER the instant scroll — `scrollToBottom()` pins the tail
synchronously, so `lastFullyVisibleRowId` returns the TRUE DOM tail, not a
stale pre-scroll id the #233 monotonic clamp would drop. No second cursor
authority. The gesture deliberately does NOT touch `setMarkerCursorId` — the
frozen divider stays, re-latching only on next focus acquisition or own send
(freeze contract). The #243 re-tap advancing regresses nothing (its spec
asserts geometry only; #200/#125 no-steal untouched); its moduledoc's "no
server round-trip" claim was corrected. Playwright pins both halves: the
cursor advances to the tail, AND a peer PRIVMSG after the tap does not snap
the view back.

_Deploy: cic-bundle only (hot-eligible). HELD — ships in the #299 window._

### 2026-07-19 — #324: media-modal same-host gate rejects deployment hostname aliases (P0)

**Gap.** `mediaLink.ts` gated upload links on SINGLE host equality with the
page origin. A deployment answering on several aliases (`irc.sindro.me` +
`irc.sniffo.org`, one instance + shared `/uploads`) mints URLs under one
alias while a session loads from another → cross-host → `null` → plain
anchor; on the iOS standalone PWA (manifest has no `scope`) that navigates IN
PLACE: raw media document, no chrome.

**Fix.** Admit host ∈ (page origin ∪ server-provided alias set); re-root the
href onto the PAGE origin as before, so the modal `<img>` stays SAME-ORIGIN
and CSP `img-src 'self'` is untouched. A genuinely third-party host
(litterbox) stays `null` — NEVER re-root a foreign host onto the page origin
(404 / wrong file). `sameHostHref()` (the non-media 📄 escape path) widens
with the same set.

**Challenge-the-spec: server-settings, NOT per-network ISUPPORT.** A hostname
alias is a DEPLOYMENT-GLOBAL HTTP property; `Session.ISupport` is
per-(subject, network) — wrong altitude. The alias set rides the existing
server-settings payload (`ServerSettings.public_view/0` → Wire →
`GET /api/server-settings` + WS snapshot); cic threads
`serverSettings().httpHostAliases` into the PURE classifier (mediaLink.ts
stays store-free + table-testable). No new endpoint, no nginx route.

**Single source of truth — derived.** Aliases derive at boot from the SAME
env that builds `check_origin` — `PHX_HOST` + `EXTRA_CHECK_ORIGINS`
(`config/runtime.exs`) — stashed in `:persistent_term` by the new
`Grappa.HttpHosts` (boot-read in `Application.start/2`, the CLAUDE.md boot
boundary). Adding a vhost = one env edit — no cic redeploy, no
hand-maintained duplicate; cic bakes NO host list; empty set → page origin
only (pre-#324 behaviour). NOT `Grappa.Vhosts` (#228) — per-network IRC
source-bind, a different axis. Wire: `http_host_aliases: [String.t()]` on
changed_payload + public_view + REST (codegen, drift-gated); cic narrower
tolerates malformed/absent → `[]` (#292 posture). e2e proves a synthetic
`EXTRA_CHECK_ORIGINS` alias re-roots under the prod CSP (`_cspGuard`) and a
third-party host stays a plain anchor.

_Deploy: **COLD** — boot-derived set (env re-read + `:persistent_term`); a
hot module reload re-runs neither. server + cic. HELD — #299 batch._

### 2026-07-19 — #266: per-network source_address — admin-configurable, absolute precedence (Libera go-live)

**Re-scope.** The original direction — drop `network_servers.source_address`,
bind wildcard — was **annulled** by vjt (2026-07-17 body re-scope; the
2026-07-16 "remove the column" comment is dead context). New goal: keep a
per-network outbound source, admin set/clear, **absolute precedence**. On
Libera a user-driven rotating vhost reads as a ban-evasion tool; an
admin-pinned, accountable, single egress per network is the honest posture.

**Altitude (A) — elevate the EXISTING per-server column**, not (B) a new
network-level `networks.source_address` overriding it. A network's server
rows ARE its endpoints; Azzurra/Libera run RR-DNS (one server row, #271
rotates the leaves), so one network = one server row = one source in the
common case — zero schema churn. (B) is a SECOND source column with a
precedence between the two — the "parallel structure that drifts"
anti-pattern. Multi-server networks can pin per-endpoint egress under (A).
**No migration** (deviation from the plan's "migration expected") — so the
server change is PURE code, HOT-reloadable on its own; HELD only because it
ships with a cic bundle.

**Precedence inversion (REVERSES the #251 nuance).**
`Vhosts.effective_source/2` is the single resolution point (SessionPlan →
Session → `IRC.Client.source_bind/2`). Pre-#266 a subject's vhost
self-selection OVERRODE `server_source`; now a set `server_source` WINS
(returned verbatim) over the vhost selection, the `OutboundV6Pool` rotation,
AND #271 RR-DNS leaf distribution; `nil` → existing fallback unchanged.
Moduledoc + call-site comments rewritten (a stale invariant comment is a
bug). Acceptance: ExUnit precedence table asserting WHICH address binds, not
call sequences. #271 interplay proven, not rebuilt: a pinned source
constrains the destination-leaf family and threads the SAME `ifaddr` through
every rotated leaf — pinned by a new cross-rotation `client_test`.

**Local-bindable validation — admin REST boundary, NOT the changeset.**
Reused `Grappa.Net.HostAddresses.list/0` (the infra already provides it);
pure `local_bindable?/2` takes the universe IN — interface enumeration is IO
that doesn't belong in the pure `Server.changeset/2`. `ServersController`
gate: non-literal → changeset `validation_failed` (literal-SHAPE stays the
first gate); valid literal not on the host → `{:error, :source_not_local}` →
422 (distinct wire token); nil/clear always valid; threat test first. The
mix-task path (`grappa.add_server --source`) stays UNGATED —
operator-on-host is trusted. Pool subtraction preserved for free:
`ServersController` already resyncs
`Vhosts.resync_pool(Servers.list_source_addresses/0)` on every write, so a
whitelisted `source_address` automatically feeds it.

**Admin surface.** `Servers.AdminWire` emits `source_address` (hand-declared
— `admin_wire.ex` is outside the `gen_wire_types` glob). cic Networks tab:
source input on the add form + per-row inline editor (clear via
`source_address: null`); the non-local 422 surfaces in the shared banner — no
client-side IP validation (the bindable set is server-only knowledge). e2e
drives non-local rejection through both forms (192.0.2.1 / TEST-NET-1); the
local-address success round-trip is ExUnit-only (a guaranteed local address
isn't discoverable browser-side).

_Deploy: server-side HOT-reloadable on its own, but ships with a cic bundle —
HELD to ride the #299 COLD batch. Merge to main + push + HOLD._

### 2026-07-19 — #202: drop the WS query-string token fallback (subprotocol-only)

Follow-up to #95 (`a00aed3`), which moved the WS bearer onto the
`Sec-WebSocket-Protocol` subprotocol but retained the legacy
`params["token"]` fallback in `UserSocket.connect/3` for one deploy cycle
(stale bundle mid-cold-deploy). #202 removes it: the subprotocol is the SOLE
bearer source.

**Gate.** #95's method-tagged telemetry/Logger line existed precisely for
this: vjt read the prod log — **0 `auth_method=query_string` / 26
subprotocol**, INCLUDING the post-cold-deploy reconnect wave (the
long-lived-PWA risk #95 hedged). Clean signal → safe to remove without a
#193-class stuck-on-splash.

**Server.** `extract_token/1` reads only `connect_info.auth_token`; the
`method` element is dead (only `:subprotocol` survived — carried no
information); the "any failure → `:error`, no enumeration leak" posture
unchanged. Telemetry: `[:grappa, :ws, :connect]` has no production handler,
but a connect-churn counter is a cheap ops/Phase-5-exporter signal — kept as
bare `%{count: 1}` with EMPTY metadata (the tag, not the event, is removed).
The unrelated IRC-credential `auth_method` field untouched.

**nginx.** The `/socket` `access_log off;` existed solely to keep the
pre-#95 `?token=` out of logs; with the token off the URL it is removed — the
default access log aids connect-churn debugging. The block lives in the
SHARED snippet (`infra/snippets/locations-api.conf`) included by BOTH prod
and e2e nginx — one edit covers every server block.

**Sweep (total consistency).** `config.exs` dropped the dead `:auth_method`
Logger-metadata key (`"token"`/`"password"` stay filtered as
defense-in-depth); `nginx-tls-frontend.example.conf` re-enabled its `/socket`
log (a third block the snippet didn't cover); stale `?token=` comments in
`auth.ts`/`socket.ts` corrected. Tests: RED-first "valid bearer in the query
string now returns `:error`"; the telemetry assert pins `metadata == %{}`
(catches a re-added tag); the #95 e2e's "fallback still connects" test was
INVERTED to assert rejection.

_Deploy: **COLD** — the nginx reload is the binding constraint (+ cic hash
bump). HELD — #299 batch._

---

## #267 — server-authoritative per-window mention count (2026-07-19)

**Reframed.** #280 had already fixed the overflow-red aggregate and
message/event counts were cursor-derived. What remained: the MENTION count
was a pure client bump (per-tab live regex), so it (a) never rebuilt on
reconnect — a mention landing while disconnected was lost forever — and (b)
diverged across tabs/devices. Real scope: make the mention count
server-authoritative; leave everything else alone.

**Server — derive, don't duplicate.** `Grappa.WindowCounts.snapshot/6`
computes `%{messages, mentions, events, severity}` PURELY from
`(read_cursor, messages)` — no persisted counter, no per-channel
Session.Server state. `mentions` = unread content rows matching the SSOT
predicate `Grappa.Mentions.mentioned?/3` (own_nick ∪ highlight patterns,
word-boundary, case-insensitive), own-sent excluded, sender folded through
the rfc1459 nick SSOT (#121), bounded by a `@mention_scan_cap` tail scan
(SQLite has no REGEXP). Reconstructs identically on every (re)subscribe.
Seeded into `/me` (`unread_counts`) + the per-channel join reply
(`window_counts`), pushed live on new message + cursor advance as a typed
`window_counts` event.

**Three blessed deviations (vjt).**
1. Only the mention count moved server-side. message/event counts STAY
   client-derived — cic applies the presence-filter (#239); a
   server-authoritative event count would be a non-clearable badge. So
   `severity` is re-derived cic-side as a projection (server mentions >
   client messages > client events > none), NOT read from the server field.
2. Door #4 (per-row `mention:bool` on the message Wire) DEFERRED — the
   cosmetic `.scrollback-mention` row highlight stays a client render
   decision; `mentionMatch.ts` now drives ONLY the live alert (beep +
   optimistic title badge), not a count.
3. Covering index `messages(...,id)` DEFERRED (measure-first).

**Behaviour seam.** `Session → ReadCursor → Networks → Session` is a real
Boundary cycle; `WindowCounts.PushSource` (behaviour) + a `Pusher` impl break
it — the BadgeSource precedent. Persist-arm fires from Session.Server;
cursor-advance fanout from ReadCursorController.

**cic focus-zero overlay.** `mentions.ts` is server-fed (`setServerMention` —
one setter, three doors). `mentionCounts()` overlays a focus-zero on the raw
server value: the selected+visible window renders 0 — a PURE projection
replacing the pre-#267 imperative clear in `selection.ts` (that clear is
GONE). A selected-but-backgrounded tab keeps its count. The overlay does NOT
advance the cursor — the server re-pushes 0 on the next cursor-advance
settle. cic NEVER originates the count.

**DM edge (documented, accepted).** An inbound peer-DM persists at
`channel = own_nick`; its live push goes to the own-nick topic (self-msg
narrowed → ~0), so the peer window's mention count re-seeds on
cursor-advance/resubscribe rather than live. Rare and self-healing.

**e2e infra footnote — solanum nofile.** On a fresh `docker.io 26.1.5`
aarch64 box, `solanum-test2` segfaulted at boot (`librb Out of Memory`, exit
139): librb sizes a per-fd table to `RLIMIT_NOFILE`, and modern docker
daemons pass the host systemd `LimitNOFILE` (~1e9) into containers (older
docker-ce defaulted 1024:524288 — why the canonical worker + CI never hit
it). Fixed by capping `ulimits.nofile` to 4096 on the service. Separate
latent gap: `e2e_force_rm` on a passwordless-sudo host removes the runtime
bind-mount, which docker recreates root-owned, breaking the UID-1000 seeder —
worked around by pre-creating the dir vjt-owned; worth a script-side
`mkdir -p` fix.

_Deploy: **COLD** (cic bundle rebuild). HELD — merge + push; vjt deploys
later._

---

## #336 — a saturated DB pool must degrade scrollback, never disconnect the user (2026-07-19)

**Incident.** ~17 live sessions disconnected in the same second: the SQLite
pool saturated ~1s under a write burst and dropped queued checkouts
(`:queue_timeout`). `Repo.insert/2` does NOT return `{:error, _}` on a
checkout failure — it **raises** `DBConnection.ConnectionError`.
`Scrollback.persist_event/1` matched only `{:ok, _}`/`{:error, _}`, so the
raise escaped → `Session.Server`'s `:persist` arm → session crashed → client
disconnected. Invariant: **scrollback persistence is best-effort durability —
degrade (retry / defer / drop), never take down session liveness.**

**Crash class, not crash instance.** Three reachable escape sites; two
consumed the error as `{:error, changeset} -> changeset.errors`, which would
ALSO crash the instant a typed atom appeared. Fix in two layers:

1. **`persist_event/1` no longer raises.** Insert + wire-shape preload run
   through `Scrollback.with_pool_retry/1`: catches
   `DBConnection.ConnectionError`, retries bounded (3 × short linear
   backoff), then logs honestly and degrades to the typed
   `{:error, :persist_unavailable}`. Closed set:
   `Scrollback.persist_error() :: Ecto.Changeset.t() | :persist_unavailable`.
   (Insert-ok-but-preload-fail: the row is durable and surfaces on the next
   fetch; only the live broadcast is lost.)
2. **Every `:persist` consumer is total over that set** via a shared
   `Session.Server.log_persist_failure/2` (changeset = validation, atom =
   drop) — logs + CONTINUES. Dialyzer enforces totality.

**Testing seam.** The ExUnit sandbox pool cannot reproduce a real
`queue_timeout` (no checkout queue; forcing a failure yields
`DBConnection.OwnershipError`, a test-only class we deliberately do NOT catch
— catching it would silently swallow genuine sandbox-setup bugs). So the
raise→typed-error contract is unit-tested against `with_pool_retry/1`
directly, and the end-to-end half uses a REAL persist error the sandbox CAN
produce (empty-body PRIVMSG fails the changeset; the session survives). No
prod-weakening persister injection.

**Out of scope (filed as #337):** async-writer decoupling (a
supervision-tree change, not a P0 hotfix) + the SQLite pool-tuning follow-up.

_Deploy: **COLD** (server release rebuild). HELD — joins the batch._

---

## 2026-07-19 — Bucket B (review remediation): mode-1 login throttle + demotion disconnect

Codebase review 2026-07-19, Bucket B. Closes the last open security MEDIUM
(S6) and the S27 demotion residual.

* **`Grappa.RateLimit.FailureWindow`** — per-(bucket, key) failure counter
  over a fixed window. Check/record are SEPARATE verbs (unlike DailyQuota's
  atomic pair): failure is only known after the bcrypt compare, so `check/3`
  is a lock-free pre-gate and `record_failure/3` advances only on failures —
  successes never count, so an operator cannot lock themselves out. A
  new-window insert sweeps every expired row: keys are unbounded source IPs,
  so the table bounds itself to live-window keys (the DailyQuota "bounded by
  subjects" argument doesn't transfer).
* **Mode-1 gate** (`AuthController`): 10 failures / 15 min / source IP,
  checked before the bcrypt work; trip → 429 `too_many_attempts` (distinct
  from `rate_limited`). `:login_throttled` AdminEvents emitted ONCE per
  (ip, window) — on the exact crossing failure — so a spray cannot flood the
  admin stream. Kept separate from the #171 visitor admission cap: same
  counter infrastructure, different policy axis (credential guessing vs
  network capacity). nginx fail2ban (#160) remains defense-in-depth.
* **Demotion disconnect** (S27): admin `PATCH is_admin true→false` closes the
  target's WebSocket (mirror of the S8 rotation fix); reconnect re-evaluates
  `is_admin` at `UserSocket.connect/3`, so AdminChannel keeps its
  snapshot-at-connect design. Bearer sessions NOT revoked — demotion is a
  privilege change, not a credential compromise.

## 2026-07-18 — #247: /notify presence watch (MONITOR/WATCH), server-side list

External contribution (gabrielemarrone), implementing GH #247's design; the
deltas below are decisions the issue left open (or that repo invariants
overruled).

**Shipped (the issue's "Suggested v1"):** `/notify [list|add|del|clear]` +
Watched panel; DB-owned list per (subject, network) in `notify_entries`
(`Grappa.Notify`); session arm at end-of-MOTD with MONITOR (solanum/Libera)
or WATCH (bahamut/Azzurra) picked from 005; authoritative presence map on
Session.Server; `presence_changed`/`presence_error`/`presence_snapshot` +
`notify_list` events on `Topic.user`; snapshot-on-attach; REST
`/networks/:network_id/notify` with live-sync diff. **ISON polling fallback
deferred** (phase 2) — a no-mechanism network logs honestly and keeps
`:unknown` dots.

**Decisions the issue left open:**
* **Arm slot is 376/422 (end-of-MOTD), NOT the 001 JOIN-replay slot**: 005
  arrives after 001 and the MONITOR-vs-WATCH pick needs the ISUPPORT tokens.
  A `presence_armed` latch keeps a mid-session `/motd` (re-fires 376) from
  re-sending the burst; reconnect re-arm is free (`:transient` restart
  replays 001→005→376).
* **Storage is subject-XOR (user_id XOR visitor_id)**, not "account_id" —
  `query_windows` twin: inline CHECK (SQLite can't ALTER TABLE ADD
  CONSTRAINT), rfc1459-folded partial unique expression indexes per #121,
  CASCADE on visitor reap.
* **Fold is rfc1459 everywhere**, not per-network CASEMAPPING as sketched —
  #121 made rfc1459 THE server-wide fold; a per-network fold would fork the
  identity rule. cic mirrors the fold for presence-map KEYS ONLY
  (`rfc1459Fold` in `notifyWatch.ts` — without it bracket-nick dots never
  light).
* **Baseline-vs-transition lives in the map, not the numeric**: first report
  on an `:unknown` entry is `initial: true` (dot only); a flip is
  toast-eligible. 604/600 (and 730 batches) need no special-casing — "no
  storm on bulk add" falls out of the state machine.
* **Numeric routing**: 730/731/600/601/602/604/605 NumericRouter-delegated
  (per-transition noise; WATCH's nick-shaped params[1] would misroute to
  query windows — the #221 WHOIS-leg disease). Error numerics 734/512 NOT
  delegated: raw text stays on `$server` AND a typed `presence_error` goes
  out (never a silent drop on a full list). 512 gated on an armed WATCH
  because other ircds reuse the numeric.
* **Boundary**: `Grappa.Notify` takes `Networks.Network` as dirty_xref (FK
  only) — a full dep would close the cycle Session → Notify → Networks →
  LiveIntrospection → Session created by the arm-time list read.
* **Watched panel has NO add-input** — the home pane is input-free by pinned
  design; adding is `/notify add`. Flagged in the PR for maintainer judgment.

**Known limitations (documented in the issue):** nick-keyed, not
account-keyed — a watched nick that renames reads offline (extended-monitor
is a future upgrade). MONITOR/WATCH limits enforced by the server only;
grappa surfaces the rejection rather than pre-clamping.

_Deploy: **COLD** — `notify_entries` migration + Session.Server state-shape
change + cic bundle._

## 2026-07-19 — #247 post-review hardening: bounded watch list + visible presence errors

Codebase review 2026-07-19, Bucket A — landed on the open #247 branch before
merge. Supersedes the previous entry's "surfaces the rejection rather than
pre-clamping" note — the list is now BOTH capped locally and
rejection-surfaced.

* **Watch list capped at 64 per (subject, network)** (`Notify.max_entries/0`,
  R1), enforced on the POST-state row count inside `add/4`'s transaction —
  counting after the inserts gets fold-dedup right for free (an idempotent
  re-add against a full list still succeeds), rollback on excess →
  `{:error, :list_full}` → 422. The cap is STATIC, not the ISUPPORT
  `MONITOR=`/`WATCH=` value: adds happen while parked/disconnected when no
  005 exists, and 64 sits under every observed mechanism limit (solanum
  MONITOR=100, bahamut WATCH=128), so a within-cap arm burst can never earn
  734/512 on reconnect. The controller also rejects over-cap batch SHAPES
  before building changesets.
* **`presence_error` is now production-visible** (R2). It used to route only
  to `diagPush` (rendered solely behind the `cic_diag` flag — invisible in
  production) while the comment claimed a toast. Now an error-styled toast
  through the shared presence-toast store (`PresenceToast` grew
  `kind: "transition" | "error"`). Toast, not banner: per-action feedback
  tied to a command just run, unlike ErrorBanners' persistent
  connection-level conditions.
* **Dead REST client removed** (R4): `getNotify` had no call sites (the WS
  snapshot covers cold load); the server-side GET stays. **R5 accepted**:
  multi-nick `/notify del` stays sequential single-nick DELETEs.
* **e2e**: `issue247-notify-watch.spec.ts` drives the full loop. Not run on
  the Windows dev host (bind-mount IO — see memory/windows-host-gotchas);
  gate is the GH CI integration run.

### #247 addendum (review 2026-07-19) — 005-independent arm

The 005 advertisement is a HINT, not a gate. `Session.Server.arm_presence/1`:
advertised pick wins (MONITOR over WATCH); with no advertisement the session
probes WATCH optimistically and downgrades via a 421 ERR_UNKNOWNCOMMAND
fallback chain (WATCH → MONITOR → :none, cached on
`state.presence_mechanism` per connection). Cost on a mechanism-less ircd: at
most two probe lines per connect. The 512 list-full gate honours the RESOLVED
mechanism (a probed-WATCH session has no WATCH= token but its
ERR_TOOMANYWATCH is real). Also per review: the fold SQL now has a single
source (`Identifier.nick_fold_sql/1` + a drift-pin test over the migrations),
the Watched panel renders on parked/disconnected rows, and the live sync only
arms genuinely-new nicks on idempotent re-adds.

## #340 — persist reliability + inbound send-throttle (2026-07-19)

Follow-up to #336 and the #337 filed there. Two distinct floods, two
mechanisms.

### The single deferred WRITER (option-1) was BUILT, e2e-tested, and REJECTED

#340 first pursued #337: one serialized `Grappa.Scrollback.Writer` GenServer
(in-order deferred FIFO; sessions cast fire-and-forget; drain oldest-first,
defer on transient fault, drop only at a hard buffer cap). Fully implemented
(parked branch `340-batched-scrollback-writer`), then run through a real e2e.
**It failed, and the failure is FUNDAMENTAL to the deferred design, not a
tuning issue:** 83 spec failures, deterministic; root cause 48
`Ecto.ConstraintError` row drops on
`messages_visitor_id_fkey`/`messages_network_id_fkey` — a deferred insert
lands AFTER its FK parent (an ephemeral visitor, a torn-down network) has
been deleted → unrecoverable → dropped → never broadcasts. **You cannot defer
an insert past the lifetime of its FK parent.** 0 buffer-cap drops (never
under throughput pressure — purely the deferral race), and the writer
measured −33% peak insert throughput vs synchronous. The race is latent in
prod too (a network unbind or visitor reap racing a buffered row). Rejected.

### Chosen: per-session SYNCHRONOUS insert + #336 degrade

Persist stays synchronous in the Session.Server process (pre-#336 shape,
hardened). Order-preserving with no writer — the session GenServer already
serializes its own persists, so rows insert in receipt order per window — and
no FK-race drops, because the insert happens while the FK parent is alive.
Two axes, two DIFFERENT floods:

* **Part A — persist-degrade (inbound FROM IRC).** A channel spammer is not
  our request; we can't 429 the IRC server, so
  `Scrollback.with_pool_retry/1` rides it out. #336 only caught
  `DBConnection.ConnectionError`; a >busy_timeout write-lock raises
  `%Exqlite.Error{}` ("busy"/"locked") which ESCAPED and still crashed the
  session (latent #336 gap). The rescue now covers both classes, classifying
  transient (busy/locked → retry) vs permanent (syntax/corruption → degrade
  immediately with a loud error log — never silently swallowed). The retry
  runs over a WALL-CLOCK BUDGET (1.5s prod) with capped linear backoff,
  replacing the old fixed ~75ms (which dropped a *normal* message caught
  behind a burst). The backoff sleep runs in the flooding session only, after
  its failed checkout is released — bounded per-session backpressure, never a
  global stall.
* **Part B — send-throttle 429 (outbound TO our API).** The user/cic sending
  too fast IS our request, so we CAN push back. `POST .../messages` consumes
  a token from a per-(subject, network) `RateLimit.TokenBucket` (new
  ETS-backed primitive, sibling of DailyQuota/FailureWindow: burst-tolerant,
  lazy-refill, atomic check-and-consume, no ban-state). Empty bucket → 429
  `rate_limited` via the existing FallbackController clause —
  drop-with-retry; cic's send-failed affordance renders the copy. Numbers
  from the bahamut source's flood allowance (config `:grappa,
  :send_throttle`): **capacity 5, refill 1 token / 2s** — at/below the
  upstream allowance so cic gets "slow down" BEFORE the ircd k-lines the
  user. THAT framing is the point: protect the user upstream, not just the
  DB.

The two compose; neither replaces the other.

**Multi-line paste consequence (intentional in prod).** cic splits a
multi-line compose into one POST per line, so a paste of >capacity lines
trips the throttle mid-paste — lines past the burst get 429'd and cic retains
the un-acked draft (no silent loss). Drip-feed / 429-surfacing UX for a split
send is a cic-side follow-up, NOT server scope. dev + e2e relax
`:send_throttle` so long-body seeding specs don't break; production keeps
capacity 5 (429 contract unit-tested in
`GrappaWeb.MessagesControllerOutboundTest`).

**Known limitation (flagged, NOT built).** The pool is shared across subjects
with no per-subject FAIRNESS: one user's SUSTAINED flood could still
delay/drop another user's message. A hard guarantee needs per-subject
fairness / reserved pool capacity — a bigger mechanism than the incident
warrants. Filed as follow-up.

---

## 2026-07-20 — cic-themes P0 cluster (#332 / #335 / #333) + the `.settings-section` retrofit

Three P0 cic UI enhancements vjt filed, built + shipped as one batch. Durable
decisions:

### One section idiom: `.settings-section` (+ `-card` modifier)

Settings surfaces had grown three "titled group" shapes (drawer `<fieldset>`s,
bespoke `.vhost-section*`, bare visitor identity block). #335 and #333 both
needed sections and both named the vhost sections as the design to copy — so
rather than a fourth variant, ONE idiom:

- `.settings-section` — flex-column titled group (`.settings-section-heading`
  muted uppercase + `.settings-section-body`). **Transparent by default** —
  the ITEMS carry the borders (vhost option buttons, theme cards); bordering
  the section too would double up.
- `.settings-section-card` — modifier adding bg-alt + 1px border + padding,
  for FORM sections whose content has no bordered items of its own (visitor
  identity editor, share session card).

vhost was retrofitted in the same batch (vjt's call — "total consistency or
nothing"): `.vhost-section*` deleted, `VhostSettingsPage` emits
`.settings-section*`. Testids unchanged — the e2e selects by testid, so the
class rename was invisible to it.

### #335 — share session: modal → in-panel sub-page

`ShareSessionModal` → `ShareSessionPage`, a settings sub-page reached from a
section-button (the vhost/themes nav-row pattern; a `"share"` arm added to
`SettingsSubPage` in `lib/settingsNav.ts`) — the issue asked for an in-panel
section that mints the link: a sub-page, not a modal. The sub-page mounts
fresh per entry, so the mint is a plain `onMount`; it closes via its own back
button, leaving the #232 modal-Esc family (which never actually covered the
share modal). Old modal + its unit suite deleted; no other consumer existed.
Gained a **native-share** button (`navigator.share`), feature-detected —
hidden where absent, copy-to-clipboard the always-present fallback.

`lib/settingsNav.ts` (sub-page union + mobile-footer deep-link one-shot) uses
a plain module-level `let`, NOT a Solid signal: the drawer consumes the
pending deep-link inside a `createEffect` that must track only `props.open` —
reading a signal there would add a spurious reactive dependency. Imperative
hand-off, imperative storage.

### #333 — themes personal/gallery + the duplicate-name gotcha

The "copy vanished / base disappeared" report was never data-loss (the copy
is a separate owned row since #299) — two UI facts: the flat list was
`apply_count desc` ordered (copying bumps the base to the top) and there was
no owned-vs-gallery split. Fix: "your themes" (owned) FIRST, then "gallery",
partitioned by the server's **per-viewer `mine` flag** (the same one
`canManageTheme` reads), so a copied built-in lands in personal while the
base stays in the gallery. A copy scrolls to the personal section
(`queueMicrotask` so the freshly-mounted section attaches its ref first).

**Duplicate-name detection is client-only, keyed on the subject-id field.**
The `(subject_id, name)` unique index is the only uniqueness a theme write
can violate, and Ecto attaches its changeset error to the SUBJECT-id field —
`user_id` for users, `visitor_id` for visitors — NOT `name`. So
`ThemeEditor.errMessage` checks for a `user_id`/`visitor_id`/`name` key in
the `validation_failed` response's `field_errors` (already attached by
`FallbackController`). A `maxlength=60` on the name input rules out the
too-long case, so a subject-id field-error unambiguously means "name taken".
No server change — the batch stayed cic-only / hot-deployable.

Delete now routes through the shared confirm modal (`lib/confirmDialog`,
z-index 1000 > the drawer's 100) instead of firing on the first tap.

### #332 — mobile footer: themes launcher restored, wrap, ⚙️

#299 had REMOVED the 🎨 footer launcher to dodge a 5-button overflow that
clipped the admin launcher. #332 reverses the trade: the launcher is back
(deep-links to the themes sub-page via `settingsNav`) and the overflow is
handled the right way — `flex-wrap: wrap` on `.mobile-panel-actions`.
Restoring it inverted two specs' premises — `issue291` (4→5 launchers) and
`issue299-footer-admin-reachable` (admin reachable now via wrap, not
removal) — both updated to guard the new mechanism. The settings glyph became
the emoji-presentation ⚙️ (U+2699 U+FE0F) — the bare text-presentation ⚙ was
too small at tap size.

### Test-order gotcha the batch surfaced

`issue75-themes-gallery` @webkit tapped theme cards by bare positional
`nth(0/1)`. Once #333 put owned themes first, a vjt-owned theme created by an
EARLIER spec in the same run interposed at nth(0). Fix: scope the taps to the
gallery section. General lesson: positional card selectors are fragile across
a per-viewer, ownership-partitioned list — scope to the section whose
contents are stable.

### #342 — send-door throttle copy: discriminating a shared `rate_limited` token by surface

#340's send throttle reuses the **existing** `{error: "rate_limited"}` wire
token — the same one themes' per-day creation quota emits — so a throttled
send rendered the themes copy ("You've hit today's theme limit. Try again
tomorrow.") on the compose box.

**Challenge-the-spec note:** the clean-slate contract is a DISTINCT server
token, exactly as `FallbackController` already does for `too_many_attempts`
and `theme_cap_reached` — 429s that got their own wire string precisely so
cic can render distinct copy. #342 was scoped client-only (per #grappa, no
scope creep), so the fix discriminates by SURFACE on the client. If a future
batch touches #340's controller, minting `send_throttled` server-side and
dropping the client override is the tidier end state.

**The fix — one line, at the right seam.** `friendlyError` is THE send-door
dispatcher (its #74 moduledoc: the single dispatcher for either send door).
It overrides `rate_limited` to the throttle copy BEFORE delegating to
`friendlyApiError`. The themes surfaces call `friendlyApiError` **directly**,
bypassing `friendlyError`, so their copy is untouched — the two surfaces were
already cleanly separated at the dispatcher boundary. Any `rate_limited`
reaching `friendlyError` is a send throttle by construction (topic-set,
`/notify`, services verbs don't hit the message token bucket; themes never
route through here). No server change; draft preserved for retry. Pinned at
unit (`friendlyError.test.ts`: send-door arm → throttle copy, NOT the themes
arm) and e2e (`issue342-throttle-copy.spec.ts`: mocked 429 paints
`/throttl|too fast/`, explicitly NOT `/theme limit/`).

---

## 2026-07-20 — #319: landscape-compact shell tier (slim rails, not the drawer shell)

**Symptom (P1, maintainer via #grappa).** A ~5" phone rotated to landscape
rendered the full desktop three-column shell with desktop-width rails
(16rem / 14rem), leaving the center scrollback a sliver.

**Root cause.** The mobile shell is gated on **width only** — `theme.ts`
`MOBILE_QUERY = "(max-width: 768px)"` drives `isMobile()`. A 5" landscape
phone reports CSS width > 768px, so the desktop `.shell` renders. The
breakpoint conflated "≥768px wide" with "has room for three desktop-width
columns" — false for a short landscape phone.

**Decision — re-proportion, do NOT collapse.** The maintainer explicitly did
NOT want the portrait drawer shell here ("un pelo di left e right bar" — keep
both rails, just narrow them). A dedicated landscape-compact CSS tier
re-proportions the desktop shell rather than switching layout.

**Why pure CSS, not a matchMedia signal.** The issue offered both arms; the
CSS one is the 10x-simpler: no JS, no signal wiring, and media queries
re-evaluate on `orientationchange`/`resize` for free — the tier flips live on
rotation. `isMobile()` deliberately untouched (flipping it true would trigger
the portrait drawer vjt does NOT want). `default.css`-only diff.

**The tier.** `@media (orientation: landscape) and (max-height: 500px) and
(min-width: 769px)`:
- Rails → `grid-template-columns: 8rem 1fr 7rem` (and `8rem 1fr` under
  `.shell-no-members`). The fixed values **override the drag-persisted**
  `--sidebar-width`/`--members-width` vars (not referenced in the override),
  so a previously-widened desktop rail can't leak in.
- Topic bar → tighter padding; namebox cap 18% → 50% (the channel name shows
  first instead of truncating); topic `-webkit-line-clamp: 1`.

**Gate rationale + the iPad watch-out.** `max-height: 500px` is the
load-bearing guard: an iPad in landscape is **768px tall** — it stays on
full-width desktop rails (iPad landscape is legitimately desktop; do NOT
regress it); a landscape phone is ~390-430px tall. `min-width: 769px` scopes
the overrides to the DESKTOP shell only — at ≤768px `.shell-mobile` carries
the base `.shell` class, and without the width floor the rail template would
fork the mobile layout. No `pointer: coarse` gate (spec-optional): a desktop
window resized short-landscape gets slim rails too — acceptable, and the tier
stays a pure geometry predicate (testable on desktop chromium).

**CSS ordering gotcha.** A media query adds **no specificity**. The rail
overrides win because base `.shell` precedes them in source order; the
topic-bar overrides had to be split into a *second* `@media` block placed
AFTER the base `.topic-bar*` rules — an equal-specificity override placed
earlier loses on source order. Two blocks, each adjacent to what it
overrides.

**Verification.** jsdom computes neither layout nor `@media`; pinned by
`issue319-landscape-compact-shell.spec.ts` (desktop chromium, viewport
844×390): both rails visible but slim (< 176px), center pane exceeds half the
viewport, topic clamps to one line, channel name not truncated. RED pre-fix.

## 2026-07-20 — #350: tapping a scrollback link dropped the mobile keyboard

**Symptom (P1, cic).** On iOS, tapping a link in scrollback dismissed the
on-screen keyboard; it should behave like a control — compose keeps focus.

**Root cause.** `keepKeyboard.ts` preventDefaults the mousedown focus-shift
while compose is focused, but `.scrollback` is a duration-gated
selectable-text surface (`SELECTABLE_TEXT_SURFACES`): a short TAP is
deliberately let through (vjt-confirmed tap-to-close for copyable text, #79);
only a long-press preserves the keyboard. A linkified
`<a class="scrollback-link">` sits INSIDE `.scrollback`, so a link tap took
the tap-to-close path. A link is a **control**, not copyable text — the same
category as `.scrollback-invite-join`, which was already in
`SELECTABLE_TEXT_EXCLUDE`; links simply never were.

**Fix.** `SELECTABLE_TEXT_EXCLUDE = ".scrollback-invite-join,
.scrollback-link"` — a link tap now hits the always-fire mousedown
preventDefault → focus never leaves compose. `.scrollback-link` covers plain
+ media links. **Navigation untouched:** the preventDefault is on
**mousedown**; the anchor's `target=_blank` navigation is the **click**
default — the same guarantee the existing exclude relies on.

**The CSS side — a REJECTED symmetry (resolved by code review).** The first
pass also re-excluded `.scrollback-link` on the CSS side (`user-select: none`
under `html.is-ios`), mirroring the [Join] button. Code review caught this as
a **#250-class regression** and it was reverted: `user-select: none` buys
nothing for the keyboard (preservation is 100% the mousedown preventDefault),
and WebKit **excludes an inline `user-select:none` element from a
drag-selection that SPANS it** — selecting a whole message and copying would
drop the URL. The link's own mousedown preventDefault does NOT save this: a
spanning selection starts on adjacent text, so the link never sees that
mousedown. Exactly the regression `.nick-clickable` fixed in #250
(`default.css:1858`). **A URL is copyable content that is also a control —
like a nick, unlike the [Join] label** (which nobody copies). That is the
"reuse the verbs, not the nouns" boundary: Join and the link share the
keyboard *verb* (tap-preserves) but not the selection *noun* (the link is
content).

**Resolution: the two lists deliberately DIVERGE on `.scrollback-link`.**
keepKeyboard's EXCLUDE is the KEYBOARD/focus policy; the CSS re-exclude is
the SELECTION policy (non-copyable controls). They coincide for
`.scrollback-invite-join`, NOT for `.scrollback-link` (keyboard-EXCLUDE only;
stays `user-select: text` via the `.scrollback` cascade so its URL survives a
spanning copy). The keepKeyboard comment documents this so a future reader
doesn't "restore symmetry" and reintroduce the bug. Net shipped change is
**one line**; `default.css` untouched.

**Scope note.** `.scrollback-link` is MircText's class for *every* linkified
URL, so the keyboard-preserve applies in the topic modal / `/list` rows /
mentions too — consistent, harmless (keepKeyboard is gated on an input being
focused). Sibling gap flagged: `.nick-clickable` is also a clickable control
inside `.scrollback` and NOT in the keyboard EXCLUDE, so a nick tap still
dismisses the keyboard — same class as #350, out of scope, possible
follow-up.

**Verification.** Unit: the discriminating short-tap cases (plain + media
link) were RED pre-fix. E2e (`issue350-link-tap-keyboard.spec.ts`, @webkit)
drives the exact touchstart→short-mousedown on the real rendered anchor — a
page.mouse gesture would be non-discriminating (no touchstart → the timing
degenerates to long-press; webkit doesn't focus an `<a>` on mousedown).
webkit can't simulate the OS keyboard — real-device smoke stays vjt's iPhone.
Client-side only.

## 2026-07-20 — #272: WHO membership is roster-authoritative, not a flags `%`-scan

**Bug.** An IRC operator's `/who #chan` rendered a `%` sigil + "halfop" chip
on members carrying umode `+i` (invisible) who were NOT halfops; a non-oper
`/who` rendered correctly.

**Root cause (source-confirmed).** The 352 RPL_WHOREPLY flags field's `%` is
**overloaded** on azzurra bahamut — `src/m_who.c` builds the token
positionally:

```
[ H | G ] · [ * | % ] · [ S ] · [ @ | % | + ]
  away       oper|+i     ssl     chanop|halfop|voice
```

The position-2 `%` is the umode `+i` marker, emitted **only** in the
operator-visible WHO (`IsInvisible(ac) && IsOper(sptr)`); the position-4 `%`
is the halfop membership prefix. A plain `+i` member (`H%`) is
**byte-identical** to a real non-invisible halfop (`H%`) — undecidable from
the flags string alone. cic's `WhoModal.tsx` derived membership with
`modes.includes("%")` (correct for a NAMES prefix *list*, wrong for the
positional WHO flags *token*). grappa relays the flags verbatim; the stray
`%` originates upstream.

**Fix (client-side, no wire change — HOT `--cic`).** Membership is
**roster-authoritative**:

1. **Roster cross-check (primary).** Each WHO row looks the member up in the
   existing NAMES store (`membersByChannel`) — the same unambiguous prefix
   source MembersPane renders — and derives `@`/`%`/`+` from `member.modes`.
   `rosterMembership/3` returns `null` for a roster-plain member
   (authoritative "no sigil") vs `undefined` for no-snapshot/not-found (→
   fall back); the distinction keeps a roster-plain member from falling
   through to the stray-`%` flags field.
2. **`%`-count reconciliation for +i (both directions).** Invisibility is NOT
   read positionally — that mislabels the collision the OTHER way (in the
   non-oper view the +i marker is never emitted, so a position-2 read tags
   every ordinary halfop "invisible"; caught in code review). Instead
   `resolveWhoRow/2` derives `+i` from the count of `%` the RESOLVED
   membership does not account for: real halfop (`H%`, roster `%`) → not +i;
   plain +i member (`H%`, roster plain) → +i; invisible halfop (`H%%`) → +i.
3. **Trailing-glyph fallback** when no roster exists (WHO on a non-joined
   channel, `WHO <nick|mask>`): membership is the **trailing** status glyph
   (`parseWhoFlags/1` — bahamut emits it last), so a lone `%` reads halfop
   and only a non-trailing `%` (e.g. `H%@`) reads +i; robust to unenumerated
   chars between the slots. Irreducible residual: a rosterless
   *operator-view* `+i` plain member (`H%`) reads halfop — inherent to the
   byte-collision, documented in-code.

The `+i` marker surfaces as its own honest **"invisible"** chip (muted
italic, emphatically NOT a channel-status tier), so no wire information is
dropped. `H`/`G`/`*`/`S` chips were never affected.

**General rule (invariant-adjacent).** The WHO flags string is an unreliable
source for channel membership — `%` (and potentially future chars) are
overloaded per-ircd and per-viewer-privilege. The NAMES roster is the
reliable source; WHO flags carry only what the roster doesn't (away / oper /
secure / +i). A new WHO/NAMES consumer MUST take channel membership from the
roster, never from a `%`/`@`/`+` scan of the raw WHO flags token.

**Verification.** `WhoModal.test.tsx` #272 block — RED pre-fix on both
collision directions + the fallback cases; GREEN guards for `H%%`, `HS@`,
`HS%`, `H*%`. E2e (`issue272-who-invisible-not-halfop.spec.ts`): a plain peer
(bahamut boots users `+i` by default) joins, the bouncer opers up, `/who`s —
asserts the real oper-view 352 row carried `%` (anti-hollow-green) AND the
honest "invisible" chip with no halfop chip. Client-side only.

## 2026-07-20 — #327: BottomBar active-tab auto-scroll — defer past the badge-clear reflow (double rAF)

**Symptom.** On mobile, Alt+A / the next-active button jumped selection, but
the bottom bar did NOT always scroll the newly-selected tab into view.

**Root cause (traced, not guessed).** `BottomBar.tsx` ran
`selected.scrollIntoView(...)` **synchronously inside the reactive flush**
`setSelectedChannel` triggers — but selecting a window zeroes its
unread/mention counts in the SAME flush (the 2026-06-02 focused-window badge
suppression): the badge span unmounts → the tab narrows → the strip reflows.
The synchronous `scrollIntoView` computed against **stale pre-reflow
geometry**; with `behavior:"smooth"` it undershot or no-op'd. It misfired
only when the flush actually changed tab widths — hence "not always".

**Fix.** Defer past layout settle using the codebase's established
**double-rAF idiom** (the same one `ScrollbackPane.tsx` uses for "read DOM
geometry after the browser has settled") and **re-query**
`.bottom-bar-tab.selected` INSIDE the deferred callback so it resolves
against the settled DOM, not a ref captured pre-reflow. Kept
`inline:"nearest"` (the bar is the `overflow-x` scroller — correct axis),
`block:"nearest"`, and the jsdom guard.

**One effect, all triggers.** Every selection change — sidebar tap, Alt+A,
Ctrl+N/P, tab tap — funnels through `selectedChannel`, so the fix lives in
ONE effect and covers every door. The #243 re-tap path is orthogonal.

**Verification.** Unit pins the TIMING seam jsdom CAN see: not called
synchronously, not after one rAF, called after the second — on the element
that is `.selected` at flush time (proves the re-query); RED pre-fix. The
visible outcome is proven by a real-WebKit mobile e2e
(`issue327-bottombar-scroll-into-view.spec.ts`) with a precondition that the
target tab starts off-screen (else the test proves nothing). Client-side
only.

---

### 2026-07-20 — #283: per-network Disconnect on the home ConnectedRow

**Premise correction.** The issue framed this as "users have Disconnect,
visitors don't — add parity." Stale: since #211 phase 6 ruling D, the
disconnect verb (`windowClose.disconnectNetwork` → `patchNetwork(:parked)`)
is subject-agnostic — the sidebar / bottom-bar `×` parks for user AND
visitor; the "quitAll for visitors" split survives only in stale comments.
The real gap was **symmetric** and lived in the home panel: `ConnectedRow`
had Jump + 📇 Browse but no Disconnect, while `DisconnectedRow` already had
Reconnect. (vjt spec-challenge + decision.)

**Shipped.** A Disconnect button on `ConnectedRow` **reusing**
`confirmDisconnectNetwork(slug)` (the #195 confirm modal → fire-and-forget
park) — the SAME verb the `×` fires, NOT raw `disconnectNetwork`
(accidental-tap guard). One shared component → identical for user + visitor.

**Litigated: fire-and-forget vs pending/error chip.** The spec said both
"reuse `confirmDisconnectNetwork`" AND "mirror `onReconnect`'s pending/error
UX" — these conflict: the confirm verb opens the modal and returns `void`
immediately, firing `disconnectNetwork` (fire-and-forget, PATCH error
swallowed) — no promise to await, no error to surface; wiring
`pending()`/`friendlyApiError` through would mean extending the shared verb
and touching every `×` call site. vjt chose **Option A**: match the `×`
exactly — fire-and-forget behind the modal; the row swapping to
`DisconnectedRow` on `connection_state_changed` IS the feedback. Styled as a
subdued outline chip, distinct from the accent-filled Reconnect CTA.

**Apply:** when a spec says "reuse verb X" AND "mirror behavior Y" and X is
fire-and-forget while Y needs an awaited result, they conflict — surface the
tension and let the owner pick before building, don't silently deliver half.
A home-panel affordance that *reverses* an existing one (Reconnect ⇄
Disconnect) should reuse the existing verb, not fork a parallel one.
Client-side only — cic bundle, no cold deploy.

**Verification.** `HomePane.test.tsx` #283 block: fires the confirm verb,
does NOT `patchNetwork`/`setSelectedChannel` (proves reuse, not fork/jump);
visitor-identical; a `:parked` row renders NO Disconnect. E2e: button →
modal → **Cancel does NOT park** (asserted with a bounded settle so a
regressed async park can't slip past a t≈0 snapshot) → confirm parks → row
swaps to the parked card.

---

### 2026-07-20 — #356: /notify + /hilight feedback rewire + classic-IRC rename (cic-only)

`/notify` (presence) and `/watch`|`/highlight` (keyword) executed correctly
server-side but their SUCCESS / LIST output was computed then **discarded** —
CP13 removed the numericInline surface and never rewired a consumer. Errors
showed; success + list vanished, so the commands *felt* dead. cic-only.

**1. Feedback — hybrid by argument presence (ComposeBox seam).** The compose
`error` signal became severity-tagged `feedback`
(`{ text, severity: "error" | "notice" }`): error → red `.compose-box-error`,
`role=alert`, STICKY; notice → green `.compose-box-notice`
(`var(--mode-voiced)`, cloned geometry so error↔notice never reflows),
`role=status`, AUTO-DISMISSES after 3s (timer cancelled on new input /
submit / unmount so a stale timer can't wipe a fresh notice). `doSubmit`
routes `{ok: string}` → notice, `{ok: true}` → silent, `{error}` → sticky.
WITH arg → execute + notice; BARE → open settings.

**2. Classic-IRC rename (irssi-direct grammar).**
- Presence (`kind:"notify"`): `/notify` canonical + `/watch` **alias** (was a
  KEYWORD alias pre-#356; classic IRC WATCH/MONITOR = presence).
  `/notify <nick>…` adds.
- Keyword (`kind:"watchlist"`): `/hilight` canonical (irssi helpfile
  spelling) + `/dehilight` remove + `/highlight` alias; whole rest = one
  pattern.
- **Dropped** the add/del/clear/list subverb grammar: bare opens the settings
  section (the list is right there); clear/del → the per-entry × there. A new
  `{kind:"open-settings", section:"watchlists"}` covers every bare form.
- **No `/unnotify`** — the spec lists a keyword remove but no presence
  remove; presence removal is the settings × (trivial parser twin later if
  wanted; deliberately out of scope).

**3. Unified "watch lists" settings section (moved off home).** ONE sub-page
(`WatchlistsSettings.tsx`) holds BOTH lists under one header:
- Presence (notify), PER NETWORK — the home "Watched" panel MOVED here (spec:
  move, don't copy); same per-network source of truth; `WatchedPanel` deleted
  from both rows.
- Keyword — brand new (there was no `highlight_patterns` UI). Backed by a new
  `highlightList` store: unlike the presence list (kept fresh by the
  `notify_list` broadcast), the keyword list has NO server broadcast, so the
  store mirrors each `{patterns}` push response and refreshes on open. ONE
  cic-side source of truth shared by the `/hilight` command AND the section —
  no drift.

Deep-link: a bare watch-family verb calls `settingsNav.requestOpenSettings`
(a monotonic open-tick a lib module can bump; Shell's effect opens the
drawer, whose open transition consumes the pending `"watchlists"` page) — the
existing `requestSettingsPage` pattern extended to also *open* the drawer.

**Apply:** when a spec's confirmation output is "computed then discarded",
the fix is a *consumer*, not new plumbing — the data was already built. When
renaming commands to a domain convention, follow the convention's grammar
(irssi-direct), not the codebase's prior subverb shape — a bad grammar
doesn't become right by being the incumbent. When a "list/manage" verb and a
rich settings surface both exist, the settings surface absorbs
list/clear/bulk and the command keeps only the quick-add — two ways to do one
thing → drift.

**Verification.** Unit suites across ComposeBox / slashCommands / compose /
WatchlistsSettings. E2e `issue356-notify-highlight-feedback.spec.ts` (notice
auto-dismisses; sticky alert; bare verbs → the section; home shows no watched
panel; keyword round-trips real server state);
`issue247-notify-watch.spec.ts` retargeted to the settings sub-page (the
presence loop unchanged; the list just moved).

## 2026-07-20 — #360: mention-aware scroll-to-bottom badge (cic-only)

The floating scroll-to-bottom button (C7.4, `ScrollbackPane`) now surfaces a
count of own-nick mentions below the fold in the active window; a tap jumps
to the next one instead of straight to the tail. cic-only.

**Badge is DERIVED geometry, not a stored count.** Pure fn
`lib/mentionScroll.ts:mentionsBelowViewport(lines, viewportBottom)` — a
mention straddling the fold counts as *seen* and is excluded
(`top >= viewportBottom`). ScrollbackPane reads per-row geometry
(`readMentionGeom` — `offsetTop` + the `.scrollback-mention` class, mirroring
`lastFullyVisibleRowId`'s layout-cached walk, no `getBoundingClientRect`
thrash). The `mentionsBelow` signal (length = badge, head = next target)
recomputes at the SAME geometry edges `atBottom` does — every `onScroll`,
after each `rows()` recreation via rAF, AND on viewport/container resize
(`onResize` + the #285 `ResizeObserver`; a soft-keyboard open while parked
mid-buffer moves the fold with no scroll event). Nothing persisted; the badge
decrements for free as a jumped-to mention clears the fold.

**Scope = mentions only.** `.scrollback-mention` (own-nick), NOT
`.scrollback-highlight` (watchlist) — kept split per the existing track
separation; feeding watchlist highlights in is a deliberate follow-up
decision, not this issue.

**Tap semantics (`onScrollToBottomTap`).** Badge > 0 → SMOOTH
`scrollIntoView({block:"center"})` to the nearest mention below
(nearest-first = DOM order = chronological; the target is re-derived FRESH
from the DOM at tap time, not the badge signal). Badge == 0 → the existing
`scrollToBottomGesture`, unchanged. A tap also
`setMarkerActivationPending(false)` (operator navigation hands scroll
authority back, as the snap path does, so a live message's `rows()`
recreation can't yank the view off the mention — #168 latch) but does NOT
advance the cursor (a mid-buffer mention isn't "read to newest"; the
leave-arm's forward-only write covers it on the next switch).

**Smooth scroll + the 2026-06-02 shared-node hazard.** This is the ONE smooth
scroll in the file; every other path is instant because `.scrollback` is a
SHARED DOM node across channel↔query↔server switches (Shell's non-keyed
Match) and an async animation would survive the row swap and race
`scrollToActivation`, stranding the arriving pane (the 2026-06-02
contamination). Smooth is deliberate here (vjt device-verifies the FEEL;
Playwright ≠ iOS), so the hazard is neutralised by a dedicated
`on(key,…,{defer:true})` effect firing a synchronous `scrollTo` to the
current offset at the switch boundary — interrupts the native animation
without moving, before scrollToActivation re-anchors. The #243 re-tap stays
plain `scrollToBottomGesture` (issue scope = the floating button only).

**Visual.** Corner pill reusing the mention colour pairing (`--mention` bg +
`--fg` text) so it reads as "mentions", distinct from the button's `--accent`
fill; the button gains `position: relative` as its offset parent.

**Apply.** When a UI count is a projection of live layout, DERIVE it at the
geometry-change edges (recompute where `atBottom` recomputes) — no parallel
stored counter with its own housekeeping. When re-introducing a smooth scroll
onto a shared, switch-reused node, pair it with a switch-boundary cancel —
the 2026-06-02 "make everything instant" fix was the blunt version of the
same invariant.

**Verification.** `mentionScroll.test.ts` (predicate edges incl. boundary
`top == viewportBottom`). E2e
(`issue360-scroll-to-bottom-mention-badge.spec.ts`, chromium, a fresh per-run
channel so #bofh's accumulated mentions can't skew): badge "2" → tap →
mention 1 + badge "1" → tap → mention 2 + badge gone → tap → snap to bottom.

## 2026-07-20 — #366 long-press selects the ENTIRE message (keyboard-open fallback for native selection)

**Problem.** #79 restored scrollback selection while the keyboard is open,
but native CHAR-RANGE selection stays unreliable on mobile with the keyboard
up (#79 remains the tracker for the underlying native failure). Users need a
working "grab this whole message" path regardless.

**Fix (companion to #79, NOT a new mechanism).** The long-press detector
already exists: `keepKeyboard.ts` duration-gates its mousedown preventDefault
on selectable surfaces (iOS dispatches the mousedown on finger-release, so
`mousedown − touchstart ≥ LONG_PRESS_MS` IS the long-press signal). #366
extends that branch: besides preserving the keyboard,
`selectEntireMessage(e.target)` does `selectNodeContents` on the enclosing
`.scrollback-line` and applies it as the document selection — bypassing the
flaky native partial selection.

**Why the WHOLE `.scrollback-line`, not `.scrollback-body`.** The rule must
be uniform across message kinds: for a PRIVMSG the sender nick is a sibling
`<button>` OUTSIDE `.scrollback-body`, so body-only would drop the nick.
Selecting the whole row (time + sender + body) is the one robust rule; the
timestamp riding along is acceptable chrome (device-tweakable post-ship).

**Scope.** `.scrollback-line` only — a long-press on `.topic-modal-text`
finds no message row → `selectEntireMessage` returns false → the #79
native-preserve path unchanged. Excluded controls (`.scrollback-link`,
`.scrollback-invite-join`) fall through to the always-fire chrome branch, so
select-all never runs on a control.

**Non-negotiables honoured.** Detection via time-threshold, NOT an aggressive
`preventDefault` on touchstart (touchstart stays a passive timestamp read) —
vertical scroll and future #308 swipes untouched (a scroll/swipe is a move
gesture iOS does not follow with a mousedown, and we never cancel touch
defaults). iOS-scoped like #79 (`isIos()` gate); whether Android's native
selection also fails with the keyboard up is untested — the release-timing
mousedown model is iOS-shaped, so un-gating needs its own verification.

**Verification.** Unit: long-press on a `.scrollback-line` selects the whole
row; short tap / modal-text / link long-press select nothing. E2e
(`issue366-longpress-select-all.spec.ts`, @webkit): synthetic touchstart +
real wall-clock hold + mousedown; asserts `getSelection().toString()`
CONTAINS the body after a long-press, not after a short tap (jsdom's
Selection is a no-op). Real iOS/Android FEEL is not
Playwright-reproducible — vjt device-verifies post-ship
(feedback_playwright_webkit_not_ios_scroll).

## 2026-07-20 — #364 cicchetto S1: re-join the user topic on token rotation (rebuild ≠ reconnect)

**The bug (P0, from the 2026-07-19 codebase review).** A token rotation that
KEEPS the identity — Phase 5 refresh, admin re-issue, same-visitor `/share`
consume — silently killed all user-topic traffic: every user-topic push event
vanished AND every user/channel push verb (`/whois`, `/op`, `/away`, …)
rejected "not connected", until logout+reload.

**Root cause — a rebuild is NOT a reconnect.** `socket.ts` REBUILDS the
Phoenix Socket on every token transition, because the bearer rides the
`authToken` subprotocol captured ONCE at Socket construction (#95/#202) — a
plain reconnect would replay the stale ctor-time token. But phoenix.js's
per-Channel auto-rejoin only re-runs the channels the SAME Socket instance
holds in `socket.channels[]`; a new instance starts with ZERO channels, so
NOTHING auto-rejoins — every topic must be re-joined by the effect that owns
it. `subscribe.ts` already did (its `on(token)` arm clears the joined Map +
`leave()`s on rotation). `userTopic.ts` did NOT: its join effect dedup'd on
the derived IDENTITY (`socketUserName()`) and early-returned when the name
was unchanged — so on a same-identity rotation it never re-joined, and
`_userChannel` (the module-level handle every push verb writes through)
stayed null.

**The fix.** Track the live `Channel`, not a boolean identity guard: on any
token transition off the value we joined under, `leave()` the orphaned prior
Channel (H2 double-handler-leak parity with subscribe.ts) and re-join on the
rebuilt socket — regardless of whether the identity changed. **The SOCKET,
not the identity, is the resource the effect tracks.** General rule for the
whole codebase: any token-tracking join effect must key its dedup on the
socket lifecycle, never the derived identity — a stable identity does NOT
imply a stable socket.

**Honesty fixes alongside.** (1) `socket.ts`'s moduledoc claimed "phoenix.js
auto-rejoins on the next `connect()`" — true for a reconnect, FALSE for the
rebuild path, and precisely the mental model that let this ship; corrected.
(2) The `__cic_userTopicReady` e2e stamp now clears on the rebuild-leave and
re-adds on the RE-join ack, so it mirrors the LIVE subscription instead of
"ever subscribed".

**Verification.** Unit (`userTopic-rotation.test.ts`) drives the REAL
`auth.ts` signal — the sibling `userTopic.test.ts` mocks auth as plain fns
and cannot exercise the reactive rotation at all. E2e
(`issue364-usertopic-rejoin-on-rotation.spec.ts`) mints a second server-valid
bearer for the SAME user, rotates in-context through `__cic_setTokenForTests`
(a test-only TRIGGER for a real production transition — no in-UI rotation
path exists today), and proves `/whois` still round-trips. Self-`/whois` is
the proof surface because it has NO optimistic local render: the WhoisCard
appears only if the verb reached the server AND the reply arrived on the
re-joined user topic — one artifact for both symptoms.

## 2026-07-21 — #360 iOS: mention-jump anchors on msg+1, not the mention (keyboard-clip fix)

**Problem (vjt real-iOS report).** The mention-jump anchored the scroll ON
the mention (`scrollIntoView({block:"center"})`), leaving it clipped behind
the on-screen keyboard. Root cause: `scrollIntoView` aligns against the
LAYOUT viewport, which extends the full height under the keyboard — the
mention "centered" in the layout viewport lands in the region the keyboard
visually covers (the visual viewport is only the top slice). Same class as
every "iOS keyboard shrinks the visual viewport" gotcha.

**Fix.** Anchor the scroll on the message immediately AFTER the mention
(msg+1), so the mention sits fully visible ABOVE the anchor, clear of the
keyboard. Pure decision extracted to
`mentionScroll.mentionJumpTargetId(lines, mentionId)` (next DOM-order line's
id, or the mention's own id when it is the last line — nothing below to
anchor on); `ScrollbackPane.onScrollToBottomTap` scrolls that anchor. Keeps
the #360 split (mentionScroll owns the geometry decision, ScrollbackPane the
DOM), so the anchor choice is unit-tested without a layout. The webkit e2e
cannot reproduce the keyboard (feedback_playwright_webkit_not_ios_scroll) —
the existing #360 e2e still asserts the mention lands visible after each tap;
vjt device-verifies the iOS feel.

## 2026-07-21 — #366 iOS: long-press select-all rides touchend, not the synthetic mousedown

**Problem (vjt real-iOS report).** Long-press select-all did "absolutely
nothing" on real iOS Safari. The #79/#366 mechanism duration-gated its
select-all on a `mousedown`, assuming iOS dispatches one on finger-RELEASE
even for a long-press. FALSE on device: iOS Safari synthesizes mouse events
ONLY for taps — a long-press the OS routes into native
text-selection/callout fires NO mousedown/click, so the handler never ran.
The #366 e2e passed as a FALSE GREEN because it SYNTHETICALLY dispatched the
very mousedown real iOS withholds (webkit ≠ iOS).
**Fix.** Drive the long-press from TOUCH events, which fire regardless of how
iOS routes the gesture: `keepKeyboard` records the touchstart
clock/target/coords + keyboard-up state, cancels on a touchmove past a 10px
tolerance (a scroll, not a hold), and on `touchend` — held ≥ LONG_PRESS_MS,
no move, compose focused at start, on a selectable surface — calls
`selectEntireMessage`. All passive (we only read + set the selection; a
long-press shifts no focus, so the keyboard stays up with no preventDefault).
The mousedown handler is untouched — it still carries the tap
keyboard-preserve/close policy and is a harmless idempotent net for any
platform that DOES emit a long-press mousedown (Android, untested). The e2e
was rewritten to drive the REAL gesture (touchstart → hold → touchend, NO
mousedown) so it reds if the select-all regresses to the mousedown-only path;
the real-device FEEL (magnifier/handles, copy callout with the keyboard up)
is vjt post-ship — this fix makes the handler FIRE, which it never did
before.

---

### 2026-07-22 — #379: the periodic multi-core CPU spike was a lost scrollback index, not the reapers (P0, code-freeze blocker)

**Symptom.** grappa periodically pinned more than one full core for
several seconds, then dropped to idle — a periodic cadence pointing at a
scheduled job. The issue's leading hypothesis blamed the 60s reapers
(`Visitors.Reaper` per-row reap: Cloak decrypt + N+1 + a 13-table
CASCADE delete).

**The reapers were innocent on prod.** A live prod BEAM profile
(`bin/grappa rpc` + `:recon`) + prod DB inspection cleared them:
`Visitors.list_expired` correctly excludes the "expired-looking" rows
that hold a NickServ credential (`registered_ids_subquery` filters
`password_encrypted IS NOT NULL`) — those are live registered visitors,
not garbage. The reaper swept 1 tiny visitor per 90s window; N≈0, no
Cloak/N+1 cost. The reaper hypothesis was a plausible read of the source
that a live profile refuted — evidence over source-reasoning.

**Root cause — CP29 R-2 index regression.** An Ecto query-time profile
over 35s attributed ~88% of ALL DB query time (4.76s, avg 170ms/call,
worst 730ms) to `SELECT … FROM messages` — the since-cursor read paths
`Scrollback.fetch_after/6`, `count_after/5`, `count_after_split/5`,
`unread_content_tail/6`. CP29 R-2 had switched the scrollback cursor
from `server_time` to monotonic `id` (to kill same-ms tie
loss/duplication across a page boundary), so those paths now filter
`WHERE subject=? AND network_id=? AND channel=? AND id>? ORDER BY id`.
But every `messages` composite still ENDS in `server_time` (kept for the
`fetch/6` `server_time DESC` display order). So `id > ?` was not
index-eligible and SQLite fell back to `messages_network_id_index`:

```
EXPLAIN (prod):  SEARCH messages USING INDEX messages_network_id_index (network_id=? AND rowid>?)
```

— scanning ALL of the busiest network's post-cursor rows (~570k rows,
most on network 1 = azzurra), filtering `channel`/`visitor_id` row by
row. These reads fire on every channel join + unread-count, ×~18 topics
per WebSocket (re)join (clients reconnect often), so it was a
near-constant SQLite **dirty-scheduler** burn. `:recon.scheduler_usage`
hides it (it excludes dirty schedulers); host `top` showed the
`erts_dios_*` dirty-IO threads dominating cumulative CPU. That is the
"constant CPU" the operator saw as periodic spikes.

**Fix — the id-twin composites.** Add the id-cursor twin of each
existing `…server_time` composite (KEEP the server_time twins;
`fetch/6` still orders `server_time DESC`):

```elixir
create index(:messages, [:visitor_id, :network_id, :channel, :id])
create index(:messages, [:user_id,    :network_id, :channel, :id])
create index(:messages, [:visitor_id, :network_id, :dm_with, :id])
create index(:messages, [:user_id,    :network_id, :dm_with, :id])
create index(:uploads,  [:visitor_id])
```

Verified on a copy of the prod DB — the channel path flips from the full
network scan to a clean seek (`SEARCH USING INDEX
messages_visitor_id_network_id_channel_id_index (…, id>?)`, no TEMP
B-TREE), and `count_after/5` is COVERING on the same index. The
`ScrollbackTest`/`UploadsTest` `EXPLAIN QUERY PLAN` guards pin this and
reproduce the exact pre-fix prod plan in RED — they also guard against a
future `messages` table-rebuild migration dropping the id-twins, which
is precisely the CP29-R-2-class drift that caused this.

**`uploads.visitor_id`.** The one genuinely-missing index the issue
already flagged: `uploads` is an `ON DELETE CASCADE` child of `visitors`
that shipped without an index on the FK column, so every visitor delete
full-scanned `uploads` (`EXPLAIN → SCAN uploads`). Added the index.

**Residual (separate follow-up).** The DM-peer view filters `(channel=?
OR dm_with=?) ORDER BY id` — an OR across two indexes → still filesorts
even with the id-twins. Rewrite as a UNION of two index-seekable halves;
lower volume than the channel path, deferred. The `dm_with` id-twins are
added now for symmetry (they make the `dm_with=?` arm and the own-nick
self-msg path seekable).

**Deploy.** COLD deploy — a new `priv/repo/migrations/*` file is Class 5
in `Grappa.Deploy.Preflight`, and the hot path skips `mix ecto.migrate`,
so `--force-hot` would silently NOT build the indexes (the CPU burn would
persist while the operator believed it fixed). The `CREATE INDEX` DDL is
itself online-safe for the running old code (expand-class — no
schema-shape change), but the four `messages` builds share one migration
transaction, so the write lock is held across their cumulative ~4-pass
scan of the ~570k-row table — the operator (orch owns this call)
schedules it off a traffic peak. The reaper Cloak/N+1 hardening from the
issue body is real but only bites the high-churn e2e testnet, not prod —
left as a separate low-priority pass. `uploads.user_id` is the same
unindexed-CASCADE-FK class as `visitor_id` but only bites the rare manual
user-delete op (not the 60s Reaper's visitor path) — a one-line
follow-up, not part of this P0.

---

## 2026-07-23 — #364 S6: the last fire-and-forget WS pushes now surface rejections (invite + read-query verbs)

**Problem (codebase review 2026-07-19 S6/H3).** `/invite` and the
read-query verbs (`whois`/`whowas`/`who`/`names`/`lusers`/`info`/
`version`/`motd`) were the last channel pushes still shipped as
fire-and-forget `: void`. `compose.ts` set `result = { ok: true }`
synchronously right after the push, so a server `{:error, %{error}}`
(invalid_channel/invalid_nick/no_session/upstream_unavailable) OR a
WS-down dropped frame silently reported a false green ✓. `/invite` is a
write verb — this is exactly the class #154(1) fixed for op/deop/voice/
devoice/kick/ban/unban/mode/umode but explicitly deferred ("invite left
as-is (follow-up)"). The read-query verbs had a worse UX twist: their
server-side validation reject fires BEFORE the upstream write, so on a
malformed target NO reply bundle and NO `$server` numeric ever arrive —
the operator got literally nothing.

**Fix (cic-only).** All nine now route through the same #154(1)
`pushUserChannelVerb` Promise helper (`: void` → `Promise<void>`) and are
`await`ed in `compose.ts`, so a rejection hits the shared catch →
`friendlyChannelError` inline banner (mirror of kick/ban/mode + the S21
`/topic -delete` fix). No server change was needed: every one of these
verbs already replies `{:reply, :ok | {:error, %{error}}}` via
`GrappaChannel.dispatch_subject_verb/3`, so awaiting confirms the command
was ACCEPTED (validation + upstream write succeeded) and NEVER hangs; the
reply bundle/modal still arrives asynchronously on the user topic,
unchanged.

**Deliberately exempt: `banlist`.** It stays fire-and-forget because its
errors surface via the 367/368 numerics — that rationale does not hold
for the read-query verbs (a pre-write validation reject emits no
numeric). Also deleted the dead `pushChannelTopicSet` helper (no call
sites; compose uses the `postTopic` REST path) so it can't be wired up
later and silently swallow `persist_failed`.

**Test.** A parameterized `compose.test.ts` spec drives each of the nine
verbs through a rejected push and asserts the failure surfaces as
`{ error }` (not a green ✓) with the draft preserved for retry — the same
shape as the S21 `topic_clear` test. Known follow-up (out of S6 scope):
`UserContextMenu`'s right-click WHOIS now returns an ignored Promise that
can reject unhandled when the socket is down — but that is
pattern-consistent with the op/deop/kick/ban context-menu actions already
there, and the menu has no inline error surface regardless.

---

## 2026-07-23 — #364 bucket A: #247 notify-hardening cluster (lifecycle S2/S3, persistence S1/S3, web S4/S5, cicchetto S3)

The 2026-07-19 codebase review's "bucket A" grouped the fresh #247
`/notify` presence-watch surface's rough edges. Burned down as one cluster
(the two HIGH riders — lifecycle S1 numeric routing and cicchetto S1 topic
re-join — were already fixed on main, `36476d99` / `7ce908be`, verified
no-op). The six that still reproduced:

* **lifecycle S2** — `GhostRecovery` compared the 401/311 nick echo with a
  bare `==` guard. The echo comes from the ghost holder's server record and
  can differ in case / rfc1459 bracket-fold; a miss stranded the FSM on the
  no-op catch-all until the 8s `:ghost_timeout`. Now folds both sides via
  `Identifier.canonical_nick/1` (GH #121).

* **lifecycle S3** — `arm_presence/1` + the 421-fallback read the watch list
  with a raw `Notify.list/2` inside `handle_info`; a saturated SQLite pool at
  a reconnect storm would raise and crash the session (the #336
  slow-DB→disconnect class, reintroduced). Added `Notify.list_available/2`
  (degrade-aware, `{:ok, entries} | {:error, :unavailable}`) + the
  closure-taking `Notify.degrade_on_db_fault/1` (public for unit test, mirror
  of `Scrollback.with_pool_retry/1`; no retry — a ≤64-row read skips and lets
  reconnect retry). Controllers keep `list/2` (a DB fault → 500 is correct
  there). The arm leaves `presence_armed: false` on `:unavailable`.

* **persistence S1** — `Notify.clear_all_for_user/1` was written "for
  SubjectReset only" but never wired; the e2e reset left watch rows that
  re-armed MONITOR/WATCH on the respawn and flaked later specs. Wired the
  drain alongside its siblings.

* **persistence S3 / web S4 / web S5** — zero test coverage on fresh #247
  surfaces: the visitor-subject Notify arm (conflict target / CASCADE), the
  after-join `notify_list` + `presence_snapshot` channel pushes, and the
  controller's `pre_folds` quiet-re-add diff. Added real tests for each
  (a fold-duplicate re-add now provably emits no second `WATCH +` upstream).

* **cicchetto S3** — `notifyWatch` was the one per-network store NOT built
  via `identityScopedStore`; `resetNotifyWatch` was dead prod code, so a
  same-browser account switch leaked the previous identity's watch list +
  presence dots + toasts (network ids are global — slugs collide across
  accounts) until the new `notify_list` snapshot landed. Now wired through
  `identityScopedStore` like every sibling.

The general lesson threaded through S2/S3/persistence-S1: fresh code copied
the SHAPE of adjacent verbs (a nick compare, a DB read, a reset helper) but
not their invariants (rfc1459 fold, the #336 degrade contract, the reset
wiring) — the "Claude copies whichever pattern is closest" trap CLAUDE.md
warns about. Each fix routes the new site through the established primitive.

## 2026-07-23 — #364 docker S1/S2: toolchain image + live-node debug attach

Two DEV-INFRA HIGHs from the 2026-07-19 review. Both are LOCAL dev/e2e
tooling — the FreeBSD prod jail (`deploy-m42.sh`) stages a `mix release` +
rc.d wrappers and never reads the Dockerfile / `bin/start.sh`, so neither
change rides anything to prod.

**docker S2 — `iex.sh`/`observer.sh` booted a SECOND application instead of
attaching.** `scripts/iex.sh` ran `iex -S mix`; `scripts/observer.sh` ran
`in_container iex -S mix run -e ':observer_cli.start()'`. Both boot a whole
new `Grappa.Application` inside the running container: Bootstrap re-reads
the DB credentials and spawns a DUPLICATE `Session.Server` + upstream IRC
connection per binding (nick collisions), and the second node writes the
same sqlite file the live node owns (the WAL "Database busy" flake).
`observer.sh` was doubly broken — `in_container` = `docker compose exec -T`
gave the TUI no TTY, and even with one it would introspect the
freshly-booted node, not the live one.

- `iex.sh` is now a thin alias for `bin/grappa remote-shell` (T-2 —
  `iex --remsh grappa@grappa` gated by `RELEASE_COOKIE`), the attach path
  that already existed (the old "remote is gone" comment was stale). One
  attach path, one code path.
- `observer.sh` spins a THROWAWAY local node (`obs-$$`) and runs
  `observer_cli.start(:"grappa@grappa")` AGAINST the live node.
  `mix run --no-start --no-compile` loads the project + deps code path (so
  `:observer_cli`, an `only: [:dev]` dep, resolves) WITHOUT starting the
  app — no second boot, no sqlite handle — while `observer_cli.start/1`
  renders the live tree over an interactive (no `-T`) exec.
- Dropped `iex.sh`'s worktree guard: remsh always joins the LIVE node
  (main's source), so the "poking main vs my worktree" ambiguity of the
  old code-loading path is gone. That surfaced a latent `bin/grappa` bug —
  it never `cd`s to `REPO_ROOT`, so from a worktree the compose *project*
  defaults to the worktree dirname (a different project than the live
  container) and a main-side `compose.override.yaml` resolves to a
  nonexistent worktree path. Fixed `bin/grappa` to `cd "$REPO_ROOT"` like
  every sibling script (honors its "run from any worktree" docstring).
- Verified against a live dev node (web-only, empty DB): `iex.sh --batch
  -e 'node()'` → `grappa@grappa`, `Registry.count(SessionRegistry)` → 0
  (no duplicate sessions); observer mechanism → `local_grappa_started=false`,
  `observer_cli_loaded=true`, `connected_to_live=true`, live proc count via
  RPC = the live tree. `test/scripts/iex_observer_test.bats` guards the
  invocation shape (remsh / `--no-start` / no `exec -T`).

**docker S1 — the Dockerfile dep-bake was 100% shadowed.** Every runtime
shape bind-mounts the repo over `/app` (`./:/app`, `../..:/app`), and
`MIX_HOME`/`HEX_HOME`/`deps/`/`_build/` all live under `/app`, so the
image-baked `mix local.hex` / `COPY mix.exs mix.lock` / `mix deps.get` /
`mix deps.compile` / `COPY . .` / `mix compile` layers were invisible at
runtime — pure build waste that re-ran C-NIF dep compilation on every
context change, invalidated `COPY . .` on any edit, and made "clone-and-go
`docker compose up`" a lie (a fresh clone has no host-side hex/deps and the
baked ones are shadowed — which is why quickstart + the e2e seeder already
re-install into the mount). Single-stage is still right (the CP23 rationale
holds); only the vestigial bake was wrong.

Reduced the Dockerfile to a toolchain image (base + `apk add` + `ENV` +
`WORKDIR` + `EXPOSE` + `HEALTHCHECK` + `CMD`). Deps install into the
bind-mounted tree at first boot: `bin/start.sh` self-heals (installs hex +
`deps.get` when `deps/` is empty; idempotent — a cheap dir check on every
subsequent boot), the same pattern `scripts/bun.sh` + `scripts/bats.sh`
use, so a fresh `docker compose up` is genuinely clone-and-go.
`quickstart.sh` (standalone), `deploy.sh` (per-deploy sync — now installs
hex too since the image no longer bakes it), and the e2e seeder already
cover their paths. Verified: image build drops to seconds (no dep layers);
image shrinks 985MB → 777MB; a toolchain image with `hex_installed=no`
bootstraps 67 deps (incl the ecto_sqlite3 C-NIF) from an empty tree; the
dev stack boots green on the new image with the self-heal correctly
skipped when deps are warm.

## 2026-07-23 — #364 bucket G: GrappaChannel boundary robustness (web S2/S3)

Two MEDIUMs from the 2026-07-19 review — both are the same class: a
hostile or buggy cicchetto could crash its OWN user channel pid with a
malformed frame, spamming operator crash reports and letting the client
repeatedly take down its socket. Server-side, ride the next deploy.

**web S2 — `away` crashed on a non-map `origin_window`.** The set/unset
handlers read `origin_window` straight from the payload and passed it to
`dispatch_set_away/4` / `dispatch_unset_away/3`, whose only clauses are
`nil` and `is_map/1`. A string/number/list raised FunctionClauseError.
`origin_window` is OPTIONAL wire-untrusted metadata (routes the 305/306
reply numerics back to the originating window), so a new shared
`validate_origin_window/1` normalizes at the boundary: absent → `nil`
(the pre-C-bucket path), map → passed through, anything else → reject
loudly with `invalid_payload` — mirroring the sibling `visibility`
handler's documented "reject rather than crash" posture. Also fixed the
`away_set_dispatch/4` `@spec`, which declared `origin_window ::
String.t() | nil` while the implementation has always required
`map() | nil` (Dialyzer couldn't catch it — the caller passed the raw
`Map.get` result typed as `any()`).

**web S3 — no `handle_in` catch-all.** Every specific clause is tightly
guarded (`is_integer(network_id)` etc.); an unknown event, or a known
event with a wrong-typed field that fails its guard (a string
`network_id`), matched no clause and Phoenix's default `handle_in/3`
raised. Added a terminal `handle_in(_, _, socket)` replying
`unknown_event`, mirroring AdminChannel's already-documented catch-all
(same problem, now the same solution per the CLAUDE.md consistency rule).

Both fixes ship a failing-first channel test asserting the malformed
frame is rejected AND the channel pid survives (`Process.alive?`). The
sibling bucket-A findings (lifecycle S2/S3) were already resolved by
`340c22db` / `635352a9` in the notify-hardening cluster above — verified
still-fixed, no re-implementation.

## 2026-07-23 — #364 bucket E: rfc1459 fold-consistency (cic + persistence)

The 2026-07-19 review flagged the rfc1459 nick fold (GH #121) as
half-migrated across four surfaces. All four are the same disease the
nick invariant exists to prevent — a nick the server treats as ONE
identity forking into two on a surface that folds differently — plus the
drift gate that would have caught it. The `canonical_channel/1` vs
rfc1459 **channel** casemapping question (irc S4) is a separate design
decision and is deliberately OUT of this cluster; only the nick surfaces
ship here.

**Server invariant recap.** The single source of truth is
`Grappa.IRC.Identifier.canonical_nick/1` — byte-level ASCII, folding
`A-Z` + the four national chars `[ ] \ ~` → `{ } | ^`. Its query-side
twin is `nick_fold/1` (Ecto fragment) and `nick_fold_sql/1` (raw SQL for
`:unsafe_fragment` conflict targets). The fold literal MUST stay
byte-identical everywhere or SQLite silently drops the expression index.

**cicchetto S4 — `rfc1459Fold` used Unicode `toLowerCase()`.** The cic
presence-key mirror over-folded non-ASCII the server never touches
(`CAFÉ`→`café`, `İ`→`i̇`), so two nicks the server keeps as distinct
presence keys collapsed to one client key. Rewritten to fold the `A-Z`
range by char code, byte-for-byte with `fold_nick_byte/1`.

**cross-surface S13 — two client folds, neither pinned.** The client
carried `rfc1459Fold` (presence) AND `nickEquals`/`normalizeNick`
(ASCII-downcase-only, no bracket fold) for one identity invariant — the
"half-migrated creates two patterns" split. Consolidated onto a single
`rfc1459Fold` in the nick-identity module (`nickEquals.ts`), with
`normalizeNick`/`nickEquals` layered on it, so cic now folds nicks
exactly as the server does (this STRENGTHENS the "cic mirrors with
nickEquals" note in the invariant — nickEquals now folds the bracket
range too). `nickEquals.test.ts` enumerates the fold table as the drift
gate, mirroring the server's `nick_fold_sql/1` migration pin.

**cicchetto S5 — bare `.toLowerCase()` compare sites.** Every nick
compare/key that bypassed the fold was migrated onto the shared helper:
queryWindows open-dedup + `canonicalQueryNick`, selection.ts (MRU / live
/ restore query lookups) + Shell.tsx query restore, peerAway store key +
banner lookup, and the pushTriggers DM sender (→ `rfc1459Fold`, mirroring
the server's `canonical_nick(sender) in private_messages_only`). The DM
bracket case landed in the SHARED `shouldNotifyTruthTable` fixture, so
one row pins both the cic mirror and the ExUnit `should_notify?/4` parity
test. Channel-keyed sites (pushTriggers channel, `channelKey.ts`) stay on
Unicode downcase — they mirror `canonical_channel/1`; the channel
casemapping decision (irc S4) is deferred.

**persistence S2 — QueryWindows fold SQL hand-copied.** `Grappa.QueryWindows`
still carried a hand-copied `@nick_fold_sql` literal (the one runtime copy
the 2026-07-19 Notify migration missed), and the fold-drift pin scanned
only migrations — so a fold change would fail loudly on migrations + Notify
yet leave this conflict target drifted, erroring at runtime on the first
contended DM-window open. Now derived from `Identifier.nick_fold_sql("target_nick")`;
the pin test gained a `lib/`-wide scan asserting the fold literal lives in
exactly ONE runtime module (Identifier). Migrations still embed it verbatim
(they run before the app is loaded — no `nick_fold_sql/1` available).

Each finding ships failing-first: S4/S13 assert bracket-fold equality AND
non-ASCII distinctness (the Unicode over-fold the old path broke); S5
proves the fixed sites treat `Nick`/`nick`/`ni[k`/`ni{k` as one identity;
S2's pin goes RED if any runtime module re-introduces a hand-copied fold.

## 2026-07-23 — #364 cicchetto S2: logout/rotation must disconnect() a mid-backoff socket (no zombie reconnect / stale bearer)

**The bug (from the 2026-07-19 codebase review).** Both the logout arm
(token → null) and the rotation arm (a → b) in `socket.ts` gated their
`disconnect()` on `_socket.isConnected()` before dropping the reference
(`_socket = null`). But phoenix.js's native auto-reconnect keeps a live
`reconnectTimer` firing `connect()` while the WS is DOWN — after a BEAM
restart, a network blip, or a handshake that never completed — and in
that window `isConnected()` is FALSE. So a logout/rotation that landed
mid-backoff SKIPPED the teardown and then nulled `_socket`, **orphaning**
an instance whose reconnectTimer kept reconnecting under the STALE
ctor-time `authToken` (the bearer rides the `authToken` subprotocol,
captured ONCE at construction — see the #95/#202 history). Unstoppable,
because the reference was gone: a zombie reconnect loop under the old
identity.

**Root cause — `isConnected()` is the wrong predicate for "should I tear
this down?".** `disconnect()` is the app-callable that resets phoenix's
`reconnectTimer` while the WS is down, and it is a safe no-op on a
non-open socket (its `teardown` handles a null/closed conn). `haltForOffline` and
`kickReconnect` in the same module already rely on exactly this — they
call `disconnect()` on a not-connected socket to cancel the futile
backoff. The two lifecycle arms were the odd ones out.

**The fix.** Drop the `isConnected()` guard in both arms — call
`disconnect()` unconditionally before `_socket = null`. Sibling of the S1
"rebuild ≠ reconnect" fix: S1 made the effects re-JOIN on the rebuilt
socket; S2 makes the old socket actually DIE first. Pinned by two
socket.test.ts cases that hold the mock `isConnected()` at false (the
mid-backoff state) and assert `disconnect()` still fires on logout and on
rotation.

## 2026-07-23 — #364 bucket F: wire-contract drift gates (xsurface S1/S2/S7 + web S1)

Four findings from the 2026-07-19 review, all one class: a contract seam
whose drift NO gate would catch. Each is now closed at compile time
(Dialyzer / tsc / a canary test) rather than at runtime with a
console.warn.

**xsurface S1 — envelope discriminators are LITERAL ATOMS, pinned
end-to-end.** ~10 Wire modules typed their envelope `kind` (and
Session.Wire its window `state`) as `String.t()`. Consequences: codegen
emitted `kind: string`, no literal `WireXEvent` union was pinnable, and
cic restated every literal (`"notify_list"`, `"query_windows_list"`, …,
`state: "pending" | …`) by hand with ZERO compile-time gate — a
server-side rename shipped silently past codegen + `wireTypesAssert.ts` +
tsc, then every event of that kind was dropped at the cic narrower. The
fix is the S14/S15 precedent (already in force for Scrollback
message-kind + ServerSettings `active_host`) applied to the DISCRIMINATOR
field itself: typespec `kind: :notify_list`, builder passes the atom
(Jason stringifies at the JSON edge — WIRE bytes unchanged). Dialyzer now
pins each builder to the literal; the typespec is the single source, so a
rename must edit it. **Rule going forward: a Wire envelope `kind`/`state`
discriminator is a literal atom, never `String.t()`.** cic's hand-rolled
union arms are pinned to the generated literal payloads in
`wireTypesAssert.ts` via `Extract<Union, {kind}>` (kind + full field
shape) — a server rename is now a tsc error. The one production
pre-serialization consumer (`test_support/subject_reset.ex`, matched
`%{state: "joined"}`) moved to the atom in lockstep; test consumers that
matched the Elixir map (`%{kind: "..."}`) moved too, while post-JSON
string-key checks (`"kind" => "..."`) and Phoenix event NAMES stayed
(the wire is unchanged).

**xsurface S2 — codegen preserves `optional(...)`.** `gen_wire_types`'s
`strip_atom_keyed_field/1` matched `:map_field_exact` and
`:map_field_assoc` identically, so `optional(:k) => T` rendered `k: T` —
the generated type OVER-CLAIMED an omitted-when-absent key as required
(`CicWireBundleHashPayload.version` was the live case). Fixed at the
root: the assoc clause tags the key `{:optional, k}` and `do_render`
emits `k?: T`. **Rule: `optional(...)` in a Wire typespec is the
contract for a server-omitted key; codegen renders it `k?:`.**

**xsurface S7 — the biggest payloads are pinned.** WhoisBundle (27
fields, grown twice), WhowasBundle, LusersBundle, Names/WhoReply
envelopes, and the #247 presence arms had generated counterparts but no
`_Assert_`. Added; standalone hand types pin against
`Omit<SessionWireXPayload, "kind">`, inline union arms via
`Extract<WireUserEvent, {kind}>`.

## 2026-07-23 — #364 bucket D: deploy-safety tooling (docker S5/S6/S10)

Three findings from the 2026-07-19 review, all in host-side shell tooling
(`scripts/*.sh`), all guarded by new host-side bats suites under
`test/scripts/` (docker stubbed on PATH; real git for the SRC/REPO
derivation). No behavior change was tested against a real deploy — the
suites assert the invocation SHAPE / control flow.

**docker S5 — `mix.sh --env=prod` injects the matching prod DATABASE_PATH.**
`compose.yaml` interpolates `DATABASE_PATH: /app/runtime/grappa_${MIX_ENV:-dev}.db`
from the HOST shell at container-create time. `mix.sh --env=prod` only
overrode MIX_ENV *inside* the mix process, so a oneshot (or live exec)
still carried `grappa_dev.db` whenever the host MIX_ENV was dev/unset.
`DATABASE_PATH` is read ONLY by runtime.exs's prod branch —
`config/{dev,test}.exs` hardcode the db path and ignore the env var — so a
`--env=prod` task then migrated/read the DEV db believing it was prod.
(The reverse — `--env=dev` on a prod host — is NOT a bug: dev ignores
`DATABASE_PATH` entirely.) Fix: mix.sh injects the matching prod path via
the new `_lib.sh db_path_for_env/1` (the shell-side SoT for the path shape
— kept character-identical to compose.yaml, and reused by `scripts/db.sh`)
for `--env=prod`, and leaves dev/test to their compile-time config
(injecting there would be inert theater — and `grappa_test.db` wouldn't
even match config/test.exs's MIX_TEST_PARTITION suffix). Chose injection
over the review's alternative (derive in `bin/start.sh`, drop the compose
interpolation) because runtime.exs *raises* without DATABASE_PATH and
oneshots bypass start.sh entirely — a start.sh default wouldn't cover the
exact path that reported the bug. **Rule: a mix invocation resolved to
prod MUST carry a matching DATABASE_PATH; dev/test own their path in
config and need no override.**

**docker S6 — the Docker hot path verifies the reload result +
healthchecks.** `scripts/deploy.sh`'s hot branch POSTed `/admin/reload`
and printed "✓ hot-deploy complete" unconditionally. But HTTP 200 is NOT
success: `/admin/reload` reports per-module failures in-band
(`{"reloaded":[...],"failed":[{"module":..,"reason":..},...]}` —
`:old_code_in_use` / `:not_purged`), so a half-failed reload was declared
a success, leaving
the dev/e2e stack silently on stale code — the no-silent-swallow boundary
class, already solved once in the jail twin (`infra/freebsd/deploy.sh`).
Ported that behavior: capture the response, fail on a non-empty `"failed"`
list (same `*'"failed":[]'*` glob the jail path relies on in prod against
the identical endpoint), then run a bounded post-reload `/healthz` probe on
the live node before claiming success. The hot healthcheck loop is
overridable via `HOT_HEALTHCHECK_{RETRIES,SLEEP}` (prod defaults 30×1s) —
deliberately distinct from the cold path's much longer recompile-boot
window.

**docker S10 — deploy scripts guard worktree/branch BEFORE side effects.**
Both scripts side-effected first and only tripped `in_container`'s
worktree guard afterwards. `deploy-cic.sh` had NO branch guard at all and
rebuilt `runtime/cicchetto-dist` (the bundle nginx serves — swapped on
disk) before dying at the broadcast POST: dist deployed from a worktree /
feature branch, non-zero exit, no refresh banner. `deploy.sh` ran
`git pull` in REPO_ROOT then died at the same late guard — tree updated,
BEAM stale; worse, its own branch guard ran AFTER `cd REPO_ROOT`, so it
checked main's branch and never caught a worktree at all. Fix: a shared
`_lib.sh require_main_checkout/1` (asserts `SRC_ROOT == REPO_ROOT` AND
`branch == main`, `ALLOW_DEPLOY_FROM_BRANCH=1` overrides the branch check)
called as the FIRST step of both scripts, before any pull/build. Replaces
deploy.sh's ineffective inline branch guard; gives deploy-cic.sh the
branch guard it never had. **Rule: deploy scripts assert the main-checkout
invariant up front — a guard that fires after the side effect is not a
guard.**

**web S1 — FallbackController @spec ↔ clause lockstep is now a canary.**
The `@spec call/2` error union had drifted six tags behind its clauses.
Beyond adding them, `FallbackControllerTest` now parses every
`def call(conn, {:error, TAG})` head from source AST and the atom set of
the spec union (expanding `Admission.error()` via the production canon +
the Captcha type) and fails loud on drift in either direction — the same
shape as the existing capacity_error matrix.

## 2026-07-23 — Channels fold rfc1459 like nicks (GH #364 E/irc-S4)

**Reverses the channels-are-Unicode-downcase decision.** UX-4 bucket A
(2026-05-18) case-folded channels with Unicode `String.downcase/1` and
#121 (2026-06-28) folded *nicks* with rfc1459 — leaving the server with
TWO casemappers and `canonical_channel/1`'s own docstring stating it was
"distinct from `canonical_nick/1`". The 2026-07-19 codebase review
(irc S4) flagged the split as a decision needed, because the ircd does
NOT split it: bahamut (azzurra) runs `CASEMAPPING=rfc1459` for **channel
names too**, not just nicks. The Unicode downcase was wrong two ways at
once against the ircd's own rule:

  * it FAILED to fold the four rfc1459 national chars `[ ] \ ~` →
    `{ } | ^`, so `#chan[1]` and `#chan{1}` — one channel to the ircd —
    forked into two windows / scrollback streams / read-cursors.
  * it OVER-folded non-ASCII (`#CAFÉ` → `#café`), MERGING two channels
    the ircd's ASCII casemapping keeps distinct.

vjt resolved the design call: **converge, honour the ircd.**
`canonical_channel/1` now shares ONE byte-level `fold_rfc1459/1`
primitive with `canonical_nick/1` (sigils sit outside the fold set, so
folding the whole name leaves the sigil intact and folds the body
identically to a nick). One casemapping for every server-side
identifier — "total consistency or nothing".

**Channel pattern ≠ nick pattern — deliberately NOT #121's expression
index.** #121 used a UNIQUE **expression index** on the rfc1459 fold of
`query_windows.target_nick` *because a nick is stored RAW* (case is
display-meaningful — sender badges, `dm_with`). Channels are the
opposite: they have always been stored **canonical** (folded at write in
the changesets) with a **plain `==`** lookup + plain index, corrected by
a one-shot backfill (`backfill_lowercase_channels`). Grafting the nick
expression-index pattern onto channels would have converted them AWAY
from their own established pattern (and added fold-in-lookup churn + new
indexes on the hot `messages` write path) for zero benefit, since
canonical storage already makes new writes converge. So #364 extends the
**channel** pattern: `canonical_channel/1` folds rfc1459 at every write
boundary, lookups stay plain `==`, and `20260723120000_fold_channels_rfc1459`
re-folds historical bracket rows (messages UPDATE; read_cursors +
network_featured_channels collapse bracket-collisions then UPDATE; the
two JSON channel arrays rebuild via `json_each`). Non-ASCII merges from
the old downcase are NOT un-merged — the original case is unrecoverable,
and the stop-merging fix is the going-forward ASCII-only fold, not a
historical rewrite. The fold SQL is byte-identical to
`Identifier.nick_fold_sql/1` (the `IdentifierTest` drift pin covers the
new migration). Cold deploy (new migration).

**Two bare-`String.downcase` channel compares folded too.**
`SessionPlan.merge_autojoin/2` (dedup of operator autojoin vs last-live
snapshot) and `ChannelDirectory.Wire.mark_featured/2` (featured-label
join) both keyed on `String.downcase`, which silently diverges from the
new byte-fold on bracket channels; both now fold via
`canonical_channel/1`. `channel_directory.name` itself STAYS verbatim
(case-preserving /LIST display, like a nick) — only the featured compare
folds.

*Lesson: "do it like #121" was the spec, but #121's expression-index
shape was FORCED by raw nick storage for display — a constraint channels
don't share. The right move was to read how channels are ALREADY stored
(canonical + backfill) and extend THAT, not copy the nick mechanism. A
pattern doesn't transfer just because the two problems rhyme; check
which invariant forced the original shape first.*

## 2026-07-23 — #364 bucket J: runtime DI-seam `Application.get_env` → `:persistent_term` boot boundary (cross-module S2)

The codebase review's cross-module S2 finding: three dependency-inversion
seams resolved their injected impl via a **per-call `Application.get_env/2`
read at runtime** — the pattern CLAUDE.md bans ("Application.{put,get}_env:
boot-time only, runtime banned"). Left as-is it propagates: the next seam
copies the closest example. vjt resolved: **migrate clean.**

The three seams:

  * `Grappa.Push.BadgeSource.impl/0` — `:badge_source` (door #1 PWA badge
    count, resolved on the Session→Push hot path via `Push.Triggers`).
  * `Grappa.WindowCounts.PushSource.impl/0` — `:window_counts_push_source`
    (#267 per-message push, called from BOTH `Session.Server`'s persist arm
    AND `ReadCursorController`).
  * `Grappa.Themes.BackgroundImage.fetcher/0` — `:themes[:image_fetcher]`
    (theme background fetch-by-URL, called from the `Themes` context ← a
    controller).

**Why NOT `start_link` opts (the rule's headline mechanism).** The rule's
"pass config via `start_link/1` opts" prescription is written for
GenServers. All three seams are **stateless resolver modules** reached from
controllers / context functions / a hot path threaded through other
processes — none has a `start_link` of its own, and two are reached from
per-request controller/context code with no process to inject into. Forcing
`start_link` would mean either a half-migration (two patterns — the exact
"total consistency or nothing" trap) or an invasive refactor threading the
impl through `Session.Server` state + controller conns. That is the "casino
totale" vjt's HALT gate was set to catch.

**The clean fit already existed: the `:persistent_term` boot boundary.**
`Grappa.Admission.Config` / `Grappa.Uploads` / `Grappa.HttpHosts` /
`Grappa.Push` already read their env ONCE at boot into `:persistent_term`
and read it lock-free at runtime — the review named this exact target ("the
boot-time `:persistent_term` rule"). Each seam now has a `boot/0` called
from `Grappa.Application.start/2` (before the supervision tree) that stashes
`Application.get_env(...)` into a `{Module, :key}` persistent_term entry; the
runtime resolver reads `:persistent_term.get(key, default)`. The config
value stays a **module atom read from env**, never a literal — so the
Boundary cycles the seams break (`Push → BadgeCount → …`, `Session → Pusher
→ …`) stay broken. The `get/2` **default preserves each seam's documented
degradation**: `nil` (BadgeSource/PushSource → hot-deploy no-op / omit
badge) or the real `ImageFetcher.Req` (BackgroundImage → graceful real
impl) in the transient window after a hot code load but before `boot/0`
re-runs.

**Test injection: helper, not `Application.put_env`.** BadgeSource +
PushSource expose a `Mix.env() == :test`-gated `put_test_impl/1` (mirrors
`Admission.Config.put_test_config/1`); tests set/restore the seam through it.
BackgroundImage needs no helper — its one test impl (`ImageFetcherMock`) is
injected via `config/test.exs`, which `boot/0` reads at app start; the
existing url-path tests resolve the mock through boot→persistent_term and are
the behavioral guard.

**Boundary.** `Grappa.WindowCounts` + `Grappa.Themes` join
`Grappa.Application`'s boundary deps for their boot calls (acyclic — nothing
deps the top-level app). `BackgroundImage` stays INTERNAL to the Themes
context: its boot is exposed via a context-level `Grappa.Themes.boot/0`
delegate rather than widening Themes' exports with a security-sensitive
module. No call site changed — only the internal resolution mechanism.

*Lesson: the rule's headline mechanism (`start_link` opts) is not the rule
— the INTENT is "read config once at boot, never per-call at runtime; let
tests inject without runtime config tricks." For non-process seams the
codebase's OWN `:persistent_term` boot boundary satisfies that intent; the
review even named it. When the literal instruction doesn't fit the shape,
check whether the codebase already has a blessed pattern for that shape
before forcing the instruction into a mess.*

## 2026-07-23 — DM peer folds rfc1459 on EVERY match (GH #372)

Bug (reported on #grappa, testnet): `/msg debugserv HELP` opened a query
window keyed `debugserv`; the service replied as `DebugServ` (proper case)
and the reply landed in a SEPARATE, archived `DebugServ` window — a phantom
split by nick casing. The opened window "looked dead" (no replies), and
deleting EITHER window deleted both while their contents stayed unmerged.

Root cause spanned server + cic (the report framed it cic-only; the
evidence — a HALT + vjt ruling — said fix both). `dm_with` is stored
case-PRESERVED at write (`Scrollback.Message.canonicalize_channel/1`
deliberately leaves it raw — it is a NICK column, display-case-meaningful,
exactly like `query_windows.target_nick` under #121). The design is
therefore **store raw, MATCH folded**. But only `delete_for_dm/3` folded
(via `Identifier.nick_fold/1`); the two READ paths matched RAW:

  * `Scrollback.channel_or_dm_where/3` peer-DM branch — `m.dm_with ==
    ^channel` (raw). A `debugserv` REST fetch missed the `DebugServ`-cased
    inbound rows → the window's scrollback was empty on reload.
  * `Scrollback.list_archive/3` — `GROUP BY COALESCE(dm_with, channel)`
    (raw) → `debugserv` + `DebugServ` split into TWO archive entries, and
    the active-keyset exclusion (`MapSet.member?`) was case-sensitive so an
    OPEN `debugserv` window failed to suppress its `DebugServ` variant.
  * cic `subscribe.ts installDmListenerHandler` re-keyed the live append on
    the RAW sender (`channelKey(slug, message.sender)`) → the inbound reply
    landed in a phantom in-memory bucket the opened window never rendered.
  * cic `archive.ts visibleArchiveForNetwork` compared live windows with a
    raw `Set.has` → left the archived split visible in the sidebar.

That "delete folds, read/display don't" asymmetry IS the "delete either
deletes both, yet contents split" inconsistency the report pinpointed —
and a straight violation of the CLAUDE.md nick invariant ("EVERY
server-side nick compare routes through `canonical_nick`/`nick_fold`,
never a bare `==`"). `delete_for_dm` even *claimed* in its docstring to
mirror `channel_or_dm_where/3`; it didn't.

Fix — fold the peer on ALL match sites, one shared primitive per surface:

  * server: extracted `Scrollback.where_dm_peer/2` — the single
    rfc1459-folded DM-peer WHERE (both DM directions + the `dm_with IS
    NULL` orphan-channel arm for 401 NOTICEs) — now shared by
    `channel_or_dm_where/3` (read) AND `delete_for_dm/3` (delete), so read
    + delete pick ONE identical window key. Bonus: the no-session
    (`own_nick = nil`) own-nick fetch now shows self-msgs only (folds on
    the peer) instead of leaking every inbound DM via the raw
    `channel == own_nick` arm — the CP14-B3 leak, closed for the
    no-session path too.
  * server: `list_archive/3` groups by `nick_fold(COALESCE(dm_with,
    channel))` (casing variants collapse to ONE entry; the displayed
    `target` is the bare COALESCE from the `max(server_time)` row via
    SQLite's documented bare-column rule, so display casing = the most
    recent spelling) and excludes on the fold of BOTH sides.
  * cic: `installDmListenerHandler` re-keys via
    `queryWindows.canonicalQueryNick` (the existing OUTGOING-side helper,
    #364 E/S5) — the live-WS mirror of the server window key; the beep
    focus check + `routeMessage` displayName use the same canonical peer.
    The peer-NOTICE own-echo guard moved from raw `!==` to `!nickEquals`.
  * cic: `visibleArchiveForNetwork` folds every comparison via
    `normalizeNick` (idempotent on server-canonical channels; ASCII-only,
    so non-ASCII variants stay distinct — matching the ircd + the server).

Coverage: server ExUnit (`#372` describe — fetch converges across casings
+ rfc1459 brackets; archive collapses + excludes a folded-active window),
cic vitest (`subscribe.test.ts` canonical re-key; `archive.test.ts` fold
exclusion), and an incoming-direction e2e (`nick-case-incoming.spec.ts`,
sibling of the OUTGOING `nick-case-sensitivity.spec.ts`).

*Lesson: "store raw for display, match folded" is only correct if EVERY
match folds. A single raw `==` on a fold-identity column silently forks
the window — and one that folds on delete but not on read is worse than
one that never folds, because the operator sees "delete removed both" and
assumes one window while the data is two.*

## 2026-07-23 — Query window follows a peer NICK change (GH #373)

Third query-window-identity bug after #371 (services allowlist) and #372
(incoming casing fold), but **distinct from the fold family**: the peer
genuinely RENAMES (`old ≢ new` — different identity, not a casing of one),
and nothing migrated the window `old → new`. So an open query kept the
stale nick, and outbound sends routed to the vanished nick →
401 ERR_NOSUCHNICK. #372's fold does not help (old and new fold to
different keys). The repro: open a query with `Guest87449`; the peer
renames `Guest87449 → NickTemporaneo`; the window stays on `Guest87449`
and every send bounces.

**Server-authoritative, per the window-state invariant.** Query windows
are server-owned ("cic NEVER originates state"), so the server observes
the NICK and drives the migration; cic mirrors the sidebar via the
existing `query_windows_list` broadcast and only migrates its OWN
in-memory caches. A cic-first optimistic rename would have forked the
pattern into a parallel client state machine.

  * **`Grappa.QueryWindows.rename/5`** — fold-matches (#121) the `old`
    row. `fold(old) == fold(new)` (a case-only NICK) is `:noop`: the
    row already resolves via the fold and IRC routing is
    case-insensitive, so nothing moves (#372 owns the display dedup). No
    row folding to `old` is `:noop` too (a peer we never queried). A
    genuine rename is an `UPDATE target_nick = new`; a **nick-collision**
    (a window already folds to `new`) instead MERGES — delete the `old`
    row, keep the existing `new` — because the two DM histories coalesce
    under one folded key on the read path anyway (the #372 fold-dedup:
    one window per folded identity). Broadcasts `query_windows_list` only
    on `:renamed`.
  * **`Grappa.ReadCursor.rename_dm_peer/4`** — migrates the DM read
    cursor row (`channel = peer`, stored case-preserved, matched folded)
    old→new, else the migrated history reads FULLY unread under the new
    window (no cursor row → `WindowCounts` derives from `cursor || 0`).
    Same keep-new merge + `Ecto.ConstraintError`-rescue-to-merge as
    `QueryWindows.rename/5`. Missed in the first cut, caught in code
    review: adding it keeps the "migrate every store of the moved
    identity" invariant honest. Its `Networks` dep demoted to a
    struct-only `dirty_xref` for the same `Session → ReadCursor →
    Networks → Session` cycle reason as `QueryWindows`.
  * **`Grappa.Scrollback.rename_dm_peer/4`** — migrates the DM rows so
    history survives under the new window (else `channel_or_dm_where/3`,
    which reads the peer window by the fold of the peer nick, returns
    nothing and the conversation vanishes on reload). Two scoped UPDATEs
    keyed off the DM row shapes from `dm_peer/4`: `dm_with := new` where
    `fold(dm_with) == fold(old)` (the peer column on BOTH inbound
    `channel=own_nick,dm_with=peer` and outbound `channel=peer,dm_with=
    peer` rows) and `channel := new` where `fold(channel) == fold(old)`
    (outbound + orphan `dm_with IS NULL,channel=peer` rows — e.g. a 401
    NOTICE). Inbound rows keep `channel=own_nick` (folds ≠ old); channels
    carry a sigil so `#old` never cross-hits a bare nick. The distinct
    migrated-row count comes from the shared `where_dm_peer/2` predicate
    (the union of the two UPDATEs), so the two column writes don't
    double-count.
  * **Wiring:** `EventRouter.do_route(:nick)` emits
    `{:peer_nick_renamed, old, new}` for a PEER rename with a shared
    channel (`not nick_eq?(old, state.nick) and channels != []` — the
    only case IRC delivers the NICK, mirroring the per-channel fan-out
    gate). `Session.Server.apply_effects/2` renames the window, then
    migrates the scrollback ONLY on `:renamed` — so a peer we never
    queried costs one indexed lookup and no writes.
  * **cic:** the server broadcast relabels the sidebar row (server-owned
    list). But cic-OWNED caches don't ride that broadcast — the live
    in-memory scrollback (keyed `(slug, nick)`), the read-cursor cache,
    and THIS device's focus. On the per-channel `nick_change`,
    `subscribe.ts` calls `scrollback.renameScrollbackKey` (move + merge
    the live rows), `readCursor.renameReadCursorChannel` (move the cursor
    — the server `rename_dm_peer` does NOT broadcast a `read_cursor_set`),
    and `selection.followQueryNick` (re-point focus if that query is
    selected — the focused-window case is the repro: without it the next
    send still targets the stale nick and 401s). The old key is resolved
    via `canonicalQueryNick` first, because the caches key on the window's
    STORED casing which can differ from the NICK line's sender casing
    (#372). Gated to a PEER (`sender ≠ ownNick`) genuine rename
    (`old ≢ new` under rfc1459). Mirrors `members.ts` renaming a member on
    NICK — cic-owned cache maintenance, NOT window-list origination. Own
    self-rename rides `own_nick_changed`.

**Boundary knock-on:** `Session` now depends on `QueryWindows` +
`ReadCursor` (for their `rename`s), which would close the cycle
`Session → {QueryWindows,ReadCursor} → Networks → Session`. Fixed by
demoting BOTH contexts' `Networks` dependency to a struct-only
`dirty_xref` — the `Network` reference is a `belongs_to` FK + a schema
query only, exactly the shape `Scrollback` already declares as a dirty
xref for the same cycle-avoidance reason (`ReadCursor` had `Networks` as
a real dep pre-#373; #373 demotes it too).

**Out-of-scope boundaries (documented, not bugs):**
  * No shared channel → IRC never delivers the peer NICK → the window
    cannot follow. Protocol limit, not a defect.
  * A CLOSED window's archive (row deleted, history remains) does NOT
    follow a later rename (`:noop`, no scrollback migration) — the
    primary fix targets the OPEN window.
  * Own-nick self-msg window following an OWN rename is handled via
    `own_nick_changed`, not here (peer renames only).

Coverage: server ExUnit (`QueryWindows.rename/5` — genuine/merge/case-
only/fold/scoped; `Scrollback.rename_dm_peer/4` — both directions +
orphan + own-nick-channel-untouched + fold; `ReadCursor.rename_dm_peer/4`
— migrate/fold/case-only/merge/scoped + a visitor parity case;
`EventRouter` peer-vs-own emit; a `Session.Server` end-to-end
NICK→window+history), cic vitest (`renameScrollbackKey` move/merge/no-op;
`renameReadCursorChannel` move/merge/no-op; `followQueryNick` selected/
not-selected/kind/slug), and an e2e (`nick-follow-query.spec.ts`:
relabel + history + a post-rename send that REACHES the renamed peer,
proving no 401).

*Lesson: the fold family taught "match folded" — but a RENAME is a
different problem than a CASING. `old ≢ new` means the identity actually
moved, so the fix is a MIGRATION (rename the row + its history), not a
match. Reusing #372's fold here would have been a category error; the
right question was "what stores the OLD nick, and does it move?" —
QueryWindows row, DM `dm_with`/`channel`, cic scrollback key, cic
selection. Enumerate every store of the moved identity, migrate each.*

## 2026-07-23 — Services allowlist gains Azzurra pseudo-services (GH #371)

Azzurra (bahamut) exposes three pseudo-services absent from the closed
services allowlist: **SeenServ**, **StatServ**, **DebugServ**. Their
inbound NOTICE/PRIVMSG replies therefore fell through
`EventRouter.route_non_channel_notice_non_chanserv/2`'s `valid_nick?`
arm and opened a stray per-nick query window instead of landing on the
synthetic `$server` channel — they looked like they "went into the void"
from cic while working normally from weechat. Added to the allowlist so
they route identically to NickServ et al.

**The issue was filed as cic-only; that framing is incomplete.** The
routing source of truth is server-side —
`Grappa.IRC.Identifier.services_sender?/1`, consumed by EventRouter's
inbound NOTICE (`route_non_channel_notice_non_chanserv/2`) and PRIVMSG
(`privmsg_default/3`) arms — NOT cic. The cic `SERVICES` set
(`servicesSender.ts`) only governs the OUTBOUND compose path (suppress
the optimistic query-window open for `/msg SeenServ ...`). Fixing the
INBOUND symptom the issue describes REQUIRES the server allowlist; a
cic-only change cannot move a service NOTICE to `$server`. Both are
extended in lockstep — as the code comments in both files have always
demanded ("future *serv variants need an explicit add here AND on the
server in lockstep") and as RootServ ("already works") demonstrates by
being in both. This is the UX-4 bucket G "one predicate, every door"
contract: outbound no-persist (Session.Server), inbound `$server`
(EventRouter), REST classification (MessagesController) all read the
same closed allowlist.

**Interaction with #372.** #372 used `DebugServ` as a *fixture* for the
DM-peer casing-fold bug (a window OPENED as `debugserv`, the service
replying as `DebugServ`, folding to one archive entry). Now that
DebugServ is a service, its inbound replies route to `$server`, never a
query window — which is the DELIBERATE #371 outcome ("a services query
window would just sit empty"). The #372 tests operate at the Scrollback
layer (not routing), so they stay green; the fold family still applies
to genuine peer nicks.

**Deploy:** server change → needs a COLD deploy (the `@services` module
attribute is compiled in). cic bundle ships the mirror. No integration/
e2e coverage is possible for the new nicks (the testnet has no live
pseudo-service responder); proof is unit-level on both doors —
`EventRouter` routing test (`#371 SeenServ / StatServ / DebugServ
NOTICEs route to $server`, exercising production routing, with the
`Conserv` guard proving allowlist membership is what flips it) + the
`services_sender?/1` accept test + the cic `isServicesSender` accept
test. Also closed two pre-existing gaps found while here: the identifier
property-test allowlist mirror was missing `rootserv`, and both accept
tests now cover the full 11-entry set.

**Out of scope (separate observation in the issue):** a ~10s lag on the
StatServ reply itself smells server/services-side (routing / StatServ
latency), not the client allowlist — filed as its own look.

*Lesson: "cicchetto: X is missing from cic's allowlist" is a symptom
report, not a scope boundary. When the symptom is inbound routing, the
SoT is the server — challenge a client-only fix direction against where
the behavior actually lives before building.*

## 2026-07-23 — #373 peer-NICK migration: broadcast AFTER migrating history (rename-order fix)

The #373 peer-NICK migration (`Session.Server.apply_effects/2` on
`{:peer_nick_renamed, old, new}`) broadcast the `query_windows_list`
event from **inside** `QueryWindows.rename/5`, BEFORE it migrated the DM
scrollback + read cursor. The broadcast is a PubSub message, so any
consumer reacting to it — a cic client OR the #373 Session.Server test —
raced its follow-on `Scrollback.fetch(new_nick)` against the
not-yet-migrated rows and could read `[]`.

**How it surfaced:** the #373 test `server_test.exs` "peer NICK migrates
the open query window + its DM scrollback old -> new" failed in CI
(`ci` run on #371's merge, amid a bahamut-autokill `tcp_closed` storm)
AND reproduced deterministically in isolation locally (`--repeat-until-
failure` failed on iteration 1), while passing under full-suite
scheduling load. That iso-fail / full-suite-pass split is the fingerprint
of a real process-scheduling race, NOT a load flake — the test's
`assert_receive query_windows_list` was an INVALID sync point for the
scrollback read because the broadcast preceded the migration.

**Fix — decouple the broadcast from the DB rename:**
  * `QueryWindows.rename/5` → `rename/4`: does the DB write only, returns
    `{:ok, :renamed | :noop}`, no broadcast. Dropped the now-unused
    `subject_label` param (it existed only to feed the internal
    broadcast).
  * `broadcast_windows_list/2` made public.
  * `apply_effects/2` on `:renamed`: migrate scrollback → migrate cursor
    → THEN `QueryWindows.broadcast_windows_list/2`. The
    `query_windows_list` event is now a truthful "rename fully applied"
    barrier: any consumer reacting to it is guaranteed the DM history has
    already moved old→new.
  * `open/4` / `close/4` keep broadcasting inline — they have no
    follow-on migration to order the broadcast against.

**Verification:** the existing #373 Session.Server test becomes the
regression proof (racy-fail → deterministic-pass across 200 iso
`--repeat-until-failure` runs). The QueryWindows unit test that asserted
`rename` broadcasts now asserts it is broadcast-free (the new contract);
broadcast-after-migration is covered end-to-end by the Session.Server
test. Full `check.sh` green (4046 tests, dialyzer 0 errors).

**Provenance:** pre-existing race in the #373 code (commit `8ef221d7`),
NOT introduced by #371 — #371's diff is orthogonal (services allowlist;
`server.ex`/`scrollback.ex`/`query_windows.ex` untouched). Surfaced by
#371's post-merge CI, root-caused, and fixed here.

*Lesson: a PubSub broadcast is only a valid test/consumer sync point for
state the broadcaster has ALREADY committed before emitting it. When an
effect handler broadcasts mid-sequence and then keeps mutating, the
event lies about "done." Emit the broadcast LAST, as a barrier — or the
consumer races the tail of your own callback. "Passes in the suite, fails
in isolation" is a race signature, not spec-rot: investigate before
masking.*

## 2026-07-23 — #327 reopen: the deferred scroll still landed the tab UNDER the sticky header

**Premise correction.** The reopen prompt framed the remaining work as "apply
the double-rAF defer." Scoping against `main` showed that fix was **already
merged AND deployed** (`5d44b7f8`, prod `--cic` 2026-07-20, bundle `CM2Tel4n`)
— with its unit + e2e proof. The issue had been **reopened the same day** for a
DIFFERENT symptom: after the shipped defer, tapping next-active still left the
target channel tab **occluded under/behind the network tab**. Not the
stale-geometry bug — a second, orthogonal one. (Directions over code: the spec
inherited a stale premise; the fix is not what it said.)

**Root cause (traced, not guessed).** The network header is
`position: sticky; left: 0; z-index: 1` (#260, 2026-07-16 — landed AFTER the
original #327 design). `scrollIntoView({inline:"nearest"})` brings the selected
tab **flush to the scroller's leading edge** — which is exactly where the sticky
header is pinned — so the tab ends up UNDER it, z-index'd behind. `scrollIntoView`
has no notion of a sticky element's occupied strip; `inline:"nearest"` treats the
container edge as the target, not "edge + header width." The original e2e never
caught it because it drives a RIGHT-edge overflow (tab lands at the right, far
from the left-pinned header) and its `withinLeft` check only asserts the tab is
within the bar's bounds, not that it clears the header.

**Fix — compute scrollLeft manually inside the (kept) double-rAF.** Drop
`scrollIntoView`; the effect now reads geometry and nudges `scrollLeft` itself.
The visible region EXCLUDING the pinned header is
`[scrollerLeft + headerWidth, scrollerRight]`; bring the selected tab's near edge
to that boundary: if `tabRect.left < scrollerLeft + headerWidth` it's occluded →
scroll it clear past the header; else if `tabRect.right > scrollerRight` it's
clipped right → reveal at the right edge; else (already visible) `delta 0`, no
scroll. `headerWidth` is read from the target tab's OWN
`.bottom-bar-network`'s header (sticky is per containing block, so the header
pinned over a visible tab is that tab's group header) — robust to variable slug
widths, no magic constant. Two guards from code review: when the selected tab IS
the header (the server-window tab is itself `.bottom-bar-network-header`) it is
its OWN occluder, so `headerWidth` is 0 — never self-subtract, or selecting a
server window jerks the strip left by the header width; and sub-pixel deltas
(`Math.abs(delta) < 1`) don't scroll, so a fractional `getBoundingClientRect`
diff can't fire a smooth animation for a visually-zero move. Horizontal only
(`scroller.scrollTo({left, behavior: "smooth"})`) so page vertical scroll is
never touched — the job `block:"nearest"` used to do. The defer + re-query of `.bottom-bar-tab.selected` inside the settled
callback are UNCHANGED (still needed for the badge-reflow width change).

**One effect, all triggers** (unchanged): every selection change funnels through
`selectedChannel`; the manual scroll lives in the one effect and covers every
door. No regression to the #243 re-tap → `requestScrollToBottom` path.

**Verification.** Unit (`BottomBar.test.tsx` #327 block, rewritten): jsdom does
no layout, so we inject geometry via `getBoundingClientRect` stubs and prove the
effect (1) does NOT scroll synchronously, (2) does NOT scroll after one rAF, (3)
after the second rAF scrolls the selected tab CLEAR of a 60px sticky header
(occluded tab at `left:10` under `visibleLeft:60` → `scrollTo({left:50})` from
`scrollLeft:100`), and (4) re-queries the LIVE selection — a mid-flight switch
scrolls the NEW tab's geometry (`left:100`), never the stale one's (`left:-50`).
RED pre-fix: the `scrollIntoView` code never calls `scrollTo`. Full cic gate green
(`bun run check` 0 errors, `bun run build` real tsc, `vitest` 3096/3096). The
VISIBLE occlusion outcome — tab left edge clears the sticky header on a device —
is **owed a real-iOS verify** (Playwright WebKit ≠ iOS scroll timing; a
left-jump next-active e2e would be flake-prone on the shared bahamut stack, so it
is deferred to device verify, not faked green). Client-side only — no cold deploy.

*Lesson: `scrollIntoView` is blind to `position: sticky`. When a scroll container
has a sticky leading-edge element, "scroll into view" must subtract that element's
occupied strip — `scrollIntoView({inline:"nearest"})` will faithfully park the
target UNDER it. Compute the scroll manually against the sticky-excluded visible
region. And: a green e2e that asserts "within bounds" does NOT assert "not
occluded" — bounds ≠ visibility when something is painted on top.*

## 2026-07-23 — #344 TopicBar: topic line-height bump + column top-align (cic)

vjt dogfood (#grappa): the two-line topic strip read too cramped. Raised
`.topic-bar-topic` `line-height` 1.25 → 1.5 for breathing room, and top-aligned
the two columns (`.topic-bar` `align-items` center → flex-start) so topic
line-1 sits beside the channel name and topic line-2 beside the +modes line
instead of both columns centering as whole blocks.

**The coupling (re-application of the #262/#307 gotcha — the reason this note
exists):** the topic strip's real height bound is NOT `-webkit-line-clamp`. The
strip is a `<button>` wrapping `<MircBody>`, and WebKit wraps a button's
children in an internal box that defeats the clamp — so the clamp only paints
the trailing … on the inner `.topic-bar-topic-text` span, while the actual
height cap is a HAND-COMPUTED `max-height` = N-lines × line-height. Any
line-height change MUST therefore be mirrored into EVERY manual max-height, in
lockstep, or the last line clips:
- base `.topic-bar-topic-text` `max-height` 2.5em → 3em (2 × 1.5)
- landscape-compact 1-line override `max-height` 1.25em → 1.5em (1 × 1.5) — the
  `@media (orientation: landscape) and (max-height: 500px)` tier overrides the
  clamp count + height but NOT the line-height, so its single line inherits lh
  1.5 and needs the matching 1.5em cap.

The #262 e2e witness (`issue262-topic-clamp-mobile.spec.ts`) still passes
unchanged: the taller strip is now 2 × 1.5 × 14px = 42px, comfortably under its
60/120/50 caps (the caps were generous-slack bounds, not exact-fit), so only its
explanatory comments were retargeted to the new calc — no threshold moved.

Part 2 (top-align) is the "il top sarebbe" stretch: fine baseline rhythm between
the two columns (bold base name + border-bottom vs 0.85rem mode vs 2× mono topic
@ lh 1.5) is a tune-by-eye visual match, **device-verify owed** (Playwright
WebKit ≠ iOS). Pure CSS, client-side — no cold deploy. cic gate green (biome +
tsc + vite build + vitest 3097/3097).

*Lesson: when a manual `max-height` stands in for a clamp the engine won't
honour, that number is line-height × N frozen at author time — it does not
track the line-height. Every future line-height edit on the topic strip must
re-touch all its max-height overrides (base + every media tier) in the same
commit, or a tier silently clips. The clamp is decoration; the max-height is the
contract.*

---

## 2026-07-23 — Autojoin waits for upstream +r on `:nickserv_identify` (GH #347)

**The bug.** For a credential using `auth_method: :nickserv_identify`, the
autojoin JOIN loop fired on `001 RPL_WELCOME` (`Session.Server`'s numeric-1
handler). But that method sends `PRIVMSG NickServ :IDENTIFY <pw>` on 001 too
(`IRC.AuthFSM.maybe_nickserv_identify/1`), and the upstream processes it
**asynchronously** — the identity confirmation (self umode `+r`) lands *after*
001. So the JOINs went out while still unidentified: on Libera-class networks
`+R` (registered-only) channels reject with `477 ERR_NEEDREGGEDNICK`, and
ChanServ won't grant `+o` (ops only for identified users). SASL is unaffected —
it identifies *before* 001, so the 001 autojoin already sees `+r`.

**Decision (vjt, 2026-07-20) — identify-first + short bounded wait, NO NickServ
NOTICE-text parsing.** For `:nickserv_identify` credentials, defer the autojoin
JOINs until the **earlier** of:
- the self-`MODE +r` echo — surfaced by EventRouter's existing self-MODE fold as
  `{:session_identity_changed, :acquired}` (the `+r` *umode*, not NickServ
  text-scraping — the same bit `#215` already watches for the identity
  session-log event); or
- a **~0.5s** fallback timeout (`@autojoin_defer_ms 500`, opts-overridable via
  `:autojoin_defer_ms`) — so a silent/slow/`+r`-less NickServ never hangs
  autojoin: on elapse, JOIN best-effort (non-`+R` channels still work).

**Mechanism.** `Session.Server` gains three state fields: `auth_method` (the
honest discriminator — the change is scoped to `:nickserv_identify` only),
`autojoin_defer_ms` (config default + test seam), and `autojoin_defer_timer`
(the one-shot latch). At 001, `maybe_autojoin_or_defer/1` either fires
immediately (SASL/`:none`/`:server_pass`/`:auto`, or an empty autojoin set) or
arms the fallback timer and defers. Both deferred triggers — the `:acquired`
`apply_effects` arm and the `:autojoin_defer` `handle_info` — funnel through
`fire_deferred_autojoin/1`, whose latch (non-nil timer ⇒ still pending; the
first trigger cancels-and-drains the other) guarantees the JOINs fire **exactly
once**. The 001-path JOIN reduce was extracted to `fire_autojoin/1` so both the
immediate and deferred paths share one wire emitter (implement-once).

**Alternatives rejected.** (1) *Strict `+r` gate, no timer* — deferring solely
on `+r` hangs autojoin forever if NickServ never answers; the ~0.5s fallback is
exactly that fix. (2) *Retry on `477`* — keep firing at 001 and re-JOIN rejected
`+R` channels post-identify: more moving parts, and it eats an initial reject
per `+R` channel; superseded by identify-first, which avoids the reject entirely.
(3) *Parse the NickServ IDENTIFY NOTICE* — banned; NOTICE-scraping is accepted
only for the auto-registration wizard (#349), never for identify.

**SASL non-regression is structural**, not a special case: only
`auth_method == :nickserv_identify` arms the timer, so every other method leaves
`autojoin_defer_timer` nil and `fire_deferred_autojoin/1` no-ops even if a stray
`+r` echo arrives later. A `:lost` transition never triggers autojoin.

Server-side change → **cold deploy**. Covered by four deterministic
`Grappa.IRCServer`-fake tests (real TCP + real `IRC.Client` + real
`Session.Server`): deferral-past-001, `+r`-trigger, fallback-timeout-trigger,
exactly-once dedup, plus explicit SASL-fires-on-001. Per vjt (2026-07-23) the
fake tests are the integration coverage for this server-only change (no cic
surface); the full browser integration suite runs as the post-merge GH CI gate.

*Lesson: an async identity handshake is a HAPPENS-AFTER edge the connect-time
fast path can't assume away. When a downstream action (autojoin) depends on an
upstream state (`+r`) that arrives on its own schedule, gate on the state's
own signal with a bounded fallback — never on a proxy event (001) that merely
tends to precede it, and never by scraping human-readable NOTICE text when a
structured protocol bit (the umode) already carries the fact.*

## 2026-07-24 — Whole message pane is the file-drop target (GH #351, cic)

**The gap.** File-upload drag-drop was scoped to the ComposeBox `<form>` only
(`onDragOver`/`onDrop` on the compose element). A file dropped over the
**scrollback** — the large part of the screen — did nothing; the operator had
to aim at the small compose strip.

**Decision.** Hoist the drop target up to the whole conversation pane. A new
`DropUploadZone` component (in `Shell.tsx`) wraps the vertical `TopicBar +
ScrollbackPane + ComposeBox` stack in **both** the desktop and mobile Match
blocks; a file dropped anywhere over it uploads exactly as a compose-box drop
did before.

**One drop target, not two.** The compose-form `onDragOver`/`onDrop` handlers
were **removed**, not kept alongside the zone. Keeping both would (a)
double-fire the upload on a compose-area drop (the drop bubbles to both the
form and the enclosing zone) and (b) `stopPropagation` on the form to fix
that would then **strand the zone's overlay** — its dragenter/dragleave depth
counter would never see the balancing drop-reset. So the zone owns the single
drop path; ComposeBox keeps only clipboard **paste** (a textarea-scoped
surface the pane can't observe).

**Shared wiring (implement-once).** Both the zone's drop and ComposeBox's
paste funnel through one `lib/dropUpload.ts` helper (`dropUpload(files, slug,
channel)` — filter to uploadable categories, then `triggerUploads`), so the
orchestrator wiring is not duplicated. `dragHasFiles(dataTransfer)` is the
shared guard.

**Guards.** (1) *File-drag only* — the overlay arms + `preventDefault` fire
only when `dataTransfer.types` includes `"Files"`, so dragging selected text /
an in-app element over the pane is left to native handling (no overlay, no
swallowed drop). (2) *Depth counter* — dragenter(+1)/dragleave(−1) with the
overlay shown while depth > 0, because enter/leave fire once per child element
the cursor crosses; a naive boolean flickers the overlay off between scrollback
rows. Known edge: an external drag abandoned without a dragleave reaching the
zone could leave the overlay up until the next drag; Chromium fires dragleave
on viewport exit so it self-clears, and a global `dragend`/blur reset was
judged heavier than the marginal, self-recovering problem.

**Layout is unchanged.** `.drop-upload-zone` is a transparent pass-through
flex column (`flex: 1; min-height: 0`) occupying the exact slot the four
children filled directly inside `.shell-main` (also a flex column), so
`.scrollback-pane`'s `flex: 1` still grows and the surrounding rows keep their
natural heights. The `min-height: 0` chain (shell-main → zone → scrollback-pane
→ scrollback) is preserved so the scroller still scrolls on iOS. The overlay is
`position: absolute; inset: 0; pointer-events: none` at `z-index: 500` — above
in-pane content (scrollback floats, WHOIS cards) but below modals (≥1000), so a
media-viewer / other overlay with its own drag semantics is never covered.

Client-side only → **no cold deploy**. Covered by `dropUpload` +
`DropUploadZone` vitest units (filter / guard / overlay / depth / drop→upload),
the ComposeBox drop tests collapsed to a "form is NOT a drop target"
regression guard, and a real Chromium e2e (`uploads4-pane-drop`) that drops a
PNG over the **scrollback** and asserts the auto-sent 📸 upload lands — the
browser gate for a browser feature (chromium-scoped: an OS file drag is a
desktop-pointer gesture, and WebKit's programmatic `DragEvent`/`DataTransfer`
is unreliable).

*Lesson: when hoisting an event handler to an enclosing container, the nested
handler must be removed, not layered — two live handlers for one gesture
double-fire, and papering over that with `stopPropagation` silently breaks a
sibling concern (here, the container's own drag-overlay bookkeeping).*
