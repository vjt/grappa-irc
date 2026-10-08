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

Everything before **2026-10** lives in [`design_notes/`](design_notes/), moved
**verbatim** by #1537, issue 2138 and issue 2335 — not one entry was edited, cut,
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
| 2026-09 | [`design_notes/2026-09.md`](design_notes/2026-09.md) | 178 |

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
<!-- entry #2335 -->

---

## 2026-10-01 — #2335: September rolled out, and the boundary of a marked first entry

September moved to `docs/design_notes/2026-09.md` verbatim, the August
procedure (issue 2138, `60d8ddeb4`) applied unchanged — predict the byte and
line arithmetic on both files first, reassemble the original with `cmp` and a
one-byte mutant that must answer rc=1, and compare the multiset of deleted
lines with the archive's lines so that nothing is invented and nothing lost.

**Why now and not "when someone gets to it":** check 0 of
`scripts/design-notes-gate.sh` is not driven by the calendar. It takes the
NEWEST month among the inline entry headings and fails on every other one, so
the first October entry on any branch turned that branch red for as long as
September stayed inline. The rollover is the prerequisite of every append in
the new month, which is exactly why issue 2138 put it in a gate.

**The one thing August did not decide.** August's first entry predated the
#1271 marker, so its archive opens on the `##` heading and the `---` glue above
it was dropped. September's first entry opens with `<!-- entry #1044 -->` — by
the #1271 convention that entry's own first appended line — so the archive
opens on the MARKER and keeps the entry's block (marker / blank / `---` /
blank / heading) whole. Only the blank between the preamble and the marker is
glue, and it is the only line deleted without landing in the archive.

**Apply:** when a month's first entry carries a marker, the archive starts at
the marker, not at the heading: the marker is part of the entry, and dropping
it is an edit. The glue that belongs to neither side is the separator BEFORE an
entry's block, never a line inside it. And the index column counts `##`
sections, so an undated `##` heading inside the month (September has one,
`## #1922`) counts there too.
<!-- entry #1365d -->

---

## 2026-10-01 — #1365d: a nick change writes nothing; "is this a DM?" is `dm_with` (protocol 36)

**The ruling, and its provenance.** Comment 5934112501 on issue 1365
(2026-10-01T15:00Z): a nick change, a peer's OR our own, causes NO database
update; only the UI changes. Accepted downsides: a renamed peer opens a NEW
query window, and a mute is evaded by changing nick. vjt said it on IRC
#grappa (~14:59Z); the comment was written by a peer relaying it, and
`author=vjt` on it is the fleet token, not proof of authorship. This entry
records it as RELAYED.

**What this slice does (fetta A minus the wire removal).**

- *Peer axis, built.* `{:peer_nick_renamed, old}` (the effect lost its
  unread `new_nick`) keeps only the #378 presence reset, which is in-memory
  state, not a DB update. `NickMigration.peer_renamed/5` and its
  windowed/windowless halves are deleted, and with them the code that had no
  other caller: `Scrollback.rename_dm_peer/4`, the framed
  `UserSettings.rename_muted_target/4` and its #1378 probe,
  `QueryWindows.exists?/3`. cic stops moving its caches on `nick_change` in
  the same change (the server not renaming while cic did would be cic
  originating state). The e2e `nick-follow-query` is inverted, not deleted.
- *The own-nick TAG (#514) stops moving.* An inbound DM sits at
  `channel = <own nick at receipt>`; `Push.Triggers.dm?/2` compared it with
  the LIVE nick, which is why #514 re-keyed it on every self-rename — a
  write the ruling forbids. Of the three options (re-key: forbidden; a
  sentinel in `channel`: a ~30k-row backfill, also an update; a history of
  our nicks: a write per rename) only one survives: classify by `dm_with`,
  which `Scrollback.dm_peer/4` sets on exactly the rows whose target was us
  at receipt, and which no rename touches. It is `Message.dm?/1`, the ONE
  rule for `Triggers` (push + badge) and `Payload` (which had a second copy
  of the TAG test and loses the `own_nick` argument it existed for). That
  `Payload` only ever sees fresh rows is read, not measured: moving it is
  consistency, not a recorded bug.
- *The wire, protocol 36.* cic's push mirror (`pushTriggers.ts`) could not
  follow: the live scrollback row carried no `dm_with`. Left there, the
  shared truth table had to drop the one row where server and client
  disagree, which makes it a table shaped not to see the divergence. So
  `dm_with` joins `Scrollback.Wire.t`, copying the away bundle's field
  (issue 2333, protocol 35): same name, RAW, `null` off a DM, `optional`.
  Additive, so `@protocol_version` 35 → 36 under #1393d; `wire_pin --check`
  was red before the re-pin and green after. `@min_protocol_version` stays
  1, and cic's `MIN_SERVER_PROTOCOL_VERSION` stays 9: that floor is the
  axis issue 1365's Q2 ruled on ("no bump to 34"), and this does not touch
  it. Found on the way: cic's hand narrower (`narrowScrollbackMessage`)
  rebuilt the row and dropped every key it did not list, so `dm_with` had
  to be added there too, test-first. It drops `dm_conversation_id` the same
  way, which means no live WS row has ever delivered that field to cic;
  recorded, not changed (its removal is leg 4, an open question for vjt).

**What it deliberately does NOT do.**

- *Our own nick: RULED to zero writes, NOT implemented, for want of the
  mechanism.* The self window (`/msg <ownnick>`, #948) is keyed on our
  nick, and which key replaces it is undecided. `own_renamed/5` keeps
  moving it (rows, cursor, window row, mute, DM conversation) until that
  is decided. A named debt, not out of scope.
- *Removing `dm_conversation_id` from the wire and the `dm_conversations`
  files* waits on an explicit ruling (#1626: removal is never a judgement
  call inside a slice). Staging never ran migrations 20260929001416/17
  (measured on a frozen `.backup` of the staging DB by the orchestrator);
  that says nothing about prod m42.

**The census of what remains of `NickMigration`.** One public verb,
`own_renamed/5`, and everything left in the module is reached from it: the
retried transaction, `follow_conversation`, and the bounded-batch merge.
The merge/batch tests that reached it through `peer_renamed/5` now reach it
through `own_renamed/5`, so the live merge path is still covered.
<!-- entry #1365e -->

---

## 2026-10-01 — #1365e: our own nick change writes nothing either

**Provenance.** The goal was already ruled in comment 5934112501 on issue
1365 ("vorrei andare a 0 anche in questo caso"); what was missing was the
mechanism — which key replaces the nick-keyed SELF window (#948). Proposed by
the worker as the exact analogue of the peer price, posted on IRC #grappa as
the only line in flight at 22:56 Europe/Rome, answered by vjt at 22:58 with
«va BENISSIMO». RELAYED by a peer session, not seen first-hand by the
orchestrator or the worker.

**The mechanism.** None: the self window keeps the nick it was opened under,
with its rows, read cursor and mute, and `/msg <newnick>` opens a new window —
a renamed peer's next message does the same since #1365d. So there is no
`{:own_nick_renamed}` effect, and `Grappa.NickMigration` (#1374) goes with its
last verb. Its stores lose their rename verbs: `Scrollback.rename_self_window/4`,
`ReadCursor.rename_dm_peer/4`, `QueryWindows.rename/4`,
`UserSettings.rename_muted_target!/4`.

**The dm_conversations merge machinery goes in the SAME commit, by caller
count, not by inference from the ruling.** `DmConversations.follow_rename/4`
and `delete!/1`, `ReadCursor.move_dm_conversation/3` and
`dm_conversation_cursor?/1`, `Scrollback.move_dm_conversation_rows/4`,
`dm_conversation_keyed?/2` and `dm_conversation_rows?/1` had zero callers
outside `NickMigration` — measured with `mix xref trace` over every file that
calls the three modules (positive control: `DmConversations.get/3` from
`read_cursor.ex`, found) plus a local-call grep inside each defining module
(positive control: `by_nick`, found). The dual write, the schema and the wire
field are untouched: they are #1365's other legs, held on #1626.
`QueryWindows.broadcast_windows_list/2` was public only for the rename's
"fully applied" barrier and is now private.

**What the price includes, so nobody rediscovers it as a bug.** The old self
window now reads as a query with a peer bearing our old nick, so whoever takes
that nick next lands in it. And `Push.Triggers.own_row?/2` reads `sender` as
the live identity, so a self row written under the old nick stops counting as
ours: an unread one counts as an inbound DM unless it is muted (the mute stays
on the old key, and that is the key the row resolves to). Outbound DMs to
peers already behaved this way before this change — nothing ever migrated
their `sender`.
<!-- entry #1365f -->

---

## 2026-10-01 — #1365f: of cic's four rename mirrors, three were never caches — the rail WHOIS is, and is copied

**The licence and the criterion.** vjt, relayed from IRC #grappa at 23:00
Europe/Rome (not seen first-hand): «non e' un prb modificare cic» and «se la
cache non serve si puo togliere, se serve la lasciamo». The first is the
licence to touch cic; the second hands the decision on the four #373 mirrors to
a technical criterion — does the cache serve once the server migrates nothing?
The reason each one goes or stays is the invariant below, not the licence.

**Why three go.** `subscribe.ts` on main said it in its own comment: the
mirrors were the client half of a migration whose server half renamed the
`query_windows` row. With the server writing nothing on a NICK:

- `renameScrollbackKey` would file rows under the new nick that the server
  never returns for that key (they keep `dm_with` = the old nick);
- `renameReadCursorChannel` would move a cursor the server keeps at the old
  key — read state is server-owned;
- `followQueryNick` would select a window absent from `query_windows_list`,
  and its only non-originating form, `openQueryWindowState`, is a database
  write caused by a nick change, which the ruling forbids. The 401 it used to
  avoid is the accepted price.

Each would make cic originate state.

**Why the rail WHOIS stays, and as a COPY.** It is a cache of the server's own
`whois_bundle` replies about a person, not window state, and it serves without
any server migration: the renamed peer's new window puts the card on screen,
and without the entry the rail asks upstream again, which a +y peer is told
about. Measured in `subscribe.test.ts` by counting `pushWhois` calls over the
P → P2 round trip on both windows (positive control inside the test: an
unknown nick costs exactly one): with the mirror removed, 1 WHOIS, on P2; with
the old MOVE, 1 WHOIS, on P, which nobody holds any more; with COPY, 0 and 0.
COPY wins both cells, so there is nothing to balance. 307 RPL_WHOISREGNICK is
still dropped from the copy (identified for that nick, not the person); an
unanswered ask is not copied, and an entry already under the new nick wins.

**What the mutant said.** COPY → MOVE killed 2 tests, both written or rewritten
in this slice: no assert that predates it depended on the behaviour.
<!-- entry #1365g -->

---

## 2026-10-02 — #1365g: dm_conversations goes, and dm_conversation_id leaves the wire (protocol 37)

**Ruling, RELAYED and not seen first-hand.** vjt on IRC #grappa, relayed by a
peer: 2026-10-02 00:01Z "levalo" to the question "oggi non serve a nulla, su
main il server lo manda ma cicchetto non lo legge, era per la leg 3 (DM per id
invece che per nick); se la leg 3 non si fa si puo' togliere, lo togliamo?".
The scope ruling of 2026-10-01 (comment 5934112501, also relayed) is the
premise: a nick change writes nothing to the DB, so nothing has to outlive a
nick, and leg 3 (DM windows keyed by id) has no reason to exist.

**What goes, together.** The table and its writers (C5): `Grappa.DmConversations`
and its schema, the dual write in `Scrollback.persist_event/1`,
`QueryWindows.open/4`/`close/4` and `ReadCursor`'s cursor insert, the FK fields
on `Message` and `Cursor`, the virtual field on `Window`. And the wire field
(C6): `dm_conversation_id` off `Scrollback.Wire.t` and
`QueryWindows.Wire.windows_entry`. Doing C5 alone would have left a field
naming rows that no longer exist; doing C6 alone, a table written forever for
nobody.

**The #1626 bar, item by item.** (a) A ruling: the one above, relayed.
(b) The break MEASURED on the real client, before the cic regeneration: a
scratch vitest against the generated schema at protocol 36 — the key in the
optional set `q` of both shapes — had `validate/2` ACCEPT a scrollback row and
a `query_windows_list` entry without it, and REJECT the same payloads without a
required key (`sender`, `target_nick`) as the positive control, 6 of 6.
origin/main's schema (35) carries the same optional set; v1.5.11, the last
tag, never had the key. No existing bundle stops validating, so
`min_protocol_version` stays at 1. (c) The shape moved, so the number moved:
`wire_pin --check` went red on the digest (and on 36 → 37) before the re-pin.

**The migrations are DELETED, not undone.** No release tag contains
`…001416_create_dm_conversations` or `…001417_backfill_dm_conversations`
(`git tag --contains` is empty; v1.5.11 is from 2026-09-27). That is
consistent with "never deployed" and does not prove it. Keeping them and
adding a plain drop would have made a database that never ran them build a
partial index over every `messages` row, run the backfill, then rewrite
`messages` again with `DROP COLUMN`, under the write lock, for a shape that
ends up gone. Instead one generated migration,
`20261002001215_drop_dm_conversations`, is CONDITIONAL: `DROP INDEX IF
EXISTS`, `DROP COLUMN` only where `pragma_table_info` sees the column,
`DROP TABLE IF EXISTS`. On a database that applied the pair (dev and test
databases that ran main since 2026-09-29) it removes everything and keeps the
child rows; on one that did not, every statement finds nothing. A version in
`schema_migrations` with no file is reported, not refused, by
`Deploy.MigrationAudit`. Deploy class: COLD (a new migration file).

**Measured on SQLite 3.53.3: indexes before columns.** `ALTER TABLE … DROP
COLUMN` on a column a partial index still names fails with `error in index …
after drop column`; with the index gone it succeeds even though the column
carries `REFERENCES dm_conversations(id)`. The deleted create migration's
`down/0` already had that order; it had simply never run.

**Shared test database.** `runtime/grappa_test.db` comes from the main
checkout's bind and is shared by every worktree; running this drop there
would leave main's code writing a column that no longer exists, under a
version already marked applied. Every gate of this slice ran under
`GRAPPA_CACHE_ID=w1-1365` (own `_build`, `deps`, PLT and test partition).
After the merge the same drop cleans each shared database the first time it
migrates.

**Caveat, by design: orphan versions stay in `schema_migrations`.** A
database that applied the deleted pair keeps `20260929001416` and
`20260929001417` in `schema_migrations` with no file behind them; the drop
removes the schema, not those rows. Nothing breaks: Ecto's pending filter
keys on the VERSION and an orphan joins no set, and
`Deploy.MigrationAudit` reports it as `applied_without_file` without
refusing. It is a divergence between `schema_migrations` and the tree that a
future reader should read as this, not as a defect. Measured on this host,
read-only, 2026-10-02 00:22Z: 2 of 55 local databases carry the pair, the
shared `runtime/grappa_dev.db` and `runtime/grappa_test.db`; the isolated
test database of this slice never had them.

**At rebase: re-check the stamp.** `20261002001215` is past every version on
origin/main as of 2026-10-02 00:12Z (`20260929001417`). If a migration lands
first with a higher stamp, regenerate this one past it, or two files can
end up claiming one version.

**The first #1626 condition, which the paragraph above skipped.** "The field
stands between the server and a property it cannot otherwise have" holds
here by ARGUMENT, not measurement: the id names a `dm_conversations` row, so
emitting it means keeping that table and writing it on every persisted DM
row, window open and close, and new DM cursor. The property bought back is
the one the issue 1365 ruling asks for, a DM write that touches only the
row and no identity a nick has to keep true. The ruling's own stated ground
was narrower ("oggi non serve a nulla"); whether "unused" alone clears the
bar is vjt's to say.

**Production's state is the one that is not known.** No tag contains the
deleted pair, but production pulls origin/main. If it ran main between
2026-09-29 and this change, the drop takes its costly branch there: `DROP
COLUMN` rewrites `messages` (~5.2M rows) under the write lock during the cold
deploy. Probe before deploying, read-only: `SELECT version FROM
schema_migrations WHERE version IN (20260929001416, 20260929001417)`; empty
means the run is a no-op.

**After the merge, worktrees branched before it break on the shared
databases.** The first migrate on the shared `runtime/grappa_{dev,test}.db`
drops the columns; a worktree whose code still declares `field
:dm_conversation_id` on `Message` and `Cursor` then selects a column that no
longer exists, and every message or cursor query there fails until it
rebases (or runs under its own `GRAPPA_CACHE_ID`).
<!-- entry #2338 -->

---

## 2026-10-02 — #2338: shottino files an inbound DM under `dm_with`, and keeps the old derivation only as a fallback

shottino decided an inbound DM's window by re-deriving it from
`channel == own nick`. Issue 1365's ruling — a nick change writes NOTHING
to the database (comment 5934112501 on issue 1365, relayed from IRC, not
read first-hand) — made that derivation permanently wrong after our first
`/nick`: every row stored before the rename keeps our OLD nick as its
channel, the predicate is false for all of them, and nothing later repairs
it, because the stored value is history by design.

The row already names the peer. `dm_with` (on every scrollback row since
protocol 36) is the peer on both halves of a conversation and is the one DM
fact a rename never rewrites, so `render_message` files a row under its
`dm_with` whenever that differs from the row's channel. A row whose
`dm_with` IS its channel — our outbound half, a note to ourselves — is
already where it belongs and opens nothing. Absent or null `dm_with`
narrows to NULL, and only then does the old `channel == own nick`
derivation run: it is the fallback for a server below protocol 36, right
until our first rename, which is all such a server can say.

The live DM listener (`ws_sync_dm_listeners`) is unchanged and correct: it
subscribes the CURRENT own-nick topic, and a DM arriving now is stored at
the nick we hold now. The rename only strands rows already stored.

**Apply:** a client deciding "whose conversation is this row?" reads
`dm_with`, never a comparison against the live nick. Any column that holds
"our nick at receipt" is history after issue 1365, and a predicate that
compares it with the live nick goes false at the first rename and stays
false. Keep such a derivation only behind the field's absence, for a server
that predates it.
<!-- entry #2343 -->

---

## 2026-10-08 — #2343: the upload confirm asks "Shrink videos before sending" per batch, and does not write it back

The transcode switch lived only in Settings (device-local, default OFF since
#2173), so an operator who never opened the drawer sent a 12.3 Mbps 1080p
HEVC clip untouched without knowing the switch existed. The upload confirm
already asks one per-batch term, the TTL (#2094); it now asks this one
beside it. Proposed on #grappa, approved by vjt on the issue.

**The confirm store gains ONE on/off term, `ConfirmToggle`, and no more.**
#2094 wrote "deliberately ONE choice — a second control would be a form
wearing a modal's chrome". vjt's approval narrows that to one choice and at
most one switch; a caller that needs more still needs a form. Every
`ConfirmRequest` declares `toggle` explicitly (`null` on the ten dialogs
that ask nothing), the same explicit-null contract as `choice`.

**Shown only while the batch holds a video**, reactively: removing the last
clip from the list removes the switch, since it does nothing to any other
category. "Video" is the dispatch's own `categoryOf(baseMime(type))`, so the
dialog and the pipeline cannot disagree on what counts.

**Carried per item, like `ttlSeconds`:** `videoProcessing: boolean | null`
rides the queue and `lastAttempt`, so a retry keeps the batch's answer even
if the device preference changed in between. `null` means no dialog asked
(`upload_confirm_enabled` off) and the device preference decides at
dispatch, exactly as before. The answer is resolved once per attempt and
feeds both the transform and the over-cap refusal, whose recourse now names
where the answer was given: "Tick … when sending" for a dialog answer, "Turn
on … in Settings" otherwise. The old Settings copy was wrong advice to an
operator whose Settings already said ON.

**No write-back to the device preference — a REVERSIBLE choice, pending
vjt.** The issue left it open. Not writing back is #2094's posture for the
TTL: a tick given while looking at one batch is not a change to the device.
Reversing it is one line in the confirm's `onToggle` plus two inverted
assertions (vitest "does not write the answer back", e2e arms (a)/(b)).

**Apply:** a new per-batch upload term follows this shape: seed from the
stored preference, carry per item with `null` for "not asked", resolve once
per attempt, never write back without a ruling.
