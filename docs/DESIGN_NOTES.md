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

### Archived months

Everything before **2026-09** lives in [`design_notes/`](design_notes/), moved
**verbatim** by #1537 and by issue 2138 — not one entry was edited, cut,
reordered or judged obsolete. A ruling from May is still one grep away, over
two paths instead of one:

```
grep -rn '<pattern>' docs/DESIGN_NOTES.md docs/design_notes/
```

| month | file | `##` sections |
| --- | --- | --- |
| 2026-04 | [`design_notes/2026-04.md`](design_notes/2026-04.md) | 10 |
| 2026-05 | [`design_notes/2026-05.md`](design_notes/2026-05.md) | 82 |
| 2026-06 | [`design_notes/2026-06.md`](design_notes/2026-06.md) | 64 |
| 2026-07 | [`design_notes/2026-07.md`](design_notes/2026-07.md) | 265 |
| 2026-08 | [`design_notes/2026-08.md`](design_notes/2026-08.md) | 501 |

`2026-04.md` carries **every April entry there is**. In this repo an entry is a
`##` heading — that is the definition `scripts/design-notes-gate.sh` enforces,
and a `###` is a subsection *inside* an entry. The **2026-04-18 … 2026-04-26**
items below are `###`: narrative of this preamble, which is also how #1537
counted them when it fixed the undated preamble at lines 1–328.

> **Looking for an April ruling and not finding it in `2026-04.md`?** The
> preamble above carries April-dated `###` subsections (2026-04-18 …
> 2026-04-26) — search this file too.

**Open design questions** and **What's *not* in this document** stayed for a
different reason — they are document sections, not months. `git log -S` puts
both in `b7b08375` (2026-04-24), the same commit as this preamble; later
entries were simply appended underneath them.

New entries keep going to the tail of **this** file. The archives are frozen:
nothing appends to them, which is why they carry `merge=text` and not this
file's `merge=union` (see `.gitattributes`). Keeping the rollover up to date is
no longer down to somebody remembering it: `scripts/design-notes-gate.sh` fails
when a month older than the newest one here is still inline (issue 2138).

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

## Open design questions

Tracked here until resolved in the README or an issue.

- ~~**Client framework:** Svelte vs SolidJS vs plain lit-html. Decision deferred to Phase 3 (client walking skeleton). Criteria: PWA shell ergonomics, service-worker story, bundle size budget (≤200 KB gzip target before optional Vosk/piper drop-ins). Note: any choice integrates with `phoenix.js` (3KB, framework-agnostic) for the Channels client.~~ **Resolved 2026-04-26:** SolidJS 1.9 + TypeScript 6 + Vite 8 + Bun 1.3 + Biome 2.4 + `phoenix.js` 1.8. See dedicated DESIGN_NOTES entry above.
- **KV vs sqlite for scrollback:** sqlite via `ecto_sqlite3` is the chosen default. The pagination-heavy access pattern + per-user row counts + the need for indexed lookup by (channel, server-time) all favour SQL. Revisit only if the sqlite file turns out to be the bottleneck.
- ~~**Session token format:** `Phoenix.Token` short-lived access + long-lived refresh, or single long-lived + revocation list. Phase 2 concern.~~ **Resolved 2026-04-25:** opaque UUID session ID + sliding 7d idle expiry + revocation table. See dedicated DESIGN_NOTES entry above.
- **How to expose multi-network per user in the UI** without descending into tree-view hell. Phase 3 concern.
- **Coverage floor:** start CI at 80%; ratchet up each major release. No exclusion lists — if a file is hard to test, the design needs fixing, not the gate.

---

## What's *not* in this document (on purpose)

- Anything that was decided inside a private channel and hasn't been published elsewhere. The repo is public; private crew chatter stays private.
- Implementation scheduling ("I'll do X next week") — that belongs on the issue tracker, not in-repo.
- Anything that belongs in `CONTRIBUTING.md` or a future issue template — to be added when the project moves past spec-only.

<!-- entry #1044 -->

---

## 2026-09-01 — 1044: one secret slot, several roles — and the read half nobody had written

A self-hoster bound a network with `--auth server_pass` for hostmasking and
found the only place left for the NickServ password was the on-connect
perform list, in cleartext. One credential, one secret slot, and an
`auth_method` deciding which single role it was spent on.

The column that fixes it had already landed and was HALF dead. Measured on
`origin/main 725788267`: `server_pass_encrypted` exists, the wide changeset
casts it, `validate_server_pass_is_user_only/1` guards it and
`put_encrypted_server_pass/1` writes it — while `upstream_server_pass` was
**0 hits** in `lib/` (positive control: `upstream_oper_pass`, 3). So
`grappa.repair_passwords`'s "never read and never written" was half false,
and the issue's own account of what was missing was too generous: only the
READ was.

### Two roles, two arms — not one guard over both methods

`maybe_send_pass/1` used to be a single clause guarding
`m in [:auto, :server_pass]` over `:password`. It is now one clause each,
and the split is the design rather than a refactor. On `:server_pass` the
PASS token is the NETWORK'S GATE secret; on `:auto` it is the services
secret handed off to NickServ (Bahamut/Azzurra), the same value SASL would
carry. Those are two roles that happened to share a wire line, and #124's
property is one home per ROLE. `:auto` therefore does NOT move, and a
gate-secret-plus-handoff credential is out of scope, named here so the next
reader does not read the asymmetry as an oversight.

S30's single-token rule follows the SLOT that lands on the PASS line, not
the method: the NickServ secret beside it keeps the CR/LF/NUL floor,
because it leaves as a PRIVMSG trailing param where a space is legal.

### The read cutover needed a data migration, and there was no third option

The slot was opened EMPTY (`remove` + `add`, deliberately, so a retired
NickServ secret could not be relabelled as a server password). So every
`:server_pass` row in existence still kept its PASS in
`password_encrypted`, and the instant `AuthFSM` reads the new slot those
rows send no PASS at all — a refused handshake, not a degraded one.

"Read the slot, fall back to the password column" is shorter and needs no
migration. It is also precisely the two-homes-for-one-role split brain
#124 is named after, so it was never available. The bytes move once, by
migration, and the predicate is four conjuncts: the method, `user_id IS
NOT NULL` (the slot is user-only), `server_pass_encrypted IS NULL` (a row
written through the post-#1044 door already has both secrets in their right
homes — and this is also what makes the migration idempotent), and a
non-null source.

**Measured before it was written, because the whole migration rests on it:
a Cloak AES-GCM ciphertext is portable between two `EncryptedBinary`
columns by a raw SQL copy.** Positive control, a same-column round trip
returning the plaintext; the measurement, a raw copy into the other column
still decrypting through the schema; negative control, one byte flipped,
which must NOT decrypt — it loads as the atom `:error` rather than raising,
which is worth knowing on its own. The property is pinned by the
migration's test, which drives the moved value back out through the SCHEMA:
comparing blobs would have been green on undecryptable garbage.

### `identify_expected?/1` stopped reading `auth_method`, and that is the subtle half

Widening the #347 autojoin defer from `:nickserv_identify` to "either
method" reintroduces the #509 KNOWN EDGE that #124 removed: the common
gate-only credential has no NickServ secret, expects no identify, and would
wait out the whole fallback window for a `+r` that is never coming.

The method could answer "is an identify expected" only while exactly ONE
method staged a secret. Two do now, so the question moved to the secret
itself — a boolean derived at init from the same `pending_password_from_opts/1`
that stages it, because `pending_password` is cleared one-shot before the
defer decision runs. It carries a hot-reload fallback clause and that is
NOT redundant: session state here is a plain MAP, not a struct, so
`Deploy.Preflight` (which refuses a hot deploy on a changed `defstruct`)
has nothing to read and would let one through.

The two halves of the widened method set live in different boundaries
(`Networks` deps `Session`; the reverse closes a cycle) and cannot call
each other, so `Credential.nickserv_secret_methods/0` is exported as DATA
and a test DRIVES that list against live sessions. Falsified before being
trusted: adding `:sasl` to the list turns it red naming the method.

### The version bumped on the rule, not on the gate

`/networks/:id/server_pass` renders its shape in a controller, and the wire
pin's digest spans the artefacts generated from `Grappa.*.Wire` typespecs —
so the digest is BYTE-IDENTICAL across this slice and `mix grappa.wire_pin
--check` would have stayed green with the number still. It moved anyway:
reason (1) of the 2026-08-21 ruling applies literally, since a cic bundle
growing a gate-secret editor REQUIRES the route and gets a 404 from any
older server. Recorded because the next person to add a REST-only surface
will find the gate silent and needs to know that silence is not permission.

### Corrected in passing

Three comments in `lib/` described a `password_set` field on the credential
wire. There is no such field, and `networks_controller_test` asserts there
is not — the password door is write-only including its set-ness. The
comments now say so, since they were the signposts pointing at where
`server_pass_set`'s sibling supposedly lived.

The column's validation also TIGHTENED: it was `safe_line_token`
(CR/LF/NUL) while `AuthFSM` gates the same value with S30's single-token
rule, so a gate secret with a space saved 200 and then refused every
connect — the ircd keeps the first token and answers 464 with nothing in
the log. A write door that accepts what the reader will reject is the
silent-swallow the boundary rule forbids.
<!-- entry #1888 -->

---

## 2026-09-01 — #1888: the closing bracket speaks when the opening line never did

Prod froze for 31 s on 2026-09-01 (jail `grappa-new`, release
`1.4.1-997711ac`): no request served, on any network, then everything
resumed at once. The issue asks first for the write-lock HOLDER to be
logged, "because today the warning says how long we waited but not who was
writing."

### The premise was incomplete, measured

`Grappa.Repo.LockWatch` is ARMED in prod — `config/config.exs` declares
`enabled: true, stall_threshold_ms: 2_000, tick_ms: 1_000` and neither
`prod.exs` nor `runtime.exs` overrides it. It already derives the holder's
identity (`sample/2`: pid, `current_function`, `status`,
`message_queue_len`, `initial_call`, 12 frames) and already reports a queue
that names nobody (#1687's `report_unattributed/2`). Both of those shipped
INSIDE the running release — `cf5a612f2` (2026-08-23) and `c048d2bff`
(2026-08-24) are ancestors of `997711ac` (2026-08-27), tested with
`git merge-base --is-ancestor`.

So the instrument was not missing. It was silent, and its silence was
indistinguishable from a healthy system.

### What actually had no door

`close_episode/1` matched `reported?: true` and nothing else. An episode
the watchdog never announced therefore closed with **no log line, no
telemetry and no ring row** — the instrument's silence meant both "nothing
happened" and "something happened and I could not say so". That ambiguity
is what this entry removes, and the bracket is where it is cheapest to
remove: by then the lock is RELEASED, so nothing on that path can be
blocked by the stall it describes — which is exactly the trap the detection
path lives in (#1715).

Three changes, all on the closing bracket:

1. **It fires for any hold past `stall_threshold_ms`**, announced or not,
   and the line SAYS which. An announced episode has an opening line above
   it carrying the holder's sampled stack; an unannounced one is the only
   record that episode left, and an operator needs to know which they hold.
2. **It carries a `t:caller/0`, NOT a `t:sample/0`.** A sample is taken
   while the holder is parked, so `current_function` names the frame it
   paused IN; by release there is no pause site left. What survives is the
   write PATH — which caller opened the transaction — read from the
   releasing process's own state (`$initial_call` plus its own stack, no
   signal, no suspend). Folding the two shapes would let a release-time
   frame be read as a pause site, and the renderer keeps them apart too
   (`holder at …` vs `write path …`).
3. **Every phase stamps `observed_at`**, at EMIT and not at fold: the fold
   happens behind a cast in `Grappa.DbLatency`, so a stamp taken there
   would be "when the aggregator got round to it", skewed by exactly the
   load an incident produces. Without an instant a ring row cannot be lined
   up against `erlang.log`, and the ring is the door that survives a log
   that went quiet.

`waiter_count` on a `:resolved` row went from `0` to `nil` in the same
pass: a closing bracket counts no queue, and the zero asserted a
measurement nobody took.

### Costs, and the one that is new

One extra `:persistent_term` READ per write-transaction release — the
threshold, published once by `init/1`. A read and not a write on purpose:
the WRITE is what blocks on a thread-progress barrier (#1715). Everything
else runs only once the hold has already crossed the threshold. Absent the
key (watchdog never booted, or mid-restart) `past_threshold?/1` answers
false rather than guessing, which is byte-for-byte the pre-#1888 behaviour.

### Two measurements worth keeping, and one hypothesis killed

**`busy_timeout: 30_000` does NOT explain the four observed durations.**
`BusyRetry.run/1` starts its clock before `op.()` and computes `elapsed_ms`
in the `rescue`, so the printed figure is checkout + wait + propagation.
30_000 is a LOWER bound; 31214 / 31295 / 31345 / 31397 ms leave 1.2–1.4 s
unattributed, with a residual spread of 183 ms that is too tight for
queueing noise. Only the weak form survives: `busy_timeout` is the dominant
term.

**#1888 has a one-term shape; #1687 had two.** LockWatch's own moduledoc
records a prod decomposition measured 2026-08-22 — "~31 s of DBConnection
checkout PLUS ~31 s of `busy_timeout`", the whole of that issue's 62 s.
#1888's ~31.3 s is one `busy_timeout` plus ~1.3 s. These are two different
shapes, not one episode and a shorter version of it.

### Refused

- That the UNATTRIBUTED line is absent from the jail's `erlang.log`. Only
  the issue BODY was measured (0 hits on all three LockWatch signatures,
  positive control 2, negative 0), and the body is a curated extract; the
  issue's own census grepped only `write lock held by another writer`, so
  the signature was never looked for. Absence in an extract is not absence.
- That `prime_logger_module_cache/0` never ran on that node. It runs ONLY
  in `init/1`, and the issue reports 41 days of uptime against a release
  dated five days earlier — but "41 days" is an assertion in the body, not
  a measurement of ours.
- The mechanism behind the simultaneity at unfreeze: five
  `db_conn_N … longer than 15000ms` disconnects plus one `Exqlite.Error
  interrupted`, all inside a 30 ms window at 12:07:28.55, rather than at
  15 s into the stall. That is the SHAPE of "nobody was scheduled" rather
  than "each expired on its own", and it is recorded as an observation. Its
  causal chain is #1715's, whose last link is inferred and never reproduced
  on a bench.
- Whether the write lock was held by a writer this seam cannot see. 129
  bare `Repo.insert/update/delete/*_all` call sites live in 24 files under
  `lib/` on `origin/main`, and an autocommit statement takes the same file
  lock with no row here. Widening the seam to cover them is a separate
  slice, deliberately not taken in this one: without the bracket above, it
  would produce a row whose only door is the one under suspicion.
<!-- entry #1889 -->

---

## 2026-09-01 — 1889: a 404 is a fact the client can read, and refused to

`cicchetto`'s media viewer rendered a deleted or expired upload exactly like
a broken image: `failed to load — try "open in browser"`. Both halves are
wrong for that case. The browser did not fail, and "open in browser" lands
on the same route, which serves `{"error":"not_found"}` as JSON. Two
operators reported it independently, and the message sent both of them
looking for a client bug.

### Why the status had to be asked for

The `error` event of `<img>` / `<video>` / `<audio>` carries no status.
There is no response to read off the element that failed, so the option of
"use the failed element's own response" — which the issue left open — does
not exist for three of the four viewer kinds. Only the `text` arm fetches,
and it discards the status inside `fetchTextResource`. That measurement is
what made the choice, not a preference.

`HEAD`, not `GET`: the question is whether the server still has the file,
and a 200-but-undecodable response (corrupt image, wrong mime) must not be
downloaded a second time to be told it is not a 404. `Plug.Head` sits above
the router in the endpoint, so HEAD shares the GET route and answers with
the same status the element saw — one server path, not two. One probe for
all four kinds rather than one probe plus a special case for `text`: the
round-trip is paid only on the failure path, which is cold.

### Same-origin is a CSP gate, and it was already there

`connect-src` is `'self'` plus the captcha hosts and two audio hosts. It is
deliberately NOT widened to `https:`, unlike `img-src` / `media-src` — an
element source can only be rendered, whereas `fetch` can read a response
body. So a cross-host probe is refused by the policy and raises a
`securitypolicyviolation` that the e2e `_cspGuard` fixture fails specs on.
This is the same boundary that keeps `.txt` / `.md` admitted-host only
(#1764); reusing it beat inventing a scope rule.

It costs no coverage. `classifyMediaLink` re-roots an admitted host (page
origin ∪ the #324 deployment aliases) onto the page origin, so every own
upload arrives at the viewer same-origin by construction, and a genuinely
foreign host keeps its absolute href — another deployment's 404 is not ours
to interpret anyway.

ORIGIN equality, deliberately not the HOST equality `mediaLink.sameHostHref`
uses. That one is scheme-agnostic on purpose (legacy `http://` upload links
live forever in scrollback) and then re-roots; `'self'` is scheme + host +
port. Reusing host equality here would look right and admit a probe the CSP
then refuses.

### The rule that matters more than the feature

🔴 **A failure of the probe never produces "gone".** Dead network, CSP
refusal, an abort when the viewer closes mid-flight, a response we cannot
read — all answer `unknown`, and the reader keeps the generic text. Saying
"your upload is gone" because OUR request broke is a worse lie than the
message this change replaces. Enforced by the return type being a closed
two-member set where `gone` is earned only by a 404 read off the wire, and
asserted on two planes: a table over the probe, and the visible outcome in
the viewer.

### What this message can never say, on purpose

`UploadsController.show/2` answers the same 404 for **five** distinct
causes: a malformed slug, a missing row, a soft-deleted row, an expired row,
and a row whose file is gone from disk. It gives no oracle, and that is
correct and stays. So the client can say the file is not there, and can
never say which of the five, never say *expired at HH:MM*, and cannot even
separate "removed" from "a slug that never existed". `(expired or removed)`
names the two likely causes without claiming to know. The noun is neutral
rather than "this upload" because classifier rule 3 admits any same-origin
media, not only `/uploads/`.

### The interpretation, declared

The header's "open in browser" anchor is suppressed in `gone`, and only
there. The issue says of the 404 case *"No `open in browser` suggestion:
that route returns JSON, not an image"*, and the anchor is that same
suggestion in another form — same route, same raw JSON, the exact trap that
cost two operators their afternoon. Least surprise finishes it: a line
saying the file is gone, beside a live control that opens it, contradicts
itself. On a generic `failed` the advice stays, because there "maybe it is
your browser, try it over there" is still a live hypothesis.

### Scope

Client only. The server behaviour — row gone ⇒ 404, no oracle — is correct
and untouched. The disk-side half of the same incident (account deletion
cascades the rows but never unlinks the files) is a separate issue and is
not addressed here.
<!-- entry #1890 -->

---

## 2026-09-01 — #1890: the cascade takes the rows and leaves the bytes

Account deletion removed a subject's `uploads` ROWS and left the FILES on
disk. `uploads.user_id` / `uploads.visitor_id` carry `ON DELETE CASCADE`, and
nothing on any deletion path called `File.rm/1`. The bytes then became
unreachable (row gone ⇒ 404), invisible to `Grappa.Uploads.Reaper` (which
sweeps ROWS and unlinks from them), and uncounted by `live_bytes_sum/0`
(row-derived) — so the global-cap accounting drifted from real disk usage
with no signal anywhere.

### The fix goes at the chokepoints, not at the door the issue named

The issue named `AccountDeletion.delete_account/1`. Measured, that is one of
**five** doors that destroy a subject, and the smallest: `Operator.delete_user/2`
and `Operator.delete_visitor/2` (admin), `Visitors.purge_if_anon/1` (anon
co-terminus), and — the one with by far the highest cadence —
`Grappa.Visitors.Reaper`'s **60-second** sweep of expired visitors. Repairing
the self-delete door alone would have left the automatic door leaking on a
one-minute tick.

All five funnel through exactly two functions, so the unlink sits there:
`Accounts.delete_user/1` and `Visitors.destroy_visitor/1`. `destroy_visitor/1`
and not `Visitors.delete/1`, because `purge_if_anon/1` reaches the former
without passing the latter.

`Uploads.delete_all_for_subject/1` replaces the former
`delete_all_for_user/1`, whose `@doc` declared it test-support-only and
asserted that "production lifecycle uses `soft_delete/2`" — a sentence that
becomes false the instant production calls it. It takes `Subject.t()` (the
bare-id tuple both call sites already hold) and queries through the existing
`Subject.subject_where/2`, so the two arms differ only in an FK column and no
second query idiom is introduced. Its one previous caller, the test harness,
moved with it: no half-migration, no two spellings of one verb.

### Why a failed unlink is logged rather than discarded or retried

`Uploads.Reaper.unlink_then_soft_delete/3` can afford to leave a row alone
when `File.rm/1` fails, because **the row IS its retry token** and the next
sweep tries again. On the deletion path the row is about to be destroyed, so
no retry token will ever exist — the reaper's third arm is structurally
unavailable here, and a discarded error is a permanent leak that nothing can
later detect.

So the three outcomes stay apart. `:ok` proceeds. `{:error, :enoent}` is NOT
a failure and is deliberately kept OUT of the log — it is the expected
idempotent case (the reaper or a prior partial run got there first), and
logging it would drown the one line that matters. `{:error, reason}` logs the
slug and **continues**: a read-only disk must not hold someone's right to be
deleted hostage, and the log line is the only surrogate for the retry token
being destroyed. The metadata shape mirrors the reaper's own failure line
(`upload_id` / `slug` / `error`), all three already in the Logger allowlist,
so this costs no `config/` edit.

On the visitor side the call sits INSIDE the existing `Repo.BusyRetry.run/1`
block, beside the published-theme re-home — which is the same figure: a
pre-delete step disposing of something the cascade would otherwise destroy
without cleaning up. Inside and not before, so a sustained SQLITE_BUSY still
degrades to `{:error, :db_unavailable}` for every caller rather than raising
past it; re-running is safe because the second pass finds no rows and an
already-unlinked file answers `:enoent`.

### Measured, and deliberately not claimed

`storage_path/2` has been `Path.join(storage_root, slug)` — no extension —
since the commit that introduced it (`61269ebe7`); the only other commit
touching that name merely added a caller, and no commit in the file's history
ever composed a filename with an extension. So unlinking by slug cannot miss
a historically differently-named file.

Peer avatars are NOT in this class: `peer_avatars.network_id` references
`networks`, which carries no owner column, so destroying a subject never
cascades them. Theme background images ARE covered, because
`Themes.BackgroundImage` stores them through `Uploads.create/3`.

Not claimed: that self-delete is the dominant source of orphans. The visitor
reaper has the higher cadence and passes through the same hole, but neither
the expiry rate nor how many expiring visitors hold uploads was measured —
that is structure, not magnitude. Nor is the volume of already-orphaned bytes
on production established; the defect is proved from the code, and the
one-off sweep for existing orphans is a separate deliverable.
<!-- entry #1896 -->

---

## 2026-09-01 — #1896: the shell's regime branch was tearing the radio down

A user on a Galaxy S24 Ultra reported that rotating the phone with the radio
playing drops the audio for a fraction of a second and then restarts it, every
rotation, both directions. The issue read the chain out of the source and said
so; this entry records that it was then **reproduced in-process** before
anything was changed, and what the cure costs.

### The chain, re-measured on `origin/main` before touching anything

`isMobile()` is `matchMedia("(max-width: 768px)")` (`theme.ts`, `MOBILE_QUERY`)
and `Shell` branches on it with a `<Show>` carrying two complete subtrees, each
of which mounted its own `<AudioMiniPlayer />`. A phone whose landscape CSS
width clears 768 flips that signal when it turns, Solid destroys one subtree and
builds the other, and the `<audio>` on the far side is a different element. Its
`on(activeAudio, …)` effect then runs as a first tune, and for a stream
`mustRefetch()` is true (#1700 — a stream has no position to resume to,
re-tuning IS its resume), so it re-fetches. The new HTTP connection is the gap;
the `play()` beside it is the "restarts on its own".

Reproduced, not argued: the new `Shell.test` case mounts the shell, marks the
live `<audio>` object, flips the regime signal, and finds a different element on
the other side. That required making the suite's `isMobile` mock a real signal —
the regime had only ever been a start-up condition in tests, which is precisely
why no existing test could see a rotation. Every pre-existing site assigns it
before its `render`, measured (40 assignments, 0 after a render), so nothing
else changed behaviour.

### The cure, and why it is the element that must not move

One `<AudioMiniPlayer />`, mounted once ABOVE the regime `<Show>`. Each branch
renders an `<AudioDock />` where the player used to be, and the player portals
its CHROME into whichever dock is live. The `<audio>` element never moves at
all.

Moving the element with the chrome — one `<Portal>` around the whole component —
was rejected on the spec: a media element removed from a document has its
internal pause steps queued after "await a stable state", so a same-task
re-insertion probably survives. Probably is not a contract to ship playback on,
and there is no need to: the chrome holds no transport state, so only the chrome
has to travel.

Two wrappers now stand between `.drop-upload-zone` and `.audio-mini-player` (the
dock, and the container `<Portal>` builds inside it). Both are `display:
contents`, so the bar remains a direct flex ITEM of the compose column — #1701's
ruling. Without that the layout is identical today, because both wrappers are
full-width and auto-height and the column declares no `gap`, and silently wrong
the first time either of those changes. #1701's Shell assertion moved from
`parentElement` to `closest(".drop-upload-zone")` for the same reason, and the
CSS-text guard beside it is what keeps the weaker DOM assertion honest.

### The consequence, named rather than discovered later

The hoist necessarily lifts the player above the window-kind `<Switch>` too,
because the regime `<Show>` encloses it. There is one arithmetic here, not two
decisions: you cannot mount above the branch and remain inside the `<Match>`.

So the #1701 kill-and-re-tune on a window switch is gone as well — including the
half that file called "a defect in its own right and not this file's to fix", an
upload restarting from the beginning when the operator visits home. What changes
in exchange is that on home / list / mentions the audio now keeps playing with no
bar on screen. That state is not new: #1697 ships it deliberately as
`playerHidden`, and the doors out of it are the same ones — `RailRadio` and
`RailActions` live in `.shell-members`, OUTSIDE the `<Switch>`, so stop and
un-hide are reachable on every window kind in both regimes. Verified, not
assumed.

#1734's resume point is kept and unchanged. It now fires only on Shell's own
teardown rather than on every window switch, which narrows WHEN it runs without
touching what it must do.

### Not established

Not reproduced on hardware, and no device was rotated: the e2e crosses the
breakpoint with `setViewportSize` in desktop Chromium, which is the same
`matchMedia` edge and the same JSX flip, not an orientation change. The S24
Ultra's real landscape CSS width was never read off the handset — the phone-shaped
viewports in the spec straddle 768 by construction, they are not a measurement of
the reporter's device. And nothing here says the audible gap is the ONLY thing a
rotation costs: the flip rebuilds the whole subtree, and the audio element is the
casualty that was measured.
<!-- entry #1906 -->

---

## 2026-09-03 — #1906: the Android push badge is an alpha mask, and the icon was opaque to the last pixel

A phone that had been receiving cic pushes since they shipped showed a solid
white square in the status bar in place of the grappa-glass mark. Not a
regression — it had always looked like that — and invisible on iOS, which is
why it read as device-specific.

### The cause is a spec, not a bug

`pushNotificationOptions()` passed `/icon-192.png` as BOTH `icon` and
`badge`. The two fields are not two sizes of one picture. `icon` is the large
full-colour image; `badge` is the small status-bar glyph, and Android draws
it through the ALPHA channel alone — colour discarded, every non-transparent
pixel painted with the system tint. `icon-192.png` is the full-bleed `any`
icon on its own opaque `#0a0a0a` background: measured, 36864 of 36864 pixels
at alpha 255. Under an alpha-only mask that input can render as exactly one
thing, a filled square. The platform did what it is specified to do.

### One asset per field, derived from the one SVG

`public/badge-96.png` is new, and `NOTIFICATION_BADGE` names it next to
`NOTIFICATION_ICON`. It is the mark as a ONE-colour silhouette on a
transparent canvas, and it is minted by the same `scripts/gen-pwa-icons.mjs`
from the same `public/icon.svg` as every other raster surface — the generator
flattens every `fill="#…"` to white and captures on a transparent default
background instead of the opaque page the six siblings use. Two alternatives
were refused on purpose: tracing the raster would drift from the SVG the first
time the mark changed, and keying the background out of the flattened PNG
leaves fringe pixels at partial alpha that the mask renders as a halo. 96px is
24dp at xxxhdpi, the largest density Android draws the badge at.

It is NOT a manifest icon. A badge carries no `purpose`, so it never joins
`PWA_ICONS`; it does join `includeAssets` so the offline shell precaches it
(the `**/*.png` glob would have caught it regardless — listing it keeps the
icon set in one place). The Badging-API counter `applyIconBadge()` in the SW
is an unrelated axis (a number on the home-screen icon) and is untouched.

### The third door: the endpoint's static allowlist

A new root-level public asset has THREE places to be, not two, and the third
was found by the emulator rather than by reading: `GrappaWeb.Endpoint`'s
`@cic_static_only` names every top-level dist entry `Plug.Static` may serve,
and everything else falls through to the SPA history fallback. With the
bundle deployed and the badge sitting in the dist, `GET /badge-96.png`
answered `200 text/html` — index.html — exactly the #485 / #1739 regression
class, and the quietest instance of it yet: no page references the badge, so
nothing draws a broken image; the service worker precaches whatever bytes it
is given, and Android paints its own fallback where the glyph should be.
`badge-96.png` now sits in the allowlist and `spa_serving_test.exs` pins the
content type, the same lockstep test the icons have. Note for the dev stack:
the cached `Plug.Static` opts live in `:persistent_term` (#399), so a code
reload does NOT pick up an allowlist change — the BEAM has to restart.

### The test that passed on the defect, and the two that would not have

`pwaIcons.test.ts` tied `badge` to `NOTIFICATION_ICON` — it asserted the alias
as the invariant, so it was green on the blob. It now pins `icon` to the
manifest and `badge` to `NOTIFICATION_BADGE`, DISTINCT from `icon` and ABSENT
from `PWA_ICONS`; `pushPayload.test.ts` pins the same split from the SW's
side. The property of the bytes themselves is pinned by a new
`badgeAsset.test.ts`, which decodes the PNG (IHDR + inflate + unfilter, for the
one shape the generator writes) and asserts RGBA, 96×96, every corner at alpha
0, more than half the canvas transparent, an opaque mark between 5% and 50% of
it, and every painted pixel white. The contrast case decodes `icon-192.png`
and asserts it is opaque throughout — that is the reason the badge cannot be
the icon, stated as a test rather than a comment.

### The generator is not byte-stable across Chrome versions — measured

Running `gen-pwa-icons.mjs` under Chrome 151 re-wrote all six existing PNGs
with different bytes (pixel-identical mark, different encoder output from the
one that minted them). Only `badge-96.png` is committed here; the siblings were
reverted. That is also why the asset gate asserts PIXEL PROPERTIES and never a
digest: a byte pin would go red on every Chrome bump for no change in the mark.

### Verified on the emulator, and what that does and does not prove

Before and after were captured on an Android 17 emulator running Chrome 152
against the local dev stack. The push was injected through the DevTools
protocol (`ServiceWorker.deliverPushMessage`, what the DevTools "Push" button
sends) with a payload shaped like `Grappa.Push.Payload`'s, so cic's real SW
push handler and its `showNotification` call ran — the layer the defect lives
in. Before: a white square in the status bar. After: the glass silhouette.
Not exercised: FCM delivery and the VAPID subscription, which need a Google
account the emulator does not have; the dedup gate was satisfied by leaving the
cic tabs hidden behind a blank tab, since Android drops Chrome's DevTools socket
the moment the browser itself is backgrounded. Two traps for whoever repeats
this: Chrome's abusive-notification heuristic replaces the toast with a
"Possible spam" wrapper after a handful of un-tapped test pushes (tap "Show
notification" to get the real one back), and `Browser.grantPermissions` alone
left `Notification.permission` at `denied` on Android — `Browser.setPermission`
did the job.
<!-- entry #1908 -->

---

## 2026-09-04 — #1908: the colour code is the bug, not the control byte

A watchlist keyword never fired on a game bot's `QUACK!` line while the same
word typed by a human highlighted fine. The reported shape invites the
generalisation "formatting breaks watchlists", and that generalisation is
wrong in a way that would have shipped a cure leaving the bug fully intact.

**What actually breaks it.** `matchesWatchlist` and `Grappa.Mentions` both ran
their word-boundary regex against the RAW wire body, while the operator picks
the keyword by reading the RENDERED text. The argument-free attribute bytes are
harmless there: `\x02` `\x0f` `\x11` `\x16` `\x1d` `\x1e` `\x1f` are not word
characters, so `\b` still has its transition on both sides of a term. The
COLOUR byte is not: it drags up to four decimal digits into the text, and
digits ARE word characters, so `\x03` `1` `5` before `QUACK` reads to the regex
as `...15QUACK` and the term's left anchor has nothing to sit on.

**The contrast case is what pins it, and it is field evidence rather than
argument.** A URL-title bot on another network formats *every* line and matches
fine — 872 stored lines, 139 carrying `\x02`, zero carrying `\x03`, and terms
sitting flush against the bold on both edges all match. Without that half, "a
formatted line failed" is the only datum and a stripper that removed control
bytes WITHOUT their arguments would look correct while leaving `15` glued to
the `Q`.

Colour 15 is light grey and 99 is the default colour: both render as ordinary
text, which is why nothing on screen suggested formatting was involved and why
the first theory was case folding.

**Measured, and it killed a premise this slice was handed.** The working
hypothesis going in was that `mircPlainText()` might strip the control bytes
without their arguments, and that the real cure would therefore be inside the
parser. It is not: the shipped `parseMircFormat` already consumes `\x03` plus
up to two digits plus an optional `,` plus two more, and all nine spellings
(`15` `04` `4` `04,01` `99` `00`, bare, stray comma, three digits) reduce to
`QUACK!`. Positive control: the bold byte IS removed, so the instrument is
alive. Negative control: a bare `15QUACK!` comes back untouched, so it is not
deleting digits — it consumes them only as arguments. The cure on the client is
therefore one line: CALL the projection. Reading the parser suggests the same
conclusion; measuring it is what makes it a fact, and the premise it retired
was the expensive half of the slice.

**Why the server gets a second implementation, knowingly.** cic's projection is
derived from the renderer's own parser, which is exactly why it cannot drift
from what is on screen. The server has no renderer to derive anything from, and
porting a run-producing parser there would be dead weight — nothing server-side
styles a message. So `Grappa.IRC.MircFormat.plain_text/1` is a second
implementation of the consumption rule, and the honest thing is to name that
rather than pretend the ports share code. What holds them together is the same
discipline #1786's anchor rule runs under: two shared tables, one for the
consumption rule (`test/grappa/irc/mirc_format_test.exs`) and one for the
mention truth table (`test/grappa/mentions_test.exs` and its client twin), each
carrying the note that a case added on one side without the other IS the drift.

Two details in that rule are load-bearing and neither is obvious. The comma is
consumed only when digits follow it, so `\x034,foo` keeps `,foo` as literal
text — mIRC's behaviour, and a naive `\x03\d{0,2}(,\d{0,2})?` would eat the
bare comma and diverge. And the digit classes are spelled `[0-9]` with no
`unicode` option, because the client's `isDigit` is a bare `0x30..0x39` range
test: a `\d` under `unicode` would consume an Arabic-Indic digit the client
leaves as text, and the two ports would disagree on a body neither author will
ever type by hand. Byte semantics are also the honest ones for IRC, and they
are safe on UTF-8 because every sequence removed is ASCII and a continuation
byte is never below `0x80`.

**One funnel per port, chosen so a later door inherits the fix.** Server-side
the projection sits in the private `body_matches?/2`, which every mention door
already reaches: the OS push through `mentioned?/3`, the sidebar badge through
`matchers/2` + `matches?/2`, and the mentions-while-away bundle through
`aggregate_mentions/6`. Client-side it sits in `matchesWatchlist` — once per
call, not inside the per-term `matchesTerm` — which is the single predicate
behind the visual highlight, the mentions window and the push mirror. Both ports
change together by construction; splitting them is how the visual highlight and
the OS push diverged before #370.

The projection is a MATCH-time view only. `aggregate_mentions/6` still returns
the stored row with its control bytes intact, because cic renders the colours
from it — pinned by its own test, since a strip that leaked into the returned
row would be invisible to every predicate test.

**The test that separates the cure from the cheap wrong one.** Every case above
also passes if the anchor is LOOSENED instead of the body being stripped. One
case does not: after a genuine strip the body is `QUACK!`, so a term spelling
the colour ARGUMENTS (`15QUACK`) must now MISS, where a loosened anchor would
keep matching it against the raw bytes. That case was measured red-before-green
on both ports in the direction that matters — it is the only one that failed
with `got true, expected false` rather than the reverse.

**What this does NOT settle.** The cost was not measured: the projection is one
regex pass per body per predicate call, and on the bulk badge fold that is one
extra pass per row. It is the same complexity class as the matching already
being done there and it was left unbenchmarked, deliberately, rather than
guessed at. Nor does it touch what is STORED or RENDERED — scrollback keeps the
raw bytes, and every other consumer of a body is unchanged. And the report's
own reach is one bot on one network: the rule generalises because the mechanism
is the regex word class rather than any bot's habits, but no survey of senders
was run to say how many lines in the corpus were affected.
<!-- entry #1912 -->

---

## 2026-09-05 — #1912: the Kubernetes manifests, and the egress list that would have bricked the bouncer

Kustomize manifests for the release image, at the repository root: a root
`kustomization.yaml` importing `base/` (Deployment, Service, PVC, an optional
Secret template, a NetworkPolicy) plus `overlays/default/` for the PHX_HOST
patch, an Ingress example and the IRC-egress rule. Root and not `infra/k8s/`
because that is what was asked for; the layout is not the interesting part.

**Shipped untested, on purpose, and the header says so.** The open question was
whether to add a kind-based smoke job to CI. We took the other branch — a
support-status header in every file stating the path is community-maintained
and not exercised by CI. The two options are not symmetric: a header is
reversible in one commit, a Kubernetes target in CI is owned forever. The cost
is real and named rather than hidden: these manifests are reviewed by reading,
and they can rot without anything going red.

**The egress set was measured from the code, not copied from the request.** The
list that came with the ask named DNS, IRC, web push and (once OIDC lands) the
IdP. Enumerating every outbound call site in `lib/` found two more it did not:
`Grappa.Net.ImageFetcher.Req.fetch/1` (`Req.get/2`), which is load-bearing for
theme backgrounds and cached peer CTCP AVATAR images, and
`Grappa.Admission.Captcha.SiteVerifyHttp.verify/4` (`Req.post/2`), dormant until
`GRAPPA_CAPTCHA_PROVIDER` is set. One candidate was refused with the
measurement: reverse-DNS is not separate egress —
`Grappa.Net.PtrResolver.resolve/1` issues a PTR query through `:inet_res` to the
cluster resolver and never dials the address it is naming, so the DNS rule
already covers it. DNS itself needs UDP *and* TCP 53, because a truncated answer
retries over TCP and a UDP-only rule turns that into intermittent resolution
failure.

**Why `base/` allows any port to the public internet rather than 443.** A
NetworkPolicy that selects a pod and declares `policyTypes: [Ingress, Egress]`
makes everything it does not list denied — so on a permissive cluster the object
does not *describe* a posture, it *creates* one. A 443-only base would therefore
ship a bouncer that cannot reach IRC to every cluster that applied it, and IRC
ports are the operator's (6697, 6667, anything). Pinning the hosts in `base/` is
impossible for the same reason. The boundary that is worth enforcing here is not
the port but the direction: everything public is allowed on any port, everything
private or in-cluster is denied — which is also, exactly, the posture
`Grappa.Net.Ssrf` already enforces application-side for the image fetcher. The
per-network tightening, and the rule an operator with a private ircd MUST add,
ship commented in the overlay; a NetworkPolicy is purely additive, so that patch
REPLACES `spec.egress` rather than extending it (measured by rendering it, not
assumed).

The failure mode is why this is prose and not a bullet list: an incomplete
egress allowlist does not look like a firewall problem. grappa reports itself
up, `/healthz` stays green, and every network sits in `connecting` forever —
indistinguishable, from the operator's chair, from an upstream outage.

**Three image-shaped traps Kubernetes exposes that no other substrate does.**
`Dockerfile.release` says `USER grappa`, a NAME: adding the reflexive
`runAsNonRoot: true` makes the kubelet refuse the pod outright, because it
cannot verify a non-numeric user is non-root. A freshly provisioned PVC is
root-owned, so without an `fsGroup` the non-root entrypoint dies on its first
write to `/data` — and the value is arbitrary, since the kubelet chowns the
volume to that GID *and* adds it to the pod's supplementary groups. And
`PEER_AVATARS_STORAGE_ROOT` is the one state root the release image does NOT
bake: `config/runtime.exs` defaults it to the relative `runtime/peer_avatars`,
which resolves against WORKDIR `/app` — the container's ephemeral layer, not the
volume. It is only a cache, so this is durability rather than correctness, but
it means the claim "everything in `/data`" is true of the database, the uploads
and the secrets, and not of the avatars.

**`/healthz` is a deep check, and the probes are set accordingly.** It sits
outside both router pipelines (`pipe_through []`) and answers under any auth
state, which is what makes it usable at all — but `Grappa.Health.check/0` runs
`Repo.query("SELECT 1")` and asserts the singleton ETS tables exist. That is
right for readiness and needs a long leash on liveness: a transient SQLite lock
must not get the single writer killed. Hence ~3 minutes of sustained failure
before a restart, and a startup probe to cover first-boot migrations plus theme
seeding.

**What this does NOT settle.** Nothing was applied to a cluster. The manifests
render (`kubectl kustomize` on both the root and the overlay, and on the
commented Secret, Ingress and IRC-egress templates with their comments stripped),
which proves they parse and compose; it proves nothing about admission, about
whether any particular CNI accepts an IPv6 `ipBlock`, or about whether the pod
actually boots. `kubectl apply --dry-run=client` could not stand in for that —
it fetches the OpenAPI schema from an API server, and there is none here. The
Kanidm example the request asked for is absent and stays absent until the OIDC
client exists (#1911): a Kanidm deployed next to a grappa with no OIDC client
has nothing to talk to.
<!-- entry #1914 -->

---

## 2026-09-05 — #1914: `/topic` answers in the window (cic, client-only)

**Symptom.** Typing `/topic` (bare, or `/topic #chan`) printed a red inline
error: `/topic #sbiffo (bare) — inline render wired in C3 (TopicBar)`. That is
the `TODO(C3)` stub's OWN string — `topicShowCommand` had never been written,
and `compose.test.ts` asserted the stub's message, so the suite PINNED the
defect. A test that encodes a bug prevents anyone from finding the bug; it is
why this survived from C3 to #1914.

**The topic was never unavailable.** `channelTopic.topicByChannel` is seeded by
the join-time `332`/`333` on every JOIN and by `topic_changed` on every change,
and #237 already derives an on-JOIN inline line from it. What was missing was a
door from the COMMAND side into scrollback.

### The issue asked for something else, and it is not built

#1914 as filed asks the SERVER to persist a typed JOIN-time topic row, and
states cicchetto "is missing" the join-time line. That premise is not accurate:
#237 (2026-07-15) ships that line — presentational, derived, anchored after the
own-JOIN row — and that entry explicitly REJECTED the server-persisted variant
("option b … a server change AND exactly the reconnect-spam the server
avoids"). Reversing it needs vjt, not a slice. Two gaps therefore remain open
under #1914 and neither is addressed here:

* No persisted JOIN-time row, so scrolling back to an OLD join still shows no
  topic-at-that-time.
* #237's line still requires the operator's own-JOIN row to be inside the
  loaded page. On a bouncer it usually is not, which is the likeliest reason
  the topic reads as "topic-bar only" in daily use.

### Three choices worth the ink

**Not `{ ok: string }`.** The dispatcher renders a string `ok` as the
auto-dismissing green `.compose-box-notice` (#356). The complaint that opened
#1914 is a topic too long to read in the TopicBar — a transient strip cannot
carry it either. It had to be a buffer row.

**The snapshot is FROZEN at invocation.** `topicShow.ts` copies `text` /
`set_by` / `set_at` out of the store rather than holding the channel key and
re-reading at render. Re-deriving would let a later TOPIC change retroactively
rewrite a line the operator already read — the same lie `meta.sender_prefix`
freezes away at send time (#25), and precisely the caveat #237's live-derived
line had to DOCUMENT rather than fix ("shows the CURRENT cached topic, not a
frozen topic-at-join snapshot").

**A second row variant, not a flag on `topic-join`.** Same look, disjoint
lifecycle: unsolicited vs asked, at most one vs one per invocation, live vs
frozen, anchored to the own-JOIN vs interleaved at the ask. One variant with a
flag fuses four differences into a boolean. Reuse the verbs (the `inviteAck`
interleave-by-wallclock mechanism, the `scrollback-topic-join` classes), not
the nouns.

### Boundaries, stated so they are not rediscovered as bugs

An UNCACHED channel is an honest error (`no topic known; join #chan first`),
never a fabricated "no topic set": #975 drops the entry on own-PART, so absence
means "not in that channel", and asking upstream would need a server verb.
An EMPTY topic does print `No topic set for #chan` — both `hasNoTopic` shapes
(331's `null` and an operator's empty `TOPIC #chan :`) collapse there, because
the operator asked what the topic IS and both mean there isn't one. That
diverges from `topicJoinLine`, which stays silent on the same input, and the
divergence is the point: an unsolicited line may say nothing, an ANSWER may
not. Rows are ephemeral and identity-scoped — lost on refresh, like an
invite-ack — and presentational, so they stay out of the unread/cursor math.

_Deploy: **HOT — `--cic` only.** No server change, no wire change._
<!-- entry #1916 -->

---

## 2026-09-05 — #1916: the credits jingle becomes a phrase, and the loudness becomes a test

`cicchetto/src/lib/creditsAudio.ts` — the credit roll's soundtrack, shipped in
#1773 — was eight `triangle` notes over a static A2 sine, re-armed verbatim
every 1.92 s. The field complaint ("it repeats too soon") was right in
substance, and the fix is longer and more chiptune. What is worth recording is
not the tune; it is the three things the work settled.

### The arrangement is DATA, and the loop length is an assumption

`BARS` is an array of bars walked in order (Am → F → C → G) and `creditsBar/1`
expands one to typed `CreditsEvent`s; the scheduler renders those events and
never reads the score. Going from four bars to eight is four more entries in
that array — no code moves. That shape was chosen precisely because **the loop
length was the issue's one open question and it was never ruled on**: four bars
/ 7.68 s is the orchestrator's declared assumption, not vjt's call, and the
array is what makes reversing it cheap.

The chiptune register is three swaps the issue offered — `square` lead,
`triangle` demoted to a bass line that MOVES with the chord (the drone is gone,
not joined), one noise channel for percussion — and one it did not. **The snare
TAKES the hat's slot rather than stacking on it.** That is how a
two-pulse-plus-noise chip behaves, and it is also load-bearing for the budget
below: hat and snare can never sound together, so only one of them is ever in
the worst instant.

### The loudness ceiling is measured off the shipped score, and the first measurement was wrong

`PEAK_GAIN` is untouched at 0.06 and every voice declares its envelope peak
RELATIVE to it, so the worst instant this mix can produce is `PEAK_GAIN × (the
sum of the peaks of whatever is audible at once)`. The test expands two whole
phrases (two, so the loop seam is inside the window), lays them on one timeline
and takes that maximum: **1.41 against #1773's 1.4167 — 0.0846 absolute against
0.085.**

That measurement is why this is a note and not a comment. The hand arithmetic
said 1.41; **the first run of the test said 2.61**, and the difference was not
music. Summing over each note's SOURCE lifetime (`durS`) makes every note
overlap its successor, because `bar*BAR_S + 7*STEP_S + STEP_S` and
`(bar+1)*BAR_S` are the same instant computed two ways and therefore differ by
one float ULP — so the bound counted two leads and two basses that were 10⁻¹⁵ s
apart. The cure is in the DATA rather than in the test: `CreditsEvent.decayS`
is the note's AUDIBLE span (its envelope reaches the floor there; the source
runs on to `durS` to leave the articulating gap), it is what the scheduler
already ramps against, and it is what a loudness sum has to use. **General
rule: an overlap test over scheduled events must span the ENVELOPE, not the
source — adjacent-and-touching is the common case, and float equality is not
where you want it decided.**

### What was NOT measured, stated so nobody reads more into the number

The ceiling above is an **upper bound on the rendered waveform, not the
waveform**: it sums envelope peaks, and |sine|, |square| and |triangle| are all
≤ 1. Nothing renders audio anywhere in this repo's test suites — jsdom has no
WebAudio and node has no `OfflineAudioContext` — so no true sample peak was
taken, for either side. The bound is computed identically for both, which is
what makes the comparison sound; it is not a claim about absolute headroom.

Peak is also the wrong axis for "will this embarrass someone on a screen
share", and swapping a triangle for a square at equal peak raises RMS by 4.8 dB
on its own. So, computed analytically off the constants (**by hand, not by a
test**): the old mix's mean square was 0.1031 and the new one's is 0.0502 — the
new arrangement is **3.1 dB QUIETER in RMS** despite the brighter lead, because
the continuous A2 drone was **84 %** of #1773's loudness and it is gone. If
that ever needs to be a gate it needs the envelope integral, which means either
duplicating the envelope shape in the test or rendering for real.

### The lookahead scheduler, and the one way it can get loud

Bars are now placed on a cursor (`nextBarAt`) advanced by exactly `BAR_S` on
the audio clock, rather than re-based on `ctx.currentTime` at every re-arm, so
timer jitter no longer smears the phrase. That swap brings a hazard the old
shape did not have: **a backgrounded tab freezes `setTimeout` while the audio
clock keeps running**, so the catch-up loop would arm every missed bar with a
start time in the PAST — which WebAudio renders immediately, i.e. all of them
simultaneously. Fifteen bars at once, and the gain budget above says nothing
whatsoever about that instant. `pump` resyncs the cursor to `ctx.currentTime`
before catching up; a test that sleeps the clock 30 s without running the
timers proves it, and the unfixed version dies on it.

### Declined, with the reason

**No e2e.** The visible behaviour here is AUDIO, and Playwright cannot assert
it: the only in-browser purchase available is monkeypatching `window.AudioContext`
and inspecting the calls, which asserts the stub and duplicates the unit tests
through a browser and an exclusive lane. An empty green would be worse than the
gap. **No `createPeriodicWave` duty-cycle pulse** (12.5 % / 25 %, the NES
register): `square` is most of the effect and the periodic wave is a third node
class and a third stub method for the remainder. **No filter on the noise
channel** — hat and snare are separated by envelope length, which is what the
NES noise channel has too.

The existing tests were not weakened: none of them pinned a frequency or a step
length before and none does now, so the tune stays rewritable. The stub context
gained a real clock (a getter over the faked `Date`) because a `currentTime`
frozen at 0 makes a lookahead scheduler CORRECTLY decide there is nothing to
arm — a stub that cannot advance is a different module under test.

_Deploy: **HOT — `--cic` only.** No server change, no wire change._
<!-- entry #1901 -->

---

## 2026-09-05 — #1901: LockWatch reads the NIF, because the seam only sees the rare writes

`Grappa.Repo.LockWatch` had two arms and both read the same ETS table, whose
only producer is `Repo.immediate_transaction/1`. Measured on the live node
via `Grappa.Operator.db_latency_text!/0`: `messages insert` —
`Scrollback.persist_row/1`, an autocommit single statement — is **324 679**
writes, while every source the seam covers (auth, settings, themes, push,
reap) is in the thousands. The instrument was watching the rare tail of the
write load. That is why four stalls with six victims (#1888) produced
`grep -h "db lock stall" runtime/log/erlang.log.* -> 0`.

### The third arm reads a physical property, not a cooperative one

At each tick the census walks `Process.list/0` and keeps whoever is inside
`Exqlite.Sqlite3NIF`, timed from the first tick that saw them there. Read in
the dependency, not assumed: `execute/2` and `step/2` are registered
`ERL_NIF_DIRTY_JOB_IO_BOUND` (`deps/exqlite/c_src/sqlite3_nif.c:2066,2077`)
and exqlite installs its OWN busy handler which SLEEPS inside the NIF
(`:332`) instead of returning to Elixir to retry — so a writer blocked on the
file lock stays visible in `current_function` for the whole `busy_timeout`.
No enumeration of write paths to maintain, and nothing added to the write
path itself.

The clock lives in the watchdog's state as `%{pid => {since, reported?}}` and
is REBUILT from `Process.list/0` every pass, so a process that leaves the NIF
drops out with no housekeeping. That is the design-discipline rule (1) —
derive, do not maintain a parallel structure — applied to the one piece of
state this arm genuinely needs.

### 🔴 What it refuses to say, and why that is not a shortfall

The issue's acceptance criterion asks for a line that NAMES the process
holding `RESERVED`. The same physics that makes the cohort visible makes it
INDIVISIBLE: the holder and every victim are inside the same dirty-IO NIF,
all reading `status: :running`, and nothing BEAM-visible separates them. So
the arm reports the ROSTER — every pid, elapsed and frame, with the full
twelve-frame stack for the longest — and the count of how many of them the
seam could already name. `registered=0h/0w` is the finding in one field.

Naming the holder outright is exactly what axis 2 (registering the autocommit
writes at `observe/1`) would buy, and it is deliberately not built. Asserting
it from here would be the class of claim `BusyRetry.terminal_message/3` was
twice rewritten to stop making (#1420, #1421).

Two limits stated in the moduledoc so they are not rediscovered as bugs: a
transaction parked BETWEEN statements is not in a NIF and only the first arm
can see it; and `elapsed` runs from the first TICK, so it is a LOWER bound
understated by up to one `tick_ms`.

### The cost is the one paid when nothing is wrong, so it was measured

Dev image, warm, 20 passes per point: 0.7-2 us per process, i.e. **1 550 us
at 2 000 processes** and 5 237 us at 8 000. At `tick_ms: 1_000` that is
0.16 % of one scheduler on a 2 000-process node. It does NOT scale with write
volume, which is the argument against axis 2's three ETS operations on each
of those 324 679 inserts.

### The CI stack that prompted the design was measured, and it is not a block

A red `LockWatchTest` in PR #1917's CI died at 60 s with the sample inside
`LockWatch.format_frames/1` -> `Exception.format_stacktrace_entry/1` ->
`:application_controller.get_application_module/2`, which reads as the census
formatting stacks through a global gen_server. **Measured here, it is not
one:** with `application_controller` SUSPENDED via `:erlang.suspend_process/1`,
`:application.get_application/1` answers in **38 us** and the whole
twelve-frame format door in **286 us** (against 242 us with it running).
`get_application_module/2` is a pure list walk over the result of an
`ets:match` on the public `ac_tab`; it never sends a message. This reproduces
#1747's own reading (9 us, same conclusion) on different hardware, and it is
why the census formats stacks from the tick without routing around anything.
What the CI red shares with its siblings is a RATE, not a place — this
branch's own baseline run showed the same file taking 135 s for ONE test
under the full suite and **8.6 s for all 34** in isolation, with #1767's
filmer reporting 1 of 539 turns taken.

### Axis 3: a mean cannot represent the event the instrument exists to catch

`Grappa.DbLatency` folded every family to `n / total_ms / mean_ms`. A 31 s
write inside 324 679 samples moves the mean by **0.1 ms** — under the
rounding the CLI prints. `Grappa.DbLatency.Distribution` keeps the same two
exact numbers plus an exact `max` and a fixed-bucket histogram, applied to
`queries`, `persist` AND `send_privmsg` (giving it to one would leave
mechanisms 1 and 3 of #357 reading a mean and nothing else).

Bounds run 0.5 ms to 30 s so that `busy_timeout` is a bucket EDGE: a writer
that exhausted it lands in the last finite bucket, and the overflow then
means "worse than the driver's own patience".

**The quantiles are UPPER BOUNDS and the type says so.** Interpolating inside
a bucket prints a decimal nobody measured, and a reader comparing two windows
would read interpolation noise as movement. The property test holds only the
direction that matters — never understates — against a sort-and-rank oracle
that shares no code with the histogram. Its first cut also asserted
`<= the observed max` and that was FALSE: one 2 ms sample reports
`p50_ms == 2.5`, the ceiling of its bucket. The test was wrong, not the
structure.

`queue_ms` stays a bare cumulative sum, recorded as a KNOWN GAP rather than a
judgement: #1687 measured a victim's 62 s as ~31 s of DBConnection checkout
PLUS ~31 s of `busy_timeout`, so the pool axis hides an outlier exactly as
the execution axis did.

### Two drifts found while passing through

`Grappa.DbLatencyTest` hand-copied the production `@events` list, so the new
emitter reached a new `fold/4` clause with a GREEN suite and an empty ring.
The copy stays — deriving it would make the boot-wiring test tautological —
and `DbLatency.attached_events/0` plus one equality assertion now name the
divergence. Separately, `bin/grappa db-latency` has been printing four
contention values under four names since #1657 shipped a fifth
(`interrupted`); the header now carries it.

_Deploy: **COLD**, and the state-shape check is what establishes it — not the
touched-paths heuristic. Measured through
`Grappa.Deploy.Preflight.classify_state_shape/2` against `origin/main`
(349145af), with an added-field/identical pair as the positive and negative
control: **3 of 34** tracked long-lived files changed state shape —
`lock_watch.ex` (`defstruct` gains `:nif_watch`), `db_latency.ex` (the
accumulators become `Distribution`s) and the new `db_latency/distribution.ex`.
A hot reload would leave the running `DbLatency` holding
`%{n:, total:, outcomes:}` while the new `add_span/3` expects
`%{dist:, outcomes:}`.

🔴 Worth recording because it nearly went the other way: for the first four
commits this diff touched NO `config/`, no migration, no `mix.exs`, no
`infra/` and no `application.ex`, so a paths-only reading answered HOT while
the state-shape check already answered COLD. `config/config.exs` entered only
at the end, and for a reason unrelated to deploy safety — Credo requires a
Logger metadata key to be declared in the allowlist, and the census emits two.
A verdict that would have been right by accident is not the same as one that
was measured._
<!-- entry #1883d -->

---

## 2026-09-05 — #1883d: the upload confirm becomes OPT-IN

**Ruling (vjt via Gabriele, 2026-09-05): the pre-upload confirm is a setting,
default OFF.** It lives beside upload retention in the settings drawer, backed
by a new `user_settings.data` key `"upload_confirm_enabled"` — no migration, a
JSON key in the existing column, `false` stored as ABSENCE (the
`put_show_peer_profiles/2` rule: an explicit `false` row is a second spelling of
the default).

### This reverses this file's own earlier position, and the reversal is the entry

The #1883 note and the `triggerUploads` header both argued there must be no
"don't ask again": *a gate every returning operator has already switched off is
not a gate*. That argument was aimed at the flag which PRODUCED the defect —
`localStorage`, key `image-upload-privacy-acknowledged:<host.id>`, per-browser,
invisible, not revocable from the UI. `upload_confirm_enabled` is a different
object: per-user, server-side, visible, revocable. So the contradiction is
rhetorical rather than mechanical.

**The cost is real and is not hidden.** OFF by default means all five upload
doors — picker, drop, pasted file, paste-as-`.txt`, OS share — are unguarded
until someone opts in. Opt-in was chosen over default-on-with-opt-out knowing
that; the measured difference is that the assertion
`has no remember-me door — a second pick confirms again` is red under opt-in and
green under opt-out. It was not deleted but **narrowed** to what survives: while
the confirm is ON there is no per-dialog "don't ask again" — turning it off is a
deliberate trip to settings, not a checkbox on the way past.

### The policy branch sits AFTER normalisation, and that is load-bearing

`enqueueUploads` does not normalise; `normalizeUploadFile` runs inside
`triggerUploads`. So the obvious spelling

```ts
if (!uploadConfirmEnabled()) return enqueueUploads(key, ..., rawFiles)
```

sends the RAW files and re-breaks the iOS `.m4r` case the function exists to
rescue (iOS labels it `application/octet-stream`; only the normaliser maps it to
`audio/mp4`) — reopening exactly the hole #1883 closed. The branch therefore
takes the NORMALISED list, and a test asserts the type that reaches the host on
the confirm-OFF path, not merely that a call happened.

### A displaced confirm is now reported instead of vanishing

`consumeShare` → `dropUpload` → `triggerUploads` opens a confirm at BOOT, with
no gesture on screen. `confirmDialog` is last-write-wins (a modal is a focus
trap), so any other confirm replaced it and the shared files disappeared with no
banner — an outcome that never reached `recordShareTargetBlock`. `ConfirmRequest`
gains an optional `onDisplaced`, fired when a pending request is REPLACED (never
when the operator answers it), and the share path passes one that records the
new `confirm-displaced` block reason. The callback is optional and the asymmetry
is deliberate: every other door is driven by a gesture still on screen, so "ask
again" is the operator repeating it; the share target has nothing to repeat.

Only reachable with the confirm opted IN — but that is a reason to fix it once,
not to leave it for whoever turns the setting on.

_Deploy: **COLD** — new server routes + context accessors. cic changes ride with
it; no wire-shape change (settings endpoints are outside the generated wire
schema, so no `protocol_version` bump)._
<!-- entry #1883e -->

---

## 2026-09-05 — #1883e: the privacy notice runs before the send confirm

**Reported in testing (Gabriele, 2026-09-05): the Send confirm opened FIRST and
the "files go to <host>" notice second.** Not a preference — an ordering bug.
The notice states the TERMS (which host receives the bytes, and for how long); a
question about terms is worth nothing once the answer has been given. The
operator was told where their file goes only after committing to send it.

**Cause: the gate sat in `startUpload`, inside the queue pump.** That is
downstream of the Send confirm by construction — `triggerUploads` asks,
`enqueueUploads` queues, `pumpQueue` pumps, and only then did `startUpload`
check `image-upload-privacy-acknowledged:<host.id>`. Before #1883d moved the
confirm into `triggerUploads` there was no second modal to be out of order
with, so the placement was invisible rather than wrong.

**Fix: the gate moves to the FRONT of `triggerUploads`**, ahead of both doors:

```
privacy notice → send confirm → enqueue → upload      (opt-in ON)
privacy notice → enqueue → upload                     (opt-in OFF)
```

What waits behind the notice is a **continuation** (`pendingTrigger`), not a
staged file, because what comes next depends on the opt-in. `acknowledgePrivacy`
clears it before invoking it, so a resume that opens another modal cannot
re-enter a stale one; `dismissUpload` drops it, and since nothing is queued yet
**dropping the continuation IS the cancel**.

**The old gate was REMOVED, not left as a belt.** Two gates would ask an
operator who declines "don't show this again" twice per batch — once at the
trigger, once per file in the pump. With `enqueueUploads` private and reachable
only through `triggerUploads`, nothing can arrive at the queue
un-acknowledged, so the second check could only ever re-ask. `pendingPrivacyGated`
went with it: dead state, and a parallel structure that would have drifted.

**Accepted behaviour change, stated so it is not rediscovered as a bug.** An
operator who never ticks "don't show this again" is now asked **once per BATCH**
rather than once per FILE — dropping five files was five notices. That also
matches the Send confirm's own granularity.

**Known rough edge, NOT fixed here.** "Don't show this again" remains a one-way
door: the only way back is deleting the localStorage key by hand. That is
exactly the criticism #1883 levelled at this flag (per-browser, invisible, not
revocable from the UI), and now that upload preferences have a home in settings
the reset belongs next to the opt-in. Deliberately out of scope for this slice.

_Deploy: **HOT — `--cic` only.** Client ordering; no server change._
<!-- entry #1920 -->

---

## 2026-09-05 — #1920: the credit roll enters from the bottom, and the soundtrack becomes a suite

Two reports from vjt on #grappa against staging `b06262041`, one a defect and
one an ask, shipped together because they are the same loop seen twice: what
happens when the titles come back round.

### The entrance was measured against the wrong box

> «i credits riappaiono in mezzo allo schermo dopo esser scrollati tutti su,
> dovrebbero ri-apparire dal fondo»

`@keyframes credits-roll` opened on `transform: translateY(100%)`. **A
percentage translate resolves against the element's OWN border box**, and
`.credits-roll` is `position: absolute` with `left`/`right` but no `top`, so
its static position puts its top edge at y=0 of `.credits-viewport`.
`translateY(100%)` therefore parked that edge at y = the roll's own height —
below the fold ONLY for a roll taller than the window.

It is not. With the nine contributors this repo bakes, the roll is a few
hundred px against a ~1000px viewport, so every cycle began with the titles
already fully on screen, halfway up. The exit was never wrong: `-100%` is
exactly the roll's own height past the top, which is what "cleared" means for
the roll.

So the fix is an ASYMMETRY, and it reads like an oversight unless it is
written down: **the entrance is viewport-relative (`100dvh`) and the exit
stays self-relative (`-100%`)**, because arriving is a fact about the window
and leaving is a fact about the roll. `dvh` rather than `vh` for the reason
#205 records at `#root` — `100vh` is iOS Safari's URL-bar-hidden LAYOUT
viewport, which would start the roll below the visible bottom and eat the
first seconds of the entrance — with #205's `@supports not (height: 100dvh)`
re-declaration carrying the `vh` fallback, since biome forbids the classic
duplicate-property spelling.

**The test that should have caught this was the one that encoded it.**
`creditsRain.test.ts` asserted `all[0]?.transform === "translateY(100%)"`
under the name *"holds it OFF-SCREEN, and re-enters from the bottom"*. The
name and the value disagreed and the value won for two issues. It now asserts
on the UNIT (`/^translateY\(100d?vh\)$/`) rather than on a number: no roll
height makes a `%` entrance correct on every window, so pinning the unit is
pinning the claim.

**Accepted cost, stated so it is not rediscovered as a bug.** The cycle is
still 34s while the distance covered grew, so the titles travel faster than
they did — on a short roll, noticeably. The alternative is measuring the
distance in JS and setting the duration from it, i.e. a layout read per
resize to hold steady a number nobody has complained about. Declined.

### One bar became four movements, and the ROLL picks which

> «e dovrebbe cambiare la musichetta quando ri-appaiono» /
> «più variegata più chiptune più voci»

#1916 made the phrase four bars and left it looping verbatim: about four and a
half repeats per 34s cycle, identical on every cycle. `MOVEMENTS` replaces
`BARS` — four movements of four bars, each with its own progression, pulse
width, drum pattern and second-channel role — and the movement index comes
from `creditsRoll.creditsRollPass(roll)`, which reads `currentIteration` off
the roll's own CSS animation.

**ONE CLOCK, the same doctrine `creditsRain.rollIsParked` follows.** A
`setInterval` at 34s would be a second clock, and it would disagree exactly
where it matters: a backgrounded tab freezes rAF and the animation with it
while timers keep running, so the music would turn over while the titles stood
still. The accessor is read inside the scheduler's own pump, one bar ahead of
what is heard, so the switch can only land on a bar line; `barIndex` resets
with it, so the incoming movement enters at ITS first bar rather than wherever
the outgoing one had got to.

**The channel model is the NES's, and that is what makes `harmony` and `arp`
mutually exclusive.** Two pulses, one triangle, one noise. The lead owns pulse
one; the second pulse does a harmony line OR sixteenths, never both, because
it is one channel and a chip that could sound both would not be a chip. The
harmony is DERIVED rather than written out — the nearest chord tone below the
lead note, which tracks it in thirds and fourths that are in key by
construction; a second `Eight<Note>` per bar would be the same information
typed twice, and the copy that drifts is always the one nobody hums.

**"Più chiptune" is mostly the pulse WIDTH.** `OscillatorNode` has no 25% or
12.5% type, so those are `PeriodicWave`s built from the duty-`d` series
`(2/nπ)·sin(nπd)`, 24 harmonics, cached per width and normalisation left ON so
the rendered peak stays ≤ 1 (the gain budget is stated in those terms). 50%
stays the built-in `square`, so the OPENING movement is #1916's timbre exactly
rather than a ringing 24-harmonic approximation of a wave the engine already
has. An engine with no `createPeriodicWave` loses the width, never the note.

### The gain budget did not move, and that is the constraint the rest bends around

`PEAK_GAIN` is untouched, and the ceiling is still #1773's worst instant
(1.4167 × master). More voices had to be paid for out of existing headroom, so
a lead WITH a second channel under it comes down to 0.74 by exactly what that
channel takes, and a lead without one keeps 1. Both arrangements land on 1.36
— under #1916's 1.41, so this is quieter at its worst, not louder — and the
opening movement is therefore not quieter than what shipped, which would have
been an odd thing to trade for an improvement to pass two.

`creditsAudio.test.ts` measures that across EVERY movement rather than
trusting the arithmetic above: the per-movement peak is the claim, and a suite
whose loudest movement is untested is a suite with no bound at all.

### What is NOT proven here

The vitest suite could not be run on the host that wrote this (`nowhere`,
node 20: jsdom's undici needs `webidl.util.markAsUncloneable`, node ≥22). Types
(`tsc --noEmit`) and lint (`biome check`) are green locally, and the score's
arithmetic — the per-movement loudness bound, the harmony staying below the
lead, the movements being distinct, the suite wrapping — was measured directly
off an esbuild bundle of the module. **The unit suite's verdict is CI's**, and
nothing here should be read as a claim that it passed locally.

_Deploy: **HOT — `--cic` only.** Client-side; no server change._

## #1922 — the movements get a RHYTHM, because #1920's did not

> «ok molto meglio ma le musichette so tutte uguali»

vjt, on the deployed #1920. He is right, and the reason is legible in the score
that shipped: `MOVEMENTS` gave every pass its own progression, pulse width, drum
pattern and second-channel role — and left every one of them playing **eight
eighth-notes of lead over four quarter-notes of bass at one tempo**, walking the
chord up, back down and out on a step. All four movements were one rhythm,
transposed. That is one tune played four times, and no duty cycle fixes it: an
ear separates two tunes by where the notes fall and how long they last, which is
precisely the dimension #1920 held constant.

**The tests could not have caught it, and that is the more useful lesson.** Every
#1920 assertion about the movements differing compares PITCHES —
`JSON.stringify(events.map(e => [voice, hz, at, duty]))`, distinct across the
suite, green on four transpositions of one figure. A test that compares the
*colour* of music will pass an arrangement with no variety in it at all.

### `lead` and `bass` become slot arrays

A `Line` covers exactly one bar, so its LENGTH is the subdivision: 4 is
quarter-notes, 8 eighths, 16 sixteenths. A movement changes its felt tempo by
changing its resolution, and `BAR_S` never moves — the bar line is where the
suite is allowed to turn over, and the bar is the unit the roll's cycle is
counted in. Two slot values are not notes: `null` RESTS, and `"-"` HOLDS the
previous note through this slot. Those two are what buy syncopation and sustain,
and neither can be spelled in a row of eight notes that all have to sound.

The hold is a slot rather than a duration on the note ON PURPOSE. A note that
carried its own length could disagree with the array it sits in — a bar adding
up to more than a bar, which the scheduler would happily arm straight over the
next one. A `"-"` with nothing to hold (first slot, or straight after a rest) is
simply a rest: making it an error would buy a compile-time check on a score
nobody outside this file writes, and cost the ability to start a bar on the tail
of the one before it.

The four movements now span densities rather than transposing one figure:

| movement | grid | what it sounds like |
|---|---|---|
| `opening` | 8, straight | #1916's phrase, untouched — and now also the ruler |
| `swing` | 8 with ties and rests | lead breathes, bass answers in the holes |
| `descent` | 4 (half-time) + 16ths arp | quarters over a bass that holds three beats |
| `finale` | 16 | sixteenths, root/fifth bass on eighths, hats all the way down |

`opening` is deliberately untouched: it is the pass everybody sees, nobody
complained about it, and #1922 is not a licence to relitigate it.

**The finale is not faster.** It is 125 BPM at twice the resolution, which is the
trick chip music uses to end on a lap of honour — and the reason the tempo is
still one number for the whole suite.

### What the constraint did to the score

`PEAK_GAIN` and every voice peak are untouched, so the ceiling is still the same
lead + second channel + bass + snare it was. That holds only because **no
movement sounds two lead notes at once** — a held note ends exactly where the
next begins — which is now a test rather than a property of a fixed-length row.

The harmony is placed at the lead's own `at` and `durS`, held notes included: a
harmony on its own grid would flam against the note it is shadowing. The drums
are the one voice whose LENGTH does not follow the grid — a hit's length is the
sound of the hit — so only their placement is read off the array.

**No lead note goes above B5.** `PULSE_HARMONICS` (24) × B5 (~988 Hz) is 23.7 kHz,
under the Nyquist frequency of a 48 kHz context; a pulse whose top harmonic folds
back is an out-of-tune whistle rather than a bright note. The finale runs
sixteenths high in the register, which is exactly where a future edit trips over
this, so it is pinned by a test too.

### What is proven here

The unit suite **was** run on `nowhere` this time — 30/30 — by pointing vitest at
a throwaway config with `environment: "node"` and `setupFiles: []`, which is what
sidesteps the node-20 jsdom breakage recorded above (`setupTests.ts` reaches for
`HTMLMediaElement`, which a node environment does not have). That is a narrower
run than CI's: this file's tests need no DOM, and nothing else in the suite was
executed. Types and lint are green locally. **Everything outside
`creditsAudio.test.ts` is still CI's verdict.**

_Deploy: **HOT — `--cic` only.** Client-side; no server change._
<!-- entry #1929 -->

---

## 2026-09-06 — #1929: the roll, the cow and the special thanks are one block, and a fade hands over to the prose

The credit roll ended where the names ended. vjt's brief is that the names, a
cowsay and a special-thanks list are **one block — the first one** — and that
the paragraph sets #1924 introduced begin only on the other side of a fade out,
with the matrix rain thickening through it.

### One block, and what that buys

`.credits-block` is a new wrapper inside `.credits-roll` holding the titles, the
contributors, the cow, the thanks and the coda. It is not decorative: it is the
element carrying the fade, so it is what dissolves and what the rain reads. The
animation could not go on the roll itself — the roll outlives the block and
carries the prose afterwards, so a `forwards` fade there would dim every
paragraph set for ever.

The prose is now gated on `pass() > 0` rather than merely on a set existing. The
two used to share the first pass, in the same column, which is exactly the
adjacency the issue says is wrong: the block is supposed to hand over to the
prose, not be trailed by it. The set is also drawn LAZILY now — on open the
signal is cleared instead of dealt from, because a set drawn for the first pass
would be replaced by the first `animationiteration` without ever being on
screen, quietly spending one of the deck's no-repeat draws.

### The cow is bahamut's, reused rather than redrawn

`azzurra/bahamut src/version.c.SH:145-152` — the `/info` infotext that reads
`This bahamut has Super Cow Powers !`. The body is transcribed byte-for-byte;
only the sentence changes, to `This grappa has Super Cow Powers !`. That is the
smallest edit that makes it speak for grappa, and choosing it rather than
writing a new joke is the whole point: an ASCII animal that merely resembles
Azzurra's would be a different joke told to nobody.

The BALLOON is generated from the sentence rather than transcribed, so the
rules can never disagree with the text — the failure mode of a hand-drawn box
is that someone shortens the words and the underscores stay the old length.
That generator is only trusted because it is checked against the original:
fed bahamut's own sentence it emits bahamut's own eight lines, underscore for
underscore, and the test asserts exactly that before any claim about "the same
cow" is made. It handles ONE line and does not wrap; real cowsay breaks at 40
columns into a multi-line box with shoulders, and half of that would be worse
than none.

### The special thanks are dictated, and the test says so

Copied verbatim from the issue, in the order given. **Sonic is thanked twice**
— once among the people keeping Azzurra standing, once for bicchierino — and a
test pins that, because deduplicating him is precisely the helpful cleanup a
later reader will reach for. The list is pinned in full and by length: the
first catches an edit, the second catches an insertion.

### The fade rides the roll's clock, and the rain reads it

`@keyframes credits-block-fade` runs on the same 34s as `credits-roll`, once,
with `forwards`. It holds opacity until 70% and reaches zero at **82%, which is
the offset the roll parks at** — the block finishes dissolving exactly as it
finishes leaving, so the interlude that follows is pure rain with nothing
half-visible in it. Those two numbers must agree and neither is copied into TS:
`creditsRain.test.ts` reads both out of the stylesheet and fails if they part.
Both pins were falsified before being believed — moving the fade end to 80%
reds the seam test, and declaring the fade at 30s reds the clock test.

No wall-clock timer anywhere, and that constraint is the same one #1807 and
#1920 wrote down: a `setTimeout` at "about thirty seconds" is a second clock,
and it disagrees in the case that always breaks these — a backgrounded tab
freezes rAF and the animation with it while timers keep running.

`creditsRainLook` now takes the block as well as the roll and bursts when
EITHER says there is nothing left to compete with: the roll parked, or the
block dissolving. `blockIsFading` reads the fade's start off its own keyframes
the way `rollIsParked` reads the park offset, so retiming the dissolve moves
the rain's surge with it.

**The rain reaches the existing burst look at the dissolve's start; it does not
ramp into it.** That is a deliberate reuse of #1807's two-look model rather
than a new one. A gradual thickening would mean interpolating four knobs —
one of them an `rgba` string needing a parser — to render a four-second
nuance, which is more mechanism than the effect is worth. If vjt wants the
thickening gradual rather than immediate, that is the change, and it is
contained to `creditsRainLook`.

### What is NOT established here

* **Nothing was seen.** There is no browser and no handset in this session, so
  every visual claim is arithmetic and unit tests. That the fade reads as a
  dissolve rather than as a cut, and that the rain surge lands where it should,
  is a human's verdict on a real screen.
* **The cow's fit on a narrow phone is computed, not observed.** 38 columns at
  `min(0.8em, 3vw)` against the 88vw the rest of the roll keeps; `white-space:
  pre` because wrapping fixed-width art does not degrade it, it destroys it.
  The `min()` is what should keep it whole at 320px, and it has not been seen
  at 320px.
* **The first pass now travels faster, and by how much is an estimate.** The
  cycle is a fixed 34s over a distance of one viewport plus the roll's height,
  so a taller block is a quicker block. The block gained the cow and the thanks
  and LOST the prose to the second pass, which nets out at roughly +15% travel
  distance by line count — not measured, and not obviously worth the layout
  read per resize that #1920 already declined. **Re-derived against #1927,
  which landed under this branch:** dropping `[bot]` authors takes the
  contributor list from 9 rows to 8 (`git shortlog -sn --no-merges`, measured
  on `3037acb14` — `dependabot[bot]`, 49 commits, is the only one), so the
  estimate was computed over one row more than the roll now carries. Direction
  unchanged and the shift is inside the imprecision the word "roughly" was
  already carrying; the countervailing term — `nick (Name)` being a longer
  string that may wrap to a second line on a narrow viewport, ADDING height —
  is not measured either, and the two are not claimed to cancel.

_Deploy: **HOT — `--cic` only.** Client-side; no server change._
<!-- entry #1931 -->

---

## 2026-09-06 — #1931: the credits end — a spent deck, a manifesto, a pulsing heart and a way out

The credit roll never finished. `createProseDeck()` is an infinite shuffle
bag, so once the sixteen prose sets had been dealt it reshuffled and started
again. vjt's brief is that the sequence should have an ENDING, and an addendum
dictated the same evening put a fourth thing in it. End to end:

    block (roll + cow + thanks, #1929)
      → prose sets until the bag is spent
      → the manifesto, under music of its own
      → the credits AGAIN + a pulsing <3 + a closing line + a close button

### The trigger is the deck, and the deck now says so

The ending fires when every set has been dealt once — not on a pass counter
and not on a timer. Both of those are a second tally of what the reader has
actually been shown, and the one thing an ending must not get wrong is
arriving early.

`ProseDeck.exhausted()` is DERIVED rather than counted: the bag, the last
index dealt and the pool size already say it between them, so a `dealt` field
would be a parallel account of one fact and the copy that drifts is always the
one the ending reads. The subtlety is the `last !== null` conjunct — the
refill is lazy, so a bag that has never been filled and one that has been
dealt out are the same empty array. Without it an empty pool reads as
"everything has been shown" and cuts to the ending on pass one. That case has
a test.

### A stage, not a pass number

`CreditsModal` had `pass()`, set from the roll's own `currentIteration`. It
could express "show the names" and nothing else. It could not express "the
deck is spent", and it could not tell the manifesto from the finale — both
would have become arithmetic on a number that means something different, which
is exactly how an early "that's all, folks" gets written.

So the modal carries a closed set: `"block" | "prose" | "manifesto" |
"finale"`, walked by `advance()` on the roll's `animationiteration`. The BRANCH
ORDER inside it is the guarantee, and the test asserts the heart's absence on
every one of the sixteen turns before the end rather than on a sample, because
the interesting failure here is an off-by-one.

`endingDue` is one session-scoped boolean and it is **not** a copy of
`deck.exhausted()`. The deck reports an EDGE — the draw that empties the bag —
and the ending is two turnovers later, so something has to hold the news in
between. Clearing it when the finale arrives is what makes both reopen cases
right, and they pull in opposite directions:

* close one set short and come back → you land on the ending. The deck is
  session-scoped on purpose, so progress across viewings is not thrown away.
* come back after a FINISHED run → you get prose again. A latch that stayed
  set would replay the ending for ever and put all sixteen sets out of reach
  for the rest of the session.

### The roll STOPS, and that is what settles the rain

Everything in this modal travels. A close button that scrolls off the top is a
button the reader waits a full 34 s cycle for — so when the ending arrives the
roll is parked, reusing the posture `prefers-reduced-motion` already has in
this stylesheet (`position: static; animation: none`) rather than inventing a
second one.

The reuse pays a second time, and this is the answer to "the rain must not
fight the heart, and no third clock": **both readers in `creditsRain` ask the
roll's animation what phase it is in, and an element with `animation: none`
has none to report** — which they already answer "steady" to, pinned since
#1807 by the no-animation case. The rain settles with no new code, no new
dial, and nothing in `creditsRain.ts` touched.

The fade splits off `.credits-block` onto `.credits-block-fading`, because the
block COMES BACK for the finale and the fade is `1 forwards`: a re-mounted
element still carrying it would dissolve the ending as it arrives. Invisible
in review, fatal to the one screen the reader is meant to act on.

CSS cannot share declarations across a media boundary, so the ended rules and
the reduced-motion rules carry the same text twice. A test compares them
declaration for declaration, with a positive control that the travel is
genuinely off — a comment asking the next reader to keep two rules in step is
what lets rules drift.

### Three pieces of music on one graph, dissolved rather than cut

vjt: *"musichette crossfade"*. The soundtrack gains a manifesto theme and a
closing cadence beside the suite, and the joins are dissolves.

That is why there are now three gain buses under the master. A crossfade needs
both pieces audible at the same instant, which one retargeted bus cannot
express — it can only dip to silence and come back, which is the cut with
extra steps. Notes connect to the bus of the piece that ARMED them, so the
outgoing bar rings on while its bus ramps down, and the incoming piece enters
at `currentTime` instead of at the next bar line, which can be most of a bar
away and would run the fade out over silence.

`linearRampToValueAtTime`, not the `setTargetAtTime` the mute uses:
setTargetAtTime approaches asymptotically and never arrives, so two of them
cannot share the landing instant that makes a pair of ramps a crossfade.

**The master is deliberately outside all of it**, and that is load-bearing
rather than incidental layering. Mute and teardown have to work MID-DISSOLVE,
when two buses sound and three carry ramps scheduled into the future. Mute
acts above the buses, so it silences the fade without fighting it on the same
params; the teardown cancels the pending ramps on every bus before dropping
the graph. Closing the context would mask a missing cancel in practice — which
is why the test asserts the cancel and not the close, at the exact moment of
the fade.

The cadence is ONE-SHOT. An ending on a loop is a ringtone, which is the
defect #1916 was filed for.

### What is licensed, and what is therefore NOT in the tree

* **The tune quotes nothing.** The Looney Tunes outro is "The Merry-Go-Round
  Broke Down" (1937) — US copyright to 2033 — and "That's all Folks!" is a
  Warner Bros. trademark, which does not expire at all. The cadence borrows
  the SHAPE of an ending (rise, turn, land, over a plagal iv–i) which is
  nobody's property. A test pins the contour rather than the pitches, so the
  tune can be rewritten without touching it, and forbids the trademarked
  string by name.
* **The manifesto's TEXT ships, on vjt's own clearance.** "The Conscience of a
  Hacker" (The Mentor — Loyd Blankenship, *Phrack* Vol. 1 Issue 7 Phile 3, 8
  January 1986) is from 1986, was never dedicated to the public domain and was
  never put under a free licence; forty years of universal reproduction is
  CUSTOM, not permission, and grappa ships a public PWA and a `.deb`. So the
  slot was built empty first, behind one named constant, with a tripwire test
  that failed if the manifesto's own opening lines appeared — the standing
  instruction being *do not include it until vjt confirms in writing*. **He
  confirmed on 2026-09-06**, as the repository's owner, on the stated grounds
  that the project is open source and that he will comply with a takedown if
  one is ever asked for. The tripwire is therefore gone and its tests now pin
  what SHIPS: the words, the credit beside them, and the two ways the paste
  can be corrupted silently (below). **The decision is recorded with whose it
  was on purpose** — the block is still in this file's history, and a reader
  who finds it must be able to see what lifted it rather than re-derive it.
* **The attribution is not decoration, it is the term.** It was written before
  the words arrived, and the render-level test asserts the credit is inside
  the same block as the text — the constant-level pin cannot see a markup edit
  that drops one and keeps the other.
* 🔴 **Two silent corruptions of the pasted text, both pinned.** (1) The Phrack
  header art is `\/\The Conscience of a Hacker/\/`, and in a plain template
  literal `\/` is an escape for `/` — the backslashes vanish with no error and
  nothing in a diff to catch the eye. `String.raw` is why they survive. (2)
  What was pasted in carried a monotonically growing indent (0, 8, 16, … past
  100 columns), an editor auto-indent artifact rather than Phrack's layout,
  and the slot renders `white-space: pre-wrap` in a 64ch column where that
  wraps into noise on a phone. Every line is flush left — ONE rule applied
  uniformly, rather than a reconstruction of the original two-level shape,
  which the mangled indent no longer contains enough information to recover.
  The words are untouched; the paragraph breaks do the structuring.
* **The closing line was a placeholder for a smaller reason** — the wording was
  vjt's call, not the implementer's. It resolved the other way round: vjt
  approved the implementer's line on 2026-09-06 and changed one word,
  `friends` → `folks`, which is the Looney Tunes cadence landing in the one
  place it can land without quoting the mark.
* **The manifesto is its own block and not a seventeenth prose set.** It is
  ~570 words against a cap of 300, and the cheap way to fit it is to raise the
  cap — which silently un-bounds all sixteen sets the cap exists to keep
  readable. `PROSE_SET_MAX_WORDS` is therefore pinned BY NUMBER, so raising it
  is a red test rather than a quiet edit. The pin cannot read intent and does
  not try to: it makes ANY move an argued diff.

⚠️ **A retraction, and the rule it cost.** This entry first carried a
"measured correction to the issue": the issue calls the cap "300 after the
raise", and `git log -S 'PROSE_SET_MAX_WORDS = 300'` on `creditsProse.ts`
returned nothing while `= 150` returned `31fa3bd92`, so the raise was declared
never to have happened. **The search was right and the inference was wrong.**
The raise existed as an OPEN PR, not as a commit — it landed a few hours later
as the copy rewrite, and the cap is 300. The manifesto is ~1.9× the cap, the
ratio the issue always claimed.

**The rule: `git log -S` answers "is this in the history of THIS ref", never
"does this exist".** Those are the same question only when nothing is in
flight, which is exactly the condition a concurrent worktree cannot assume.
The failure is silent and reads as rigour — an empty search result looks like
evidence of absence and is quoted as one. When a search over history is about
to contradict a written spec, the missing half is the open PRs; the honest
form of the claim names the ref it was measured against and its date.

The pin itself was not the mistake and did not change shape: it moved from
`toBe(150)` to `toBe(300)` and still forbids the one move the block exists to
prevent. What changed is that its comment no longer accuses the issue of
inventing a number.

### What is NOT established here

* **Nothing was seen.** No browser and no handset in this session, so every
  visual claim is arithmetic and unit tests. That the heart reads as a
  heartbeat rather than as a spinner, that the dissolves sound like dissolves,
  and that the stopped roll leaves the button somewhere sensible on a phone,
  are a human's verdict on a real screen.
* **The crossfade is measured as SCHEDULING, not as sound.** The tests assert
  which ramps are scheduled on which bus and when; no test renders audio. An
  `OfflineAudioContext` would measure the mix, and this does not use one.
* **The gain budget is pinned per piece, not across a dissolve.** Each new
  piece is proven no louder than the loudest bar of the suite; during the
  overlap two buses sound at once, and the argument that the fade keeps their
  sum in hand is arithmetic, not a measurement.

_Deploy: **HOT — `--cic` only.** Client-side; no server change._
<!-- entry #1938 -->

---

## 2026-09-06 — #1938: mint 1.10.0, and a CVE gate that was green for the wrong reason

`mint` moves 1.9.3 → 1.10.0 in `mix.lock` and nowhere else. `finch 0.23.0`
requires `mint ~> 1.8`, so 1.10.0 satisfies a constraint already written and
`mix.exs` does not move: the diff is one line.

Two advisories, both against `Mint.HTTP1`, both fixed in 1.10.0, both read
from `repos/elixir-mint/mint/security-advisories` rather than inferred:
CVE-2026-82728 / GHSA-g83f-2j6r-q6m4 (HIGH — unbounded response-line
buffering, range `>= 0.1.0 and < 1.10.0`) and CVE-2026-82729 /
GHSA-7p8w-j234-7qc8 (MEDIUM — quadratic chunk-size parsing, range
`>= 1.9.3 and < 1.10.0`). Both describe a hostile SERVER exhausting its
CLIENT, which is why the reach matters and not merely the presence: `{:req,
"~> 0.5"}` carries no `only:`, so req → finch → mint is a runtime path, and
the link-preview fetch in `lib/grappa/net/image_fetcher/req.ex` dials a host
chosen by whoever pasted the link. The attacker picks the server. The captcha
siteverify in `lib/grappa/admission/captcha/site_verify_http.ex` dials a fixed
endpoint and is the weaker of the two.

### The gate was silent, and the tool was not broken

🔴 `mix deps.audit` exits **0 on mint 1.9.3**, measured before the bump, and
**0 again after it**. The pre/post pair is therefore VACUOUS as evidence that
this change fixed anything, and it is recorded here as vacuous rather than
quoted as a green.

The cause is the database, not the tool. `mix_audit 2.1.5` vendors nothing:
`MixAudit.Repo` clones or pulls `github.com/mirego/elixir-security-advisories`
into `$HOME/.local/share/…` on every run and **discards the exit status of
that `git`** — so a failed fetch yields an empty advisory list and a confident
`No vulnerabilities found.` Here the fetch worked, and that was checked rather
than assumed: the local clone sits on upstream's tip `5246bccd9`
(2026-09-04T00:46:43Z) with `FETCH_HEAD` rewritten by the run. That tip
predates the two advisories by nine hours — they were published 09:45:35Z and
09:46:33Z the same day — and querying upstream's `packages/mint/` directly
returns the same four files the clone holds, all disclosed 2026-06-02 and all
first patched in 1.9.0, none of which reaches 1.9.3.

The matcher was then proven to fire, so that the silence has exactly one
remaining cause. Against the real loaded database (116 advisories):
`cowboy 2.14.0` yields 1 vulnerability (positive control), a package that does
not exist yields 0 (negative control), and `mint 1.8.0` yields 4 — the same
four rows, matched on the same package name. `mint 1.9.3` and `mint 1.10.0`
both yield 0.

The lag is not the nine hours. mirego carries four of the ten mint advisories
GitHub publishes, and the four it is missing from 2026-07-06 through
2026-07-16 are still absent seven weeks later. **So the reading to retire is
"`deps.audit` green ⇒ no known CVE in the tree."** The honest reading is "no
CVE that mirego has imported, matched against the version we lock". A bump
justified by an advisory younger than the importer's lag will show a green
before and a green after, every time, and the gate cannot be asked to prove
its own worth on that shape.

### What was deliberately not touched

The cowboy/cowlib derogation in `mix.exs` (#149) was neither extended nor
leaned on — it was not needed. Our lock carries cowboy 2.17.0 and cowlib
2.18.0 while every mirego range for those packages tops out at 2.15.0 /
2.16.1, so `deps.audit` is silent there by arithmetic and not by exemption
(measured: both yield 0 against the same loaded database). Separately, the Hex
resolver's own OSV feed — a third database again, printed during
`deps.update` and not a gate — flags cowboy 2.17.0, cowlib 2.18.0 and
**bandit 1.12.4** (CVE-2026-74836, HIGH). Bandit is the production server, so
that one is not covered by the test-only reachability argument the derogation
rests on; it is outside this change and left exactly as found.

_Deploy: **COLD** on every substrate. Measured, not reasoned:
`Preflight.classify_paths(["mix.lock"], s)` returns
`{:cold, [mix_deps: ["mix.lock"]]}` for `:jail`, `:linux` and `:docker` alike,
and a dep's beams live outside the app ebin that `HotReload.reload_modified/0`
walks._
<!-- entry #1939 -->

---

## 2026-09-06 — #1939: the sidebar was the only place that title-cased a window label

A user on #grappa reported that the desktop sidebar spells the home window
`Home` while everything around it is lowercase. Measured in `cicchetto/src`
before the change: `Sidebar.tsx` renders `Home`, `admin`, `channels` and
`mentions`; `RailActions.tsx` renders `home`, `admin`, `rooms`, `mentions`,
`player`, `radio`, `themes`, `archive`, `settings`, `refresh`, `denoise`,
`mute`, `switch account`, `quit`, `actions`. So `Home` was not one convention
among two — it was a single literal disagreeing with every sibling in its own
component AND with the rail's spelling of the very same window.

**The rule this settles: a window label rendered in cic chrome is lowercase,
and when a window is reachable from more than one surface the surfaces spell
it identically.** irssi's own window list is lowercase; the rail was already
right; the sidebar was the outlier and moved.

### `ScrollbackPane.tsx` keeps its `"Home"`, and it is not an exception

The reported string appears a second time, in `ScrollbackPane.tsx`. It is
NOT a label: it is a member of `SCROLL_KEYS`, the set matched against
`KeyboardEvent.key` in the pane's keydown handler to decide whether a key
press counts as an operator scroll for the settle-arm gate. `Home` there is
the DOM key name of the Home key, next to `PageUp`, `End` and `ArrowUp`.
Lowercasing it would silently stop the Home key from arming the gate. The
general shape worth keeping: a capitalised string in a UI file is a label
only if something renders it — follow it to its consumer before treating a
casing convention as applying to it.

### The four e2e assertions that moved with the label

`cursor-forward-only`, `issue160-virtual-tab-no-cursor`,
`issue356-notify-highlight-feedback` and `ux-5-b-home-emoji` each pin the
rendered text, and all four matchers are case-sensitive
(`getByRole(..., { exact: true })`, `hasText: /^Home$/`, `toContainText`), so
they had to move in the same commit or go red on a label they themselves
document. The two `getByRole("button", { name: "home", exact: true })` calls
stay page-wide and stay unambiguous: the rail's home button also contains the
text `home`, but it carries `aria-label="open home"`, and an `aria-label`
takes precedence over element contents when the accessible name is computed,
so it is not a second match. `gotoHome()` in `issue496-home-restyle` and
`registration-wizard` was never affected — both click `.sidebar-home-btn`.

### What was declined

A test asserting "every static sidebar label is lowercase". It cannot be
written without a hand-maintained enumeration of the static rows
(`.sidebar-home-btn`, `.sidebar-admin-btn`, `.sidebar-list-row`,
`.sidebar-mentions-row`), because the `.sidebar-channel-name` class that
carries the labels ALSO carries data the convention does not govern —
network slugs, channel names, query nicks. That enumeration is exactly the
parallel structure that needs housekeeping and drifts, and it is heavier
than the one-literal defect it would guard. The convention is recorded here
instead; the existing per-row assertions are case-sensitive and each reddens
on its own row.

### What is NOT established here

* **Nothing was seen and no e2e ran.** This slice had no browser and no e2e
  lane. The four spec edits are typechecked (`tsc -p e2e/tsconfig.json`) and
  argued from Playwright's documented matching semantics; they are not
  executed here.
* **Only the sidebar literal moved.** Prose in comments and test titles that
  calls the window "Home" was left alone — it names the window, not the
  label, and rewriting it across the tree buys nothing the reader needs.

_Deploy: **HOT — `--cic` only.** Client-side; no server change._
<!-- entry #1942 -->

---

## 2026-09-06 — #1942: bandit, cowboy, cowlib — every advisory that has a fix, and the three that do not

Three lock lines move and nothing else: `bandit` 1.12.4 → 1.12.5, `cowboy`
2.17.0 → 2.18.0, `cowlib` 2.18.0 → 2.19.0. `mix.exs` is untouched, because it
did not need touching — `bandit "~> 1.6"` and `bypass "~> 2.1"` already admit
the targets, and `plug_cowboy 2.9.0` asks for `cowboy ~> 2.7`, which 2.18.0
satisfies. Sibling of #1938 (mint), same shape, same posture.

### bandit is the one that matters, and the reason is the listener

Production serves on Bandit, so its two advisories sit on the live HTTP
listener rather than behind a test-only dependency: EEF-CVE-2026-74836 /
GHSA-xj8g-532w-jv94 (HIGH — HTTP/2 connection-window starvation pins Plug
processes indefinitely) and EEF-CVE-2026-75484 / GHSA-x3gh-xhj4-3vq8 (MEDIUM —
HTTP/2 header values carrying CR, LF or NUL reach the application
unvalidated). Both first patched in 1.12.5. cowboy's EEF-CVE-2026-65624
(MEDIUM, `max_headers` bypass via duplicate header names) and cowlib's
EEF-CVE-2026-59248 (HIGH, unbounded HPACK/QPACK prefixed-integer decoding) are
the same class of memory-exhaustion DoS but arrive only through `bypass`
(`only: :test`), so they are hygiene rather than exposure.

### What it closes, measured rather than asserted

`mix hex.audit` was run before and after and the two lists diffed by advisory
id, so the claim is a set difference and not a reading of the tail:

| | ids |
|---|---|
| **cleared** | EEF-CVE-2026-74836, -75484 (bandit) · -65624 (cowboy) · -59248 (cowlib) |
| **newly appeared** | none |
| **still present** | EEF-CVE-2026-43966, -43969, -43971 (cowlib) |

Seven entries before, three after. The pair is its own positive control: the
BEFORE run named bandit, cowboy and cowlib, so the tool was demonstrably
looking, and a shrunken list means something.

### The #149 derogation survives, and the three that keep it alive

The three cowlib entries that remain have **no fixed release at any version** —
OSV records an `introduced` event and no `fixed` one for a release. Response
splitting in `cow_http_struct_hd:escape_string/2` (-43966, MEDIUM), cookie
request-header injection in `cow_cookie:cookie/1` (-43969, LOW), Link header
directive smuggling in `cow_link:link/1` (-43971, MEDIUM; a fix commit exists,
no release carries it). 2.19.0 does not clear them and no bump can. They stay
under the #149 derogation for the reason written there and not a new one:
cowboy and cowlib enter ONLY through `bypass` (`only: :test`), and production
serves on Bandit and ships neither.

🔴 **What changes is that the derogation's own weakest point is now gone.** It
rests on unreachability, and bandit — which IS reachable, being the production
server — had been sitting in the same `hex.audit` output since its advisories
landed. An exemption argued from "these cannot be reached" reads very
differently when the list it appears in also contains the listener. After this
bump the residue is exactly the set the argument covers.

### The gate did not ask for this, and must not be said to have

🔴 `mix deps.audit` — the hard, blocking gate — exits **0 before this change
and 0 after it**. The pair is VACUOUS as evidence and is recorded as vacuous.
Its advisory database (the mirego mirror, see the #1938 entry for how it is
fetched and how far it lags) carries none of these seven. The step that does
list them is `mix hex.audit`, which is `continue-on-error: true` by the #149
decision and is therefore not a gate at all.

**So this bump unblocks nothing. It closes four real advisories, one of them
HIGH on the production listener.** A future reader looking for the CI failure
that motivated it will not find one, and should not go looking: the motivation
is the listener, not the pipeline.

_Deploy: **COLD** on every substrate. Measured, not reasoned:
`Preflight.classify_paths(["mix.lock", "docs/DESIGN_NOTES.md"], s)` returns
`{:cold, [mix_deps: ["mix.lock"]]}` for `:jail`, `:linux` and `:docker` alike
(positive control: a `lib/` path returns `{:hot, []}`). Same class as #1938,
and for the same reason — a dep's beams live outside the app ebin that
`HotReload.reload_modified/0` walks._
<!-- entry #1945 -->

---

## 2026-09-06 — #1945: storage roots stop being resolved against a CWD nobody chose

The v1.5.0 cold deploy on the production jail did not start. `rc.d/grappa`
launches the release with `su -m grappa -c '.../bin/grappa daemon'` and sets no
WorkingDirectory, so the CWD is `/`; `PEER_AVATARS_STORAGE_ROOT` was unset, its
default was the relative `runtime/peer_avatars`, and
`Grappa.Avatars.Reaper.init/1`'s `File.mkdir_p!` therefore tried `/runtime/peer_avatars`
and died of `eacces` inside the supervision tree. A boot crash, not a degraded
feature. The host was unblocked by setting the variable by hand, which is a
per-host workaround: any operator upgrading without it hits the same wall.

### The defect is the CWD dependency, not the missing variable

Three roots had the same shape — `:cic_dist_root`, `:uploads_storage_root`,
`:peer_avatars_storage_root` — and `Grappa.Uploads.Reaper.init/1` carries the
same bang as the avatar one. Uploads escaped only because the jail's env file
happens to set its variable.

The CWD is not a value an operator sets or sees: it is whatever the init system
left the process in. So a default that reads it is a default nobody chose, and
the three regimes it produces have nothing to do with each other — repo root
under Docker's `WORKDIR /app` and native systemd's `WorkingDirectory=`, `/`
under the jail, and the container's ephemeral layer under the release image.

**The second failure mode is quieter and strictly worse.** Measured on
`ghcr.io/vjt/grappa:latest`: the release image boots CLEAN, no `eacces`,
`/healthz` 200 — because `/app` is owned by the `grappa` user, so `mkdir_p!`
SUCCEEDS and the peer-avatar cache lands in `/app/runtime/peer_avatars`, inside
the container layer and outside the only volume the image declares
(`compose.release.yaml` mounts `grappa-data:/data`, and the image baked
`DATABASE_PATH`, `UPLOADS_STORAGE_ROOT`, `CIC_DIST_ROOT` but not the fourth).
The documented upgrade — `pull` then `up -d` — threw the cache away every
release, silently. A crash at least tells you.

### Two anchors, because the roots have two meanings

One rule (nothing resolves against the CWD), two ways to honour it, and the
split is the domain boundary rather than a compromise:

* **DATA** — uploads and peer avatars now default to
  `Path.join(Path.dirname(DATABASE_PATH), name)`. This is not a new convention:
  `runtime/uploads` was already DOCUMENTED as "the sibling of the sqlite DB".
  The old default only approximated that sentence by borrowing the CWD; the new
  one computes it. `DATABASE_PATH` is the one absolute path prod already
  mandates, which is what makes it the anchor.
* **CODE** — the built SPA dist gets no data anchor (a packaged install puts it
  in `/usr/share/grappa` while the DB is in `/var/lib/grappa`), and needs none:
  `config/config.exs` already expands an ABSOLUTE build anchor, and the actual
  defect there was `runtime.exs` **clobbering** it with a relative literal in
  every env except `:test` — runtime config runs LAST. Unset now derives
  nothing. On the jail, where `mix release --overwrite` runs in
  `/home/grappa/grappa`, that build anchor expands to exactly the path #526
  tells the operator to write by hand.

**An operator-supplied value is kept verbatim, deliberately.** Re-anchoring a
relative one would silently move an existing uploads directory
(`/app/runtime/uploads` → `/app/runtime/runtime/uploads`), and a relative root
under Docker is a WORKING configuration that `.env.example` shipped for a year.
What changes is that prod now logs a warning naming the directory the value
will be read against, so the resolution stops being invisible. Same
belt-and-braces posture as the captcha warning in the same file.

A relative `DATABASE_PATH` is refused outright, because the anchor cannot
deliver an absolute root from one and such a deployment is CWD-bound end to end
anyway (`Grappa.Repo.init/2` mkdir_p's the same dirname). That is a fourth key,
touched knowingly: it is the anchor's precondition, and no shipped template
writes a relative one.

### What the measurement says that the issue text did not

**The derived default equals the value already in force wherever the old one
worked, and differs only where it was broken.** Not argued — pinned, in
`test/grappa/config/storage_roots_config_test.exs`, by reading what each
substrate declares and requiring the derivation to reproduce it:
`compose.yaml`'s `${UPLOADS_STORAGE_ROOT:-/app/runtime/uploads}` and
`${PEER_AVATARS_STORAGE_ROOT:-/app/runtime/peer_avatars}` against its own
`/app/runtime/grappa_<env>.db`, and `Dockerfile.release`'s baked `/data/uploads`
against `/data/grappa.db`. The compose half of that pin was GREEN before a line
of the cure existed, which is the evidence for the claim. `base/deployment.yaml`
is the third witness: it sets `/data/peer_avatars` BY HAND to dodge the
ephemeral relative default, and that hand-written value is character-for-
character what the derivation computes. Three hosts independently wrote the
anchor the default should always have had.

**Two corrections to the report this entry closes out.** (1) The issue proposes
the DATABASE_PATH anchor "and apply the same treatment to all three roots" — the
third root cannot take it, for the reason above, so the class is closed by two
anchors rather than one. (2) The measured follow-up states that "the
absolute-default fix alone is not enough" for the Docker path and that
`PEER_AVATARS_STORAGE_ROOT` must be set in the image env AND in
`compose.release.yaml` "next to the other two roots". Measured: the image bakes
an absolute `DATABASE_PATH=/data/grappa.db`, so the derived default IS
`/data/peer_avatars`, inside the volume — the anchor alone does close that path.
And `compose.release.yaml` names no storage root at all; the other two are baked
in the image, not composed. The image ENV line was added anyway, for parity and
so `docker image inspect` shows the third root without the reader having to know
the derivation; `compose.release.yaml` was deliberately left alone, since adding
the only storage-root override to a file whose stated design is "the image
bootstraps itself" would be the inconsistency, not the cure.

An empty value now counts as unset. It did not before: `System.get_env(x) || default`
keeps `""` because the empty string is truthy, so an empty variable configured an
empty root and `File.mkdir_p!("")` is not a directory. The file's own comment
claimed "Empty / unset = the CWD default"; only half of that was ever true.

### What this does NOT claim

Nothing here was measured on the jail — that host is unreachable from the
worker, so the crash chain is read from the issue and from `rc.d/grappa`, never
observed. The release-image behaviour is likewise the reporter's measurement,
re-derived here only from the files (`Dockerfile.release`, `compose.release.yaml`,
`infra/docker/release-entrypoint.sh`), not from a container that was run. And
the warning path is pinned as "a warning naming the variable is emitted", not as
"an operator will see it in a release boot log", which depends on the handler
state at `runtime.exs` evaluation time and was not tested.

_Deploy: **COLD** on every substrate. Measured, not reasoned:
`Preflight.classify_paths(<the changed set>, s)` returns
`{:cold, [config: ["config/runtime.exs", "config/config.exs"]]}` for `:jail`,
`:linux` and `:docker` alike (positive control: the `lib/` comment-only paths
alone return `{:hot, []}`). The release image also has to be REBUILT for the
baked ENV to move — the config change alone does not reach it._
<!-- entry #1946 -->

---

## 2026-09-06 — #1946: ISON presence fallback, and two seam bugs only live testing found

**`/notify` was inert on IRCnet.** Its ircd (2.11.2, RFC 2810–2813 lineage)
implements neither MONITOR nor WATCH — confirmed in `common/parse.c`'s message
table and in a live 005 that carries neither token. So the 005-independent arm
probed WATCH, took a `421`, downgraded to MONITOR, took a second `421`, and
resolved `:none`, where `arm_commands/2` returns `[]` and every watched nick
stays `:unknown` until reconnect.

#247 had already named this exact condition: *"ISON fallback can be phase 2 if a
network without MONITOR/WATCH ever matters."* It now matters.

### ISON is the terminal fallback, NOT a fourth probe rung

MONITOR and WATCH are optional extensions, so probing them is meaningful — a
`421` is a real answer. ISON is RFC 1459/2812 mandatory: there is nothing to
discover, so it is *used* rather than probed. `:none` survives only for the
ircd that refuses even ISON, because no-silent-drops says the impossible case
still needs a name.

The 005 hint keeps winning when present, and the optimistic WATCH probe stays —
its reason (bahamut forks that support WATCH without advertising it) is
untouched.

### The reply budget is the correctness problem, not the request budget

IRCnet's `m_ison` fills its reply buffer and then `break`s
(`if (len + i > sizeof(buf) - 4) break;`), dropping the tail with no error and
no marker. The reply carries only the **online** nicks, so a chunk sized
against the REQUEST can still overflow the reply — and every dropped nick then
reads as offline, fabricating "X went offline" pushes.

Hence `@ison_reply_budget 360` (below the 400 used for MONITOR/WATCH), sized so
the reply fits even if every queried nick is online. And hence the sweep rule:
**N chunks must yield N × 303, or the sweep is discarded and nothing is
diffed.** Absence of evidence must never become an offline transition.

### Cadence is budgeted against a measured penalty

In this ircd a handler's return value IS its penalty in seconds
(`cptr->since += ret`); `m_ison` returns **1**, the cheapest tier (`m_whois` 2,
`m_who` up to MAXPENALTY), plus a pre-dispatch base of `1 + len/100`. So a full
ISON line costs ~2 penalty-seconds and the interval scales with chunk count:
30 s floor, +10 s per chunk. An empty watch list arms **no timer at all** —
most sessions watch nobody and must pay nothing.

### Deviation from the issue's design, and why

The issue said `:ison` should get no `arm_commands/2` clause, so nobody could
"arm" a poll and wait forever for a push. Built that way it crashes: the live
`/notify add` path calls `arm_commands/2` with whatever mechanism the session
resolved, and a `FunctionClauseError` there takes down a working session over a
nick the next sweep would have picked up anyway. It returns `[]` instead, and
`sync_presence/3` re-schedules the timer — which it must regardless, since
0 → N has to create the timer `poll_interval_ms(0)` refused.

### 🔴 Two bugs that unit tests could not have caught

Both live at the server↔client seam, and both were found by running the thing
against real IRCnet:

1. **`Wire.presence_changed/6` had no `:ison` clause** — guarded
   `source in [:monitor, :watch]`. Thirty seconds after the downgrade the first
   sweep produced `source: :ison` and the session crashed with a
   `FunctionClauseError`, then `:transient`-restarted into the same wall.
2. **`source` is a CLOSED SET on the wire**, and widening it server-side while
   an old bundle was live made cic drop every presence frame with *"This client
   could not read a presence_changed update from the server and discarded it"*.
   That is the validator working: `wireSchema.ts` carried
   `{ e: ["monitor", "watch"] }`.

So a closed set gaining a member IS a wire-shape change, in the
new-server-to-old-client direction, and it is **measured** here rather than
argued. Protocol went **11 → 12** and — unlike v10 and v11 — `mix
grappa.wire_pin` *demanded* it: `source` lives in a `Session.Wire` typespec, so
it reaches the generated artefacts and the digest actually moved
(`9c97bd9b…` → `4e6ee9e6…`). `@min_protocol_version` stays 1: an old client
drops presence frames and keeps every other pane, and only on the one network
that needs ISON at all.

Regenerating the artefacts was not sufficient on its own — `src/lib/api.ts`
carries a hand-written copy of the payload that `wireTypesAssert.ts` pins equal
to codegen, so `tsc` stayed red until that was widened too.

_Deploy: **COLD** — server behaviour + wire version. cic rides with it._
<!-- entry #1949 -->

---

## 2026-09-06 — #1949: two image boxes, one documented update — and the refusal pointed at the wrong door

`README.md` and `INSTALL.md` have offered **two** pre-built-image install paths
since #1160 — the `get.sh` one-liner and `compose.release.yaml` — and exactly
**one** update procedure, the one that does not drive the second. The correct
recipe for the compose path existed only inside that file's own comment block,
where nobody looking for an update command would think to look. Reported on
#grappa by an operator who worked it out himself.

### The two boxes share nothing, the failure included

| | `get.sh` / `deploy.sh` | `compose.release.yaml` |
|---|---|---|
| driver | `docker run` | `docker compose` |
| container | `grappa` | `grappa-release-grappa-1` |
| volume | `grappa-data` | `grappa-release_grappa-data` |
| secrets | `$GRAPPA_HOME/grappa.env` | generated inside `/data` |

The right-hand column is measured from `docker compose -f compose.release.yaml
config` (a render — it touches no daemon state): project `grappa-release`,
volume resolving to `grappa-release_grappa-data`, and no `container_name:`
pinned, so compose derives `grappa-release-grappa-1`.

### The issue named the wrong verb, and the right one is worse

Its body has the documented update "stand up a second, empty box". Read against
`infra/docker/deploy.sh` at `c65a84073` that is not what happens, and the truth
is less forgiving. There are three doors:

- **`… get.sh | bash -s -- update`**, the documented update. Release mode is
  auto-selected (no `compose.yaml` two levels up) and `cmd_update_release`
  guards on `$GRAPPA_HOME/grappa.env`, which a compose install never writes, so
  it **aborts**: *"no env file … this box was never installed. Run 'install'
  first."* A correct refusal carrying a **false diagnosis** — the box IS
  installed — and it names the one door that does damage.
- **`~/.grappa/infra/docker/deploy.sh update`**: that path does not exist on a
  host that never ran `get.sh`.
- **`… get.sh | bash`** (bare — the documented *install* one-liner).
  `cmd_bare_release` finds no env file and calls `cmd_install_release`, whose
  only ownership guard is `docker inspect grappa`. That never matches
  `grappa-release-grappa-1`, so it proceeds: fresh secrets, `docker volume
  create grappa-data`, and a migration writing an **empty database onto the
  second volume** — all of it before anything is started.

The operator does not walk into the wreck. The abort message walks them in.

### The wreck is conditional, and the condition is the port

`release_start_container` publishes `${GRAPPA_PUBLISH}:4000`, defaulting to
`127.0.0.1:4000` — byte-identical to what `compose.release.yaml` publishes.
Under the script's `set -euo pipefail` that `docker run` dies on the bind and
takes the install with it **while the compose box is up**. So the second box
only *comes up* when the port is free: a compose box stopped, crashed, or
republished elsewhere. Which is also where it hurts most — the reverse proxy
still points at 4000 and now serves an empty grappa asking for a first user.
Either way the empty volume, the fresh `grappa.env` and the migration have
already happened.

### The cure, and the rule it is pinned by

`INSTALL.md`'s *"Updating an image box is always COLD"* now carries a command
block **per substrate**, names the compose project and volume where the choice
between the two paths is actually offered, and says plainly that the data is on
`grappa-release_grappa-data` and not lost. `README.md`'s release paragraph gives
the `pull` + `up -d` pair inline instead of only `-s -- update`.

`test/infra/release_update_docs_test.bats` pins the general rule rather than the
two files this was filed about: **any tracked file outside `test/` that tells a
reader `docker compose -f compose.release.yaml up -d` must also tell them
`docker compose -f compose.release.yaml pull`.** Keying the obligation to the
INSTALL invocation means a document that starts offering the compose path
tomorrow inherits it without anyone remembering this issue. It carries a
negative control — a needle that appears nowhere must match nothing — because
the whole suite is `git grep`-derived, and a grep that had started answering
"every tracked file" would satisfy every other assertion by accident.

### What was deliberately NOT done

The issue's third suggestion — teach the release path of `deploy.sh` to refuse
when a `grappa-release` compose project is already on the host — is **not in
this slice**, and not for lack of merit. The measurement above makes it *more*
attractive: the doc fix stops the reader, and the abort message is aimed
squarely at the one who does not read. It is out because it is not the
one-liner "optional but cheap" suggests. Such a guard must decide how it detects
the other box (`docker compose ls`, versus a
`label=com.docker.compose.project=grappa-release` filter — the only one that
also sees a *stopped* compose box); it teaches the release-mode driver the
compose file's project name, a new coupling that then needs its own pin because
the two must agree; and it needs an escape hatch, or it blocks the operator
legitimately migrating off compose onto the script path. The honest sibling
change is smaller and is also not here: `cmd_update_release`'s abort should
state what it OBSERVED (no env file at this path) instead of what it concluded
("this box was never installed") — the log-honesty rule in CLAUDE.md, applied to
a `die`.

### The near miss: `compose.` is a PREFIX, and it is `:docker`-only

Worth pinning for whoever edits these files next, because the natural instinct
is to fix the docs where the right recipe was hiding — inside
`compose.release.yaml`'s own comment block. `Preflight`'s `docker_image?/1`
matches **any path beginning with `compose.`**, so that one extra edit
reclassifies the whole slice. Measured:

    classify_paths(~w(compose.release.yaml), :docker, f)
      => {:cold, [image_substrate: ["compose.release.yaml"]]}
    ...                          :jail   => {:hot, []}
    ...                          :linux  => {:hot, []}

Two properties, both measured rather than read off the source. It is a prefix
on the FULL path and not on the basename — `docs/compose.notes.md` returns
`{:hot, []}`. And it is scoped to `:docker` alone (`filter_on([:docker], …)`),
the exact mirror of `VERSION`, which returns `{:cold, [version: ["VERSION"]]}`
on `:jail` and `{:hot, []}` on `:docker`. **A docs-only slice that reaches into
a `compose.*` file is a COLD docker deploy.** This one deliberately does not,
which is why the compose recipe was copied INTO `INSTALL.md` rather than the
prose being improved where it already lived.

### What this does NOT claim

Nothing was run against a real box. The three doors are read from
`infra/docker/deploy.sh` and `infra/docker/get.sh` at `c65a84073`; the only
command executed against docker was `docker compose … config`, which renders.
The port collision is derived from two literals
(`GRAPPA_PUBLISH=127.0.0.1:4000` and the compose `ports:` entry) plus `set -e`,
never observed as a failed bind.

_Deploy: **HOT** on every substrate. Measured, not enumerated:
`Preflight.classify_paths(["INSTALL.md", "README.md", "docs/DESIGN_NOTES.md",
"test/infra/release_update_docs_test.bats"], s, fn _ -> nil end)` returns
`{:hot, []}` for `:docker`, `:jail` and `:linux` alike. The verdict was gated on
its controls rather than printed beside them: `compose.release.yaml` on
`:docker` and `VERSION` on `:jail` had to come back COLD, `docs/compose.notes.md`
and `VERSION` on `:docker` HOT — all four held before any verdict was
emitted._
<!-- entry #1951 -->

---

## 2026-09-06 — #1951: the probe was fine, the ORACLE went stale — so the oracle got a test

`deploy + probe the release image (amd64)` was the only red check on the
release runs of BOTH `v1.5.0` and `v1.5.1`, twice with the same words:

```
the shipped chunks carry NEITHER a populated credit roll nor the degraded one —
the payload's spelling changed and this probe is now blind (#1834)
```

Nothing shipped wrong. That message is #1834's anti-hollow-green branch doing
exactly its job: neither shape matched, and rather than pass quietly it died.
The payload's spelling HAD moved, and the mover was #1927 — `credits.sh` grew
a third key per contributor (`nick`) while probe 5's `contributor_row` still
spelled two, so it could never match, `populated_roll` (built on top of it)
could never match, and the third branch was the only one left.

### `nick` is not always a string, and that is the half a careless fix misses

`credits.sh`'s `nickof()` returns the BARE `null` token for an author absent
from `infra/packaging/contributors`, and the table itself is optional by
construction — a tree that cannot read it falls back to `/dev/null` and emits
`null` for EVERY row. A pattern accepting only `"nick":"handle"` would be
blind to half the field in this repo and to all of it in a checkout without
the table. The cure carries both spellings and nothing else:

```sh
contributor_row='\{"name":"[^"]*","nick":(null|"[^"]*"),"commits":[0-9]+\}'
```

### Deliberately strict, because the failure mode is the cure's mirror image

The tempting fix is a looser pattern. It is the wrong one: probe 5's value is
its THIRD outcome, and a regex that matches anything deletes that outcome
while reporting green. Measured over six payload classes with the driver's own
patterns — real roll with quoted nicks → passes (8 rows); real roll with bare
`null` nicks, from the same script run without its table → passes (12 rows);
degraded roll → dies on the degraded branch; pre-#1927 two-key row → dies on
"neither shape"; a row whose `commits` is quoted → dies; a bundle with no roll
at all → dies. Both directions, not just the one the issue was about.

### The real lesson: nothing was reading the reader

`test/infra/release_image_credits_test.bats` already read the RECIPE — that
the build arg is declared, that the fallback survives, that the workflow
supplies it. Nothing read the PATTERN the artifact is read WITH, so the one
component whose whole job is to notice drift was itself free to drift, and it
took two releases to notice because it only runs on a tag.

Four cases now pin it, in that same file, against payloads the REAL
`credits.sh` produces — never hand-typed, since a hand-typed copy drifting
from the deriver IS the defect. They read the driver's own assignments out of
it rather than restating them, for the same reason, and the extractor carries
its own positive control: an empty ERE matches everything, so a reformat that
put those lines out of grep's reach would otherwise turn the whole block
green. Cost is nil and it runs on every PR, where the tag-only probe does not.

### What this does NOT claim

It was never run against a ghcr image. The assertion is oracle-vs-payload, on
the string `credits.sh` emits — which vite re-serialises through
`JSON.parse/stringify`, so it is canonical, but it is not the shipped chunk.
Whether the payload REACHES the bundle stays probe 5's claim, on a real image,
and the two halves are complementary on purpose. The healthy roll on the prod
bundle for `v1.5.0` (8 contributor rows, three-key shape) is the issue
reporter's measurement, not one taken here.

_Deploy: **no deploy** — CI/release tooling only, nothing in the image or the
release itself changes._
<!-- entry #1851 -->

---

## 2026-09-06 — #1851: the jail's tree is dirty BY CONSTRUCTION, so every release reports `X.Y.Z-<sha>`

Production reported a suffixed version on three releases running —
`1.4.0-596d5ea0`, `1.4.1-997711ac`, `1.5.0-35e9fca6`. **`Grappa.Version` is
not the defect and was not touched.** An unclean tree at compile time IS an
unreleased build, and the suffix saying so is #391 working exactly as
designed. The defect is one layer up: the deploy machinery MANUFACTURES the
uncleanliness, so the signal is on permanently and discriminates nothing — a
genuinely unreleased build looks identical to a released one, and the tag the
operator just cut disagrees with `CTCP VERSION`.

`git status --short` in the jail, both entries written by the deploy and
never by a human:

     M cicchetto/e2e/infra
    ?? cicchetto/package-lock.json

### Two entries, two causes — and the issue's "option A" splits in half

The issue framed A as one cure ("stop the build from dirtying the
checkout"). It is two, at two different layers, and forcing one mechanism
onto both would have been wrong in one of them.

**`cicchetto/package-lock.json` is a build artefact of one substrate's
toolchain.** FreeBSD pkg has no bun port, so `jail_cic_build.sh` falls back
to `npm install`, which regenerates the file inside the checkout. `bun.lock`
is canonical and OPERATIONS.md already said so; nothing else reads the npm
lock. A generated path that lands in the tree belongs in `.gitignore`, next
to `dist/` and `.vite/`. That is the cause removed at the layer that owns
it — git is told what the file IS; nothing stopped looking.

**`cicchetto/e2e/infra` is the pull failing to finish.** `git pull
--ff-only` advances the SUPERPROJECT and leaves every submodule working tree
exactly where it was, and nothing downstream ever syncs it back — so ONE
gitlink bump dirties a deploy checkout permanently. The pin last moved on
2026-08-23 (`f2b93f2bf`), which is when the jail's tree went dirty and
stayed. The cure is `--recurse-submodules=on-demand` on every deploy pull:
three `substrate_pull` hooks (jail, linux, docker) and the two standalone
jail rails.

### Why `on-demand` and not the bare flag — measured, on a throwaway bench

| pull spelling | gitlink moved | gitlink still | tree after |
|---|---|---|---|
| `--ff-only` (before) | rc 0 | rc 0 | **DIRTY** |
| `--recurse-submodules` (`=yes`) | rc 0 | **rc 1** w/ remote down | clean |
| `--recurse-submodules=on-demand` | rc 0 | rc 0 | clean |

The bare flag means `=yes`, which fetches every submodule on EVERY pull. A
box that cannot reach the submodule remote would go from "deploys fine until
the gitlink moves" to "never deploys" — and the submodule here is behind a
`git@` SSH URL that production has no reason to hold a key for.

`on-demand` IS git's own fetch default, so the FETCH half of the pull is
byte-for-byte what it already does and only the CHECKOUT half is new. **The
flag therefore cannot introduce a failure the current pull does not already
have** — measured directly: with the remote unreachable AND the new
submodule objects absent, the old pull and the new one fail identically
(rc 1, the same `Errors during submodule fetch`, superproject un-advanced).
It is also a no-op where the submodule was never initialised, which is what
a plain `git clone` leaves behind, so it does not drag a test-only testnet
onto a production box that does not have one.

### The two cures that were measured and REJECTED

**`ignore = all` in `.gitmodules`** cleans `git status` — and also makes
`git add cicchetto/e2e/infra` stage *nothing*. Measured: `git diff --cached
--name-only` comes back empty after the add, so a deliberate bump like
`f2b93f2bf` becomes uncommittable through the normal gesture. Not "a bump
you might not notice": one you cannot make. `ignore = dirty` does not apply
at all — the dirt is `(new commits)`, which `dirty` deliberately still
reports.

**Teaching `GitProbe` an allowlist of deploy-noise paths** (the issue's
option B) turns "clean" from a fact into a policy that rots, and leaves the
checkout genuinely diverged from the commit it claims to be. The version
string would read `X.Y.Z` while the tree was not `X.Y.Z`. That is a worse
lie than the one being fixed.

### The THIRD source, already cured — and the rule it leaves

The deploy writes `runtime/last-deployed-sha` INTO the checkout on every
run. It is not dirt today only because the repo's root `.gitignore` already
carries `/runtime/*`. It surfaced as a red in the new bats case, whose
throwaway upstream carried no `.gitignore` at all — the fixture was lying by
omission, and mirroring the real rule was fidelity, not accommodation.

**The general rule this leaves: any path a deploy WRITES into the checkout
must be checked against `.gitignore`, or it poisons the version string the
same way.** Three such paths exist today; two were covered, one was not.

### What the tests pin, and what killed them

`test/infra/deploy_checkout_dirt_test.bats` is new and owns the CLASS: the
ignore rule (with both controls — `package.json` must NOT be ignored,
`bun.lock` must stay tracked) and a census of every non-comment `git pull
--ff-only` in `infra/`, gated on a minimum hit count so an empty census
cannot report a green. `deploy_jail_test.bats` owns the BEHAVIOUR, because
it already has a throwaway upstream and clone and can pull across a real
gitlink bump; its two cases are a pair, the second planting genuine dirt and
demanding it still shows, because "the tree is clean" alone is
indistinguishable from a cure that blinded `git status`.

Three mutants, three kills, one assertion each: dropping the flag from the
jail pull kills both behavioural cases naming ` M sub`; dropping the ignore
line kills exactly one census case; dropping the flag from
`jail_git_pull.sh` — a door the behavioural test cannot reach — kills only
the census, naming the door.

### What this does NOT claim

**Nothing was run on the jail. Production is not ours to touch and the box
was not reachable from here.** Every measurement above is local: a throwaway
git bench for the pull semantics, the repo's own bats set for the cures.

Two consequences are stated rather than hidden. The exact SHAPE of the jail's
submodule dirt was never measured — `git status --short` prints ` M` for
`(new commits)`, `(modified content)` and `(untracked content)` alike, and
the issue records only the short form. The cure addresses `(new commits)`,
which is *structurally guaranteed* to be present (the pin moved, nothing on
that box moves the submodule worktree), but if content dirt is ALSO there it
survives — correctly, since that would be real dirt somebody made. And the
claim that the jail already holds the objects the checkout needs is an
INFERENCE, not a measurement: a pull whose on-demand submodule fetch fails
exits 1 and aborts `substrate_pull` under `set -e`, and v1.5.0 is live, so
the jail's pull across `f2b93f2bf` must have fetched successfully. Sound, but
inferred.

_Deploy: **classification NOT measured** — the `Preflight.classify_paths`
oneshot needs the compile lane, which this slice did not hold. Read from the
source rather than run: the slice touches `infra/**`, `test/**`, `docs/**`
and `cicchetto/.gitignore`, and no `compose.*` path and no `VERSION`, which
are the two literals that force COLD. Treat it as unverified until the
oneshot is run._
<!-- entry #1850 -->

---

## 2026-09-06 — #1850: the reload that answers "nothing to do" when it means "I read the wrong tree"

A `VERSION`-only bump is COLD on the two `mix release` substrates because the
code path carries the vsn: `lib/grappa-<vsn>/ebin`, and `:code.lib_dir/1`
resolves to the **boot** directory forever. `Grappa.Deploy.Preflight.version?/1`
already PREVENTS that (#1287). What nothing did was **detect** it, and the issue
text said so outright: *"That miss cannot be reported, only prevented."*

**That claim is false, and this entry is the mechanism.** The live node knows
the vsn in its own code path, and the release on disk names the vsn it last
assembled. Comparing the two is exact, needs no heuristic, and is observable
from precisely one place — inside the running BEAM, which is where
`Grappa.HotReload.audit_code_path/1` now sits.

### Why detection is not redundant with prevention

Preflight classifies a DIFF, on the deploying host, before the POST. Three
things escape it, and they are the same three that escape the pending-migration
verdict (`migrate_and_reload/2`'s moduledoc already argues this for migrations —
the argument transfers whole):

* `--force-hot` skips preflight entirely.
* A diff range that does not contain the bump has nothing to classify.
* Prevention leaves no trace when it is bypassed; the reload's own
  `{"reloaded":[],"failed":[]}` is indistinguishable from "nothing to do".

Production served the old BEAM under the new git history for ~6.5 hours on
2026-08-13 through that third shape, and the deploy printed success.

### The measurement that killed the first design

The obvious oracle is "is there more than one `lib/grappa-*` sibling?". It is
wrong, and a real `mix release --overwrite` says so. Measured 2026-09-06 in an
isolated build cache (`GRAPPA_CACHE_ID`), two consecutive assembles of this
tree:

    VERSION=1.5.1   lib/grappa-1.5.1                     start_erl.data: 16.4.0.4 1.5.1
    VERSION=9.9.9   lib/grappa-1.5.1 + lib/grappa-9.9.9  start_erl.data: 16.4.0.4 9.9.9

`--overwrite` **does not prune**: the boot dir survives with its mtime
untouched (22:26:03 vs the new dir's 22:26:10), and `releases/` keeps both
version subdirectories. Stale lib dirs therefore accumulate for the life of the
install, so sibling-counting would refuse **every** hot deploy on a jail that
has ever been bumped — a permanent false COLD, which is exactly the
session-dropping class this whole area exists to avoid.

What DOES move is `<rel>/releases/start_erl.data`. That is the oracle. (There
is no `RELEASES` file at all: `mix release` does not write one, only
`release_handler` does — worth knowing before anyone reaches for it.)

### Shape

`audit_code_path/1` is pure-ish and total, three arms:

* basename carries no `grappa-<vsn>` → `:ok`. This is Docker and every source
  checkout (`_build/<env>/lib/grappa`), where the fresh beams always land where
  the node already looks. **Inert by construction, not by a substrate flag** —
  the same posture `Preflight` takes when it excludes `:docker` from
  `version?/1` by measurement rather than omission.
* vsn matches `start_erl.data` → `:ok`, leftovers or not.
* anything else → `{:error, {:stale_code_path, %{booted:, built:, lib_dir:}}}`.

Unreadable or malformed metadata under a versioned path refuses rather than
passing. A versioned path asserts "this is a mix release", so the metadata is
expected; reading `:ok` out of its absence would restore the silence the audit
exists to break. Same bias as `Preflight`'s "in doubt, COLD", and it costs
nothing real: every shipped layout writes the file.

It runs BEFORE the migration audit in `migrate_and_reload/2`. If the beams are
in the wrong tree the deploy is going cold anyway, so committing DDL first buys
nothing and muddies the "nothing ran" all three refusals now promise.
`POST /admin/reload` answers 409 `stale_code_path` with both numbers, and
`infra/lib/deploy_common.sh` names it as cause 3 — `curl -f` discards the body,
so the script has to enumerate rather than guess.

### The bug the test caught, kept because it generalises

`built_vsn/1` first read `Path.join([lib_dir, "..", "..", "releases", …])`. The
vanished-boot-dir case went red: `..` is resolved by the OS at open time and is
ENOENT when a component is missing — and a missing component is exactly the
case under test. The refusal still fired, but `built` came back `nil`, losing
the one fact the operator most needs. `Path.dirname/1` twice is lexical and
correct. **General rule: when a path is being computed ABOUT a directory that
may not exist, `..` is the wrong operator.**

### Wire

`GrappaWeb.ErrorTokens` is a generated-artefact source, so the new token lands
in `REST_ERROR_TOKENS` / `wireSchema.ts` and moves the digest —
`mix grappa.wire_pin` demanded protocol **13**, it was not a judgement call.
v12's measured client break does NOT reproduce: the endpoint is loopback-gated,
so no bundle will ever be handed this token. The number moves because the shape
moved and the floor must stay TOTAL. `min_protocol_version` stays 1.

### What this is NOT

**It is reportability, not the cure.** #1850 asks for a direction among
appup/relup (A), freezing the OTP app vsn (B), and compiling the hot branch into
the live vsn's ebin (C). This entry picks none of them: a release cut still
cold-restarts prod. It converts a silent 6.5-hour class into a refusal the
operator sees, which every one of A/B/C wants anyway.

One thing measured in passing, because it cheapens C: the issue worries that C
leaves "the node reporting the old number while running new code". For
`Grappa.Version.base/0` that does not happen — it is a compile-time constant
inside `Version.beam` (`version.ex:156`), so a reload that loads that beam
reports the NEW number, which is the code actually running. What stays old
under C is the directory name and `Application.spec(:grappa, :vsn)`, and
`version.ex:37-39` records that nothing else in the tree reads the latter.

### What was not measured, and what is not asserted

* **Neither release substrate was exercised.** No jail, no systemd host. The
  release LAYOUT was measured on a real `mix release --overwrite`, which is a
  property of Mix and not of FreeBSD; the *deploy* on those substrates was not.
* The 2026-08-13 production incident is quoted from the record, not re-measured.
* The wiring `migrate_and_reload/2 → audit_code_path/1` is a one-liner
  composition and is **not** covered by a test that makes it FIRE: forcing drift
  needs a versioned `:code.lib_dir(:grappa)`, which a source-checkout test run
  does not have, and a seam for it would be a seam over a gated verb. Its
  INERTNESS is gated — the migration suites drive `migrate_and_reload/2` and
  would go red if the audit refused wrongly. This is the same posture already
  declared for `reload_modified/0` in `hot_reload_test.exs`.
* Not asserted: that this prevents any restart (it does not); that
  `start_erl.data` is written by substrates other than `mix release`; that a
  package install (`cp -a` of the release root) behaves identically — it should,
  it was not run.

_Deploy: **HOT** on every substrate, and measured rather than reasoned.
`Preflight.classify_paths/3` over this slice's 11 changed paths returns
`{:hot, []}` for `:docker`, `:jail` and `:linux` alike, and the verdict was
gated on its controls before being emitted: `config/config.exs` COLD on all
three, `VERSION` COLD on `:jail`/`:linux` and HOT on `:docker`, `compose.yaml`
COLD on `:docker` only, an unreadable migration COLD on all three; and
`docs/compose.notes.md` plus `infra/lib/deploy_common.sh` HOT everywhere. The
state-shape axis was measured too, not assumed: `long_lived_module_files/0` has
34 members and the intersection with this slice is empty. **`VERSION` still
classifies COLD on the release substrates — this slice moves no
classification.**_
<!-- entry #1952 -->

---

## 2026-09-07 — #1952: the release smoke crosses a version seam, and one flag was enough to keep the image from booting

`scripts/smoke-release-image.sh` is a good gate that never changes version.
Measured in the file before this work: every probe runs `$GRAPPA_IMAGE`
alone, both volumes are destroyed before the run, and probe 3 — the closest
thing to an upgrade — `docker restart`s the SAME image. So the shape that
broke #1945 in the field, an existing box running the previous release and
updated in place, had no coverage at all. That is the shape a self-hoster's
automated update takes, and it is how the failure reached a user.

Three things land: an upgrade probe from the previous release, an assertion
that boot-time writes land in the volume, and a hostile-substrate matrix.
The matrix found a real defect on its first run, which is recorded below
along with the two shapes that were refused.

### The previous release is DERIVED, and the comparison is not git's

`infra/packaging/previous_release_tag.sh` answers "the highest RELEASE tag
strictly below this one". It is the third script in that directory to read a
tag and it reuses both rules the other two own: `prerelease_flag.sh` is the
ONE pre-release classifier (#1636), and a repository tag it refuses is
SKIPPED while the tag under test is refused outright — `latest_tag_gate.sh`'s
posture (#1686), for its reason.

What it does NOT reuse is `git tag --sort=-v:refname`, and the reason is a
constraint the other two do not have: **the version under test need not be a
tag.** On a `docker_validation` dry-run the smoke job runs from a branch
whose `VERSION` has never been tagged, and git can only order refs it holds.
A three-field numeric compare answers it for any version string. It is a
comparison and not a second classifier — every string reaching it has already
passed the shared classifier's shape floor. `test -lt`, never `$((…))`: a
field with a leading zero shape-passes there and is an invalid octal constant
to POSIX arithmetic.

A dead end is a REFUSAL, never an empty line: the caller interpolates the
answer into an image ref, where empty becomes `:` and fails far from the
cause. The two dead ends are told apart because they need different fixes —
no `v*` tag at all is a shallow clone that never fetched them (which is why
the smoke checkout now takes `fetch-tags`), while tags with none below is the
first release of a line.

### `docker diff` is the oracle, and the bar is EMPTY because that is measured

#1945's second half was silent rather than loud: the peer avatars were
written to `/app/runtime/peer_avatars`, inside the container layer and
outside `grappa-data`, so a cold update deleted them with no error anywhere.
`docker diff` fits exactly — it reports the read-write layer and by
construction never reports what is under a mount, so a root that landed in
the volume is invisible and one that missed it is an `A` line. Nothing has to
be enumerated in advance, which is what makes it a class gate rather than a
second list of the three roots #1945 happened to fix.

**No allowlist is written, because the measurement says there is nothing to
allow.** A full boot of `ghcr.io/vjt/grappa:v1.5.1` — entrypoint, secret
bootstrap, migrator, theme seeder, Phoenix up and answering — leaves the
container layer with literally nothing in it. No `/app/tmp`, no `/tmp`, no
cookie file. An allowlist authored ahead of the first entry it needs is a
hole with a comment on it.

The same reading on the release BEFORE it is the evidence the probe bites.
`v1.5.0` answers three lines, two of them the defect itself:

    A /app/runtime
    A /app/runtime/peer_avatars
    C /app

An empty diff is also exactly what a BLIND oracle produces, so the probe
plants that same path afterwards and requires docker to see it. Without that
control the clean reading proves nothing.

### One flag, and the image does not come up

The matrix's cwd shape is the honest stand-in for the production jail, where
#1945 actually happened: rc.d starts the release with `su -m grappa` and no
`cd`, so the cwd is `/`. Docker bakes `WORKDIR /app` and makes it writable by
the runtime user, which is exactly why the same class of defect is SILENT
there and FATAL in the jail. Measured on stock `v1.5.1`:

    docker run --workdir / ...
    /app/release-entrypoint.sh: line 126: bin/grappa: not found
    grappa: MIGRATION FAILED — refusing to start.
    exited/1

Three commands in the entrypoint run `bin/grappa` and all three spelled it
RELATIVELY. `--workdir`, or a Kubernetes `workingDir:`, is set without a
thought. **This is #1945's own rule one layer over: the cure there stopped
deriving DATA paths from the cwd; the cure here stops deriving the release's
OWN path from it.** `cd "$(dirname "$0")"` is a no-op wherever things already
worked. It ships in this slice and not in a follow-up because a gate that is
red by construction has two futures, and the second is somebody weakening the
oracle to make it green.

**Blast radius, verified rather than assumed:** the only installer of
`infra/docker/release-entrypoint.sh` is `Dockerfile.release`. `infra/freebsd/`
and `infra/linux/` contain zero references; `infra/packaging/`'s single hit is
a comment. The one non-Dockerfile consumer, `infra/release/grappa.sh`, IS
installed into every release including the jail's, and is doubly barred:
it requires `GRAPPA_SUBSTRATE = docker` exactly, and the path it would exec is
never created outside the image because `install_operator_cli/1` copies only
`infra/release/grappa.sh`. Production (the m42 bastille jail) runs `mix
release` and does not read this file.

### An exit status is not a fact about the fault

The second defect the measurement surfaced is a different one and got its own
cure: the operator was told `MIGRATION FAILED`, with a paragraph about rolling
the schema back, while nothing had opened the database. That is the
log-honesty rule verbatim — a fast path describing work it did not do.

The first spelling keyed on exit 127 and the bats case written for it is what
killed that: **on one missing file the number is not stable.** `sh -c
'bin/nothere'` answers 127, the image's busybox ash prints `not found`, and
this script's own `if ! bin/grappa …` under `set -e` on bash-as-sh hands back
**1** — indistinguishable from a migration that ran and failed. So the guard
is a PRECONDITION, `test -x`, which answers the same on every shell, placed
once at the top because a tree with no runnable `bin/grappa` cannot migrate,
cannot seed and cannot boot.

### Two hostile shapes refused, both by measurement

**A volume over `/app`** removes the release itself, so a probe asserting that
shape answers 200 would assert a falsehood.

**An arbitrary uid (`--user 65534`) cannot be set up.** Docker re-seeds an
EMPTY named volume from the image on every mount, ownership included:
`chown -R 65534:65534 /data` in a helper container reads back as `65534:65534`
inside that container and as the image's `100:101` in the next one. Only a
pre-populated volume survives it, which is a fixture built to dodge a docker
behaviour rather than a substrate anybody runs — and the property it would
test (nothing outside `/data` need be writable) is what the read-only shape
asserts directly.

**The read-only recipe is one tmpfs, measured, not assumed.** Naked
`--read-only` dies with `mktemp: : Read-only file system` before it reaches
the secret bootstrap; `--read-only --tmpfs /tmp` boots. `/app/tmp` is not in
it because the release never writes there — the same fact the empty container
layer reports from the other side.

### The gate the gate needs

`release.yml` fires on a `v*` tag push and on `workflow_dispatch`, so nothing
added to its `smoke` job is ever executed by a pull request: the first real
run is the release. #1951 is that story verbatim, a rotted pattern failing the
release runs of BOTH v1.5.0 and v1.5.1 — a red check an operator learns to
ignore. The mitigation it landed is the one taken here: bats over the LOGIC at
PR time (`test/infra/release_upgrade_probe_test.bats`), against real git
repositories with real tag sets rather than a stubbed `git`, so what stays
untested until a real tag is only the part that genuinely needs a booted
container.

Every RED case carries a positive control on the same predicate. One of them
earned its keep immediately, catching a fixture bug in this very slice: the
temp repositories were keyed on the test number, so a case building two of
them to contrast had the second silently eat the first.

_Deploy: **cold** — `infra/docker/release-entrypoint.sh` is baked into the
release image, so it reaches an operator only through a new image. The m42
jail runs `mix release` and does not read it; nothing else here leaves CI._
<!-- entry #1960 -->

---

## 2026-09-07 — #1960: one prefix for one phenomenon, and the holder named WHILE it holds

`Grappa.Repo.LockWatch` printed four literals for one lock — `db lock stall`,
`… UNATTRIBUTED`, `… NIF CENSUS`, `… RESOLVED` — and picked the arm by
attributability, so consecutive ticks could describe one episode under two
different words and an operator had to correlate them by timestamp. Worse, it
was **silent while the lock was held** on exactly the episodes that hurt.

Measured on prod (jail `grappa-new`, 1.5.0, all rotations of
`runtime/log/erlang.log*`), 2026-09-06: `2` named-while-holding, `4`
UNATTRIBUTED, `11` NIF CENSUS, `7` RESOLVED — **two** announcements against
nine stall episodes, and **five** RESOLVED lines carrying
`NEVER announced while it held` with holds of 31.0 s, 31.3 s, 31.3 s, 62.7 s
and 94.1 s. Each already knew its write path
(`UserSocket.detach_client_source_capture/2` → `Vhosts.record_client_source/2`;
`Session.Server.init/1` → `apply_effects/2`). The 22:09–22:12 pair is the run
that starved the pool and preceded the 22:13 shutdown.

### The gate was never a contention test

`report_stalls(_, [])` returned `:ok` for a holder past the threshold whenever
no WAITER was registered, on the reasoning that a slow uncontended transaction
is not a stall. That reasoning is sound and the gate does not implement it: the
watch table has ONE producer (`Repo.immediate_transaction/1`), so "no waiter
registered" means "no waiter that went through the seam", and this system's
dominant writer is an autocommit `Repo.insert` — 324 679 `messages insert`
against thousands for everything the seam covers (#1901's own measurement).
The gate reads a 0.1 % sample and calls it silence.

🔴 **The decisive argument is that the codebase had already ruled the other
way and only on one edge.** #1888 made the CLOSING bracket fire on
`announced or past_threshold?` — no waiter conjunct. So a 31 s uncontended
hold already printed a RESOLVED line and refused to print an opening one. The
asymmetry was the defect; ONE threshold policy over both edges is the fix, and
"remove the short circuit" is #1960's own smallest-change proposal.

What replaces the gate is not "print more", it is the line stating what it
observed: every report now carries `H holder(s) / W waiter(s) registered at
the seam, P process(es) parked inside Exqlite.Sqlite3NIF`. An uncontended hold
prints `0 waiter(s)` instead of printing nothing — the reader SEES the absence
of contention rather than inferring it from the absence of a line, which is
the log-honesty rule applied to a fast path that was skipping the work.

### The ladder, and why `none` outranks `cohort`

One event, one prefix, one `attribution` field: `:named` (the seam registered a
holder past the threshold) > `:none` (registered WRITERS queued past it, holder
not attributable) > `:cohort` (nothing at the seam, only processes parked
inside the NIF). The order is claim strength, not preference. A registered
waiter is a writer we KNOW is blocked and whose own frame separates a lock-wait
from a pool-wait — measured live while building this: a `:none` subject
sampled at `DBConnection.Holder.checkout_call/5`, which is the #1687
decomposition visible in one frame. A NIF resident is a physical observation
that may equally be a healthy two-millisecond write.

🔴 **Nothing is lost by the ordering, because the ROSTER rides every verdict.**
Keying the roster on `:cohort` would have made it available exactly when the
seam knows LEAST, which is backwards. Measured on the real fixture: a `:none`
line with `parked=1` prints the full roster and the
`0 holder(s) and 1 waiter(s) of them registered at the BEGIN IMMEDIATE seam`
clause. This is why `lock_watch_test.exs`'s "a writer the seam DOES know is
counted as such" moved from the census verdict to `:none` and kept every one
of its assertions.

🔴 **The honest verb is per-arm and lives in ONE place** (`subject_clause/3`).
`has held RESERVED` appears on `:named` and nowhere else. A shared template
with a shared verb is precisely how a fold re-commits the claim
`terminal_message/3` in `Grappa.Repo.BusyRetry` was twice rewritten to stop
making, so the template carries the arm's verb rather than a neutral one.

### The census noise was a race, and the sample IS the cure

8 of the 11 census lines reported a longest-parked between 2.0 s and 3.1 s —
normal write latency at `stall_threshold_ms: 2_000`, not a stall — and their
rosters named processes that were not in the NIF at all:
`#PID<0.2456.0> 32024ms :gen_statem.loop_hibernate/3`,
`#PID<0.3110.0> 2120ms DBConnection.Holder.checkout_call/5`. The sweep matched
on `current_function` and `sample/2` re-read the process later; between the two
reads it had left, so the census printed a cohort whose frames contradicted its
own headline.

`nif_sample/2` now decides from the SAME `Process.info/2` read it builds the
sample from, so the decision can never disagree with the frame that gets
printed — a third read would let it. **An entirely-departed cohort produces NO
line.** That is the noise cure and it is deliberately not a bigger threshold:
the arm is silent because there is nothing true left to say, which is a
different fact from being under a threshold, and only one of the two is worth
an operator's trust.

One level down, `sample/2` folded `:current_stacktrace` into the same read.
The frame under `at …` and the frames under `stack:` used to come from two
signals and could describe two different instants — the same race, one layer
in.

### The output contract of the #1429 census does NOT move

`scripts/log-gap-scan.awk` keeps `lockstall`, `lockstall_unattributed` and
`lockstall_nif` as SUMMARY fields and re-keys their INPUT onto
`attribution=named|none|cohort`. The discrimination those three counters exist
to express — a holder was NAMED, versus a queue measured with nobody to blame,
versus neither established and a cohort photographed — is exactly what the
field spells out, so the census keeps counting and nothing downstream of the
summary line has to learn a new name.

The three `sig()` samples and the three bats pins were replaced with lines
**captured from real emissions** through the production path, not composed by
hand: the awk's own doc requires verbatim call-site copies, and a pin that
merely satisfies the regex is a fiction that passes.

### Verified, not cited: the #1715 Logger cache key is PER MODULE

The cure adds `Logger.warning` call sites inside `Grappa.Repo.LockWatch`, and
rule #1715 says a module that may log DURING a write-lock wait must buy its
Logger cache key at boot or the observer becomes the first casualty of the wait
it observes. That the key is per MODULE and not per CALL SITE was asserted in a
comment; a guard comment can be factually wrong and the price of being wrong
here is the whole instrument, so it was measured instead — diffing the entire
`persistent_term` keyspace around each call, MIX_ENV=test, OTP 28:

| call | new keys |
|---|---|
| `A.site_one` | `+1` — `{:logger_config, Probe1960.A}` |
| `A.site_two` (same module, different call site) | **`+0`** |
| `A.site_one` again | `+0` |
| `B.site_one` (different module) | `+1` |
| `C.prime` — `Logger.debug(fn -> "" end)`, the prime's own call | `+1` |
| `C.real` — `Logger.warning` AFTER that debug prime | **`+0`** |

So the key is `{logger_config, Module}`, the existing
`prime_logger_module_cache/0` covers any number of new call sites in this
module, and — the second row that mattered — the prime's `debug` writes the
same key a later `warning` would, so it is not purged into a no-op in this
build. No new priming, and the conclusion now rests on a measurement.

### Known limits, stated so they are not rediscovered as bugs

* **While a named episode is armed the cohort gets no line of its own**, so
  victims that pile into the NIF after the announcing tick are not enumerated
  until the closing bracket. That is the price of one report per episode; the
  alternative is a second line about an episode already announced, which is
  the correlate-by-timestamp reading this issue removes.
* **The parked count is threshold-filtered like everything else.** A `:named`
  line during the first seconds of a stall can read `0 process(es) parked`
  while victims are already in the NIF but under `stall_threshold_ms`. One
  threshold policy was the requirement; a second, lower one for the count
  would be a knob nobody asked for.
* **A pid that is both a registered waiter and parked in the NIF is sampled
  twice** on a firing tick, under two different clocks (seam elapsed vs NIF
  elapsed). Deduplicating would mean lying about one of the two measurements.
  The per-tick SWEEP — the cost #1767 bounded at 0.7–2 µs per process — is
  untouched; this is on the emitting path only, behind the threshold.
* **`lock_stall_row.elapsed_ms` is a hold ONLY on `:resolved` and on
  `:detected` with `attribution: :named`.** It is a WAIT on `:none` and a time
  parked in a NIF on `:cohort`. That is the #1687 ruling generalised: never
  name the column `held_ms`, and make `phase` + `attribution` total so the
  pair disambiguates it.

### Refused

Touching the threshold, `busy_timeout`, the pool or the `BEGIN IMMEDIATE`
posture — 1767 and 1888 are open and are vjt's calls. This is the
OBSERVABILITY face and it does not cure the stall it reports.
<!-- entry #1952b -->

---

## 2026-09-07 — #1952b: the two hostile shapes the first pass refused, and the reading that made one of them look impossible

The hostile-substrate matrix #1952 asks for is FOUR shapes. The first pass
shipped two — `--read-only` and `--workdir /` — and named the other two in the
driver's non-coverage list, one as a judgement and one as a measurement. Both
are now run. This entry is mostly about why the refusals were wrong, because
the mistake is reusable and the fix is not.

### An arbitrary uid: the mechanism was right, the conclusion did not follow

The refusal read: docker re-seeds an EMPTY named volume from the image on every
mount, ownership included, so a helper container's `chown -R 65534 /data` reads
back as `65534` inside that container and as the image's `100:101` in the next
one — therefore the shape cannot be set up.

The first clause is TRUE and re-measured here: create a volume, chown it,
mount it again, and the image's owner is back. The second clause does not
follow from it, because the re-seed only applies **while the volume is empty**.
One zero-byte file inside and the ownership sticks:

| fixture | next container reads |
| --- | --- |
| empty volume, `chown 65534` from a helper | `100:101` — re-seeded |
| one file inside, `chown -R 65534` | `65534:65534`, and writable |
| control: virgin volume, `--user 65534` writes | `permission denied` |

So the shape is constructible, and the fixture is not a trick to dodge docker:
handing storage to the uid it will run as is what an arbitrary-uid deployment
does anyway — a Kubernetes `fsGroup`, an operator's `chown` on the host path.
The general rule the miss illustrates: **a measured mechanism plus an
inference is not a measurement.** "I could not build it" and "it cannot be
built" are different claims, and only the first was in evidence.

What the shape then found is the strongest red in the file, because it is
#1945 verbatim rather than a cousin of it. Same fixture, same flags, the two
releases apart:

```
v1.5.1   running/0, /healthz in 2s
v1.5.0   exited/1
         ** (File.Error) could not make directory (with -p)
            "runtime/peer_avatars": permission denied
                (grappa 1.5.0) lib/grappa/avatars/reaper.ex:79
```

The path in that error is RELATIVE. `/app` is writable by the baked user and
by nobody else, which is exactly why the same defect is silent on every other
docker shape. The control that makes the pair mean something: v1.5.0 with the
baked user on an ordinary volume boots healthy, so the red belongs to the uid
and not to the release.

### A volume over /app: one sentence, two substrates, opposite answers

The refusal read: the release IS `/app`, so mounting over it removes the thing
under test. That is TRUE OF A BIND MOUNT AND FALSE OF A NAMED VOLUME, and the
issue's words ("a volume mounted over `/app`") name the second.

* empty **bind** mount — the container is not merely unable to boot, it cannot
  be CREATED: `stat /app/release-entrypoint.sh: no such file or directory`,
  status `created/127`. It stays in the non-coverage list, now with that
  measurement attached.
* named **volume** — docker copies the image's `/app` into it at first mount,
  permissions and the setgid bit included, and the container boots. Both
  v1.5.0 and v1.5.1 answer `/healthz`.

Which is the problem with the shape: **boot alone does not discriminate**, so
a probe asserting only `/healthz` here would be a fifth ordinary boot. What
discriminates is the release root itself. `docker diff` — probe 7's oracle for
"the boot wrote nothing outside /data" — never reports what is under a mount,
and on this substrate answers **zero lines for v1.5.0**, whose #1945 defect
creates `runtime/peer_avatars` right there. So shape 3 reads the same property
through the window the mount leaves open: `ls -1A` on the volume after the
boot must equal `ls -1A` on the `/app` the image ships. Measured, the same
comparison the driver runs:

```
[ -s shipped ]  → non-empty (the blindness guard)
cmp             → DIFFER
diff            → 7a8 > runtime
```

### What this probe's green does NOT mean, and it needs saying

Mounting a volume over `/app` is not thereby supported. The copy-up happens
ONCE, while the volume is empty: pull a new image, recreate the container, and
the volume still holds the OLD release. Measured — a container started from
`:v1.5.1` on a volume seeded by v1.5.0 reports `.Config.Image = …:v1.5.1` to
`docker inspect` and version `1.5.0` to `/api/config`. Silent stale code across
exactly the upgrade this issue exists for. The driver therefore removes that
volume before the run AND in the teardown, since a leaked one would make the
NEXT smoke boot a release nobody built while reporting the tag it was asked
for.

### A mutation test that landed somewhere else, and was worth keeping

To prove shape 3's oracle is not blind, an image was built from v1.5.1 with
#1945's shape reintroduced — a relative `mkdir -p runtime/peer_avatars` in the
entrypoint, guarded by a `cmp` proving the `sed` had matched. Run through the
driver it died at **probe 7**, not shape 3: the mutation writes on every boot,
and `docker diff` on the ordinary container sees it first. That is the right
behaviour and the wrong experiment — the two oracles overlap on the ordinary
substrate, and shape 3's exists only for the one where probe 7 cannot look. The
isolating evidence is the direct run above, against a volume a real v1.5.0
booted on.

### Shape of the driver

`hostile_boot` now takes the `uid:gid` its `/data` volume must be handed to as
a REQUIRED third argument — no default, because that ownership is half of what
a shape means, and a call that forgets it puts a docker flag where the owner
belongs. Three of the four pass the image's own owner, read out of the image
with `stat -c %u:%g /data` rather than spelled: a literal `100:101` here is a
second copy of a Dockerfile fact, wrong the day `adduser -S` picks another
number. The arbitrary uid is guarded against BEING that owner, or the shape
would be an ordinary boot wearing a `--user` flag.

`test/infra/release_hostile_matrix_test.bats` is the PR-time half, for the same
reason the upgrade probe has one: nothing in the `smoke` job runs on a pull
request. It folds the driver's backslash-continuations and EVALUATES each
`hostile_boot` call with the function replaced by a recorder, so the assertions
read the real argument lists through the real quoting — a shape that dropped
its owner argument shows up as a flag in `$3`, which is the mistake a grep
cannot see. It carries its own negative control on that predicate.

_Deploy: **nothing** — the driver and its bats run in CI and by hand; no
runtime code changed, and no substrate reads either file._
<!-- entry #1974 -->

---

## 2026-09-07 — issue 1974: where "which bundle am I running?" gets answered

The four facts were already collected. `cicchetto/src/lib/bundleHash.ts` has
carried `bootBundleHashAccessor`, `bootBundleVersionAccessor`,
`serverBundleHash` and `serverBundleVersion` since #292; the skew between them
already drives the refresh banner. What did not exist was anywhere to READ
them. Measured before touching anything: `bootBundleVersionAccessor` reached
exactly two surfaces — the credits roll and #775's update toast — and the two
server-side accessors reached NO production code at all, only tests and the
e2e window hook. So a person chasing a stale service-worker cache had one of
the four numbers, in an easter egg, and none of the server side.

### The ruling, and why it is not `AdminDebugTab`

The issue left one thing open — which panel — and vjt ruled it UNGATED
(relayed 2026-09-07, not observed first-hand). `AdminDebugTab` is the panel
named for diagnosis and it stays exactly as it is.

The argument that decided it is a population argument: whoever gets served a
stale bundle is an ordinary PWA user, so a readout behind `is_admin` answers
the question for everyone except the people who have it. The second half is
sharper. The failure worth seeing is the one `performRefresh`'s own header
documents (`bundleHash.ts`, the UX-6-I comment): the service worker keeps
serving the OLD precached `index.html`, so a refresh press can land back on
the same bundle — the "three presses to update" vjt measured on iPhone. That
is only observable by watching the running hash NOT move across presses, and
an admin-gated panel cannot host that observation for the population that
hits it.

Within "ungated", the placement is the settings drawer's main index, at the
tail beside `credits`. The drawer is the one ungated, always-reachable
surface both subject kinds get; it is not the credits modal, which declares
itself an easter egg (`lib/creditsModal.ts` header), is a full-viewport
animated end-titles roll with a soundtrack, and renders one of the four
values as a line that scrolls past. It is deliberately NOT a
`.settings-nav-row`: a nav row pushes a sub-page and wears a chevron saying
so, and this pushes nothing and changes nothing. #1773's contract that
`credits` is the LAST of the drawer's own ENTRIES is therefore untouched — a
readout is not an entry.

### Why the boolean had to become a closed set of three

`shouldShowRefreshBanner()` folded "we have not compared yet" into the same
`false` as "these agree". For a banner that is right: both mean do-not-pester.
For a readout it is a lie, and precisely the lie the surface exists to
prevent — before the user-topic join lands its `bundle_hash`, nothing has been
compared, and rendering that as "up to date" asserts a fact nobody measured.

So the comparison moved into a pure `bundleSkew(bootHash, serverHash) ->
"aligned" | "skewed" | "unknown"`, and the banner predicate is now literally
`bundleSkew(...) === "skewed"`. Pure-plus-caller rather than a signal-reading
`bundleSkew()` with no arguments: the readout renders both hashes, so it
computes the verdict from exactly the two values it printed and the two can
never disagree. The module already used this shape — `formatRefreshBanner`
(pure) beside `refreshBannerMessage` (signal-reading wrapper).

### Two things deliberately NOT built

**No fourth refresh button.** Three already exist: `errorBanners.ts:282` →
`requestBundleRefreshNow("user")`, `BootErrorBoundary.tsx:138`, and #674's
auto-refresh announced by #775's toast. The first of those renders on the
ungated banner stack under `shouldShowRefreshBanner()` — which is now, by
definition, the same condition that makes a refresh actionable in the
readout. A control here would be the same verb twice, live in the same state,
a drawer apart.

**No build id or ISO date.** The version and the hash are already baked; a
third carrier is exactly the drift #538 closed
(`cicchetto/src/lib/buildCredits.ts:13-15`).

### The hash prints whole, and that is a measurement

`versionLabel`/`formatRefreshBanner` truncate to `SHORT_HASH_LEN = 7` so a
sentence stays readable, and reusing them here was the obvious move. Measured
against a real build instead: `cicchetto/dist/index.html` points at
`/assets/index-DyH3fZLf.js` — an EIGHT-character hash. Borrowing the banner's
formatter would drop the last character of the two values the reader opened
the panel to compare. The readout therefore renders four cells rather than
two composed labels, which also makes the trivial-rebuild case #292 names
(same semver, different hash) legible as a column.

### What was proven, and what was not

Red-then-green on a new `BundleReadout.test.tsx` (six cases), plus three
reachability cases in `SettingsDrawer.test.tsx` and four on the pure
predicate. Four mutants, each killing what it was predicted to kill and
nothing else: the deployed-version cell reading the boot accessor (1 test),
the `unknown` arm returning `aligned` (2 — one per file, the pure fn and the
render), `cell()` truncating to 7 (3), and unmounting the readout from the
drawer (3 — the drawer cases only, so the mount is pinned separately from the
component). Negative control: rewording all three verdict strings kills
nothing, so the tests pin structure and values rather than prose.

NOT established, and worth stating rather than implying: nothing here was
observed in a real browser or on a real PWA install. The "three presses"
behaviour this readout is meant to make visible remains #292/UX-6-I's
measurement, not one taken in this slice — jsdom has neither a service worker
nor a precache. The readout is also reachable only by an AUTHENTICATED
subject; a bundle stale enough to break login is `BootErrorBoundary`'s
territory and keeps its own refresh.

_Deploy: **cic bundle only** — no server code, no wire change, no
`protocol_version` movement. `serverBundleVersion` was already on the wire
(`api.ts` `bundle_hash` event); this slice is the first production code to
read it._
<!-- entry #1973 -->

---

## 2026-09-07 — #1973: the client protocol constant lags by construction, so the cure is a pin and not more diligence

`cicchetto`'s `CLIENT_PROTOCOL_VERSION` said 9 while `Grappa.Protocol`'s
`@protocol_version` said 13, so every boot of every current bundle logged
`protocol mismatch: this bundle speaks 9, the server speaks 11` against
production. The same defect the constant's own note already records for
`2 → 9` — *"a true statement about a stale constant, not about a real
incompatibility"* — and it came back because nothing pinned the two numbers
to each other in this direction.

**The recurrence is structural, and that is the argument.** Measured on
`origin/main`: 12 bumps of `@protocol_version` (1 → 13, 2026-07-27 →
2026-09-06) against 3 writes of the cic constant, two of which were
catch-ups — `2 → 9` swallowed seven bumps at once. Since cic first declared
a version (2026-08-16) the two have been equal for roughly 8 days out of 22.
The stale value is the NORMAL state of that file. A rule saying "remember to
bump both" has now been written twice and obeyed neither time.

**Why the three existing pins all stayed green: every one of them is
one-sided, and none of them looks at `version/0`.**
`protocol_test.exs` asserted `cic >= Protocol.min_version()` (`9 >= 1`) and
cic's floor `<= Protocol.version()` (`9 <= 13`); `serverProtocol.test.ts`
asserted `MIN_SERVER <= CLIENT` (`9 <= 9`). Nothing compared cic against what
the server actually SPEAKS. The new pin is
`cic_protocol_version() == Protocol.version()`, and equality rather than `>=`
because the two are one contract version by definition: cic below is a stale
constant, cic above is a bundle claiming a shape no server ever emitted, and
`>=` waves one of them through. It is deliberately NOT the
`MIN_SERVER_PROTOCOL_VERSION` axis — what cic SPEAKS says nothing about what
it REQUIRES, and after this bump the two no longer coincide (13 vs 9), which
is those axes working rather than drifting.

### The objection that had to be measured before the cure, and how it resolved

`noteServerProtocol` is a pure inequality: its only silence is exact
equality, so it warns for `server < CLIENT` and `server > CLIENT` alike.
Raising the constant to 13 while production speaks 11 therefore does not
silence the warn — it reverses its sign. The question raised before any edit
was whether the cure merely relocates the lie.

It does not, and the distinction is between the two configurations rather
than between the two directions. Today's warn fires with ZERO skew: prod
serves the `v1.5.1` bundle (declares 9, measured at the tag) against the
`v1.5.1` server (speaks 11), both artefacts from one commit, and that is what
makes the message a lie. After the bump and the pin, bundle and BEAM built
from the same commit are equal by construction, so an inequality at runtime
means the two artefacts came from DIFFERENT commits — which is exactly the
`--cic`-only skew the warn was written to surface. `13` against a `11` server
is reachable only that way.

Measured while resolving it, and worth keeping because it bounds the claim:
the two deltas between 11 and 13 cannot hurt a newer bundle talking to an
older server. v12's break was measured in the OPPOSITE direction (an old
bundle drops `presence_changed` on the unknown `source: "ison"` enum member;
a bundle knowing the wider set accepts a server that never sends it), and
v13's `stale_code_path` token is loopback-gated, so no browser is ever handed
it. That acquits those two deltas specifically — it is not a general proof
that a newer bundle tolerates an older server, which #1393d repealed
outright.

vjt's call (2026-09-07): keep the condition as it is. Narrowing the warn to
`server < CLIENT` would reverse a deliberate choice — the note on the
function already says the newer-server direction is additive and tolerated
and keeps warning anyway, because on a service-worker-cached PWA the skew
FACT is the signal. The floor (`MIN_SERVER_PROTOCOL_VERSION`,
`min_protocol_version`) is the #1654 question and is untouched here.

_Deploy: **cic bundle** — one integer literal and comments in `socket.ts`;
the pin is a test and reaches CI only. Ship the bundle with a server built
from the same commit: a `--cic`-only push of this bundle onto the current
`1.5.1` BEAM will log the mismatch, and after this change that log is telling
the truth._
<!-- entry #1950 -->

---

## 2026-09-06 — #1950: a scrollback row is a RECORD, so its nicks take no live glyph

`ScrollbackPane`'s `prefixFor` had two branches: CONTENT rows
(privmsg/notice/action) read the server's send-time `meta.sender_prefix`
snapshot — that is #25, which stopped a MODE change from retroactively
re-prefixing old lines — and *everything else* re-derived the glyph from the
LIVE members store at every render, on the stated rationale that those rows
"describe a *now* event, so the current grade is the correct glyph".

That rationale is false for every row it covered. **A scrollback
row is never "now": it is a RECORD.** Reading the live store answers "what
grade does this nick hold at the moment you happen to be looking", which is a
different question from "what was true when this happened", and the difference
is visible the instant the nick is opped.

The reporter saw both halves of it on Azzurra:

```
20:30:23 * @Mezmerize [mezmerize@staff.azzurra.chat] has joined #italia
20:31:21 * @ULIAK [~ULIAK@5uo2.l.time4vps.cloud] has quit (Read/Dead Error: Input/output error)
```

The join line is wrong on the protocol outright — **JOIN carries no grade**;
the `@` always arrives afterwards in a separate MODE, from a human op or from
ChanServ auto-op a fraction of a second later — so `@nick has joined` states
something that cannot ever have been true. It bites hardest exactly the people
who look at it most: anyone with auto-op reads every one of their own joins as
`@nick`. The quit line is the same defect with a later re-render as its
trigger, and it also killed the issue's own guess that part/quit "render empty
anyway because the sender is gone from the store".

### The rule, and why the answer is not a snapshot

Where the event HAS no grade — a join, a kick victim — there is nothing to
snapshot and the correct value is always empty. So the cure is a named reading
of the sender button rather than a second server column: `bareSpanWithPrefix/2`
holds the one `<button>`, `contentSenderSpan/1` passes `prefixFor(nick)` and
`recordSenderSpan/1` passes `""`. The glyph is a PARAMETER, never a default,
so each call site states which reading it wants — the same no-magic-default-arg
rule the bare/bracketed split already followed.

**The rule that settles it: the ONLY glyph a scrollback row may carry is the
#25 send-time snapshot, on a CONTENT row.** `prefixFor` keeps that branch and
nothing else; there is no live members read left in `ScrollbackPane`. The
members pane keeps one, because it is the single surface where "now" is
actually the subject.

### The `mode` carve-out this entry first defended, and why it fell

This entry originally read *"`mode` is the ONE deliberate survivor … a mode
row's whole subject IS the grade, so the sender's current status is the honest
thing to show"*. That is retracted. The reporter closed it with a repro that
refutes itself on its face:

```
20:58:09 * @Mezmerize sets mode +o Mezmerize on #grappa
```

The `@` is GRANTED by that very line, so the setter provably did not hold it
when the event happened — no knowledge of the channel's history is needed to
see the render is wrong. The general form has nothing to do with self-ops: a
`mode` row records who set the mode THEN, so a setter deopped since reads plain
on the line where they were opping people, and one opped since reads `@` on a
line from when they were not. "Its subject is the grade" describes the row's
CONTENT; the glyph is about its SENDER, and those are two different people as
often as not.

Losing the exception made the fix SMALLER, not bigger — one branch deleted
instead of one branch conditioned.

### Measured

Two rounds on the untouched tree, `ScrollbackPane.test.tsx`.

Round 1, seven cases: **6 red, 1 green**. Red — `join`, `part`, `quit`,
`nick_change`, `topic`, `kick`; the `kick` row failed with **2** glyphs, not
one, because it renders the kicker through the sender span AND the victim
through its own `NickText`. Green — the `mode` case, which round 1 used as the
block's POSITIVE CONTROL.

That control could not survive round 2, since `mode` is now one of the
absences. Its replacement is the one glyph path deliberately left standing:
a CONTENT row rendering its #25 snapshot, through the same component, fixture
and `.nick-prefix` selector. It proves a glyph CAN reach the DOM here, so the
ten absences are not an artefact of a mocked-away `NickText`. It does NOT
prove the LIVE store would have supplied one — after this fix nothing in the
module reads it, so no in-block assertion can, and that half is carried by the
red measurement below rather than pretended at.

Round 2 (this extension), four more cases: **4 red, 0 green**, one glyph each
(`mode` channel, `mode` self-op, `mode` on `$server`, `server_event` INVITE).
Two of them are the interesting ones, because round 1's own text had ACQUITTED
them:

* `mode` on `$server` (#154(b) user modes). Round 1 reasoned it was safe
  because no member list exists for that key. True, and irrelevant: seed one
  and the old code paints an `@` on a row that has no channel grade at all. It
  was safe by ROUTING ACCIDENT, not by rule. The unit fixture seeds a
  deliberately unrealistic `$server` member list for exactly this reason — a
  vacuous assertion would have passed either way.
* the `server_event` INVITE into a channel we are ALREADY in. Round 1 listed
  this as a stated residual, reasoned from `EventRouter` rather than measured.
  It was real: red, one glyph. It is now fixed as a consequence of the total
  rule, not as a carve-in.

Counts, `bun.sh run test`: 6759 → **6755**. That is +4 new cases and −8 for
the deleted `senderPrefix` unit tests, and the arithmetic closes exactly.

### The helper is deleted, not just unused

With the live branch gone, `nickColor.senderPrefix/3` had zero production
callers — its only remaining consumers were its own eight unit tests. It is
removed rather than left exported: there is no correct use of a live members
read on a scrollback row, and an exported helper that says otherwise in its
own doc comment is how the next session reintroduces this. `memberSigil`
remains the members-pane path and is untouched.

### What this does NOT claim

Nothing here was measured on production. The Azzurra lines above are the
reporter's, quoted from the issue; what was measured is the renderer, in jsdom
for the eleven cases and against the live stack for the two-door
(live vs. reload) contract in `issue1950-record-row-no-live-glyph.spec.ts`.

The e2e `mode` case needs out-of-band standing to exist at all: setting `+o`
requires chanop, so a setter who lacks the grade cannot normally produce the
row. The reporter could because he is Azzurra staff
(`mezmerize@staff.azzurra.chat` in the field line above) and the testnet runs
the same ircd, bahamut — so the spec buys the same standing the same way. That
is a property of the FIXTURE, not of the defect: the defect needs no oper,
only a setter whose grade moved.

### /OPER is not the standing — the fixture asked the wrong door

The paragraph above first read "so the spec buys the same standing the same
way, with /OPER", and the spec did exactly that: `oper()` on the line above
`mode()`. It went red on `IrcPeer: timeout waiting for mode … (5000ms)`, and
the reason is structural rather than incidental. bahamut's `m_mode` grants the
override on

```c
IsULine || ((IsSAdmin || IsAdmin) && !MyClient(sptr)) || IsUmodez
```

and **`!MyClient` switches the admin arm off for anyone connected to the very
server being asked** — which is every e2e peer. `IsUmodez` is unreachable:
`m_umode` lists `z` (with `a`, `j`, `S`, `r`) among the modes a client may
never set on itself. So an opered non-chanop lands on `chanop = 0`,
`set_mode` raises `SM_ERR_NOPRIVS`, and the peer gets a 482 with no echo.
**No quantity of /OPER was ever going to be enough**, and raising the 5 s
budget would only have bought a slower red.

The door that opens is `SAMODE`, which carries no `!MyClient` conjunct: it
gates on `IsPrivileged` (the /OPER) plus `IsAdmin || IsSAdmin`. Umode `+A` is
reachable because the leaf's O: line is `OaARD` and `s_conf.c`'s
`oper_access[]` maps `A` to `OFLAG_ADMIN`, which is what lets the `MyClient`
clamp `if (IsAdmin && !OPIsAdmin) ClearAdmin` spare it. `+a` stays out of
reach and is not needed. Nothing downstream changes: `m_samode` relays through
the same `sendto_channel_butserv` call `m_mode` uses, so the wire line is a
plain `:<setter> MODE <chan> +o <nick>` and the row grappa stores is the row
the spec was always asserting on.

**The generalisable part is the comment, not the verb.** `oper()`'s docstring
claimed ircops "issue MODE / SAMODE freely on any channel they're in" — true
of the second and false of the first — and separately that the leaf is
permanently split so "fresh JOINers never auto-op", which
`infra/bahamut/Dockerfile:26` contradicts on purpose by sed-deleting
`NO_CHANOPS_WHEN_SPLIT` from `config.h`. Sixteen of the suite's seventeen
`.mode()` sites are green precisely because their peer joins FIRST and
auto-ops. Two readers were sent down the MODE path by that comment before it
was measured against the source; it is corrected in place.

### Why the setter still joins second

The cheap repair is to make the setter the founding JOINer, like the other
sixteen sites. It is refused, and the spec now says so at the join. The claim
is not "a mode row renders bare" but "a mode row renders bare **even when its
setter demonstrably could not have held the glyph at the time**" — which is
what makes `* @Mezmerize sets mode +o Mezmerize` self-refuting without any
knowledge of the channel's history. A setter who joined first already holds
`@` when the row is written, so reordering keeps the assertion passing while
quietly deleting the thing it asserts. **Join order is load-bearing here; at
the other sixteen sites it is the opposite — there it is the only way the peer
gets chanop at all.**

### The oracle, measured

A repaired test that cannot fail is worse than a red one, so the fix was run
against a deliberately un-cured tree. In a detached scratch worktree,
`cicchetto/src/ScrollbackPane.tsx` and `cicchetto/src/lib/nickColor.ts` were
reverted to their pre-#1950 blobs while the new tests were kept:

| tree | `ScrollbackPane.test.tsx` |
|---|---|
| cured (HEAD) | **234 passed**, 0 failed |
| pre-cure mutant | **10 failed**, 224 passed |

All ten failures are the `#1950 record rows carry no live-derived mode glyph`
block and all ten fail on the same assertion — `.nick-prefix` length 0, got 2
— across join, part, quit, kick, topic, nick_change, the channel `mode` row,
the **self-op `mode` row**, the user mode on `$server`, and the
already-in-channel INVITE `server_event`. The mutation was proven real before
the run (`export const senderPrefix` back in `nickColor.ts`, its call back in
`prefixFor`) and proven gone after it, with a positive control showing the
same grep finds the helper in the pre-cure blob.

The same displacement was run on the STACK, because jsdom proves the renderer
discriminates and only the live stack proves it through the reload door:

| tree | `issue1950-record-row-no-live-glyph.spec.ts` |
|---|---|
| pre-cure mutant | both tests **RED**, on the glyph assertion |
| cured | both tests **GREEN** (5.6 s, 5.1 s) |

The red is the one that had to be checked, and it is the right red: `:73:1`
fails at line 130 with `.nick-prefix` expected 0, **got 2** (both join rows
re-prefixed), and `:181:1` at line 234 with expected 0, **got 1**. That second
number is also the proof the SAMODE path works end to end — the assertion one
line above it, `expect(modeRow).toHaveCount(1)`, PASSED, so the row
`sets mode +o <staff>` was really created, relayed and persisted by the very
sequence the fixture now issues. A cure that had not worked would have failed
earlier, as a `samode`/`umode` timeout, and the red would have proven nothing.

_Deploy: **cic bundle only** — no server module, no migration, no wire change._
<!-- entry #1977 -->

---

## 2026-09-07 — #1977: the push was the one door still shipping the wire bytes, and the title took the same class

Push notifications rendered the raw IRC body. `\x03` is non-printing, so the OS
notification renderer drops the byte and leaves its decimal operands sitting in
the text as ordinary digits: the lock-screen capture filed from `#allnitecafe`
read `04QUACK` where the wire carried `\x03` `0` `4` `QUACK`.

The projection already existed and had one caller too few. `Grappa.Mentions`
runs `MircFormat.plain_text/1` before matching so a padded body cannot dodge or
forge a mention, and cic parses the same bytes into styled runs for the message
list. The same message was therefore de-formatted for matching, parsed for
rendering, and shipped raw only to the notification — and that asymmetry, not
the control byte, was the defect.

The cure is in `Grappa.Push.Payload.build/3` rather than in the service worker:
the server keeps one matcher and one projection, payloads already delivered stay
consistent with the ones that follow, and no second parser ships inside the SW
bundle. Interpreting instead of stripping was never on the table — the Web
Notifications API takes plain text, so there is no styled-run surface to render
into.

### The title takes the same input class, and the asymmetry is measured

`title` is built from `sender` and `channel`, so it needed deciding rather than
assuming. Measured on this branch, executed rather than read off a regex:

  * `Identifier.valid_nick?` on a `\x03`-bearing nick answers **false**, and so
    does `valid_sender?` — the nick charset holds no control byte and the host
    arm excludes `\x00-\x1f` outright. Positive controls `"alice"` and
    `"irc.azzurra.chat"` both answer true. The one arm that would accept a
    control byte is `<meta>`, and that shape is minted server-side for
    non-IRC rows, never read off the wire.
  * `Identifier.valid_channel?` on a `\x03`-bearing channel answers **true**.
    The channel regex excludes only whitespace, comma and BELL; the negative
    control `"#all nite"` is false, so that true is not vacuous.
  * `Parser.parse/1` hands such a target back intact — `strip_unsafe_bytes/1`
    removes `\x00 \r \n` and nothing else — and `canonical_target/1` folds
    `A-Z` and passes every other byte through. A `\x03` in a channel name
    therefore survives ingress, persist and fold.

So a nick cannot carry it and a channel can. The projection sits on the COMPOSED
title rather than on the channel alone: one door serves both arms, and the
sender arm costs nothing because the projection is provably a no-op on any
string the nick charset admits.

### What does NOT get projected, and why that is the same rule

`tag` and `url` keep the channel KEY exactly as stored. `tag` is the OS dedup
key and `url` is a deep link cic resolves back to a window; projecting either
would coalesce the banner against a surface that does not exist and land the
click on a channel nobody is in. Two rendered fields project, two key fields do
not — the key/display split, applied at one door.

The issue left the dedup tag unmeasured ("probably untouched, but I did not
check it"). It is untouched by the BODY: `dedup_key` reads `sender` or
`channel` and never `body`, so no amount of formatting in a message can perturb
the dedup surface — now pinned by an assert in the same test that pins the body.
The second half is the part the report did not anticipate: the tag is not
`\x03`-free in general, because a `\x03`-bearing CHANNEL puts it there, and
deliberately so, since the tag is a key.

The stripper is the mIRC one and not a control-byte purge: CTCP framing
(`\x01`) round-trips verbatim per the wire-format rule, so an ACTION row still
reaches the payload framed. That is pinned too, because `build/3` now runs a
stripper and the next reader is entitled to know which one.

### Refused

No change to the service worker or to `pushPayload.ts` — the server projection
makes both unnecessary, and a client-side stripper would be the second parser
1908 spent its whole argument avoiding. No claim about payloads already
delivered: they were sent raw and are gone, and nothing here rewrites stored
rows. Whether a `\x03`-bearing channel is reachable on bahamut SPECIFICALLY was
not measured — the ingress chain admits it, which is the fact the cure needs,
and the ircd's own opinion would not make the projection wrong.

_Deploy: **HOT** on all three substrates — measured via
`Preflight.classify_paths/2` over the changed paths: `{:hot, []}` for `:docker`,
`:jail` and `:linux`. Positive control: `VERSION` answers
`{:cold, [version: ["VERSION"]]}` on jail and linux._
<!-- entry #1982 -->

---

## 2026-09-07 — #1982: the same tap, and the other three scrims

A user on a Samsung phone reported that a bare `/notify` sent with the compose
SEND BUTTON clears the draft and opens nothing, while the same verb sent with
the keyboard's Enter opens the settings drawer as designed. That is issue 1831,
again, on an overlay 1831 did not reach.

### What was measured, and it is the whole point of the slice

The mechanism was already established and is not re-litigated here: a command
that reaches its opener with no `await` ahead of it mounts a full-region scrim
while the finger is still down; a touch's compat mouse events are synthesised
after the touch ends and hit-tested against the layout as it stands THEN, so
the click lands on the scrim and a dismiss-on-any-click fires inside the
gesture that opened the overlay. `lib/backdropDismiss.ts` carries that
reasoning and the cure.

What had never been written down is the SET. Grepping every overlay opener
referenced from `lib/commands/` and `lib/compose.ts` closes it at five:

| opener | overlay | state before this entry |
|---|---|---|
| `openBanlistModal` | BanlistModal | cured by #1831 |
| `openModeModal` | ModeModal | cured by #1831 |
| `openUmodeModal` | UmodeModal | **defective** |
| `openServiceModal` | ServiceModal | **defective** |
| `requestOpenSettings` | SettingsDrawer | **defective** — reported as #1982 |

#1831 cured two of five. The remaining three carried the identical defect for
anyone who tapped instead of pressing Enter, and #1982 is simply the first of
them a user happened to hit. All three are confirmed synchronous: `openSettings
Command` and `umodeViewCommand` call their opener as the first statement, and
`serviceModalCommand` opens FIRST and awaits `sendBodyLines` after — an
ordering #1518 pinned as load-bearing, so that one cannot be defused by moving
the await instead.

The drawer differs from the four modals in one respect worth recording: it is
the only site reached through a signal rather than an `open*Modal`. The verb
bumps `settingsOpenTick`, Shell's effect runs `setSettingsOpen(true)` in the
same turn, and `.settings-drawer-backdrop.open` takes `pointer-events: auto`
with NO transition of its own (`themes/default.css`) while the opacity fade is
200 ms. So the drawer opened and closed without ever painting — which is
exactly the reported "nothing happens", and is why no overlay appeared in the
reporter's frame-by-frame.

### Why the cure is #1831's helper, and not either candidate in the issue body

The issue proposed widening the send button's #925 click swallow to a
document-level one-shot capture listener, or holding a freshly-opened
backdrop's `pointer-events` off until its transition starts. Both were
declined, and the reasons are not stylistic.

The document-level swallow deletes nothing; it moves the orphan click's victim.
It also defends only overlays opened by that ONE button, when the property
wanted is about the scrim: an overlay that appears under a finger mid-gesture
must not be dismissed by that gesture, whoever opened it. The `pointer-events`
delay is worse on its own terms — it makes correctness depend on a transition
race, and #1059 already ruled on precisely that shape for the twin problem on
the button ("deferring the guard by a frame makes the guard timing-dependent,
which is the shape of the bug, not of its remedy"). A press-armed dismiss is
structural: a backdrop that never received the pointerdown beginning the
interaction cannot be dismissed by its click, whatever the timing.

So the cure is three call sites of an existing helper and no new mechanism.
That is also the honest reading of "fix the class, not the example": the class
was already fixed once, and what #1982 exposes is a migration that stopped at
two of five.

### The oracle

Unit, on the three components' own suites — the two arms that encode the cure
fail before it, the arm that encodes the PRESERVED dismiss passes on both
sides, which is what makes the red discriminating rather than merely red:

| tree | `SettingsDrawer` + `UmodeModal` + `ServiceModal` |
|---|---|
| pre-cure | 6 failed / 139 passed, rc 1 |
| cured | 145 passed / 0 failed, rc 0 |

`SettingsDrawer.test.tsx` had a case named "backdrop click fires onClose" that
asserted a BARE click dismisses. That is the defect written down as a
requirement — the exact click a press-armed dismiss must ignore. It was
replaced by the press-armed trio, not deleted: the dismiss itself must keep
working, and two of the three new cases exist to prove it does.

`e2e/tests/issue1982-tap-send-overlay-survives.spec.ts` puts the platform half
of the question to an engine, `@touch` and only `@touch`: `chromium-pixel-touch`
is the sole project whose `tap()` produces the compat mouse events a real tap
produces, and a `@webkit` twin would pass without touching the defect. Two
verbs through two parsers onto two sub-pages — `/notify` (as reported) and
`/alias`, which is not in the watch family and is parsed by `parseAlias` — each
with an Enter control alongside its tap, because one verb would only have shown
that one string had been patched. Against the pre-cure tree both taps fail and
both Enters pass (2 failed / 2 passed, rc 1); with the cure the four are green.

### The false green that had to be thrown away

The first draft of that spec used `/umode` → UmodeModal as its second arm,
which would have been the stronger claim: a different command module, a
different opener, a different scrim. It PASSED against the pre-cure tree — an
arm that cannot fail, which is worth less than no arm at all. A document-level
capture probe on that same tree says why, and the reason is geometry rather
than mechanism:

    /notify   pointerdown -> polygon                          (the send glyph)
              click       -> div.settings-drawer-backdrop.open
              drawer.open=0        the defect, on an engine

    /umode    pointerdown -> polygon
              click       -> div.mode-modal-body              (the DIALOG)
              umode-modal=1        survives

On a Pixel 7 the umode toggle list is tall enough that the centred dialog
covers the point the send button occupied, so the synthesised click never
reaches a scrim: the dialog's own `stopPropagation` eats it first. UmodeModal
is still defective by construction — its scrim dismissed on a bare click, and a
network advertising few umodes yields a short dialog that leaves the scrim
exposed — but that is not reproducible at this viewport, and the arm was
deleted rather than kept as decoration. The probe output is quoted in the spec
header so the next reader does not spend a stack cycle rediscovering it.

Worth stating plainly because it nearly shipped: the arm was green, on the
right project, exercising the right verb, against code that still had the bug.
Only running it against the MUTANT exposed it. A spec that has never been shown
to fail has not been shown to test anything.

### What this does not claim

Only ONE of the three cured sites has engine evidence. SettingsDrawer was
measured red-then-green on `chromium-pixel-touch`; UmodeModal cannot be
reproduced at that viewport (above) and ServiceModal cannot be driven there at
all, since a bare `/ns` needs services this testnet does not run. Both are
cured on the strength of being the same construction — a scrim dismissing on a
bare click, reached synchronously from the compose line — and both carry unit
arms, but neither has been shown to fail on an engine. Curing them anyway is a
deliberate call: leaving two of five uncured is precisely the half-migration
that produced this issue eight months after #1831.

The engine is Blink with `isMobile` + `hasTouch`. The reported device runs
Chrome, the same engine family — a closer match than #1831 had, whose report
was Android Firefox — but this is still not "Android coverage".

The eighteen other backdrops in cic are out of scope and are NOT asserted safe
by omission. The argument for leaving them is that an overlay opened from an
`onClick` handler activates AT the click, so no orphan click exists to be
retargeted; that argument is reasoning, not measurement. The context menu is
the one adjacent case where it was not even attempted: it opens from
`contextmenu` (long-press), a gesture whose trailing-click behaviour was not
measured here.

The keyboard staying up over the opened drawer was reported in the same session
and is split out as issue 1983; nothing here addresses it.

_Deploy: cic bundle only — every changed source file is under `cicchetto/`,
plus this entry. `Preflight.classify_paths/2` was deliberately NOT run: it
needs the shared `_build` and the COMPILE lane was held by another worker, and
a classification quoted without running it would be a guess wearing a
measurement's clothes._
<!-- entry #1988b -->

---

## 2026-09-07 — #1988b: pinning an effect's shape at the producer does not prove the interpreter accepts it

The #1988 P0 — an inbound `/ctcp <victim> USERINFO` killing the victim's session —
is cured in `9adc65ee3` (v1.5.3). This entry is not about the defect. It is about
why the defect survived a suite that already covered all four of its sites.

`Session.Server.apply_effects/2` is the interpreter of the effect grammar
`EventRouter` produces. It has one clause per effect shape and deliberately NO
catch-all, so an out-of-grammar tuple is a `function_clause` crash rather than a
silent drop. That is the right posture, and its price is that the grammar is
checked at RUNTIME, only for the shapes some test actually drives.

Every test that covered the four broken sites asserted the tuple that
`EventRouter.route/2` RETURNS. Such a test type-checks the producer against
itself and is green for any shape the producer is free to emit — including one
no clause of the interpreter can match. The defect never lived in either module;
it lived in the JUNCTION, and nothing in the suite crossed it. So a test that
pins arity at the producer is worth having (it stops those four sites
regressing) and it is structurally incapable of catching the class.

`test/grappa/session/ctcp_reply_effect_test.exs` is the other half: it feeds a
real line into a real `Session.Server` over a real socket and asserts the answer
reached the wire. Two-sided against the shipped cure — intact: 4 tests, 0
failures; the four sites reverted to the 2-tuple in a local tree: 4 tests, 4
failures, every one `no function clause matching in
Grappa.Session.Server.apply_effects/2`.

### The assertion that is easy to get wrong

It asserts the pid is the SAME pid, not merely that a session is alive.
`Session.Server` is `:transient`, so a crash is followed immediately by a
supervisor restart under a NEW pid re-registering the same key: a liveness check
on a re-looked-up pid goes green milliseconds after the crash it exists to
catch. The wire assertion carries the same weight from the other side — a dead
session sends nothing, so `{:error, :tcp_closed}` on the waiter IS the crash,
observed from outside the VM's supervision.

### The rest of the class, measured

The class is "a producer whose arity the single interpreter clause cannot
match", and it was enumerated rather than grepped: parse every `apply_effects`
clause head into `atom -> accepted arity` (34 atoms), then scan all 337 modules
under `lib/` for balanced `{:atom, ...}` tuples. Comments and `@doc` heredocs
must be stripped first — the first pass reported 12 hits and 8 were abbreviated
tuples in prose, which read exactly like code. The answer over all of `lib/` is
that the four cured sites were the only real ones; the remaining hits are
documentation, plus `session_log.ex`'s `GenServer.cast(__MODULE__, {:persist,
metadata})`, an unrelated protocol colliding on the atom alone.

One test-side straggler is fixed here: `event_router_property_test.exs`'s
`:reply` arm still carried the 2-tuple, so the file's own "Mirror the FULL
union" contract was false. Measured before touching it: DEAD, not a latent red —
`string(:ascii)` cannot generate the `\x01` of a CTCP body and
`show_peer_profiles` is hardcoded false in all three state generators, so no
`:reply` producer is reachable from that generator and the property suite was
green either way. It would have begun flunking on its own `other ->` clause the
day a generator turned that flag on.

_Deploy: **test-only** — no production module, no migration, no `VERSION` bump,
no cic bundle, no wire change._
<!-- entry #162a -->

---

## 2026-09-06 — #162a: /ignore, dropped at the door

**Shipped:** a per-subject, per-network `/ignore` mask list, honoured
server-side. `Grappa.IRC.Mask` (the `nick!user@host` glob matcher grappa never
had), an `"ignores"` key in `user_settings.data` with `get_ignores/2` +
`add_ignore/4` + `remove_ignore/4`, `/networks/:network_id/ignores` REST, the
list carried on `Session.Server` state and re-synced on mutation, and the
filter itself at the head of `EventRouter.route/2`. cic gets `/ignore <mask>`,
`/unignore <mask>`; a BARE `/ignore` opens the ignore-list settings
sub-page, the door bare `/hilight` and `/notify` take (#356) — the list with
its per-entry × lives there, so there is no in-window list verb. A mutation's
answer prints INTO THE WINDOW, irssi-style, through a new plain-text sibling
of `topicShow` / `inviteAck` (`cicchetto/src/lib/commandOutput.ts`, one row
per line with an optional accent label and an indent flag, interleaved by
wallclock like the other two): one row naming its own outcome on the
NORMALISED mask (`Unignore: removed spambot!*@*`, labelled like `Topic for
#chan:` — `/unignore spambot` acts on a mask the operator never typed, so
the reply must name it) and nothing else. Not the transient compose notice,
which auto-dismisses and holds one line: the rows stay, so the window reads
as a history of what was asked and done (Gabriele's rulings, 2026-09-06:
name what was removed; drop the trailing list; print in the window; then
the bare verb opens settings rather than printing the list).

**The ignore list is read at the SPAWN BOUNDARY, not in `init/1`.** First
CI run after the review fixes: `JoinSeedCostTest` (the #1759 join-storm
count, which deliberately counts every query in the VM) read one stray
`user_settings` query at W=1 and failed its linearity law. The stray was
`UserSettings.get_ignores/2` inside `Session.Server.init/1`: a `:transient`
respawn re-runs `init/1` with the same opts, so an init-time read fires on
every crash — and the storm fixture's session respawns mid-window. Moved to
`start_session/3` beside `auto_away_debounce_ms` and `show_peer_profiles`
(`Map.put_new_lazy(:ignores, …)`), the repo's spawn-boundary pattern, which
a respawn does not re-run. Same edge those two carry: a restart holds the
spawn-time value until the next `ignores_changed`.

**Review fixes (vjt on #1984, 2026-09-07), all three taken as fixes.** (1)
Masks are compiled ONCE — `Mask.compile_all/1` in `Session.Server` at init
and on every `ignores_changed` — and the router matches the compiled list;
the first cut compiled up to three regexes per mask per inbound line, on
exactly the users who use the feature. (2) The fold is the NETWORK's, not
ASCII-only: `Mask.normalize/2` takes the casemapping (the controller reads
`Session.casemapping/2`, the `/notify` door), so a stored mask sits in that
network's folded space, and the delivery match folds only the SUBJECT nick
with `state.isupport`'s casemapping — the #537 ingress rule applied to one
more key. The review asked for this to be documented as an accepted rfc1459
gap; Gabriele ruled it fixed instead, since casemapping is implemented and
the "accepted gap" reads as older than that fact. Compiled masks are
casemapping-independent, so nothing recompiles on 005; the one remaining
edge is the pre-005 write, the same one the autojoin plan carries. (3)
`\A`/`\z` instead of `^`/`$`, with a test that a trailing newline on the
subject does not match — and every positive assertion in `MaskTest` pins
the backslashes themselves.

**Settings sub-page.** The list is also editable under settings → "ignore
list" (`cicchetto/src/IgnoresSettings.tsx`), one block per network with × to
remove and an add-input, shaped after the watch-lists page (#356) down to
the list classes. Backed by `lib/ignoreList.ts`, a mirror store in the
`highlightList.ts` mould (no broadcast → refresh on open, every REST answer
mirrored), and the `/ignore` verbs go through the SAME store, so a verb typed
in the compose box updates a sub-page that is open — one state, never two.

**A third ephemeral kind exposed an ordering bug in the first two.** `/ignore`
then `/topic` printed the topic ABOVE the ignore rows. `ScrollbackPane`'s
`rows()` memo wove invite-acks, `/topic` answers and now verb answers into
the timeline in three separate passes, each anchoring only on MESSAGE rows
(`server_time > at`): the `/topic` pass ran after the `/ignore` pass, saw no
later message, and went to the END — past rows it never looked at. The same
shape reverses two `/topic` answers once a message lands after both (equal
insertion index, the second splice lands first) — latent since #1914, never
seen because nobody asked `/topic` twice under a live channel. Fixed by ONE
pass over all ephemeral entries sorted by `(at, ts)`, with every woven row
carrying its `at` so a later answer anchors on an earlier one exactly as on a
message (`rowTime/1`). Pinned by a pane test that asks `/ignore` then
`/topic` under a message later than both.

### Drop, not hide, not re-route — and why the pick was easy

#162's body says drop. Lucy's variant re-routes to the server window as a flat
silent line; the issue records the tension and that someone has to pick. Picked
drop, on vjt's ruling that ignored is ignored — no un-hide, no back and forth —
which also makes the second ruling on the issue free: **an ignored message must
produce no push**, and with no persist effect there is no row, no broadcast and
no trigger, so *"ignored mask sends a DM, subscription exists, zero pushes
emitted"* holds by construction rather than by a second gate beside
`muted_targets` in `should_notify?/5`. If the re-route variant wins later, the
storage, matching, REST and commands all survive; only the delivery arm changes.

### Its own structure, beside `muted_targets`, not inside it

vjt's ruling, and mechanical rather than aesthetic: a mute is "this ROOM is
noisy" and only suppresses attention; an ignore is "this PERSON is a problem"
and stops the message existing. The read-path difference is total — mute has
never needed a filter, ignore is nothing but one — so one shared shape would
carry a field meaningless on half its rows. Same conventions (network in the
key for the #1038 reason, `canonical_target/1` fold), separate key. irssi's own
`NO_ACT` level is what `muted_targets` already is, arrived at independently,
which is the strongest evidence these are two features and not one with a flag.

### The filter's four deliberate exclusions

Content only — PRIVMSG and NOTICE (ACTION rides PRIVMSG); presence verbs are
governed by the presence filter and dropping a JOIN here would desync the
members map. Never our own lines. Never a services or server sender
(`Mentions.mentionable_sender?/1`, #1674): a `*!*@*` mask must not eat
NickServ telling you your password is wrong. Never an origin with no nick.

### Forward-only settled the mask question for free

Scrollback stores `sender` as a NICK, never `nick!user@host`, so a mask can
never be applied to stored history. Under #162's forward-only ruling that never
bites: matching happens at delivery, where the prefix carries the full triple
(`Message.sender_origin/1`). A cloaked or absent user/host satisfies only a `*`
pattern, never a concrete one — an ignore on a host must not fire for a sender
whose host we cannot see.

### Two bugs the unit tests caught before the PR

1. `normalize/1` accepted `"a b"` — `safe_line_token?/1` guards CR/LF/NUL, not
   whitespace, and a mask is one token. Rejected explicitly.
2. The glob's absolute anchors (`\A`/`\z`) reached the source as a bare `A`/`z`
   through a layer that eats backslashes, so the matcher silently matched
   nothing — every positive `matches?/4` case red at once. Replaced with
   `^`/`$`, which need no escaping and bind to the string ends here (no part can
   carry a newline). The comment on the regex says why.

### Not in v1

irssi's `<levels>` argument (`/ignore nick PUBLIC`) — content-only for now, and
the vocabulary to grow it is `Message.kinds/0`. irssi's `-replies` — grappa
does not track what a message replies to. A settings-drawer list — the bare
`/ignore` prints it.

_Deploy: **HOT** — no migration (a JSON key in the existing column).
`protocol_version` 13 → 14 (13 went to #1850 while this branch was out — same mechanism, a token moving the pin), and not by judgement: the routes alone are the
v10/v11 shape (REST endpoints sit outside the generated schema), but the 422
`invalid_mask` token joins `rest_error_token`, a closed set
`gen_wire_types` renders into cic's `KnownApiErrorCode` union — the pin
moved, `ErrorTokensDriftTest` went red, and this paragraph had already
written the bump off before either spoke. `min_protocol_version` stays 1:
no pre-v14 bundle knows `/ignore`, so none can earn the token._
<!-- entry #1767c -->

---

## 2026-09-07 — #1767c: the LockWatch flake is quarantined at MODULE scope, and that is a real hole

`test/grappa/repo/lock_watch_test.exs` is excluded from CI by default. vjt's
ruling on issue 1767, 2026-09-07: *"se abbiamo un flake test disattiviamo e
apriamo issue per fixarlo"*. **Issue 1767 stays OPEN** — it is where the cure
will be built. This entry records the quarantine, which is the immediate action
and explicitly not the diagnosis.

The trigger, from the orchestrator's sightings register (`.orchestrate/
flake-1767-lockwatch-sightings.md`, kept on the Pi — read by them, not by me,
so it is attributed and not claimed): six reds in forty minutes on one evening,
five distinct carriers inside this module plus one in `JoinSeedCostTest`; one
carrier reproduced in isolation at 38 tests against a clean `origin/main`; one
test green and red on the SAME sha.

### Where the exclusion lives, and why it cannot live in `config/test.exs`

The tag is `@moduletag :flaky` on the test module; the exclusion is
`ExUnit.start(capture_log: true, exclude: [:flaky])` in
`test/test_helper.exs`. That placement is not a preference. The same file
already documents the incident that settles it: **`ExUnit.start/1` opts
override `config :ex_unit` SILENTLY**, and on 2026-05-13 the CP25
shared-singleton fix shipped INERT for ~12 hours because a `max_cases: 2` in
`ExUnit.start/1` quietly beat the `max_cases: 1` in the config. An exclusion
written config-side would have been the next thing to ship inert, and it would
have looked exactly like a working one.

Getting back in is `scripts/test.sh --include flaky <path>`. Mix configures the
CLI `--include` before requiring `test_helper.exs`, and `:include` is a
different key from the `:exclude` set here, so the `ExUnit.start/1` call does
not clobber it — measured below rather than reasoned about, since reasoning is
what produced the twelve inert hours.

### The four measurements

All on this branch, in the container, `scripts/test.sh`:

* **Module size / baseline.** Unmodified tree: `38 tests, 0 failures` in 11.5s.
  Green on that run — the flake is intermittent by construction, which is why a
  single green proves nothing and is not offered as proof of anything.
* **NEGATIVE.** Default run of the file: header `Excluding tags: [:flaky]`,
  then `0 tests, 0 failures (38 excluded)`. The exclusion is live and its reach
  is exactly the 38.
* **POSITIVE.** `--include flaky` on the same file: **38 tests actually ran**,
  150.8s. `--include` beats the exclude. This run did more than count: it
  reproduced the quarantined phenomenon — `1 failure`,
  `lock_roles/0 names the same holders and waiters inspect_lock/0 does`,
  `** (ExUnit.TimeoutError) test timed out after 60000ms`. Same class as the
  register's sightings, on the first attempt after tagging.
* **SUITE DELTA.** Full suite before: `8 doctests, 65 properties, 7164 tests,
  0 failures` (155.3s). After: `8 doctests, 65 properties, 7126 tests, 0
  failures (38 excluded)` (141.7s). 7164 − 7126 = **38**, exactly the module,
  with the doctest and property figures unmoved. Nothing but this module left
  CI. Both runs green, so the delta is a clean subtraction and not a red
  cutting a run short.
* **NON-COLLATERAL.** `git grep ':flaky' -- test/ config/` returned **0 hits**
  before this change (positive control alongside: `@moduletag` in
  `lock_watch_test.exs` = 1 hit, so the grep was alive). The tag has exactly one
  carrier; a second one is a decision, not housekeeping.

### 🔴 The price, stated rather than buried

`@moduletag` quarantines the **whole module**, not the tests that actually
flake. From here on **a GENUINE `LockWatch` regression lands unobserved in
CI** — the holder/waiter attribution (#1420), the unattributed-queue arm
(#1687), the NIF cohort (#1901), the closing bracket (#1888), the episode
instant, the boot-time priming of the logger module cache (#1715), the barrier
budget (#1747) and the filmer (#1767) all stop being defended. That is the cost
the ruling accepts in exchange for not losing unrelated PRs a night to somebody
else's flake, and it is a cost, not a claim that the module stopped mattering.

Module scope rather than five per-test tags is deliberate for a second reason:
the carrier set is not closed. Five carriers are known; pinning today's five
would go stale on the sixth while reading, to anyone glancing at CI, like
coverage.

### What this entry does NOT claim

* Not a diagnosis and not a cure. Nothing here explains the flake; #1767b's
  measurements remain the state of the art and issue 1767 remains open.
* Not that the phenomenon is confined to this module. `JoinSeedCostTest`
  carried a red the same night per the register; it is deliberately NOT tagged
  by this slice.
* Not that `--include` is the only door back in — `--only flaky` was never
  measured here.

_Deploy: **test-only** — no production module, no migration, no `VERSION` bump,
no cic bundle, no wire change._
<!-- entry #1958 -->

---

## 2026-09-07 — #1958: /credits, one verb deep

The end titles (#1773) opened from exactly one place: the last entry of the
settings drawer, three taps down — menu, settings, scroll to the bottom — for
the one screen in cicchetto people stop to read. A `/credits` verb now opens
the same modal from the compose box.

### Shape: a UI deep-link, like a bare /hilight

The parser gains `{kind: "open-credits"}`, carrying nothing: the modal is a
module-singleton signal (`lib/creditsModal.ts`) and the verb takes no
arguments, so trailing text is ignored, the no-arg family's posture. The
handler sits in `lib/commands/local.ts` beside `openSettingsCommand`, the
existing precedent for an arm that resolves no network id and puts no frame on
the wire; its body is the `openCreditsModal()` the drawer entry already calls.
Opening the modal IS the feedback, so it is a silent `{ok: true}` and the draft
clears. The modal itself is untouched — one opener signal, two doors.

### The issue's two open questions, answered on the issue (Gabriele)

1. **Shadowable.** `/credits` does NOT join `NON_SHADOWABLE_VERBS` (`alias` /
   `unalias`, the command-side repair surface). Nothing argues an alias over
   the end titles needs a deny; a unit test pins that an alias wins.
2. **The drawer entry stays.** The verb is a shortcut, not a replacement — the
   drawer is where people find the things they cannot name. The e2e spec
   opens the modal both ways in one run.

### What each gate proves

The unit layer (`slashCommands.test.ts`, `compose.test.ts`) pins the parse and
the dispatch — the #1396 characterization net gained an arm, with
`../lib/creditsModal` as a mocked seam so the open is observable rather than a
silent `{ok: true}`. What a mock cannot see is that the signal the verb flips
is the one the MOUNTED modal listens to; `e2e/tests/issue1958-credits-verb.spec.ts`
types the verb into a channel window against the real bundle and asserts the
modal's title, then closes it and opens it again from the drawer.

_Deploy: **HOT**, cic bundle only — no server change, no wire change, no
protocol bump: the verb never leaves the client._
<!-- entry #1993 -->

---

## 2026-09-08 — #1993: the general settings page, grouped by what governs it

The general sub-page had grown by accretion. Network-scoped and account-scoped
controls were interleaved, and the `<select>` deciding WHICH network four of
them target sat buried inside one of those four — the identity card. Nothing
above the fold said the identity/profile/avatar/password block was per-network
at all. What follows is the set of rulings the reshaping needed; the mechanics
are in the diff.

### Scope is a GROUP, and on the common path the heading is its only witness

The picker is lifted to the top of a `.settings-network-scope` group holding
exactly what it governs; the account-scoped knobs (upload retention, auto-away)
stay outside. The heading naming the scope is not decoration, and that is the
load-bearing half: **#497 stands** — a one-option picker is noise, so a subject
with a single network never sees the selector at all — which means on the common
path the heading is the ONLY thing on screen saying what those cards are keyed
to. Membership asserted on one side proves nothing (a group that swallowed the
whole page would satisfy it), so the tests assert it two-sided: the identity
card INSIDE, auto-away and upload retention OUTSIDE.

### One gesture, two endpoints: a CEILING, not a single bounce

Identity and the NickServ password now apply with one button. They remain two
endpoints — `PATCH /identity` and `PUT /password` fail differently, so the
signals and the error banners stay separate — and each leg is skipped unless it
has something to write (`identityDirty()`, password `!== ""`). The password leg
goes FIRST and fails fast: a refused secret must not buy a reconnect for the
half of the gesture that would have worked.

**#124's objection is ANSWERED, not overruled.** It refused an earlier fold
because an untouched password field would be indistinguishable from *clear my
password*. Leave-blank-to-keep now lives on the password LEG rather than on a
button of its own: the empty field is never sent, so it cannot mean *clear*. The
objection was about a semantic the fold destroyed; that semantic survives in a
different place, which is why the fold became admissible — the ruling was not
outvoted, its premise stopped holding.

**What the merge guarantees is a CEILING: never MORE reconnects than the two
buttons it replaces.** A single-axis change costs exactly one bounce; an
untouched card costs none. It does NOT guarantee ONE bounce when both axes are
dirty, and that is measured rather than assumed — `identity/2` and
`update_password/2` BOTH call `live_apply_identity/3`
(`lib/grappa_web/controllers/networks_controller.ex`), so two writes are two
reconnect requests. A genuinely single bounce needs a COMBINED SERVER VERB,
which is a server-side scope change and not this slice. cic cannot manufacture
one: the only client-side way to spend a single bounce is to withhold a write,
and withholding a write is originating state.

Renamed while there: "Network password" reads as the server PASS (#1044's
separate secret, with its own door). This field writes what identifies you to
NickServ, so that is now what it says.

### Sub-page, not disclosure

Profile, avatar and the peer-profiles opt-in — many fields for something set
once — moved behind a nav row into their own sub-page. **Chosen over a
checkbox-driven disclosure because the drawer already HAS sub-pages**: a
disclosure would mint a second in-drawer navigation idiom for the same job, and
a second idiom for one job is the accretion this issue exists to undo.
`subpageHeader` takes its back target as an explicit parameter now, with no
default — profile is entered from general and must return there, and a defaulted
back target is precisely the silent-degradation path a wrong return would take.

The door is UNGATED on networks and sits OUTSIDE the per-network group, on
purpose: the profile page also carries the ACCOUNT-scoped peer-profiles opt-in,
so gating the door on holding a network would strand a control that has nothing
to do with networks. "profile" is also the first NESTED sub-page — reachable in
one tap from general, never from the index — which the flat routing signal
supports unchanged, but which a future deep link should respect rather than
stranding someone a level in.

### Point 4 is NOT decided here

Making `show_peer_profiles` network-scoped is deliberately left out. It is a
server-side scope change that the issue itself files as an open design question,
and the layout states TODAY's truth — account-wide, outside the per-network
group — rather than pre-positioning for a ruling nobody has made. If the ruling
lands the other way the control moves INTO the group, and this paragraph is what
the current placement meant, not an argument for keeping it.

### A length pass may not drop what a user cannot guess

The blurbs are cut to one sentence each. #462's three facts about upload
retention all survive INSIDE that one sentence: that pass was about LENGTH, and
brevity is not licence to drop what a user provably cannot derive from the
control in front of them. The guard is a SHAPE rule — at most one sentence
terminator per blurb, over the general and profile pages — not a string pin. A
string pin would rot on the next reword and teach the next reader to delete the
guard instead of the prose.

### The select-sizing rule, and exactly what its guard proves

`:where(.upload-ttl-fieldset, .auto-away-fieldset) > label > select { width:
100% }`. Both fieldsets wear the #1227/#1766 shape — the visible label text was
dropped and the `<label>` stayed as the flex ROW — which left the select sized
by its own option text inside a full-width fieldset; neither fieldset carried a
rule at all. One rule on the class both share. The notifications mute picker is
deliberately excluded: its label still carries visible text sharing the row. The
guard reads the CSS SOURCE (`ruleBody`), so it proves what is ASKED of the
cascade, never what a browser paints.

### What this entry does NOT claim

* Not that the merged apply is ONE reconnect. It is at most two, and exactly two
  when both axes are dirty — measured on the controller, above.
* Not that the select sizing was observed in a real browser. The guard is on the
  source rule; no rendered width was measured anywhere in this slice.
* Not a ruling on point 4, and not a claim that outside-the-group is where
  `show_peer_profiles` BELONGS — only that it is where it currently is.

_Deploy: **HOT**, cic bundle only — no server change, no migration, no wire
change, no protocol bump: nothing here leaves the client except the two REST
calls the two buttons already made._
<!-- entry #1964 -->

---

## 2026-09-08 — #1964: the confirm previews what it is asking about, and Enter means yes

#1883 put a file list in the confirm dialog so "Send this?" could be answered,
and gave the row an image thumbnail. The argument for stopping there is quoted
in the code it justified: *"a picture is the only preview worth showing: for
every other category the bytes say nothing a human can check at a glance, and
the name is what distinguishes `contract-final.pdf` from `contract-draft.pdf`"*.

That reasoning assumes a name the OPERATOR chose. On the paste-as-.txt door
(#816) the name is the constant `paste.txt`, for every paste in every window,
so on the one door where the operator cannot know what is inside, the dialog
showed a constant name, a byte count and an empty box. Gabriele reported it
from the paste path and ruled the fix (2026-09-08): show the preview for the
file's ACTUAL type, reusing the wiring that already exists.

### Reuse means the viewer's vocabulary, not its components

`MediaViewerModal` switches on `MediaKind` (`image | video | audio | text`) and
its image/video/audio arms are `href: string`-driven, so a `blob:` URL of a
local file would work in them unchanged. What is NOT reusable is the component:
it is a full-screen modal with dismiss gestures, and the confirm needs a 2.5rem
row. So the reuse is at the level that survives — the kind vocabulary and the
element shapes — and `ConfirmAttachment` now carries
`preview: {kind: MediaKind, blob} | null` instead of `thumbnail: Blob | null`.

`attachmentPreview.previewKindOf/1` maps a MIME to that kind, and it is NOT
`categoryOf`: `UploadCategory` also has four members, but `document` is one
bucket holding `text/plain`, `text/markdown`, PDF, ODT, ODS, DOCX and XLSX.
Only the two text types have a renderer in cic, so `document` splits on the
base MIME and everything else answers `null` and keeps the placeholder. There
is no PDF or office renderer anywhere in the client and this slice did not
invent one.

**The text arm is the one that could not reuse the viewer**, and the reason is
mechanical: `TextPane` reads through `textResource.ts`, which fetches with a
`Range` header, and a blob: URL does not honour Range. So a staged text file is
read from the File itself — `blob.slice(0, 8 KiB).text()`, head only, then
`splitLines` (the viewer's own splitter) and the first four rows. A truncated
read drops its last row, because a byte slice can land mid-line and
mid-codepoint — but only when that row is really partial. The review found both
exceptions: a cut landing exactly on a newline leaves every row complete (and
`splitLines` has already dropped the phantom), so dropping again eats a real
line; and a file whose FIRST line is longer than the head yields one partial
row, where dropping it returns `[]` — an empty box, the very defect this
change removes.

**Sound and video get a PLAYER, not a still.** For sound there is no picture
to recognise — listening IS the preview, and `<audio controls>` is what the
viewer gives a clicked audio link. Video started as a muted first frame in the
thumbnail box; Gabriele asked for it to be playable (2026-09-08) and the reason
holds: a video is a thing that MOVES, so checking you picked the right take
means watching it, and a still frame answers a question only a photo has. A
control bar is unusable at 2.5rem, so both take a full-width block and the row
became a column — the first line keeps #1883's shape (thumbnail, name, size, ×)
and every preview that must be operated or read stacks under it. The `#t=0.1`
fragment stays: it asks for a frame rather than a black poster before play.

### Enter, and the reversal it required

#195 focused Cancel unconditionally, "so a stray Enter dismisses, never
leaves". That is right for a dialog that leaves a channel, drops a network,
floods a room or deletes a theme. It is wrong for this one: the operator has
already picked, dropped or pasted the file, the confirm is opt-in and was
switched on to LOOK at what is going out, and Enter — the key you press after
reading — discarded the batch. `ConfirmRequest.defaultButton` is now explicit
at all ten call sites; nine say `"cancel"` and the upload confirm says
`"confirm"`.

Two things fell out of implementing it, both measured in a browser rather than
reasoned:

1. **The focus effect was keyed on an open/closed EDGE**, and the `<Show>` is
   unkeyed, so a request REPLACED by another never re-focused. That is exactly
   the paste path: the guard's "Upload as .txt" door clears the store and opens
   the send confirm in the same tick, so the intermediate `null` is never
   observed. Now keyed on the request object, which also preserves #195's other
   half (a re-render with the same request does not re-steal focus).
2. **A row removal dropped focus to `<body>`.** The × the operator presses
   unmounts with its row, so the next Enter answered nothing — in the one
   dialog where Enter is supposed to send. The modal hands focus back to the
   request's default button after a removal.

### What the review changed

An adversarial pass over the branch found no critical issue and four medium
ones, all fixed here rather than filed. Two are recorded above (the truncation
guards, and the `MediaKind` coupling note); the other two:

* **Row identity.** `items()` minted a fresh `ConfirmAttachment` on every read,
  and Solid's `<For>` diffs by REFERENCE — so removing one row disposed and
  recreated every row. Invisible while the only preview was an `<img>`; visible
  the moment one of them is a PLAYING `<audio>`, which stopped and reset to
  zero. The attachment is now minted once, beside the staged file.
* **The document split was a stringly `Set`.** `uploadCategory` types
  `MIME_EXT_LABEL` on the MIME unions precisely "so a 15th MIME added to a list
  without a label here is a compile error"; the preview map now does the same,
  so a ninth document type cannot silently preview as an empty box.

### The row with no preview says so

The first cut kept #1883's neutral ☐ glyph for a file with no renderer.
Gabriele's ruling on seeing it (2026-09-08): that glyph reads as a picture
that FAILED to load, which is a different claim from "this type has no
viewer", and it was also being shown beside text and audio previews that
work. There is no PDF or office renderer anywhere in cic — the media viewer
has four arms, and a 📄 link deliberately falls through to the browser
(`MircText.tsx`) — so previewing those types would mean building a viewer
first, which this slice is not.

So the unpreviewable row now carries no box at all and states the limit in
words: name, size, `· preview not supported`. It is the CATCH-ALL, not a
PDF special case — the picker does not pre-filter by category, so an
arbitrary binary reaches the dialog too, and it gets the same honest row. The
uniform-row-height argument the glyph existed for had already lapsed: audio
and text previews are taller than any 2.5rem box.

### Not done, and why

The constant `paste.txt` filename is untouched. With the first lines rendered,
the dialog now says what is going out, which was the complaint; changing the
name changes the URL peers see on IRC, and that is a separate decision from
fixing a blind dialog.

_Deploy: **HOT**, cic bundle only — no server change, no wire change, no
protocol bump._
<!-- entry #1999 -->

---

## 2026-09-08 — #1999: the membership sigil set is the network's, in six places

A user on #grappa (Kerd) reported that clicking a nick in the members pane
opened a query against `~nick` — a nick that does not exist, so nothing could
be written in the window. The issue named one cause,
`EventRouter.split_mode_prefix/1`, which matched a hardcoded `?@ ?% ?+`: a 353
RPL_NAMREPLY token like `~nick` missed every clause, fell through the
fallback unchanged, and the sigil became the `state.members` KEY.

That diagnosis was correct and incomplete. Grepping the CLASS rather than the
reported symptom found the same hardcoded triple in five more places, three of
them server-side and none named in the issue:

* `Identifier.member_prefix/1` held `["@", "%", "+"]` as a module constant, so
  `Enum.find` returned nil for a `["~"]` member and a founder's content rows
  were persisted with NO `meta.sender_prefix`. That one is permanent by
  design: #25 SNAPSHOTS the grade at persist time precisely so a later MODE
  cannot re-prefix history, so every row already written keeps the omission.
* `Session.Server.member_sort_tier/1` knew `@` and `+` only. It did not rank
  bahamut's OWN halfop — a `%` member sorted into the plain tier — and that
  survived unseen because cic re-sorts the pane with a tier function of its
  own. The server order is visible in `GET /members` and in the
  `names_reply`/`members_seeded` payloads, not in the pane.
* cic's `memberSigil`, `members.tierRank`, `NamesModal`'s four hand-written
  not-higher predicates, `WhoModal`'s `Membership` union, `MembersPane`'s
  `tierClass` and `nickColor.snapshotSenderPrefix` each carried a copy.

### What the fix is

One accessor per side. `ISupport.sigils/1` and cic's `sigilRank` return the
advertised run, HIGHEST RANK FIRST, composed from `prefix_order` + the lookup
map — not stored as a third field, because a stored copy is a parallel
structure that needs housekeeping and will drift. Rank comes from
`prefix_order` and never from the map: `Map.values/1` / `Object.values` come
back alphabetical BY MODE LETTER, which on `(qaohv)` puts `o` in the MIDDLE.
That is the same mis-rank #1302 found in `editorSigils`, and #1302's docstring
is the reason this was written correctly the first time here.

Deriving the SET rather than widening the literal to `~&@%+` is what makes the
inverse safe. On a `(ov)@+` network a leading `~` is not a membership sigil,
and peeling it would silently address a DIFFERENT nick. Unknown stays unknown,
everywhere: an unadvertised sigil is not a grade for the sort, not a grade for
the snapshot, and not a glyph for the render.

The peel is GREEDY, and that is a deliberate decoupling rather than support
for a feature we do not have. `multi-prefix` is not in grappa's CAP REQ, so
upstream sends the single highest sigil and the run is length 1 in production
— but a nick can never BEGIN with a sigil (RFC 2812 §2.3.1 `special` is
`[ ] \ ` _ ^ { | }`, which excludes every PREFIX char), so peeling the whole
run is unambiguous. Writing it greedily keeps `split_mode_prefix/2` correct
independently of a CAP decision made in `IRC.AuthFsm`, instead of silently
keying on `&nick` the day that changes.

### No wire change, and it was measured

`mix grappa.wire_pin --check` answers "wire shape and protocol 14 agree" and
`gen_wire_types --check` reports in sync after the change. The domain of
`modes` widened; its SHAPE did not, and `meta.sender_prefix` is `term()` in
the typespec, appearing in `wireTypes.ts` only as a key NAME. `modes` is
already `string[]` there, so an old bundle receiving `["~"]` degrades — no
glyph, plain tier — rather than rejecting the payload. Everything cic needs
(`prefix`, `prefix_order`) has crossed the wire since #1302. Recorded because
the #1393d rule bumps on every shape change including additive ones, so "no
bump" has to be an answer somebody measured, not an omission.

### Two limits taken knowingly

**No colour for a new sigil.** `NickText.prefixClass` and `MembersPane`'s
`tierClass` keep their three classic branches and fall back to the bare
`.nick-prefix` baseline / `member-plain`. The theme carries `--mode-op`,
`--mode-halfop` and `--mode-voiced` and nothing else; inventing a hue per
sigil is a design decision every theme in `themes/` would have to answer.
The glyph is what carries the grade, and it is now drawn at all — which was
the defect. `--mode-founder`/`--mode-admin` wants a design owner.

**The e2e cannot reach the reported case.** Measured on the live stack rather
than assumed: the bahamut leaf advertises `PREFIX=(ohv)@%+`, solanum
advertises `PREFIX=(ov)@+`, and solanum's reference.conf carries no
`use_owner`/`use_admin`/`use_halfop` knob — it has no founder/admin channel
modes to enable. So `~` and `&` are covered where they CAN be measured:
server-side by a `list_members` case that drives a real
`005 PREFIX=(qaohv)~&@%+` through the fake ircd, client-side by unit cases
that seed the isupport store with the same table. The e2e that DOES exist
guards the rewrite at the one door nothing else guarded — a real ircd, a real
353, the real render — and states its own limit in its header. Lifting it
means adding an ircd that advertises founder/admin as a testnet service,
which argues against #221's deliberate move from a hand-rolled bahamut mock
to a real solanum, and is its own slice.

### The test that broke, and why it was the test

Two `MembersPane` cases asserting "the network is unresolved" used
`mockReturnValueOnce([])`, which pins a CALL INDEX rather than a state. The
rank memo adds one `networks()` read at render, so the empty array was
consumed before the click handler ran and both cases failed while the
production behaviour they assert was intact. Measured both ways before
touching anything: 1 call after render / 2 after click with the memo, 0 / 1
with that single path stubbed. Cured in the SETUP — a scoped
`mockReturnValue` restored by `beforeEach` — never in the assert. General
rule: `mockReturnValueOnce` on a function the component calls an
implementation-dependent number of times encodes a call count nobody meant to
assert.

_Deploy: **COLD** — server modules changed (`ISupport`, `EventRouter`,
`Identifier`, `Session.Server`) plus the cic bundle. No wire change, no
protocol bump._
<!-- entry #2003 -->

---

## 2026-09-08 — #2003: `CLAUDE.md` said `:interactive`; the release runs `-mode embedded`, and the number that backed it is withdrawn

`CLAUDE.md`'s #1715 paragraph carried four claims about the runtime it
describes. One was false, one was unsourced, one is about to go stale under a
slice in flight, and the rule they all propped up turns out not to have needed
any of them.

### The false one: the release is not interactive

The paragraph read *"the release runs `:interactive` and its `vm.args` sets no
`-mode`"*. The second half is true and the first does not follow from it — the
flag is supplied by the START SCRIPT, not by the args file.

Measured twice, independently:

* **On the live node.** `RELEASE_MODE=embedded` read out of pid 45683's
  *environment* with `procstat -e` (jail `grappa-new`, release 1.5.3). The
  explicit variable, not a glance at a command line.
* **Off-prod, from the build artefacts.** The repo ships no `rel/`, so
  `mix release` writes Elixir's stock template, whose `vm.args` sets no `-mode`
  and says so in a comment. The generated `bin/grappa` then supplies it with a
  **default of its own**: `RELEASE_MODE="${RELEASE_MODE:-"embedded"}"` (line
  31), passed as `--erl "-mode $RELEASE_MODE"` (line 85) from the shell
  function that both `start` and `daemon` call. `RELEASE_MODE` appears **0
  times** in the whole repo (positive control: the same grep recipe hits
  `RELEASE_COOKIE` in 36 files), and `infra/freebsd/rc.d/grappa` reaches the
  release through one door — `grappa_runas "daemon"` — exporting `RELEASE_TMP`,
  `LANG`, `RUN_ERL_LOG_*` and `PATH`, and no `RELEASE_MODE`.

So embedded is nobody's choice: it is the Elixir release default and the repo
has never overridden it. Residual gap, named rather than papered over: `su -m`
preserves the invoking environment, so a `RELEASE_MODE` exported outside the
repo could override it — which the `procstat -e` reading rules out for the
running node.

### The unsourced one: the cold-module census is deleted, not re-measured

*"2464 of 3063 modules are still cold (80 %), 265 of `Grappa.*` alone"* had no
recorded provenance. It is removed rather than re-taken, on three grounds, and
the third is the one that generalises:

1. **Nobody recorded which node it came from.** An unsourced number is cited as
   measured by the next reader; that is how it survived this long.
2. **It cannot describe this substrate.** `releases/<vsn>/start.script` carries
   **317** distinct `Elixir.Grappa*` modules among 1372 total, all inside
   `primLoad` directives, and embedded mode loads exactly that set at boot. The
   census was therefore almost certainly taken on a NON-release node — docker's
   `mix phx.server` or an `iex -S mix`, where interactive genuinely is the mode.
3. 🔴 **A correct re-measurement would still be the wrong evidence.** The number
   counts MODULE RESIDENCY. The rule it was supporting depends on LOGGER-CACHE
   residency. Those are different axes, and no value of the first is evidence
   for the second. **A rule may not cite a number that does not measure it** —
   that is the transferable lesson, and it is why re-measuring was declined even
   though the measurement is cheap to describe.

### The rule survives, and it never depended on `-mode`

The priming rule (`LockWatch.prime_logger_module_cache/0`, #1731) stands
unchanged. #1715's hazard has two legs and they part company here:

* **The `persistent_term` leg is intact on every substrate.** A module's first
  log line does a `persistent_term:put` via `logger_config:allow/2`. Embedded
  mode loads CODE; it does not populate Logger's per-module cache. A preloaded
  module that has never logged still owes that put. Nothing about `-mode`
  touches this.
* **The module-load leg does not reach the release.** Under embedded the boot
  script has already loaded the tree, and a module outside it fails fast rather
  than reaching the code server. That leg is live only where the node really is
  interactive: docker/dev.

So the rule was right and its stated reason was wrong — a worse failure than a
wrong rule, because the reasoning is what the next reader reuses.

### The one about to go stale: don't restate `busy_timeout`

The paragraph pinned the window as *"`busy_timeout` (`30_000` in every env
today)"*. A slice in flight moves it to ~300 ms in prod and dev, keeping 30_000
only in `:test`, so "in every env today" stops being true.

**Deliberately NOT corrected by writing the new number in.** The two changes can
land in either order, and a file asserting a value that has not merged yet is
the same defect mirrored. The form chosen instead: **name the SSOT and drop the
value** (`config/runtime.exs`, per-env), and supply the field scale from a
**dated measurement that cannot go stale** — the 29 holds logged 2026-09-08 ran
31.1–94.1 s. A knob moves; a dated observation does not. This is the shape to
reuse whenever `CLAUDE.md` needs to convey a magnitude that lives in config.

_Docs-only. No code, no wire change, no protocol bump. Deploy: **nothing** —
`CLAUDE.md` is instruction, not runtime._
<!-- entry #2001-w2-defaults -->

---

## 2026-09-08 — #2001 (w2 slice): the contention ladder, chosen as a ladder

**Provenance.** vjt asked for "default sani per gli altri utenti" and then
"cambia i timeout, e se possiamo aumentare o render tunabili gli io thread
aumentiamoli su prod" — the first relayed by the ircbot, the second reaching
the orchestrator directly in session. The motive is his and it is explicit:
someone installing the `.deb` must not inherit numbers born in CI.

### The fact that opened it

`config/runtime.exs` said, in its own comment, that production's
`busy_timeout` of `30_000` *"mirrors `config/test.exs`"*. Production was
running the test suite's number, and the file admitted it.

Pulling that thread produced the real finding: the four numbers governing a
contended write are not four defaults, they are a **ladder**, and each rung is
supposed to hand the fault to the rung above it. Measured, three of the four
had never been chosen at all:

| rung | was | chosen? | now |
|---|---|---|---|
| `busy_timeout` | 30 000 | yes — for `:test` | **300** |
| `busy_retry.budget_ms` | 1 500 | yes (#336's ~1s window) | 1 500, unchanged |
| `queue_target` / `queue_interval` | 50 / 2 000 | **no** — DBConnection defaults | **1 500 / 5 000** |
| `:timeout` | 15 000 | **no** — Ecto's default | 15 000, now **pinned** |
| `pool_size` | 10 | yes | **5** |

Read top to bottom it was inverted at every rung, and two of the consequences
were already written down in our own source as defects:

* **The retry engine could not take a second attempt.**
  `Grappa.Repo.BusyRetry`'s moduledoc said so (#1421): at `30_000` against a
  `1_500` budget *"the loop makes EXACTLY ONE attempt and the linear backoff
  below never runs."* We had built a retry ladder and set a timeout that
  guaranteed it never climbed.
* **`queue_target: 50` decided message loss.** `ConnectionPool.drop/2` is what
  raises the `ConnectionError` that `Session.Persistor` reports as a dropped
  scrollback row — and delivery is downstream of the insert, so a dropped row
  is a message never delivered either. The threshold that governs that was a
  library default nobody had looked at.

The cure for the first is deliberately taken from the other side of #1421's
pricing: **not by growing the budget, but by shrinking the wait the budget has
to cover.** The caller-visible bound therefore does not move (~1.5s), and the
engine becomes reachable for the first time. `BusyRetryBudgetReachTest` already
measured both regimes against a real held write lock; production now runs in
the arm that test proves works, rather than in a predicted one.

### The invariant that is not a number: `pool_size` < dirty-IO floor

The question vjt's brief forced was whether the pool should be tied to CPU
cores or to the dirty-IO scheduler count. **Neither.**

Cores have no claim: measured, ERTS does not derive `+SDio` from them — a
6-CPU prod node reports 10, and the same node booted `+S 16:16` still reports
10, so the default is FIXED at 10 and not `max(S, 10)`. (`dirty_cpu` does track
the schedulers, which is the control that makes the reading mean something.)

Tying it to dirty-IO is worse than it sounds, because **that is what we already
had, by accident**: `pool_size 10 == dirty_io 10`. Every exqlite entry point is
`ERL_NIF_DIRTY_JOB_IO_BOUND` — reads included — so a writer parked on the file
lock occupies one of the ten for the whole hold, and at parity the Repo alone
can occupy all of them. #1715 already documents what queues behind that
occupancy. An equality is the degenerate case of a coupling, not a design.

So the shape is a **relation with a reserve**, and the elegant part is that the
thing to stay under is itself hardware-independent: 10 is the floor on every
substrate we ship (ERTS gives 10; the Docker entrypoint gives `max(nproc, 10)`).
A constant below it is correct on a 1-core VPS and a 64-core box alike, with no
`nproc` call. `5` is half.

Because it is a relation and not a number, it is **checked at boot** rather
than commented: `Grappa.Repo.check_dirty_io_reserve/2` compares the two and
warns naming both. That is not decoration — `GRAPPA_DIRTY_SCHEDULERS` applies
its floor of 10 only when UNSET, so an operator who sets it explicitly (which
`bin/start.sh`'s own comment encourages, calling 10 "wasteful on a 4-core
host") can invert the relation silently. It warns rather than raises: the
reserve being gone is the posture production shipped, so raising would refuse
to boot the deployments this exists to inform.

### The dirty-IO threads: tunable yes, raised by default NO

vjt asked to raise them on prod. **We are declining the raise and keeping the
tunability**, and the argument is a measurement rather than a preference.

Sampled read-only on the live prod node, `run_queue_lengths_all` over 400
samples at 50ms: the dirty-IO run queue was non-empty in **1 sample out of
400**, maximum depth **1**. At steady state the ten threads are nowhere near
the constraint. What makes them scarce is a holder parked inside the NIF —
three consecutive holders were observed nailing 3/10 during one episode — so
`+SDio` is **insurance against head-of-line during a stall, not throughput**.
And `pool_size 10 → 5` lowers that same pressure on its own, from the cheap
side: a smaller pool costs nothing, while each extra dirty-IO scheduler is an
OS thread with its own allocator carriers on machines that may have two cores.

⚠️ Limit of that measurement, stated rather than glossed: it was taken **at
steady state on a healthy node**. Occupancy DURING a stall remains unmeasured.

Tunability turned out to already exist and to be undocumented: `ERL_ZFLAGS` is
honoured by erlexec on every release substrate, the jail's rc.d exports every
`^[A-Z_]` name in its env file, and systemd loads the same file via
`EnvironmentFile`. So the deliverable was documentation, not machinery — and
that also resolved the separate lie in the same files, which advertised
`GRAPPA_MAX_USERS` / `GRAPPA_DIRTY_SCHEDULERS` as knobs on two substrates where
nothing reads them (they are read only by the two CONTAINER entrypoints). The
knobs' absence there is deliberate and documented in `docs/OPERATIONS.md`; the
advertisement was not.

### 🔴 What this is NOT

**It is not a cure for the 31s stalls, and no part of it should be read as
one.** `busy_timeout` governs who WAITS; the stalls are a single holder's
POSSESSION (`LockWatch`'s `held_ms` is taken from inside the transaction fun,
so it measures possession, not queueing). Shortening the wait bounds the blast
radius and surfaces the failure sooner; it does not shorten one hold by a
millisecond. #1420's mechanism remains unestablished, five candidates are dead
there, and this entry adds no sixth.

### What is NOT measured, and should set these numbers one day

The **healthy write-lock hold-time distribution**. It is what should fix
`busy_timeout`, and neither instrument we own can produce it: `LockWatch`
reports only holds above its 2 000ms stall threshold, so it sees the tail and
never the body, and Ecto's per-query telemetry is completion-driven and
therefore measures the victim rather than the holder. `300` is consequently
argued from ABOVE (a fraction of the retry budget, so the loop gets four to
five attempts) and open from BELOW. A slow bulk write — an archive purge, a
`NickMigration` sweep — is the case to watch. Likewise unmeasured: the healthy
checkout-delay distribution behind `queue_target`, and read fan-out at any pool
size (`config/dev.exs`'s #1759c comment already said so, and the former claim
in `runtime.exs` that "lower than 10 starves cic's fan-out" carried no
measurement either — it has been retired rather than reworded).

### #340 is honoured, not sidestepped

A timeout change moves when an insert lands, so it owes the #340 answer. It
**narrows** the exposure: the dominant term today is one attempt bounded by
`busy_timeout` = 30 000ms, and it becomes a ~1 500ms budget — a 20× smaller
window against a `Visitors.Reaper` that sweeps every 60s. Structurally, every
retry is synchronous in the caller's own process, so nothing is deferred,
spooled or handed off, and the caller's stack holds the FK parent's liveness
across the whole window. #340 rejected deferral; there is none here.

_Deploy: **COLD** — `config/runtime.exs` is read at boot, and the release lib
directory is unchanged only for hot-reloadable modules. `BEGIN IMMEDIATE`
(#524) is untouched and out of scope._
<!-- entry #2004 -->

---

## 2026-09-08 — 2004: the client-source sample stops taking the writer lock to write nothing

`Grappa.Vhosts.record_client_source/2` fires on every client connect and puts
one key — the subject's last-known client `/64` — into the shared
`user_settings.data` blob. It did so unconditionally. Between two reconnects of
the same client that key is normally IDENTICAL, so the write transaction opened,
took SQLite's single-writer `RESERVED`, and committed a change nobody made. In
w1's review of the 2026-09-08 stall episodes, **21 of 29** trace to this call.

### The guard belongs OUTSIDE the transaction, and that placement is the fix

`UserSettings.put_last_client_prefix64/2` routes through the one write path,
`update_data/2` = `Repo.BusyRetry.run(fn -> Repo.immediate_transaction(fun) end)`.
So `BEGIN IMMEDIATE` takes the lock **before** anything can know the value is
unchanged. Asking "has it changed?" inside the transaction would shorten the
hold; asking it outside removes the transaction outright on reconnect churn.
`UserSettings.get_last_client_prefix64/1` already existed, so the comparison
cost nothing to buy.

**Measured, and it is more than the issue claimed.** The issue and its follow-up
comment describe a SELECT and a COMMIT around an UPDATE Ecto declines to emit.
The query telemetry captured in `Grappa.VhostsClientSourceWriteTest` shows the
unchanged path emitting, verbatim, a bare `begin` and then

```
INSERT INTO "user_settings" (…) ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO NOTHING RETURNING "id"
```

— the row init inside `get_or_init!/1`. The UPDATE is indeed absent, but a WRITE
statement runs regardless: the lock was not merely taken for a no-op, it was
taken and then written through. The correction strengthens the case rather than
weakening it, which is why it is recorded here instead of quietly dropped.

### Why the guard sits in `Vhosts` and not in the setter

`UserSettings.get_last_client_prefix64/1`'s own doc calls the key **"a dumb
string store"** and delegates interpretation to `Vhosts`. A skip-if-unchanged
rule is a policy about a SAMPLE — "this reading is best-effort and redundant
between reconnects" — and that policy belongs to the domain that owns the
sample. Putting it in the setter would also have created a per-key exception
inside a module whose other setters have none, which is the half-migrated shape
CLAUDE.md warns propagates itself.

The `#1375` one-write-path invariant is untouched: when the value DOES change,
the write still goes through `update_data/2`, still holding read and write in
one transaction. `Grappa.UserSettingsConcurrencyTest` calls the setter directly
and so still exercises it.

### 🔴 The recursion trap, worth naming because the issue's wording invites it

The guard must read `UserSettings.get_last_client_prefix64/1` — **never**
`Vhosts.last_client_prefix64/1`. The latter falls back to
`last_known_client_key/1` (#647), which calls straight back into
`record_client_source/2`: a guard spelled with it recurses without end. The
issue says only "`get_last_client_prefix64/1` already exists", and the two
modules' functions are one word apart.

### It skips the WRITE, never the VALUE

The guard fires only when the store ALREADY holds exactly what the call would
have written, so mode 2 (#543) reads the same key either way and no session is
newly HELD with `:no_client_source`. The three callers enumerated in
`GrappaWeb.UserSocket.detach_client_source_capture/2` are safe by that same
token: the detached WS capture is the churn this targets; `Visitors.Login`
(#645) needs the sample PERSISTED before it spawns the anchor session, and a
skip means it already is; `last_known_client_key/1` (#647) runs only when
nothing is stored, so it never skips and pays one extra SELECT on a path walked
once per subject. A value stored in another spelling compares unequal and is
rewritten — the guard self-heals rather than pinning bad data.

### 🔴 Not a cure for the stall, and the beneficiary has moved

This removes THIS possession of the lock. **Why a holder sits in `RESERVED` for
tens of seconds is still unmeasured**, inside the NIF (#1687); the OS-level
route (`procstat -kk` on the dirty thread at the next stall) has not been taken.
Do not read the guard as a diagnosis.

⚠️ vjt has decided **Postgres for this instance; SQLite stays for
self-hosters.** That does not invalidate the work — it moves who benefits, and
the priority with it. Judging this against prod would be the wrong yardstick.

### What the test can and cannot prove

The tests assert on the write STATEMENTS, because the captured frame is a bare
`begin` with no `IMMEDIATE` in it: they cannot tell
`Repo.immediate_transaction/1` apart from a plain `Repo.transaction/1`, and
`Grappa.UserSettingsConcurrencyTest` already measured that the distinction is
invisible under the Sandbox. A green proves the writer lock is never REACHED —
nothing about how the acquisition is spelled. Two of the five cases guard the
other direction (the value stays readable after a skip; a genuinely roamed
prefix still writes), because a guard that skipped the VALUE would break mode 2
silently.

_Code + docs. No wire change, no protocol bump. Deploy: hot — one context
module, no supervision-tree or schema change._
<!-- entry #2011 -->

---

## 2026-09-09 — #2011: the marker is the FIRST appended line, and the four-line window could not see the blank that says otherwise

`scripts/design-notes-gate.sh` keeps four lines of history above every added
entry heading and asserts the canonical shape — blank / `---` / blank / marker.
A blank line ahead of the marker pushes it to the fifth line, outside the
window, so the four lines the gate inspects still spell exactly the canonical
shape and it answers green. Found while validating the gate BY MUTATION: of
three mutants, a removed separator and a removed marker both came back `rc=1`,
and the stray blank did not.

A COVERAGE gap, then, not a broken check — which is why the cure is a fifth
line of history plus one more arm, and not a new regex on the four that were
already being read.

### Why a stray blank is not a style nit

The marker defeats `merge=union` by making the FIRST appended line DIFFER
between two branches, leaving the driver no identical prefix to align as a
common addition. A blank ahead of it hands that prefix straight back, and a
blank is the most collidable line there is: it is what every entry in the
legacy separator-first shape opens with — most of this file's history — and
what every other blank-led entry opens with too.

Measured on the scratch repo the bats suite builds, one row per configuration
of the other side. Every row reports `rc=0` with zero deletions:

| this branch | the other side | lines lost |
|---|---|---|
| canonical | canonical | 0 |
| blank-led | canonical | 0 |
| canonical | legacy, no marker | 0 |
| **blank-led** | **legacy, no marker** | **1** |
| **blank-led** | **blank-led** | **1** |

Rows 3 and 4 are the whole finding. The same pair that #1271's
incremental-adoption case proves is SAFE for a canonical entry loses a line the
moment that entry is blank-led — so the blank is precisely what disarms the
protection the marker exists to give. One line, not three; `CLAUDE.md` already
said as much in prose, and nothing asserted it.

And the line the driver eats IS that blank, so what it leaves behind reads
canonical with nothing left to find. The window is therefore BEFORE the rebase
and cannot be moved after it — the same posture #1428 arrived at, by a
different road. The new oracle case asserts that post-rebase green on purpose,
so that nobody later tidies the check into a position where it is blind.

### The cure, and a guard nobody would have tested

`p5`, a fifth line of history, and a third arm reported as its own finding with
its own message. The other two are untouched: a stray blank means the separator
IS present and the marker IS present, and reporting either of those would send
an author editing a correct line.

The arm is guarded on `FNR > 5`. awk history variables start unset and read as
blank, so an entry whose marker is line 1 of a file would otherwise be reported
for a blank nobody wrote. Measured: with that guard deleted the suite stayed
16/16 — live code no test defended, the same class of hole being cured here —
so it now carries its own case, and deleting the guard turns that one case red
and nothing else. The cure itself is validated the same way in the other
direction: removed, only the blank case goes red.

### The debt this leaves standing, named rather than ticketed

Three entries already on main carry a blank ahead of their marker: `#1261`
(line 16494), `#201` (16717) and `#1883c` (45652). `git blame` puts the blank
and the marker in the SAME commit for all three, so the blank was added by the
entry's own branch — not one of them is a previous entry's trailing line. Out
of 326 markers in the corpus that is 0.92 %. The four archive files
(`docs/design_notes/2026-0[4-7].md`) carry 0 markers at all: they predate the
convention.

They stay, on three grounds. The damage happened at their own rebase and
removing the blank now does not undo it. A dated entry in this file is HISTORY,
and rewriting one destroys the evidence that the shape ever existed. And the
gate is diff-scoped: it judges only what a branch ADDS, and those three have
been in the base for weeks. No separate issue either — a ticket for three blank
lines nobody sees is a mechanism heavier than the problem.

Measured, so that "nobody goes red today" is a fact and not an argument:
against `origin/main~20` the gate judges 10 real entries at `rc=0`, against
`~50` it judges 19 at `rc=0`, and the first blank finding appears only at
`~100` — three of them by `~800`. ⚠️ The red at those depths is NOT this cure's.
The UNFIXED script answers `rc=1` at the same depths, on SEPARATOR, and that
was established by running both scripts side by side against the same bases,
not inferred from an exit code that happened to match.

### Stated limit

The check reads the resulting FILE, not the diff. A blank belonging to the
PREVIOUS entry's tail would therefore be charged to the new author, even though
a blank already sitting in the base collides with nothing and costs no line.
Across all 326 markers there are three findings and all three are same-commit:
zero false positives observed, and no reachable case constructed. Should one
ever turn up, the honest cure is to read the lines the branch ADDS rather than
the file — a larger change than this gap justified today.
<!-- entry #2017 -->

---

## 2026-09-09 — #2017: the archive row that was deleted and recreated

`ux-2-mobile-archive:54` failed three times reading "the deleted archive row
does not disappear". It disappears. It is deleted and then RECREATED, and the
recreating write is the spec's own PART coming back from upstream. Recorded
because the symptom points at the wrong layer and cost three sightings before
anyone read the timestamps.

### The mechanism

Server log and Playwright trace of run 34285217206, both failing attempts,
agreeing to the millisecond: the archive DELETE commits (`204 in 4ms`,
`DELETE FROM "messages" ... "#spec-w0"`), and 7 ms later the session process —
logged with no `request_id`, so not an HTTP call — inserts a `:part` row for
that channel. The archive is derived from scrollback, so the entry returns
carrying exactly that row's `server_time` as its new `last_activity`. The
re-fetch 7 ms later reads it back.

The echo is late because the connection spent its penalty budget on connect
plus autojoin: the PART send logs `headroom_s=-1.155`, and PART-sent to
echo-ingested measured **1.002 s** and **1.003 s** across the two attempts,
while the spec reaches its delete tap at ~989 ms. The margin was **13 ms** and
**8 ms** — a deterministic mechanism with a photo-finish outcome, which is why
it wore the costume of a flake.

### Why the timeout was never the knob

Nothing removes the new row until the `afterEach` JOIN five seconds later, so
a larger budget buys a slower red — the assertion had already polled nine
times and seen `1` every time. Every DB operation in the window is
sub-millisecond to low-single-digit (`db=0.1ms`…`2.6ms`, `queue=0.1ms`): there
is no lock wait here and nothing a storage-side timeout could reach. The one
delay that decides the test is IRC fake-lag, on the far side of the socket
from SQLite.

### The cure, and its shape

`awaitPartEcho` is the PART-side twin of the lesson `listChannelNames` already
carried for JOIN (#793): the request only ASKS. It delegates to
`assertMessagePersisted` with `kind: "part"`, which `m9-cicchetto-part-x-click`
already used — the verb existed; what did not exist was a name for using it as
a SETUP BARRIER rather than as a claim. That distinction is the whole reason
for the wrapper, and it is why m9's direct call was left alone.

Applied to all three specs that DELETE archive state (`ux-1-archive-delete`,
`ux-2-mobile-archive`, `ux-z-cluster-journey`), not only the one that went red:
identical shape, and the two journey specs additionally assert the scrollback
is empty afterwards, which the same stray row breaks. **The direction matters
and is the reason the blast radius stops there:** specs asserting the entry is
PRESENT need no barrier, because a late echo can only recreate an entry, never
remove one.

### Proved by mutation, both directions

A three-arm throwaway probe on the real stack, contract deliberately mixed so
that three greens would indict the probe rather than bless the cure. Arm A (no
barrier, delete driven over the API so it lands ~8 ms after the PART instead of
the UI's ~990 ms) FAILED as required, on `not.toContain` with
`archive after echo = ["#spec-w0"]`. Arm B (with barrier) passed, the archive
still empty 2 s later. Arm C (barrier on a nick that never parted) FAILED on
the 5 s ceiling — without it, a barrier matching anything would also be green.

**Arm B's number is the evidence the barrier observes rather than sleeps:** it
reported 2016 ms at a 100 ms poll granularity, i.e. the fake-lag as it actually
was on that stack — twice the 1.002 s measured in CI. A disguised sleep prints
its own constant on every substrate.

Driving arm A's delete over the API rather than the UI is what made the red
reproducible: at 13 ms of margin the UI path is a coin toss, and a negative
control you cannot summon is not a control.

### Left open, deliberately

Whether the server SHOULD let an in-flight echo repopulate a just-emptied
archive entry is a product question, escalated rather than answered here. The
barrier holds under either ruling — it waits for an event that happens in both
worlds. Worth carrying forward: on a real network that window is WIDER than the
1 s measured on the testnet, not narrower, so the same race is reachable by a
user who parts, opens archive, and deletes.

_Test-only. No wire change, no protocol bump, no production code touched.
Deploy: nothing to deploy._
<!-- entry #2014 -->

---

## 2026-09-09 — #2014: the flip was never the bug, the preferred side was

On iOS the long-press message menu opened **down-and-right of the touch
point**, so the hand that opened it covered it. vjt measured it on an iPhone
with cicchetto installed as a PWA, against staging `1.5.3-def8cb2ac`. The ask:
the menu's **bottom-right corner sits on the press point**, so it opens
up-and-left, out from under the thumb.

### One defect, not two, and the code says so

The issue lists two things as **not measured** — whether the placement is also
wrong with the keyboard UP, and whether it changes near the viewport EDGES —
and warns that an anchor bug and a viewport-collision flip look identical from
one screenshot. Both were answerable by reading `lib/menuPosition.ts`, and the
answers are what made the cure small.

**Keyboard up:** `ContextMenu` feeds `computeMenuPosition` the VISUAL viewport,
which does shrink with the keyboard. But the fit arm returns `click` whether or
not the keyboard is up; what the keyboard moves is the FLIP THRESHOLD, not the
anchor. One defect, at one door.

**Edges:** near the far edge `placeAxis` already FLIPS, and a flip puts the
box's far edge on the press point — which is the geometry being asked for. In
the bottom-right corner the menu already rendered exactly as vjt wants it.
**So the flip is not the defect: it is the discriminant the issue was asking
for.** What was wrong was only which side we PREFER. That is why this is one
parameter on the existing primitive — `placeAxis(click, size, start, end,
prefer)` — and not a second placement mechanism beside the first.

`prefer` is REQUIRED, with no default. A default picks an anchor on behalf of a
caller that never thought about one, which is the shape of the bug being fixed.

### The one branch that must not mirror

Three of the four branches mirror cleanly. The fourth does not: a menu bigger
than its interval still pins to `start` under BOTH preferences, because the
fallback it hands off to is the CSS `max-height` + `overflow-y: auto` pair, and
that box grows DOWN from `top` / RIGHT from `left`. Mirrored to `end - size` it
would put the menu's HEAD above `start` — behind the status bar on a notched
iPhone, with the overflow scroll unable to bring it back, which is the #913
defect re-entered at this door. Derived from the fallback's growth direction,
not measured on a device; what a device would add is how bad it looks, not
whether it happens. Commented where it lives, because "make the mirror
symmetric" is a tidy-up somebody will attempt.

A second, smaller asymmetry sits in the guards: the `before` arm needs a
`Math.max(click, start)` on its FLIP where the `after` arm carries the
equivalent on its FIT. A press can land inside the leading inset, and each
preference meets that press in a different arm. The asymmetry is in which arm
needs the guard, not in the policy.

### The gate is the POINTER, not the door

`(pointer: coarse)`, read once in `ContextMenu` — the module that already owns
placement — via a new `isCoarsePointer()` in `lib/platform.ts`. The precedent
is #1869's, verbatim: `default.css` moved the whole selection/callout policy
off `html.is-ios` onto exactly this query because it *"keys on the actual
pointing device rather than a UA sniff"*. A second, disagreeing notion of "is
this touch" is the drift that issue is a record of.

The rejected alternative was deciding per EVENT at each door, which sounds
more precise and is not: the message menu has TWO doors reaching one opener
(`bindMessageGestures`'s hold and `bindMessageContextMenu`'s `contextmenu`,
both landing on `openMenuForRow`), so a per-event anchor lets them disagree
about the same press, last writer winning. Accepted cost, identical in kind to
the one #1869 already took: `pointer` describes the PRIMARY pointer, so a
hybrid whose primary is touch gives its occasional mouse the touch anchor.

**Scope is vjt's ruling** (`#grappa`, 2026-09-09 00:24Z, relayed): *"tutta la
shell"* — every menu on the shared shell, so no host passes an anchor and none
can drift. The nick menu and the admin verb menu inherit it. On a fine pointer
NOTHING moves: the desktop right-click keeps the native down-and-right.

### The premise that said this could not be tested

The issue states the e2e suite cannot host the gesture, citing
`webkit-iphone-15`'s `tap()`. **False, and both halves of the refutation were
already in the repo:** `issue1067-swipe-reply-message-menu.spec.ts` has
synthesized a real touchstart → wall-clock hold → touchend since #1067, and its
own header records that `hasTouch: true` puts Chromium's primary pointer at
COARSE. The citation is about a different engine and a different verb.

So `issue2014-context-menu-touch-anchor.spec.ts` runs three tests: the reported
path (coarse, long-press, message row), and a PAIR that isolates the gate —
same door, same surface, one variable changed, the pointer. The pair is what
keeps "maybe the DOOR decides" from standing, and it doubles as the scope proof,
since the nick menu passes no anchor of its own and can only have got its
answer from the shell.

Every test asserts an anti-hollow precondition first: that at the chosen point
the menu would have fitted on BOTH sides of both axes. Without it a collision
flip satisfies the corner assertion by itself and the spec goes green against a
reverted fix — the very confusion the issue names.

**Declared limit.** Chromium is not iOS, and every engine in the suite reports
`env(safe-area-inset-*)` as `{0,0,0,0}`, so nothing in that file exercises the
notch or the home indicator; the inset arithmetic is unit work
(`menuPosition.test.ts` carries the iPhone 15 numbers) and the FELT result stays
vjt's on-device dogfood.

### An inference left standing, and how to kill it

Not chased in this slice, and not a second mechanism: since #1869 a scrollback
row computes `user-select: none` standing on a coarse pointer, and Blink fires
`contextmenu` on a long-press over non-selectable content. If that holds, an
Android long-press already opens the menu TWICE today — invisibly, because both
doors pass the same point. It is an INFERENCE: no browser launches on the
machine this was written on, and it was never reproduced.

**What would falsify it, in thirty seconds on any Android:** open the console,
`addEventListener('contextmenu', e => console.log('ctx', e.clientX, e.clientY),
true)` on `document`, then long-press a message row. No line logged ⇒ the
inference is dead and the doors never race. A line logged ⇒ it is real, and
worth its own issue. The pointer-keyed gate above makes it harmless either way:
both doors read the same pointer and cannot disagree.
<!-- entry #2018 -->

---

## 2026-09-09 — #2018: the release-image gate boots both published arches, and names the red it cannot explain

On the `v1.5.4` release commit (`b68373237`) the job `deploy + probe the release
image (amd64)` died at the first BEAM invocation — `sys_sigaltstack(): Internal
error: Failed to set alternate signal stack`, exit 139 — before any migration
line. A rerun of the SAME commit and the SAME image on a different runner
instance came back green in 71 s (run `34293606005`, attempt 2); the failing
attempt had died ~2 s into the step. **Same bytes, opposite verdict.** The
mechanism is still unmeasured and this entry does not claim otherwise.

### What was refused, and why it is the larger half of the decision

The issue asked to "make the probe run somewhere it can actually boot the image
(or make the sandbox difference explicit and asserted)". Both branches were
declined.

There is no second substrate: production is the FreeBSD jail and it has no
docker at all (`grep -rln 'docker|ghcr' infra/freebsd/` → nothing), a
self-hosted runner would be a third production substrate, and self-hosters are
field evidence rather than a gate — nobody fires them and nobody reads their
verdict. The `uname -m` of the two who answered CTCP VERSION was asked for and
never arrived, so even "the image boots on real hosts" is true of an unknown
architecture.

Asserting the sandbox difference is worse than useless: nobody has measured what
that difference IS, so the assertion would encode a guess and would stay green
in exactly the case where the guess is wrong. "`sigaltstack` smells of seccomp"
is a smell, not a measurement, and the issue's own "Not measured" section says
so.

And the premise moved underneath the request. The rerun shows the failure is
**not deterministic across runner instances**, and a different PLACE does not
cure non-determinism — it relocates it.

### What shipped instead

**Both published architectures are now BOOTED.** The docker job publishes
`linux/amd64,linux/arm64`; the smoke job ran on `ubuntu-latest` alone and said
so out loud ("amd64 only: the arm64 leg is proven by the build"). Measured, and
it is why that posture fell: **every job in every workflow in this repository
was `ubuntu-latest`** (12 of 12, across `ci.yml`, `integration.yml`,
`release.yml`), so no arm64 binary had ever been EXECUTED here by anything.
`assert-abi-lockstep.sh` does gate arm64 at build time, per-platform — but it
proves the runtime stage can LINK the release, not that the VM STARTS. For an
arm64 puller the first process ever to run the image was a user's, on every
release that has ever shipped. That is structural, not intermittent.
`ubuntu-24.04-arm` is free on a public repository, so the cure is a matrix and
nothing else; the driver is untouched, because `docker pull` resolves the
multi-arch manifest for whatever host it lands on, candidate and upgrade fixture
alike.

`fail-fast: false` is load-bearing rather than a softening: without it an amd64
failure CANCELS the arm64 leg, and that cancelled leg is precisely the reading
worth having. Two independent runner substrates probing one artefact is the only
cross-check this gate has ever had against a failure belonging to the machine —
"amd64 red while arm64 is green on the same run" is a sentence nobody could
write before.

**The runner's facts are captured on EVERY run, green included.** This is the
part that is easy to get backwards. What the v1.5.4 incident lacks is not only
the red sample — it is the GREEN one. An `ImageOS`, a `_SC_MINSIGSTKSZ`, a set
of XSAVE feature flags cannot be read as anomalous by anyone who has never seen
what they look like on a run where the image boots. Facts only on failure
produce a sample of one class and nothing to hold it against, so the capture is
unconditional and the failure branch adds only the NAME. Every reader is
best-effort and prints `unavailable` rather than exiting: the block that
describes the run must never be able to fail it.

**A failure carrying the ERTS-startup signature is NAMED, not forgiven.** The
run stays red — no retry, no `continue-on-error`, no downgrade. What is added is
the distinction that cost a night: a VM that never started and an image that is
genuinely broken used to arrive identically, as "the job is red". The pattern
matches the MESSAGE the VM printed, deliberately, rather than a cause: a match
on seccomp or on a CPU feature would be the encoded guess refused above.

**Release-only is now stated as deliberate.** The subject of this gate is the
PUBLISHED image, and before the tag there is none — release-only is arithmetic,
not a cadence anyone chose. What main can rot is the RECIPE, and the recipe is
already held by gates that need no container: `base_image_digest_pin_test.bats`
(#103), `toolchain_pin_test.bats` (#1408 D-S10), the build-time ABI floor, and
the ~50 suites in `test/infra/`.

A `schedule:` for the `docker_validation` dry-run was considered and refused
(vjt's ruling): a cron red has no owner, nobody is on duty at the hour it fires,
and a signal nobody reads is indistinguishable from a signal that is not there.
There is no `schedule:` anywhere in this repository and that is a decision. For
the same reason the dry-run keeps ONE leg: an arm64 leg there would mean a
second gha cache for a path nothing fires automatically.

### A claim withdrawn before it was published, recorded so nobody re-derives it

The first draft of the issue comment carried a second finding: that
`Dockerfile.release` leaves `elixir:1.19-otp-28-alpine` and `alpine:3.24` on
floating tags, so the published image is not a pure function of the source tree.
The observation is literally true and the framing was wrong, which is worse.
Both are excluded **by name** from the #103 digest-pin gate with the argument
written there: the Elixir tag "carries the pin" and is held to `.tool-versions`
on the minor line and the OTP major by `toolchain_pin_test.bats`, while the
alpine floor is left floating on purpose so security patches keep flowing, with
`assert-abi-lockstep.sh` proving compatibility instead of freezing bytes. It is
a decision with two gates over it, not a gap. The lesson is the ordinary one:
the gate that would contradict a finding is usually already in `test/`, and
reading it costs less than publishing the finding.

The version that SURVIVES the contradiction is narrower, and it took measuring
the two gates rather than accepting that they cover the ground. They cover a
different axis each, and neither is drift-over-time.
`assert-abi-lockstep.sh` takes its eight arguments from ONE build — the `b_*`
values out of `/tmp/abi-manifest`, written by that build's build stage
(`Dockerfile.release:108-119`), the `r_*` values live from the same build's
runtime stage (`:172-180`) — touches no network, and names no earlier build. It
is a same-build coherence gate, so two stages moving TOGETHER to a newer alpine
patch keep it green by construction, which is the intended behaviour rather than
a hole. `toolchain_pin_test.bats` touches no network either; it reads files, and
holds `.tool-versions` (`elixir 1.19.5-otp-28`, `erlang 28.5`) against the
Dockerfile tag to minor-line and OTP-major precision, with its own moduledoc
calling the Elixir PATCH floating underneath "real and deliberate".

So neither gate reads the bytes that were pulled and neither compares two builds
made at different times — nor should they. The consequence is what belongs to
#2018: **if a drifted base ever produces an image that does not start, the only
thing in this repository that finds out is the release-image smoke job.** It is
not one check among several on the published container; it is the sole
consequence-detector for a recipe the project has deliberately chosen to let
move. That is why a blind spot in it costs more than its size suggests, and it
is an argument FOR this gate rather than for pinning anything — a digest on
`alpine:3.24` is argued in `base_image_digest_pin_test.bats` as the wrong move,
because it would freeze security patches.

### 🔴 What this does NOT cure — say it before someone reads a cure into it

**The non-determinism is untouched and its mechanism remains unknown.** This
gate produced red and then green on byte-identical input, which means it can lie
in BOTH directions, and the direction that hurts is the false GREEN: the absence
of the failure is not by itself evidence that the image boots. What shipped here
cures the CECITY (an arm64 half nobody had ever executed) and the LEGIBILITY (a
red nobody could classify). Neither of those is the flip.

The honest expectation is narrower and worth writing down: the next occurrence
arrives with the runner's facts attached and a comparison class to hold them
against, which is the measurement nobody has been able to make so far. That is
an instrument, not a diagnosis.

A BEAM preflight — the cheapest possible VM start, run first, to attribute
before six minutes of deploy — was designed and then dropped from this slice.
It could not be exercised anywhere available (the honest proof is a
`docker_validation` dispatch, and the local substrate is macOS/arm64 while the
phenomenon is linux/amd64), and an untested new invocation in the release path
is a new way for every release to go red in exchange for attribution the
classifier already delivers a few minutes later. It is worth doing once
something can run it.

_CI + driver + docs. No wire change, no protocol bump, no supervision-tree or
schema change. Deploy: nothing to deploy — the change is in `release.yml` and
the smoke driver, both of which run only in CI._
<!-- entry #2022 -->

---

## 2026-09-09 — #2022: the jail name is one constant, and a gate holds the other fifty-five spellings to it

`scripts/deploy-m42.sh` defaulted `JAIL` to `grappa`, and
`infra/freebsd/deploy.sh` built its restart hint on the same name. The jail's
bastille NAME is `grappa-new`; `grappa` is its `host.hostname`. Measured on
m42 from two sources (`jls -h jid name host.hostname path` and
`bastille list`), and confirmed in practice: the v1.5.4 cold deploy went
through as `JAIL=grappa-new scripts/deploy-m42.sh --force-cold`.

The sharp edge is not the default. It is
`DEPLOY_RESTART_HINT="sudo bastille cmd grappa service grappa start"`, printed
by `deploy_common.sh` on the "daemon is GONE" path — the line an operator
pastes while production is down. A default that is merely wrong is cheap; one
that is wrong in the recovery path fails exactly when it is needed.

### Derivation was rejected, and not for effort

The issue suggested deriving the name from `bastille list` / `jls`, on the
grounds that this is the second name the jail has had. Three reasons against,
all about WHERE the name is needed:

1. **It is not derivable where it matters most.** `infra/freebsd/deploy.sh`
   runs INSIDE the jail. Every `bastille` spelling under `infra/freebsd/` is a
   comment quoting the HOST-side invocation — not one of those rails invokes
   bastille, because bastille is the host's tool for addressing jails from
   outside. From inside, `hostname` answers `grappa`: the host.hostname, i.e.
   precisely the wrong token, and precisely the confusion that produced the bug.
2. **Host-side it only moves the hardcode.** Picking this jail out of
   `bastille list` needs a predicate, and the candidates are the NAME
   (circular) or the host.hostname `grappa` — reading the Hostname column is
   the misreading that opened the issue.
3. **Its failure mode is the one being cured.** A derivation that answers
   nothing must die or fall back, and a fallback IS a default that can be
   silently wrong. Worse, the hint printed when production is down would then
   depend on a query likeliest to fail exactly then.

So: `infra/lib/bastille_jail.sh` declares `BASTILLE_JAIL`, overridable by env,
and the two files that COMPUTE with the name source it — the host wrapper for
`JAIL`, the in-jail deploy for both hints and the `--defer-restart` log line.
That is the issue's "same source" requirement, satisfied where a variable can
reach.

### The measurement the issue declared not done

A systematic sweep for jail-name ARGUMENT positions (`bastille <verb> X`,
`bastille-restart X`, `jexec X`, `pkg -j X`, `/usr/local/bastille/jails/X`)
found **59 stale spellings across 20 files** on `origin/main`, not the two the
issue named: every usage comment of the twelve `infra/freebsd` rails, three
printed hints in `jail_import_db.sh` (including a
`/usr/local/bastille/jails/grappa/root` copy target, which is a real path that
does not exist), four Elixir moduledocs, `scripts/zfs_baseline.exs`, three
assertions in `deploy_m42_test.bats` that pinned the wrong default, and 22
lines of `docs/OPERATIONS.md` runbook — among them the DB-restore sequence
and, with some irony, the paragraph that says "Reference the jail by NAME, not
a numeric JID". Afterwards the same scan sees 55 literal spellings and zero
disagreements; the difference is accounted for site by site (six became
variables, three previously-invisible ones became visible once the wrapped
prose and a false-positive comment were rewritten).

Those are comments. They cannot source a variable, so what holds them is
`test/infra/bastille_jail_name_test.bats`: it reads `BASTILLE_JAIL` and proves
every literal spelling in the live tree equals it, naming file, line and token
for each that does not. The next rename is one line plus whatever the gate
then lists.

### What the gate does not see, stated rather than implied

It is line-based, so a name that prose wrapped onto the following line is
invisible to it (two such existed, in `docs/OPERATIONS.md` and
`LoopbackOnly`'s moduledoc — both rewrapped by hand here). It only reads
ARGUMENT position, so a name stated in prose is invisible too
(`(name \`grappa\`, …)` in the runbook — fixed by hand). A token spelled as a
variable or placeholder never matches, which is what lets the sourcing sites
pass. Bare numbers are skipped: a JID is a different addressing mode, and the
runbook quotes `jexec 6` on purpose as the form that DRIFTS — demanding a name
there would delete the warning.

Chronological records are out of scope by construction: `DESIGN_NOTES.md`,
`docs/design_notes/`, `docs/project-story.md`, `docs/reviews/` and the dated
baselines quote what was true when written. A log rewritten to stay current is
not a log.

### Not verified, and it cannot be from here

Nobody on this side of the fence can run `bastille cmd`. What is proven is
that the scripts now emit `grappa-new` where they emitted `grappa`, that the
two consumers read one constant, and that no spelling in the tree disagrees
with it. That the resulting command works against the live jail rests on the
issue's m42 measurement and on the v1.5.4 deploy that already ran with this
exact value — not on anything exercised in CI.

_Deploy scripts, infra comments and docs. No wire change, no protocol bump, no
supervision-tree or schema change. Deploy: the changed files are the deploy
machinery itself — the value they now carry is the one tonight's deploy was
already run with by hand._
<!-- entry #2022b -->

---

## 2026-09-09 — #2022b: adding a second `source` to a deploy script breaks a fixture that names its libs by hand

#2022 gave `infra/freebsd/deploy.sh` a second sourced lib. Main went red
immediately: 35 `not ok`, all in `test/infra/deploy_jail_test.bats`, each
failing at its FIRST assertion.

That fixture builds a throwaway repo and copies in, **by name**, the libs the
script sources. It had one such line. With the second lib absent, `set -eu`
kills the script at the source — `deploy.sh: line 46: …/lib/bastille_jail.sh:
No such file or directory`, rc=1 — before a single assertion runs.

Two things are worth keeping, and neither is "remember to copy the file".

**The fixture is a hand-maintained mirror of a source list, and nothing
derives one from the other.** Six fixtures across docker, linux and the jail
follow the same one-`cp`-per-lib shape; it is consistent, and it is a mirror
that will drift again the next time a deploy script gains a source line. The
cure here follows the convention rather than inventing a second one — but a
reader adding a `.` to any deploy script should know the fixture is the other
half of that edit.

**bats reports the symptom thirty-five times and the cause zero times.** The
CI log carries 35 assertion failures and not one line of the script's stderr;
`No such file or directory` appears nowhere in it. The failure is legible only
by running the suite, or by running the script from a sandbox by hand — which
is how the mechanism here was established rather than guessed, together with
the control that proves it: with the lib present the script runs past line 46
into `git pull`, i.e. fails somewhere else entirely. That control is what ruled
out the rival reading, that `SCRIPT_DIR` was resolving to the wrong place.

Process note, recorded because the cost was real: `scripts/check.sh` already
runs `scripts/bats.sh`. The red did not escape a gap in the gates — it escaped
because the gate was not run before pushing.

_Test fixture only. No wire change, no protocol bump, no supervision-tree or
schema change. Deploy: nothing — the change is in a bats fixture._
<!-- entry #2024 -->

---

## 2026-09-09 — #2024: the probe that handed a stranger a tab, and the fourth arm nobody counted

An inbound CTCP query MINTED the sender's query window. A DM-targeted query
resolved its routing key to `state.nick`, which made `build_persist/6` set
`dm_with = sender` (`Scrollback.dm_peer/4` returns the sender when the target
IS us), and `Session.Server.maybe_open_query_window/2` keys on
`dm_with || channel`. So anyone who asked the bouncer for a VERSION string
left a tab open with somebody the operator had never talked to. **What the
receiver paid was not a wire line, it was a window** — the asymmetry the #546
door exists to remove for NOTICE.

**The ruling, and its provenance.** vjt on `#grappa`, 08:45 Europe/Rome,
verbatim `<< network`, answering "does an inbound CTCP query in a DM go to the
network window (the #546 door), or does it keep minting the peer's query
window?". Recorded on issue 2024 as comment `5597364131`. I did not see it —
reading IRC is closed to me; it reached me relayed and I verified it against
the issue before building. The issue deliberately carried no `status:` label
until the ruling landed, because flipping this reverses a contract that a test
was written to pin.

### The cure is ONE call, and it calls the existing door

`ctcp_query_channel/3` replaces four inline copies of the same three lines. It
calls `open_query_or_server/2` — the #546 door itself — rather than restating
"open query → that query, else `$server`". A second copy of the rule would be
a boundary violation and not a cure: the two would drift, and the reason this
arm was broken at all is that the rule lived in one branch while the traffic
arrived on another.

The CHANNEL-targeted branch is untouched, and is the negative control in the
tests: a channel CTCP keeps the channel key, takes no `dm_with`, and minted
nothing before or after. It is exercised on BOTH sides of the open-window
predicate, because the door must not reach that branch at all — if it did, an
open query with a peer would drag a channel row into her window.

### 🔴 FOUR arms, not three — the issue's own enumeration was short

The issue measured three (`VERSION`, `USERINFO`, `AVATAR`). `ctcp_ping_reply/4`
is a fourth, computing the identical key with the identical consequence, and it
is included. Two reasons, and the second is the load-bearing one. Curing three
of four identical sites would leave one inline copy of the rule beside the
shared helper — the half-migration that makes the next reader copy whichever
pattern is closer. And the tree ALREADY holds "CTCP is protocol, not
conversation" for PING on the *reply* direction: `route_non_channel_notice/3`'s
CTCP short-circuit names a PING round trip in its own comment. Curing the query
direction is the symmetric half of a rule the codebase had already accepted.

The fourth arm surfaced from the RED run, not from reading: exactly four
existing assertions flipped to `left: "vjt"`, one per arm.

### Three doors now, and the split is not the one the names suggest

`open_query_or_server/2` used to document "two doors, deliberately asymmetric"
— NOTICE for every nick sender, PRIVMSG for services only. There are three now,
and the axis is **conversation vs control surface**, not NOTICE vs PRIVMSG:

* NOTICE — every nick sender. Announcement, not conversation.
* CTCP QUERY — every nick sender. A probe is a control surface, and it arrives
  as a PRIVMSG, which is exactly why it walked past the door for so long.
* PRIVMSG — services senders ONLY. A peer's ordinary DM still opens the
  conversation; it is the one arm of the three that still mints.

### The issue's "not measured", measured

Whether a peer's `USERINFO` probe and its `AVATAR` sibling minted ONE window or
TWO: **one**. All four arms computed the same key from the same inputs, so
`dm_with` was the same nick and `QueryWindows.open/4` is keyed on it. Evidence
is the pre-cure assertion set — four arms, four `channel == "vjt"`, one key.
Post-cure the count is zero, asserted end-to-end by inspecting the whole
`list_for_subject/1` map rather than a per-nick boolean, so the failure message
carries the count the question was about.

### What is NOT claimed

* **The e2e is written but NOT YET RUN.** It needs the exclusive stack lane,
  which is the orchestrator's to allocate; the result is reported separately
  and this entry does not pre-date it green.

  🔎 It nearly was not written at all. The draft of this very bullet read "no
  e2e — the harness drives cic against a fixture API rather than a peer on a
  real ircd". **Measured, that premise is false**: the stack runs a real
  grappa against the testnet ircd, `IrcPeer.connect` gives a real peer, and a
  CTCP query is a PRIVMSG whose body is delimiter-wrapped, so the ordinary
  send verb carries it and no shared-fixture seam was needed. A declaration
  of "cannot be covered" is a measurement like any other, and this one would
  have been wrong — the lesson is worth more than the spec.

  It exists because the unit and integration layers prove the routing key and
  the absent `query_windows` row, and neither proves the thing reported: a
  TAB. The sidebar is projected from `windowStateByChannel` off the user
  topic, so "no row in the table" and "no tab on the screen" are two claims
  with a whole client between them.
* **That the cic arm is now dead.** `subscribe.ts`'s own-nick NOTICE branch
  documented the CTCP-query visibility row as the last thing still reaching it
  after #546. It no longer does. Its comment is corrected; the arm is NOT
  removed, because its full input set was not enumerated and deleting a
  renderer arm whose inputs you have not measured is how a class goes silent.
* **Anything about the sender side.** The fan-out (`maybe_query_peer_profile/2`
  on JOIN + 353) is rate limited per SENDER (`{subject, network_id}`), which
  bounds one session's outbound and says nothing about the aggregate one
  receiver takes from N sessions. That is a different slice and was not
  redesigned here. The `LucentW` Excess Flood kill on Libera is ONE sighting,
  unreproduced and untied to this path; it is not a cause and was not built on.
* **Whether USERINFO/AVATAR replies should be surfaced at all.** A product call
  nobody has made. Each still mints a visibility row; the ruling does not touch
  it.

_Test-only + routing. No wire change, no protocol bump, no migration.
Deploy: ordinary._
<!-- entry #1956 -->

---

## 2026-09-09 — issue 1956: the long-press menu that vanishes with the keyboard down — what the source CAN decide, and what it cannot

Reported three times on iOS, most recently against **production `1.5.4-c911f7cc`**
(the sha this work branched from, so the code read here IS the code that
misbehaves). The discriminator has been stable across all three: with a compose
field focused there is no problem; with the keyboard down, a finger held STILL
makes the menu dismiss itself, while a movement that produces vertical scroll
leaves it up. #2014's anchoring cure is already live and is not this.

### What the source decides

**The class of focus-dependent branches is CLOSED, and it has one member.**
Enumerating every `document.activeElement` / `isTextEntry` read in `cicchetto/src`
gives six production sites; five are off this path (`Shell.tsx` tab-complete,
`AdminDebugTab` display, `globalPaste`, `mediaViewer`, and `messageMenu.ts`'s
`selectMessageText`, which only runs once the menu is already open). The sixth,
`keepKeyboard.ts:182`, is the only one the long-press gesture can reach. So the
issue's "candidate to check first" is not a starting point — it is the only
door, by enumeration.

**The menu has exactly three pointer/key doors and one lifecycle door**:
`.context-menu-backdrop`'s `onClick`, an item's `onClick`, `createOverlayEscape`,
and `ScrollbackPane`'s `onCleanup`. `ContextMenu` binds no touch or pointer
listener of its own, so every pointer-driven close is a `click`.

### What the source REFUTES

The natural reading — *keepKeyboard's `preventDefault` suppresses the synthesized
click with the keyboard up, and with it down the click closes the menu* — **is
false**, and the shipped code is what falsifies it. `preventDefault` on a
mousedown cancels the focus shift and the selection-drag start; it does not
cancel the click. If it did, every chrome control in the app would be dead to a
tap while the compose box holds focus, because that same always-fire
`preventDefault` covers them all. UX-3 has shipped since 2026-06-11 and they
work; `keepKeyboard`'s own moduledoc states it outright ("The click still fires
… the tapped element's onClick still runs").

So the focus discriminator's mechanism is **not determinable from the source**.
Two candidates survive:

* **A** — the real shield, `messageGestures.onEnd`'s `if (e.cancelable)
  e.preventDefault()`, is a silent no-op because WebKit hands out a
  non-cancelable touchend. `preventDefault` on one throws nothing and leaves
  `defaultPrevented` false, so the shield reads applied while doing nothing.
* **B** — the shield holds and the close arrives through another door (with
  #2014 the menu's bottom-right corner sits ON the press point, so an item is a
  pixel from the synthesized click).

**Open tension, deliberately unresolved.** `keepKeyboard.ts:188-191` asserts that
"on real iOS a long-press synthesizes NO mousedown at all". If true, candidate A
is impossible by construction. That assertion is reasoning, not a measurement —
the comment uses it to justify a branch it calls a cross-platform net. It is
used here in neither direction. **If the diag below prints `cancelable=false`
with the keyboard down, that comment is falsified and must be corrected in the
same round**: a module comment is a claim about the present.

### What ships, and why both halves

**The diag** names the two facts nothing off-device can supply: the `cancelable`
of the release after a hold, and WHICH door closed the menu. Gated on
`isDiagEnabled()` like `keepKeyboard:200-205`; a no-op with the flag off.

**The cure** is focus-INDEPENDENT, which is the point: it is correct under A and
under B, so it does not wait on a measurement it cannot take. *The menu refuses
any pointer activation until it has seen a press that BEGAN after it opened.*
Causal, not timed — the opening gesture's `pointerdown` fired before the
component existed, so the menu is born disarmed and the click synthesized from
that same gesture finds no arm, while every genuine interaction starts with a
fresh one.

🔴 **It must arm on `pointerdown`, never on `mousedown`.** The synthesized
mousedown PRECEDES the click inside the same release: arming there would arm
exactly the click this refuses — a no-op that reads as applied. Escape stays
outside the guard; a way out that is always available must not require a prior
press.

It lives in the shared shell rather than in the long-press binder because the
defect is not "the scrollback's gesture leaks" but "a menu can be actioned by
the gesture that opened it", which is true of every door the shell has — the
#1115 desktop door and the nick and admin menus included. vjt ruled the scope,
including the vitest churn (relayed, not seen first-hand).

### The guard would have blinded the diagnosis, so it logs its own refusal

Once the cure is in, a menu that correctly stays put is **silent**, and silence
cannot separate "the click arrived and was refused" from "no click ever
arrived" — which is precisely the pair the on-device round has to settle. The
refusal therefore emits its own line. Without it the cure would have closed the
defect while destroying the instrument that says WHICH candidate it closed, and
whether a third remains.

### Cost measured, not estimated

`fireEvent.click` dispatches a bare `click`, which no browser produces, so the
guard reddened **4** test files and 21 tests — not the 5 files predicted;
`RailContext` is a different component and has zero `fireEvent.click`. They are
updated to press first (`helpers/pointerEvents.pressAndClick`), which makes the
simulation faithful rather than compliant, and the refusal keeps its own direct
coverage. Verified by mutation: neutering the guard reds exactly the three
refusal tests and nothing else.

_Client-only. No wire change, no protocol bump, no migration. The verification
that matters is vjt's, on device, with the flag on._
<!-- entry #2029 -->

---

## 2026-09-09 — #2029: stripping mIRC formatting on render, and a gate that stayed silent twice

`morph` (Azzurra staff) asked for a setting that renders messages with the
mIRC control codes REMOVED, after a channel filled up with heavily coloured
bot output. The neighbour to rule out first is channel mode `+c`, and it is a
different thing on both axes: it is an operator's channel-wide policy rather
than a per-viewer preference, and it REJECTS the message, so the reader loses
the words along with the colours. This strips on RENDER — the words still
arrive, they just arrive plain. Default OFF.

### The issue said "client-side"; the codebase said otherwise, and the codebase won

The issue's Scope section opens *"Setting lives client-side in cicchetto, per
user, persisted with the other display preferences"*. The last five words are
the ones that decide it, and they point at `display_prefs` — which has been
SERVER-backed since #449 (`GET/PUT /me/settings/display-prefs`,
`UserSettings.default_display_prefs/0` the authority). So the sentence is
self-contradicting: persisting it *with the other display preferences* is
exactly what makes it not client-side. Issue text is DATA about a defect, not
an instruction about the fix.

That does not settle it by itself, because a local-only class genuinely
exists: `fontSize.ts` is localStorage with a stated reason (*"cic owns mobile
UX; no server-side persistence, no wire bleed"*). The criterion for choosing
between them was already fixed by #1766 and is not re-litigated here: a
per-DEVICE toggle is right when the complaint is about a **viewport** (#914's
`hide_next_active`, a fixed overlay on a phone), and wrong when it is about
the **account**. A channel full of coloured bot output is identical on the
phone and on the desktop. Reinforcing rather than deciding: the pref's nearest
neighbour BY SHAPE — `colored_nicklist`, a boolean colour-rendering toggle —
sits in the same settings fieldset and is synced, and two adjacent checkboxes
that persist differently is a promise the interface should not break.

### 🔴 The pin did not force the bump, and this is the SECOND carrier to prove it

`Grappa.Protocol.version/0` moves 14 → 15, under #1393d: `display_prefs` is a
client-facing REST payload and its shape changed, which is enough on its own.
`@min_protocol_version` stays at 1, and cic's `MIN_SERVER_PROTOCOL_VERSION`
stays at 9 — the key is absent-tolerant in BOTH directions
(`fetch_optional_display_bool/3` server-side, `?? DEFAULT_DISPLAY_PREFS`
client-side), so a bundle carrying it degrades against an older server instead
of breaking.

#1766 recorded that `mix grappa.wire_pin --check` *"did not force this and
could not"*. That was its measurement of its own case; this is a fresh one, on
this branch, and it agrees:

* with `strip_formatting` ALREADY added to `Grappa.UserSettings` and the
  version still reading **14**, the gate answered
  `priv/wire/shape.pin: wire shape and protocol 14 agree.` at **rc=0**;
* `--update` after the bump rewrote **one line**, `protocol_version 14 → 15`.
  The digest is byte-identical before and after:
  `sha256:f3c18a4c920e1bbf97d9fa7af80d1970fb3bbe47ef6e062d7f6f92817b4bf3c0`.

One occurrence is an anecdote about `UserSettingsJSON`; two independent keys
entering through the same hand-written `*_json.ex` and both passing green make
it a property of the DETECTOR — the digest spans the codegen artefacts, whose
sources are `lib/grappa/**/*wire.ex` plus a hand-kept list of web envelopes,
and no hand-written JSON view is on it (the same silence #1679 hit with
`BootJSON`). Consequence to carry forward rather than rediscover: **for a
payload rendered by a hand-written `*_json.ex`, the bump is a manual act and
CI will not catch its absence.** Widening the digest's coverage is a change
the pin deliberately cannot tell apart from a shape change, so it is not
smuggled in here either.

**Which gate DID hold, and it is not the one you would name.** The bump has a
second half — cic's `CLIENT_PROTOCOL_VERSION` (socket.ts), what the bundle
SPEAKS — and this branch shipped the server half without it. #1973's
`protocol_test.exs` is what went red: *"cicchetto declares
CLIENT_PROTOCOL_VERSION = 14 while the server speaks 15"*. So on a payload the
codegen does not cover, that pin is the ONLY automatic guard on the pair, and
it was carrying the whole change alone. Worth knowing in the order the failure
arrives: `wire_pin` is silent, `protocol_test` is not. (cic's OTHER constant,
`MIN_SERVER_PROTOCOL_VERSION`, correctly stays at 9 — it says what cic
REQUIRES, and the new key is absent-tolerant.)

### One chokepoint, twelve surfaces, and why the issue's list was not used

The issue enumerates *"channel and query panes, notices, quit/part reasons,
informational output"* and cites #142/#175. The set was derived from the code
instead, and it is bigger: **39 `<MircBody>` call sites across 12 files**, of
which **nine are surfaces the issue never names** (WhoisCard, WhowasCard,
WhoModal, DirectoryPane topics, LinksModal, ServiceModal, ServerReplyModal,
ServerInfoCard, RegistrationWizardModal).

None of them were touched. `parseMircFormat` has exactly **one** production
render caller — `MircText.tsx`'s `MircBody` — and `MIRC_PALETTE` has **zero**
consumers outside `mircFormat.ts`, so colour resolution cannot leave the
parser. One line at that chokepoint reaches every surface, including the nine.
That is also the answer to *"if a surface renders colour, it must honour the
strip"*: honoured by construction, not by a list that would rot the next time
a card learns to render a body.

### `mircPlainRuns`, and why it is not a second stripper

`mircPlainText` (#142) already existed and already strips — for STRING
surfaces (a `title` attribute), and it is the client twin of #1908's
match-side strip. It could not be reused verbatim: a string cannot carry the
run boundaries the renderer needs. `mircPlainRuns` is its render-side sibling
— same input, same one parser, run structure kept, attributes cleared. The
control bytes are still removed by `parseMircFormat` and nowhere else; what is
new is only the projection. A fresh scanner over `\x03`/`\x02` here would have
been the second implementation of the rule, and that is the thing forbidden.

**The runs are deliberately NOT merged.** Merging them would repair a URL that
a colour code splits mid-link (linkify runs per-run) — a real improvement, and
a behaviour change with nothing to do with removing colours. It does not ride
in on this issue's back; if it is worth having it is worth its own issue.

### Two smaller things that would have rotted

`mircPlainText`'s comment said *"This is NOT a render strip (the visible body
always routes through `MircBody`)"*. #2029 makes that false, so it is
rewritten in the same commit rather than left to mislead a future reader into
thinking no render strip exists.

The display fieldset's blurb read *"The first two follow your account onto
every device you use"*. A third synced row makes it wrong, and nothing
type-checks a sentence — so it is rephrased by BEHAVIOUR (*"Only the jump
button is remembered on this device alone — the rest follow your account"*),
which the next added row cannot falsify.

### Open, and shipped anyway

Two product questions were put to vjt and are unanswered at merge: whether the
strip should also apply to one's OWN outgoing messages, and whether OFF is the
right default. What shipped: the strip acts at the chokepoint, which makes the
first a "yes, everything visible" at no cost, and the default is OFF as the
issue specifies. Both are small, localised changes if the answers differ.

_Not asserted: that the pref reaches every surface has been measured through
the chokepoint (one parse caller, zero palette consumers elsewhere), not by
exercising all twelve in a browser. The e2e covers one channel-pane line._
<!-- entry #2032 -->

---

## 2026-09-10 — issue 2032: a visibility-return is a resume, and #535's divider half is reversed

Reported: tapping a link that leaves the app and coming back moves the reader
off the position they were reading at. Desktop and mobile, long-standing.
Modals are unaffected — they never hide the document, so the pane holds
position through `overlay-freeze`, a different writer.

**Two writers moved the reader, not one, and the second is the one that makes
the obvious fix wrong.**

1. **The divider JUMP.** `scrollToActivation` read the `unread-marker` node for
   `"marker-or-preserve"` — the scrolled-up arm of visibility-return — in the
   SAME query as the deliberate-switch mode, and `scrollIntoView`d it. So the
   mode preserved only when NO divider rendered. With one present it moved the
   reader, which is the opposite of its name.
2. **The divider RE-LATCH.** The visibility arm re-pointed `markerCursorId` at
   the live read cursor. When that MOVES the cursor it recomputes `rows()`, and
   every row is a fresh object literal under a `<For>` keyed by reference, so
   the whole DOM list is recreated and **scrollTop collapses to 0**.

Writer 2 is masked by writer 1: the jump lands somewhere immediately after the
reset, so nobody sees the zero. **Remove the jump alone and the reader is
dropped at the TOP of the buffer — strictly worse than the reported bug.** The
cure removes both. `"marker-or-preserve"` is renamed `"preserve-only"`, which
is now the truth rather than an aspiration.

**This REVERSES the second half of #535 (2026-07-30), deliberately.** That entry
recorded vjt's ruling verbatim — *"non dobbiamo sminchiare lo scroll, come regola
generale. l'unico caso in cui scrolliamo to bottom è quando si scrive un
messaggio nella finestra attiva"* — and then glossed it as "everything else
preserves the reader's position **or lands on the unread divider**". vjt's words
constrain scroll-to-BOTTOM only; the divider clause was the entry's own
extension, and it is what authorised putting a resume mode into the divider
query. #535's reasoning for why that was harmless: the hide-edge cursor write
parks the cursor at the reader's own row, so the re-latched divider IS their
position. **That holds only while the write lands.** `setCursorIfAdvances` is
forward-only (#233), so a reader parked ABOVE the live cursor leaves it
untouched and the divider sits somewhere else entirely. The invariant that
survives is #168's (2026-07-03): only a DELIBERATE window change lands on the
divider.

**The freeze contract loses "option (b)".** `markerCursorId` no longer
re-latches on visibility-return. It still re-latches on a deliberate switch, on
cold-mount and on an own send — all genuine focus acquisitions. A resume is not
one, and the divider a reader was reading against must not move under them.

**The comment at the divider query asserted the opposite of the code** — *"the
channel-SWITCH trigger jumps to the RENDERED frozen unread divider when one
exists; every other trigger (cold-mount, visibility-return, resize) lands at the
tail"*. Both clauses were false: cold-mount became a marker activation in #168's
own 2026-07-03b completion, and visibility-return's scrolled-up arm was in the
query. Fixed in the same commit as the cure, per the standing rule.

**`"preserve-only"` still declares the `marker-activation` intent kind**, and
that is deliberate. The kind is a PRECEDENCE CLASS, not a description of the
write: it must outrank `tail-follow` (rank 4) or a concurrent tail-follow snaps
the resuming reader to the tail, which is the #535 defect returning.
`prepend-preserve`, the only other preserve-shaped kind, sits BELOW `tail-follow`
and would reinstate it. Minting a new kind means widening the union and the
PRECEDENCE array shared by the whole applier — a separate change with its own
blast radius.

**Tests that pinned the old behaviour were rewritten, not deleted.**
`issue535-visibility-return-preserve-scroll.spec.ts`'s second case asserted
"return lands ON the divider" — it pinned this defect, and was green by
construction over the entire divider-present half of the space. Three unit cases
in `ScrollbackPane.test.tsx` pinned the re-latch, one of them named "(option
b)". The #168 display-only case kept its property and swapped its trigger from a
visibility-return to an own send, since a resume can no longer remove a divider.
New coverage: `issue2032-visibility-return-preserve-position.spec.ts`, whose
discriminating case has the reader read DOWNWARD past the frozen divider so the
input-gated scroll-settle advances the live cursor — giving the re-latch
somewhere new to point, which is what separates writer 2 from writer 1.

_Client-only. No wire change, no protocol bump, no migration._

_Not asserted: the reported direction. The report says "backwards"; every path
this analysis can construct from the code yanks the reader FORWARD by roughly a
viewport, or to scrollTop 0 when the divider is absent on return. The backward
variant was not reproduced, and the cure does not depend on it — the contract
asserted is preservation, which is direction-agnostic and covers all three._
<!-- entry #2031 -->

---

## 2026-09-10 — #2031: a send stops one padding short of the tail, and the obvious cure was a regression

Reported from an iPhone: send while the `── N unread messages ──` divider is on
screen and the just-sent line comes out clipped at the bottom of the scrollback.
The issue's own guess named the `SCROLL_BOTTOM_THRESHOLD_PX` slack — 50px of
declared "close enough to the tail", which is wider than a message row, so a
pane every assertion in the codebase calls "at the tail" can hold a whole row
below the fold.

That guess is right about the mechanism it enables and wrong about the distance.
Measured over nine runs on the untouched tree, the terminal state has exactly
two values: `distanceFromBottom = 7` with the row overflowing the pane's bottom
edge by +0.203px (`webkit-iphone-15`, 3/3 — deterministic on the reported
platform) or +0.359px (chromium, 2/3), against `distanceFromBottom = 0` and
−6.640px on the one healthy chromium run. The pane does not stop somewhere
inside 50px of slack. It stops SEVEN pixels short, and seven is the scroller's
own `padding-bottom` (`.scrollback { padding: 0.5rem 1rem }`).

`scrollIntoView({ block: "end" })` aligns the tail ROW's bottom box with the
scrollport's bottom EDGE. The scroller's padding sits below that row inside the
scrollable extent, so it is simply never scrolled: the row lands flush against
the edge with no breathing room and a fraction of a pixel cut. Nothing repairs
it afterwards, because 7 ≤ 50 makes every "am I at the tail" reader answer yes —
the #625 fail-safe included, which then skips its write for exactly the reason
#625 taught it to.

So the divider is not what leaves the pane short. Its collapse is the follow-on
rows change that produces the poll whose correction gets suppressed; the
shortfall itself is the padding blind spot, and it is there on every send. The
divider is what makes it visible.

### Two cures were refused, and a third refusal is the entry

Lowering `SCROLL_BOTTOM_THRESHOLD_PX` is not available: that number is the
definition of "at the tail" for the whole product — the scroll-to-bottom button,
the `followMode` re-arm, the read-cursor advance, the badge suppression in
`readingAtTail.ts`. Four unrelated behaviours moved to repair one scroll write.

Changing the #625 fail-safe's PREDICATE — comparing against the tail row's box
instead of the fixed slack — treats the symptom. The fail-safe did not misjudge
anything; it was asked to patch a write that should have been correct.

The third is the one worth recording, because it was the obvious move and it
would have been a REGRESSION. The write's two branches read as interchangeable:

```
if (tail?.scrollIntoView) { tail.scrollIntoView({ block: "end" }); }
else { listRef.scrollTop = listRef.scrollHeight; }
```

and the `else` branch reaches the real tail, so swapping them is a one-line fix
that measures correct on this issue. The branches are not alternatives. UX-8(a3)
chose the native walk over the `scrollHeight` math from a measured incident: the
browser scrolls the container from the element's real box, which stays
layout-aware while `scrollHeight` bookkeeping is mid-update — the channel-back
path, where a cached window's store reload races the key-effect even after
rAF×2. The setter has no such property, and it does not walk scrollable
ANCESTORS either. The `else` branch is the fallback for having no element (and,
incidentally, the jsdom path, where `Element.prototype.scrollIntoView` does not
exist).

Trading the walk for the setter therefore trades a measured 7px clip for the
re-opening of a measured page-scale defect, on a path this issue's spec does not
cover. So the write is COMPLETED rather than replaced:

```
const tail = list.lastElementChild as HTMLElement | null;
tail?.scrollIntoView?.({ block: "end" });
const max = list.scrollHeight - list.clientHeight;
if (max > list.scrollTop) list.scrollTop = max;
```

The maximum is spelled `scrollHeight - clientHeight` rather than left to the
browser clamping `scrollTop = scrollHeight` — the same call #1121 made two
screens down for `restoreTo`, for the reason written there: *a number that has
to be clamped before it is true cannot be measured against*. The shape of this
cure was already reasoned out elsewhere in the same file; the pre-existing
`else` branch is the part that leans on clamping.

The top-up only ever scrolls DOWN, and that guard is the walk's insurance rather
than defensive habit. A stale `scrollHeight` is the precise condition step 1
exists to survive, so writing a stale maximum over a good walk would undo it;
`max <= scrollTop` means the read cannot be trusted (or the pane is already
there) and the walk stands. Down-only also keeps `followMode` out of it — the
pane leaves the tail only when `scrollTop` DECREASES (#168).

### Three sites, and "verbatim" was measured rather than eyeballed

The same five lines appear three times: `scrollToActivation`'s no-marker branch,
`tailFollowWhenSettled`, and `dispatchScrollWrite`'s operator-tail. All three
target `lastElementChild` of the same `.scrollback` node with the same padding
and all three mean "put the pane at the tail". Only the middle one was measured
defective; the other two are cured BY CONSTRUCTION, and that phrase is worth
something only if "verbatim" is a measurement.

It is: stripping leading indentation and nothing else, the three write cores
share one md5 and the three `const tail` bindings share another. Controls in
both directions — an independent block from the same file (the marker write,
`block: "start"`) differs; a one-byte mutant (`"end"` → `"enD"`) differs; and
the normaliser is shown not to have gutted the content (five lines, tokens
intact), because three empty files would also share an md5. The raw blocks are
NOT identical — two sit at ten spaces of indentation and one at eight — so the
identity is post-normalisation and is stated that way.

The set is CLOSED, which is what "all three" actually rests on: `block: "end"`
occurs exactly three times in non-test `cicchetto/src`, and
`scrollTop = …scrollHeight` at those three `else` branches plus two comments.
There is no fourth site left behind.

### The spec that photographed the defect and called it green

The first draft of `issue2031-send-with-marker-row-clipped.spec.ts` carried a
1px "sub-pixel" tolerance and passed. That thread swallowed the defect whole:
the clipped state overflows by +0.203px, so the spec measured exactly what it
was written to catch and reported ok. The tolerance is ZERO, and zero is safe
here precisely because it is not a knife edge — the two states are ~7px apart
(−6.64 against +0.20) with no sub-pixel path between them.

Two hypotheses were falsified on the way, recorded so the dead ends are not
walked twice. The soft keyboard is not involved: a third case with
`visualViewport` shrunk to 300px the way issue253 stubs it produced numbers
identical to its keyboard-less twin to the third decimal. The CSS layout
mechanism `themes/default.css` records for iOS WebKit ("last messages hide
behind BottomBar", UX-6 bucket D v2) is excluded: `composeTop` equals
`paneBottom` exactly on both engines, so nothing is painted under the compose.
The case and the fixture that served only the dead hypothesis were REMOVED
rather than left green and meaningless; `rowClearance` still reports the field
so the next reader can tell the two failure shapes apart.

### What the runs actually said

RED on the untouched tree, both projects, and the artefact was read rather than
the reason deduced: `Expected: <= 0 / Received: 0.203125` on
`webkit-iphone-15`, `0.359375` on chromium, both at `distanceFromBottom = 7`.
GREEN after the cure: `−6.640625 / d=0` (chromium) and `−6.796875 / d=0`
(webkit) — the terminal state the untouched tree had produced once by itself on
its healthy chromium run. The write probe shows the predicted shape: two writes
in the SAME tick (`scrollIntoView`, then `scrollTop=1415` from `before:1408`),
which is why #625's gap-based `delayedWrites` is unmoved by a second door
opening.

#625 is green on both its cases after the cure — the control that the
double-scroll it killed has not come back, not a bonus. `scroll-on-window-switch`
is green on all four, and its first test is the guard on the UX-8(a3)
channel-back path this cure deliberately does not re-open. That guard's
granularity is worth naming: it asserts `scrollHeight - scrollTop - clientHeight
<= 50` — the very slack this issue accuses — so it can see a page-scale
regression and cannot see seven pixels. Right instrument for that job, blind to
this one. Both it and #625 run on `chromium` only (neither carries `@webkit` or
`@touch`), which is why this issue's spec adds a `@webkit` case rather than
trusting the desktop projection.

The mutant flipped the guard (`max > scrollTop` → `max <`), which disables the
top-up and inverts its direction at once. It killed the two new jsdom guards and
NOTHING else (expected 120 to be 700; expected 700 to be 900 — the second is the
guard dragging a reader 200px back up), and it killed the e2e on both projects
with numbers bit-identical to the pre-cure red. Restore was proven rather than
assumed: mutate → dirty → `git checkout --` → porcelain empty → the eight
scoped e2e green again.

### The jsdom suite is blind to this write, which is why two guards ride in

Under jsdom `scrollHeight` and `clientHeight` both default to 0, so `max` is 0
and the top-up never fires unless a test defines geometry BEFORE the tail write.
The 6922-test suite therefore says nothing about the two new lines — measured,
not assumed: a prediction that the W6 loadMore-preserve block would break was
WRONG, and the reason is exactly this. That block defines its geometry after
`render`, so at mount `max` is 0 and there is nothing to top up; what protects
it is the zero geometry, not the `scrollIntoView` stub its comment credits.

So two guards were added where the coverage was: one pins the top-up (700 from
a 1000/300 pane), one pins the down-only branch (a stale maximum of 700 must
leave a pane at 900 alone). The e2e cannot construct the second one's input —
a stale `scrollHeight` read is a `defineProperty` in jsdom and not reachable
from a real layout — so the guard would otherwise be an untested branch.

_Not asserted: that what the reporter saw has been reproduced. They describe a
line substantially hidden; the measurement here is 0.203px of clip — the same
mechanism at its minimum amplitude, not the same amplitude. What makes those
seven pixels into many more on that device is not known and is not guessed at._

_Not asserted: that the report's second face — "after a moment it shifts by a
few pixels on its own" — is cured, or absent. It did NOT reproduce: all nine
runs recorded exactly one scroll write. The spec asserts it anyway, as the
invariant #625 bought, stated on webkit for the first time; a green there is a
guard, not a reproduction._

_Not asserted: that UX-8(a3) is still true today. It is a measured incident
written into the file by someone else, and it is PRESERVED rather than
re-tested — preserving it does not require re-measuring it, removing it would
have._

_Not asserted: that the two other call sites were measured. They were not. They
are cured by construction from the md5 identity above and carry no e2e of their
own. Only scoped e2e was run here; the full-suite ship gate is CI's._
<!-- entry #2033 -->

---

## 2026-09-10 — #2033: quoting the author a bridge relayed, not the bridge

A bridge bot relays somebody else's words under its OWN IRC nick and wraps the
real author into the body — `<Gazzurbo> <THREADelli> ne parlavamo…`. `msg.sender`
is therefore the RELAY, so both quote doors credited a bot: Reply put
`<Gazzurbo> <THREADelli> body << ` on the wire, arriving three attributions deep
and addressing the author as plain text (notifying nobody), and `!addquote`
archived that misattribution permanently, into a database where the channel
context that would explain it no longer exists.

### What vjt ruled (2026-09-10, relayed into the issue — not observed on IRC)

Detection is the head shape ALONE: no configured relay list, no second gate. The
false positive is priced in. `@name` does produce a real mention because this
bridge relays the Telegram USERNAME, not the display name — which also settles
the charset worry the issue raised, since a username is `[A-Za-z0-9_]` and the
existing RFC 2812 `NICK` admits that in full. `!addquote` is in scope but takes
STRIP ONLY, no `@`: an archive addresses nobody. The cap is measured on the body
after the head comes off.

### The limitation is a dropped speaker, not a stray `@`

Worth restating because the cheap reading understates it. A human writing
`<foo> bar` is read as a relay, and the cure then drops `alice` — the actual
speaker — and answers `@foo`, who does not exist. Accepted knowingly, and pinned
as an assertion in `replyQuote.test.ts` so it is a recorded decision rather than
a bug report somebody files in six months.

### Two decisions the rulings did not cover

**An ACTION is never read as bridged.** #1126 forbids rendering an action as
speech, and detection is SHARED with `!addquote`, which would otherwise archive
`<THREADelli> waves` as something nobody said. No transcript of an action-shaped
relay exists, so this falls back to today's behaviour — the same bounded,
deliberate silence the accepted limitations already carry. The cost is that a
genuinely action-shaped bridge stays unfixed; the alternative was inventing a
shape for a case with no evidence behind it.

**The order of the two peels is FORCED, not a preference.** #1123's
previous-quote cut must run FIRST. A plain reply body (`<bob> original<< answer`)
opens with a nick wrapping too, so looking for a relay first recovers `bob` — who
is being QUOTED, not speaking — and strands the remainder past a cut that no
longer matches. Measured, not argued: swapping the two kills 14 tests, 13 of them
pre-existing #1123 guards. The consequence is a real gap, stated rather than
hidden — a bridge relaying a line that was ITSELF a reply loses its author,
because #1123's greedy cut consumes the relay head on its way to the tail.

### Shape

`attributionHead/1` became `attributionHead/2`, gaining a `RelayedAuthorStyle`
(`"mention" | "wrapped"`). One shared site, one predicate, one parameter — a
fork would let the two doors disagree about what a relay IS, which is the
failure `quotableBody`'s own header warns about. The 100-char cap needed no edit
to satisfy ruling 5: it has always been measured on what `quotableBody` returns,
and that is now the body with the head already gone.

_Not asserted: that `<nick> ` is the only bridged shape in the wild. One
transcript exists, from one bridge, and no survey was made. Verified on chromium
via vitest only — no real bridge, no Telegram, no device._
<!-- entry #2035 -->

---

## 2026-09-10 — #2035: eight lines the box actually has, and an Enter that sets

Two asks from dogfood, and they turned out to be different kinds of thing: one
is a reversed decision, the other is an arithmetic bug that had been sitting in
a comment-free stylesheet since #263.

### Enter sets the topic — a reversal, on a ruling

`TopicBar.tsx` used to carry this, in as many words: *"Enter in the textarea
must stay a newline (save is the ✅ button only), the flatten collapses it on
submit."* That is now false, and the reason it is false is that the product
owner ruled the asserted behaviour wrong. Recording the reason matters more
than recording the change: the decision was not flaky, not awkward to test, and
not inconvenient — it was a product call, and it was reversed by the only
person who can reverse one.

It is worth adding that the premise it rested on was weak. An IRC topic is ONE
wire line; the server rejects a body carrying `\r`/`\n` outright
(`Identifier.safe_line_token?` → `:invalid_line`), and `flattenTopicNewlines`
collapses every newline run to a single space BEFORE the send door. So the line
break Enter bought was worth exactly one space and could never reach the wire
as a break. The decision was defending a cosmetic that the next function call
spent.

**Shift+Enter was left unruled by the issue, and is RULED now**: *"anche
shift-invio setta il topic"* — vjt, 2026-09-10, his words on #grappa relayed in
session rather than read off IRC by the implementer, which is worth stating
because it is the provenance of the whole slice.

The code predates the ruling and did not have to guess, because #974 already
answered the same question one surface over: vjt's 2026-08-07 ruling on
`ComposeBox` — same operator, same device, same one-wire-line domain — reversed
his own day-old split with the measurement that *a Shift+Enter that refuses
also EATS the keystroke*, and that on his device the modifier arms itself on
presses he never meant as Shift+Enter, so the send silently does not happen.
Growing a second semantics for the same chord on a second surface is exactly
the "whatever pattern is closest gets propagated" failure CLAUDE.md warns
about. One chord, one semantics: every Enter sends, modifier or not, on both.

Two guardrails, both held. The new element-level `keydown` handles `Enter` and
returns on everything else — it is **not** a second ESC authority, which #232
made the shared overlay stack's alone, and whose edit-aware branch already has
real-browser coverage in `issue263-topic-modal-edit.spec.ts`. And **the flatten
stays**: Enter no longer types a newline, but a PASTE still carries them in,
which is now the route it exists for.

### Three lines were not a preference — they were `box-sizing`

The issue asked for eight lines and derived `min-height: 10em` from
`4.5em / 1.25 = 3.6 lines`. Both halves of that arithmetic are wrong in the
same way, and the wrongness is measurable rather than arguable.

`* { box-sizing: border-box }` is global in `default.css`, and `html` sets
`font-size: var(--font-size)`, so at the 14px root a `min-height` is a BORDER
box: it swallows the editor's `0.3rem` vertical padding on each side and its
1px borders before the text sees a pixel. The old `4.5em` = 63px therefore left
`63 − 8.4 − 2 = 52.6px` of content over a `1.25 × 14 = 17.5px` line box —
**3.0 lines, not 3.6**. Which is precisely the *"mo è solo tre righe"* that was
reported: the operator counted correctly and the stylesheet's arithmetic did
not. Carried forward unchanged, the `10em` quoted for "8 lines" would have
rendered **7.4**.

The cure is not a bigger number. `rows={8}` on the element is the platform's
own line count: it tracks `font-size` and `line-height` by itself, cannot
disagree with them, and leaves no coupled arithmetic for the next reader to get
wrong — the `min-height` is deleted rather than corrected. `resize: vertical`
stays, so an operator who wants more drags; the only floor a drag now meets is
the global form-control `min-height: var(--tap-min)`, which is the tap-target
one and correct.

### Where each half is proven, and one test that lied

The split is forced by the tooling. jsdom has no layout engine, so vitest pins
the `rows` ATTRIBUTE, the `preventDefault`, the Shift+Enter pairing and the
Esc-guardrail; `e2e/tests/issue2035-topic-editor-height.spec.ts` measures the
rendered box (content height ÷ computed line-height, drift-proof against both
properties moving) and witnesses the real `TOPIC #chan :<flattened>` from an
in-channel peer after a keyboard `Enter`.

🔴 **A Solid element handler cannot be probed with a non-bubbling event.** The
first version of the Esc guardrail dispatched `keydown` with `bubbles: false`,
reasoning that this isolated the element handler from the shared stack. It
passed — and it also passed with an `Escape` branch deliberately smuggled into
the handler, which is how it was caught: Solid DELEGATES `onKeyDown` to the
document root, so a non-bubbling dispatch reaches no handler at all and the
test asserted nothing. The isolation that does work is structural: `keybindings`
(the one global keydown listener) is never installed in that test file, so a
normally-bubbling Escape can only reach the element handler. The mutant dies
now. The general rule is worth more than the fix — **a "the handler ignores X"
test must be shown to fail when the handler stops ignoring X**, because the
event never arriving looks exactly like the event being ignored.

_Not asserted. The phone measurement is against the LAYOUT viewport (iPhone 15
and Pixel 7 descriptors): Playwright raises no soft keyboard, and focusing the
editor on a real phone roughly halves the visual viewport, so "the modal fits
above the fold" is strictly weaker than "the ✅ is reachable while typing".
Neither is the IME case covered: like `ComposeBox` before it, this handler has
no `isComposing` guard, so an Enter that confirms a candidate mid-composition
submits. That is a shared gap of the two surfaces and wants one issue over both,
not a divergence introduced on one of them here._
<!-- entry #1985 -->

---

## 2026-09-09 — #1985: a parked network leaves the sidebar, and the cold load is where the disappearance bites

An operator with two parked networks carries two rows that cannot be acted
upon: every channel under them is unreachable, selecting one bounces to home,
and on mobile they push live channels below the fold. vjt, on `#grappa`:
*"they don't serve any purpose there"*.

### The ruling, and what is NOT a ruling

**Q1 is verbatim.** The issue offered two shapes — hard disappearance vs a
collapsed/on-demand section — and vjt chose the first on 2026-09-07:
*"sparisce se è disconnected (parked)"*. While `connection_state == parked`
the network and every row under it leave the sidebar and come back on
reconnect. Option 2 is dropped; #450 (collapsible network groups) stays a
separate concern. When the cold-load orphan below was put to him on
2026-09-08, the answer was equally flat: *"redirigi a home"*.

**Q2 was flagged as an inference and is now RULED, and the ruling reverses
what this entry first said.** Choosing the redirect looked like it killed the
one door for re-reading a parked window's history — `selection.ts`'s bucket-D
redirect is transition-only precisely so an operator can navigate BACK to a
parked window, and with no row and no restore there is nothing left to
navigate back to. That collateral was recorded here as accepted-but-unspoken.
It is not accepted: on 2026-09-10 vjt answered *"the history is reachable
from the archive"* (relayed in session, not read on IRC by the author of this
entry), and on 09-09 that reading the history of a parked network is deferred
to SEARCH rather than to a dedicated re-entry door. **So nothing is lost and
this paragraph's earlier claim that something was is FALSE.** The archive is
the door, and it is reachable while parked: `ArchiveModal` iterates the RAW
`networks()` store (`:174`), not the sidebar's filtered list, and the archive
launcher renders unconditionally (`RailActions.tsx:525-533`).

**But the door only opened once this slice made it open, and that is the
substance of the fix below.** Naming the archive as the surface turns
`archive.ts`'s subtraction into a load-bearing part of the ruling rather than
a detail: the filter removes what the nav draws, and a parked network's nav
draws nothing. Measured on this branch before the cure — a parked network
whose archive holds an autojoin channel and a kicked pseudo-row rendered
**zero** rows in the modal, both swallowed. Half of that was invisible to the
issue's own reading of the code (see "The hole the ruling exposed").

**`failed` is out of scope and the asymmetry is deliberate.** A failed network
keeps its greyed row IN PLACE: a failure is something the operator must see
and act on. `failing` stays outside both sets for #1675's reason — it is
retrying on its own and has a way back. Three states, three treatments, and a
future generalisation to "any non-connected state" would silently take all
three.

### The cold load is the part the issue did not know about

The live park path was already covered and is not what broke. `selection.ts`'s
bucket-D effect redirects to home when a network the operator is looking at
transitions INTO `parked`, and it is transition-only by design:
`lastConnectionState` starts empty and `prev === undefined` skips the first
observation.

A cold load is exactly the case with no previous value to transition from. So
on a reload nothing walks the selection back, while #35's restore hands the
saved window straight back — and for `kind: "server"` its gate is only "the
network still exists", with `connection_state` deliberately not consulted
(`selection.ts:296-303` spells out why). Before this change that was harmless:
the row sat there greyed and the operator read history. After the
disappearance it is a pane the sidebar draws no row for.

Cured in the restore's EXISTING validity gate rather than by widening bucket
D. Bucket D firing on a non-transition would make every boot re-decide the
selection for every network; the restore gate already asks "is the saved
window still somewhere the operator can be", and this is one more clause in
that same question. The gate is TERMINAL, unlike the provisional `$home` below
it — a non-latching gate would re-attempt on every resource update and pull
focus off home the moment the operator hit `[Reconnect]`, which is a delayed
jump nobody asked for.

### Where the filter goes, and what it takes with it

One filter, at the ONE `<For>` over networks in `Sidebar.tsx`. The header, the
channels, the queries and the synthetic pseudo-rows all render inside that
loop, so dropping the network drops all four by construction. The fourth is
the one that argues for the placement: pseudo-rows project from
`windowStateByChannel`, a store no network-level filter would think to
consult, so a per-branch filter would have left them behind.

`parked` comes OUT of `NETWORK_GREYED_STATES`, which now reads `["failed"]`.
Not tidying — the set answers "which network states grey the section", and
parked can no longer reach that cascade because it no longer renders. Two
statements of one policy is how the next reader picks the wrong one.

The `<Show>` guard around the loop still counts the RAW list. Its fallback
says "no networks", which is true of zero networks bound and false of two
parked ones; with everything parked the sidebar draws the home row and stops.
That is the honest rendering, and it needs no new string.

The predicate is its own module (`lib/networkParked.ts`) rather than a
function in `lib/networks.ts`, for a testing reason that is also a design one.
`networks.ts` is a resource singleton, so every suite that touches it replaces
it wholesale with `vi.mock`; a predicate living there would be mocked
alongside the resources at every call site and could only ever be tested
through a mirror of itself. Extracted, it is measured directly and the Sidebar
and Shell suites run the real rule.

### The hole the ruling exposed, and where the cure goes

`visibleArchiveForNetwork` subtracts three sets — the live channels, the live
queries, and the pseudo-rows — on the premise #402 wrote down: *a nav renders
what it subtracts*. Dropping a whole network from the Sidebar's `<For>` breaks
that premise wholesale, and the archive kept subtracting. Three legs, and only
one of them was predicted:

**Pseudo-rows (predicted).** `navPseudoChannelsForNetwork` returned the
projection unconditionally on desktop, so `pending` / `failed` / `kicked` /
`parked` windows under a parked network were subtracted from the archive while
no sidebar row drew them: one window, ZERO surfaces — #402's bug, one level up.

**Live channels (NOT predicted, and read as safe until it was measured).**
`GET /networks/:slug/channels` returns the union of the credential's AUTOJOIN
list and the live session's channels (`ChannelsController.index` →
`Networks.merge_channel_sources/2`). A parked network has no session, so
`Session.list_channels/2` answers `{:error, :no_session}` → `[]` and the union
is exactly the autojoin list, at `joined: false`. Those rows sit in
`channelsBySlug`, the archive subtracts them, and the sidebar no longer draws
them. The server, meanwhile, PUTS them in the archive precisely because the
session is gone: `ArchiveController`'s `active_keyset` is empty without one —
*"everything with rows qualifies for the archive when no session is live"*.
So the two sides disagreed, and the operator's own autojoin channels were the
casualty. This is the leg that makes the cure worth more than a tidy-up.

**The cure is `navDrawsNetwork(slug)` in `lib/pseudoChannels.ts`**, one level
above `navPseudoChannelsForNetwork`: does the nav of THIS form factor draw ANY
row for this network. Desktop answers `!isNetworkParked(...)`; **mobile answers
YES**, measured rather than assumed — `BottomBar.tsx` iterates the raw
`networks()` store and renders each network's channels and queries with no
state filter (`:138`, `:174`, `:215`), so on a phone those rows are still on
screen and must still be subtracted. The archive consumes the one answer and
returns its entries unfiltered when the nav draws nothing. It does NOT live in
`archive.ts` as a local `isNetworkParked` call: that would be a second
statement of the parked policy plus a copy of the form-factor rule, and
`lib/networkParked.ts` exists to stop the first.

**Queries were the third leg, and they ARE closed — with a server change this
entry first said the slice would not make.** `build_active_keyset/3` composed
the live session channels (empty when parked) with `open_query_targets/2`,
which reads `QueryWindows.list_for_subject/1` — a DB read with no session
gate. So a parked network's DM windows were excluded from the archive response
by the SERVER while the desktop sidebar no longer drew them either: one
window, zero surfaces, and no client-side filter can put back a row the server
never sent.

It was handed up rather than taken, and the call came back to take it, on a
reason worth recording because it is the general rule and not a preference:
**the asymmetry is pre-existing, but this slice is what turns it into a live
hole, so shipping the first two legs without it ships a measured regression.**
It is also not a product decision — it aligns `build_active_keyset/3` with the
promise the module already makes in words (*"everything with rows qualifies
for the archive when no session is live"*), which its channel arm kept and its
query arm did not. Now one `case` over the session lookup answers for both
arms, so there is a single place saying what an absent session means and they
cannot drift apart again.

The pair of tests is the point: without a session an open query window no
longer hides its DM, and WITH a live session it still does. The second is the
control — the fix must not become "the archive never subtracts queries", since
while a session is live that window is one the operator can actually be in.

### The two contract specs, and why a spec may be rewritten

`cp15-b6-parked-disconnect-reconnect` and `issue100-reconnecting-badge`
asserted the PRE-ruling contract: a parked network stays in the sidebar,
greyed and navigable, and the reconnecting badge has that greyed row to appear
on. They were left red for a while precisely because rewriting an assertion to
make a branch pass is how a suite stops being evidence.

**The bar they clear is the only one that licenses it: the product owner ruled
the asserted behaviour wrong.** Not flaky, not slow, not inconvenient. The
rewrite is written down in each spec at the assertion that changed, in those
terms, so a later reader cannot mistake it for a relaxation. cp15-b6 now
asserts the disappearance AND the return — a disappearance-only spec goes
green on a sidebar that never recovers.

`issue100` keeps its subject and gains the precondition it used to assume.
Under the ruling the badge's host is absent for the whole park, so what makes
the badge observable at all is an ORDERING: the reconnect PATCH spawns FIRST
and commits `:connected` only on spawn success (`NetworksController`'s U-0
ordering), and `Session.start_session/3` returns when the GenServer starts,
not when the link registers — so the row is back within milliseconds while the
`connecting` flag, which clears only on 001, is still set. The spec asserts
that ordering now (section gone while parked, section back before the badge
latch) instead of letting it be the unstated reason a latch fires or times
out. If it ever stops holding, the failure names the broken link and becomes
evidence for the badge question below rather than a mystery.

Both specs also stopped reading `toHaveCount(0)` on the greyed child as proof
a row is healthy: that assertion is satisfied by a row which never came back.
It was fair while present-and-greyed was the only possible state, and it is a
hole now that disappearance is real.

### Limits, stated

**Not device-verified.** The gates here are jsdom + the pure predicate; the
mutation was run in both directions (disabling the filter reds exactly the
disappearance assertions while the failed / failing / visitor /
no-empty-claim controls stay green, and disabling the predicate reds those
plus its own). Whether the sidebar READS right with two parked networks on a
phone is dogfood.

**BottomBar is untouched, and that is a scope call, not an oversight.** The
mobile strip is a separate `<For each={networks()}>` in `BottomBar.tsx` with
no greying of its own, so a parked network still shows there. The ruling names
the sidebar; the issue's own motivation cites the mobile fold. The question
was raised and not answered, and widening on a guess is what the ruling exists
to prevent.

**`ComposeBox.tsx` keeps its own `NETWORK_GREYED_STATES = {parked, failed}`
and was left alone deliberately.** It is what makes any residual parked window
readable but not writable, and it is a different question (can I type here)
from the one this slice answers (is there a row).

**The `reconnecting…` badge has nowhere to live during the transition, and on
2026-09-10 vjt ruled that nothing is to be built to give it one.** The words on
`#grappa` at 14:59 Rome (12:59Z) were *"ci si riconnette da HOME"* and *"non
SERVE nient'ALTRO"*. ⚠️ **Provenance: RELAYED into this session from the ircbot
session, not read on IRC by this entry's author** — the same posture as the
archive ruling above, and it is recorded as relayed rather than quoted as
first-hand. So none of the three candidates is built: no badge grafted onto
`$home`, no state machine holding `[Reconnect]` disabled longer, no teaching
`$home` the progress signal. A parked network's row leaves the sidebar and
reconnecting is `$home`'s business. This EXTENDS the 2026-09-08 *"redirect to
home"* ruling rather than competing with it, and the cold-load restore gate in
`Shell.tsx` is untouched by it.

What was measured before the ruling landed still describes today's behaviour —
it is simply no longer a question. The #100 badge renders inside the
per-network `<For>` (`Sidebar.tsx:378-380`) off `reconnectingByNetwork`, which
the server drives with `connection_progress` (`connecting` on the attempt,
`connected` on 001). `connection_state` stays `parked` for that whole window —
it is operator intent, and the badge is deliberately NOT that state. So the
badge fires while its host row does not exist.

**Observed, and placed OUT OF SCOPE by that same ruling — written down so the
next reader does not re-discover it as new.** Between clicking `[Reconnect]` on
`$home` and 001, the button relabels to `Reconnecting…` only while
`reconnector.pending()` — the awaited PATCH — then returns to `Reconnect` with
the state word still reading `parked` and no badge anywhere, while the upstream
link is in fact coming up. Before this slice the greyed sidebar row hosted the
badge for exactly that window. It is a second-order effect of the ruling, it is
deliberately NOT filed as an issue, and it is not cured: *"non serve
nient'altro"*.

_Code + tests. No wire change and no protocol bump — the archive response
shape is untouched, only which entries qualify for it. It is NO LONGER cic
bundle only: `ArchiveController` changed, so the deploy is cic bundle PLUS the
server. One module body, no `VERSION` bump and no migration, so the server
half is hot-reloadable; the preflight decides._
<!-- entry #2037a -->

---

## 2026-09-10 — #2037: three unread numbers, and the four ways they cannot be one window

The report is one operator returning after ~21h: the far-behind bar says
`1807 unread`, the sidebar pills say `187` and `216`, and `187 + 216 = 403`.
The issue body attributes the direction to own-authored rows plus the
content/events split, states plainly that those do not account for the
`1404` residual, and nominates the ANCHOR. This entry records what the
residual is NOT, which is all that got settled.

### The anchor cannot contribute in the observed direction

Measured on the client, where the anchor lives
(`cicchetto/src/__tests__/unread2037AnchorProbe.test.ts`). The cold-open path
probes ONCE, at the read cursor — the same integer
`ReadCursor.bulk_unread_split/3` anchors the badge seed at, so that path has
no anchor term at all. The reconnect path is the only one holding two
anchors, and it renders the CURSOR-anchored number. The one branch that
renders the other is the re-probe failure the issue names, and it renders the
SMALLER number, because the fallback anchor sits further FORWARD and
`count_after/6` is monotone non-increasing in `m.id > ?`.

So the anchor term is bounded ABOVE by zero. **Anyone who closes this by
re-anchoring the probe moves the bar DOWN by at most one page and leaves the
1404 exactly where it is.** The positive control is what makes that claim
worth anything: it asserts two DISTINCT anchors actually reached the wire
before the sign is read, without which the same assertion passes a harness
that only ever probed once.

### The two presence resolvers are two doors, and they can disagree

The body says *"Both paths DO share the presence-hidden filter, so that is
not a divergence source."* They share the RULE (`PresenceFilter.hidden?/2`)
and nothing else. The bar reaches it through `Resolver.hidden?/4` →
`Session.list_members/3`; the seed through `Resolver.hidden_channels/3` →
`Session.list_member_counts/2`. Two calls, at two instants.

Measured through the real `Grappa.Session` facade against a `Session.Server`
stand-in registered under the real registry key: with no session both SHOW,
with consistent over-threshold answers both HIDE, and with the two calls
answered independently the bar SHOWS while the seed HIDES — the sign the
issue needs. The cost of that one disagreement on a 78-row fixture is 69
rows, i.e. own-authored UNION suppressed-presence (they overlap on the
operator's own presence rows, so the residual is the union and the assertion
says so exactly rather than `> 0`).

Reachability is a READING, not a measurement: both `handle_call` clauses read
the same `state.seeded_channels` and `state.members`, so a real server cannot
answer asymmetrically within one instant. The divergence needs two instants,
or a call failure at one door — `member_count_for_unset/4`'s catch-all folds
`:uninitialized`, `{:error, :timeout}` and `{:error, :no_session}` to one
`nil`, and decision D reads nil as SHOW. For a history FETCH that is correct.
For a COUNT it converts "I could not reach the session" into "count every
JOIN/PART", and freezes it into the far-behind state.

### And that mechanism is not what happened, by measurement

Write, for one window at one anchor, `C` = non-own content, `E_s` = non-own
suppressed presence, `E_c` = non-own carve-out (`topic`/`kick`/`server_event`,
outside `suppressed_presence_kinds/0` per #458), `O` = own-authored,
`O_s` = own presence. Then `bar(SHOW) = C + E_s + E_c + O`,
`bar(HIDE) = C + E_c + (O − O_s)`, `pills(SHOW) = C | E_s + E_c`,
`pills(HIDE) = C | E_c`. Against 187 / 216 / 1807 all four assignments fail:
the two SHOW-seed ones require ~1404 own-authored rows in 21h, and the two
HIDE-seed ones additionally require `E_c = 216`.

`E_c = 216` is the one that is measurable off-line, and it was measured
against the on-host prod snapshot (13320 rows, opened `immutable=1`). On
channel-shaped windows the entire carve-out population is 13 `topic` rows and
4 `kick` rows; `server_event` never lands in a channel window at all. The
largest carve-out in any single channel window, ever, is 9. The incident
needs 216 in one window in 21 hours — 24× the observed maximum, 30× on the
ratio against content. The suppressed-presence half of the same snapshot is
by contrast entirely ordinary (`suppressed/content` ranges 0.078 to 5.43, and
the assignment needs 7.5).

So the reading that "216 is exactly what is left over once presence is
hidden" is dead, and it was mine. Two numbers agreeing was the whole of that
argument; the control that discriminates between agreement and coincidence
says no.

### What is left

At least one premise of the report is false, and the anchor is not it. The
economical candidate is that the two pills are not one window's pair, or not
the bar's window — which the same snapshot makes circumstantial rather than
speculative: every one of the five furthest-behind cursors in it is a
`$server` window (1584, 1531, 1370, 1052, 113 rows behind), the furthest
channel window is 68 behind, and `$server` is 99.9% content, so its own pill
pair reads ~N messages and ~0 events. A 1807-row far-behind bar looks like a
`$server` window, and a `$server` window does not produce 187/216.

_Not asserted: that the resolver divergence caused the incident (measured
that it CAN happen and what it costs; measured that the arithmetic it needs
does not hold). That a real `Session.Server` cannot produce the asymmetry in
one instant — that is read off two clauses, not measured, and measuring it
needs a live session. That the May snapshot is representative of the incident
channel; it establishes a floor on how implausible 216 carve-out rows are,
not a distribution. That the residual is explained — it is not._
<!-- entry #2037b -->

---

## 2026-09-10 — #2037b: one predicate, two buckets, and a bar that is now the badge

#2037a measured the three reported numbers and closed the anchor: the bar's
term is bounded above by zero, so re-anchoring the probe moves the bar DOWN
by at most one page and leaves the 1404-row residual exactly where it is.
This entry records what was BUILT on top of that, under three rulings from
vjt on the issue (2026-09-10, 08:54 / 08:56 / 09:00): use one logic for the
counting; messages are what land in both the badge and the far-behind bar;
the threshold stays as it is today.

### The partition, named once

There is ONE split and it already existed:

    messages := kind IN     Grappa.Scrollback.Message.@content_kinds
    events   := kind NOT IN @content_kinds

`Scrollback.count_after_split/6` (per window) and
`ReadCursor.bulk_unread_split/3` (the bulk `/me` seed) were both already
computing exactly this. #2037 introduced no new predicate; it stopped a
FOURTH surface — the far-behind bar — from using a different one. The split
gained a name this round, `Grappa.Scrollback.count_split()`, because it is
now a wire shape rather than only an internal return.

The threshold is deliberately NOT in the partition. `count_after/6` keeps its
predicate (raw rows, own-authored included) and its one caller, the
`probeGap` → `isFarBehind` decision. Feeding a messages-only number into the
threshold would have a channel with 3000 hidden JOINs and 40 messages report
a 40-row gap and then take a contiguous-paging path it cannot serve. That is
the 09:00 ruling and it is a correctness argument, not an omission.

### The property: the bar and the badge are ONE VARIABLE

The acceptance criterion was that the two numbers cannot drift apart again.
Two values that happen to agree do not satisfy it; one value read twice does.
So `far().missed` IS the messages count, `perChannelUnread` reads the
far-behind entry for a far-behind key instead of the seed, and the bar
renders the same field. Nothing compares them, because there is nothing to
compare.

Serving the seed at render time was the one-line alternative and was rejected
for a MEASURED reason, not a stylistic one: `far.missed` also feeds
`measuredUnread`, which places the in-pane divider. Narrowing only the
sidebar would have left the divider on the raw number, so the operator taps
"187 unread" and lands on "1807 unread messages". A definition that reaches
one of its two consumers is the defect this issue is about, reproduced one
layer down.

The probe is also the fresher of the two inputs, which is a side effect worth
recording because it is easy to mistake for a fix. The seed is written by
`/me` and by the join reply and by nothing else: the per-message
`window_counts` push carries the pair, but cic ignores it on purpose
(`subscribe.ts`, #239 — messages/events stay client-derived for the presence
filter) and a far-behind key skips client derivation by design. So a
far-behind window's seed is frozen at login while the probe is taken when the
pane opens. That narrows the stale-seed path for exactly the windows where it
went stale. It is NOT a fix aimed at the residual and is not claimed as one.

The prune path (#1229) had to follow or the tree would carry two definitions
again: it arms far-behind from LOCAL eviction and was accumulating raw row
counts into the same field. It now accumulates the content unit. The ARMING
stays on the raw count, deliberately — what arms far-behind is "a row at or
after the cursor left the store", which a JOIN does as surely as a message,
and the divider cannot be placed either way. Only the displayed quantity
narrowed.

### One resolution per request

Both halves of the split come from ONE `resolve_hide_presence/3` call in
`MessagesController.count/2`. That closes by construction the divergence
#2037a measured between the two `PresenceFilter.Resolver` doors: within a
request there is one resolution and both counters get it. It does NOT close
the divergence between `/me` and a later probe, which is a different pair of
instants and has its own issue.

### The `kick` consequence, said out loud

`show_event_badge` is the sixth #449 display pref and the first whose DEFAULT
takes something away. It is server-backed on #1766's criterion: a per-DEVICE
toggle is right when the complaint is about a VIEWPORT and wrong when it is
about the ACCOUNT, and "is my sidebar cluttered with join/part counts" is
identical on the phone and the desktop.

What it hides is WIDER than join/part, and the ruling asks for that to be
stated rather than discovered. The events bucket is `kind not in
@content_kinds`, so `topic`, `kick` and `server_event` follow it — the three
kinds that sit OUTSIDE `Message.suppressed_presence_kinds/0` on purpose
(#458), because the PANE still renders them on a denoised channel. Rendering
in the pane and earning a badge are different questions and this pref answers
only the second. **A KICK therefore stops contributing to a badge by
default.** That is a deliberate behaviour change.

Putting `kick` back into the message bucket would smuggle a non-message into
the very number the bar now shares with the bold pill and undo the other
half. A kick that must stay loud belongs in the mention/severity channel
(#267), which is a different axis from "how many unread rows".

### A default that takes something away makes existing specs VACUOUS

Worth its own heading because it is the part that nearly shipped wrong, and
it is a general consequence of the FIRST opt-out-shaped default rather than
anything specific to this pref.

Four e2e specs read the sidebar's events pill, and under the new default
`sidebarEventsBadge(...)` resolves to nothing at all. One of them asserts the
pill is VISIBLE (#265) and failed loudly, which is the easy case. The other
three assert `toHaveCount(0)`:

* #239 — the presence-filtered JOIN did NOT bump the events badge
* r6 — the operator's own ACTION earns no events badge
* #532 A — no event badge on the archived row after a self-PART

All three would have stayed GREEN while testing nothing, because the pref
suppresses the element whether or not the thing under test happened. The full
suite says so directly: four reds, and the three vacuous ones were not among
them. So each now calls `setShowEventBadge(token, true)` before `loginAs` —
before, because `displayPrefs.ts` applies the server's map on the post-login
refresh.

The general rule, for the next pref whose default removes a surface: grep for
every assertion on that surface and split them by SIGN. The positive ones
fail and find themselves; the negative ones pass and have to be found.

No restore is needed and none was added. Every e2e test runs on its own
throwaway subject (`provisionSpecSubject`, named off the title path and
DELETEd at teardown), so a pref set inside one body cannot reach another
spec — an earlier version of the #2037 spec carried an `afterEach` justified
by a cross-spec poisoning that cannot happen, and the justification was
wrong before the machinery was unnecessary.

### The unit is not yet ONE unit — `far.missed` still has two producers

Recorded because A closed most of this gap and the remainder is easy to
mistake for closed. `far.missed` is written by two paths: the server PROBE
(`count_after_split/6`, which excludes own-authored rows per #576/#532 A) and
the client PRUNE (`capScrollbackRing`, which filters `isContentKind` and has
no own-nick arm at all). Before A they counted different things entirely;
after A they agree on everything except own-authored content.

That is better and it is also a worse FAILURE MODE: two numbers differing by
a lot are visibly two numbers, and two numbers differing by three are
indistinguishable from one until somebody counts. The same window at the same
cursor reports a different figure depending on whether it went far behind by
local eviction or by a gap probe. Filed as its own issue rather than fixed
here — it is a second behaviour change on a path that already carries one,
and none of the three rulings asked for it.

Two mechanics that are easy to get wrong and were not: the count is ZEROED
rather than the element hidden, because `events()` feeds `title` and
`aria-label` as well as the text and an element hidden by a `<Show>` whose
accessible name still says "216 unread events" is the wrong half of the
change; and `applyServerPrefs` uses `??` and not `||`, which matters more for
this key than for its predecessors because `false` is the default — `||`
would make the badge impossible to turn back OFF from a second device once
any device had turned it on.

### Protocol 16, and the third `wire_pin` blindness

`@protocol_version` goes 15 → 16 for the two new fields on the count
response. `mix grappa.wire_pin --check` did not force it, for the THIRD
release running — and this time the gate printed the proof of its own
blindness rather than leaving it to be argued. It failed on this branch, but
on the VERSION field alone, and its own output is the measurement:

```
shape digest   pinned sha256:f3c18a4c…4bf3c0
               now    sha256:f3c18a4c…4bf3c0
protocol       pinned 15
                now   16
```

The digest is byte-for-byte identical ACROSS a two-field addition to the
wire. So the gate did not catch the shape change and then ask for a bump; it
noticed that a human had already moved the number and asked to be re-pinned.

Reversing the order is the discriminating control, and it was RUN rather than
reasoned about: with both new fields still in `messages_json.ex`, put
`@protocol_version` back to 15 and re-pin at 15, and the gate answers

```
priv/wire/shape.pin: wire shape and protocol 15 agree.     rc=0
```

That is green on exactly the violation the gate exists for — a wire-shape
change carried in under a still number. (Measured on this branch, then
reverted; `lib/grappa/protocol.ex` and the pin are byte-identical to their
committed state afterwards.)

Two more measurements pin down why, and both are one command:
`grep count_split cicchetto/src/lib/wireTypes.ts cicchetto/src/lib/wireSchema.ts`
finds nothing — the count response is absent from BOTH generated artefacts,
so it was never inside the digest's span; and `mix grappa.gen_wire_types
--check` answers `in sync.` on the same tree, which is the failure mode
CLAUDE.md already names (it compares each artefact with its own SOURCE, so
a route the generator does not cover is "in sync" by construction).

The bump therefore remains a deliberate manual act — and this round names
which guard actually caught it being done HALF-WAY, because it was not the
one v15's own entry nominated. Three things could have fired:

* `wire_pin --check` — fired, but only after the number had already moved,
  and only to ask to be re-pinned. See above.
* `protocol_test.exs` (#1973) — GREEN. It pins cic's
  `CLIENT_PROTOCOL_VERSION` against the server's, and both had been moved to
  16, so it had nothing to say. v15's entry called it "the ONLY automatic
  guard standing on this change"; on this change it stood and saw nothing.
* the `@spec version() :: 15` LITERAL — RED, at
  `lib/grappa/protocol.ex:373`, `invalid_contract`, "success typing () :: 16
  but the spec is () :: 15". That is the one that caught it.

The literal was chosen for a Dialyzer-idiom reason (a constant-returning
function's spec matches its success typing under `:underspecs`) and its
comment already claimed the tripwire role as a secondary benefit. It is now
the PRIMARY automatic guard on the pair, by measurement, which is worth
knowing mostly because it is a strange place for a protocol invariant to
live: it fires in the dialyzer stage, minutes after the suite is green, and
it says nothing about the wire.

`min_protocol_version` stays at 1:
`countMessagesAfter` falls back to `{messages: count, events: 0}` when the
pair is absent, which is exactly the pre-#2037 number in the pre-#2037
place, so a new bundle degrades against an old server instead of breaking.

_Not asserted: that any of this explains the 1404-row residual. It does not
and does not try. The four (bar posture, seed posture) assignments from
#2037a remain excluded by measurement, so a premise of the MODEL has to give
rather than a premise of the reading, and the reading that the two pills are
not that window's pair is EXCLUDED by vjt — he settled on 2026-09-10 that it
is one and the same window ("si stessa window", his words on IRC, reported
into the session; I do not read IRC). The quantity was unified. The mystery
was not closed._
<!-- entry #2037c -->

---

## 2026-09-10 — #2037c: the wire pin was blind to every hand-written JSON view, and a list was never going to fix it

`mix grappa.wire_pin --check` is the gate behind the #1393d ruling: a wire
shape that moves without `Grappa.Protocol.version/0` moving is RED. It failed
to see #2037's own wire change. It caught the commit only on the VERSION
field, printing a byte-identical digest across a two-field ADDITION — the
gate's own output was the proof of its blindness.

### Measured on demand, this session, not inherited

A field named `mutant_probe` was added to `GrappaWeb.MessagesJSON.count/1` —
`@spec` and body together — on the untouched branch:

| tree | command | rc | verdict |
|---|---|---|---|
| pre-cure + the new field | `wire_pin --check` | **0** | `wire shape and protocol 16 agree.` |
| the same tree | `gen_wire_types --check` | 0 | `in sync.` on BOTH artefacts |
| the same tree | grep the artefacts | — | `mutant_probe` **0×** in each |

with a positive control on the grep (223 / 190 hits for a token that is in
them) and a negative control (0). So the addition was invisible to the drift
gate, invisible to the tripwire, and absent from both generated files.

The second row is the live instance of what CLAUDE.md already claims in the
abstract — the generator compares the artefact with its own SOURCE and answers
`in sync.` in exactly the case to catch. It had been recorded from a Wire
typespec; here it is measured on a hand-written `*_json.ex`, where the source
it compares against never mentioned the field at all.

### Why the obvious cure is not one

This is a RECURRENCE. #1679 met the same class — `/boot` invisible to the
tripwire — and cured it by adding `GrappaWeb.BootJSON` to `gen_wire_types`'s
hand-kept `@extra_modules` and writing a comment telling the next author to
remember. The note did not hold, and it could not: an inclusion list is
**fail-OPEN**, so forgetting it costs nothing and says nothing. Measured
today, two views that were never added — `PushSubscriptionJSON` (3 declared
types) and `UserSettingsJSON` (9) — have been outside the digest the whole
time.

Widening that list still would not have caught #2037, and this is the part
that decided the design: of the twelve `GrappaWeb.*JSON` views, **eight
declare no named `@type` at all**, `MessagesJSON` among them. The codegen
renders named types, so listing those modules buys exactly zero. All twelve
DO carry `@spec`s — 29 of them.

### What shipped

`wire_pin` grew a third digest component: the `@spec`s of the EXPORTED
functions of every `GrappaWeb.*JSON` module, read from BEAM chunks, over a
module set derived from the build output (`Elixir.GrappaWeb.*JSON.beam` under
the compile path) rather than typed by hand. Fail-CLOSED twice — a new view is
covered the moment it compiles, and a discovery that finds nothing RAISES
rather than contributing an empty string to a digest that would go on
agreeing.

The module name comes from the beam FILENAME, which IS the module. Not from
camelizing a source path: `gen_wire_types` records that guess turning
`controllers/me_json.ex` into `GrappaWeb.Controllers.MeJson`, a module that
does not exist, dropped SILENTLY — zero coverage while looking widened.

Reading BEAM chunks rather than source is what keeps it from firing on
comments and reformatting, the property the two-artefact digest already had
and had to keep.

### Deliberately NOT routed through the codegen

Adding the twelve views to `@extra_modules` and letting `gen_wire_types` emit
them would drag their shapes into `wireTypes.ts` **and `wireSchema.ts`** — and
the schema one is RUNTIME validation in cic. Widening a runtime validator is a
client change with its own blast radius; this is a gate change. They do not
belong in one commit, and the gate does not need the client to move for the
server-side hole to close.

### Cost paid once, and the route was the documented one

Widening what the digest COVERS is not a wire-shape change and the gate cannot
tell — it saw a moved digest and a still number, which is the violation, and
`--update` refused. That is the moduledoc's own scenario, and its prescribed
route was taken: DELETE `priv/wire/shape.pin` and re-create it, visible in
review, rather than adding a `--force` flag that would be the hole the refusal
exists to close. Re-created at protocol **16** — unchanged, because the WIRE
did not move, only the gate's view of it. The pin's header states its coverage
on purpose, so it was rewritten in the same commit; a header describing a
coverage that no longer exists is the same lie, moved.

### Proof the cure is a gate and not decoration

The identical `mutant_probe` addition, re-applied after the cure:
`wire_pin --check` rc **1**, digest `sha256:cdc283e8…` → `sha256:e9de1fa8…`.
Reverted: rc 0. A gate that has never failed on the case it must catch is
decoration, and that is literally the defect being cured here — repeating it
in the cure was not an option.

### Two limits, stated so they are not rediscovered

A view whose BODY grows a key while its `@spec` stands still is still
invisible to this component. Dialyzer is the leg that catches that one, and
that is an ARGUMENT — it was not measured in this session, and it is written
down as an argument rather than dressed as a measurement.

A spec that references a remote type is digested as the reference TEXT, so a
change inside `Grappa.Scrollback.count_split()` moves nothing unless that type
reaches the digest by another route.
<!-- entry #2056 -->

---

## 2026-09-10 — #2056: SASL logs you in on solanum, and nothing on the wire told the session

`IdentityState` (#388) ORs two axes, and on solanum/Libera only one of them
exists: there is no registered umode in `user_modes[256]`, so the services
account IS the verdict. It was seeded in exactly two places — the IRCv3
`ACCOUNT` relay and a self-targeted 330 RPL_WHOISLOGGEDIN — and a SASL login
reaches neither, so a session that authenticated successfully read
`identified: false` until the operator happened to WHOIS themselves.

**The issue said that, and said it was NOT measured.** Its analysis derives
"no self `ACCOUNT` on a SASL login" from the absence of a seeding path plus
the pre-registration timing. That is a reading of structure: structure says a
path EXISTS or does not, never that it is the cause. So the first step here
was a capture, not a clause.

**The capture.** A stock solanum (upstream main @ `30f74b2c`) fronted by
Atheme 7.3.0-rc2, in an isolated compose project on its own subnet. Stock
matters: the #349 e2e conf loads an `umode_regd` extension that emits `+r` on
services login, and that shim would have handed the bench a registered-umode
axis solanum does not have — the exact axis under measurement. A client ACKed
`account-notify extended-join multi-prefix sasl chghost server-time` and
logged in with SASL PLAIN. What arrived:

```
<< CAP w2sasl ACK :account-notify extended-join multi-prefix sasl chghost server-time
>> AUTHENTICATE AGNhcGFjY3QAY2FwYWNjdHBhc3MxMjM=
<< 900 w2sasl w2sasl!w2sasl@172.31.99.1 capacct :You are now logged in as capacct
<< 903 w2sasl :SASL authentication successful
>> CAP END
<< 001 … 376, :w2sasl MODE w2sasl :+i
```

From socket open through 001, a ten-second tail, and a JOIN: **zero `ACCOUNT`
lines**. The premise holds.

**The zero is only worth printing because the instrument answered a known
question first.** Two positive controls, same tool, same transcript format: a
`NickServ LOGOUT` on the SAME socket with the SAME caps produced
`:w2sasl!~w2sasl@… ACCOUNT *` (plus `901`), and a `NickServ IDENTIFY` on a
second socket produced `:w2ident!~w2ident@… ACCOUNT capacct` (plus `900`). The
harness refuses to print the negative count unless both fire — and that refusal
earned its keep on the first run: the line classifier skipped the `:` source
prefix but not the `@time=` tag that `server-time` puts in front of it, so every
tagged line was classified as the tag blob. It reported "INSTRUMENT BLIND"
rather than "0 ACCOUNT lines". The answer would have been right for the wrong
reason.

**Why no ACCOUNT, now read WITH the measurement in hand.** solanum emits the
relay in one place, `modules/m_services.c:148` (`me_su`), and
`sendto_common_channels_local` does deliver it to the user themselves even
with no channels in common (`ircd/send.c`, the trailing `MyConnect(user)`
branch) — which is why the IDENTIFY control fires. SASL takes the other door:
`me_svslogin` (`modules/m_signon.c:122`) sends the numeric and then, on the
`IsUnknown(target_p)` pre-registration branch, merely stashes `suser` and the
spoof fields. No ACCOUNT to anyone; `register_local_user` propagates
`ENCAP * LOGIN` to SERVERS only; no `account_change` hook consumer emits one.

**The cure** is a `do_route/2` clause for `{:numeric, 900}` mirroring the 330
one — `normalize_account/1`, `identity_effects/2`, `identity_secret_effects/2`
— and nothing else. Two details the issue's sketch did not carry, both from
the capture and the source:

  * **It must NOT be gated on the leading param matching our nick.** The 330
    clause is, correctly. But SASL completes pre-registration and solanum
    fills that param with `*` while the client has no nick
    (`m_signon.c:218`, `EmptyString(target_p->name) ? "*"`). The numeric is
    `sendto_one` to this link about this link; there is no third party it
    could describe.
  * **It does not fold into the WHOIS card.** 330 folds because 330 is a
    WHOIS reply; 900 describes the connection, and folding it would write an
    account into whatever WHOIS happened to be open.

The vjt ruling of 2026-08-11 is untouched: the account counts as proof only
where `account-notify` is ACKed. On solanum it is, which is precisely why the
seeded axis is retractable — the `ACCOUNT *` in positive control 1 is the
retraction, captured.

**A correction to the issue text.** It says "900 has no logged-out form". True
of 900; not true of the transition — solanum emits `901 RPL_LOGGEDOUT`, and
the capture has it. The clause stays set-only anyway: where the account counts
at all, the cap guarantees the `ACCOUNT *`, so 901 would be a second spelling
of a retraction already handled. Recorded so the next reader does not
rediscover it as a gap.

**Reachability, checked because the fix depends on it.** The 900 lands
mid-registration. `IRC.Client.process_line/2` forwards every parsed line to
the session BEFORE stepping the auth FSM, and `Session.Server`'s numeric
clause delegates to `EventRouter` after window routing — so the clause is
reached. The `:acquired` transition also releases the deferred autojoin
(#347); it cannot fire early here, because that latch is armed at 001
(`maybe_autojoin_or_defer/1`) and is a no-op while nil.

**What this does NOT establish.** The bench is stock solanum plus stock
Atheme, not Libera's deployment: Libera runs its own solanum fork and its own
services, and nothing here was captured against Libera itself (no account
there was in scope). What the bench does establish is that the behaviour is
solanum's DEFAULT, in the code path Libera runs, with the positive controls to
show the tool would have seen the counter-example. Nor is it established that
this is the only cause of a stuck `identified: false` on an atheme network —
the capture shows the SASL arm carries no seed, not that no other arm is also
broken. The `extended-join` echo of our OWN JOIN carries the account
(`JOIN #capchan capacct :realname`), a third potential seeding path, left
deliberately untouched: it is not the connection's login signal, it is a
channel event that happens to mention it.
<!-- entry #2050 -->

---

## 2026-09-10 — #2050: the far-behind record had no way to notice the cursor had caught up

vjt: *"hai rotto i badge e di conseguenza il bottone alt+a, adesso ho tre badge
su tre canali che non riesco a marcare read"*, then *"dopo un restart dell'app
problema sparito"*, and the repro: *"l'app ha passato un periodo di tempo senza
connessione e poi si è riconnessa"*.

Alt+A was never the defect — `keybindings.ts` dispatches `nextUnread`, so the
chord kept landing on the same three windows because their badges would not
fall. One thing was broken, not two.

### What the record promises, and where the promise lapses

#693's `farBehindByChannel[key]` says "the unread region is NOT in this pane".
Two consumers act on it: `perChannelUnread` (`selection.ts`) discards local
truth and publishes a frozen server-side number instead, and
`setCursorIfAdvances` FREEZES the read cursor. Both are sound only while the
cursor sits where it did when the record was written.

WHICH frozen number moved while this was in flight, and the note is here so the
next reader does not think the entry describes code that no longer exists.
Until #2037 (landed 2026-09-10, hours before this) the published figure was
`serverSeedCounts[key]`; it is now the far-behind record's OWN `missed`, so the
record no longer merely GATES a frozen number, it CARRIES one. That makes the
defect sharper rather than different — and the cure identical, because retiring
the record is what releases either reading. Re-measured on the new base with
the bound removed: the same three reds, the third now printing
`{ missed: 5000, events: +0, … }` where it printed `{ missed: 5000,
resumeFrom: 1000 }`. Nothing in the tests moved but the fake's probe shape
(#2037 turned `countMessagesAfter` into a three-field `GapProbe`) — no
assertion was touched, which is the only reason the reds are comparable at all.

It does not stay there. The record had exactly three exits — `jumpToUnread`,
`dismissFarBehind`, `purgeScrollback` — and not one of them was keyed on the
cursor, while at least four paths move it: `sendMessage`'s DIRECT
`setReadCursor` (deliberately not routed through the frozen door, to avoid an
import cycle), `applyReadCursorSet` (the unconditional cross-device echo), and
the two hydration paths. Once any of them fires, the cursor is at the tip with
nothing unread and the record still stands — so the badge keeps publishing a
seed that only a per-channel join reply or a `/me` fetch can rewrite, neither of
which happens again while the socket stays up.

That is the report exactly: unclearable in session, clean after a restart,
because both stores are in-memory. Measured against the real stores and a fake
server whose cursor the POST actually moves: one send takes both cursors to 6001
with zero rows unread while the badge holds 5000 across a visit, a read at the
tail, a reopen and the activation refetch. The single-device path needs no
second client — talking in the window is enough.

### Why an effect, and why this bound

An EFFECT on the cursor rather than a call at each door, because the doors are
not a closed set: patching the two known ones cures the instances and leaves the
next to be found in production.

The bound is `cursor >= oldestLoaded - 1` — "the loaded window already reaches
down to the read position". It states the record's own claim instead of
approximating it. Two alternatives were measured and rejected:

* `cursor >= resumeFrom + missed` adds an ID to a per-channel row COUNT.
  `messages.id` is one global autoincrement across every network and channel (a
  single `messages` table, `20260425000000_init.exs`), so the sum is not an id.
  With two channels interleaved on that sequence it fires at HALF the region,
  and the error scales to ~1/N with N busy channels — worst exactly when the
  absence was longest. Measured retiring the record with 2500 rows still unread,
  which is the destructive unfreeze #693 exists to refuse.
* `cursor >= newest loaded` is not wrong, it says less: it closes only at the
  very newest row, so an operator who has scrolled INTO the loaded window keeps
  a "jump back" bar over a pane with no hole left. The objection raised against
  it — that live traffic keeps raising the newest id so the record would never
  close — was measured false: under far-behind the only doors that move the
  cursor land ON the row that just arrived, so cursor and newest rise together.

### The caveat, named rather than discovered later — and then measured

`loadMore` prepends older rows and LOWERS the oldest loaded id, so scrolling up
far enough satisfies the bound. That is correct, and the reason is that clearing
**thaws; it does not mark anything read**. The badge stops publishing the frozen
seed and returns to LOCAL truth — still N if N rows follow the cursor, but now a
live number the operator retires by reading. Re-paging the region back into the
pane IS closing the hole. The destructive move would have been the opposite:
unfreezing while the pane was still holed, leaving local truth incomplete and
the count under-reported.

That paragraph shipped as an ARGUMENT, labelled as one in the code comment and
in the PR: the bound was measured on the cursor axis only, and everything above
about the window axis was reasoning. It is now measured too, by a fifth arm on
the other axis — the cursor never moves, the WINDOW does, page by page up to
the read position. Three rows land live mid-scroll, which is what makes the
badge's two readings separable: the seed is a join-time snapshot stuck at 5000,
local truth is 5003. So the closing number is neither zero (thaw ≡ mark read),
nor 5000 (still frozen), nor short (a bound firing over a holed pane).

Its evidence is a mutation bench, because a green arm on a shipped cure proves
nothing on its own. Bound deleted (= `origin/main`): red at the arm's page
budget. **Bound fires one page into the scroll: all FOUR pre-existing arms stay
GREEN and only the new one goes red** — that gap is the arm's whole reason to
exist, since "retires when the hole closes" and "retires as soon as you scroll"
were indistinguishable before it. Clear-and-also-advance-the-cursor: again only
the new arm, on the cursor assertion.

The price is the file's blanket threshold-agnosticism, and the header note is
amended rather than left to rot. Four arms park the cursor at the channel tip
where every candidate bound agrees; this one is about the bound by construction
— but it asserts the record's own claim ("the unread region is not in this
pane"), not the arithmetic, so it survives any bound that honours what the
record says.

### What the e2e found: the bound was reading a HOLED pane

The first contact with a browser turned the slice red — `#1062`'s spec, which
asserts the "jump back" bar is attached on a freshly-opened far-behind window.
It was not a flake and it was not the threshold being greedy. Measured:

| tree | runs | verdict |
| --- | --- | --- |
| this branch | 5 (1 cold stack, 4 warm) | **3 red**, 2 green |
| `9c1c9ecff` with `scrollback.ts` byte-identical to the base | 4 (1 cold, 3 warm) | 4 green |
| this branch + the guard below | 3 | 3 green |

Every red rendered the SAME pane, read off the DOM in three independent
artefacts (one Playwright trace snapshot, two `error-context.md`): rows
`seed line #1..#22` and `#212..#260` — **71 rows with a 189-row hole** — and
the sidebar badge at 49 rather than the frozen 240.

The chain, from the trace's own request order. `refreshScrollback` fills the
pane with the region after the cursor; the pane scrolls up and `loadMore` puts
`?before=<head>` on the wire; `loadInitialScrollback` probes, decides the gap
is undrainable and `anchorAtTail` REPLACES the window with the tail page and
arms the record; and THEN the older page lands and is prepended into a window
it no longer abuts.

So the far-behind bound was not wrong about its own claim — it was reading a
pane that lied. `rows[0]` is the bottom of the unread region ONLY while the
window is contiguous, and a late `loadMore` had spliced rows from BELOW the
cursor onto a tail-anchored pane. `cursor >= oldestLoaded - 1` was then TRUE
with the whole region still missing.

**Fixed at the root, not at the threshold.** `loadMore` now drops a page whose
window moved under it — `scrollbackByChannel()[key]?.[0]?.id !== oldest.id` —
which is the same sentence `loadInitialScrollback` already applies to its own
two pages ("the loser drops its pages: they describe a window the pane has
deliberately left"). Narrowing the bound instead would have papered over a
PRE-EXISTING defect: without this cure the same race still splices the hole,
silently, and the pane renders two non-adjacent regions as if they were
consecutive — precisely what `anchorAtTail` says it refuses to create and what
#1538 calls an invariant of every path. The cure did not create the hole; it
made it visible by reading it.

The guard sits BEFORE the empty-page exhausted latch on purpose: a window that
moved says nothing about whether the NEW head has older rows. It is not
far-behind-specific — the ring cap evicting the head produces the same stale
page, and `purgeScrollback` and `jumpToUnread` replace the window too.

The e2e is a race and races are bad evidence, so the invariant is pinned where
the order is decided rather than raced: a sixth arm in
`unreadBadgeFarBehindStale.test.ts` holds the older page on the wire until the
re-anchor has happened, then releases it and asserts BOTH that the record
stands and that the pane carries no id gap. With the guard disabled it fails on
the record; the other five arms stay green, which is the same coverage gap the
e2e had.

### A send retires the affordance, and that is the ruling

Writing in a far-behind window clears the record, so the "N unread — jump back"
bar disappears after your own message. That reads like a loss — the operator
never asked to give up the way back to the region — so it is worth saying that
it is a DECISION and not a side effect nobody looked at.

vjt ruled on 2026-09-10 (relayed by the orchestrator, whose session it reached):
writing in a far-behind window counts as having caught up; the bar going away
after a send is wanted. So the cure is NOT narrowed — `sendMessage` gets no
special case and the record is not held armed for it.

Why it holds, beyond the ruling: the SERVER already thought so. A send takes its
read cursor to the tip, so before this the client was publishing a "you are
thousands behind" affordance over a channel the server considered read. The
change removes a disagreement rather than creating one.

The cross-device echo (`applyReadCursorSet`) was NOT put to him and carries no
ruling. It needs none — the bound covers it by construction, since the cursor
lands at the tip whoever moved it.

`measuredUnreadByChannel` (#947) is deliberately not cleared alongside: the pane
spends it only while `measured.at === cursor`, so a cursor that moved has
already expired it.

### Two siblings named, not folded in

Measured on the way and filed separately, because each fails differently and one
fix does not obviously cover them:

* issue 2052 — `applyJoinReply` lands the reply's cursor unconditionally, so
  after a POST that failed offline a rejoin moves the local cursor BACKWARDS to
  the server's stale value and the badge resurrects. It self-heals on the next
  successful forward write; the asymmetry is that forward-only holds on the
  write path and not on the join-reply path.
* issue 2053 — the INVERSE defect on the same branch: a window driven far behind
  by the #1229 ring cap, whose seed is a truthful zero from join time, shows NO
  badge while hundreds of rows are unread. There the seed is stale LOW and
  cannot rise; retiring the record on cursor catch-up does nothing for it,
  because the cursor is frozen and never catches up.

### Scope, declared

Store-level. jsdom gives the pane no geometry, so the read-at-the-tail door is
driven through its published verb rather than by scrolling, and nothing here
asserts the fix reaches a rendered badge in a browser.

_cic only. No wire change, no protocol bump, no migration — cic bundle deploy._
<!-- entry #2057 -->

---

## 2026-09-10 — issue 2057: the OTP app vsn was never a version, it was a path

A `VERSION`-only bump was COLD on `:jail` and `:linux`, and #1287 had already
established WHY: the bump moves the release's lib directory to
`lib/grappa-<new>/ebin` while the running node keeps resolving
`:code.lib_dir(:grappa)` to its BOOT directory, so `reload_modified/0` diffs a
stale tree against itself and answers `{"failed":[],"reloaded":[]}`. Production
served the old BEAM under new git history for ~6.5 hours on 2026-08-13 that way.

What had never been named is that this is not a property of deploying, or of
releases, or of the version number. It is one line of `mix.exs`. The repo-root
`VERSION` was read to stamp the **OTP application vsn**, and the app vsn is the
only thing that puts a number into a release's code path. Freeze it and the
class disappears: `@otp_vsn "0.0.0"`, a constant that never moves, with
`@version` left deriving from `VERSION` exactly as #652 built it.

### The bench, three arms, one live node

Measured on a real `mix release` (not the docker dev stack, whose bind-mounted
`mix phx.server` layout has no vsn in the lib path and would have passed for
the wrong reason), in an isolated tree, booting the release and asking the
**live** node rather than reading the disk:

| arm | live `:code.lib_dir(:grappa)` | `start_erl.data` after bump | `POST /admin/reload` | `/api/config` after |
|---|---|---|---|---|
| app vsn tracks `VERSION` (before) | `lib/grappa-1.5.5` | `1.5.6` | **409** `stale_code_path` | **1.5.5** — stuck |
| app vsn frozen, release vsn inherits | `lib/grappa-0.0.0` | `0.0.0` | **200** `reloaded:["Elixir.Grappa.Version"]` | **1.5.6** |
| app vsn frozen, release vsn tracks | `lib/grappa-0.0.0` | `1.5.6` | **409** `booted 0.0.0 / built 1.5.6` | **1.5.5** — stuck |

The first arm is the negative control and it reproduced the production 409
exactly, so the bench can see the defect it claims to cure. A side effect worth
recording: under the freeze the second `mix release --overwrite` left **one**
lib directory, where the tracking arm accumulated `grappa-1.5.5` beside
`grappa-1.5.6`. Stale sibling directories stop piling up forever.

### The third arm is the whole reason this entry is long

Freezing the app vsn while letting the release keep `version: @version` is the
obvious half-measure — it preserves an honest number in the tarball name — and
it is **catastrophic and silent**. `HotReload.audit_code_path/1` compares the
app vsn it reads off the booted code path against the RELEASE vsn in
`start_erl.data`. Frozen beside tracking, those two diverge on every bump and
never reconverge, so the audit refuses **every hot deploy, permanently**. The
cure becomes its own exact opposite and says nothing while doing it.

So the constraint is: the release vsn MUST inherit the freeze, i.e. the release
must have no `version:` key of its own. That is not enforceable by reading the
value — an inheriting release and a re-coupled one both produce a plausible
number — so the pin asserts the KEY IS ABSENT
(`version_single_source_test.exs`). This was predicted from the source and then
measured rather than shipped as a reasoned-about hazard.

### What was in the way, and it was a false zero

The proposal rested on "`Application.spec(:grappa, :vsn)` has zero consumers;
the only matches are prose". Re-measured, that is false in the way this repo
fails most often: the census had stopped at `lib/`.
`test/grappa/version_single_source_test.exs:67` asserted
`Application.spec(:grappa, :vsn) == @canonical_version` — not a stale test but
the #538/#652 PIN on the exact coupling being removed, with its rationale in
the comment above it: *"If they disagree the running node's .app would report a
version the source never declared."*

That is now true and deliberate, which is a thing a worker does not get to
decide. vjt ruled it (**relayed via the ircbot, not observed first-hand**): the
number in the source stays one — the `VERSION` file — and the second place is
the app vsn, which is a path component and not a carrier. The pin is
**rewritten as the pin of the DECOUPLING, not deleted**, because an accidental
re-coupling is silent and the inverted assertion is what catches it. Both
mutants were run and each kills exactly one assertion.

Two `Application.spec(:grappa, …)` readers do remain — `:modules`, a different
key — which also falsifies `Grappa.Version`'s own moduledoc claim to be the
only consumer. Corrected in place.

### What deliberately did NOT change

`stale_code_path` (#1850) stays. It is fair to observe that with both vsns
frozen it can no longer fire for the class it was written against, and that is
the correct outcome rather than an argument to delete it: prevention moved to
the ROOT, detection did not move at all. It never named `VERSION` — it compares
what the node booted against what the build wrote, whatever drove them apart,
and the third arm above is a live example of a route that has nothing to do
with a bump.

Also not taken: vjt floated running the jail the way docker runs, `mix
phx.server` over a bind-mount, hot by construction. The price is the whole
release — no `bin/grappa`, so no `rpc`, no boot script, no operator CLI — and
he did not pursue it. The decision here is to freeze a constant, not to change
substrate.

The price paid, in full: paths and the release tarball on the box read `0.0.0`.
Nothing consumes them — measured across `infra/`, `scripts/`, `.github/` and
`Dockerfile*`, every one of which names the unversioned
`_build/prod/rel/grappa`. The number an operator reads is `Grappa.Version`,
still baked from `VERSION`, still declared exactly once.
<!-- entry #2060 -->

---

## 2026-09-10 — issue 2060: the oracle counted the whole VM, and then multiplied a sample

`GrappaWeb.JoinSeedCostTest` went red eleven times between 2026-08-30 and
2026-09-10 on branches that could not have caused it. Two defects, one in the
instrument and one in the oracle. They are separable, they compound, and only
one of them is the one the issue named.

### The quoted red is not the assertion the issue diagnoses

The issue's diagnosis is the multiplicative assertion `eight.total ==
one.total * 8` — a relation between two measurements whose base is itself
sampled. That assertion exists and that reading of it is correct. But the
failure the issue quotes is a different arm: `join_seed_cost_test.exs:240` is
`assert length(one) == 2` inside *the SAME account through the /me door costs
2*, a FLAT PIN of one measurement with no base and no multiple in it.

That matters because it falsifies, on the issue's own evidence, the first of
the two cures the issue proposes. "Pin what `W=1` must cost" is precisely what
that arm already did, and it went red anyway. The base was not wobbling
because it was sampled and then multiplied; it was wobbling because the
measurement admitted work nobody in this file performed.

### What the counter was actually counting

`measure/1` attached a `[:grappa, :repo, :query]` handler with no filter at
all, deliberately: the moduledoc argued that a `self()` filter reads zero here
(true — `Phoenix.ChannelTest.subscribe_and_join/3` runs `join/3` in a spawned
CHANNEL process) and that `async: false` buys the unfiltered count back
because no sibling test is running to contaminate the mailbox.

The second half is true and insufficient. Sibling tests are not the only
emitters. The application supervisor runs three ambient sweepers and a
`Session.Server` per bound network in every env including test, and
`GrappaWeb.ChannelCase` puts the sandbox in SHARED mode for `async: false`,
which is exactly what lets an unrelated process's query execute on the
current test's connection.

Measured, on this branch:

  * `WindowCounts.bulk_snapshot/4` costs exactly two queries and their sources
    are `["read_cursors", nil]`. So the CI red's
    `["read_cursors", nil, "visitors", "visitors"]` is that pair plus two
    foreign reads — the door was never involved.
  * Driving `Visitors.list_expired/0` twice from a plain `spawn` inside the
    window reproduces the CI list source-for-source. That is now a committed
    control test.
  * On a live join, all seven door queries are emitted by the CHANNEL process
    carrying `$callers: [test_pid]`; the `Session.Server`'s own
    `Networks.mark_registered/1` write carries `$callers: nil` and the
    application supervisor as its ancestry.

#893 met the same class from the writing side and pushed the sweeper cadence
past any suite runtime (`config/test.exs`). That removes the ticks and leaves
every other ambient emitter, so it mitigates one instance rather than the
class.

### The cure: attribute by cause, then pin absolutely

`forward_query/4` now keeps an event only when the emitter is the test process
or carries it in `$callers` — the same provenance chain Ecto's own Sandbox
reads for automatic allowance. Nothing here names an interloper, so a new
ambient emitter needs no edit; and the fixture's registration write drops out
by CAUSE rather than being cancelled inside a delta, which is why the live
tally is now 7 where it was 7+1 and why `per_join_tally/3` is gone with its
reason.

With the measurement deterministic, the oracle stops being a ratio. Both storm
arms pin every W against a declared per-join tally and against no other
measurement, so a red names the read that changed and the W it changed at.
Widening the tolerance and swapping in an inequality were both declined for
the reason the issue gives: they trade a noisy oracle for a blind one.

Attribution can fail in two opposite directions and each has a control test:
the existing arm goes red if the counter ever reads zero, and a new one goes
red if it ever reads someone else's work.

### The mutation bench

Both properties are measured rather than argued, in a private worktree:

  * ambient emitter hammering `list_expired/0` for the whole file (697 foreign
    reads inside one `W=8` window): attribution off → 7/7 red; attribution on
    → 0/7.
  * one extra `UserSettings.get_highlight_patterns/1` inserted into the real
    `join_reply/2`, attribution on: red at `W=1`, naming `user_settings` 3
    against a declared 2.

So the instrument is neither credulous nor blind, and neither claim rests on
the other's absence.

### A retraction, and the class it widens

Predicted, then measured false: that the `async: true` query counters
elsewhere in the suite are protected, because an ambient process holds no
sandbox checkout and its query would be refused before it could emit. The
refusal happens (`DBConnection.OwnershipError`) — and Ecto emits the
`[:grappa, :repo, :query]` event anyway, `source: "visitors"` and all. So
ownership mode is not a shield. `async: false` merely also lets the foreign
query SUCCEED.

The exposed set is therefore every unfiltered counter, not just the shared-mode
ones. Fifteen test files attach to the repo query event; `BootCostTest` and
`RefreshPlanCostTest` filter on `self()` and are exact, because their work runs
in the test process. Four do not filter at all and pin something on the result:
`WindowCountsTest.count_repo_queries/1` (the `/me` constant-2 pin) and
`GrappaWeb.Admin.SubjectLabelsTest`'s verbatim copy of it, `ScrollbackTest`'s
`capture_one_query/1` — whose `[captured] = drain_queries(...)` breaks on ONE
foreign query rather than on enough of them to move a number — and
`NickMigrationTest`'s transaction-statement assertion. All four call their
subject in the test process, so `self() == test_pid` is the exact predicate
there. That is deliberately NOT done here: it is four files outside this
issue's subject, and the shape they share argues for one test-support harness
rather than four one-line patches.

### What is not claimed

Which process emitted the two `visitors` reads in CI run `34509867323` is
unknown and is not asserted. `Visitors.list_expired/0` is the verb that
produces that source and the ambient sweepers are its scheduled caller, but
their cadence is 24h under `config/test.exs`, so naming one would be a guess.
The fix does not depend on the answer: the window is closed to every emitter
that is not this test, whoever it was.
<!-- entry #2034 -->

---

## 2026-09-10 — #2034: a notification is dismissed by READING the conversation, not only by tapping it

The tap half shipped with the deep-link work: `notificationclick` calls
`event.notification.close()`. The other half never existed —
`getNotifications()` had zero occurrences in the whole cicchetto tree, so once
a banner was on screen nothing ever took it back. Reading a conversation in
the app left its banners in the shade, and a later tap yanked the reader to a
window they had caught up with minutes ago.

`lib/notificationDismiss.ts` is the missing half: on every moment a
conversation can come into view, enumerate what the registration is showing
and close the notifications naming the focused window. No new state, no new
server field, no bookkeeping to drift.

### Matching on the URL, not on the `tag` — and it is a correctness argument

The obvious shape is the one the issue proposed: `getNotifications({ tag })`
for the active conversation's tag. It does not work, and the reason is the
key/display split rather than taste.

`getNotifications({ tag })` filters by EXACT string, so the client has to
SPELL the tag — a second copy of `Grappa.Push.Payload`'s
`"<slug>:<channel_or_dm_peer>"` format living in cic. For channels the copy
would be right by luck (both sides fold). For a DM it is wrong by
construction: the server tags with `sender` RAW (`libera:Alice`), because a
nick's case is presentation and the payload keeps it, while the selection
store holds the CANONICAL window nick (`alice`). A filter built from the
selection asks for `libera:alice`, matches nothing, and closes nothing —
silently, in exactly the case DMs make most common.

So the match runs the other way: each open notification is resolved through
its own `data.url` — the deep link it would follow if tapped — by the
`parsePushTargetUrl` that the tap path already uses. That makes the identity
question one question with one answer, asked in two directions.

`pushTargetSelection/1` is the extraction that makes "one answer" literal.
`routePushTarget` walks the mapping forwards (a tapped notification names the
window to focus); the sweep walks it backwards (an open notification is asked
whether it names the window already focused). Both go through the same
`canonicalQueryNick` step, so the tap and the dismissal cannot disagree about
which window a notification belongs to. Channels need no step there, and the
reason matters more than the fact (review, 2026-09-10): it is NOT that
`setSelectedChannel` folds the channel KEY on the way in. It does (#1396), but
only the FORWARD path reaches the setter — the sweep never calls it. What
covers BOTH directions is `isActiveSelection`, which runs its own argument
through the same `foldChannelKey` before comparing. The distinction is not
pedantry: a later reader who drops the fold from the comparator, believing the
setter covers it, breaks the dismissal while every forward-path test stays
green. That asymmetry is also why the DM arm is the one carrying a test.

**Presence banners fall out for free, and that is the intended reading.**
`build_presence/3` deep-links to the same `?network=&channel=` shape, so
opening a peer's query also clears their online/offline banner. A tag filter
would have had to be taught this; matching on the window means the rule is
stated once — close what the reader is looking at — and both banner kinds obey
it.

### Two triggers, and one API choice

The reactive arm is `isDocumentVisible()` crossed with `selectedChannel()`:
that pair IS "the conversation is in view", covering both the tab coming back
and the reader switching windows while it is already in front of them.
`pageshow` is the second trigger for the reason `resumeProbe.ts` and
`DiagFloat.tsx` already carry it — an iOS PWA frequently thaws without
reporting a visibility transition, so the reactive arm never re-runs. The
sweep is idempotent, so the overlap costs nothing.

`getRegistration()`, not `serviceWorker.ready` (which `push.ts` uses).
`ready` NEVER settles when no service worker is registered, and this runs on
every focus flip and every window switch rather than once at opt-in — a
browser with SW disabled would accumulate one dangling promise per sweep for
the life of the session. `getRegistration()` resolves to `undefined` and the
sweep ends.

The sweep does not enumerate at all while the document is hidden. Not an
optimisation: a hidden tab is exactly where a notification is still doing its
job, so "visible" is a precondition of the whole operation rather than a
filter applied to its results.

**No e2e, and the ceiling is the harness rather than the effort.**
`self.registration.showNotification(...)` rejects under headless Playwright
with "No notification permission has been granted for this origin" even after
`context.grantPermissions(["notifications"])` — the finding `e2e/fixtures/
pushTap.ts` already documents for the TAP path, which is why that path is
driven through the cold deep-link and a replayed `navigate` message instead of
a real `NotificationEvent`. A dismissal test needs a notification that EXISTS,
so it hits the same wall one step earlier: with nothing shown,
`getNotifications()` returns an empty list and the sweep would pass while
closing nothing. vitest is therefore the ceiling here, and the spec pays for it
by asserting the DM canonicalisation directly.

### The residual: a notification arriving while its conversation is in view

All three triggers are TRANSITIONS — a visibility flip, a selection change, a
`pageshow`. None of them fires when the reader is already looking at the window
and the banner appears underneath it. That case is not handled here, and the
first draft of this entry claimed it was "handled one layer up" by
`shouldSuppressPush()` and called it "a state that should not occur". **Both
halves of that were wrong, and this tree says so in writing.**
`service-worker.ts` records that `clients.matchAll` visibility is UNRELIABLE on
iOS PWAs — an empty or non-"visible" client list while foregrounded — and #182
leaves the server-side gate deliver-leaning in the just-connected window on
every platform. So the residual lands precisely on the device this feature
exists for. Two independent blind reviews found it from those same two pieces
of evidence without reading each other, which is the strongest signal available
here that it is real rather than theoretical.

The mechanism is deferred, not denied: one `postMessage` from the push handler
to the visible client, or a sweep at the tail of `handlePush`, closes it. What
is NOT known — and would move the severity in either direction — is whether an
iOS banner over a foregrounded PWA produces a blur/focus pair at all. If it
does, `isDocumentVisible()` flips and the reactive arm already self-heals the
whole case on that platform. The tree carries no note either way and no device
was measured.

### The race between asking and acting

`getRegistration()` and `getNotifications()` are IPC round-trips to the service
worker, not microtasks, so the gap between reading `isDocumentVisible()` and
closing anything is real wall-clock time. A reader who switches to `#sniffo`
and then locks the phone can have a push for `#sniffo` land and be SHOWN inside
that gap — the suppression gate being leaky in exactly that direction, per
above. The list then comes back holding a brand-new banner, the selection has
not changed, and a single-check sweep closes a notification the reader never
saw.

That is the one failure mode here that DESTROYS information rather than
withholding it, and it inverts the module's own posture ("a hidden tab is
exactly where a notification is still doing its job"). The cure is to
re-establish the precondition immediately before acting on it rather than only
when it was first asked. Structural, not observed: no instrumentation says this
has fired in the field.

### Two known approximations, stated so they are not rediscovered as bugs

`parsePushTargetUrl` decides channel-vs-query from four hardcoded RFC-2812
sigils (`# & ! +`) and ignores the network's advertised CHANTYPES, though
`lib/chantypes.ts` exists. On a network advertising an exotic chantype a
channel notification is classified as a query, gets `canonicalQueryNick`
applied, is compared against a channel selection, and is never dismissed. That
is pre-existing tap-path behaviour; what changed here is that the same
approximate parse became load-bearing in a SECOND direction.

A notification with no usable `data.url` is left alone rather than closed on a
guess — unrecognised is never fatal, and leaving a banner up is the harmless
direction of that error, whereas closing on a guess destroys a notification
nobody read.

### What was checked and cleared

"The shade empties but the badge does not" is the obvious fear and it does not
land: `lib/badge.ts` re-pulls the authoritative `/me` count on every visible
event and force-applies it, bypassing the signal-equality skip, so the badge
axis is server-authoritative and independently reconciled. Verified for the OS
icon badge and the `document.title` mirror; the in-app sidebar counters were
not audited. `installNotificationDismiss` being non-idempotent is fine — the
sibling `installPushTargetListener` is equally so, `main.tsx` calls each once,
and the sweep is idempotent regardless.
<!-- entry #2064 -->

---

## 2026-09-10 — issue 2064: three more blind windows, and the harness this log asked for is the wrong shape

The entry above closed by naming four test files that attach to
`[:grappa, :repo, :query]` with no filter at all, and by saying that "the shape
they share argues for one test-support harness rather than four one-line
patches." Three of those four are cured here — one line per attach site, no
harness. This entry records why that sentence is withdrawn, and one thing both
it and the issue got wrong about the mechanism.

### The mechanism is the GLOBAL attach, not the shared sandbox

The 2060 entry and issue 2064's body both attribute the leak to `async: false`
putting the Ecto sandbox in SHARED mode, so a stranger's query runs on the
test's own connection. That is true of two of the three files, and it is not
the mechanism. `WindowCountsTest` is `async: true` — it owns its connection and
no stranger can borrow it — and its counter is contaminated all the same,
because `:telemetry.attach/4` is VM-global: the handler fires for every emitter
in the node, whatever connection, whatever sandbox owner, whatever test the
query belongs to. Shared mode decides who may USE the connection; it decides
nothing about who is HEARD. Under `async: true` the strangers are just the
other async tests running concurrently.

That distinction is what a later reader needs. "Make the file `async: false`"
is not a cure for this class, and an `async: true` file is not exempt from it.

### Measured, two-sided

The bench: one ambient stranger injected inside each helper, before the subject
runs — a bare `spawn`ed process (so no `$callers`, the shape of a sweeper or a
`Session.Server`), allowed on the sandbox, running
`Repo.transaction(fn -> Repo.query!("SELECT 1") end)`. Built, measured, and
removed; it is in no commit.

| state | failures |
|---|---|
| before any change, no stranger | 0 / 232 tests |
| blind counter + stranger | **8** — `WindowCountsTest` 2, `ScrollbackTest` 5, `NickMigrationTest` 1 |
| `self() == test_pid` + stranger | 0 |
| `self() == test_pid`, stranger removed | 0 / 232 tests |

So each file still carries a live positive control inside its own asserts: the
predicate keeps exactly the work the pinned numbers describe, and blinding it
again turns eight of them red.

Issue 2064's table reports `ScrollbackTest` at 6, not 5. Six tests reach that
file's two helpers; the sixth is the `rename_dm_peer` plan test, which picks
its statement out of the captured list by CONTENT (`Enum.find` on an
`UPDATE ... "dm_with" =`) rather than by position, so an added stranger cannot
displace it. Whether the earlier bench differed in shape or in injection point
is unknown; 5 is what this instrument measures and it is not offered as a
refutation of 6.

### Why one line each, and not the harness

Four attach sites, not three — `ScrollbackTest` has a plural twin
(`capture_queries/1`) beside `capture_one_query/1`. What the four share is the
PREDICATE, one expression. What they do not share is everything else: the
payload is a bare tick, a `{sql, params}` pair, or a lowercased statement; the
drain is a counter, an ordered list, or a reversed list; the handler id is a
`{__MODULE__, ref}` tuple in two files and an interpolated string in the third.
A harness would have to be parameterised on payload and on drain, which is the
entire body — it would share the twelve lines that differ in order to share the
one that does not. Lightweight over heavyweight (CLAUDE.md design discipline
(4)): the mechanism would be heavier than the problem, so the mechanism would
BE the problem. The measured cure is four guarded handler bodies.

### What is not claimed

`capture_queries/1` is cured for CONSISTENCY, not on a measured red — its one
caller is content-addressed, as above. Leaving one blind attach beside a cured
one in the same file would leave two patterns for the next caller to copy, and
the next caller may well index by position.

`NickMigrationTest`'s second oracle (`refute transaction_statements(...) == []`,
the complement that stops the fix degrading into "never transact") asserts
PRESENCE, so a stranger's savepoint can only mask a regression there, never
manufacture one. The blind-counter red on its sibling proves the stranger's
savepoint does enter the list; that the masking direction is therefore reachable
is an inference from that measurement, not a separate measurement. It was not
probed, deliberately: `Grappa.NickMigration`'s own moduledoc already records
that no test can kill a mutant deleting `immediate_transaction/1` today, for a
reason independent of this one, and the strength of that oracle is that
module's subject rather than this issue's.

`GrappaWeb.Admin.SubjectLabelsTest`, the fourth file, is untouched here — it is
issue 2065.
<!-- entry #2059 -->

---

## 2026-09-10 — #2059: the most frequent red in the repo was not a flake, and it was two defects

`cicchetto/e2e/tests/issue1796-reconnect-bounces-network.spec.ts` had gone
red **17 times since 2026-08**, on branches with nothing to do with it. It
was rerun past, attributed to branches, and tracked as a flake sixteen
times. It is not a flake. The spec is honest on both of its assertions, and
the product fails each of them by a different mechanism.

Sighting 17 (2026-09-10, run `34497776963`) was the first on clean `main`,
which settles that no branch is NECESSARY to reproduce it; the next run on
main was green, which settles that it is intermittent rather than healed. A
green does not acquit the mechanism any more than a red convicts the branch
that happens to host it — the race is sensitive to main-thread latency, so
a branch can move its probability without being its cause. Several past
attributions did not clear that bar.

### Defect A — a sampled transition cannot see a park shorter than the sample

UX-4 bucket D (`selection.ts`) redirects the operator to Home when the
network they are looking at goes INTO `:parked`. It derived that transition
by SAMPLING `networks()` — the answer to a GET — against a per-slug Map of
the previous value:

```ts
if (curr === prev) continue;                       // ← the redirect died here
if (curr !== "parked" && curr !== "failed") continue;
```

`/reconnect` parks and reconnects immediately. Both legs emit
`connection_state_changed` and each triggers a `refetchNetworks()`, but a
GET issued at the park leg is not guaranteed to OBSERVE the park: by the
time the server answers, the credential can already read `connected`
again. The sampled sequence is then `["connected", "connected"]`,
`curr === prev`, and the redirect is lost in silence. The measured
signature at sighting 16 was exactly that — the store never held `parked`.

The cure reads the EVENT, which carries `to` and cannot be outrun by the
refetch it triggers. That is not a new pattern: `userTopic.ts` already
makes the same move three lines above that refetch, with
`patchHomeNetwork(payload.network)`, added by REV-J M15 to close "the
temporal window where Sidebar saw the new state but HomePane hadn't yet".
Bucket D was the last consumer still sampling.

**Two feeds, one observer, one memory.** The sample is NOT removed, and
deleting it would have been the smaller change and the wrong one: Phoenix
PubSub does not replay, so after a WS gap the refetch is the only evidence
that a park happened while the client was deaf. Both feeds are load-bearing
for opposite reasons — the sample survives a lost event, the event survives
a park shorter than a round-trip. Rather than a second observer with its
own state to keep in step, both call ONE `observeConnectionState`, which
owns the only Map: the event writes it first, so the sample that lands
afterwards sees `curr === prev` and does not fire a second redirect.

### Defect B — a second refetch in flight is dropped, not queued

Measured on the same bench, and NOT the same defect: with two
`refetchNetworks()` issued back to back, the second GET never leaves.
`createResource.refetch()` does not start a second fetch while one is in
flight, so the caller's request is simply lost. Driving the bench with
three distinct states (`connected` → GET1 `parked` → GET2 `failing`) leaves
the store on `parked` with the second stubbed answer still queued,
unconsumed.

It reaches the SAME spec from the other side. That spec asserts the
operator lands on Home AND that the network section loses its greyed class;
losing the unpark refetch keeps the parked row in the store, so the section
stays grey and the Home parked card stays up with nothing scheduled to
correct it. Curing only A could therefore have left the spec red and looked
like the cure had failed.

The cure queues a TRAILING refetch: any number of calls arriving during a
flight collapse into exactly one follow-up, started when that flight ends.
The invariant worth holding is "a refetch requested after the last state
change is answered after it" — one trailing run buys that without turning a
burst of N events into N round-trips.

**The independence is measured, not argued:** unwiring A alone leaves B's
arm green (mutation M5).

### What the bench had to be taught, three times

Every negative control in the first cut of this bench passed for the wrong
reason, and the mutation bench is what found all three. This is recorded
because the failure mode is generic, not specific to this file.

1. The other-network arm fired at a slug absent from the mocked network
   list, so the first-sighting guard (`prev === undefined`) stopped it
   before the slug test was ever consulted. Deleting the slug test left it
   GREEN.
2. The no-op arm used `connected` → `connected`, which the same-value test
   stops before the parked/failed gate. Deleting that gate left it GREEN.
   It now uses `connected` → `failing` (#1675 put `:failing` in the closed
   set) — a genuine transition of the selected network that is not a park,
   so only the gate can stop it.
3. The sibling-defect arm asserted a value the store ALREADY HELD at mount,
   so `waitFor` returned on its first tick without any GET having answered.
   Fabricating the swallow left it GREEN. It now ends on a third state the
   store has never held.

The general rule: **an assertion that holds before the action measures
nothing, and a control nobody has mutated is a control nobody has tested.**

### Not established, and not to be rounded off

* That the run at sighting 16 took defect A's mode is INFERRED, not
  measured — the HAR leaves 19 ms of margin. What is measured is that the
  store never held `parked`, and that the bench reproduces the collapse.
* Whether either defect is what produced any GIVEN one of the 17 sightings.
  They are reproduced here store-level; attributing a specific historical
  red to a specific mechanism is not something this work did.
* `refetchChannels` and `refetchUser` have the same shape as `refetchNetworks`
  and are therefore open to defect B. They are NOT changed here: nobody has
  measured a caller that issues two of them back to back, and serialising a
  refetch nobody has measured changes timing for callers this slice never
  looked at.

_cic only. No wire change, no protocol bump, no migration — cic bundle deploy._
<!-- entry #2067 -->

---

## 2026-09-10 — issue 2067: the delivered push and the withheld one both said nothing

Two paths through the push stack produced no output of any kind, and the
absence of output was read — correctly, given what the code offered — as
absence of work. `Push.Sender.send_to_subscription/2`'s vendor-2xx arm
returned without a `Logger` line while every OTHER arm of the same `case`
logged (five calls, not the four the issue enumerates — it misses the
`delete_dead` `:db_unavailable` degradation), and
the `#182` foreground gate in `Push.Triggers` skipped an entire fan-out
inside a bare `if`, with neither a line nor a counter. So an operator with
no notification on their phone and an empty `journalctl -u grappa | grep
push` could not distinguish three quite different situations: the trigger
never fired, the trigger fired and the gate held the push back, or the push
was delivered and the phone dropped it. The issue was filed off a live
debugging session where the answer turned out to be the second — a
client socket stuck reporting the foreground — and reaching that answer
needed three RPCs into a running node.

### The level is the decision, not a detail

`info`, for both lines. `debug` is below the level this ships at —
`config/prod.exs` pins `:info` and `config/runtime.exs` defaults `LOG_LEVEL`
to the same — so a `debug` line answers the operator's question exactly as
badly as the silence did for anyone who has not already reconfigured their
logger, which is everyone at the moment they need it. The sibling
`push.send subscription gone — deleted` has sat at `info` since B2 for the
same class of event, so `info` is also what the module already does.

The counter-argument is volume, and the first draft of this entry answered
it wrongly. It claimed the lines are "one per notification, not one per IRC
message", which holds only for the DEFAULT prefs. `channel_messages_all` is
a real pref and `channel_match?/4` returns `true` unconditionally when it is
set, so an operator who turns it on has asked for a notification per channel
message and gets a log line per channel message to match — `push.send
delivered` while their devices are backgrounded, `push.trigger suppressed`
while the PWA is on-screen. The honest statement is that the PREFS set the
rate: the defaults (`channel_messages_all: false`, `channel_mentions: true`,
`private_messages_all: true`) need a DM or a mention and are rare,
`channel_messages_all` needs nothing and is not, and `LOG_LEVEL` is the knob
for anyone who does not want the consequence of their own pref. Stated
rather than bounded away, because the level decision above rests on it.

### What was NOT added, and why

No success telemetry. The issue's text reads the existing events as
error-only (`"Telemetry fires on the error paths (:222, :246, :304)"`), but
`[:grappa, :push, :send, :stop]` carries `%{success: x, gone: y, error: z}`
— the success axis is already exported, at the fan-out aggregate where a
rate belongs. A per-subscription success counter would restate a number the
aggregate already has, which is design-discipline (1): derive, do not
duplicate. Only the LOG half of that half of the issue was missing.

No new Logger metadata key. `:reason`, `:network`, `:subject_kind`,
`:user_id`, `:visitor_id` and `:endpoint` are all already in the
`config/config.exs` `:metadata` allowlist, so this slice edits no config file
at all. That matters twice: an undeclared key is dropped at FORMAT time (the
call site compiles, the line fires, the operator reads it bare), and any
touch of `config/*.exs` turns a hot deploy cold. Reusing declared keys buys
both — and it is also what decided the two shapes below.

`:network` on the suppression line but not `:channel`, though `:channel` is
allowlisted too and the message path knows it. One reporter serves both
doors and the presence door has no channel, so taking it would either split
the reporter in two or print an empty field half the time. The network is
the context both doors carry, and on a multi-network bouncer it is what
turns "something was withheld" into "something was withheld on azzurra".

`endpoint:` stays the full vendor URL on the delivered line, and that is a
call worth naming rather than leaving to be discovered. A Web Push endpoint
is a CAPABILITY — holding it lets anyone POST to that device — and while it
already rode all of this function's failure arms, the frequency now goes
from broken subscriptions only to every successful delivery, into a stdout
that persists across restarts and ships out with any log forwarder. The
alternatives are what settled it. `Push.VendorLog` logs the host alone
(#1321, "a path segment can itself be a credential") and can afford to
precisely because its own moduledoc names THIS line as the correlation
anchor; host-only here would leave nothing to anchor to and could not
separate two iPhones on `web.push.apple.com`, which is the multi-device case
the line exists for. A subscription row id would be the clean answer and
costs a new metadata key, hence a cold deploy. If the exposure is judged to
outweigh the correlation, the cure is `:vendor` here too plus that id, the
next time something else is already paying for a cold deploy.

### One reporter, two doors, and the ordering that carries the meaning

`Triggers` has two dispatch paths — the message one and the `/notify`
presence one — and both end at the same gate. They report through a single
`report_suppressed/2` emitting a single `[:grappa, :push, :suppressed]`
event, rather than one event per path: an operator asking "how often is
push being held back?" must not have to add two counters, and two call sites
maintaining two spellings of the same event is exactly how they drift.

The gate stays the SECOND conjunct of the `and` at both call sites, and that
placement is now load-bearing rather than incidental. Short-circuit
evaluation means a message the prefs never matched never reaches the gate
and therefore cannot be counted as suppressed. Reversing the conjuncts would
leave the code delivering identically while making the new event report
every non-notify-worthy PRIVMSG as a withheld push — the old lie, in a
louder voice. Three tests pin it from both sides: a visible device with a
matching message emits the event, a visible device with a NON-matching
message emits nothing, and a delivered fan-out emits nothing either.

Inside the reporter, the `Logger` call precedes `:telemetry.execute/3`, also
deliberately. Anything observing the counter is then guaranteed the message
is already on its way to the handlers, so the two halves of one withholding
can be correlated without a sleep — which is what lets the test capture the
rendered line out of a detached Task deterministically.

### Why the delivered line sits above `touch_last_used/1`

The fact being reported is the vendor 2xx, and it has already happened by
the time the row-bump runs. Logging inside the `{:ok, _}` sub-arm would mean
a failed `touch_last_used/1` erases the record of a delivery that did occur,
leaving the bump's own warning as the only trace of a SUCCESSFUL send — a
smaller version of the bug being fixed.

### What is not claimed

Nothing here changes what is delivered; every branch returns exactly what it
returned before, and the boolean the gate produces is unchanged. This is an
observability slice and it fixes no delivery defect.

The reported incident is not reproduced. The self-hoster's always-visible
socket (instance `h-irc`, 1.5.5) is described in the issue and taken as
given; nothing was measured against that instance or any production node
from here, and whether these two lines would in fact have shortened that
evening is an inference from what they now print, not an observation. The
root cause of a socket stuck at `visible` is untouched and remains open.

`suppression_reason()` has one member. It is a closed type with one atom
rather than a bare `:foreground_visible` literal because it is published on
the telemetry metadata; no second reason is anticipated, and none is
invented here to justify the shape.

`[:grappa, :push, :suppressed]` counts withheld TRIGGER DISPATCHES, not
undelivered pushes, and the difference is a real population: a subject with
the PWA open and NO registered device is counted, though
`Sender.send_to_subject/2` would have hit its empty-list arm and sent
nothing either way. Deliberate, on a layering argument — this module decides
whether to dispatch, `Push.Sender` owns what a dispatch reaches — and on
cost: separating them means a `push_subscriptions` read on EVERY
suppression, which under `channel_messages_all` is per channel message, to
answer a question the device-list UI already answers directly. Anyone
reading the counter as "pushes the user did not get" is reading it wrong,
which is why the moduledoc says what it measures instead of posing the
looser question the first draft posed.

The rendered-output tests lower the global Logger level and therefore live
in their own `async: false` file (`push/observability_log_test.exs`),
following `client_tls_posture_log_test.exs`. They assert the FORMATTED line,
which is the only thing that can catch an allowlist drop; the behaviour they
sit next to — that the gate suppresses at all — stays pinned where it was.
<!-- entry #2069 -->

---

## 2026-09-11 — #2069: one question, one function, two anchors

vjt on staging: three ways of saying "how many rows are behind my cursor in
this window", disagreeing with each other and moving without anyone reading
anything. (A) open a channel with hundreds unread, read nothing, look away and
back — 500 becomes 800. (B) take the "2900 unread — jump back" affordance,
change channel, come back — 200, which is the fetch page. (C) the in-pane
divider counts join/part/quit/nick as unread "messages"; the sidebar pill does
not.

The issue proposed mechanisms for A and B and said outright that neither was
reproduced. Both proposals were wrong in an instructive way, and finding that
out cost less than curing them would have.

### What was measured, on `b7989f4ba`, before anything was changed

Against the real `scrollback` + `readCursor` + `selection` stores and a fake
server that honours `after`/`before`/`limit` and answers its probe out of the
same log it serves — with a MIXED log, every fourth row a peer JOIN, because a
uniform log cannot see any of the three defects.

**C is three divergences, not one, and they run in both directions.** Over one
fixture of 150 rows past the cursor (113 peer messages, 37 peer JOINs):

| rows past the cursor | sidebar pill | in-pane divider |
| --- | --- | --- |
| 113 peer messages + 37 peer JOINs | 113 | `150 unread messages` |
| 5 peer + 5 own messages | 5 | `10 unread messages` |
| 5 numeric-derived NOTICEs | 5 | no marker at all |
| 50 peer JOINs | 0 | `50 unread messages` |

The label says "messages". Two of those rows say the pill was right; the third
says the DIVIDER was, because `notice` is a content kind and the derived pill
counted a 401 the operator's own `/msg <ghost>` produced.

The reason all three exist is one stale sentence, and it is in the source.
`operatorActionEcho.ts` and `ownPresenceEvent.ts` each claim to be the "single
source of truth" shared by "subscribe.ts (the sidebar badge gate)" and the
in-pane marker. That was true while the badge was BUMPED per row. `subscribe.ts`
still calls both predicates — the early return is right there — but since the
2026-06-01 bucket-B2 change the badge is DERIVED from `(scrollbackByChannel,
readCursors, serverSeedCounts)`, and the derivation never saw them. The gate
kept guarding the mention beep and stopped guarding the thing its own comment
names. Nothing broke loudly; two surfaces drifted apart one row class at a
time, and the comment stayed.

**A does not reproduce as reported, and the mechanism the issue named is not
the cause.** A bare re-select with no traffic moves nothing — measured across
two re-selects on a far-behind window, on a not-far-behind window (gap 150) and
on a just-far-behind one (gap 250): stable in all three. What moves is the
far-behind count while the operator is AWAY. `appendPageToScrollback`
accumulated it by the content-ness of the row the ring cap EVICTED rather than
of the row that ARRIVED, and added nothing at all while the store sat under
`UNREAD_RETENTION_CAP`. Measured: 500 arrivals took it to 4012 against a server
answer of 4125, and the per-step error was neither constant nor signed
(-75, -113, -113). Then the re-select's `?after=<high-water>` page came back
FULL, which fires the gap probe, which re-anchored and OVERWROTE the drifted
number with a fresh measurement: 4012 → 4125 in one step, no scroll, no read.

So the discriminator the issue asked for — "does a re-select re-probe
`/messages/count`?" — has the answer YES, conditionally, and the re-probe is
the CORRECTION rather than the cause. Curing the visible step would have left
the drift, which is the number the operator actually reads for as long as they
stay away.

**B reproduces, and it is worse than reported.** It does not stop at the page
size. The jump retires the far-behind record, the pill falls back to counting
held rows, and as the operator reads through the one page the jump loaded the
count reaches ZERO on a window with thousands unread: 3750 → 150 → 0, cursor at
1200, server answer 3600. The measurement that answers every one of those was
already on file — `measuredUnreadByChannel` (#947), written by that same jump —
and only the divider ever spent it.

### The shape

`lib/unreadCount.ts` publishes one row predicate and one region count. Both
surfaces call them and neither re-derives.

The issue asked for "one variable … it must not change while the cursor does
not move". That is right for the DIVIDER and wrong for the PILL, so what ships
is one FUNCTION at two anchors rather than one value read twice. The divider
passes the frozen cursor and the frozen session top (the freeze contract: the
line must not renumber under a reader). The pill passes the live cursor and no
bound, because a pill that ignored arrivals while the cursor sat still would
stop saying the window is receiving traffic, which is the pill's whole job.
Same population, same unit, same source-selection; different anchors, on
purpose.

PLACEMENT is deliberately BROADER than the count. The line marks where the
operator left off, so it goes above the first row somebody ELSE produced,
message or presence, while the label counts only messages. Narrowing placement
to content would leave a run of peer JOINs sitting above the line, rendered as
if they had been read.

A is cured at the accumulator: count ARRIVALS (fresh rows above the pane's
previous newest), not evictions. Exact, independent of the cap, and it leaves
the probe nothing to correct — which is what removes the visible step. The
eviction-side bookkeeping (`contentDropped`, `keptContentCount`) is deleted
rather than kept beside it.

B is cured by letting the pill spend the same #947 record, minus what the
cursor consumed, so the number falls by what was READ instead of by what was
FETCHED. The record gains `through`: the top of the contiguous run the pane can
account for, written by the jump and extended by `loadNewer` as the pane pages
forward. The subtraction is only sound while every row the cursor passed is one
the pane HELD, so past that run the record stands down rather than answering
with a number it cannot support — an own send lands the cursor at the tip with
nothing unread, and a record that kept spending would report thousands. The
count is a FLOOR (`max(local, count - consumed)`), not a replacement, so local
truth overtakes it as the region comes back and nobody has to remember to
retire it.

### What this does NOT fix, stated rather than discovered later

* **The server's population and the client's differ by numeric-derived
  NOTICEs.** `Scrollback.count_after_split/6` excludes own-authored rows but
  knows nothing about `meta.numeric`, which is a client concept. So
  `count - consumed` can run high by the number of such rows the operator read
  inside the measured region. Bounded, rare (they land in `$server` and ghost
  query windows, not busy channels), and NOT cured with a second predicate for
  the subtraction — a second predicate is the fork this entry exists to remove.
* **The arrivals accumulator counts own-authored content**, exactly as the
  eviction one did. It has no `ownNick` to fold against without an import cycle
  into `networks`, and the far-behind cursor is frozen, so an own send adds one
  either way. No regression, no cure.
* **A cross-device read-ahead still under-reports.** The peer device moves the
  cursor past rows this pane never held; the record stands down and the pill
  answers from local rows. That is what it did before, and inventing a number
  there would be worse than a low one.
* **The SHORT-page arm of `jumpToUnread` is very nearly unreachable.** A
  far-behind window has >200 unread by definition and `resumeFrom` does not
  move, so `after(resumeFrom, 200)` is always full. Its `clearMeasuredUnread`
  branch is near-dead. Named, not deleted: it is the correct answer if the
  region ever shrinks under it (an archive purge), and the test that tried to
  construct it is the one arm of this slice that had to be replaced by a
  property that IS reachable.

### The bigger answer, not taken here

The server already pushes per-window `messages`/`events` on `window_counts`,
on every message and on every cursor advance, and cic throws them away
(`selection.ts` says so in as many words, citing #239 — that the presence
filter is a client concern, which is true of the EVENTS bucket and not of the
MESSAGES one). Adopting that field would collapse `serverSeedCounts`,
`farBehindByChannel.missed` and `measuredUnreadByChannel` into one
authoritative number and delete every accumulator in this entry. It is a
redesign of the client's unread model, not a bug fix, and it is a decision for
vjt rather than one to take inside a slice that was asked to stop three numbers
lying.

### Evidence

Six mutants, one per mechanism, each killed by named arms with the unmutated
tree green at 7026 (control run first, tree restored by `git checkout` after
each): dropping the operator-echo clause (3 deaths, one of them a
PRE-EXISTING pane test, which is what proves the pane is wired to the shared
predicate), dropping the local floor (2), dropping the `through` guard (3),
dropping the content split (21), disabling the arrival count (4, one of them
the pre-existing #1229 arming test), and making the pill ignore the
measurement (4).

The browser witness is `issue2069-one-unread-number.spec.ts`, and it is the
only place the two numbers are visible AT ONCE — which is how vjt noticed. It
asserts both premises rather than assuming them: that the unread run really
contains peer presence rows, and that those rows RENDER (`#spec-wN` is far
under `LARGE_CHANNEL_THRESHOLD`), because a hidden presence row is excluded
from the old count too, by a different rule, and the spec would be green on the
broken build.

### The e2e that was green for the defect's reason

The full `scripts/integration.sh` over this branch turned one red inside the
slice's own subject — `unread-cursor-cluster.spec.ts`, "focused send collapses
the in-pane unread marker immediately" — and the honest reading of it is the
opposite of the obvious one, so it goes on the record rather than into the diff.

Attribution, measured on both refs rather than argued:

| | this branch | base `b7989f4ba` |
| --- | --- | --- |
| `unread-cursor-cluster:184` | 1 red in 5 | 10 green in 10 |

So the slice caused it. What it did NOT do is break the behaviour the spec
describes. `sessionTopId` latches the tail of the FIRST non-empty observation
the pane makes, and every row above that latch is a live arrival that draws no
marker on purpose — the operator watched it land. The spec sends the peer's
PRIVMSG and navigates immediately, so which side of the latch that row falls on
was never established by its setup. The awaited `peer.join` before it reliably
WAS inside the latch, and while the divider counted presence rows the JOIN alone
injected `1 unread` — so the spec went green, in that ordering, on the strength
of the exact defect this entry is about. Restrict the count to messages and the
stand-in disappears; the unguarded ordering stops being masked and starts being
a flake.

That is a precondition the spec depended on and never established, not a
weakened contract, so the cure is to establish it (`assertMessagePersisted`
before the navigation) and the assertion is untouched. Measured after:
**20 green in 20**, against a pre-fix rate of 1 in 5 — `0.8^20 ≈ 1.2%` if the
ordering were still free.

Both directions of the mechanism are now pinned in-process, so the browser is
no longer the only witness: `b7989f4ba` renders `1 unread` for a lone peer JOIN
(its own `DOES count peer JOIN row toward the unread marker`, re-run on the base
to measure it rather than cite it), and this branch renders no marker for the
same fixture plus a late-arriving message ("draws no marker when only a peer
JOIN precedes the session top and the message lands live").

The general rule this leaves behind: **when a slice narrows what counts, every
green that was resting on the wider count becomes suspect, and a spec whose
precondition was satisfied by the discarded rows will fail for the right
reason.** Read such a red as an oracle before reading it as a regression — but
prove which it is on both refs, because the two are indistinguishable from the
red alone.

### The fifth command, and why a green first command does not vouch for it

CI turned this slice's own browser witness red on one shard —
`issue2069-one-unread-number.spec.ts`, `IrcPeer: timeout waiting for part
#spec-w0 (5000ms)` — while the full local suite had passed it twice. The frame
was in `fixtures/ircClient.ts` rather than in an assertion, which is suggestive
and proves nothing: a shared fixture can be the victim as easily as the culprit.

It reproduces, and hard: `--repeat-each 20` on the unfixed tree gives **9 reds
in 20**, every one carrying that identical signature. So the argument never had
to be settled on the code.

What is MEASURED is that the cost tracks the command's POSITION in a burst
rather than the clock. The spec fired JOIN + 3×PRIVMSG + PART back to back on
one connection, making the PART the fifth command, and `IrcPeer.part` waits for
its own echo on `PART_TIMEOUT_MS` = 5s. **`IrcPeer.join` carries the SAME 5s
budget and timed out zero times across those 20 runs.** First command always
fine, fifth command half the time not — which is why a spec can be green a
hundred times on its first wait and still be a coin flip on its last.

What is INFERRED, and must be written as inference, is that this per-command
cost IS bahamut's fake-lag bank. That name was READ — from the `whoisAway`
comment in `fixtures/ircClient.ts` and from the ircd source — and **reading a
mechanism tells you a path EXISTS, never what it costs**. #800/S7 exists
precisely because two retractions in one cycle came from treating that reading
as a measurement, and the instrument it built (`Grappa.IRC.FakeLag`) does not
close the gap here: it accounts GRAPPA's own socket, while the peer in an e2e is
a separate irc-framework connection that instrument never sees. Any
per-connection serialisation would fit all three measurements equally well.

The cure is therefore built on the measured half and not on the name — which is
also why it survives if the name turns out wrong.

Cured by draining whatever the burst filled, on an OBSERVABLE signal: poll until the three
messages are on the server (the endpoint the spec was already polling
afterwards), THEN send the PART, so it goes out alone. **No timeout raised, no
assertion touched.** Measured after: **20 green in 20** — `0.55^20 ≈ 6e-6` had
the rate stayed where it was.

Three things worth carrying forward. First, **the timeouts in `ircClient.ts` are
not interchangeable**: `join`/`part`/`nick`/`mode`/`kick` sit at 5s while
`topic`/`privmsg`/`whois` sit at 15s, and the 15s ones carry a comment saying
why. A wait's budget is only sound for the POSITION its caller occupies in a
burst, and nothing in the API says which position that is. Second: **a burst of
IRC commands on one connection is not a setup step, it is a queue** — barrier
between the plants and the closer, or the closer inherits every penalty the
plants earned. Third, the epistemic one, because it is the trap this very entry
walked into on its first draft: **name the mechanism only as far as you measured
it.** "The fifth command costs what the first does not" is measured here and
carries the cure on its own; "the fake-lag bank did it" is a reading, it names
a path rather than a price, and it would have shipped as a fact if nobody had
asked which of the two it was.

Six other specs call `IrcPeer.part`; the closest, `issue2037`, fires four
commands where this one fired five. They are not touched here — none has been
seen red, and widening a cure past its measurement is how a fixture acquires
ballast nobody can later justify. The mechanism is written down so the next
sighting is diagnosed in one reading instead of re-derived.
<!-- entry #2071 -->

---

## 2026-09-11 — #2071: the far-behind record's events bucket, counted in a population the pane does not share

vjt on staging (`1.5.5-4a33c6747`): an unread counter that keeps climbing on a
window already looked at, cursor standing still, **only on a DENOISED channel**.
The issue filed three candidates and said so — *"a candidate list, not a
diagnosis"*. It is none of the three. All three are killed below with numbers,
because reading a mechanism tells you a path EXISTS and never that it is the
one that fired.

### What actually moves

The far-behind record (#693) carries the pair `count_after_split/6` returns — a
MESSAGES bucket and an EVENTS bucket — and it is SEEDED from exactly that call,
taken behind `Grappa.PresenceFilter.Resolver`. It is then MAINTAINED
client-side, and both maintenance sites counted RAW kinds:

* `capScrollbackRing` opened it at `events: unreadHeld - contentHeld` — the raw
  remainder of the unread region;
* `appendPageToScrollback` accumulated arrivals at `else arrivedEvents++`.

Neither asked `presenceRowVisible`. So the record is seeded in the FILTERED
population and grown in the RAW one. On a channel showing presence those
coincide and nothing is visible; on a denoised one they differ by the channel's
whole presence volume, and the difference is rows the pane never renders — so
the operator cannot read it away, and it only ever goes up.

Measured on `4a33c6747`, 3:1 join:message log, 30 arrivals per batch, cursor
pinned throughout, oracle = the server's own answer for that cursor:

```
denoised   pill 0 -> 22 -> 45 -> 67 -> 90     server answer 0 at every step
shown      pill 600 -> 622 -> 645 -> 667 -> 690   == server answer, exactly
```

One bit of fixture differs between those two lines. The cure is therefore the
FILTER and not the bucket: `eventHeld` is a count of its own (visible,
non-content, unread) rather than a subtraction, and the arrivals loop gates its
events half on `presenceRowVisible`. Its content half does NOT, and that
asymmetry is deliberate — no content kind is in `SUPPRESSED_PRESENCE_KINDS`, so
the filter cannot take one away. The presence-SHOWN arm of
`unreadDenoisedFarBehind.test.ts` passes on BOTH sides of the change, which is
what makes it evidence rather than decoration.

### The three candidates, each killed by a number

1. **The measurement floor vs. the client-only filter.** It cannot reach the
   MESSAGES bucket at all: `countsAsUnreadMessage` requires `isContentKind`,
   and no content kind is presence-suppressed, so the client filter can never
   remove a row the server's measurement counted. Measured: `msgs` tracks the
   server answer exactly (200/208/215/223/230) on BOTH postures. The floor has
   exactly one discontinuity and it is elsewhere — see the hazard below.
2. **#2043, the two resolver doors.** Flip the server's presence posture
   mid-session and re-seed the window: the pills move by **0** (msgs 40→40→40,
   evts 0→0→0) while the server's own event answer goes 0 → 120. The
   resolver's answer reaches the badge only through the SEED, and the seed
   loses to local truth on any window the operator has opened. #2043 is real
   and stays open on its own merits; it is **not** this issue's face, and this
   issue should not be closed into it.
3. **`trailingHiddenAdvanceTarget`.** Built a window where the advance really
   fires: the cursor moves 10 → 14 across the hidden run, and both buckets are
   unchanged (msgs 4→4, evts 0→0). Moving the cursor over rows nobody counts
   changes nothing anybody counts.

### A hazard found while killing candidate 1, NOT fixed here

`unreadMessagesAfter`'s `spendable` gate is a step function at `measured.at`:
with a record `{at: 100, count: 3600}` over a pane holding 200 content rows, a
cursor at **99 answers 200** and a cursor at **100 answers 3600**. One id of
forward movement, a 3400 jump. It is unreachable through
`setCursorIfAdvances` (forward-only, and the record is written with
`at === cursor`), but `applyReadCursorSet` — the cross-device echo — is
unconditional and admits backward moves, so a peer device reading backwards
below `at` and this one moving forward again would step through it. Named
rather than cured: nothing measured says it fires, and a cure for a step
nobody has stood on is a cure with no oracle.

### What is NOT established

**The reproduction's UI state is not the report's.** Every arm in which the
counter grows has the far-behind record ARMED, and `injectMarker` suppresses
the in-pane divider whenever it is — so the pane shows the "N unread — jump
back" bar, while the report says the marker was up and moving. Two readings
survive and the measurement does not separate them: either the reporter's
window was in the far-behind state and "marker" names the bar, or there is a
second, marker-preserving path to a growing count that this fixture does not
build. The literal gesture the issue asks for — select → leave → re-select, a
denoised window with a LIVE marker, cursor pinned — **passes on
`4a33c6747`** (48 → 48 → 48). It is kept as the first arm of the new suite
anyway: it is the property the issue names, and nothing here may break it.

Also unestablished, and adjacent: the far-behind MESSAGES bucket counts the
operator's OWN content (`isContentKind` alone) where the server's split
excludes it via `own_nick`. Same class as the defect cured here — a bucket
maintained in a different population from the one it was seeded in — but a
different term, not denoise-specific, and not measured. Reaching
`countsAsUnreadEvent`/`isOperatorOwnedRow` from `scrollback.ts` needs the
per-network own nick, which is `networks.ts`, which is the documented circular
import pair with `selection.ts` — so it is a slice of its own, not a line to
slip in here.
<!-- entry #2041 -->

---

## 2026-09-11 — #2041: one IME guard for both commit surfaces, and what it does not claim

`ComposeBox` (Enter sends, #974) and `TopicBar`'s modal editor (Enter sets the
topic, issue 2035) both treat Enter as a commit key, and neither asked
`KeyboardEvent.isComposing`. With a compose-based input method — Japanese,
Chinese, Korean — the Enter that COMMITS THE CANDIDATE reaches the page as an
ordinary `keydown` with `key: "Enter"`, so both surfaces fired their verb on a
half-typed line. The `preventDefault` each one calls made it worse than a
spurious send: it ate the keystroke the IME was waiting for, so the word was
never finished either. `Shift+Enter` inherited the same fault on both surfaces,
because the 2026-08-07 (#974) and 2026-09-10 (issue 2035) rulings made EVERY
Enter a commit, modifier included.

**One predicate, not two guards.** `cicchetto/src/lib/imeComposition.ts`
exports `isComposingKeystroke/1` and both surfaces call it. The expression it
wraps is one property read and buys nothing on its own — what the module hosts
is the DECISION, with one home instead of three. That is the point of the
issue rather than a tidiness preference: it was filed on both surfaces at once
precisely because the Enter chord had already grown a second semantics on a
second surface without the first one's guard travelling with it, and a cure
applied to one of them would have reproduced that split one layer down.

**Three sites, not two.** `lib/keybindings.ts` — the single global keydown
listener — already consulted `e.isComposing` inline, on the irssi-shaped
printable-key auto-focus redirect, since before either Enter ruling. It is
routed through the shared predicate here with no behaviour change, so the
surface that HAD the check cannot drift from the two that just got it. Its
existing test ("IME composition keys do NOT dispatch insertIntoCompose") stays
green and is the evidence the substitution is inert.

**The guard sits ABOVE the chord table, not inside the Enter branch**, and the
placement is deliberate on both surfaces. Every branch in `ComposeBox`'s
handler is a verb that competes with the IME for the keystroke: Enter commits
a candidate, and the arrows WALK THE CANDIDATE LIST while `ArrowUp`/`ArrowDown`
there walk the send history. One guard at the top is simultaneously the
smaller diff and the wider fix. On `TopicBar` the same placement is what keeps
the two handlers one shape.

### What is NOT claimed

The issue was filed with its own "not claimed" section and this entry does not
quietly upgrade it.

- **No measurement against a real IME.** Nobody typed Japanese into either box
  and watched what arrives. The cure is a read of the handlers and of the spec.
- **The tests are SYNTHETIC.** They dispatch a `KeyboardEvent` carrying
  `isComposing: true` under jsdom. That is not an input method: it asserts what
  the handler does with the flag, never that a real IME on a real engine sets
  it on the commit Enter. The negative control (a plain Enter with
  `isComposing: false` still submits) is what keeps the guard from being a mute,
  and the pre-existing `keybindings` test is the evidence the flag genuinely
  propagates through jsdom and discriminates — but both live on the same
  synthetic side of the line.
- **No measurement on a real browser at all.** There is no e2e arm; Playwright
  can synthesise a `CompositionEvent`, which would be the same simulation one
  layer out.
- **No claim this ever bit a user of this instance.**

### `keyCode === 229` is deliberately absent, and that is a decision, not a finding

The legacy fallback for engines that signalled a composition only through
`keyCode` was NOT added. We did not measure whether any engine cic supports
still needs it, and the absence is not evidence that none does. What IS on the
record: the declared build target is `es2022` (`tsconfig.json`,
`vite.config.ts`), the e2e matrix is chromium + webkit, `isComposing` alone is
already shipped prior art in `keybindings.ts`, and `keyCode` is deprecated. If
a real IME is ever observed committing with `isComposing` false, the fallback
belongs in `imeComposition.ts` — added once, for all three surfaces, with the
measurement written beside it. Adding it now by reflex would have put an
unmeasured branch in the one module whose job is to hold the measured decision.

### Named and not cured

`keybindings.ts` handles Tab (nick-complete, compose-input-gated) and Escape
(the #232 single overlay authority) ABOVE its composition check, so both still
fire during a composition. Whether that is wrong is a real question — some IMEs
spend Tab on candidate selection, and Escape cancels a composition — but it is
a different surface with a different authority (#232 deleted every per-dialog
Esc handler to get there, and gating the global one is not a line to slip into
this slice). Unmeasured, named here so it is not rediscovered as new.
<!-- entry #2045 -->

---

## 2026-09-11 — #2045: one definition of "unread", reached from four places

`far.missed` — the number the far-behind bar renders and, since #2037 A, the
number the sidebar's bold pill reads — had two producers that disagreed on one
term. The server's `Scrollback.count_after_split/6` counts content kinds with
own-authored EXCLUDED (`exclude_own_authored/3`); cic's far-behind maintenance
counted them IN.

The server's answer is the right one and it is not a #2037 preference: it is
the definition the project already holds. A line the operator typed is read BY
DEFINITION (#576 content), and a self-PART or a KICK they issued is an action
they performed rather than something to catch up on (#532 A presence).

**Why it surfaced now.** Before #2037 A the client path accumulated RAW row
counts while the probe returned a split — two obviously different quantities,
and whichever producer armed the window supplied the number. A narrowed the
client to the content unit, so the two now agree on everything except this
term. That is worse in one specific way, and it is the point of the issue:
two numbers that differ by a lot are visibly two numbers, and two numbers that
differ by three are indistinguishable from one number until somebody counts.

### FOUR sites, where the issue named one

The issue names `capScrollbackRing`'s `contentCount`. That line is the SEED —
what opens the record when LOCAL EVICTION is the door into the far-behind
state. But past the retention bound the record GROWS by what arrived, and
`appendPageToScrollback`'s `arrivedContent` carried the same bare
`isContentKind`. Both write `far.missed`.

Fixing only the named line would have been worse than leaving it: the number
would read correctly at arm-time and drift on the next own message —
intermittent wrongness in place of consistent wrongness, and harder to
diagnose. It is also the site the issue's own motivating case runs through.
The multi-device scenario the issue calls out — lines sent from the phone
sitting past the laptop's cursor — arrives on the laptop as a live WS append,
which is the ACCUMULATE producer and not the seed.

The remaining two sites are the events-bucket twins of the first two, and they
are a deliberate widening past the issue's text, taken on a measurement rather
than on symmetry: `exclude_own_authored/3` is applied to the query BEFORE the
content/event `group_by`, so it narrows BOTH buckets. In a peer or channel
window the server strips own content and own presence alike; in the self
window (#396) own content survives and own PRESENCE is still stripped. So
`far.events` had the identical divergence one line below. It also could not be
left: with only the content half cured, `capScrollbackRing` would read
`countsAsUnreadMessage(m, ctx)` on one line and a hand-rolled
`!isContentKind(m.kind)` on the next, with the published sibling
`countsAsUnreadEvent` unused beside it — a half-migration created by the fix
rather than found by it. It is a SEPARATE commit so it can be dropped whole.

### The context is shared, and that is the actual design decision

The predicates were not new. `unreadCount.ts` (issue 2069) already publishes
`countsAsUnreadMessage` / `countsAsUnreadEvent` and its moduledoc already says
it mirrors `count_after_split/6`; the far-behind path was simply the one place
that never asked. What is new is `lib/unreadRowContext.ts`.

Those predicates take "who is the operator, in this window?" as a PARAMETER,
so the module stays pure and reaches for no store. Until now exactly one
caller built that parameter — `selection.ts`, inline, mid-loop. A second
hand-built copy in `scrollback.ts` would have been this very defect one level
down: two spellings of one identity feeding two counts that are supposed to be
one number. So the builder was extracted first and `selection.ts` routed
through it, and the second caller was added to the shared one. Each field is
load-bearing: the nick is PER-NETWORK (`net.nick`, never the account name —
see the `ownNickForNetwork` warning and the 2026-05-08 cic H3 DM-misrouting
root cause), the casemapping is per-network (#537 axis 2), and `isSelfWindow`
is the #396 carve-out.

### The arming did not move

What puts a window far behind is still "a row at/after the cursor left the
store" (#2037 A), as true of a row the operator typed as of anyone else's.
Only the DISPLAYED quantity narrows. Nothing in this change touches
`unreadDropped`, `unreadHeld` or the bound they are compared against.

### The import cycle was MEASURED, not read

The issue reported `scrollback.ts → networks.ts` as cycle-free and said so
honestly: "a static read of the imports, not a build". It was verified with a
build before any of the cure was written — `tsc --noEmit && vite build` green
with the edge present, `grep -ci circular` on the build log returning 0 against
a positive control returning 1, and the eleven co-initialising suites (503
tests) green with no TDZ `ReferenceError`. An ESM cycle bites at module-init
and not at compile, so the runtime leg is the one that mattered.

### What this does not claim

- **No production measurement.** The size of the effect is bounded by the
  operator's own content sitting past their own read cursor. Nobody has read
  that off a real instance; "small in the common case, unbounded in principle"
  is the issue's estimate and it stays an estimate.
- **No e2e.** The evidence is unit-level, against a fake server whose
  `countMessagesAfter` implements `exclude_own_authored/3` including the #396
  carve-out — a model of the query, not the query.
- **The fixture caught itself once, and that is worth recording.** A first
  version chose arrival authorship by SKIPPING ids whose author did not match,
  which left the fake server counting rows the client was never handed: the
  client then read LOWER than the server, the opposite of the defect. The two
  control arms are what surfaced it. Authorship now lives in one map read by
  both sides, so the oracle cannot describe a log the client did not get.
<!-- entry #2043 -->

---

## 2026-09-11 — #2043: the two presence doors, measured against a real session

issue 2043 filed a divergence between the two `Grappa.PresenceFilter.Resolver`
doors, measured what one disagreement costs (residual 69 rows of 78 at one
anchor), and then said in as many words what it had NOT established:

> A real `Session.Server` cannot answer the two calls asymmetrically within
> one instant, and that is a READING, not a measurement.

This entry is that measurement. `test/grappa/presence_2043_probe_test.exs`
reads the SAME pair — `Resolver.hidden?/4` (the per-window bar) and
`Resolver.hidden_channels/3` (the bulk `/me` seed) — through the production
`Grappa.Session` facade against a REAL `Session.Server` driven by the
in-process fake ircd. No cure is shipped with it, deliberately: see the last
section.

### The known-answer control runs first, and it must DIVERGE

A file of symmetric readings proves nothing by itself, because an instrument
that cannot see divergence reports "symmetric" for a divergent system just as
cheerfully. So `CTRL DIVERGE` — the 2037-era stand-in answering the two doors
independently — is asserted to come back `(SHOW, HIDE)` before any real arm is
believed, and `CTRL SYM` is asserted symmetric beside it. Both hold. Every
negative below is a negative taken with an instrument that was demonstrably
looking.

### Mechanism (2), a failure at ONE door: FALSIFIED on a real session

The issue's second mechanism — a timeout, an `:uninitialized` window, or a
session that died — does not produce a divergent pair, because both doors
degrade TOGETHER:

* `R3`, joined with NAMES not yet landed: the per-window door answers
  `{:ok, :uninitialized}` and the bulk door OMITS the key. Both reach
  `PresenceFilter.hidden?/2` as `nil`. Pair `(SHOW, SHOW)`.
* `R4`, a channel never joined: same shape, same pair.
* `R6`, both doors read after the session died: `{:error, :no_session}` at
  one, an empty counts map at the other. Pair `(SHOW, SHOW)`.

This is not luck. `handle_call({:list_members, ch}, …)` and
`handle_call(:list_member_counts, …)` filter on the same `seeded_channels`
MapSet over the same `members` map, so a state that hides the channel from
one hides it from the other in the same breath. A timeout cannot be
asymmetric either: two calls made at the same instant against a stalled
process both time out, and making them at different instants is mechanism (1)
wearing mechanism (2)'s coat.

### Mechanism (1), two instants: holds, and is exactly what it looks like

`R6` reads the pair before the session dies (`HIDE, HIDE`) and after
(`SHOW, SHOW`). Neither row diverges. What diverges is the CROSS pair a
production `/me`-then-probe actually makes — the seed taken at the first
instant against the bar taken at the second — and the probe prints that pair
as data rather than asserting it in prose: `seed@t1 HIDE` vs `bar@t2 SHOW`.

That is real, and it is also just state moving between two honest readings.
It is the reason the far-behind freeze hurts, not a defect in the pair.

### The third mechanism, which the issue does not name

`R5` diverges on a real session **within one instant**, and by a route
neither of the issue's two describes:

```
R5  rfc1459 + bracket: members "#foo{1}" vs cursor "#foo[1]"   bar HIDE  seed SHOW
```

`Grappa.ReadCursor.set/4` folds the cursor key with the arity-1
`Identifier.canonical_target/1` — plain ASCII, `[ ] \ ~` untouched, which is
the documented channel-key posture (storage and query stay pure ASCII). The
session's members map is keyed by `fold_key/2`, the network-aware fold, which
on a `CASEMAPPING=rfc1459` network maps `[` to `{` FIRST. The two keys are
then permanently different for that channel — not racing, just different.

The per-window door survives it because it hands the raw channel to the
server, which folds it correctly on arrival. The bulk door does not: it
receives the counts map keyed the session's way and looks up
`Map.get(slug_counts, channel)` with the CALLER's key, raw, with no fold at
all. So `hidden_channels/3` is where an ASCII-keyed DB world meets an
rfc1459-keyed memory world across an unfolded lookup.

Two controls attribute it rather than leaving it as an observation:

* `R5b` — same rfc1459 network, `#plain`, whose two keys coincide: symmetric.
  So R5 is the key mismatch, not something about rfc1459 sessions at large.
* `R5c` — the same `#foo[1]` on an `:ascii` network, where
  `normalize_casemapping/2` is a no-op and the keys coincide again:
  symmetric. So the whole of production, which is bahamut/`:ascii`, cannot
  reach R5 today.

Note the SIGN. The issue measured `bar SHOW, seed HIDE`; R5 is
`bar HIDE, seed SHOW`, the mirror image. A cure aimed at the issue's sign
would not have touched this.

### Why no cure ships here

The cure the issue reaches for — teach the count path to distinguish "I could
not reach the session" from "I reached it and it is under threshold", instead
of folding both to `nil` — is aimed at mechanism (2), and mechanism (2) is the
one this measurement falsifies. Shipping it would harden a path that has not
been shown to diverge, and an undiagnosed cure makes the NEXT sighting
unreadable.

R5's cure is a different change in a different place (fold the bulk door's
lookup key, or key the counts map the way its caller keys it), it lands on the
rfc1459 axis rather than the presence-filter axis, and whether it is a defect
or another entry on the documented rfc1459 known-gap list is a ruling, not a
judgement call inside this slice.

### What is NOT claimed

* **No production measurement.** Every reading here is a test-harness
  session. Prod is `:ascii` throughout, where `R5c` says the divergence
  cannot fire; whether an rfc1459 network in the wild is carrying it is
  unmeasured.
* **Mechanism (2) is falsified for the states this probe can reach**, which
  are `:uninitialized`, never-joined and dead-session. A stalled process
  answering one call and not the other within one instant remains
  unconstructible rather than proven impossible.
* **The issue's cost figure is not re-measured.** The 69-of-78 residual is
  taken from 2037's instrument as filed; this file measures reachability, not
  cost.
<!-- entry #2052 -->

---

## 2026-09-11 — #2052: the join reply was a second door that moved the cursor backward, and the module had already said there was only one

`readCursor.ts`'s `applyJoinReply/3` landed the per-channel join reply's
cursor unconditionally. After a POST that failed — which is what a stretch
offline produces — the next rejoin rewound this device's cursor to the
server's stale value and every already-read row counted as unread again: the
badge came back on every resume, then cleared the moment the operator read.

### The fork the issue posed collapsed on a measurement, so nothing was ruled

The issue offered forward-only (`max(local, reply)`) against last-write-wins
and declined to choose, on the grounds that *"last-write-wins is also what
makes a deliberate server-side cursor reset land at all."* **There is no
deliberate server-side cursor reset.** `Grappa.ReadCursor`'s own moduledoc
says it outright: `set/4` is monotonic, *"cic is already forward-only
locally; the server is the single authoritative regressor"*, and
**deliberate mark-as-unread "has no caller today — no cic surface, no REST
verb … when the feature ships it gets its OWN explicit path"**. The one
backward writer, `force_set/4`, has exactly one caller — `TestReadCursor
Controller`, on a route `Mix.env() in [:dev, :test]` compile-gates out of the
release — and it broadcasts, so it lands through `applyReadCursorSet`
anyway. A reply BELOW what this device holds therefore cannot be a
deliberate regression; it can only be a device that wrote and did not land.

### This is drift repair, not a new policy

The module had already declared the invariant in two places — *"the ONLY
path that lands a peer's set (or a backward move)"* and *"only that
authoritative WS path moves the cursor backward"* — while a third door
quietly did it. The rule now has ONE name, `advanceOnly/3`, shared by the
join-reply arm and `setReadCursor`'s optimistic advance, which had the same
predicate written out. It returns `prev` UNCHANGED on a no-op: a
rebuilt-but-equal object wakes every cursor consumer for nothing, the same
reason `renameReadCursorChannel` bails early on a pure re-casing.

A reply that is AHEAD still lands — that is what the rejoin refresh is FOR,
and the paired test says so; "forward-only" degrading into "the join reply
is ignored" is the mutant that test exists to kill.

### What forward-only gives up, named rather than discovered later

`networks.ts`'s #818 note describes a cross-identity `/me` seeding a HIGHER
cursor on a window; this door can no longer correct that downward. That path
is guarded by `identityMoved/1` and readCursor's `on(token)` purge, and
trading it for the resume flicker is the deliberate call.

### `applyMeEnvelope` is the same SHAPE and deliberately not cured

It replaces the whole map, so it can also land a server value over a local
optimistic one. It is not the same defect and not left alone by omission:
**it is not on the resume path.** Measured — `refetchUser()`'s callers are
`HomePane` (connect-a-network), `BootErrorBoundary` (retry) and five
read-after-write settings mutations in `lifecycle.ts`; the socket reconnect
triggers none of them, and `reconnectBackfill.ts` only READS the cursor. An
alarm was raised here that five `refetchUser()` calls sat on resume, and the
measurement killed it. Its full-replace is also load-bearing — a stale entry
from a prior session would mask a cleared cursor — so a forward-only merge
there would break the contract it exists to hold. The reload-after-a-failed-
write case remains what `readCursor.ts` already documents and accepts:
already-read rows re-surface as unread once.

### Not measured

Whether this fires in production (the issue simulated the offline POST; no
real client was observed), the frequency, and the browser: the arms are
store-level, in jsdom, so nothing here says the number reaches a rendered
badge. That is the e2e's job and it has not run.
<!-- entry #2053 -->

---

## 2026-09-11 — issue 2053: the badge was already right; the comment was the defect

Reported: a window driven far behind by the #1229 ring cap shows NO badge at
all while hundreds of rows are unread. `perChannelUnread` skips the local row
count for a far-behind key, the only writers of the server seed are a join
reply and `/me`, and for a window the operator was caught up on at join that
seed is a truthful ZERO that nothing can raise.

**It does not reproduce, and the negative is measured rather than argued.**

### The measurement

Bench: the real `scrollback` + `readCursor` + `selection` stores against the
fake server the sibling suites use (`after`/`before`/`limit` honoured, the
probe answered from the same log), on `95998369a`. The shape is the issue's
own and not a near-miss of it — a join reply seeding `{messages: 0, events: 0}`
at a cursor equal to the tip, then a live burst through `appendToScrollback`
with no join, no `/me` and no reconnect anywhere near it. Mixed log, every
fourth row a peer JOIN, so the two buckets cannot hide in each other.

```
after 400 live rows
  far   {missed: 300, events: 100, resumeFrom: 1000}
  seed  {messages: 0, events: 0}          <- still the truthful zero
  rowsHeld 200
  badge 300 / 100     server answer at the frozen cursor 300 / 100
```

Extended to 2000 rows in ten batches and then a re-select: the badge equals
the server's own answer for the frozen cursor at every step (150, 300, 450,
… 1500) and does not move on the re-select.

**The control, on the same bench.** Delete `perChannelUnread`'s far-behind
loop — the pre-#2037 shape, in which the seed does stand — and the same run
reports `badge: 0` beside `far.missed: 300`. That is the issue's `{badge: 0}`
to the digit, so the bench does discriminate and the issue did happen; it
happened on a tree that no longer exists.

### Why it stopped

#2037 (`d49582c58`) merged to main at **2026-09-10 15:06:53Z**, in PR #2047.
Issue 2053 was filed at **15:14:13Z** — seven minutes later, from a tree
where that PR was still open, and it says so: *"a prediction from the values
measured in my own tree, not a measurement of that branch"*. The prediction
was right. This is that measurement, taken where it was asked for.

### No new test, and the reason is a measurement too

`farBehindOwnAuthored.test.ts`'s `openFarBehindByEviction` already drives the
ring-cap route — the arm is called *"opens the record on the server's number
when the PRUNE opens it"* — and its oracle is the server's answer, not a
literal. Under the control above it goes RED, together with eight other arms
across four files; the unmutated set is green. A second file asserting the
same property on a seed of 0 instead of 50 would be a duplicate of a landed
test, so there is none.

### What shipped instead

Ten comments, in eight files, still said in the present tense that a
far-behind badge publishes the seed. One of them is the line the issue quotes
and it ended *"the seed … is the honest number here, so leave it standing"* —
follow it and you rebuild the reported defect exactly. `scrollback.ts`'s own
docblock on the record already stated the truth, so the repair is to make the
other ten agree with it rather than to invent a story.

Left alone deliberately: the `issue1765` e2e header and the "Pre-2069 this
line ALSO said" aside in `unreadBadgeFarBehindStale.test.ts` narrate a PAST
state in the past tense and were accurate on their dates; the DESIGN_NOTES
entries that record the old behaviour are history and are not rewritten.

### Not measured

- **The rendered pill on this route, in a real browser.** `issue1229`'s e2e
  reaches the ring-cap arm and asserts the in-pane BAR; `issue2037`'s asserts
  the sidebar pill but arms far-behind through the reload/probe route. The
  crossing of the two — ring-cap arm, sidebar pill, real server — has no spec,
  and this slice did not open one, there being no defect to pin.
- **Whether the ring-cap route fires in production at all.** Unchanged from
  the issue: it needs a live burst past the retention cap on a window with a
  non-null cursor, and nobody has read that off a real instance.
<!-- entry #2046 -->

---

## 2026-09-11 — #2046: the directory answers from one read, and says which kind of empty it is

`ChannelDirectory.list/3` built one payload from three unsynchronised reads, so
a capture landing between them produced `status: "empty", total: 0` beside five
entries — measured off a production trace in the issue. vjt's ruling has three
parts: defer the persistence to the end of the LIST, take the total and the
page from the SAME read, and split the one `empty` into three named states.

### The measurement the ruling asked for, and it went the other way from the hope

The ruling flagged that part 1 might make part 2 **superfluous**: if nothing is
written until the 323, a reader during a capture sees the previous snapshot
whole, so where would the skew come from? Reported as a structural reading, not
a measurement, with an explicit instruction to measure and report the direction
found.

**It does not.** The deferral moves the write, it does not make it atomic: the
323 still performs a delete followed by inserts, and three reads still straddle
it. `channel_directory_test.exs` carries the demonstration as a PAIR — a control
that fires the same interleave BETWEEN two `list/3` calls and shows the two
instants disagree (`total: 5` beside 3 rows, the shape the trace reported), and
the subject test that fires it from inside a telemetry handler DURING the read
and asserts `total == length(entries)`. The interleave is fired from Ecto's own
`[:grappa, :repo, :query]` event, which is emitted synchronously in the calling
process, so the write lands between one statement of the reader and the next
with no production seam, no sleep and no second process. The subject test
asserts the harness fired before it asserts the outcome: without that, a
`total == length(entries)` that holds because nothing moved is a mirror.

So part 2 was written. `total` is now a `count(*) over ()` on the page's own
statement, and `captured_at` rides the page rows.

### `:refreshing` was dead, and it is gone rather than commented

`status_of(nil, _, _) -> :refreshing` meant "rows present, `captured_at` still
NULL", which only existed because the ingest wrote mid-stream and stamped
later. `replace/3` stamps at INSERT, so a row without a stamp cannot exist —
the clause was unreachable, not deprecated. Deleted, with `replace_start/2`,
`ingest/3`, `finalize/2`, the `{:ingest, rows}` action, `DirectoryIngest`'s
batch field, `drain/1`, and the `ingest_batch` config key that sized a flush
that no longer happens.

### The deterministic defect: the incoherence is real, the consequence was not

The issue records a second defect: a search matching nothing mid-refresh reads
`:empty`, and `DirectoryController.index/2` arms a refresh on every `:empty`,
so — the claim goes — a search miss KILLS the capture in flight. The first half
is true and is cured here (a search miss is now `:no_results`, and only
`:unknown` arms). **The second half is false, and was false before this
slice.** `handle_call(:refresh_directory, …)` matches an in-flight run in an
EARLIER clause than the one that sends LIST: a second request while a capture
is streaming is a pure `{:error, :already_refreshing}` that touches neither the
wire nor the tracker nor the buffer. `directory_test.exs` now asserts the
buffer survives the rejected call, rather than the return value alone.

What the auto-arm COULD do, before the deferral, was nuke an orphaned partition
left by a watchdog abort — and after the deferral even that is gone, because
the arm writes nothing until its own 323.

### The two questions the ruling left open

**1. The default for `total` / `captured_at` when the filtered set is empty.**
A statement that returns no rows carries no window value, so the envelope is
asked for separately in exactly that case: one row of the same subquery when a
CURSOR ran past the end (exact total, real stamp), and `{0, max(captured_at)}`
over the unfiltered partition when the search genuinely matched nothing. The
second read is what keeps a search miss reporting WHEN the list it searched was
captured. Its cost is stated rather than hidden: on that one path the two
values come from two instants, and a capture landing between them can only ever
flip an EMPTY page between `:no_results` and `:unknown` — there are no entries
for the numbers to contradict.

**2. Which scope owns the count in `status_of/3`.** The count stays
SEARCH-scoped, as it always was, and the stamp stays SNAPSHOT-scoped. That
combination is what makes the discriminant work: a non-nil stamp beside
`total == 0` can only be a search that matched nothing.

### The query is NOT an argument to `status_of/4`, and that is a deliberate refusal

The ruling names the presence of the query as the discriminant between "no
results" and "no list yet", and the brief for this slice read that as a
signature change carrying `q` down to `status_of/3`. It is not needed. With the
stamp snapshot-scoped and the count search-scoped, `%DateTime{} + total == 0`
is REACHABLE ONLY with a query present — an absent `q` counts the whole
partition, which is non-empty whenever a stamp exists. Passing `q` would
re-state a fact the two arguments already carry, and it would be WEAKER: it
would label a search typed before the first capture as `no_results` when the
truth is `loading`. The signature that shipped is
`status_of(captured_at, total, refreshing?, ttl_ms)`.

### `:loading` needs a fact the table cannot hold

With persistence deferred, a running capture leaves every row as it found it,
so `:loading` and `:unknown` are the same rows. The in-flight fact lives in
`Session.Server` and reaches the read as a required `:refreshing?` opt, via
`Grappa.Session.directory_refreshing?/2` — the sibling of `casemapping/2`, same
reason, same "no live session means the honest default" posture.

**The ORDER of the controller's two reads is load-bearing and is the reason
`replace/3` needs no transaction.** `directory_refreshing?/2` is a call into
the session, so it queues behind the 323 handler that performs the write. A
reader that asks FIRST therefore sees either the old snapshot whole (capture
still streaming) or the new one (write committed) — never the delete-then-
insert gap. Swapping the two lines hands the gap back, and the payload it
produces is `:unknown`, the one status that arms a re-capture.

### The wire bump is the first that is not additive

`protocol_version` 16 → 17. `empty` and `refreshing` LEAVE the closed
`status` union; `no_results`, `unknown` and `loading` enter it. This is not the
#1626 field-removal carve-out — every key stays where it was — it is a closed
set of VALUES changing, which the additive-only rule never spoke to. Measured
consequence, both directions: cic's generated `wireSchema` rejects a `status`
outside its enum, so a pre-17 bundle throws away every directory page a v17
server sends, and this bundle cannot read a pre-17 server's either.
`min_protocol_version` stays at 1 deliberately — raising it would 426 the whole
socket over one broken pane, and the two ship together.

### Not measured, not claimed

* **No magnitude for the RAM the buffer costs.** The price was accepted by
  ruling; a few thousand rows per session running a LIST is the shape, not a
  measurement.
* **No magnitude for the write burst.** `replace/3` is a delete plus
  `ceil(n/500)` inserts on one connection; nothing here times it, and the chunk
  size is a SQLite variable-limit constraint (32766 vars, 8 per row), not a
  tuned number.
* **Nothing about the original trace is re-explained.** The issue lists three
  candidate readings for why `captured_at` stayed null for 15 s across 14
  polls; this slice cures a defect visible in the payload and in the source,
  and does not claim to have identified which reading produced that artefact.
* **The `no_results`-vs-`loading` edge on a first visit.** A search typed
  before any capture has completed reads `loading`, because the stamp decides
  before the query does. That is the honest answer, and it is also the only
  arrangement of these two branches with no wrong case.
<!-- entry #2082 -->

---

## 2026-09-11 — issue 2082: the 💤 badge is edge-only, and the reopen that "clears" it clears it unconditionally

The report: on a self-hosted 1.5.5, the away indicator stays on after the
operator is no longer away, on their OWN row, and closing and reopening
cicchetto clears it. The reporter then added that the flag "might have been
simply late" — in the same session their scrollback took ~20 s and they
suspect their own network. So the order was: measure before touching code,
and if the measurement absolves, the absolution is the result.

It does not absolve. It absolves two of the three candidates the issue
listed, leaves the third alive but pointing away from the reporter's
evidence, and convicts a fourth thing the issue did not name — one that needs
no repro at all.

### What was measured

A grep tool over the tree at `dad99f549`, with a negative control (a token
that exists nowhere) and three positive controls chosen to RESEMBLE the real
case: a sibling typed effect emitted from `EventRouter`, a
per-`(subject, network)` fact that IS in the cold-subscribe bundle, and the
same caller-scan applied to a facade verb known to have production callers.

Two of the regexes died on the first run — one on `\{` in ERE ("invalid
repetition count(s)"), one on `\(` in BRE ("parentheses not balanced") — and
the second printed **`0` production call sites**, which is the answer the
tool would also print if the count were genuinely zero. It IS genuinely zero,
but nothing in the first run established that. Every grep now goes through a
wrapper that captures stderr and aborts on any diagnostic, and the caller
scan carries its own positive control printed beside its result.

Results, all with controls green:

- `away_confirmed` has exactly **two** emitters in `lib/`:
  `event_router.ex:2011` (305 → `:present`) and `:2022` (306 → `:away`). Both
  clauses match on `%Message{command: {:numeric, N}}` alone — neither reads a
  tag.
- cicchetto has exactly **one** production writer of the badge:
  `userTopic.ts:936`, inside the `away_confirmed` arm.
- `awayStatus.ts` contains **zero** clock references — no TTL, no poll, no
  timestamp — and `identityScopedStore` (73 lines) touches no `localStorage`,
  `sessionStorage` or `indexedDB`. The store is reset only on identity change.
- The `:session_snapshot` cold-subscribe bundle carries seven keys — `umodes`,
  `supported_umodes`, `identified`, `account`, `invited_windows`, `isupport`,
  `linelen` — and **zero** occurrences of `away`.
- `GrappaChannel.push_session_snapshot/2` pushes four `SessionWire` verbs;
  `away_confirmed` is not among them.
- `Session.set_auto_away/2` and `Session.unset_auto_away/2` have **zero**
  production call sites (control: `Session.set_explicit_away` has two).
- There is **no** read-side away accessor anywhere on the web edge.

### Absolved

**Candidate 2, the labeled-response path.** `NumericRouter.route/2` tests
`@delegated_numerics` INSIDE the label-hit arm and returns `:delegated`
before it can reach `window_ref_to_decision/1` — the #276 "delegation wins
over the label override" precedence, which exists precisely because 305/306
are the only labeled replies grappa ever receives. `:delegated` goes to
`Server.delegate/2`, which calls `EventRouter.route/2` and then
`apply_effects/2`; the 305 clause is tag-blind. A labeled 305 cannot be
consumed by the correlation before the arm that emits the effect, because the
correlation is not on that path. Already pinned by two existing tests
(`numeric_router_test.exs:773`, `server_test.exs:2680`).

**Candidate 3, the auto-away cancel.** The live cancel path does round-trip:
`handle_info({:ws_visible, _})` → `unset_away_internal/2` →
`Client.send_away_unset/1`. There is no auto path that clears `AwayState`
without a wire write. The facade verbs the candidate names —
`Session.unset_auto_away/2` and the `handle_call({:unset_auto_away})` arms —
are not on any production path at all; production drives the FSM entirely
through the `:ws_visible` / `:ws_all_hidden` `handle_info` clauses. Dead
code with a test-only lifeline, recorded here and not pruned: it is outside
this slice's boundary and pruning it deletes the tests that keep it alive.

### Stands, but does not fit the reporter's evidence

**Candidate 1, the fire-and-forget send.** Real and unchanged:
`maybe_log_send_failure/2` swallows `{:error, _}` and the local `AwayState`
clears anyway, so a dead socket means no `AWAY` out, no 305 back, badge stuck.
But it needs the **grappa↔ircd** link to be dead, and the reporter
self-hosts: the latency they describe is on the **browser↔grappa** link. Not
excluded — just not where their evidence points.

### Convicted: the badge is edge-only, in both directions

The badge's entire state is one signal written by one push. Nothing snapshots
it. Two consequences, both deterministic:

- **Any `away_confirmed` emitted while the browser is between sockets is
  gone.** Phoenix PubSub does not replay, and the user-topic after-join
  snapshot does not carry away. The badge then stays lit until a reopen —
  which is the reported shape, produced with no defect in the un-away path
  whatsoever, by exactly the flaky link the reporter blames.
- **The inverse needs no repro and no reporter: reopen while genuinely away
  and the badge is OFF.** `awayByNetwork()` starts `{}` and nothing
  re-asserts. So "closing and reopening clears it" is not evidence that the
  un-away landed — a reopen clears it whether the operator is present or not,
  and the same reopen is what hides the opposite lie.

Away is the ONLY per-`(subject, network)` session fact left out of a bundle
whose own comment states why the others are in it: *"#388 — the normalized
identity verdict rides the SAME snapshot, so a client that reloads
mid-session re-learns it without a second round-trip. Without it … the live
`session_identity_changed` edge fired long before the browser subscribed, and
nothing else on the user topic carries the verdict."* Word for word the away
badge's situation, with `away_confirmed` in place of
`session_identity_changed`. Four facts already ride that call for this
reason; the fifth was never added.

The cure that follows from the precedent is small — an `away` key on the
`:session_snapshot` map (no extra round-trip, which is the #482 constraint on
that call) and one `SessionWire.away_confirmed/2` push in
`push_session_snapshot/2`, reusing the verb the live edge already emits so
cic's dispatch never branches on snapshot-vs-event. It is not written here:
it is a contract addition to a documented bundle, and it waits on a ruling.

### The discriminator, handed back

The one the issue proposes — *does the 💤 clear by itself after N seconds?* —
does not discriminate what it was asked to. It separates "the 305 is still in
flight" from "the 305 is gone"; it does not separate "grappa lost it" from
"the operator's link lost it", because a WS gap makes a healthy grappa give
the never-clears answer.

A probe that does, runnable in the same session with the badge stuck and
without a reopen: issue `/away test`, then `/away`.

- lights, then clears ⇒ the un-away path and the socket are both fine; the
  earlier 305 was lost in transit or in a WS gap — their link.
- lights, then does NOT clear ⇒ the un-away path is broken with a live
  socket. That is the defect the issue posits, and candidate 1 is the first
  suspect.
- does not even light ⇒ the WS is not delivering; nothing about away was
  learned, and the run is void.

The third arm is the positive control the `/whois`-from-another-client oracle
in the issue body cannot supply: that oracle reads upstream state, so it
cannot tell a missing event from a socket that is delivering nothing.

### Not measured

- **The reporter's own question.** It needs their session, and their exact
  1.5.5 commit was never supplied. No commit was deduced.
- **Any of this in a real browser.** No repro was built and no e2e opened —
  there is no confirmed defect on the reported axis to pin, and the axis that
  IS confirmed (reopen-while-away) has no cure to guard yet.
- **The two absolving tests, re-run on this tree.** The COMPILE lane was
  held elsewhere; candidate 2's absolution rests on the code path read plus
  two existing tests read, not on a green run taken here.
<!-- entry #1481 -->

---

## 2026-09-11 — #1481: one question, two ports, and the sender half the render port never had

Type your own nick into your own message and cicchetto highlighted your own
line back at you. Reported on IRC by alk (*"perche' deve hilightarmi il
messaggio se scrivo io stesso il mio nick"*), then again by Mezmerize on a
self-hosted 1.5.5 who read it as a regression, live-repro included.

### What the two ports actually disagreed about

The NOTIFY port has excluded own rows since #532 C, on both sides:
`Push.Triggers.should_notify?/5` asks `own_row?/2` as step 0, and
`pushTriggers.ts` mirrors it. The RENDER port asked
`matchesWatchlist(body, ownNick, patterns)` — **a BODY predicate, which cannot
answer a SENDER question** — from three places and never looked at who sent
the row: `ScrollbackPane`'s `isMention` and `isHighlight`, and
`MentionsWindow`. Server-side the same hole sat in
`Mentions.aggregate_mentions/6`, so the away digest handed the operator their
own lines back.

Three open-coded halves of one rule is not bad luck, it is the mechanism.
`WindowCounts` already carried a private `mention_row?/3` whose FIRST conjunct
is exactly the missing step; the rule simply had to be remembered in four
places and was remembered in two. #370's own header had written the stronger
claim — that ONE predicate made divergence impossible — and it was too strong
for exactly this reason.

### The shape of the cure: one predicate per port, not a fourth copy

Server: `mention_row?/3` is **promoted out of `Grappa.WindowCounts` into
`Grappa.Mentions`**, which already owns both conjuncts it composes
(`mentionable_sender?/1`, `matches?/2`) and whose moduledoc already claimed to
be where every server-side mention fold goes. The private copy goes away in
the same commit; the two counting doors and `aggregate_mentions/6` now fold the
one rule, so the badge, the away bundle and the OS push cannot mean three
different things by "mention". The pre-folded `own_folded` parameter is kept
verbatim from the copy that moved — the counting doors hoist the fold out of
their loops over a capped tail, and `aggregate_mentions/6` folds once before
its filter for the same reason.

Client: `isMentionRow` in `mentionMatch.ts`, built on `isOwnRow`, which
`pushTriggers.ts` now folds too. That leaves ONE client spelling of "is this
row mine", and the `"ascii"` pin (#1861) travelled with it — one place to
change when the server's mention folds become network-aware.

**`Push.Triggers.own_row?/2` and its cic twin deliberately keep their
POSITION.** Over there the question gates the WHOLE notification: it outranks
the per-conversation mute and both branches. Here it is one conjunct of the
mention rule. Same question, two positions in two decision trees — merging
them would have moved the step, which is a behaviour change nobody asked for.

### The below-the-fold badge needed no guard, and that is asserted

`readMentionGeom` reads `.scrollback-mention` straight off the DOM and
`mentionsBelowViewport` counts it, so the badge inherits any change to the
class. Reading the class rather than re-deciding is what buys that. The
ScrollbackPane arms assert the CLASS itself, with a peer row carrying the SAME
body as the positive control — so the inheritance is measured, not assumed.

### What is still divergent, named rather than quietly widened

After this the render set and the server's count agree on the body match and
on own rows. They are still **not identical**: the server's `mention_row?/3`
also subtracts service- and server-originated rows (#1674), an axis the render
port has never had. `mentions.ts` used to assert the two sets were the same;
that sentence was false before this change and would be false after it, so it
is replaced by one that names the remaining gap. Closing that axis is a
separate call — #1674 scoped it to the badge and the push on purpose, and
widening it here would change what a NickServ line looks like in scrollback
without anyone deciding to.

### The "new in 1.5.5" reading, and what was NOT measured

The regression reading is not supported by the code: `isMention` and
`isHighlight` carried no sender conjunct in either 1.5.4 or the tip this was
built on, and the last change to that block predates the first tag. Three
candidate explanations for why it may nonetheless look new to a reporter
(the `mircPlainText` projection, `termAnchors`, or simply having started to
quote lines carrying his own nick) were **deduced by the issue's author and
explicitly not measured** — they are not cited here as causes, and the cure
does not depend on which, if any, is true. No repro was built in a real
browser; the e2e lane was not held, and this defect is fully decidable at the
unit layer on both ports.
<!-- entry #1480 -->

---

## 2026-09-11 — #1480: the notification sound becomes a preset, and its default becomes silence

alk reported that cic's notification sound is indistinguishable from the
Windows Sticky Keys chime. deadbeef_ reported, separately and the same week,
that cicchetto still beeps while macOS is in Do Not Disturb. One module
answers both — `cicchetto/src/lib/beep.ts`, until now a single hard-coded
440 Hz sine with no way to change it and no way to turn it off.

### Why "respect Do Not Disturb" is not the cure

A web page cannot read macOS Focus/DND. There is no browser API, so cic has
no signal to gate on and no amount of server work creates one. The BANNER
half already behaves — the OS suppresses its own notification, and deadbeef_
confirmed none arrived. The SOUND half is a Web Audio `OscillatorNode`
started by the page, which the OS never sees and therefore never gates. The
implementable answer is a preset the user picks, including one that is
silence.

### The default is silence, and that is a deliberate break

vjt ruled it on the day: «e mettiamo default off», «suono deve essere
opt-in», «mi sta bene che sia disattivato per tutti», his framing being that
an audible beep a user never asked for is a privacy invasion. The issue body
said the opposite ("the current 440 Hz tone, so nobody's sound changes on
upgrade") and is superseded. So `notification_sound` defaults to `"none"`
for everyone, existing subjects included, and the sound arrives only after
an explicit opt-in.

That makes `on` and "the default" two different values, and they are two
different constants (`OPT_IN_NOTIFICATION_SOUND` / `DEFAULT_NOTIFICATION_SOUND`)
precisely so a later change of default cannot silently redefine `/beep on`.

### The samples are committed, on a ruling, with the licence problem on the table

Three options went to vjt: (a) commit the XP sounds into the public repo,
(b) host them off-repo like the ICQ one, (c) synthesise homages and ship no
bytes. Two answers landed within 30 seconds on two channels; asked which
held, he answered «(a)», «non me ne frega niente (a)», and stated the risk
himself — «mi manderanno il cease and desist» / «e li levo». That is his
call on his repo, made with the problem named. The position is recorded in
`cicchetto/public/sounds/PROVENANCE.md` rather than left to be re-derived
from the files being present. He then extended it: «generane un po'» / «e
metti anche quei due di icq e ms» — so the pack ships BOTH species
populated, not one.

### The shape

`notificationSound.ts` owns the vocabulary and the recipes; `beep.ts` plays
them. A preset is `silent`, `synth` (an oscillator recipe: wave, from/to Hz,
offset, duration, gain) or `sample` (an mp3 decoded into the same
`AudioContext`, buffer memoised per URL). The discriminated union is what
makes adding a preset a table row — the player's switch is exhaustive, so a
new `kind` is a compile error at every site that must learn about it rather
than a silent fall-through to silence.

Three details are load-bearing and none is obvious:

- **The preset is an ARGUMENT, not a store read.** `playBeep(sound)` takes
  it from the caller that already holds the prefs, so the settings preview
  and the live notify path are the same door and the recipes are testable
  without audio.
- **`none` returns before the `window.__lastBeepAt` stamp** and before the
  `AudioContext` is even constructed. `none` is the default, so a seam that
  ticked for it would report "beeped" for everybody who never opted in —
  which is everybody — and the e2e oracle would read green on silence.
- **A rejected decode EVICTS its cache entry.** Memoising the promise is
  what stops two beeps in a tick racing one fetch; keeping a rejected one
  would poison that preset for the session, so a single bad response on a
  flaky network would silence the operator until they reloaded.

### Absence and garbage are different claims

Server-side the key follows the `display_prefs.time_format` twin — the READ
falls back to the default on an unrecognised value, the WRITE rejects one —
with ONE deviation: an ABSENT key on the write means UNCHANGED, not "reset
to default". That is `muted_targets`' own rule (#866) and its reason applies
verbatim: `PUT /user_settings/notification_prefs` is a full replace and cic
deploys independently of the BEAM, so a bundle that has never heard of the
picker is saying nothing about the sound. Reading its silence as a choice
would mute an opted-in subject the first time they ticked any other
checkbox. An unrecognised VALUE still 422s — tolerating absence is not
tolerating garbage.

With a second `:unchanged` key, `resolve_muted/2` became the wrong shape and
is gone: the client that omits either key omits both, so `resolve_unchanged/4`
reads the stored prefs ONCE and fills whichever are missing.

### `/beep`, and the `/set` interface that will not exist

deadbeef_ asked for `/set beep on/off` because the drawer is «un sacco di
click». vjt refused the generic form twice — «non voglio iniziare a fare la
/set interface», then «/set è un puttanaio lasciamo perdere», which also
kills the follow-up issue he had briefly allowed — and approved `/beep`
instead: bare opens the settings page, `on` is the 440 Hz tone, `off` is
`none`, anything else is a preset name. The aliases resolve in the PARSER,
where every other argument mapping in that file lives, so the handler cannot
be handed a name the server would reject.

The verb is a shortcut into the preference, never a parallel store, so it
reuses the rail picker's GET-merge-PUT writer — generalised from
`writeMutedTargets` to `writeNotificationPrefs` so both inherit one
additivity argument instead of two copies. Its confirmation PLAYS the preset
it selected: the one case where the feedback can be the thing itself, and it
doubles as the gesture that un-suspends the `AudioContext` — which matters
most for `/beep`, since someone typing it is explicitly avoiding the drawer.

### A comment that had been wrong since UX-6-L

`beep.ts`'s header said the beep fires "when the cic page is foreground".
The call site gates on `!effectivelyFocused(slug, displayName)` — per
CONVERSATION, not per page — so it fires for a background TAB too, which is
exactly the case deadbeef_ hit with cicchetto sitting behind a Focus
session. Corrected here rather than left as the kind of line the next reader
trusts instead of the code.

### Measured

- **This slice adds no audio bytes.** The five mp3s landed on main on
  2026-08-18 in `172df6037` ("assets(#1480): notification sound presets,
  ahead of the code that reads them"), an ancestor of the base — measured,
  because the briefing for this work carried the opposite constraint
  ("synthesised only, nothing third-party in the repo until vjt rules") and
  the ruling it was waiting for had already been given three and a half
  weeks earlier. `origin/main..HEAD` contains 0 `.mp3` paths (positive
  control: 5 exist on the base). What this slice adds is the code that reads
  them.
- Every mp3 was re-downloaded independently and is byte-identical to what
  `172df6037` committed (`cmp`, with a two-different-files negative control
  at rc=1). Sizes match the issue's manifest exactly: 12537 / 11969 / 5447.
- `afinfo` was calibrated in both directions before being believed — rc=1 on
  a text file, a duration on a known-good system AIFF. It contradicts
  `PROVENANCE.md`'s "all five are 22050 Hz stereo": the ICQ sound is 44100 Hz
  MONO, and it never came from the Archive item, so it had no reason to
  match. The table now carries a per-file format column.
- Five mutants, five targeted kills: moving the silent-preset return past
  the seam stamp; dropping the decode-cache eviction; resolving `/beep on`
  to the default instead of the tone; passing a literal preset from
  `subscribe.ts` instead of the pref; and playing the sound BEFORE the write
  lands. The first exposed a test that asserted `resumes === 0` while
  claiming to check that no `AudioContext` is built — zero either way. It
  now counts constructions.
- The dispatch characterization net moved by exactly the predicted three
  hunks (64→65 arms, one `beep` row, no new indistinguishable pair) and
  nothing else.

### Not measured, and not claimed

- **Whether any preset sounds good, or whether alk likes one.** This host
  has no audio. The issue's acceptance bar ("at least one preset alk
  actually likes") is not something a gate can answer, and the sample gain
  (0.6, one shared constant) is a judgement, not a measurement — it is one
  constant so a future ear can move it once.
- **The samples playing offline.** The `globPatterns` extension is the
  mechanism, and it is argued from how workbox precaching works, not from a
  build inspected with the network down.

### The CI red this shipped with, and the duplicate state under it

The e2e above went red on the first CI run of the PR, on exactly the arm
that reads the picker without a reload: `/beep chime`, then bare `/beep` to
open the drawer, and the `<select>` sat at `none` through 14 polls in 10
seconds. The sibling arm — same write, but a `page.reload()` before the
read — was green. That pair is the whole diagnosis: the write LANDED (the
reload proves the server has it), and the drawer could not see it.

`SettingsDrawer` kept a private `prefs` signal, hydrated once at mount, and
rendered the form from that. `/beep` writes through
`applyNotificationSound`, which feeds the SHARED mirror the server's echo —
a store the drawer was not reading for this key. So the picker rendered the
value the drawer had loaded at login.

This is the second instance of one defect, not a new one. #950 hit it when
the rail picker became a second writer of `muted_targets`, and cured it by
reading THAT ONE KEY off the mirror; the comment it left behind describes
the mechanism accurately and predicted nothing about the next key. `/beep`
was the next key. A third per-key patch would have bought the same deferral
again, so the private snapshot is GONE: its only two writers were
`refreshPrefs` and `savePrefs`, each of which already handed the identical
value to the mirror one line later, so it was a pure duplicate of state
that already existed — design discipline (1), and the parallel structure
was the bug.

The half the e2e did NOT catch is the worse half, and it is now pinned by
its own unit test. `/api/user_settings/notification_prefs` is a FULL
replace and every drawer control PUTs `{...prefs(), oneKey: value}`. With a
stale snapshot as the base, ticking any unrelated checkbox after a `/beep`
would have written `notification_sound: "none"` straight back over the
choice — a lost preference rather than a late-rendering one. Deriving fixes
both at once, which is why the cure is a deletion and not a third accessor.

One behaviour changed on purpose: the form now re-renders when a user-topic
rejoin refreshes the prefs mid-open. The controls it feeds are all
write-on-change with no dirty state, and the two whitelist TEXT fields keep
their own signals (seeded only by the drawer's own load), so nothing being
typed can be clobbered — the drawer shows what the server says, which is
the posture cic holds everywhere else.
<!-- entry #2086 -->

---

## 2026-09-11 — issue 2086: the quoted head dims by losing, and it dims the region a re-reply strips

vjt, #it-opers 18:47: *"sul reply.. facciamo sì che il colore della parte
quotata sia più 'muted' cosi si vede di più il messaggio inviato"*. A reply
is plain wire text — `<nick> …body… << ` then the answer — so in cic's own
scrollback the two halves render as one undifferentiated run, and the quote
is the longer half (up to 100 body characters since #1277 raised the #1235
cap). Render-side only: nothing on the wire, nothing in what gets quoted, no
new persisted field.

### One detector, and the offset is the general door

`PREVIOUS_QUOTE` (`quotableBody.ts`) already answers "is this quote-shaped",
and it is the predicate a re-reply strips with. The render needs the same
answer plus WHERE, which a boolean cannot say, so `startsWithReplyQuote/1`
is now derived from a new `replyQuoteHeadLength/1` — one `exec`, and its
`> 0`. The count includes the tail's trailing space, so `slice(headLength)`
is exactly what `withoutPreviousQuote` keeps.

That sharing is structural, not thrift. If the styled region and the
stripped region were computed twice they would drift, and then the colour on
screen would be describing a boundary the requote does not use — one of the
two would be lying to the reader about what "the quote" is.

The boundary is measured against the run texts joined back, which IS the
plain projection: `mircPlainText` is literally that concatenation, and
`mircPlainRuns` (#2029's strip) keeps the same text. So the same offset
holds with the strip preference on or off. One correction the requote path
forces: it matches a `.trim()`ed body while the renderer must keep every
character it was handed, so the render measures from `trimStart`. Without
those two lines a body with leading whitespace would be dimmed by nobody and
cut by the requote.

### The dimming LOSES, and it is withheld rather than out-cascaded

Constraint the issue names and the one that breaks in silence: a `\x03`
opened INSIDE the quoted head keeps applying past `<< `. The head is
therefore already part-coloured, and a dim that fought the colour would
repaint characters the sender chose on purpose.

So the class is withheld from any run carrying an explicit fg or bg — the
same `run.fg === undefined && run.bg === undefined` test the reverse line one
row above already uses. Relying on inline-style-beats-class would have been
true for a plain coloured run and FALSE for `reverse`, where the parser puts
fg on `background-color` and leaves `color` free for a class to take. It also
keeps the DOM from claiming `muted` on a span where nothing is muted, which
is what the test asserts against.

### `--muted`, and the chokepoint

`--muted` is the token every theme already defines for secondary text, so
the gallery themes and the theme editor follow for free; a literal grey would
break both. It is also the same pair timestamps run against `--bg`, so the
contrast floor is one already accepted — anything dimmer would owe a
measurement, not a taste call.

Applied at `MircBody`'s single `runs()` accessor, with no per-surface prop,
for the reason #2029 wrote three lines above it: a reply reads the same way
on every surface that renders a body, and a per-surface opt-in list is the
thing that rots. The classification is by SHAPE, so a head somebody typed by
hand dims too — acceptable by the issue's own ruling, because it looks like a
quote precisely because it is one. Colour only: muted, never hidden.

### What this does NOT claim

- No contrast measurement was taken. The claim is inheritance — `--muted` on
  `--bg` is the timestamp pair — not a fresh ratio.
- Nothing was looked at in a browser. The evidence is jsdom: the dimmed span
  boundary, the colour crossing it, and the full text still present.
- #455's emphasis markers cannot pair across the `<< ` boundary any more,
  because the run is split there. Neither can linkify join a URL across it —
  but a space sits at that boundary, so no URL could span it anyway, and a
  marker pair spanning quote-head-to-answer is not a shape anyone writes.
- Out of scope, as the issue says: turning the reply into a structured field
  with its own wire representation. This is a colour on a region that was
  already identified.
<!-- entry #2088 -->

---

## 2026-09-12 — #2088: the fourth forgotten allowlist entry, and the walk that ends the class

`cicchetto/public/sounds/` shipped with #1480 and every one of its five
file-backed samples answered `200 text/html; charset=utf-8` — the SPA shell,
under an `.mp3` URL. `@cic_static_only` in `lib/grappa_web/endpoint.ex`
matches the first path segment and did not name `sounds`.

That is the FOURTH time: #485 (the icon set), #1739 (`radio-logos/`), #1906
(`badge-96.png`), now this. All four are the same move — add something under
`cicchetto/public/`, leave the allowlist alone — and all four were measured
with the same fingerprint. A list forgotten four times is the defect; the
missing word is the symptom, so the line was worth about a minute and the
rest of this entry is about the other half.

### The discriminant is the content-type, never the status

The SPA history fallback answers `200` to any path it has never heard of,
and owes it: a hard refresh on `/theme/:id` must get the shell. So a probe
that checks `200` reads GREEN on a broken asset. Staging measured a
non-existent path and a real mp3 as byte-identical answers — same status,
same length, same content-type. Only `content-type` separates them.

This is why the new walk is rooted at a COPY of `cicchetto/public/` plus a
synthetic `index.html`, rather than at `cicchetto/public/` itself. That
directory has no `index.html`, so a missing allowlist entry there would
surface as a `404` — and the test would then be pinning a mechanism
production does not have, quietly moving the discriminant back onto the
status. The copy reproduces the real shape: allowlisted → own bytes,
forgotten → `200 text/html`.

### The walk

`spa_serving_test.exs` now walks every regular file under
`cicchetto/public/` and fails on any that does not come back `200` with a
non-HTML content-type. The failure names each path and what it actually got,
so the message is the staging table.

`Path.wildcard/1` skips dotfiles, which keeps a stray `.DS_Store` from
failing the walk. An empty walk is refuted explicitly: a missing bind mount
or a moved directory would otherwise read GREEN while proving nothing. The
per-asset tests above it stay — they pin EXACT content types
(`image/svg+xml`, `font/woff2`, `application/manifest+json`) where the walk
only pins "not the shell", and the two vite-GENERATED top-level entries
(`assets/`, `manifest.webmanifest`) have no counterpart under `public/` at
all, so only the named tests reach them.

### The bind mount is load-bearing

`cicchetto/public` had to join `WORKTREE_VOLUMES` in `scripts/_lib.sh`. The
walk's INPUT SET is that directory, and a worktree run bind-mounts only an
enumerated list on top of main's `./:/app`. Without the override, a branch
that adds a public asset walks MAIN's older tree: the new entry is invisible
and the lockstep test reads GREEN on the very branch introducing the drift.
Same failure `Dockerfile.release` hit in #1945, in the opposite direction.
The red proved the mount: `sounds/` exists only on this branch, and the
failure named all six files under it.

### MEASURED: this fix is inert on a hot deploy

The issue flagged, explicitly unproven, that `Plug.Static.init/1`'s compiled
matcher is cached in `:persistent_term` keyed on the ROOT and not on the
allowlist. Measured, in-process, against the real endpoint:

```
A current allowlist:              200 ["audio/mpeg"]
B cache entry keyed on root:      true
C stale matcher, same root:       200 ["text/html; charset=utf-8"]
D :code.load_file(Endpoint) = {:module, _}; cache survived reload: true
E after that reload:              200 ["text/html; charset=utf-8"]
```

C seeds the cache with opts compiled from an older `:only` at the SAME root
while the loaded module already carries `sounds` — and the URL goes straight
back to the shell. D and E show a beam reload does not disturb the entry.
`HotReload.reload_from/1` only purges and loads beams (it names
`persistent_term` nowhere), and `Cic.Bundle.boot/1` writes only the ROOT key,
so even `/admin/cic-bundle-changed` re-booting the same path leaves the stale
matcher in place.

**So an allowlist change needs a RESTART, or it ships and does nothing.**
The two-line cure — fold the list (or a compile-time `phash2` of it) into the
cache key so a reloaded module misses and rebuilds — was deliberately NOT
taken here: it is a hot-path change to a shared caching seam, it is the same
shape as `cached_session_opts/0` next door, and it wants its own slice rather
than riding a one-word allowlist fix.

### What this does NOT claim

- Nothing was verified on production or staging after the fix. The cure is
  measured only in the unit suite.
- The service-worker question is still open and still unmeasured.
  `vite.config.ts` precaches `**/*.{...,mp3,...}` and its `globIgnores` names
  only `radio-logos/**`, so the five samples ARE in the precache manifest. A
  client that installed a worker while those URLs answered `text/html` may
  therefore hold the shell cached under an `.mp3` key, and because workbox
  revisions are content-derived and the bytes did not change, it is not
  obvious that a new build evicts it. That is a mechanism sketched from the
  config, not an observation — no browser was involved.
- Whether the client falls back to a synthesised voice when a sample fails to
  decode was not investigated.
- The walk proves the endpoint serves the bytes. It says nothing about
  whether any of them is a playable mp3.
<!-- entry #2091 -->

---

## 2026-09-12 — issue 2091: a programmatic scroll is not paging intent, and what one tap actually costs

vjt, from a live client: tapping the floating scroll-to-bottom arrow on a
channel with thousands of unread "causes hundreds of requests". The arrow is
the jump-to-mention control (#360) and keeps that role; the animation may
stay. What had to stop was the fetching.

**The defect is an asymmetry inside ONE function body.** In
`ScrollbackPane.onScroll`, the cursor-settle block is gated on recent operator
input (`lastInputEventAtMs`) precisely because "programmatic scrolls fired by
`scrollToActivation` emit DOM `scroll` events but no preceding pointerdown /
wheel / touchmove / keydown". Three lines above it, the two blocks that FETCH
— `maybeLoadOlder()` and the `loadNewer` forward pager under
`distance <= LOAD_MORE_THRESHOLD_PX` — had no such gate. A smooth
`scrollIntoView` emits one native `scroll` per animation frame, so every frame
landing inside a pager's threshold band called a pager with nobody behind it.
The precedent for the fix was already three lines below the bug.

**The cure is the POSITIVE half of the question the settle block asks.**
`lastInputEventAtMs` infers "not the operator" from the ABSENCE of an input
event, which is enough for the cursor but not for the pagers: an operator who
wheels and then taps the button inside the 1500ms recency window still looks
like input, so reusing that gate would have suppressed nothing in the commonest
real sequence. Instead `applyMentionJump` CLAIMS the scroll it is about to
cause; both paging blocks honour the claim; it is released by the operator
taking over (`on(lastInputEventAtMs)`, beside the marker-authority hand-back it
mirrors), by the key-change cancel, and by its own quiescence timer. The gate
is on WHO scrolled and never on the thresholds, so a human scrolling the same
region pages exactly as before.

**The altitude was decided by measurement, not by taste, and the first answer
was wrong.** The claim was first made at `dispatchScrollWrite`, to cover the
whole applier dispatch surface rather than one example of it — "fix root
causes, not examples". On the full cic unit suite that moved three
previously-green specs (#608 + #1094, the `applyPrependPreserve` cases): base
7118 passed / 0 failed, seam 3 failed, narrow 7123 passed / 0 failed. The cause
is the claim's LIFETIME rather than its breadth — those cases dispatch a bare
`scroll` with no preceding input event, so a mount-time tail-follow write left
a claim standing that swallowed the operator's very next scroll-to-top.
Covering the dispatch surface honestly needs the claim correlated to the write
that made it, not a time window. **Apply:** when a gate is widened to a shared
seam, the thing that breaks is rarely the seam's breadth — it is how long the
state the seam sets is allowed to stand. Measure the blast radius before
believing the altitude argument; the rule that says to fix the class does not
say the class is reachable with the mechanism in hand.

**The reported magnitude is NOT reproduced, and that is a result.** The cost
does not scale with the buffer: it is bounded by how many animation frames fall
inside a 200px band. Measured on a frame-replay bench, one tap costs 5 pager
CALLS in the worst geometry (anchor near the loaded tail), 1 when the animation
starts near the top of the buffer, and **0** with the anchor mid-buffer — and
the verbs' own in-flight guard plus exhausted latch collapse a burst further
before it reaches the wire. The issue itself declares the "hundreds" figure
unmeasured. The defect does not depend on it: the asymmetry is read in the
code and stands on its own.

**Left OPEN, deliberately: the forward-pager ratchet.** `loadNewer` merges a
page, which grows `rows()`, which can fire the length-effect's tail-follow,
which scrolls, which can page again. It is the one plausible route to a large
number. On the bench it self-limited at 2 pages, which is evidence it exists
and no evidence about where it stops in the field; this change does not address
it, and the tail-follow write is exactly the one the narrow claim does not
cover.

**Two benches, two different quantities — and only one of them
discriminates.** The vitest bench counts the PANE'S CALLS to the paging verbs
against a mocked store, with the animation's frames replayed by hand because
jsdom animates nothing; it goes red without the cure and is the evidence the
fix works. The e2e
(`e2e/tests/issue2091-jump-does-not-page.spec.ts`) counts HTTP REQUESTS in
chromium, which is the issue's own acceptance wording, and its answer is
**ZERO ON BOTH SIDES** — measured by reverting the cure and re-running, on a
3000-row corpus with both pagers still armed. The pane's 5 calls do not become
5 requests: a smooth scroll across tens of thousands of pixels moves far enough
per frame that no `scroll` event lands inside a 200px band, and the verbs'
in-flight guard plus exhausted latch absorb the rest. **So the acceptance
number exists and it is zero, before the fix as well.** The spec is kept, and
says so in its own header, because it still guards the property and because its
positive control catches the cure's worst failure mode — gating the THRESHOLDS
instead of the CALLER.

**Apply, and it cost three fixtures to learn:** a spec that counts something
must be shown to be capable of counting it, and the only proof is running it
against the defect. Two of the three fixtures here were green for reasons that
had nothing to do with the code under test — the first drained its own 200-row
corpus during setup and latched both pagers before the gesture, and the second
asserted a precondition (`scrollTop <= 200` after a human wheel) that is
UNREACHABLE while the backfill pager is armed, since every page it pulls is
prepended and `applyPrependPreserve` pushes scrollTop back down by a page.
Neither would have announced itself; both reported green.
<!-- entry #2094 -->

---

## 2026-09-12 — #2094: the upload TTL is chosen where the files are shown

The per-request `expire` has been on the wire since the embedded host landed
— `UploadsController.parse_ttl/1` takes it from a closed ladder
(`@allowed_ttl_seconds [3600, 43_200, 86_400, 259_200]`) and 400s anything
else. Nothing in cic could reach it. The only way to say how long an upload
lives was `upload_ttl_seconds`, a per-user preference set once in the settings
drawer, translated to a host token at dispatch
(`pickHostTokenFromSeconds/2`). So retention was decided in advance, for every
future file, by an operator who at that moment had no file in front of them.

**The knob moved to the pre-send confirm (#1964), and that is the whole
change.** vjt's ruling on the three options in the issue was option 1: the TTL
picker lives inside the confirm modal and nowhere else. The known cost is
stated rather than worked around — the confirm is OPT-IN (#1883,
`upload_confirm_enabled`, default `false`), so an operator who never switched
it on cannot choose per upload and keeps exactly the behaviour they have
today. That is a real limitation, and it is the same shape as the one #1883
already accepted when it put the confirm toggle inside the TTL fieldset.

### The store learned a CHOICE, not a TTL

`ConfirmRequest` gains `choice: ConfirmChoice | null` beside `alternative` and
`attachments`, on identical terms: a pre-formatted label, pre-formatted
options, a reactive `value()` and an `onSelect` closure. `confirmDialog.ts`
does not know what is being chosen, and the modal only decides where the
control sits. Ten call sites spell `choice: null` explicitly — the same
explicit-`null` contract the two neighbours carry, so a reader sees at the
call site that a dialog asks nothing beyond yes/no.

Deliberately ONE choice and not a list of them. A confirm asks one question; a
second control on it would be a form wearing a modal's chrome.

Placement is below the file list and above the buttons, and that order is the
sentence the dialog makes: *this happens, to these, on these terms — answer*.
Above the list it would be a setting read before knowing what it applies to;
inside the list it would scroll out of sight on a twelve-file batch (the list
is capped at `40vh`).

Unlike the SettingsDrawer ladder, the control carries a VISIBLE label. #1227
removed the visible label there because a `<legend>` already named the group
and the second name ate the width; in a dialog there is no legend, and a bare
dropdown reading "24 hours" says nothing about what happens then. The `<label>`
wraps the `<select>`, so the visible name IS the accessible name — one name,
not two.

### The answer rides the QUEUE, not a module-level signal

`QueuedUpload` and `lastAttempt` both gain `ttlSeconds: number | null`. The
selection is a signal created PER REQUEST inside `openSendConfirm`, so a
displaced or cancelled dialog takes its half-made choice with it and the next
drop starts from the preference again.

Three layers at dispatch, and each one is load-bearing: the batch's own answer
first, the stored preference behind it, the host default last. An operator who
never opens the confirm still gets their preference (the opt-out path enqueues
`null`, which is the whole of the pre-#2094 behaviour); one who opens it and
leaves the dropdown alone gets the value the dropdown was showing them.

The seconds are resolved to a host token at DISPATCH, never in the dialog. A
token picked when the operator dropped the file would be a token for whichever
host was active then, and `activeHost()` is a reactive read of an admin
setting.

A RETRY re-sends on the terms that were chosen, which is why `lastAttempt`
carries the field: re-reading the preference there would silently change the
answer the operator gave, in the one path where they never see the dialog
again.

The seed is checked against the ACTIVE host's ladder rather than taken at face
value. `upload_ttl_seconds` is a bare integer with no host attached, so a
preference the current host cannot serve would seed the dropdown with an
option that is not in it — a control showing a selection it does not have.

### What was deliberately NOT built

The choice is not written back to `upload_ttl_seconds`. A one-off stays
one-off, and a dialog opened to LOOK at the files is not where a durable
preference should change by accident. No "remember this" checkbox: that is a
third control on a dialog that already gained one.

No server change. The ladder cic offers for the embedded host IS
`@allowed_ttl_seconds` spelled in seconds, and the wire shape is unmoved — no
`protocol_version` implication.

### Playwright cannot read an upload request's body — measured, and it decided the oracle

The e2e for this went red twice on the same line, and the second red is the
interesting one. The spec asserted on the multipart body of the real
`POST /api/uploads`, read off the intercepted request. It came back EMPTY.

The first cure was wrong in an instructive way. `postData()` returns the body
decoded as UTF-8 and answers `null` when that fails, which a body carrying PNG
bytes guarantees — a correct mechanism, correctly described, and **not the one
operating**. Swapping in `postDataBuffer()?.toString("latin1")` did not move
the symptom: empty before, empty after. The displacement test came back
negative, which is what retracts a diagnosis.

**What is actually true** (vjt's lead, measured here rather than left as a
guess — standalone Playwright 1.59.1 driving Chrome 152 on Windows via
`executablePath`, three POSTs through ONE collector):

| body | `postData()` | `postDataBuffer()` |
|---|---|---|
| multipart **with a `File`** | `null` | `null` |
| multipart, text parts only | `string(244)` | `buffer(244)` |
| plain `expire=3600` | `string(11)` | `buffer(11)` |

The two controls read fine through the same listener, so the collector works
and the `File` is the variable. Chromium hands a body assembled from a file to
the network stack as a data pipe and never gives the bytes to the Network
domain, so there is nothing to decode and **no amount of decoding is a cure**.
Declared limit: this is the host's Chrome and not CI's bundled Chromium build,
and one Playwright version — but the mechanism is the browser's, and CI's two
reds are the same symptom.

**So the oracle moved from the request to the CONSEQUENCE**, which is the
better one anyway: the 201's `expires_at` is what the SERVER decided, so the
spec now asserts the file really will be deleted an hour from now rather than
that cic spelled a form field correctly. It is a window (30 min .. 2 h), not
an equality, because the timestamp carries the server's clock and is read
against the runner's; the thing it must be distinguished from is the 24-hour
default, which is nowhere near either edge.

**General rule for a new e2e: an upload request body is not observable — assert
on the response, or on server state.** And the reason the second red could be
read at all is that the stages had been split one commit earlier (vjt's
review): one collapsed assertion had reported "no upload happened", "the answer
could not be read" and "the answer was wrong" with the same empty string.
<!-- entry #2096 -->

---

## 2026-09-12 — #2096: the archive rollup was already on the wire

Fairy reported an archived window holding unread being invisible until you
opened `ArchiveModal` AND expanded the right network group. The issue framed
two ways to put a rollup on the launcher: eager-load every network's archive
list on the client, or ship a server-side aggregate beside `/me`'s
`unread_counts` seed. vjt ruled for the second; both premises were wrong in the
same place, and the third option is what shipped.

### The seed already carries archived windows, measured on the artefact

`ReadCursor.bulk_unread_split/3` is driven purely from `read_cursors ⋈
networks ⋈ messages`. There is no active-window filter anywhere in it, so the
envelope carries EVERY window with a non-nil cursor — archived ones included.
#532 B has been rendering the modal's per-row badges off exactly that seed
since June, which is the same fact shipped.

That was a code read, so it was taken to the far end of the tube before
anything was built. A throwaway ConnCase test with a LIVE session against the
fake ircd (the only shape in which `build_active_keyset` is not degenerate:
without a session it falls on `{:error, :no_session}`, the keyset is empty and
every target reads as archived) read two decoded HTTP bodies in one run —
`GET /networks/:slug/archive` as the ORACLE for "is this archived", `GET /me`
as the subject. Result:

    oracle  GET /archive      : ["#m2096-archived", "#m2096-nocursor"]
    subject GET /me unread_counts: {"#m2096-archived": 1, "m2096-peer": 1}

Three controls, all asserted before any number was printed. POSITIVE: the DM
`m2096-peer` is ACTIVE (open query window + live session), the oracle agrees,
and it IS in the envelope — so the reader is pointed at the right place.
NEGATIVE A: `#m2096-nocursor` has rows but no cursor, the oracle calls it
ARCHIVED, and it is NOT in the envelope — so the envelope is not a mirror of
the listing. NEGATIVE B: an invented key appears in neither. Neither set is a
subset of the other, which is the strongest form the non-degeneracy can take.

### Why that changes the ruling rather than just the cost

vjt re-ruled on the measurement: derive client-side, no wire change, no
`protocol_version` bump, and `loadArchive` stays lazy per group. Three things
carried it.

The missing half was never the counts — it was MEMBERSHIP, and membership is
`seed − what the nav already draws`, which cic also already holds
(`channelsBySlug` fans out to every network at boot; `query_windows_list` is
pushed whole at user-topic join). Deriving beats duplicating (design
discipline 1).

A server aggregate at `/me` would have put a synchronous `GenServer.call` per
network back on the cold-load path — `Session.list_channels/2` is
`call_session` — which is precisely the work #498 took off it.

And it would have been a BOOT-TIME SNAPSHOT. Nothing re-emits it when the
operator opens the archived window, so the badge could not fall without a
second push. The derivation is live for free: open the window, it becomes
active, it leaves the set.

### Shape

`lib/archiveRollup.ts` — pure `rollupArchivedUnread(input)` plus a thin memo,
the same split as `orderUnreadWindows` / `activeWindows`. The subtraction verb
came OUT of `visibleArchiveForNetwork` into `archiveSuppressionForNetwork` +
`archiveTargetSuppressed` (`lib/archive.ts`) rather than being restated: the
archive now has two consumers asking the same question of different inputs
(the fetched list vs the seed's keys), and two statements of it would drift the
first time a window shape is added — at which point the badge counts a window
the modal does not list, a number the operator cannot chase.

`$server` is skipped (`list_archive/3` excludes it unconditionally) and so is a
slug cic renders no group for (GH #105 unbound-but-retained networks still seed
the envelope). With those two exceptions the rollup cannot over-count by
construction: a key with unread has rows, and every non-active target with rows
is in the listing.

### One real bug the badge exposed

`serverSeedCounts` is written by `/me` and the join reply and by nothing else,
so a destructive `DELETE /networks/:slug/archive/:target` left its count
standing until the next cold load. Invisible while nothing summed seed keys
with no window behind them — the modal row goes with the listing refresh, the
sidebar draws no archived window, `windowCandidates()` never enumerates one.
The rollup is the first surface that does, so `archive_purged` now also calls
`clearServerSeedCount(key)`. The read cursor in the same handler still does
NOT clear, for the reasons already written there: a cursor is cross-device
state the server owns; this map is a local projection of counts whose rows the
server just deleted.

### Mute, and three limits stated rather than discovered later

The mute is untouched on purpose. "The mute always wins" is the rule for the
on-screen AFFORDANCE and it leaves the COUNTS intact — the sidebar badges and
the modal's own rows render a muted window's numbers. A count badge inherits
that by doing nothing; subtracting mutes here would be a SECOND rule that no
other badge obeys. The badge is also NOT dimmed when every contributor is
muted (#1077's per-window treatment): "all of them are muted" is a different
predicate from "this one is", and inventing it is the same second rule.

Mentions are NOT a third pill. The issue and the rollup name messages and
events; a mention is always also a content row, so `mentions > 0` implies
`messages > 0` and omitting the pill can never hide the existence of unread —
it loses a severity signal, nothing more.

And the badge sits INSIDE the collapsed drawer: `RailActions` renders its menu
under `<Show when={expanded() || open()}>`, and `expanded()` is true only on
home (#1040). So on every other window the rollup is visible one tap in, not
zero. That is one layer better than "open the modal and expand the group" and
it is what the issue asked for; a dot on `rail-actions-launcher` itself is a
separate decision, deliberately not taken here.
<!-- entry #2098 -->

---

## 2026-09-12 — #2098: the sample precache entry never changed identity

A PWA install that cached the SPA shell under `sounds/*.mp3` stayed silent
through every later deploy, and the only field cure was deleting and
reinstalling the app. Two facts combine: until #2088/#2092 `sounds` was missing
from `@cic_static_only`, so those urls answered 200 `text/html`; and Workbox
keys a precache entry by url+revision, where the samples' url is stable and
their revision is the md5 of a file unchanged since #1480. The server fix
cannot reach such an install, because the client never asks again.

Measured here rather than reasoned, on a real build of 055c8362. The precache
manifest is injected into `dist/service-worker.js` as one array: 28 entries,
19 distinct urls. The five samples' revisions are exactly the md5 of the files
in `public/sounds/`, and `dist/index.html` is 2467 bytes — the size vjt saw
served for an mp3, so the poisoned body is the shell. Building twice across a
simulated cut (VERSION 1.5.5 → 1.5.6) moves exactly ONE manifest entry,
`index.html`; all five mp3 entries are byte-identical. That is the defect, and
the positive control is in the same diff: something did change, so the harness
is not blind.

vjt ruled to salt the revision, and the ruling's own acceptance test is the
sharp edge: the entry must change identity AT EVERY CUT, not only when the
file's bytes change. It names two admissible routes, and one of them does not
satisfy that test — moving the samples behind hashed urls makes identity track
CONTENT, so it would repair the poisoned installs once and then never move
again. The salt was chosen on that ground, not on cost; the hashed-url route is
in fact cheaper (zero recurring bytes).

Cost, measured against the estimate: the five samples are 43924 bytes
(42.9 KiB), re-fetched once per cut, which is what "43 KB" in the issue refers
to. The salt is the build VERSION and not a timestamp, so two builds of one
release still agree and a rebuild does not churn the precache.

Scope is the samples, and that is a measurement too. The icons, `favicon.ico`
and `manifest.webmanifest` are equally stable-urled and equally unable to move,
but they have always been in `@cic_static_only` — verified entry by entry
against `cicchetto/public/`, all 12 present — so no install can hold a poisoned
copy of them, and `spa_serving_test.exs` now walks that directory so none can
silently leave the list again. Salting them too would re-download 22.4 KiB per
cut against a hypothetical. Widening is one constant, deliberately left narrow.

### The guard was mute, and that is why it prints

Both refusals (`refuse/1`) write to stderr before they throw. With the prefix
deliberately perturbed to `suoni/`, the build died at the right place — the
stack names `saltPrecacheRevisions` inside workbox's `transformManifest` — but
the message did NOT appear: zero occurrences of its text in the whole build
log, against a positive control that found the frame. Rollup reports a throw
from a plugin hook as the stack alone. A guard whose reason never reaches the
operator makes them open the file to learn what a bare `Error` meant, so the
reason is printed explicitly; re-measured after the change, it appears.

### What is NOT asserted

No browser ran. The repair itself — a poisoned install refetching on the first
load after a deploy — is INFERRED from Workbox's url+revision key, not
observed: there is no e2e lane on this slice, and a precache identity cannot be
watched by installing a PWA headlessly anyway. The field half (an iOS PWA still
silent against a correctly serving origin) is vjt's measurement, reproduced
here only as far as the artefact. The e2e spec written alongside asserts the
salt on the SERVED service worker and has never been executed on this host; its
verdict is CI's.

One observation recorded and not acted on: nine of the 28 manifest entries are
duplicate urls carrying identical revisions (the icons and the webmanifest,
listed both by `includeAssets` and by the glob). Workbox dedupes an identical
url+revision pair, so this costs nothing today; it is noted so the next reader
of that array does not mistake it for a symptom of this bug.
<!-- entry #2097 -->

---

## 2026-09-12 — #2097: a withdrawn capability, and what a CAP line is allowed to be

**The defect.** `caps_active` had one writer — the CAP ACK seam — and no
removal site, so a registered-phase `CAP DEL` left the session acting on a bit
that had stopped being true. Two readers consume that bit and both were being
lied to: `prepare_label/2` kept stamping `@label=` on outbound commands the
ircd no longer correlates, and `IdentityState.account_identified?/1` kept
counting an account the ircd had stopped promising to retract. Field instance,
Solanum/Libera, an oper module reloading:
`:osmium.libera.chat CAP * DEL ?oper_realhost solanum.chat/realhost`, and the
same cap back ten minutes later as `CAP * NEW`.

**The target is `*`, not the nick, and the fix inherits the right shape rather
than inventing one.** The ACK clause already matched the target as `_`, so the
DEL and NEW clauses do the same and both advertised forms travel one code
path. A handler keyed on the session nick would have missed the very line that
filed this; a handler keyed on `*` would miss the other. One clause, no
branch.

### The surfacing path: the issue declared it unmeasured, and this is the measure

The issue asserted the missing handler (measured) but explicitly NOT where the
raw line lands — *"measure the actual rendering path before assuming the status
window is where it lands"*. It does land there, and the chain is now read end
to end: no Session.Server clause matched, so `delegate/2` handed the line to
`EventRouter`'s catch-all, which persisted a `:server_event` on `$server` with
`raw_verb: "CAP"`; `ScrollbackPane.tsx` routes any row carrying `meta.raw_verb`
to `renderRawEvent`, which has no CAP arm and falls to its default,
`*** {sender} {verb} {params.join(" ")}`. Substituting the parsed params
reproduces the reported line character for character. Honest limit: this is a
derivation that COINCIDES with the field string, not an executed render.

### Retiring the name IS the teardown — per cap, decided, not assumed

* `account-notify` — nothing else to unwind.
  `IdentityState.account_identified?/1` derives from `caps_active` at call
  time, on the stated rule that "an account counts only where the ircd promised
  to retract it". A DEL **is** that promise being withdrawn, so the verdict
  falls back to the umode axis on the next read. `state.account` stays: it is
  an observed fact, not a claim of identity.
* `labeled-response` — outbound labelling stops for free (the gate is on the
  set), and `labels_pending` is deliberately **not** cleared. Commands already
  on the wire were labelled while the cap was live and the ircd still answers
  THOSE labelled, so dropping the map would misroute precisely the replies that
  are still correlatable. The map cannot grow afterwards, its only writer being
  gated on the same cap. **Stated cost:** the lazy TTL sweep runs only on the
  next prime, which never comes once the cap is gone, so a bounded residue
  lives until the process dies. A one-shot `sweep_stale/3` inside the DEL
  clause is the tidier alternative and was left on the table rather than taken:
  it trades a still-valid correlation for a neater map.

### CAP NEW does not activate anything — and the cycle is closed by asking

Per IRCv3 cap-notify, `NEW` advertises that a capability became AVAILABLE;
enabling one still takes a `CAP REQ` and its ACK. Unioning the NEW blob into
`caps_active` "for symmetry" would declare active a cap the server never
granted — this issue's bug wearing the other face. So NEW adds nothing, and
the cap re-enters the set only through the ACK clause that granted it
originally.

That leaves a real degradation, recorded here because it was argued and then
fixed rather than discovered later: with DEL removing and NEW adding nothing,
a cycled cap would stay retired for the rest of the session even though the
upstream re-offers it. Better than the stale bit, still worse than whole. The
ruling took the fork: we re-request. The ask is intersected with
`@tracked_caps` and **not** with AuthFSM's `@opportunistic_caps` — the two hold
the same two names today, but `@tracked_caps` means "caps whose ACK this
process records", so the intersection makes it impossible to request something
whose grant we would then drop on the floor. The lists are deliberately NOT
unified: same contents, different meanings, and fusing them would be a shared
data model between two readings that may legitimately diverge.

### 🔴 The re-REQ is gated on `registered_at`, and the gate guards a session kill

`AuthFSM` matches a CAP ACK in all three `:awaiting_cap_ack*` phases and reads
it as the answer to ITS request. An ACK elicited by our re-REQ mid-negotiation
carries no `"sasl"`, so the FSM takes the else branch into
`cap_unavailable/1` — which **crashes the session** on `auth_method: :sasl`
(`:sasl_unavailable`) and **silently loses SASL** on `:auto`. A server sending
`CAP NEW` during negotiation is unusual and entirely permitted, so an ungated
re-REQ trades a rare upstream behaviour for a failed login.

The FSM phase lives in the Client process, and `Session.Server` had **no**
registration marker at all: `connected_at` stamps the TCP/TLS connect
(`:irc_connected`), not 001, and the 001 clause wrote only
`connection_stable_timer`. Hence one new field, `registered_at`, stamped on
001, whose only reader is this gate — not a third liveness axis. It is read
with `Map.get` and written with `Map.put`: a hot-reloaded pre-#2097 process has
no such key, nil degrades to "skip the re-REQ" (the safe direction), and the
map-update form would have raised `KeyError` on its next 001. Residual cost: an
already-registered process that survives a hot reload never re-requests
anything again. This field is the one piece beyond the ruling's own estimate,
and the crash above is the whole reason for it.

### One cap-list parser

Two existed with different semantics — `AuthFSM.parse_cap_list/1` dropped the
IRCv3.2 `=<value>` suffix, the ACK seam's inline copy kept it attached — and
the DEL clause would have been a third. `parse_cap_list/1` is public now and
both seams use it; `cap_req/1` followed for the same reason, the shape of a CAP
line belonging to the module that speaks CAP. `Parser` could not host it (not
exported from the `Grappa.IRC` boundary) and a new `Grappa.IRC.Cap` would have
cost a module and an export to buy a name. **Side effect on an existing path:**
the ACK seam starts tolerating a valued token. **Near-regression avoided:** the
inline copy also trimmed each token, which the FSM's did not, so the merged
parser gained the trim — unifying dry would have quietly cost the ACK path its
tab tolerance.

### The generalisation, and the price that was ruled on

With the three subcommands claimed, what still reached the catch-all was LS,
NAK, LIST and whatever IRCv3 adds next. `@no_persist_verbs` gains `cap`: the
list exists to name "verbs with no user-facing content that must never touch
scrollback", which is the wording the ping/pong entry (issue 210, 2026-07-11)
put there for the identical disease — same catch-all, same one-line cure.
Deny-listing the VERB rather than the subcommands is also what answers the
issue's own "a cap we never negotiated is DELed → drop the line quietly".

**Accepted price, ruled on explicitly rather than discovered:** the
registration-phase `CAP * LS` blob has been landing in `$server` on every
connect since the catch-all existed — `IRC.Client` forwards every parsed line
to the Session before running the FSM step, and no phase gate stands between
there and the persist. That row stops being written; rows already in scrollback
are untouched. It rides in its own commit so the generalisation can be reverted
without disturbing the capability-state fix.

### What the tests establish, and what they do not

The reds were RUN before being claimed, not predicted: with the cure stashed,
eleven fail; with it, zero. All eleven were the new ones — no collateral. The
identity test is the sharpest reading, because the same snapshot field reads
`identified: true` on the parent commit and `false` here.

Two of the new tests were written with a defective positive control (asserting
a `CAP LS ` line that this fixture's credential never sends, since it
negotiates no caps at all) and went red for that reason — the control caught
itself. They now assert that the PONG barrier line is present in the sample,
which is the stronger control anyway: it proves the observation window COVERS
the point where a re-REQ would have appeared, which is exactly what an
assertion of absence needs and a handshake line from before the feed does not
give.

Not established: nothing was measured against production (m42 is unreachable
from the agent), and the `CAP LS` leak on every connect is read from the code
path rather than observed in the field — no user ever reported it. The unit
test is what makes that claim falsifiable.
<!-- entry #2089 -->

---

## 2026-09-13 — #2089: the half of DCC the old ruling never condemned

**The reversal, and why it is not a contradiction.** #167 was closed *not
planned*; `README.md` has listed DCC under out-of-scope since `3c7a0357`;
`NON-GOALS.md` repeated it; and entry #1280 wrote **"DCC is out of scope,
permanently."** vjt reopened it on 2026-09-13 narrowed to RECEIVE only. The
reversal costs nothing in consistency because **the reason #1280 recorded is
narrower than the ban it was used to justify**: it condemns *"accepting
**inbound** P2P connections from arbitrary IRC nicks"*, and in `DCC SEND` the
OFFERER listens while the RECEIVER connects **out**. Measured on that entry's
own text — `inbound` appears once, `outbound` and `connect out` zero times.
So receive-only was never inside the recorded objection; **send is, in full,
and stays out.** Send is also dead on its own merits (vjt, 2026-09-12): the
upload store already hands out an HTTPS URL, so re-offering the same bytes
over a second transport buys nothing.

**A rule this leaves standing: a documented reason outlives the conclusion
drawn from it.** The ban was broader than its own justification, and nobody
noticed for a month because the conclusion is what gets quoted. When a
standing ruling blocks a slice, read the REASON recorded with it before
arguing against the ruling — the reason may already permit what you want, and
if it does, that is a cheaper and more honest argument than asking for an
exception.

### Passive DCC is refused, and that is what keeps the above true

In passive (reverse) DCC the sender advertises port `0` plus a token and the
**receiver** listens. Accepting it would reinstate exactly the inbound posture
#1280 condemned, which would make the paragraph above false. So it is refused
— and refused as its OWN reason (`:passive_unsupported`), distinct from
`:malformed`: a passive offer is well-formed and declined on policy, and the
user reading the status line deserves that difference. `RESUME`/`ACCEPT` are
an honest not-implemented, refused BY NAME (`{:unsupported_subcommand, verb}`)
so the report can say which verb it declined rather than going quiet.

### The address field is the sharp edge, and strictness is the guard

The historical DCC address is a 32-bit unsigned integer (IPv4 only); an IPv6
literal is the de-facto extension. Both decode to an `:inet` tuple in
`Grappa.IRC.DCC`, and the literal path reuses `Grappa.Net.IpLiteral.to_tuple/1`
— the tree's single STRICT literal parser — rather than a second hand-rolled
one. **The strictness is load-bearing, not tidiness:** `017700000001` and
`010.0.0.1` are refused rather than decoded to loopback, and a hostname is
refused outright so a peer gets no DNS-rebind lever over a connection grappa
makes on the user's behalf. Both are pinned by tests. Whether a decoded
address may be DIALLED is a separate question with a separate owner
(`Grappa.Net.Ssrf.safe_public_ip?/1`), applied with the other pre-connect
policy rather than inside the parser.

### The declared size is a claim, load-bearing before the dial and untrusted after

`size` is what the sender says it will send. The per-transfer cap is checked
against it BEFORE connecting, so an oversized offer costs no socket. The drain
then stops at exactly that many bytes regardless of how many arrive: **without
truncation, declaring low would be a general bypass of every size policy
upstream of the transport.** The opposite lie is not forgiven — closing early
is `{:short_transfer, received, declared}`, never a quiet success.

### Nothing stranger-pushed persists un-reaped — including on the abort path

Every failure arm of `Grappa.Dcc.Transfer` removes the partial spool before
returning. This one **cannot be delegated to a sweeper**, and that is the
general rule worth keeping: *an orphan no row points at is exactly what no
sweeper can find.* A reaper enumerates rows; bytes written before any row
existed are invisible to it by construction, so the code that created them
owns their removal.

Same ordering logic one step earlier: the spool file is opened BEFORE the
socket, pinned by a test that breaks both and asserts the filesystem reason.
**We do not dial a stranger we could not have stored the bytes for.**

### Attribution splits, because a failure is not the peer speaking

A DELIVERED file is the peer: they initiated the transfer, so the row carries
their nick raw-cased as a `:privmsg` — which also pushes and counts unread,
what a user wants when a file lands. A FAILURE is grappa's sentence. Hanging
*"the connection was refused"* on a stranger's nick manufactures peer speech
inside the user's own scrollback, so those rows take
`Grappa.IRC.Message.anonymous_sender/0` and `:server_event` — the same pair,
for the same stated reason, as the `$server` link-failure row: nobody said
this, and it did not come off the wire. `:server_event` does not push, so a
failure informs without buzzing a phone. This deliberately narrows a brief
that said the synthesised message is attributed to the peer's nick: true of
the delivered half, followed there, wrong for the other.

### 📥 is chosen for what it is NOT

cic keys inline media rendering off a CLOSED emoji map — 📸 image, 🎬 video,
🎵 audio (`cicchetto/src/lib/mediaLink.ts`). DCC bytes are arbitrary and
stranger-pushed, served `application/octet-stream` + `Content-Disposition:
attachment` + `nosniff`, and this slice forbids any content sniff that
PROMOTES a type. Picking one of those three **would have made the renderer the
sniffer.** The test asserts the exclusion, not the decoration.

### The filename: verbatim in the parser, neutralised at the display boundary

`Grappa.IRC.DCC` keeps the peer's filename byte-for-byte, traversal shapes and
all, because it is evidence of what was actually sent and the on-disk name is
a minted slug anyway (the `Grappa.Avatars` precedent — the filename never
reaches the filesystem). `Grappa.Dcc.Report` is where it is made safe to
render: control bytes stripped (a `\x01` or a mIRC `\x03` run must not reach a
rendered row; a CRLF must not forge a second line), length capped, non-ASCII
untouched. No attempt is made to defeat a name that merely LOOKS like a URL —
a peer who can offer a file can already send a PRIVMSG saying anything, so
that is not a capability this path adds.

### v1 is body text, so there is no wire change

🔴 **Overtaken by the consent ruling the same day — see entry #2089a.** The
paragraph below was true of the slice as SPECIFIED and is false of the slice
as SHIPPED: consent needs a surface a scrollback row cannot carry, so two
event kinds ship and `@protocol_version` goes 18 → 19. It is kept rather
than rewritten because the reasoning it records is still the pattern to
follow — what changed is the premise, not the rule.

The surface is the synthesised message alone; a richer cic interface for
offers and transfers is explicitly deferred. So no new `Scrollback.Meta`
variant ships here, which means no wire-shape change and **no
`protocol_version` bump**. The Meta docs for the link-failure row set the
pattern to follow if that changes: body for the human now, a structured copy
when a client wants to style it — additive, at the cost of the bump.

### What this entry does NOT settle

🔴 **All three were ruled the same day — see entry #2089a** for what each
answer was and what it cost. Kept as written because it records what was
genuinely unknown while the code below it was built, which is the thing a
later reader needs in order to judge it.

Three questions were open with vjt while the above was built, and nothing here
assumes an answer: the TTL floor for committed inbox bytes when a user's
`upload_ttl_seconds` is `nil` (which in the uploads model means *never
expires*, colliding head-on with the criterion sentence); how a user ACCEPTS a
held offer when v1 ships no UI and the tree has no server-side slash-command
dispatcher; and the per-transfer cap VALUE, for which
`ServerSettings.get_upload_per_file_cap_bytes/1` is no help because it is keyed
by MIME category and a `DCC SEND` carries no MIME.

Not established: nothing was measured against a real DCC peer. The transport
is tested against a fake sender written for the purpose, over real loopback
sockets; coinciding with the protocol on paper is not the same as having
spoken it. Nothing was measured on m42.
<!-- entry #2089-banner -->

---

## 2026-09-13 — #2089 (cic half): the DCC consent banner, and what it refuses to claim

The client half of the DCC consent surface: a peer offered a file, the
bouncer is HOLDING it, and a human has to answer. vjt's ruling was "banner,
same pattern as the invite", and the form to copy was #902's `:invited`
entry. The interesting part of this slice is almost entirely what it did
NOT have to build, and three things it declines to say.

### The seam was already the whole feature

`errorBanners.ts` (#119, extended by #120, #459, #902, #976, #1103, #1393d)
derives typed entries off source signals and hands the owner data, not
branches. Adding a source is one `BANNER_SOURCES` member plus one loop in
`activeBanners()`. `ErrorBanners.tsx` and `BannerSlot.tsx` are UNCHANGED —
the accept button rides `actionHint` and the × rides `dismiss`, both of
which #976 turned into data precisely so the owner would stop learning
which source is special. Three files touched in production: the registry,
one new verb module, two new `api.ts` doors.

### Placed above the invite, on a criterion rather than a preference

Both entries are person-originated offers, both sit below every fault and
the update prompt, both above push-optin. Between them the tie-break is
measurable: **a DCC offer EXPIRES** — `dcc_offer_resolved` carries
`expired` as one of its three resolutions, and the server reaches it on its
own — where an invite is not lost by waiting. Nothing drops an `:invited`
window except answering it, and the server re-announces it on every cold
subscribe; that re-announcement is what #976 was filed about. The entry a
delay can destroy goes first.

### Three things the copy is careful NOT to say

*The size is not a fact.* The peer declares the length in the CTCP and the
transfer truncates at it. The banner says "the sender's claim" out loud,
because a flat number would have grappa vouching for a stranger's. Rendered
through the shared `formatBytes` (#411), so a size reads the same here as
in every other cap surface in cic.

*The file does not land on this device.* The accept door answers **202**:
the transfer runs detached and the bytes are fetched later over the file
door. "Accept" read as "download to my phone now" is the wrong model to
leave someone with, so the copy names grappa as the destination.

*The placement is absent from the text.* `channel` is frequently `$server`
(the #546 rule: a stranger's CTCP mints no window), and "in $server" names
an implementation detail as if it were a room. The store keeps the
placement because the server chose it; the banner does not recite it.

### The refusal is NOT described as local, and that is deliberate

#976's invite copy ends "nothing is sent to the IRC server", because IRC
has no DECLINE verb and an operator who suspects otherwise ignores the
banner. The DCC equivalent would be a claim about what the refuse door does
upstream — whether it emits a `DCC REJECT` — and that door is not built
yet. Rather than guess, the × says what it does (`Refuse the file X from
Y`) and claims nothing about the peer. When the server half lands, whoever
knows the answer should add the sentence; the copy is one string.

### Neither control drops the banner, and that is the load-bearing part

`dccConsent.ts` imports no store at all. The mirror (`dccOffers.ts`) drops
an offer when the server says `dcc_offer_resolved`, never when a button is
pressed. Wrong twice otherwise: the 202 means the transfer can still fail
after the click, so hiding the banner reports a success that has not
happened; and the resolution fans out to every device, so a drop here and
nowhere else leaves the phone showing a file the laptop thinks is gone —
#976's shape with a file attached. Three mutants confirm the tests see it:
moving the loop below the invite, adding an optimistic `resolveDccOffer` to
the accept verb, and making the × also hide locally each kill exactly one
assertion and no other.

### What is NOT established

**No e2e, and it is not an omission that can be closed from here.**
Measured on this base (`2e176355d`): `Grappa.Session.Wire.dcc_offer/6` has
**no production caller** — `grep -rn dcc_offer lib/` returns the builder,
one comment in `protocol.ex` and one in `report.ex` — and `event_router.ex`
names DCC only in four comments. The router carries no `dcc` route. So no
peer action, real ircd included, can make a `dcc_offer` reach cic on this
branch, and the accept/refuse doors would 404. The spec becomes buildable
at the union with the server half; writing one now would ship a red.

Nothing was measured against a real DCC peer, and nothing on m42. The two
REST paths are written against shapes that were DECIDED but not yet
compiled — an integration point, not a verified one. The `/api` prefix in
the pinned contract note is NOT the client path: every cic door under
`/networks/:network_id/*` is mounted without it (`deleteInvite`,
`postJoin`, `postPart`), so these two follow suit; if the server half
mounts them elsewhere, these two lines move.
<!-- entry #2089a -->

---

## 2026-09-13 — #2089a: consent, and the price of answering a stranger

Entry #2089 built the RECEIVE half and closed with three questions open.
All three were ruled, and the shape of the answers changed enough of that
entry that two of its claims are corrected there in place rather than left
to be quoted. This entry records what the rulings decided, what they cost,
and the decisions taken underneath them that nobody ruled on.

### The correction that matters most: there IS a wire change

#2089 said *"v1 is body text, so there is no wire change … no
`protocol_version` bump."* That was true of the slice as specified and is
false of the slice as ruled. Consent needs a surface: an offer has to be
shown to a human before anything is dialled, and a scrollback row cannot
carry a button. So two event kinds ship — `dcc_offer` and
`dcc_offer_resolved` — and `@protocol_version` goes 18 → 19.

That is an ADDITIVE change and it still bumps, per the 2026-08-21 ruling
(#1393d): the number is only worth comparing against if it is total.

**The banner also widens the surface the issue body asked for**, which
said "only the synthesised message". A banner is interface. It is here
because the ruling asked for it, not because the slice grew on its own —
recorded as a deliberate extension rather than smuggled.

### An offer has no `state` field, and that is a boundary

`dcc_offer` carries no window state, deliberately. An offer sits IN a
window; it is not one. With a `state` field cic would mirror it into
`windowStateByChannel` and draw a pseudo-window for a file nobody has
accepted yet. The channel it carries says where to RENDER, and for a
stranger that is `$server` — `EventRouter.ctcp_query_channel/3`, the #546
rule, CALLED rather than restated, so a DCC offer mints no more of a
window than a VERSION probe does.

### A `DCC REJECT` is not sent, and this is the decision to remember

`decline_invite/3` sends nothing upstream because IRC has no DECLINE verb.
DCC *does* have `REJECT`, and the refuse door still sends nothing.

A REJECT confirms two things at once to a stranger whose CTCP was
unsolicited: that this nick is online, and that a **human read their offer
inside the hold window**. That turns an ignored message into a free
presence-and-attention probe, repeatable at whatever rate the upstream
allows. Sending nothing is indistinguishable from being away, offline, or
running a client that does no DCC — the sender cannot tell which, and that
indistinguishability is the property being bought.

What it costs the peer is bounded and theirs: their own listening socket
times out on its own schedule. **The general rule: before answering an
unsolicited stranger, ask what the ANSWER tells them that silence does
not.** The client copy must therefore say what the × does, never what it
spares the sender.

### The held set is memory, and a crash is the correct reaper

An offer is a live TCP endpoint of the peer's. It is worth nothing once
the session process dies, and a row that outlived it would invite an
operator to accept a file from an address the offer no longer describes.
`Grappa.Session.DccOffers` is therefore a pure struct inside
`Session.Server`'s state, copied almost line for line from
`Session.WindowState`'s `:invited` — the precedent vjt named. The BYTES
are the opposite case and keep their table: they exist, they cost disk,
and somebody has to collect them.

Three departures from that precedent, each measured rather than inherited.

**The ceiling is enforced inside `hold/4`, not by a sibling predicate.**
`invite_admissible?/2` is separate because re-affirming an invite on a
channel already `:invited` writes a key that exists and so cannot grow the
store — a subtlety the caller must be able to ask about. No such case
exists here: every hold mints a fresh handle, so every hold grows the set,
and one door that cannot be bypassed beats two that agree by convention.

**No timer reference is kept and nothing cancels an expiry.** One
`Process.send_after/3` per held offer; a resolved offer leaves a timer
that fires into a `drop/2` answering `{:error, :not_held}`, which is
ignored. Keeping the ref would buy the cancellation of a message that is
already a no-op, and cost a field whose housekeeping must stay exactly in
step with the map it decorates — plus the cancel-and-drain race at all
three exits. Handles are 16 random bytes, so a stale one cannot expire a
fresh offer.

**`drop/2` is ONE verb for accept, refuse and expiry.** They differ only
in what the caller does next and in the resolution atom on the wire. A
second copy of the removal under a second name would be the shared data
model with a type flag rather than the shared verb.

### The numbers are OURS, and they are argued where they live

vjt ruled the SHAPE twice and never a value. Each constant is derived from
something the house already answers, and each derivation is in the source
next to the number:

| constant | value | derived from |
|---|---|---|
| `Dcc.@max_transfer_bytes` | 10 MiB | the `:document` category default — the answer already given to "a file we cannot classify" |
| `Dcc.@global_cap_bytes` | 1 GiB | 100 full transfers, a tenth of the uploads budget |
| `Dcc.@max_retention_seconds` | 259 200 | the longest rung of the upload TTL ladder — stranger-pushed bytes may not outlive the longest retention offered for a user's OWN content |
| `Dcc.@connect_timeout_ms` | 5 000 | NOT ours: `Net.ImageFetcher.Req` already answers "how long to dial an address a stranger published" for the CTCP AVATAR path |
| `Dcc.@idle_timeout_ms` | 30 000 | ours — see the gap below |
| `Policy.@daily_accepts` | 10 | every accept costs a human a click |
| `DccOffers.@held_cap` | 16 | smaller than `@invited_cap`'s 64: an invite never expires and had to fit a real backlog, an offer expires on its own and each entry is a banner competing for one screen |
| `DccOffers.@hold_seconds` | 300 | ours — how long a banner may claim a stranger's socket is still there before the claim is likelier false than true |

They are **module attributes, not operator settings**, against the word
"manopola" in the ruling. The argument is `Grappa.Avatars`': a store that
grows from OTHER people's content is not a preference the holder should be
able to raise. An operator setting here is a knob whose only use is to
make the ceiling higher for the one party who did not choose to be
offered the file.

### Retention: `nil` is the default state, not an opt-out

`dcc_files.expires_at` is `NOT NULL`. The nullable shape, which in
`uploads` means *never expires*, is unrepresentable — that is the whole
first ruling. `Dcc.retention_seconds/1` supplies the ceiling when the
subject's TTL is `nil` and CLAMPS it when it is larger, closing the
contradiction #2089 flagged: `UserSettings.get_upload_ttl_seconds/1`
returns `nil` by default and `Uploads.list_expired/1` enumerates only rows
with a non-null `expires_at`, so a null here would have meant *never
collected*.

### Known gap, named rather than cured: the idle timeout bounds SILENCE

`@idle_timeout_ms` is per-`recv`, not a total. A sender dripping one byte
every 29 seconds holds a socket, a file descriptor and a task for as long
as it likes; only a TOTAL budget stops that, and `Transfer.run/3`'s opts
do not carry one. The contract was fixed before this was noticed and is
not widened here. The exposure is bounded by the daily accept quota and by
the fact that every one of those accepts cost a human a deliberate click
on a stranger's file — but it IS unbounded in duration, and that is stated
rather than left for someone to find.

### The happy accept path is not end-to-end constructible, by construction

`Policy.admit_offer/1` refuses a loopback address. That is the SSRF
property and it is absolute, so an offer that reaches the held set can
never point at a fake sender a test could run — **the security property
and the testability are the same fact seen twice.** It is not worked
around, and no seam was added to plant a held offer: the transport is
covered against a real fake sender over real loopback sockets in
`Grappa.Dcc.TransferTest`, and the session's half is driven with the exact
`{:dcc_transfer_done, …}` message the detached task sends. The one seam
left untested is the three-line closure between them, and it is named
here rather than implied by a green suite.

Not established, unchanged from #2089: nothing was measured against a real
DCC peer, and nothing was measured on m42.
<!-- entry #2089b -->

---

## 2026-09-13 — #2089b: a gate behind a red gate has not passed, it has not run

The RECEIVE slice closed with `scripts/check.sh` red on exactly one
thing: `Mix.Tasks.Grappa.WirePinTest`, *"The wire shape changed and the
protocol version did not"*. The diagnosis was correct and the fix was one
number. What the fix uncovered is the part worth recording.

### The bump: a REST error token is wire shape

The last commit of the slice enrolled `:not_held` in
`GrappaWeb.ErrorTokens.rest_error_token/0` — the 404 the four DCC consent
doors answer when an offer id names nothing in the session's held set.
That is a member added to a CLOSED SET the wire codegen renders into both
client artefacts, so the shape moved.

Measured, not deduced: with that token removed and nothing else touched,
`mix grappa.wire_pin --check` returns rc=0 «agree». The digest moves for
it alone. And after `--update`, the pinned digest is byte-identical to
the `now` the check had been reporting — confirming the version is pinned
NEXT TO the shape rather than mixed into it, which is what lets the gate
distinguish "shape moved, number still" from "both moved".

`@protocol_version` 19 → 20, `min_protocol_version` unchanged at 1.

The argument against bumping — «no client reads `not_held` today» — is
the one this project has already measured as wrong. It is what kept the
number at `1` from #447 through five additive fields that cic later came
to REQUIRE. Additivity describes what the SERVER emits and says nothing
about what a CLIENT requires; the break the number exists to catch runs
new-client → old-server. `:not_invited`, the token on the twin consent
door, took its own bump on the same grounds, so the precedent is not
merely general but adjacent.

### The finding: two gates had never run, and nobody could tell

`ci.check` shells every step through `mix cmd` so the chain HALTS on the
first non-zero. `mix dialyzer` and `mix docs` sit BEHIND `mix test`.
While the wire-pin test was red, neither had ever executed against this
slice — and the run's output is indistinguishable, at a glance, from one
where they ran and passed: there is no "skipped" line, the alias simply
stops.

Closing the red let them run for the first time. Both had something, and
all four findings are the same shape — a declaration wider than the thing
it describes:

- `Dcc.transfer_opts/0` specced `pos_integer()` for two values Dialyzer
  knows exactly, and a possibly-empty list for a literal that cannot be
  empty.
- `Session.Server.broadcast_dcc_resolved/4` specced `:ok` while returning
  `Broadcaster.to_user/2` raw, which is `:ok | {:error, term()}`. The
  three sibling helpers (`broadcast_channels_changed/1`,
  `broadcast_archive_changed/1`, `broadcast_window_state/2`) all put the
  `:ok =` assertion INSIDE the helper — that placement is what makes
  their `:: :ok` true rather than optimistic. This one had it at the four
  call sites, so the spec was a claim nothing enforced.
- Both `refusal/0` references in the `Report` moduledoc are `@type`s
  spelled as functions. The house writes `t:Mod.type/0`, in 77 places.

None is a behaviour defect. That is the point: **the cost of a halting
alias is not the steps you know are red, it is the steps you believe are
green.** A report that says "check.sh: 1 failure, and it is the wire pin"
is true and still misleading, because it invites the reader to price the
remaining gates at zero when their real value is unknown. Say instead
which gates DID NOT RUN.

### The fourth home of a new error token

CLAUDE.md already records that a new `FallbackController` arm touches
THREE places — the clause, the `@spec` union, and `ErrorTokens` — and
that only the third is discoverable by grepping the atom. The bump found
a fourth, on the client: `friendlyApiError.ts` narrows the generated
token union to `never` in its default arm, so a token with no `case` arm
is a tsc compile error. It fired the moment the artefacts were
regenerated.

That guard is working exactly as designed and should be read as the
client half of the same closed set, not as an obstacle: a token the
server can emit and no client can phrase is a 404 the user reads as a
blank. The copy chosen is deliberately its twin's shape — `not_invited`
reads *"That invite is already gone."* — because every reachable case is
benign and self-correcting, and it names no file, since the caller held a
handle and `Dcc.Report.display_filename/1` is the one speller of that
string.

Not established, unchanged from #2089 and #2089a: `scripts/integration.sh`
has still not been run, nothing was measured against a real DCC peer, and
nothing was measured on m42.
<!-- entry #2089d -->

---

## 2026-09-13 — #2089d: why the DCC spool is not the upload store, written down late

The code has held this decision since the slice shipped: DCC bytes go to
`Grappa.Dcc`'s own spool, its own root, its own cap, its own reaper and
its own authenticated route. What was never written down is WHY, and the
reason it matters is that the issue body asked for the opposite — the
bytes were to "land in the existing upload store as if the user had
uploaded it". A decision that reversed the spec and left no argument
behind is one rewrite away from being reversed back by someone reading
the issue and not the code. **The defect recorded here is the missing
reason, not the behaviour.**

Salvaged from the superseded first iteration of this slice (branch
`w1-2089`, never merged), whose entry carried the argument and was
rewritten out.

### Two measurements against reusing the upload store

**The MIME allowlist is CLOSED, and a `DCC SEND` carries no MIME at
all.** `UploadsController`'s `@mime_categories` is commented in the
source as exactly that — *"Closed allowlist: unknown MIME → 415"* — over
image / video / document / audio. A DCC offer carries a filename, an
address, a port and a size; there is no content type anywhere in the
wire shape. So reuse forces a choice between refusing everything outside
the allowlist, which rejects the archives that are most of real DCC
traffic, and punching a hole in the allowlist, which weakens the upload
surface that already exists for everybody. Neither is a trade this slice
is entitled to make on the uploads context's behalf.

**`GET /uploads/:slug` is public and unauthenticated by design.** The
router says so in as many words (*"NO `:authn`"*), and it is safe there
because the 26-char base32 slug is a capability: `Uploads.get_by_slug/2`
collapses FOUR distinct rejections into one `{:error, :not_found}` so
the route offers no existence oracle. That posture is right for content
a user chose to publish and wrong for bytes a stranger pushed at them —
committing those there makes grappa an anonymous public file host, with
the host's own users carrying the consequences.

### The third argument was already on main, and I nearly missed it

Entry #1280's closing paragraph already reserves the *"public,
unauthenticated `GET /uploads/:slug` route ... for content the
operator's own users chose to publish — never a proxy for arbitrary
third-party URLs"*, and its 2089 amendment says the ruling REINFORCES
that rather than bending it. So it is cited here, not restated.

⚠️ Worth recording as method: the grep that went looking for that
sentence came back EMPTY, and the sentence is right there. It is wrapped
across a line break, so no line contains the phrase being searched for.
The only thing that stopped a false "not documented anywhere" was a
positive control confirming entry #1280 existed at all, which made the
empty result implausible enough to look again by hand. **A grep over
prose is a grep over LINES; an absence verdict on wrapped text needs a
control that proves the search could have succeeded.**

### The rejected alternative, and the precedent that settles it

`Grappa.Avatars` faced the same question — a stranger-declared resource
that grappa fetches — and answered it the same way: its own context, own
storage root, own caps deliberately independent of the uploads budget,
own TTL, own reaper. A shared data model with a type flag across two
trust domains is the boundary violation CLAUDE.md names, not the reuse
it encourages. The HTTP READ path from the issue survives intact; only
the STORE was refused.
<!-- entry #2089c -->

---

## 2026-09-13 — #2089c: the e2e the previous entry said could not exist, and the two mutants that killed it

Three facts about the DCC consent banner that the `#2089 (cic half)` entry
could not carry, because all three happened after it was written and inside
the same pull request.

### The "No e2e" item is retracted, by the condition it named itself

That entry's `### What is NOT established` opens with **"No e2e, and it is
not an omission that can be closed from here"**, and the reasoning was right
for the base it named (`2e176355d`): `Wire.dcc_offer/6` had no production
caller, `event_router.ex` named DCC in four comments only, and the router
carried no `dcc` route — so no peer action, real ircd included, could make a
`dcc_offer` reach cic, and both doors would have 404ed.

It also stated the condition that would retire it — *"the spec becomes
buildable at the union with the server half"* — **and that condition was met
inside the same PR**, which merged as `87c0ec398` carrying both halves.
`cicchetto/e2e/tests/issue2089-dcc-consent-banner.spec.ts` is on main, and
it passes against a real bahamut.

**The old sentence is left standing on purpose.** A dated entry is evidence,
not documentation: that one argues *from* a base on which the spec really was
not constructible, and a find-and-replace would destroy the record that the
condition was ever unmet while leaving behind an argument with no premise. A
claim that has expired is retracted by a later entry; it is never edited out
of the earlier one. The general rule this instance serves: **an item under
"what is NOT established" is a dated measurement, so it can expire without
anyone lying — and the entry that resolves it owes the retraction.**

⚠️ This retracts that ONE item and nothing else in the section. Nothing was
measured against a real DCC peer, nothing was measured on m42, and
`scripts/integration.sh` has still not been run.

### Why the spec needed a discriminator that is not the banner

Both answers make the banner go away, so "the banner disappeared" tells the
two apart not at all — it is the single most tempting assertion here and it
is worth zero. The discriminator is the **scrollback**, and it comes out of
the server's own design: a refusal says nothing and must leave no row ever,
while an accept starts a transfer whose outcome lands as a row whichever way
it goes. So the asserted pair is one filename with exactly one row and one
filename with none.

### The two mutants, and the one that was thrown away before them

These verdicts lived only in the pull request body until now. A PR body is
not the permanent record; this file is.

**The discarded one comes first, because it is the instructive one.** The
initial attempt deleted the derivation outright. That does not produce a
mutant, it produces a build failure: two bindings fell unused, `tsc --noEmit`
raised TS6133, and `bun run build` is `tsc --noEmit && vite build`, so vite
never ran. The dist was left **empty** — and an empty dist differs from the
green digest for entirely the wrong reason, so the arrival oracle read it as
CHANGED and would have credited a behaviour change that never shipped. Two
things came out of throwing it away: **a mutant must break the BEHAVIOUR, not
the build**, and every mutant is now built locally before a stack round is
spent on it; and the oracle grew a **cardinality check**, so an empty dist can
no longer masquerade as a changed one.

The two that replaced it both compile, and both died:

| mutant | what it changes | how it died |
|---|---|---|
| **M-A** | the `dcc-offer` derivation neutralised (still type-checks) | the FIRST `toBeVisible`: `locator('.error-banner[data-source="dcc-offer"]').filter({ hasText: 'refused-holiday.tar.gz' })`, `Expected: visible`, `element(s) not found`, 15000 ms |
| **M-B** | the accept and refuse verbs swapped | every earlier assertion GREEN, then the accepted file's row count: `locator('[data-testid="scrollback-line"]').filter({ hasText: 'accepted-notes.bin' })`, `Expected: 1  Received: 0`, `28 × locator resolved to 0 elements`, 25000 ms |

**M-B is the load-bearing one, and M-A alone would have been a comfortable
lie.** M-A kills the first assertion in the file, so it proves only that the
banner appears at all and leaves the discriminator — the entire reason the
spec exists — unfalsified. M-B reaches all the way to the row count with
every assertion above it green, and *that* is the finding: it is direct
evidence that the banner appears and disappears **identically** under the two
answers, so nothing above the scrollback can tell them apart. A suite whose
only mutant is M-A would report the same green while silently accepting a
product that refuses when told to accept.

### A substring of a number is not an assertion about that number

The spec first asserted `toContainText("4 KB")`. **Measured, not suspected:
that also passes against `14 KB` and against `24 KB`** — so an arithmetic
drift in the rendered size would have sailed straight through the assertion
written to catch it. This is a false green in the shipped spec, caught before
merge and cured in its own commit: two loose asserts (`"4 KB"` plus
`"claim"`) collapse into one anchored fragment, `(4 KB, the sender's claim)`,
and the opening parenthesis is what makes those same drifts fail.

The expectation is **frozen** rather than recomputed with `formatBytes`, and
that is the stronger oracle here rather than the lazier one. Measured across
six plausible drifts of the formatter, a recomputed expectation passes **six
out of six** — it is the same rule that rendered the banner, so it cannot
disagree with it — while the frozen string catches four. The two it misses
(base-1000, and round instead of floor) render 4096 as `4 KB` either way and
would escape any oracle built on that value.

This is not a licence to hardcode, and the split is the point: cic's vitest
suite calls the real `formatBytes`, because its job is to pin that the banner
goes through the one shared spelling; this spec pins what a human sees. Two
oracles, two contracts. **The general rule: `toContainText` on a bare number
is a substring match, so it asserts a prefix and not a value — anchor it on a
neighbouring character or assert nothing.**

Not established here: both mutants were run before the anchoring commit, so
their line numbers have moved. The verdicts carry across it — the anchor was
inserted *above* the discriminator and does not touch the row count M-B dies
on — but no mutant was re-run afterwards.
<!-- entry #2107 -->

---

## 2026-09-13 — issue 2107: the guard one promotion door had and the other did not, and the door that has to open because the other one stays shut

Reported by morph on a self-hosted instance: registering a nick flipped a
credential's `auth_method` from `:server_pass` to `:nickserv_identify`, and
every attempt to set it back answered
`server_pass: must be re-supplied when auth_method changes`. The stored
`server_pass_encrypted` was intact the whole time. Two independent defects
sitting on top of each other; either alone is an annoyance, together they are
a dead end by construction.

### Defect 1 — the promotion that did not ask

`Credential.registration_changeset/2` (#349, the wizard's commit-on-`+r`) cast
`auth_method: :nickserv_identify` unconditionally. Its own docstring already
said what it was for — a `--auth none` credential that has just registered a
nick and must auto-identify from now on — and its own docstring already
explained why it is a SEPARATE changeset from `password_changeset/2`: *"so the
SET PASSWD path can NEVER accidentally flip a SASL/server-pass credential's
auth method"*. That separation was necessary and not sufficient. Keeping the
flip out of the sibling verb does nothing about the verb that carries it.

The sibling promotion door has been guarded since #124:
`Credentials.update_credential_password/2` promotes only when the current
value is `:none`, with the reason written out — *"rewriting `:sasl` or
`:server_pass` would change what the password is SPENT ON and break a working
handshake"*. That is the same sentence this path needed. Rather than copy the
three-line `if` into the schema, the guard MOVED: it is now
`Credential.promote_none_to_nickserv_identify/1`, public on the schema module,
and `Credentials.update_credential_password/2` calls it. Two doors, one gate,
one place to change it. The net line count goes down.

This is the #1028 / #1032 / #1044 family reappearing on a different column.
Those were `password_encrypted`: a fold path overwrote the secret on
`:server_pass` / `:sasl` rows while the promotion path checked first. The
shape is identical — *the guard one path has, the other does not* — and the
cure is the same one, applied one field over. The fold is not involved here,
and the mechanism is different; only the shape repeats.

**Named consequence, not a side effect.** Registering a nick on a credential
that already authenticates some other way now stores the REGISTER password and
leaves the method alone, so that nick is NOT armed for auto-identify and can
still be services-enforced on the next reconnect. That is the correct trade —
a stomped `:server_pass` breaks a working handshake immediately, and used to
be unrecoverable — but it is a real gap and the enum is why: there is no value
that means "server PASS *and* NickServ IDENTIFY". Inventing one is a design
question, not a bugfix, and is deliberately not answered here.

### The class, measured

`registration_changeset/2` is one site. Census of every place in `lib/` that
writes a FIXED `auth_method` value onto an existing row (as opposed to
accepting one from operator input, or setting one at bind time where there is
nothing to stomp):

| site | guard |
| --- | --- |
| `Credential.registration_changeset/2` | none — this defect |
| `Credentials.commit_visitor_password/3` | none |
| `Credentials.update_credential_password/2` | `:none`-gated since #124 |

Three sites, one guarded. The census command was run with both controls: it
finds the guarded site (positive — an unfiltered grep that cannot see the one
known-good case is measuring nothing), and returns rc=1 on an `auth_method`
value that does not exist (negative).

**`commit_visitor_password/3` is the same SHAPE and is not a defect, and the
reason is reachability rather than a guard.** Every write of a visitor
credential's `auth_method` in `lib/grappa/visitors*` is `:none` (creation) or
the derived in-memory session plan; the only DB promotion is that one, to
`:nickserv_identify`. So the reachable set for a visitor row is
`{:none, :nickserv_identify}` and the unconditional `put_change` is idempotent
by construction, exactly as its comment claims. `:server_pass` is additionally
blocked structurally by `validate_server_pass_is_user_only/1` (#1044). It is
left alone ON PURPOSE: adding a gate there would assert a property the code
already has, and would read as if the visitor path had once been able to reach
`:sasl`. If a future door ever gives a visitor a second auth method, that site
becomes a defect the same day — it is listed here so that day is not a
rediscovery.

### Defect 2 — and why only the validator was allowed to move

With the method stomped, the row could not be moved back through any REST
door, because BOTH doors were shut at once:

* the admin PATCH whitelist (`@allowed_update_keys`) does not carry
  `server_pass`, and extra keys are rejected outright — so the secret cannot
  be re-supplied;
* `validate_secret_present/3` hard-errored on ANY `auth_method` change unless
  the virtual secret was present in that same changeset — so the change cannot
  be made without re-supplying it.

Only one of those may move here. **Adding `server_pass` to the admin PATCH
whitelist would open a NEW WRITE DOOR FOR A SECRET**, which is a
security-surface decision and not a side effect of a bugfix. This repo already
excludes fields from that whitelist on purpose — `tls_verify` (#1677) is
projected READ-ONLY for exactly this reason. So the whitelist is deliberately
left as it is; if the way back should also carry a fresh secret, that is a
separate, explicit call.

### Why the validator's relaxation is slot-aware and not blanket

The obvious cure is "accept a stored secret whenever the target method already
has one on the row" — move the stored-secret arm above the
`auth_method`-changed arm. **Measured: that breaks two tests that were already
green on `origin/main`** (`update_credential!/3 rejects auth_method change
without a fresh password`, and `update_credential/3 … returns {:error, …} on
invalid attrs`). It is not test noise; those tests are the guard, and the
blanket form deletes it silently. The guard's stated purpose is to stop an
operator *"accidentally promot[ing] a NickServ-IDENTIFY password into a SASL
credential — different upstream auth surface, almost certainly a typo"*.

The discriminator that reopens morph's door without deleting that is already
in the file: **#1044's slot table.** `server_pass_encrypted` has exactly ONE
spender, so a value stored there can only ever have been written as a server
PASS — switching INTO `:server_pass` spends it for precisely what it was
stored for, and there is nothing to re-purpose. `password_encrypted` has
THREE spenders (`:auto`, `:sasl`, `:nickserv_identify`) across TWO upstream
surfaces (NickServ IDENTIFY vs SASL PLAIN), so a change into that slot is the
typo the guard exists to catch. `validate_secret_present/4` therefore takes
the slot's kind — `:dedicated | :shared` — from the same table that already
picks WHICH secret to require, so a sixth auth method has to declare which
kind of slot it spends instead of inheriting an answer.

Stated plainly because it is a deviation: the instruction was the blanket
form. The blanket form was written, run, and produced the two reds above; the
slot-aware form is the same cure with the one discriminator that keeps the
pre-existing guard alive, and it is four lines longer than the swap it
replaces.
<!-- entry #2109 -->

---

## 2026-09-13 — issue 2109: the middle link of the archive unread chain, and why the per-network split is the primitive rather than a second sum

`ArchiveModal` draws one collapsible `<details>` per network. The rows inside
a group have carried unread badges since #532 B and the launcher that opens
the modal has carried the cross-network rollup since #2096 — and the
`<summary>` between them carried nothing but the slug. Every group starts
COLLAPSED, because the rows are lazy (`onToggle` → `loadArchive(slug)`), so
the launcher announced "something is unread behind this door" and the operator
then had to expand each network in turn to learn which one. With more than a
couple of networks that is the same blind hunt #2096 removed, one level
deeper.

Measured before the cure, on the artefact rather than on the source: the
`ArchiveModal` component test asserting a badge on the header failed with
`Unable to find an element by: [data-testid="archive-group-unread-freenode"]`,
and the DOM it printed alongside reads `<summary
class="archive-modal-group-summary">freenode</summary>` — the slug, and
nothing else.

### The split is the primitive; the launcher's total is its fold

The issue's invariant is stated as a chain: a group's badge equals the sum of
the row badges that group would draw, and the launcher's badge equals the sum
of the group badges. Three numbers that contradict each other are worse than
the missing badge, and the second half of that chain is the half a second
traversal would eventually break — both numbers are on screen at the same
instant, the group headers under the launcher that opened them.

So `rollupArchivedUnreadBySlug/1` does the traversal and
`rollupArchivedUnread/1` is now `sumRollups(rollupArchivedUnreadBySlug(input))`
— nine lines, O(networks), and the launcher cannot disagree with the groups
because it has no independent way to count. The reactive half mirrors it: ONE
memo over the live signals, and `archivedUnread` folds that memo rather than
re-running the subtraction. Every exclusion #2096 encoded is inherited
unchanged and re-pinned per group (`$server`, a live channel, an open query, a
pseudo-row, a slug with no rendered group, and issue 1985's parked network
whose nav draws nothing and whose entries therefore all count).

A slug holding no archived unread is ABSENT from the record rather than
present at zero: the badge renders on `> 0`, so a zero entry would buy nothing
and would turn "which networks are holding something" into a filter at every
call site instead of a key test.

### The slug became its own element, and that was not cosmetic

`issue473-rail-actions-drawer.spec.ts` asserted
`toHaveText(NETWORK_SLUG)` on the `<summary>` — i.e. on its whole
`textContent`. A badge appended to that summary makes the assertion read
`bahamut-test3` **only when the network happens to be holding archived
unread**, which in a suite sharing one account across specs is a red that
appears and disappears with whatever ran before it. The slug now lives in
`<span class="archive-modal-group-slug">` and the spec asserts on that span:
the claim it makes is "the group is LABELLED with the slug", and that is what
the span holds. Same lesson as the `::before`-sigil rule the modal's own
moduledoc already carries — the thing under assertion gets a node of its own,
or a sibling node silently redefines it.

### The class, and the one member left open

The class is "a surface that draws unread for windows the operator cannot see
without a further interaction." The first instrument tried for the census —
grep for the components that iterate `channelsBySlug()` / `queryWindowsByNetwork()`
— **failed its positive control**: it does not name `ArchiveModal`, a known
member, because the modal reaches its rows through `visibleArchiveForNetwork`.
The instrument that passes both controls is a grep for the render sites of the
unread pills themselves (`sidebar-msg-unread` / `bottom-bar-msg-unread` /
`<WindowBadges`), which finds exactly five files: `WindowBadges` (the shared
triad), `Sidebar` and `BottomBar` (whose rows are always on screen),
`ArchiveModal`, and `RailActions`.

That leaves one uncovered link, and it is one level ABOVE this issue rather
than below it: `RailActions` renders `.rail-actions-menu` under
`<Show when={expanded() || open()}>`, and `expanded()` is true only on the
`home` and `admin` window kinds. On every channel, query and server window the
menu is collapsed by default, so #2096's launcher badge — and now this one,
behind it — is itself concealed behind the `rail-actions-launcher` ☰ button,
which carries no badge. Recorded, deliberately not fixed here: a badge on a
generic "window actions" toggle would have to aggregate every badge-bearing
action inside it rather than just the archive, which is a design call and not
a slice of this one.

### What is NOT rolled up, at either level

- **The mention tier.** The modal's ROWS draw three pills (`@N` included,
  #267); the group header and the launcher draw two. This is inherited from
  #2096 rather than introduced here, and it is why the invariant above is
  stated per-tier: the group's message total equals the sum of the rows'
  message totals, and likewise for events.
- **The `show_event_badge` preference.** `WindowBadges` zeroes its events pill
  when the operator has opted out (#2037 B). No archive surface consults that
  preference — not the rows (#532 B), not the launcher (#2096), and not this
  header, which matches the rows it sits above. The divergence is between the
  archive surface and the navs, it predates this change on both of the
  archive's other two levels, and closing it would move #2096's number too.
<!-- entry #2112 -->

---

## 2026-09-13 — issue 2112: the reply-quote grey, and an open question that measurement took away from taste

peluche and Fairy asked on #grappa that the quoted head of a reply
(`.scrollback-reply-quote`, #2086) read as the grey the presence rows have —
the `* nick … has joined #chan` grey — instead of the `--muted` it shared with
timestamps. vjt: "proviamo".

### The stylesheet lies about this, and the lie is in the cascade

Three selectors declare `color: var(--muted)`: `.scrollback-reply-quote`,
`.scrollback-presence` and `.scrollback-time`. Reading that and concluding the
quote already wore the presence grey is wrong twice, and neither half lives in
a declaration:

- `.scrollback-line.scrollback-muted` damps the whole presence ROW with
  `opacity`.
- `.scrollback-body` declares `color: var(--fg)` on ITSELF. The presence body
  text is a DESCENDANT, so its own declaration beats the `--muted` inherited
  from `.scrollback-presence` — the join text is never `--muted` at all.

The wanted colour is therefore `--fg` damped by the row opacity: the
BRIGHTEST of the three greys on screen, not a dimmer one, and reachable from
tokens every theme already defines. Measured in Chromium through the e2e bench
— ink being the 5% of a region's pixels furthest in luminance from that
region's own dominant colour, the issue's methodology:

| region (`mirc-light`, dsf 1) | before | after |
|---|---|---|
| reply quote head | 130.62 — 3.81:1 | **69.71 — 9.48:1** |
| timestamp, same row | 128.31 — 3.93:1 | 128.31 — 3.93:1 |
| `has joined` text | 71.60 — 9.20:1 | 71.60 — 9.20:1 |
| quote → timestamp distance | 2.31 | 58.60 |
| quote → presence distance | 59.02 | **1.89** |

The defect is the first column read across: the quote sat 2.31 from the
timestamp and 59.02 from the text it was supposed to match.

On `irssi-dark` — the theme the issue itself measured, reached in the same spec
by writing the `data-theme` attribute `applyTheme` writes — the quote resolves
to `color(srgb 0.668627 …)`, i.e. **170.5/255, the issue's predicted value to
the digit**, and its timestamp inks at 110.63 against the issue's measured 112.

### The open question was not the one the issue posed

The issue left `opacity` on the fragment versus `color-mix(in srgb, …)` to
whoever took the work, on the grounds that the two "are not equivalent on
subpixel-antialiased text". Half of that premise is false and the false half is
the arithmetic:

- **On a uniform backdrop they are the same paint at EVERY coverage.**
  `opacity` composites `0.75a·fg + (1 − 0.75a)·bg`; a solid mix at coverage `a`
  gives `a·(0.75fg + 0.25bg) + (1 − a)·bg`, which is the same expression.
  Derived across `a` = .1 … .9 on both shipped themes: `|A − B| = 0.00` at every
  step; painted in a real Chromium they came out 1.17/255 apart, which is
  quantisation and not a mechanism.
- **The subpixel-AA half is UNFALSIFIABLE on our bench and stays an argument.**
  Headless Chromium renders grayscale antialiasing throughout — channel spread
  measured 0 on every region under both candidates — so the LCD-AA
  discontinuity the issue worried about cannot be produced here at all. It is
  recorded as the reason that was left standing, never as one that was proven.

So the pixels do not pick the winner. `color-mix` ships on grounds that are
structural: `opacity` makes the fragment its own compositing group (the AA
argument above), it dims everything the fragment carries rather than its colour
(a link's underline and its `:hover` accent included), and it cannot be beaten
by an inline `color` — which matters not today, since the class is withheld
from an explicitly-coloured run, but as the safe direction to fail if that
withholding ever regresses. What `opacity` would have bought and this gives up:
it composites over the ACTUAL backdrop, so on a `.scrollback-mention` row it
tracks the tint where this mixes against the `--bg` TOKEN — 8/255 apart on
irssi-dark, 15.75 on mirc-light, derived and not measured. Accepted: presence
rows are never mention rows, so the grey being matched was only ever defined
over the plain one.

`in srgb` and not the `in oklab` the `--adm-*` block uses, because the grey
being matched is produced by an `opacity` composite and the compositor works in
the device space.

### The contrast question answered itself in the other direction

#2086 demanded a measurement for anything dimmer than `--muted`, and the issue
predicted none was owed because the target is brighter. True — and the
measurement turned up what neither claimed: **the `--muted` spelling was itself
under the WCAG 4.5:1 text floor.** 3.81:1 measured in Chromium, 4.00:1 by
derivation on BOTH shipped themes. This is not a change that merely avoids
owing contrast homework; it repairs a floor failure. #2086's own comment
reasoned that `--muted` "is the SAME pair timestamps run against `--bg`, so the
contrast floor is one that was already accepted" — the pair was never accepted
on evidence, it was assumed.

⚠️ **Out of scope and deliberately untouched: the timestamps are still there.**
`.scrollback-time` inks at 3.93:1 on mirc-light and 3.92:1 on irssi-dark, under
the same floor, and every other `--muted` surface inherits the question.
Whether a timestamp is "incidental" text under WCAG is a call this issue has no
mandate to make, and making it here would move a token every theme depends on.
Recorded so the next reader finds a measurement rather than rediscovering it.

### Where it is pinned, and what each leg cannot see

- `src/__tests__/replyQuoteGrey.test.ts` — source-level over `default.css`: the
  colour derives from `--fg`/`--bg` with no literal and no new token, the mix
  percentage equals the presence row's `opacity` (the two numbers live in two
  rules and nothing else keeps them in step), and the premise is pinned too —
  `.scrollback-body` still forces `--fg`, without which the target moves. Reads
  no pixels: jsdom resolves neither `var()` nor `color-mix()`.
- `e2e/tests/issue2112-reply-quote-presence-grey.spec.ts` — a real engine, both
  themes, two legs. RESOLVED: the quote's computed colour equals a probe
  painted with `--fg` damped by the presence row's own opacity, so no literal
  75 appears in the spec and the RELATIONSHIP is what goes red. PAINTED: the
  quote must sit far closer to the presence ink than to its own row's timestamp
  ink (relative, so no tuned constant decides it) and clear 4.5:1 (the one
  threshold that is not ours to pick).
- Known softness in the painted leg, on `irssi-dark` only: the presence
  region's ink reads (168.71, 165.29, 157.17) rather than a neutral grey,
  because `.scrollback-body` contains the colour-coded nick and the brightest
  5% catches it. The relative assertion still separates by 6.5×, and the
  resolved leg is untouched by it.
<!-- entry #2114 -->

---

## 2026-09-13 — issue 2114: a JOIN the transport refused is kept, and the premise that named the wrong door

A cold deploy left one network in its old buffers with no traffic. The journal
on the issue shows ten JOINs at `15:19:28.7xx`, every one refused
`reason=:no_socket`, and the socket coming up at `15:19:33.402` — five seconds
later. Nothing put those ten channels back, and the client stayed desynced from
the ircd's idea of its membership until the user re-JOINed by hand.

### Two premises the code contradicts, and one it does not

The issue reads the ten lines as the bouncer's own rejoin racing its own
socket. They are not. `Session.Server` has two producers of a JOIN at
registration and they log DIFFERENT strings: `fire_autojoin/1` (as it then was)
says `autojoin skipped: transport unavailable`, and
`handle_call({:send_join, …})` — the REST door, reached only from
`ChannelsController.create/2` via `Session.send_join/4` — says `send_join call
rejected: transport unavailable`. Only the second string appears, ten times.
The dropped line in the preceding `disconnected` reason carries a +k key
(`JOIN #chan10 <key>`), and the autojoin loop frames every channel keyless, so
that half agrees. These were CLIENT-issued JOINs landing inside the reconnect
backoff window, not the bouncer re-joining itself.

It matters, because it decides where the cure goes: the autojoin loop already
self-heals (it re-reads `state.autojoin` at every 001), and a fix written there
would have left the door exactly as it was.

Second: "no error surfaced to the client" is not what the door did. It returned
`{:error, :not_connected}`, which `FallbackController` renders as a 400. What
was missing is a RETRY — and the 400 stopped being true four seconds later,
when the session registered without the channel.

What the issue gets exactly right is the window. It is not exotic: it is the
ladder itself. `handle_continue({:start_client, _})` reads `Backoff.wait_ms/2`
and DEFERS the Client spawn by that many ms, so a live, Registry-registered
session answers every REST verb for the whole delay with `client: nil` and
nothing to write on.

### Why a queue, and why it flushes at 001 rather than at `connected`

The issue offered three forms. "Don't attempt JOIN until connected" is what
already happened — the refusal IS the non-attempt; it changes nothing about the
loss. "Retry on `:no_socket`" wants a timer, a bound and a cancel, to decide a
question the backoff ladder exists to answer: duplicated state that has to be
kept in step with the thing it duplicates.

So: queue, in `queued_joins`, and flush at the seam the autojoin set already
rides. NOT at `event=connected` as the issue suggests — `:irc_connected` means
TCP/TLS is up and NICK/USER went out, and an ircd ignores a JOIN before
registration. 001 is where the loop already fires, and riding it inherits the
#347 +r defer for free: a queued JOIN to a `+R` channel would otherwise 477 for
exactly the reason the operator's set is made to wait.

`fire_autojoin/1` became `fire_join_plan/1` over `join_plan/1` — the operator
set plus the queue. One loop, because the only thing that differs is the +k
key: same in-flight tracking, same defer, same failure numerics. A queued entry
WINS a collision with the autojoin set, precisely because of that key; the
autojoin copy would frame the same channel keyless and earn a 475. The guard on
`maybe_autojoin_or_defer/1` moved from `state.autojoin` to the plan, because a
credential with an EMPTY autojoin set is the common one at the REST door and
gating on `autojoin` would have fired those queued JOINs straight past the
identify.

The queued channels do NOT go into `state.autojoin`, though the loop would then
have needed no change at all. `maybe_request_chanserv_invite/3` reads that field
as `in_autojoin?` to decide whether a 473/475 earns a ChanServ self-INVITE, and
that is a different question about a different set — the shared-data-model-with-
a-flag shape CLAUDE.md's design rule (6) names.

### `:no_socket` only, and what the reply now means

The transport-error arm split. `:no_socket` is the one error this process
outlives: it means there is no socket YET, which for a registered session is the
backoff wait. `:closed` and the `:inet.posix()` family mean the socket WAS there
and the write failed, so the Client is on its way down and this process with it
— an in-memory queue would die before flushing, and replying `:ok` there would
turn a silent drop into a success claim. That arm keeps its warning and its 400.

The `:no_socket` arm replies `:ok` (202) and opens the window `:pending` through
the same `record_in_flight_join/2` the accepted path uses. `:pending` is already
the server-owned state for "asked for, not joined", both paths reach it
honestly, and leaving the 400 in place beside a queued JOIN would have made the
door's answer and the session's state disagree.

### What it is not

The queue is in-memory and dies with the process, deliberately. That covers the
measured incident — the crash is BEFORE the ten refusals, so the refusals and
the recovery happen inside ONE process — and the general shape, since a
mid-session socket loss kills the Client and the Session with it rather than
parking at `:no_socket`. It is NOT a durable rejoin list: a user-subject manual
/join is still absent from `autojoin` and still will not survive a restart.
That gap is older than this issue and untouched by it.

### Not measured, and not asserted

- **Whether the ten channels were also in `state.autojoin`.** If they were, the
  registration at `15:19:33` would have rejoined them regardless and the report
  would be about something else. The journal in the issue is truncated after the
  `perform` line and shows no JOINs either way; prod is not reachable from the
  worker host, so this stayed unmeasured rather than being argued from the
  issue's prose.
- **Whether this is the `#1796` reconnect-bounce family.** The sightings file
  the brief names lives under the gitignored, machine-local `.orchestrate/` and
  is not present on this host. Nothing here claims a relation either way.
- **Why the `{:send, "JOIN #chan10 <key>"}` call timed out at 5 s** and killed
  the previous process. That is the line ABOVE the ten, a different defect — the
  Session.Server exits when its Client is slow to answer a send — and it is
  untouched here.
- **`apply_effects([{:rejoin_invited, channel} | …])`** discards
  `Client.send_join/3`'s result outright (`_ =`) and then records the window
  `:pending` regardless, so a ChanServ-relayed re-JOIN on a dead transport
  leaves a window that claims to be pending forever. Same class, different
  trigger; left alone to keep this change inside the issue's mandate, and
  reported out rather than folded in.

### Where it is pinned

`test/grappa/session/server_test.exs`, one describe, with both controls inside
the instrument rather than beside it:

- **Positive control, in `rewelcome_with_autojoin_control/3`**: `#control` is
  the operator autojoin set, so a SECOND `JOIN #control` proves the re-welcome
  really reached `maybe_autojoin_or_defer/1`. Without it a red in any of the
  three callers could equally have meant the 001 never landed — a broken
  instrument reported as a defect. It passed on the unfixed code, which is what
  makes the three reds attributable.
- **Negative control, its own test**: a JOIN the transport ACCEPTED must NOT be
  replayed at the next 001. Green before AND after, and it is what stops a queue
  that swallowed every JOIN from passing the other three.
- The class itself, and the +k key — the journal's dropped line carried one, and
  `fire_join_plan/1`'s autojoin half has none to lend.

`await_sent_line_count/4` moved out of the `away_state transitions (S3.2)`
describe to module scope on the way: `defp` is module-scoped wherever it is
written, so the old home only hid the sharing from the reader. It exists for
#417's same-process reconnect for the same reason issue 2114 needs it —
`IRCServer.wait_for_line/3` scans the whole buffer, so it cannot tell a second
JOIN from the first one still sitting there, and a re-registration test lives on
exactly that distinction.
<!-- entry #2116 -->

---

## 2026-09-13 — issue 2116: the missing table row, and the fourth site the shape did not name

IRCnet advertises `CHANMODES=beIR,k,l,imnpstaqrzZ`. `b`, `e` and `I` were
queryable there; `R`, the channel reop list, was not — the one list an IRCnet
user could not open. Not a gate failure: `ListModes.queryable/1` intersects the
advertised type-A set with `@pairs`, and `@pairs` had no `R` row, so the #1251
silent-degradation rule did exactly its job and never offered a letter whose
terminator nothing would recognise. The cure is the row, and the rule is
untouched.

### What the numeric pair buys, and why no letter-on-the-wire trick

344/345 is IRCnet's alone across the three ircds grappa talks to —
ircnet/ircd `ircd/s_err.c:379-380` spends it on the reop list
(`":%s 344 %s %s %s!%s@%s"` / `":%s 345 %s %s :End of Channel Reop List"`),
solanum's table jumps 341 to 346, bahamut's two slots are `NULL`. No collision,
so the NUMERIC identifies the letter, the same as 367/348/346 and unlike the
728/729 pair that bahamut spends on `z` and solanum on `q`. IRCnet's row is also
the shortest of the family, channel plus mask with no setter and no set
timestamp, which the shared clause already absorbed: setter/set_ts are read with
`Enum.at/2` and stay `nil`.

### The fourth site, and why it was the sharp one

The issue named three: the table row, the two `EventRouter` guards plus
`numeric_list_mode/1`, and a cic label. There is a fourth —
`NumericRouter`'s `@delegated_numerics` — and it is not an optional tidy-up.
Every other member of the family is in that set for the #376 reason: undelegated,
`param_derived_route/3` falls through to `scan_params/2` and `Session.Server`
persists each row as a bare `:notice` whose body is a scan-picked param. Here the
consequence is worse than the one #376 fixed, because the table row is what makes
the letter QUERYABLE in the first place: shipping items 1 to 3 alone would not
have left an old leak in place, it would have built a new one, and it would have
fired only on IRCnet and only when somebody opened the list the same change had
just made openable. The 344/345 rows go in with their `EventRouter` clauses in
the same commit, per the delegation contract already written above them.

### Measured: this is not a wire-shape change

The issue asserted it and the assertion is right, but `mix grappa.wire_pin
--check` is the judge, not the prose. Green on this tree at protocol 20 —
`list_modes_queryable` is `[String.t()]` and gains a VALUE, not a field, and the
pin digests the generated `wireTypes.ts` + `wireSchema.ts` + the JSON views'
`@spec` text, none of which can see which letters the runtime puts in an array.
A green from a gate that cannot move is worth nothing, so the gate was moved on
purpose: a throwaway `probe_2116_negative_control: [String.t()]` added to
`Wire.isupport_changed_payload` immediately below `list_modes_queryable` turned
the pin RED with a digest diff and the bump instructions, and reverting it
restored the pinned digest byte for byte. So the gate responds in this exact
neighbourhood, and `@protocol_version` stays at 20.

### The anti-drift pair had only one half

`event_router_test.exs` already asserted that every mode in `ListModes.pairs/0`
has a TERMINATOR clause. That test cannot see a letter whose end clause exists
and whose row clause does not — such a list flushes an empty bundle and every
entry the ircd streamed is dropped, quietly, on the one network that has the
mode. The row half is now its sibling, reading the same production table, with a
non-vacuity assertion inside it so an empty table cannot pass by asserting
nothing.

`numeric_router_test.exs`'s "whole type-A list family is delegated" test was six
hand-written rows; it is derived from `ListModes.pairs/0` now, which is the same
argument the #911 note in that file already makes against its third hand-kept
mirror. A letter added to the table without its two `@delegated_numerics`
entries now goes red there, naming the numeric. The exhaustive
`@delegated_numerics` mirror at the top of the file stays a literal list by
design and took 344/345 by hand.

### Not measured, and not asserted

- **No live IRCnet link.** The `CHANMODES=beIR` line is the issue's, from the
  reporter's own connection; prod is not reachable from the worker host. What is
  measured here is that grappa's table, router and delegation agree on `R` — not
  that an IRCnet server answered one.
- **The ircd sources are cited from the issue body, not re-fetched.** They are
  file-and-line citations to three named trees; nothing in this change turns on
  a line number holding.
- **`e` and `I` were reported missing on IRCnet and are not.** Both have been in
  `@pairs` since #1251 and IRCnet advertises them in the same group, so they were
  queryable there already. Only `R` was absent, and only `R` was added.
- **No `@channel_param1_numerics` entry.** 348/346 have none either and work:
  the accumulator key is folded by `list_mode_append_entry/4` itself and the
  bundle's `channel_display` comes from the priming call, so the numeric's own
  channel casing never reaches a key or a display. Leaving 344 out keeps it
  consistent with its two siblings rather than with 367.
<!-- entry #2119 -->

---

## 2026-09-13 — issue 2119: `tone` got its body back — the envelope grew a per-voice sustain

Lucy reported on `#grappa` that cic's `tone` preset "is too short" next to the
sound it played before the #1480 preset pack. The recipe was innocent: still a
sine, still 440 Hz, still 80 ms, still gain 0.1, and the comment above it in
`notificationSound.ts` said so. What changed was the thing the recipe does not
describe. Pre-#1480 `beep.ts` played that burst at a FLAT gain
(`gain.gain.value = BEEP_GAIN`) and cut; #1480 folded every preset under one
shared envelope — a 5 ms attack, then `exponentialRampToValueAtTime` to the
epsilon at the END of the voice. So the ramp started where the attack ended
and the note was ~20 dB down about a third of the way in. Same numbers on
paper, a click at the ear.

### The envelope is right; hard-coding decay-from-onset was not

The envelope earns its place — a bare gain step clicks at both ends, and
`chime` and the two sweeps genuinely want to ring out. The defect is narrower:
a preset whose entire contract is "what shipped before" was given a shape it
never asked for, and the table had no way to say otherwise. So the fix is a
knob on the DATA, `SoundVoice.sustainMs`: how long to hold the peak after the
attack before releasing into silence at `durationMs`. `tone` takes 65 (5 ms
attack + 65 ms at peak + a 10 ms release fills exactly the 80 ms the old burst
occupied, and fades over the last 10 instead of cutting); every other voice
takes 0, which IS decay-from-onset.

Three things about the shape, each a choice against an easier one.

- **Required, not optional.** The issue proposed `sustainMs?`. This file's own
  `toHz` field already rejects that reasoning in writing — "stated rather than
  optional so the player has one code path and no *did the author mean a
  glide?* branch" — and the same argument holds here. Five voices exist and
  they all live in one table, so the cost is five literals and the gain is
  that a new preset must DECIDE its shape rather than inherit one.
- **The release is derived, never declared.** There is no `RELEASE_S`
  constant and no `releaseMs` field: the release is whatever `durationMs` has
  left after the attack and the sustain. That keeps `durationMs` meaning the
  same thing for every voice whatever shape it asks for, and it is why a
  zero sustain reproduces the old envelope exactly instead of approximately.
- **No clamp.** `attack + sustainMs` overrunning `durationMs` would schedule
  the ramp before the hold, which a real `AudioContext` throws on and
  `playBeep` then swallows — a typo turning into silence. Clamping would hide
  it; TypeScript cannot express it; so `beep.test.ts` asserts a strictly
  positive release over EVERY synth preset in the table, which is the only
  place voices are born.

The alternative the issue listed second — lengthen `tone`'s `durationMs` until
the decay lands where the old cut did — was declined. It leaves the body
decaying, and it makes the table's duration column mean something different
for one row than for the others.

### The sustain event is guarded, and the guard is load-bearing

`playVoice` emits `setValueAtTime(peak, peakAt + sustain)` only when the
sustain is non-zero. Mathematically the event is a no-op at zero — it would
restate the peak at the instant the attack ramp already reached it — but
emitting it unconditionally would change the recorded automation of `chime`,
`blip` and `pop`, and "unchanged" is the claim being made about them. Measured
rather than argued: the gain automation of all three is identical event for
event before and after (dumped from both players against the same table), and
`tone`'s gains exactly one event, the hold at 0.070 s.

### What the test had to be able to see

A final-value assertion cannot tell these two envelopes apart — both end at
the epsilon. The oracle therefore records the GainNode automation with its
times and asserts WHEN the peak is abandoned: the ratio
`(hold − onset) / (release − onset)` is above 0.8, where it was 0.0625 before.
Mutated to confirm the gate moves: stripping the guard from `playVoice`, and
separately zeroing `tone`'s sustain in the table, each turn that one test red
and leave the other eighteen green; setting the sustain to the full 80 ms
instead reddens the release invariant. A test that stays green under its own
cure is watching nothing.
<!-- entry #1773b -->

---

## 2026-09-14 — issue 1773b: the credits roll was derived from one commit, and only a bot made it visible

Three dependabot PRs went red on `integration` shard 1 with a payload the
#1773 spec refuses:

```
GRAPPA_CREDITS is the DEGRADED payload
({"sha":"a017e63","date":"2026-09-14T04:24:02Z","contributors":[]})
```

Two of the three probes answered, so it was never "git is missing". The
question the red actually posed — and the reason it took a bot to ask it — is
below.

### What was measured

`a017e63` is exactly `refs/pull/2123/merge`, to the second on the date. CI
checks that ref out at `fetch-depth: 1`, which is `actions/checkout`'s own
default at the sha this repo pins (`action.yml`: *"Number of commits to fetch.
0 indicates all history"*, `default: 1`). Reproduced locally from a
`git init` + `fetch --depth=1` of that ref, byte for byte:

```
{"sha":"a017e63","date":"2026-09-14T04:24:02Z","contributors":[]}
```

The chain, each link measured rather than argued:

1. at depth 1 the clone is GRAFTED, so the merge commit reports **0 parents**
   — `--no-merges` therefore does NOT exclude it. The suspicion that it did
   was the obvious one and it is wrong; `--no-merges` is inert here;
2. `git shortlog -sn --no-merges HEAD` consequently yields exactly ONE row:
   the author of the single fetched commit. GitHub attributes a PR's
   auto-merge commit to the **PR author**;
3. for a dependabot PR that author is `dependabot[bot]`, which #1927's bot
   filter drops where the list is born — leaving `contributors: []`;
4. for a human PR the one row survives, and the suite is green.

### The defect the red was hiding

Step 4 is not the system working. On `main`, at depth 1, the same code bakes
`[{"name":"Marcello Barnaba","nick":"vjt","commits":1}]` — against a history
where that author has **5667** commits and nine people appear. Every green
`integration` run this suite has ever had painted a credit roll that was
factually wrong, and nothing could see it, because **a wrong roll and a right
one have the same shape**. The spec only refuses the EMPTY list, so the one
case it caught was the one where a bot filter happened to empty it.

So the dependabot red is not the bug. It is the only configuration in which
the bug became a shape.

### Two fixes, because there are two defects

**`credits.sh` withholds the contributor list on a shallow repo.** A
truncated history is not a smaller answer, it is a false one, and this is the
only probe in the script that can be confidently wrong rather than empty —
which is why it is the only one that gets a gate. `sha` and `date` stay:
a shallow repo knows them exactly, and nulling them would claim the build has
no history at all, which is the AUR/tarball case and a different fact. An
older git without `--is-shallow-repository` (2.15+) leaves the probe empty,
which reads as not-shallow and preserves the previous behaviour exactly — the
gate can be absent, never inverted. Measured: on a full clone the output is
**byte-identical** before and after (same sha256), so no release path, no
operator deploy and no local stack can tell the difference.

**`integration.yml` checks out whole history**, `fetch-depth: 0` plus
`filter: blob:none`. Without the filter, `fetch-depth: 0` drags 491M of
historical blobs onto four shard runners every run; the partial clone reaches
the same 6293 commits — all `shortlog` reads — in 25M with the tree checked
out, against 15M for today's single-commit fetch. The filter is a cost choice
and is deliberately NOT pinned by the test: a build should not fail for being
slow.

The two must land together. Alone, the first turns a silent lie into a red
suite on every run; alone, the second fixes today's checkout and leaves the
class open for the next wrapper.

### What the spec did NOT need

Nothing. `bakedCredits()` already refuses an empty list and its comment already
says why accepting a degraded payload would make the file vacuous. Once
credits.sh stops laundering a truncated history into a confident list, that
untouched guard IS the gate that catches a shallow wrapper. No assertion was
added to it and none was weakened.

### The gate that read its own comment

The first version of `integration_checkout_depth_test.bats` matched
`fetch-depth: 0` as a substring of the raw step. Deleting the key from the
YAML left it **green** — the step explains itself in prose that spells the
same string, so the check was reading the justification and reporting on the
configuration. It now strips comment lines first and anchors on a key line.
Recorded because the failure mode is general: a config assertion whose
subject also documents itself will pass on the documentation, and only
deleting the thing it guards reveals it.

Five mutations, each confirming the corresponding gate moves: key removed
(prose left in place) → red; `fetch-depth: 10` → red; checkout step renamed →
red via the positive control; the shallow branch removed from `credits.sh` →
red; the predicate forced always-true → red via `refute`. That last one was
itself a repair: the negative control was first written `! declares_full_history`,
which cannot fail a bats body, and the repo's own
`bats_assertion_style_test.bats` is what caught it.
<!-- entry #2127 -->

---

## 2026-09-14 — #2127: the DCC delivery link, and a gate that could not be satisfied

A live transfer on prod (1.5.7) left this row in the scrollback:

```
08:37:59 <EliteWarez> 📥 "Deadpool.e.Wolverine.2024...mp4" — /networks/1/dcc_files/m4n3ktwbdbnz5cco2bp6ncefay
```

Three defects were filed: the URL is relative so nothing linkifies it, it
carries no extension so `mediaLink.ts` cannot classify it, and the row lands
in `$server` instead of the query with the peer. The first two were framed
as URL shaping. They were not.

### The measurement that rewrote the issue

`GET /networks/:network_id/dcc_files/:slug` sat behind `:authn` +
`ResolveNetwork`. Four facts, each read off the tree:

* `GrappaWeb.Plugs.Authn.get_token/1` accepts exactly one thing — an
  `authorization: Bearer <uuid>` header. No cookie arm, no query parameter.
* cicchetto keeps that bearer in `localStorage` (`auth.ts`); `document.cookie`
  appears **zero** times in all of `cicchetto/src/`.
* a scrollback link renders as `<a href target="_blank" rel="noopener
  noreferrer">` (`MircText.tsx`).
* therefore a tap opens a tab carrying no `Authorization` header, and the
  route answers 401.

So the link could not be used by the one person it was minted for, and **no
shape of URL buys its way out of a gate the browser cannot satisfy**. Making
it absolute would have made it *linkify* — a tappable link to a 401. The
extension would have been worse: `mediaLink.ts` rule 3 classifies a
same-origin media extension, so cic would have opened a viewer modal that
could never fill.

vjt's ruling (2026-09-14) took a fourth road and rewrote the issue body: serve
the file the way an upload is served. `GET /dcc_files/:slug[.ext]`, top level,
`pipe_through [:api]`, no `:authn`, no `:resolve_network` — which also drops
`/networks/:network_id` from the path.

### Why the slug is enough here, and it is not a relaxation

The retired comment read *"a stranger's bytes are not something the operator's
user chose to publish"*. That describes the OFFER. By the time bytes are on
disk, `Grappa.Dcc.Policy` has passed and the operator has explicitly accepted
THIS file from THAT nick — the choice the old comment said was missing. The
26-char base32 slug carries the same 128 bits `/uploads/:slug` has stood on
since UX-6-B1, and the consent behind it is stronger.

The trade is explicit and is the point rather than a side effect: whoever
holds the URL reads the file with no login, until `Grappa.Dcc.Reaper` expires
it. That makes the reaper the **only** revocation, which is why
`@max_retention_seconds` being a ruling matters more now than when it was
written, and why the three response headers moved from defence-in-depth to
*the* defence and stay unconditional.

Comments asserting the retired rule were rewritten in the same commit —
router, controller moduledoc, `Dcc.get_by_slug`, `Dcc.delete`, `Dcc.Reaper` —
on vjt's instruction and for his stated reason: *a comment left there is how
the next reader puts `:authn` back*. `Dcc.delete/1`'s "no soft-delete" needed
a new justification as well as a correction: the old one was "this spool is
private", which is now false. The true one is that `Grappa.Uploads`' tombstone
distinguishes an admin delete from expiry, and this spool has no admin-delete
door — the only thing that removes a row is the reaper retiring one that is
already unreadable.

### The extension is a structural whitelist, not a type vocabulary

It can only come from the peer's declared filename: `DCC SEND` carries name,
address, port and size, no MIME, and the schema has no `mime` column. That is
attacker-controlled text interpolated into a URL published into somebody's
scrollback.

`[A-Za-z0-9]{1,8}`, and the character class is doing structural work rather
than naming known types. `/`, `?`, `#`, `%`, `:`, whitespace and every control
byte fall outside it, so no filename can graft a path segment, a query or a
fragment onto the URL — `clip.http://evil.tld` mints `<slug>.tld`, scheme
destroyed. A closed list of known extensions was rejected deliberately: DCC
carries `.zip`, `.iso`, `.mkv`, `.torrent`, so a vocabulary would drop the
extension off most real traffic while buying nothing, because what makes a
lying `.svg` harmless is the three headers, not the set.

Two ordering details that are load-bearing and easy to get backwards.
Validate THEN `downcase(:ascii)`, never the reverse — `String.downcase/1` is
Unicode and folds `İ` into two code points, so folding first would smuggle a
combining mark past a check that already ran. And the source is the RAW
filename, never `Report.display_filename/1`: that one truncates at 120 bytes
and appends `…`, which would eat the extension off a long name and could make
the last dot-segment something the peer never wrote.

`Report`'s "the emoji is a TYPE SIGNAL" section was reconciled rather than
left contradicting this. 2089's rule was *never an INLINE render*, and that
holds: `mediaLink.ts` rule 2 (the emoji map) fires only on the legacy
extensionless `/uploads/<slug>` shape, which a `/dcc_files/…` URL cannot
reach, while rule 3 changes only what a CLICK does.

### Routing follows CONSENT, not kind

`Grappa.Dcc.Report` already splits on attribution — `:delivered` is `:privmsg`
as the peer, everything else is `:server_event` as the anonymous sentinel. The
channel is a SECOND axis and does not follow that one. It follows the accept:

* post-accept (`:delivered`, `:failed`, and the `{:fs, :rejected}` storage
  failure) → the query with the peer, opened if needed;
* pre-accept (`:refused`, `:expired`) → wherever the OFFER rendered, `$server`
  for a stranger. Routing those to a query would mint a window for anyone who
  sent one malformed `DCC` line, which is the capability #546 denies.

Rather than thread a second channel through, the transfer path stops carrying
one: `start_dcc_transfer/2` and the `{:dcc_transfer_done, …}` tuple lost the
element. A field nothing reads is a field the next reader files a row into,
and post-accept there is genuinely nothing to inherit. The window opens as a
consequence — the `{:persist, …}` arm already runs `maybe_open_query_window/2`,
and a nick-shaped `channel` with no `dm_with` is the orphan shape
`numeric_router` has always used.

⚠️ A message in flight across a hot deploy carries the old 6-tuple and matches
no clause. It is absorbed by the `handle_info/2` catch-all (#1338,
unknown-is-never-fatal) with a warning: the cost is one missing report row,
logged, never a dropped session.

### The version bump is decided by precedent, and the pin cannot see it

No wire file was touched — `git diff --name-only` against `origin/main` lists
no `*wire.ex`, no `*_json.ex`, no `protocol.ex` in the product change. But a
documented client-facing route was MOVED, and `Grappa.Protocol`'s own log
already settles that class: **v10** and **v11** are REST routes the pin could
not see, where *"the number moves on the RULE, not on the tooling"*. This case
is stronger than either — those were additive, this takes a path away, so the
break runs in both directions. Hence v21.

`min_protocol_version` stays at 1: no client has ever CONSTRUCTED this URL, the
server mints it into the body and cic only linkifies what it is handed, so no
old bundle asks for the old path.

🔴 **The pin was moved twice, and the two results differ — which is the point
of moving it.** Adding a bogus key to a map literal in
`Grappa.Session.Wire.dcc_offer/6`'s BODY left `mix grappa.wire_pin --check` at
rc=0 `agree.`; adding a field to the named `@type channels_changed_payload`
took it to rc=1 with a moved digest. The first is a blind spot the task's own
moduledoc already declares (*"a view whose BODY grows a key while its `@spec`
stands still is still invisible here"*), not a new defect. The second is what
makes the green meaningful: the gate is alive for the class that could have
caught this change, and the change makes no such move.

### Two things NOT claimed

Delivery rows already in production scrollback carry the old relative path and
now point at a route that does not exist. Nothing usable is lost — those
strings never linkified and 401'd when pasted, so they go from one kind of
dead to another — and no migration rewrites them. **The row count is not
measured**: the prod jail is not reachable from this host.

And whether cic's media viewer now actually OPENS a `/dcc_files/<slug>.mp4` is
a separate question from whether the 401 is gone. The three response headers
are unconditional by ruling, so the served bytes are `application/octet-stream`
under `nosniff`; whether a browser will paint an `<img>`/`<video>` pointed at
that is a real-browser measurement, not a spec reading.
<!-- entry #2129 -->

---

## 2026-09-14 — issue 2129: a second leg for deb and rpm, and the audit that could not see which one died

`deb` and `rpm` now build on two runners — `ubuntu-latest` and
`ubuntu-24.04-arm` — the same two-leg matrix `smoke` took in #2018. The build
side needed nothing: `build.sh` already derives `GRAPPA_PKG_ARCH` from `dpkg
--print-architecture` with an `aarch64|arm64` arm of the uname fallback,
already maps `arm64` to the right pinned-nfpm download, and both `nfpm.yaml`
files template that one value. The missing piece was a runner, and it was free.

### The part that was not optional, and the reason it rode in the same commit

`release_assets.sh`'s expected-kind table matched `grappa_*.deb` and
`grappa-*.rpm`. Those globs are ARCH-BLIND, so the moment a second leg exists
the arm64 file satisfies them on its own — and #1591's refuse-to-create gate,
which is the only thing standing between a red leg and an irreversible
publication, reads that as a complete set.

Measured on a seeded asset tree rather than argued, with the pre-change script
taken from `git show`, not hand-edited:

| patterns | asset set | verdict |
|---|---|---|
| old (arch-blind) | arm64 present, amd64 **missing** | **COMPLETE** |
| new (arch-aware) | arm64 present, amd64 **missing** | **PARTIAL** — `publishable` exits 1, naming 4 kinds |
| new (arch-aware) | amd64 restored | COMPLETE |

The first row is the bug: a run whose amd64 leg died would have CREATED a
public release carrying no x86 package, on the architecture essentially every
operator is on, and deleting the tag afterwards does not retract it. A loud
red becomes a silent partial release. That is #1447's absorption trap one axis
over, and the file's own header already documented the grappa-vs-shottino
version of it.

**Four patterns split, not two.** The issue names only the two `grappa*` ones.
Curing those and leaving `shottino_*.deb` / `shottino-*.rpm` alone would have
left the client package with the identical hole — the same package whose own
absorption trap is why the table became name-scoped in the first place. Ten
kinds became fourteen; the six Arch kinds are untouched.

### The arch spellings are measured, not assumed

nfpm translates the single `arch:` value per format, so the same machine has
two names. Run against the pinned nfpm **2.43.0** itself (`GitVersion: 2.43.0`),
with the amd64 half as a positive control — it reproduces byte-for-byte the
four filenames this repo's fixtures have carried since #1447:

```
arch: amd64  ->  grappa_0.8.0_amd64.deb     grappa-0.8.0-1.x86_64.rpm
arch: arm64  ->  grappa_0.8.0_arm64.deb     grappa-0.8.0-1.aarch64.rpm
```

So the rpm leg's artifacts land as `aarch64`, never `arm64`. A pattern written
on the wrong guess would never match, and the audit would report that kind
missing on every release forever — the inverse failure of the one being cured,
and just as quiet from the workflow's side.

That is also why **the rpm job's matrix value is spelled `x86_64`/`aarch64`
while the deb job's is `amd64`/`arm64`**. Each job names architectures in the
vocabulary its own artifacts use, which keeps the check-run name, the artifact
name and the file name telling one story. It has a second effect worth stating:
both existing check-runs keep their EXACT names — `build + prove .deb (amd64)`
and `build + prove .rpm (x86_64)` — because `name:` is spelled with the matrix
value rather than left to the default suffix, the same care #2018 took for
`smoke`. The new ones are `build + prove .deb (arm64)` and `build + prove .rpm
(aarch64)`. Branch protection is not configured on this repository today
(`/branches/main/protection` answers 404), so nothing is broken by this; the
names are pinned deliberately so that whoever wires it later inherits a stable
set rather than a renamed one.

### Two non-goals, stated so nobody completes them later

**`arch` stays single-leg.** Arch Linux has no official ARM port, `makepkg`
runs in a real x86_64 Arch container, and the pacman repository stays x86_64.
A test now asserts that the Arch kinds carry no arch axis: adding an
`*-aarch64.pkg.tar.zst` kind would mark every release partial forever.

**Both legs run on a `deb_validation` dispatch**, unlike `smoke`, which keeps
one leg on its dry-run. Smoke's asymmetry buys away a second buildx gha cache;
there is no cache here and both legs are the same native build, so a validation
dispatch proving half of what a tag will run is exactly the shape #1714 exists
to prevent.

`fail-fast: false` on both matrices is load-bearing for a reason beyond
#2018's: a cancelled leg uploads nothing, and the audit downstream cannot
distinguish "arm64 broke" from "arm64 never ran".

### What could not be measured here

No release tag was cut, so **nothing in this change demonstrates that a real
run produces arm64 assets** — only that the audit tells the truth about
whichever set arrives, and that every prerequisite the arm64 leg depends on
exists. Those prerequisites were checked off-CI rather than assumed:
`nfpm_2.43.0_Linux_arm64.tar.gz` is a published asset of the pinned release
(build.sh's URL shape resolves), `OTP-28.5` — the `.tool-versions` pin — has a
prebuilt `arm64/ubuntu-24.04` tarball on builds.hex.pm, bun ships
`bun-linux-aarch64.zip`, and `fedora:43` publishes an `arm64` image for the rpm
job's container. Still unmeasured from here: that Fedora's `elixir`/`erlang`
packages install on aarch64, and the runner-side behaviour of
`dpkg --print-architecture` on `ubuntu-24.04-arm`. The first tag to run this is
the first real evidence, and the audit is now honest about a half set if it
comes back with one.
<!-- entry #2132 -->

---

## 2026-09-14 — issue 2132: the projection that admitted every map, and the half a type cannot see

`EventRouter` ran on a hand-written `@type state` naming five keys and
closing with `optional(any()) => any()`. That type is inhabited by every
map, so Dialyzer had nothing to disagree with, and #1390's drift pin — which
guards `Session.Server`'s own two declarations against each other — said so
in its moduledoc: the projection was the other face and nothing asserted
anything about it.

Two tools were needed, not one, and finding that out cost one demolished
proposal.

### The review's number was a grep over its own prose

The architecture review (A1, parent #2118) reported **24** fields read as
`state.<field>`, and proposed AST-walking exactly that form. An AST walk
says **6**. Every missing name is in a COMMENT — this module documents its
own state access in prose (`# comes from \`state.isupport\` (005-derived)…`,
`# gated on \`state.admin_pending\``), so a grep counts the documentation.
The review declared its own caveat, that it ran with no toolchain and every
number was a grep; that caveat turned out to be the reason the proposed fix
looked adequate rather than a footnote to it. Three other numbers moved too:
5 declared keys not 4 (`optional(:ignores)` is declared, and the review
lists `ignores` among the reads), the type is `@type state` not `@type t`,
and `Session.Server.@type t` is 82 keys, not 71. The review's own
enumeration — 19 names "plus the four declared" — sums to 23, contradicting
its own 24.

### Loud and silent are different bugs, and the proposal covered the loud one

Measured, on a map missing the key:

| form | result |
|---|---|
| `state.absent` | `KeyError` — LOUD |
| `%{state \| absent: 1}` | `KeyError` — LOUD |
| `%{absent: x} = state` | `FunctionClauseError` — LOUD |
| `Map.get(state, :absent)` | `nil` — SILENT |
| `Map.get(state, :absent, [])` | `[]` — SILENT, and a plausible default |

The real surface is **38 keys across six forms**, and it is dominated by the
silent one: `Map.get` is 31 distinct keys over 97 call sites, `Map.put` 8
over 14. `state.<field>` is 6. So the proposed walk would have pinned 16% of
the surface, and specifically the part that already crashes on its own.

### What shipped: the type takes the loud half, a test takes the silent one

`@type state :: Session.Server.t()` — the projection is deleted, not
enlarged. There is now one declaration of this state in the codebase, which
is the only version that cannot drift.

The three-point measurement that chose it, renaming `whois_pending` in the
host's `@type t` alone:

| tree | Dialyzer | where |
|---|---|---|
| baseline, unmutated | **0** | — |
| baseline + rename | **2** | `server.ex` only — the router is BLIND |
| unified type + rename | **6** | + **3 in `event_router.ex`**, its three `%{state \| whois_pending: …}` sites |

Three map-update sites, three errors: exact. And the same tree leaves the
router's **seven** `Map.get(state, :whois_pending, …)` sites at **zero**
errors — no type system sees through `Map.get`. That is the half
`StateContractDriftTest` now pins, and it is scoped to exactly that half:
re-asserting what Dialyzer already proves would be a second copy of a fact,
and a second copy drifts.

SUBSET, not equality: 44 of the host's 82 keys are never reached by the
router. A key the router reaches and the host does not declare is a bug; the
converse is none of the router's business.

The two claims are asserted separately because they are different bugs. An
undeclared **read** goes `nil` forever; an undeclared `Map.put` **injects** a
field behind the host's contract — invisible to #1390's pin too, since such
a key is neither declared by `@type t` nor built by the init path. One
mutation each, and each kills exactly one assertion.

### Three things worth keeping

The unified type's only cost was one `@spec userinfo_text(map())` that had
always been a supertype of what the function accepts; Dialyzer could only
say so once `state.profile` had a real type. The warning was the mechanism
working, not a price.

The cardinality floor's first act was to fail on **my own** arithmetic: I set
it to 33, the size of the whole `Map.*` surface, when the reads alone are 31.
An instrument that cannot fail is not an instrument, and this one failed
before it ever guarded anything.

The negative control on `:entries` is kept although the defect it names is
gone. The first census of this surface was a grep and it invented that key
out of a nested `%{accum | entries: …}` inside `%{state | links_pending: …}`.
A base-anchored AST walk cannot see it; the control asserts that property
rather than trusting it, so a rewrite that loses the anchoring fails loudly
instead of quietly inflating the set.

### Known limit, stated rather than discovered

The router walk is anchored on a variable literally named `state`. A
function head destructuring the state map without binding it — `defp
f(%{isupport: x})` — is invisible to it. Every destructuring site binds
`state` today, so the exposure is real and empty; the floor catches the walk
going blind wholesale, not one site drifting out of reach.
<!-- entry #2128 -->

---

## 2026-09-14 — issue 2128: the banner slot lost its buttons to one long word, and the cure it already had was applied to one element

A phone (Android PWA, ~393 CSS px) showed a DCC offer banner whose **Accept**
button was cut in half by the right edge and whose `×` was off screen
entirely. The banner was un-actionable: neither answer could be tapped.

### The cause is one line of CSS that was never written

`.error-banner` is a single-line flex row and `.error-banner-message` carried
`flex: 1 1 auto` with no `min-width`. A flex item's default `min-width` is
`auto`, i.e. its **min-content** width, so the message refuses to shrink below
its longest break-free run. The DCC offer embeds the peer's declared filename,
whose unbroken run is wider than the phone, so the message claimed the whole
row and the two `flex: 0 0 auto` controls after it were laid out past the
right edge — of a container that is `position: fixed; left: 0; right: 0` with
no overflow affordance. They were not scrollable to. They were gone.

### The defect belongs to the SLOT, and the class had already been cured once

Nothing about this is DCC-shaped. Any banner whose message carries a long
unbreakable token — a URL, a channel name, a hostname — loses its controls the
same way; the DCC offer is merely the longest message the app ships, because a
stranger supplies part of it.

The same root cause already has a cure in this very stylesheet.
`.compose-box-upload-filename` took `min-width: 0` on 2026-06-10 with a
comment that states the general rule in full: *"flex items default to
min-width:auto, so a long filename refuses to shrink and shoves the progress
bar + cancel/retry buttons off-screen on narrow viewports"*. That fix was
right and it was scoped to the one element that had been observed failing. The
class stayed open for fifteen months of new flex rows, and the banner slot —
shared by nine sources — is where it resurfaced. Recorded because the lesson
is not "add min-width: 0 more often": it is that a cure written against an
instance leaves the class, and the shared slot is the altitude the rule
belonged at.

### Three declarations, and each answers a different half

```css
.error-banner          { flex-wrap: wrap; }
.error-banner-message  { min-width: 0; overflow-wrap: anywhere; }
```

`min-width: 0` lets the item yield. `overflow-wrap: anywhere` gives it
somewhere to yield TO, and it is chosen over `word-break: break-word`
deliberately: `anywhere` also shrinks the **min-content size itself**, so the
run breaks inside the row instead of overflowing a box that has now been told
it may be narrow. With both in place the row does not normally wrap at all —
the message simply takes fewer columns and more lines.

`flex-wrap: wrap` is therefore the affordance of LAST resort, for when the
controls ALONE no longer fit a line (a longer action label, a user text-zoom,
a viewport narrower than any phone ships). It is kept because the failure it
prevents is the unreachable one: there is no overflow to scroll.

`margin-left: auto` on `.error-banner-action` was already there and needed no
change — auto margins resolve **per flex line**, so the wrapped case stays
right-aligned and in the same order for free. It stays on the action ALONE:
auto margins SPLIT a line's free space between them, so a second one on the ×
would park the action mid-line.

### What was NOT done: the tap target

The obvious way to buy horizontal room is to shrink the 44px `×`. That is the
wrong cure and the issue says so up front — #459 set that box at the HIG/
Material minimum on purpose, in the screen corner where thumbs are least
accurate, and it is absolute px rather than rem precisely because the app's
root font-size is 14px. The e2e below asserts `>= 44` in both dimensions, so
the wrong cure is red on an assertion the right cure never touches.

### The harness question, measured rather than asserted

The issue asked whether a slot-level test could observe this, and answered
"jsdom does not lay out flexbox". That is true and it undersells the problem.
Measured on this branch with a throwaway probe that rendered `BannerSlot` with
a 120-character filename and injected the real `themes/default.css` as a
`<style>`:

* every `getBoundingClientRect()` came back `left=0 right=0 width=0 height=0`
  — slot, action and `×` alike — and `offsetWidth` was `0`;
* `document.styleSheets.length` was `1` but `cssRules.length` was **`0`**, so
  `getComputedStyle(slot).display` read `block` and the `×`'s `width` read
  `auto`.

The second half is the one worth writing down: not one declaration of the
theme reaches an element under vitest, so the WEAKER oracle — "assert the
cascade was asked for the right thing" — is unavailable at slot level too, not
merely the geometric one. A vitest test here could only have pinned the
declarations as SOURCE TEXT (the `themeCss` / `ruleBody` idiom
`safeAreaInsetToken.test.ts` uses), whose single failure mode is reverting
this diff. That was declined: it reads as coverage while observing nothing
about layout.

### The e2e, and what it cannot say

`e2e/tests/issue2128-banner-controls-narrow-viewport.spec.ts` drives a real
DCC offer through the ircd (the issue2089 fixture, TEST-NET-3 address so the
SSRF gate admits it) with a 224-byte unbreakable filename, then measures the
live geometry at 393 CSS px (the reported device) and 320 CSS px (the issue's
contract). The oracle is the slot's own box as the outer reference, plus the
viewport width, plus `getComputedStyle(slot).paddingRight` read rather than
assumed so the right-alignment assertion carries no magic constant.

The filename is deliberately longer than the wire will carry:
`Grappa.Dcc.Report.display_filename/1` truncates at `@filename_max_bytes`
(120) and appends `…`, so the DOM gets the widest string the wire can produce
— 120 bytes of peer text plus the ellipsis, 121 characters. The spec locates
the banner by that 120-character head, so a cap that shrank would fail to
collect the banner rather than quietly weaken the case.

🔴 One engine. The default project is chromium — the reporter's engine family,
not WebKit and not a real Android device. The defect is plain CSS flexbox with
no engine-specific feature in it, which is why one engine is judged sufficient
here. That is a judgement, not a measurement, and it is written down as one.
<!-- entry #227 -->

---

## 2026-09-14 — issue 227: an identd that answers only the peer, and takes the same time to refuse everybody else

grappa now answers RFC 1413 ident lookups for its own outbound IRC
connections. An ircd that gets no answer on `113/tcp` falls back to a
`~`-prefixed unverified username, and some configs gate features on a
verified one — oper O:lines that require `identd` active are the case that
filed the issue. Three new modules (`Grappa.Identd` + `.Bindings`,
`.Listener`, `.Protocol`), one new field of knowledge in `IRC.Client`, and
a supervision group that is empty unless an operator turns it on.

This is the first INBOUND socket the bouncer has ever owned:
`:gen_tcp.listen/2` had zero occurrences under `lib/` before it, because
everything else grappa speaks it dials out to.

### The race, and why the fix is a wait rather than a pre-bound port

The ircd starts its ident lookup when it ACCEPTS — the same instant
`:gen_tcp.connect/4` returns on our side — so the query can arrive before
we have written down which tuple it belongs to. A cold `NO-USER` is not a
missed optimisation; it is exactly the failure that leaves the `~` in
place, which is the whole of what the slice was for.

Two shapes could close it. Bind an explicit local `port:` BEFORE
connecting, so the mapping is known up front; or register after the
connect from `:inet.sockname/1` and let the identd wait briefly on a miss.
We took the second, on three grounds that are properties of THIS codebase
rather than preferences:

  * **The source address is not knowable before the connect on the common
    path.** `resolve_and_ifaddr/1` returns `{[], :inet}` when there is no
    v6 pool — no `ifaddr`, kernel-default selection. Pre-binding a port
    would pin only half the key; pinning the other half means binding an
    explicit source address on every upstream connect, which changes
    production egress to satisfy a subsystem that is off by default.
  * **The peer address is not fixed before the connect either.** #271
    rotates over the resolved leaf set, so a tuple registered ahead of the
    dial can name a leaf that then fails — a lie in the table rather than
    a gap in it.
  * **Claiming an ephemeral port races the kernel's allocator.** That
    means `EADDRINUSE` retries and `reuseaddr` on every session's outbound
    socket: real blast radius bought for an optional feature.

`:inet.sockname/1` after the connect is exact, is all four elements at
once, and costs a bounded wait that is only ever paid on a miss. The
budget is 2s — three orders above the real race (the scheduling gap
between `connect/4` returning and the cast landing) and comfortably under
the ident timeouts ircds use (solanum's `ident_timeout` defaults to 5s).

### The querier is IN the key, so answering the wrong host is unrepresentable

The obvious shape is: look the port pair up, then compare the entry's
`peer_ip` against whoever is asking. We did not write that. The lookup key
is `{source_ip, local_port, peer_ip, peer_port}` and the `peer_ip` slot is
filled from the QUERIER's own address, so a query from anybody but the far
end of the connection it asks about simply misses.

The difference is not stylistic. A comparison is a branch, and a branch is
a thing a later reader can simplify away or an early `return` can skip;
the key's shape is not. It also collapses the two failure modes the
anti-enumeration property depends on — wrong querier and unknown tuple —
into literally one code path, so they cannot drift apart.

The source ADDRESS is in the key for a separate reason: grappa's sources
are plural and per-network (`client.ex` binds a fixed `ifaddr` or rolls a
v6-pool entry), so two sessions can legitimately hold the same ephemeral
port on two different addresses. The price is a deployment constraint,
documented: a 113→N redirect must PRESERVE the destination address, which
the plain `rdr … -> port N` / `redirect to :N` forms do.

### Uniform in bytes AND in wall clock

Every refusal is `<p1> , <p2> : ERROR : NO-USER`, byte for byte, whatever
caused it. `Bindings.lookup/2` already parks a miss for the wait budget
and `Listener.refuse/4` tops up anything faster to the same figure, so a
tuple that exists but belongs to somebody else, a tuple that does not
exist, and a query too malformed to name one all take the same time too.

That second half is not decoration. Identical bytes with a fast path for
"this tuple exists" re-opens by the clock precisely the enumeration the
identical bytes closed: an attacker learns which port pairs are live by
timing, and a live pair is a session to keep probing. The one fast path
left is the genuine hit for the genuine peer.

`listener_test.exs` pins it with three probes on a FIXED port pair —
nothing registered, the tuple registered to an off-path peer, then the
same tuple registered to the host actually asking. Holding the pair still
is what lets the two refusals be compared byte for byte instead of by
shape, and the third probe is the positive control: without it,
byte-equality is also satisfied by a listener that answers nobody. The
plausible weakening it is built to catch — dropping the querier from the
key — turns the first assertion red by leaking the ident to the wrong
host.

### One error type, deliberately not the RFC's four

RFC 1413 offers `INVALID-PORT`, `NO-USER`, `HIDDEN-USER` and
`UNKNOWN-ERROR`. We emit only `NO-USER`, per the issue's ruling. A reply
that varies with WHY is the oracle; the distinction buys an operator
nothing the logs do not. A query too malformed to yield ports is answered
`0 , 0 : ERROR : NO-USER` — `0` is not a legal port, so the line can never
be read as an answer about a real connection.

The ports in a reply are re-rendered from the PARSED INTEGERS and never
echoed as bytes. The reply is a single CRLF-framed line, which is what
makes an unvalidated byte an injection rather than a cosmetic defect.

### `safe_userid?/1` is NOT `valid_ident?/1`, on purpose

The obvious reuse is to gate the binding on
`Grappa.IRC.Identifier.valid_ident?/1`, the predicate the USER line's
ident already passed. It is the wrong predicate here, and using it would
have been a silent feature hole: an ident that was never set falls back to
the NICK (`Identity.effective_ident/2`), and a nick may carry RFC-2812
punctuation — `foo[1]`, `a|b` — that `valid_ident?/1` refuses. Those
sessions would have been registered nowhere and kept their `~` with
nothing but a log line to say so.

The identd's job is to name the value already on the wire, whatever shape
it has. The only thing it may refuse is a value that would corrupt its own
framing: CR, LF, NUL, the field-delimiting colon, the empty string, and
the format's 512-octet ceiling. That rule lives in the module whose wire
it protects, and it is checked at the moment a binding is WRITTEN, so an
unsafe value never reaches a table the reply path can read from.

### Off by default, and the release grants itself nothing

The ruling, in code. `identd_children/0` returns `[]` unless
`GRAPPA_IDENTD_ENABLED` is set, so the supervision tree is byte-identical
to a build without the feature. The port is `GRAPPA_IDENTD_PORT` and its
default is high and unprivileged; nothing hardcodes 113 or assumes it can
bind it. Bridging 113 to that port is a packet-filter redirect or a Linux
`CAP_NET_BIND_SERVICE` grant, and `infra/packaging/grappa.service` keeps
`User=grappa` + `NoNewPrivileges=true` with no `AmbientCapabilities`.

`GRAPPA_IDENTD_BIND` (default `::`, dual-stack via `ipv6_v6only: false`)
is a third knob rather than a constant because a host that cannot do
dual-stack needs `0.0.0.0` and an operator whose redirect lands on
loopback wants to say so. A bind that fails stops the listener with the
real posix reason — an opt-in feature that cannot start should say so, not
run deaf.

The three children sit before the Endpoint because a session publishes its
binding on connect and the REST connect door is the earliest one; a cast
into a not-yet-started table is silently dropped, and that session would
keep its `~` for the life of the connection.

### Registration is a cast, and that is a contract

`IRC.Client` publishes its tuple with `GenServer.cast/2`. A call would
block the connect path on an optional subsystem and EXIT the Client if
that subsystem were wedged — trading a missing `~` fix for a dropped IRC
session. The same property is the off switch: with identd disabled the
process does not exist, and a cast to an unregistered name is a no-op, so
no caller needs to know. The cost is that a rejected ident cannot be
reported to the caller; `Bindings` logs it instead, which is where the
knowledge of the wire lives anyway.

### What is NOT measured, said out loud

  * **The dual-stack bind is exercised by no test.** The suite binds
    `127.0.0.1` so the accepted socket's family is deterministic on every
    host it runs on; the v4-mapped normalisation a `::` bind needs is
    pinned as a pure unit test on `unmap_v4/1` instead. The listen call
    itself, on a real dual-stack socket, is unverified here.
  * **Nothing proves the feature changes anything on Azzurra.** Item 7 of
    the issue holds: `DO_IDENTD` is rewritten by the build's `config`
    script so the source tree cannot answer whether the check runs, the
    lookup additionally needs `@` in the I:line, and an `AZZURRA`-marked
    branch (`src/s_auth.c:112`) skips it outright for v4-mapped addresses
    — so even where it fires it can only fire for native IPv6. The
    empirical reading (50k lines, zero non-oper users without a `~`) is
    consistent with the check being off AND with it being on with nobody
    answering. This slice makes grappa answerable; it does not
    demonstrate that anyone asks.
  * **The listener is not flood-proof and no mechanism here makes it so.**
    Because every refusal is held for the full budget, anyone who can
    reach the port can keep all 32 acceptors parked. The cost is the `~`
    coming back, not anything worse, and the mitigation is reachability:
    scope the redirect rule to the upstream networks rather than `any`.
    A per-source rate limit was considered and declined — it is a second
    mechanism guarding a degradation that equals the pre-227 baseline.
  * **A crash of `Bindings` loses every binding.** Live sessions then get
    `NO-USER` until they reconnect. Re-deriving the table would mean
    reaching into every Client's socket from outside it, which is a
    bigger structure than the failure it insures.
<!-- entry #2135 -->

---

## 2026-09-14 — issue 2135: the schemas nobody reads, and why counting the imports would have got it wrong

A4 and A7 of the 2026-09-13 architecture review (parent #2118), filed as one
issue because A7 is A4's work list. The review ran on a host with no
toolchain, so every number in its body is a grep. Four of the six are wrong,
and each is wrong in a way worth keeping, because the same grep will be run
again by the next reader.

### The four corrections

| review | measured on `6b8b4fe0f` |
| --- | --- |
| `api.ts` 3,522 lines | 3522 ✔ |
| 31 `as` casts | **36** — 34 of them `(await res.json()) as T` |
| 107 hand-written `type`/`interface` declarations | **106**, all `type`, zero `interface` — plus one `export type { AdmissionFlow } from "./wireTypes"`, a re-export of a GENERATED type, which is the opposite of hand-written |
| "importing exactly one type from `wireTypes.ts`" | **55 names** — 54 in one MULTI-LINE import (lines 47–102) plus that re-export |
| 192 generated schemas | 192 ✔ |
| 64 referenced (~33%), "128 never read" | **59** imported by name; **120 of 192 (63%)** reachable once nesting counts; **72** never read |

Measured with an instrument that strips comments and string literals before
counting and self-tests on a fixture with known answers — eighteen
assertions, positive and negative — refusing to print a number if one fails.
It earned that: the first run reported six `as` tokens on a fixture holding
five, because `{ as: string }` is a property named `as` and `{ A as B }` in
an import clause is a rename. Cross-checked against naked greps and every
divergence reconciled: `as const` appears twice to `grep` and zero times in
code (both are prose), and 107 naked is 106 declarations plus the re-export.

**"Exactly one" is the multi-line trap**, and it is the one that matters
beyond this issue: every import in cic's boundary modules spans tens of
lines, so a line-scoped grep for `import .* from "./wireTypes"` answers with
the closing brace line and hides 54 names behind it.

### The correction that changes the work, not just the number

"128 generated, formatted, CI-gated and never read" counts DIRECT imports. A
schema nested inside an imported one is walked by `validate` on every call —
it is load-bearing even though no module names it. Counted that way the
unread set is 72, not 128, and the difference is not bookkeeping: acting on
the larger number means deleting schemas that are live, and the deletion
would compile, pass `tsc`, and fail at runtime on the first payload that
reaches the nested arm.

So the inventory the task now emits counts REACHABILITY, seeded from the
imports and closed over the composition edges. The edges are not re-derived:
they are the `deps` the schema emitter already computes for its topological
sort. A nesting the emitter can see and the inventory cannot is exactly the
error that costs a deletion, so the two read one graph.

### Where the artefact lives, and why it is not next to its siblings

`priv/wire/schema_inventory.md`, not `cicchetto/src/lib/` beside
`wireTypes.ts` and `wireSchema.ts`. Two measured reasons:

  * a worktree `mix` run bind-mounts an ENUMERATED list of paths
    (`scripts/_lib.sh`), and `docs/` is not on it — a write there lands in
    the image and a read answers with MAIN's copy, which is the #1170 class
    of unattributable red;
  * `cicchetto/src/**` is inside biome's `files.includes`, so a generated
    markdown file there would be handed to a formatter whose output no human
    may then hand-correct.

`priv/wire/` is already mounted read-write and already holds `shape.pin`,
the other artefact that exists to make a drift visible.

It gates itself with no new CI step: the inventory joins the `artifacts`
list `--check` already walks, so a cic module that starts or stops importing
a schema reddens `mix grappa.gen_wire_types --check` until the file is
regenerated. It is deliberately NOT in the `wire_pin` digest — that digest
covers `generate/0` and `generate_schema/0`, and the inventory describes who
READS the wire rather than what the wire IS. Nothing in this change touches
either emitter, so the protocol version does not move.

### A4: the criterion for the slice, and what it excludes

The slice is *the REST doors whose response envelope ALREADY has a generated
schema*. That draws the line where it costs nothing: no Wire typespec is
added, so the digest stands still and no protocol bump is owed, and no shape
is invented by hand on the client — which is the defect A4 is about.

  * `GET /me` → `S_MeJSONMeJson`. The widest renderer feed in the app, and
    the literal case the issue describes: `home_data` draws HomePane,
    `read_cursors` + `unread_counts` seed every sidebar badge, `badge_count`
    seeds the PWA icon, and a cast made all four `undefined` inside a
    renderer on a response one vintage behind.
  * `PATCH /networks/:slug/profile`, `PUT` and `DELETE
    /networks/:slug/avatar` → the EXISTING `narrowCredentialResponse`. Six
    controller actions render `NetworksJSON.update/1` through one
    `Wire.credential_to_json/1`; #1400 converted three and left three
    casting, and nothing distinguished them but which ones were looked at.

Excluded, with the reason rather than a silence:

  * `AdminNetwork` / `AdminCredential` (six casts) INTERSECT fields the
    server sends and the typespec does not declare (`circuit_state`,
    `live_counts`, `session_action`, `session_error`); validating would drop
    them. #1400 already recorded this — it needs the server-side declaration
    first.
  * `GET /networks` → `RawNetwork[]`: the hand-written type is a deliberate
    mid-rollout TOLERANCE (every field optional, `tagNetwork` defaults a
    missing one). Narrowing strictly would reject exactly the payloads it
    exists to accept.
  * login / TOTP / passkey / share-token, admin vhost list, subject search,
    perform view, ignores, settings, the reaper / circuit / delete acks, the
    message count: no generated envelope. `AuthJSON` publishes
    `subject_wire` and not the `{token, subject}` around it; the others
    publish nothing. Emitting them is a server-side change that moves the
    digest and owes a protocol bump, which is a different slice.
  * the `Record<string, unknown>` casts on the error path: not a wire shape.

### `MeResponse` stays, and that is not an oversight

cic's hand-written `MeResponse` marks `read_cursors`, `unread_counts`,
`badge_count` and `home_data` OPTIONAL while the generated schema declares
them required. The server is not ambiguous: both clauses of `MeJSON.show/1`
`Map.put` all four unconditionally. The optional marks are the test-mock
convenience `wireTypesAssert.ts` already names where it declines the
full-shape pin. So the door narrows against the generated shape and returns
a value assignable to the hand type; deleting the mirror is A4 residue that
costs a sweep of every consumer, and no door needs it to fail loud.

What the narrow did force is honest: `ME_BODY` in `api.test.ts` stopped
after `inserted_at`. A fixture that omits what production always sends
cannot catch a door losing it.

### The mutant, and what it found

Reverting the seven narrows to casts turns exactly the seven new fail-loud
assertions red and nothing else. The "nothing else" is the finding: #1400
shipped the three credential doors it DID convert with no test at all, so
the three it missed were invisible from both directions.

A positive control earned its keep here too. The complete `CREDENTIAL_ROW`
fixture was REJECTED on first run — `auth_method: "nickserv"`, where the
generated enum says `nickserv_identify`. Without a control that has to
answer yes, three rejection assertions would have passed against a narrower
rejecting everything.

### What the narrow caught first, in CI: two unfaithful e2e fixtures

The first thing this slice rejected was not a server bug — it was four e2e
tests whose `GET /me` mocks fabricate a body no grappa ever sends. All four
died the same way (30 s waiting for `.sidebar-home-btn`), and all four DOM
snapshots carry the same alert: "the server sent a subject profile this
version of the app cannot read". So the cure was to make the mocks
FAITHFUL, not to widen the narrow. The two are genuinely different worlds
and the choice between them is measurable, so it was measured rather than
assumed: had the real door been able to emit either shape, the narrow would
have been the defect.

It cannot. `GrappaWeb.MeJSON.show/1` has exactly two clauses and both
`Map.put` all of `read_cursors` / `unread_counts` / `badge_count` /
`home_data` from one literal pipeline — there is no degraded arm, so a
controller unable to supply one raises rather than omitting it.
`Grappa.Networks.Wire.home_network_row/2` is likewise the sole builder of a
home row and emits all six keys, `recoverable` included, from one map
literal.

The two fixtures were unfaithful in DIFFERENT places, which is why the
mechanism had to be measured per file instead of generalised from the first
one:

* `issue687-crt-boot-stages.spec.ts`'s `ME_USER` carried five of the nine
  top-level keys — the four it asserts on, and no more;
* `registration-wizard.spec.ts`'s `meJson()` carried all nine, and its
  NESTED `home_data.networks[0]` carried five of six: no `recoverable`.

Measured by feeding both fixture bodies straight into `narrowMeResponse`
rather than inferring it from the DOM: both rejected, the wizard body
accepted the moment `recoverable` alone was added, a faithful body accepted
as the positive control and `42` rejected as the negative one. Only two e2e
files build a `/me` body by hand at all — the rest talk to the real server,
which is why ~490 tests ran and exactly four failed.

The lesson is the one `registration-wizard.spec.ts` had already written
about its own socket mock two months earlier, in a comment thirty lines
below the fixture this slice had to repair: a mock that fabricates less
than the server sends "is not a simpler mock, it is an UNFAITHFUL one" that
"kept a half-finished migration green". A runtime narrow is how that
sentence stops being advice and starts being enforcement. The price it
charges is a 30 s browser timeout in a sharded CI job rather than a line in
the cheap cic gate — a per-fixture schema assertion in vitest would catch
the same class for a few milliseconds, but it needs the fixtures hoisted
out of the spec files into a playwright-free module first, which is its own
slice.
<!-- entry #2136 -->

---

## 2026-09-14 — issue 2136: the theme sheet was globbed rather than named, and the split it was told to take moves 1.7% of it

`cicchetto/src/themes/default.css` grew unwatched. The cure for that is one
clause of prose and a gate that notices when the clause goes away; the SPLIT
the issue proposes alongside it is deferred, and this entry is the measured
reason the deferral is not just caution.

### How to reproduce every number below

The partition and the token census come from **`test/bench_2136.sh`**, which is
committed for this reason and no other — a number that decides a refactor must
be re-derivable from the repo alone. It runs 13 known answers BEFORE it
measures anything and prints no measurement at all if one disagrees; the
fixtures exercise the ways the scan can be silently wrong (braces inside a
comment, an unclosed block it must refuse, a `:root` nested in an `@media`,
prose and BEM selectors that inflate a naive token grep). Verified by mutation:
breaking the classifier fails 2 controls and emits zero numbers.

```sh
bash test/bench_2136.sh                              # the partition + token census
wc -l < cicchetto/src/themes/default.css             # 15,513
git show 24d1cb0ac:cicchetto/src/themes/default.css | wc -l   # 12,778, one month earlier
git ls-files | xargs wc -l | sort -rn | head -5      # the size ranking
git ls-files 'cicchetto/src/*' | grep -vE '__tests__|\.test\.tsx?$' | xargs wc -l | tail -1
grep -rl 'themes/default\.css\|themeCss' cicchetto/src/__tests__ | wc -l   # 29 = 28 + helper
grep -c '!important' cicchetto/src/themes/default.css         # 2
```

The growth anchor is **pinned to a SHA on purpose**. The date-relative spelling
(`git rev-list -1 --before=2026-08-14`) is not a provenance: two commits sit 41
minutes apart on that boundary day (`24d1cb0ac` at 13:24 and `e2bb68c9` at
14:05, 12,778 lines against 12,792), and which one the walk returns is not
something a reader should have to reproduce by luck.

The sheet is byte-identical at `6b8b4fe0f` and at this branch's base
`aad1e8ef2` (sha256 `b768e61e…`), so it does not matter which of the two you
check out.

### The scope defect was real in one document and already fixed in the other

The issue says the review skill "globs `src/**` but never names this file".
Measured: `docs/reviewing.md` has **zero** occurrences of either "CSS" or
"themes" — the scope row is glob-only and the cicchetto checklist enumerates
SolidJS, TypeScript, wire shapes, XSS and a11y without mentioning stylesheets
at all. But `.claude/skills/review/SKILL.md` **already** named
`cicchetto/src/themes/*.css` in its scope row and **already** carried a CSS
lens. The premise held for one of the two files.

That the two had drifted was known: the 2026-08-15 codebase review recorded
"`docs/reviewing.md` lists 8 scopes; the skill defines 9 … The two documents
should be reconciled." They still are not. This slice reconciles the CSS axis
only and leaves the scope-count divergence open.

The skill's row carried its own rot: it called `default.css` "the single
largest file in the repo (9022 lines)". Both halves are false — the file is
15,513 lines and the FOURTH largest tracked text file, behind
`docs/DESIGN_NOTES.md` (no count quoted — this entry lives inside that file and
lengthens it, so any figure here is wrong by the time it is read; the ranking
command above is the honest form), `frontends/shottino/shottino.c` (23,017) and
`docs/design_notes/2026-07.md` (17,096). It was replaced with a class rather
than a fresh count ("by a wide margin the largest file under `cicchetto/`",
true at 3.4x the next one) because a number in prose is a claim with an expiry
date and this one had already expired.

### Two more of the issue's numbers, re-measured

Growth **holds**: 12,778 lines at `24d1cb0ac` (2026-08-14T13:24+02:00) → 15,513
today, +21.4% (the issue
says 12,822 → 15,476, +20.7%; different commits, same fact).

The **17% of all non-test client code** does not reproduce. Under the partition
"everything under `cicchetto/src` not in `__tests__` and not `*.test.ts(x)`",
verified exhaustive (test + non-test re-sums to the total), non-test client
code is 108,784 lines and the sheet is **14.26%** of it. Reaching 17% needs a
denominator near 91,250, and no defensible exclusion gets there.

### What the sheet is actually made of

Exhaustive partition, cross-checked against `wc -l`:

| group | lines | share |
|---|---|---|
| component rules | 8,617 | 55.5% |
| interstitial (depth-0 comment/blank) | 5,178 | 33.4% |
| `@media` | 1,108 | 7.1% |
| `:root` / `[data-theme]` token blocks | **260** | **1.7%** |
| `@keyframes` | 194 | 1.3% |
| `@font-face` | 120 | 0.8% |
| `@supports` | 36 | 0.2% |
| TOTAL | 15,513 | 100% |

By line nature, summing to the same total: 8,595 lines of actual CSS (55.4%),
5,329 comment-only (34.4%), 1,589 blank (10.2%). **Less than 56% of the file
is CSS.** It holds 1,370 top-level blocks under 519 column-0 section comments.

### Why the token model is not the split axis

The token census, comment-aware so the header's own "Variables:" prose and BEM
selectors like `.adm-btn--danger:hover` cannot inflate it: **135 definitions,
91 distinct names** — `--nick-color-*` 48, `--adm-*` 38 plus `--adm-space-*` 6,
core theme and geometry 25, `--mode-*` 8, `--safe-area-*` 4, effects 3,
typography 3.

Those definitions occupy 260 lines. **Splitting "along the token model" moves
1.7% of the file and leaves 98.3% exactly where it is.** The token model is not
a partition of this sheet at all: it is a small vocabulary that 1,370 blocks
consume. An axis that addresses the size is the file's own de-facto structure —
the 519 section comments, which already group rules by product surface — and
that is a different proposal from the one the issue names.

### The condition a future split must satisfy, and it is constructible

Proposed: **the built CSS bundle must stay byte-identical.** Measured rather
than asserted:

- Two clean `bun run build` runs produce `dist/assets/index-oaGHBf8Y.css`,
  152,277 bytes, sha256 `9431a370…`, identical both times. The bundle is
  reproducible run-to-run, so the criterion has a stable baseline to compare
  against. Vite content-hashes the filename, so a changed bundle renames itself.
- The build minifies 560,230 → 152,277 bytes and **comments do not survive**.
  The oracle is therefore blind to the 44.6% of the source that is prose and
  blank lines — which is what you want: relocating a section comment with its
  rules must not fail the gate.
- Byte-identity is not over-strict here, and that is the load-bearing point.
  CSS cascade order IS semantics: on equal specificity the later rule wins. A
  split that preserves concatenation order yields an identical bundle; one that
  reorders yields a different bundle AND can genuinely change rendering. The
  oracle is calibrated to the hazard rather than merely convenient.

A second condition the bundle hash cannot express. **28 test files plus
`__tests__/helpers/themeCss.ts` read the stylesheet as TEXT**, through exactly
two hardcoded `readFileSync("src/themes/default.css")` call sites. A split
leaves those reading whichever fragment kept the name. Most of the breakage
would be LOUD — `ruleBody`, `nestedRuleBodies` and `mediaGatedBlocks` all throw
when a rule or gate is absent, deliberately, "so a rename can't silently pass
the test". But `allRules()` and `focusRules()` return arrays and throw on
nothing. Checked, and the answer was better than expected: all three current
callers (`railInset`, `railRadioBandInset`, `focusVisible`) carry their own
non-emptiness guard, so the vacuous-green hazard is **structural but not
realized today**. A fourth caller written without a guard would open it. So the
split must re-point `themeCss` at the ORDERED CONCATENATION of the split set,
which removes the question instead of relying on every future caller to
remember.

### Not measured

- Whether the 519 section comments actually correspond to product surfaces
  cleanly enough to cut on. The grouping above counts them; it does not judge
  them.
- Whether a split changes anything a browser can see. Nothing here was rendered
  — the bundle-hash criterion exists precisely because this slice could not
  answer that question, and neither can the next one without a browser.
- Whether the scope-count divergence (8 vs 9) between the two review documents
  matters in practice. It is recorded, not resolved.
- The skill's "least-reviewed file in the repo" is left standing. It is not a
  claim this slice can falsify.

The `!important` count in the lens was re-checked and **holds**: exactly 2, at
lines 1814-1815.
<!-- entry #2137 -->

---

## 2026-09-14 — #2137: the eleventh injected closure gets a door, and the count gets a rationale

The 2026-09-13 architecture review (A6) read `Grappa.Session.Deps` as
"twelve injected closures carrying the Networks/Visitors → Session
inversion invisibly to Boundary", with `refresh_plan` the twelfth and
documented as outside the guard. Two of those three things were true.

### The count is ELEVEN, and the twelfth member was never invisible

Re-measured with a self-testing census (parser unit tests, six
repo-anchored positive controls, one invented key asserted at exactly
zero, and falsified by mutating a known key until the controls aborted
the run rather than printing numbers). The two producers inject **eleven**
closures. The struct carries **eleven fields**. They are not the same
eleven — they differ by one member in each direction, and conflating the
two sets is the whole bug.

`query_window_open?` was the review's twelfth. It is a struct field **no
producer injects**, its default is the STATIC `&QueryWindows.open?/3`,
this module aliases `Grappa.QueryWindows` by name, and `Grappa.Session`
declares that module in its `deps:`. Boundary SEES that edge. It hides
nothing, so it cannot be one of the edges the finding is about.

The review's growth series "7 → 10 → 12 across three reviews" holds for
its first two terms and misses the third by the same one. Dated by first
appearance of each key in `lib/`: seven by 2026-06-28 (the 07-08 and
07-19 reviews saw seven), ten by 2026-08-01 (08-15 saw ten), eleven by
2026-08-22 (09-13 saw eleven).

Four more counts in the same two files disagreed with the code and with
each other: `injectable_keys/0` claimed NINE, the `t` typedoc called all
eleven struct fields "injected", `DepsTest` called `query_window_open?`
the TENTH field, and a test name called the user due set FIVE. One file
carried "these eleven", "these ten" and "TEN, not eleven" at once.

### Ordering says WHERE a guard goes, never WHETHER there is one

`refresh_plan`'s exclusion had a real reason: `Server.init/1` invokes it
and merges its return over the opts the struct is then built from, so a
check inside `from_opts/2` would run after the fact. The fact was right;
"and therefore it stays UNGUARDED" did not follow. `Deps` now has TWO
doors — `from_opts/2` over the ten the struct keeps, at the point they
are stored, and `refresh!/2` over the eleventh, at the point it is
invoked.

`from_opts/2` alone would still have been two steps short, and the
existing tests say why: `init_or_hold/1` sits between the closure and the
struct, and a plan whose source resolved to `{:hold, _}` returns
`:ignore` without ever reaching the struct door. The four static-mapping
hold fixtures pass today while carrying five of the six user closures due
to them — that path was never guarded at all.

**The `nil ->` arm in `init/1` is deleted, not kept for compatibility.**
It was the silent half of the very bug it was written for: it handled the
closure's absence by doing exactly what a missing refresh does, which is
nothing observable. Every production spawn reaches `Session.Server`
through `SessionPlan.resolve/1` → `SpawnOrchestrator` →
`start_session/3`, and both producers inject the key, so the arm was
reachable only from fixtures.

### The shape check, and why only this member can have one

Arity is all the other ten can be checked for: nothing at the door may
invoke them, because they have effects. `refresh_plan` is different in
the only way that matters — this door consumes it anyway, so its answer
exists here. Arity alone is a weak contract for a 0-arity closure, since
every 0-arity closure satisfies it.

A STRUCT return is refused by name, and it is not hypothetical:
`Map.merge/2` accepts a struct as its second argument without a word, so
`{:ok, some_struct}` merged, injected `__struct__` into the opts, and
refreshed NOTHING. The producer's own body holds `fresh_cred` one line
above its return, so returning it instead of the resolved plan is a
one-word slip.

What is NOT checked is that the returned map is a valid `start_opts/0`.
Expressing that in the typespec would make `start_opts/0` and
`refresh_plan_check/0` mutually recursive; the runtime check stops at "a
plain map", and `from_opts/2` then validates the merged result.

### The two mutants, measured before and after

* **omitted `refresh_plan`** — pre-cure `{:ok, #PID<0.967.0>}`, a live
  session, registered as `nick=stale-nick` while the DB row said
  `fresh-nick`. Post-cure `{:error, {%DepsInjectionError{}, _}}` naming
  `refresh_plan` and no other key.
* **right arity, struct return** — pre-cure `{:ok, #PID<0.924.0>}`, a
  live session, refresh silently a no-op. Post-cure refused.

Neither pre-cure case was a crash, an error or a log line. That silence
is the finding; the mutants exist because an argument for it would not
have been believable.

### Why `refresh_plan` is NOT a `defstruct` field

It is in the due tables and in `t:injectable/0`, and deliberately not in
the struct. Nothing reads it after `init/1`, so a field would be a member
no consumer has. It would also move the DEPLOY CLASS: `Deps` is listed in
`HotReload.LongLivedModules`'s `@state_helpers`, and
`Deploy.Preflight.collect_state_blocks/1` extracts exactly `@type t`,
`defstruct`, and `init/1`'s returned map literals — so a field-add here
classifies COLD, while module attributes and function bodies do not move
the extracted block at all.

### The rationale table, total at compile time

The count reached eleven with the reasons scattered over eleven typedocs
and two producer modules, and nobody could state the rationale for the
SET — which is how three disagreeing counts survived in one file.
`@member_rationale` now holds one entry per governed member (the eleven
injectable keys plus `query_window_open?`, whose entry records why it is
NOT part of the inversion), each naming who injects it, which cycle the
closure dodges, and what its silence costs. A compile-time assertion
holds the table total against that domain: **a twelfth closure does not
compile until someone writes down why it exists.**

A second compile-time assertion pins `:refresh_plan` into both due
tables, because `DepsTest`'s producer pin structurally cannot catch its
removal: that test filters the live plan through `injectable_keys/0`,
which is derived from the same tables, so dropping the key would remove
it from both sides of the assertion at once and leave it green.

The moduledoc's two hand-written producer lists are DELETED rather than
corrected. They were duplicated state with no housekeeping, and they had
just rotted again in the same commit that added the eleventh member
("three shared" became four). `required_injections/1` and `rationale/1`
are the sources; a prose copy is the failure mode this entry is about.

### What is NOT claimed

Boundary still cannot see any of these eleven edges, and this slice does
not change that. A closure carries no module reference — that is the
premise of the defect, not an oversight — and making the edges visible is
a redesign of the inversion, not a slice. What changed is that the
eleventh closure is now guarded like the other ten, and that the set has
a rationale in one place instead of none.
<!-- entry #2138 -->

---

## 2026-09-14 — issue 2138: the rollover is enforced, and August leaves the live log

`docs/DESIGN_NOTES.md` is the CURRENT month plus the undated preamble;
closed months are archived verbatim under `docs/design_notes/` (#1537).
Nothing enforced that, so it stopped after July and nobody noticed for six
weeks. Measured on `aad1e8ef2`: 3,315,240 bytes, 613 level-2 headings, of
which **495 August entries** were still inline — 78% of the file, carried
by every grep of the log and by every append to a `merge=union` path.

### The check is FILE-scoped, and that is the finding, not an oversight

Every other check in `scripts/design-notes-gate.sh` is diff-scoped because
it judges the SHAPE of what a branch WROTE, and most of this file's history
predates the convention. A stale month is the opposite kind of fact: a
property of the FILE that every branch is about to build on, whose fixer is
whichever branch comes next rather than whoever wrote the entries. So check
0 ignores the diff, and — the load-bearing half — it runs even when the
branch appends nothing. Most PRs never touch the log; gated behind the diff
the enforcement would be dead exactly where the debt lives. The fast path
that used to `exit 0` on such a branch now exits with the check's status,
and it prints the "nothing to roll over" summary only when there is nothing
to roll over: that is the one path where the summary and a finding can be
emitted together, and a line claiming the opposite of the finding above it
is the log-honesty bug in its purest form. There is a case for it.

### "CLOSED" is read off the FILE, never off the clock

The newest month with an inline entry is the current one; every older month
is closed. The wall-clock alternative — "older than today's month" — turns
main red at midnight on the 1st for work nobody did, blocks every unrelated
PR until someone does a 2.5 MB move, and cannot be tested without a time
seam. The file-relative rule goes red on the branch that OPENS a new month:
attributable to a change, and the exact moment the rollover falls due. It
is also deterministic, so the bats cases assert it without freezing time.

The price, stated: a month that closes with nobody writing anything in the
new one stays green until the first new-month entry lands. That lag is
harmless — nothing is inconsistent, the archive is merely not yet cut — and
it is what buys the absence of a clock-driven red.

### The trap this check is one regex away from: its subject documents itself

The rollover's own index table carries a `| 2026-08 | ... |` row forever
after; the preamble names the boundary month in prose; entries quote entry
headings inside fences. A matcher that reads any of those is GREEN on a
broken file and RED on a correct one — an assertion passing on the
documentation of its own rule. So the check anchors on the KEY line and
nothing else: `^## YYYY-MM-DD` outside a fenced block, which is already the
definition of an entry everywhere else in this gate. The bats case feeds a
fixture all three prose shapes at once, asserts green, then un-fences the
same heading text and asserts red — two-sided on one file, because a green
that nothing can turn red is what a check reading nothing also produces.
Both controls are EXACT (`-eq 0` against `-eq 1`); a `>= 1` threshold
acquits the tool precisely when it is broken.

### August was not contiguous, and one entry decided the membership rule

`## 2026-08-31 — #1883c` was appended in September and sat at line 45664,
among September entries. It moves with August, to the tail of the archive,
where it keeps BOTH orders: it was appended last among August entries, and
08-31 is the last August date. Leaving it inline was the alternative and is
worse in every direction — a grep for an August ruling would find 494
entries on one path and one on the other, and the gate would need a
permanent exemption for a single entry, which is an exclusion list.

So membership is read off the DATE in the heading, the only month signal
the file carries; append order is not recoverable from it. That is a
MEMBERSHIP rule and deliberately not an answer to the open question of
whether this log is ordered by date or by append order: an entry dated
08-31 and appended in September belongs to August under either reading.

### The arithmetic was written down before the first byte moved

Predicted, then measured, both sides:

```
DESIGN_NOTES.md  3,315,240 B / 56,929 L  ->  726,304 B / 12,647 L
design_notes/2026-08.md      (new)       ->  2,588,931 B / 44,280 L
```

The 5-byte / 2-line difference is the `---` + blank that glued the preamble
to the first August entry and belongs to neither side — the archives all
begin at a `## ` heading. Then the stronger check, because equal totals
prove nothing about content: the three files were reassembled into the
original and `cmp`'d — rc=0, with a one-byte perturbation of the
reconstruction returning rc=1, so the comparison is known to look. The
prefix that must not move was checked the way BSD `cmp` allows (`head -c K`
on both sides, K the byte length of the surviving preamble) with the K+1
negative control returning rc=1, since `cmp -n K` cannot prove a prefix.

### The failure mode for THIS branch is resurrection, not loss

`merge=union` takes the additions from both sides and never the deletions.
The usual hazard on this file is an eaten separator; a branch that DELETES
in bulk has the mirror one — any branch forked before the move brings the
text back, with rc=0, no conflict and zero deleted lines. All three success
signals agree while the work has been undone.

`scripts/union-rebase.sh` could not express that, and the cure ships here
rather than behind an issue, because it is the instrument this very landing
has to be verified WITH. Its verdict read
`add_before == add_after && del_after == 0`: deletions treated as a quantity
FORBIDDEN when they are a quantity CONSERVED. On a branch whose work is a
removal that is wrong in both directions, and the second one is not a nit —

- **false RED** on a correct rebase, because such a branch's `del_after` is
  legitimately nonzero;
- **false GREEN** when the driver EATS the removal, because `del_after` then
  falls to 0 and the rule is satisfied.

Measured, on a fixture that runs a real rebase rather than a hand-written
file: with the removed block adjacent to what the base appended, the driver
puts the deleted text back and the contribution collapses to an **EMPTY
diff — 0 additions, 0 deletions** — which the old rule called "contribution
intact". The verifier was inverted on precisely the failure mode it exists
for, and nothing had caught it because no branch had deleted in bulk from a
union path in a long time. It is now
`add_before == add_after && del_before == del_after`, the old form deleted
in the same commit, with both directions pinned by cases whose rc flips when
the line is put back.

What did NOT ship is a generic CONTENT assertion inside that tool. Equal
numstats do not say WHICH lines moved, so one is clearly desirable — but no
fixture in this suite can make numstat blind while content moves: every
damage the driver produces here is already visible in the counts, so such an
assertion would ship with **zero constructible mutants**, unfalsifiable by
construction. The content checks therefore stay where they ARE falsifiable,
as the per-branch pin this landing runs by hand: zero `^## 2026-08-`
headings inline after the rebase with the base's 495 as the positive
control, and the archive's sha256 unchanged (it carries `merge=text`, so
interference there conflicts loudly instead of silently).

The standing detector, from here on, is check 0 itself: if a union rebase
ever puts an archived month back into the live log, the gate is red on the
next run.

### What this does not guard

Nothing asserts that text deleted from the live log ARRIVED in an archive.
A rollover that deletes a month and forgets to write the file is green
here, and the only thing standing in front of it is the arithmetic above,
performed by a human. Closing that would mean comparing against history, a
different and much heavier check; it is named here rather than left for
someone to discover.

### The verifier was measuring the aligner, not the contribution

Both tools went RED on this branch's real rebase onto `702834fd7`, and
neither red was about the branch. `git diff`'s default algorithm (`myers`,
heuristics on) does not produce a minimal edit script, and on a bulk
deletion from a large file the alignment it settles on depends on content
the branch never touched — here, the 492 lines `origin/main` appended while
the branch was out.

    myers      before 156/44287   after 323/44454   <- BOTH columns +167
    minimal    before 156/44287   after 156/44287
    patience   before 156/44287   after 156/44287
    histogram  before 156/44287   after 156/44287

On a third pair (merge base → post-rebase HEAD) the three stable algorithms
all returned 648/44287 — the arithmetic prediction, 156 plus main's 492
appended — while myers returned 798/44437.

`union-rebase.sh` compares counts taken against two DIFFERENT base files, so
its verdict is only meaningful if the count is a function of the content.
`design-notes-gate.sh` has a second, uglier symptom from the same cause: it
derives "the headings this branch adds" from the same diff, and myers
attributed `## Open design questions` and `## What's *not* in this document
(on purpose)` — PREAMBLE lines, byte-identical on the base — to the branch,
so the gate demanded an entry marker on two lines nobody wrote. That is the
gate failing on the exact shape check 0 now makes MANDATORY every month.

Both are pinned to `histogram`. `minimal` and `patience` measured equally
stable and nothing here distinguishes them; histogram was the ruling's
choice and the measurement did not displace it (0.04 s vs 0.08 s on the
3.3 MB file, so cost did not decide it either). The pin lives inside
`pin()`, which serves both sides of the comparison — pinning one side would
be worse than pinning neither, since the two numbers would then be computed
by different rules.

What made the reds safe to overrule was not the tools: the post-rebase file
was rebuilt byte-for-byte from its three parts — the branch's head, main's
appended tail, the branch's entry — and `cmp`'d against the real one, rc=0,
with a one-byte perturbation giving rc=1. That answers the question the
numstat cannot even ask.

**Untested, and not faked.** Two synthetic fixtures were built to reproduce
the instability — 60,000 lines with a 45,000-line deletion, and 30,000 lines
with a 24,000-line deletion drawn from a six-line vocabulary to maximise
alignment ambiguity. In both, myers and histogram agree on both sides of the
rebase, so neither discriminates and neither shipped. The instance above is
the only measured one. A fixture that cannot fail asserts nothing while
looking like cover.
<!-- entry #2139 -->

---

## 2026-09-14 — #2139: six of the seven e2e strictness flags were free, and the seventh says why it is not

`cicchetto/e2e/tsconfig.json` set `strict: true` and omitted seven flags that
`cicchetto/tsconfig.json` pins. Arch review #2118 (finding A9) called that the
larger half of the client's verification surface being checked more loosely
than the code it drives. Six of the seven are now on; the seventh is off with
its reason written in the file, which is the outcome the issue admitted.

### The flags were measured one at a time, not turned on in a heap

Enabling all seven and reading the pile gives a total and tells you nothing
about which flag to keep. Each was enabled ALONE against an otherwise green
tree:

| flag | errors |
| --- | --- |
| `noUncheckedIndexedAccess` | **813** |
| `noUnusedParameters` | 1 |
| `noUnusedLocals` | 0 |
| `noFallthroughCasesInSwitch` | 0 |
| `noImplicitReturns` | 0 |
| `verbatimModuleSyntax` | 0 |
| `isolatedModules` | 0 |

All seven together produce 814, so they compose additively — no pair
interacts. The probe carried its own controls: the pristine tree had to be
green (else no per-flag number is attributable) and a deliberately broken
config had to go red (else the harness cannot see a failure at all).

The single `noUnusedParameters` error was a dead `el` parameter on a Playwright
`evaluate` callback whose body queries `document` instead. The parameter is
removed rather than renamed to `_el` — the locator stays, because
`.evaluate` on it is still a real synchronisation point, but a parameter no
one reads is dead code. tsc enumerates that class exhaustively: 176 e2e
`evaluate` callbacks take one parameter, exactly one did not read it, and
after the fix the count is zero. The class is closed, not the example.

### Why `noUncheckedIndexedAccess` stays off, measured

813 errors across **287 of the 496 files** (58% of the tree), and 753 of them
are one shape: TS2345, `string | undefined` not assignable to `string` — an
index read handed straight on. The mechanical cure is a `!` at each of the 813
sites. That buys the flag's name and none of its safety, and plants 813
non-null assertions in a tree whose own linter treats them as a smell. Making
the flag mean something requires auditing those reads, which is a slice of its
own. The reason lives in the tsconfig next to the other six, so the next
reader does not have to re-derive it.

### The flags were proven to BITE, two-sided

A green gate after the change proves the tree still compiles; it does not
prove the flags do anything. A typo in a key, a flag TS silently ignores, or a
tsconfig the runner never reads would all be green too. So one minimal
violation per flag, judged on TWO sides: RED under the new config **and**
GREEN under the pre-change config, because a mutant red on both sides is not
attributable to the flag. All six bite — TS6133, TS6133, TS7029, TS7030,
TS1484, TS1205 respectively.

### The review's numbers were RIGHT, and that is worth recording

Siblings of #2118 have been correcting the parent's counts, so these were
re-derived rather than cited. At the review's own timestamp
(`0136c7771`, 2026-09-13T21:03:44Z) the e2e tree measures **495 files /
80,653 lines** — the review's figure, exact to the file and to the line. The
non-test `src` count measures 92,275 against the review's 92,272, a 3-line
(0.003%) gap not explained by `.d.ts` files (there are none) nor by excluding
`setupTests.ts` (that lands 147 short); it is left unattributed. TODAY the
same definitions give 496 / 80,920 and 92,421 — the figures in the issue are
not wrong, they have aged by a day.

### A red baseline that belonged to no branch

The first `bun run check` on this worktree reported 2 of 5 stages failing.
Neither was #484 and neither was the branch. Stage 1 is lock drift and it
named the cause: 24 packages installed off-lock, **including biome itself**
(lock 2.5.13, installed 2.5.8), inherited from cloning `node_modules` out of
another checkout. The biome failure below it was produced by the wrong biome.
After `bun install --frozen-lockfile` the true baseline is **5 stages, 0
failed** — `tsc (e2e)` included. #484 tracks pre-existing type errors in that
tree; on this base there are none, so every error the new flags surfaced is
attributable to the flags. Stage 1 exists precisely so that a stale toolchain
reports as a stale toolchain rather than as a defect in the code under test.
<!-- entry #2140 -->

---

## 2026-09-14 — #2140: every membership sigil is tracked, and a seed may only deny from the top DOWN to what it named

A member holding `+v` was given `+o` and then `-o`, and the nicklist drew
them as a plain user. A manual `/names` repaired the pane, so the loss was
ours. The report names op and voice; the defect is generic over the
ISUPPORT PREFIX table (`~ & @ % +`).

The roster is a SET of sigils per member at every stage but one — the
seed. Without `multi-prefix` a 353 RPL_NAMREPLY carries the member's
HIGHEST sigil and nothing else, so `state.members[channel][nick]` held a
one-element list for a member upstream knew as two, and `-o` →
`toggle_mode(_, _, :remove)` → `List.delete/2` emptied it.

**Second half of the same root, opposite sign:** the 353 fold was
`Map.merge(existing, new_entries)`, so the seed WON per nick and a member
the live MODE stream had correctly tracked as `["@", "+"]` was overwritten
down to `["@"]`. A `/names` repaired the reported direction and silently
broke this one. Any cure built on re-seeding inherits that.

### The rule, and why it is NOT "union" — a declared deviation

vjt ruled the shape ("we keep track of the sigils in grappa, full stop":
no NAMES storm, no per-MODE query). The issue body then gave two
formulations that do not coincide: the SEMANTICS *"a seed asserts the top
sigil, it never denies a lower one"* and the MECHANISM *"union, not
overwrite"*. They diverge in two cases, and pure union is the weaker:

| live set | 353 token | pure union | deny-from-the-top |
| --- | --- | --- | --- |
| `["@","+"]` | `@bob` | `["@","+"]` | `["@","+"]` |
| `["@"]` | `bob` (bare) | `["@"]` | `[]` |
| `["@","+"]` | `+bob` | `["@","+"]` | `["+"]` |

A 353 token is not partial information at random: it is the claim *this is
the top*, so everything ranking ABOVE it is provably absent, and a BARE
token is the limit case (top = none, therefore nothing — a COMPLETE
statement). Pure union makes a stale sigil PERMANENT for the life of the
membership and so removes a repair that exists today: `/names` currently
fixes exactly that case. A cure that withdraws a working remedy owes a
proof it did not pay here. **The ruling to implement the semantics rather
than the stated mechanism is the orchestrator's, not vjt's** — recorded
under that name so it can be reversed in one line at review.

The implementation is `merge_seeded_sigils/3` and carries no branch: keep
the tracked sigils ranking strictly BELOW the LOWEST sigil the seed named,
take the seed's run for everything at or above it. Rank comes from the
advertised run (`ISupport.sigils/1`, highest first), never from the
token's byte order — `multi-prefix` sends highest-first by convention, and
a convention is not a contract.

### Two properties that fall out instead of being coded

**No reconnect clause.** The one window where the local set must be
dropped wholesale is a reconnect, where we were genuinely blind. Self-JOIN
already wipes `members[channel]` (`event_router.ex`, the "wipe stale state
for this channel" arm) and every reconnect goes through it, so `tracked`
is empty by the time the seed lands and the rule passes over it silently.

**No cap branch.** As the reported run grows the rule degrades toward "the
seed is the whole truth": with `multi-prefix` the run is complete, its
lowest member is the member's lowest grade, and nothing survives
underneath it. Nothing reads whether the cap is active.

### `multi-prefix` joins the opportunistic caps

Added to `AuthFSM`'s `@opportunistic_caps` for the three properties the
two entries before it have: advertised-gated, no follow-up exchange, NAK
non-fatal. It makes even the seed complete on solanum-family networks. No
consumer branches on it — the 353 peel was already greedy and the fold
reads a run of any length — so the cap changes what upstream SENDS and
nothing about what we do with it.

**H9 edge, accepted rather than discovered.** The combined-REQ NAK
fallback re-requests `:sasl` alone and drops it. For `account-notify` that
loss was theoretical (the fallback exists for bahamut-family servers,
which do not offer it); **that argument does not transfer** — the fallback
also covers Solanum variants, which advertise `multi-prefix`. The loss is
real there and costs the seed's completeness, i.e. it degrades exactly to
this issue's accepted residual, never to a wrong roster. The alternative
is a second in-flight REQ the FSM would have to correlate against its own
ACK, and an ACK carrying no `"sasl"` is already read as "SASL refused" in
all three `:awaiting_cap_ack*` phases — that ladder buys a complete seed
at the price of a login.

**`@tracked_caps` stays at two, and the split is now load-bearing.**
#2097 recorded that the two lists held the same names and were kept apart
anyway, "two readings that may legitimately diverge". This is that
divergence arriving: `multi-prefix` is opportunistic (we ask) and NOT
tracked (no branch reads its ACK). Consequence, named: a DEL/NEW cycle of
`multi-prefix` is not re-requested, so the seed reverts to top-sigil-only
— the accepted residual again.

### Accepted residual

On a network without `multi-prefix`, a grade held BEFORE our seed and
hidden under a higher one is unknowable — probed on Azzurra, `353` gives
`:@nick` and `352` gives `HS@`, one status char, so no client can see it
either. No query chases it. A second residual is new and belongs to the
rule: a grade our live set holds STALE and the seed ranks below its lowest
survives. That needs a MODE we never applied (#878 withholds derived state
from a malformed line) and clears the moment the member's grades move.

### The prose that had to move with the code

Four comments asserted a present that this slice changes, and all four
were rewritten in the commit that falsified them: the "GREEDY on purpose —
`multi-prefix` is not in grappa's CAP REQ today" note and its copy in
`event_router_test.exs`; `auth_fsm.ex`'s "unchanged in BYTES for every
existing case" (false for any network advertising the cap) together with
the KNOWN EDGE paragraph; and `server.ex`'s "`@tracked_caps` … holds the
same two names". This is the #2127 / #2125 class: prose explaining a
choice is a claim about the present and moves with the code.

### What is not measured

Nothing was probed against a live ircd in this slice — the Azzurra and
Libera figures are vjt's, quoted from the issue, not re-measured here. The
cure is exercised at the router and FSM level only: no `Session.Server`
integration test drives a real 353 burst, and cic was read (`modeApply.ts`
keeps `modes` an array, `memberSigil.ts` picks by the advertised rank) but
not re-run against a multi-sigil member.
<!-- entry #2143 -->

---

## 2026-09-14 — issue 2143: auto-accept skips the human, never the gate

Lucy asked for a per-network DCC auto-accept so that receiving files from
the same people stops costing a banner every time. What shipped is that
request with one conjunct added, and the conjunct is the entry.

### The opt-in alone is not a feature, it is a hole

`Grappa.Dcc.Policy.admit_accept/1` charges the `:dcc_receive` daily quota
on the ACCEPT and deliberately never on the offer, so that a flood of
unanswered offers cannot exhaust a subject's allowance. That design makes
the consent click the thing that spends the allowance — which means a
per-network switch with no peer restriction does not remove one click. It
removes the only thing between a stranger and ten files a day on the
operator's spool, and promotes the quota from backstop to primary guard,
while handing whoever sends first an unsolicited window and a
notification.

So the gate is a conjunction, and both halves are required:

    UserSettings.get_dcc_auto_accept(subject, network_slug)
      and QueryWindows.open?(subject, network_id, from)

An open query window is a relationship the SUBJECT made. A stranger keeps
the #546 banner, always. The wide variant — any peer, quota-only — is a
deliberate relaxation of the consent ruling and is **not built here**; it
is vjt's call, not this issue's. `QueryWindows.open?/3` already existed
and already folds the raw nick (#121/#537), so `Alice` and `alice` are one
relationship rather than two.

### The lenient read fails CLOSED, and its neighbour fails OPEN

`UserSettings.get_dcc_auto_accept/2` sits twenty lines from
`get_ignores/2` and they are lenient in OPPOSITE directions, which is
worth stating before someone harmonises them. An unreadable ignore list
must deliver messages, because failing closed would silently ignore
everyone. An unreadable auto-accept must keep the banner, because failing
open hands a peer the spool with no human in the loop. One costs noise,
the other costs consent; they are not the same quantity and a shared rule
would be wrong for one of them. Only the literal `true` enables — a
stored `1` or `"yes"` is malformed, not truthy.

### The fork lives inside the refusal funnel

`admit_dcc_offer/4` already funnelled every refusal — parser, policy,
ceiling — into ONE `Report.render({:refused, _}, from)` row, because the
operator's question is "why did that file not arrive" and three
vocabularies answering it is how the answer starts disagreeing with
itself. The auto-accept arm is therefore a branch of `take_dcc_offer/4`
INSIDE that `with`, not a sibling clause beside it: a quota refusal on an
auto-accepted offer produces the byte-identical row a hand-accepted one
does. Skipping the human must not change what the human is told.

What the auto arm does not do is mint a handle, hold, arm an expiry or
raise a banner — so there is no `dcc_offer_resolved` to fan out either,
because that event exists to retract a prompt and there was none.

`@held_cap` is not consulted on that arm and **nothing is lost by it**:
the ceiling bounds the BANNER queue, which this arm never joins. The rate
guard on accepts was always the daily quota and still is.

### No live-session sync, deliberately

The sibling `/ignores` door pushes every mutation into the running
session because `state.ignores` is a cache. This one pushes nothing:
`Session.Server` reads the opt-in at the moment an offer arrives. Offers
come at human pace — one per decision on the far side — so there is no
hot path to protect, and a cache here would be duplicated state bought
for nothing.

### The test needed a non-destructive read of the quota

An auto-accept raises no banner and mints no handle, so the only
synchronous evidence that an offer reached `admit_accept/1` is the spent
quota slot. Polling THROUGH `Policy.admit_accept/1` cannot measure that:
it is check-and-record, so the poll would take the very slot under
assertion and the test would go green because IT spent the allowance.
The counter is read straight out of the public ETS table instead — the
same thing `AdmissionStateHelpers` does for the network circuit — and
`Policy.quota_bucket/0` was exposed for the reason `daily_accepts/0`
already is: so a caller reads the atom rather than restating it where a
rename would not reach.

Without that positive oracle the two refutations ("no banner", "nothing
held") would both pass on an offer silently DROPPED, which is precisely
the outcome 2089 forbids.

### What is not covered

The e2e never receives BYTES. An offer has to survive the SSRF gate to be
admitted, so its address is TEST-NET-3, which answers nothing — the same
constraint `issue2089-dcc-consent-banner.spec.ts` documents. "The file
arrived" is measured as the server dialling on its own and reporting the
outcome into the peer's query, which is the whole observable difference
between an auto-accept and a dropped offer, but it is not the bytes.

There is no cic control for the switch in this cut. It is settable over
REST and nothing else, so the feature is invisible to the operator who
asked for it until a client renders it; whether that control ships is a
product ruling that was escalated rather than decided here.

### The refusal cannot land in `$server`, and the conjunct is why

The first version of the quota-refusal test asserted the refusal row in
`$server`, copied from the `:passive_unsupported` test twenty lines above
it. It failed, and the failure was the test's: `ctcp_query_channel/3`
routes an inbound CTCP to `$server` only when there is NO open query with
the sender (#546), and the auto-accept arm requires exactly such a window
to fire at all. So the two tests can never assert the same window — the
sibling's peer is a STRANGER, and that is the entire difference the
conjunct encodes. The row was always written; it was written where an
offer from a known peer renders.

Worth stating because the funnel's promise is easy to over-read: what
`admit_dcc_offer/4` makes byte-identical between a hand-accept and an
auto-accept is the BODY, not the window. The window follows the
relationship, which is the thing 2143 is about.

### Protocol v22, on the rule — and the gate's silence is measured

Two new routes carrying one `enabled` boolean is a wire-shape change, so
`@protocol_version` moves 21 → 22 under #1393d, and cic's
`CLIENT_PROTOCOL_VERSION` moves with it (`protocol_test.exs` pins them
EQUAL, so a half-done bump is red rather than discovered in a browser
console months later).

`mix grappa.wire_pin --check` does NOT force it, and that was measured on
both sides rather than inherited from v10/v11/v21, which record the same
shape: on the merge base and on the finished tree the gate answered
`wire shape and protocol 21 agree.` at rc=0, and `--update` then rewrote
the pin to protocol 22 with a **byte-identical digest**
(`sha256:74cb9003…628fdb` before and after). The digest genuinely does
not move — the routes' shape lives in a controller, which is no
`*wire.ex`, is on no `@extra_modules` list, and exports no
`GrappaWeb.*JSON` view for the third component to read.

A BEFORE and an AFTER are what make that green worth quoting: one run
cannot tell a live gate's silence from a dead gate's. What is NOT claimed
is that the gate's coverage should widen here — that is a coverage change,
which the pin deliberately cannot distinguish from a shape change, and it
does not belong in a product slice.
