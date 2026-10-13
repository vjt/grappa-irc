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
<!-- entry #2345 -->

---

## 2026-10-08 — #2345: the posted upload link names its TTL, from the token the host was sent

An upload posted into a channel used to be a bare `📸 https://…`; a reader
on a plain IRC client, or scrolling back later, could only learn whether
it was still live by clicking into the deliberate opaque 404. cic now
appends the TTL the upload was sent with — `📸 https://… (24h)` — and the
reader adds it to the timestamp their own client shows. Relative and not an
absolute expiry: an absolute time needs a timezone, and the message
timestamp is already local to each reader.

**The figure comes from the host token that went over the wire**
(`ttlSuffix/2` in `uploadOrchestrator.ts`), never re-derived from the
stored preference. That token already folds the three layers #2094 set up
(batch choice → preference → host default), and the embedded server
REFUSES a value off `@allowed_ttl_seconds` with a 400 instead of clamping
it, so the suffix is the deletion time the server applied. A token the
active host's ladder does not name posts the bare link: there is nothing
known to say, and a guessed figure is worse than none.

**Format:** hours, comma decimal (the requester's spelling), cut DOWN to
the tenth. Rounding up would tell a reader a dead link is still live; the
cut errs towards "already gone". Every ladder shipped today is whole hours,
so the fraction is dormant. Not decided here, deliberately: whether the
separator follows the UI locale once i18n lands.

**#2288's `[NNN]` handle** is that issue's to place, with one constraint
found here: the issue text sketches `[042] https://… (1,5h)`, but the
category emoji must stay IMMEDIATELY before the URL — `mediaLink.ts`'s
`TRAILING_EMOJI_RE` reads only the text preceding the link, and a handle
between the two would stop legacy extensionless links classifying. The TTL
suffix stays the line's last token either way.

**Apply:** the posted body is composed in cic, not the server, and nothing
server-side parses it. A consumer that extracts the upload URL from a body
must stop at the first space: the link is followed by ` (<n>h)`.
<!-- entry #2346 -->

---

## 2026-10-08 — #2346: Ban nick / Ban host / Kickban on both menus, and a hold on a nick opens the nick menu

A flapper QUIT/JOINs #grappa every ~15 minutes under a fresh Guest nick, so
the ban has to go on the host, and from a phone no ban was reachable at all:
the nick menu (`UserContextMenu`) opened only on `contextmenu`, which iOS
never sends for a hold, and its one "Ban" row banned `nick!*@*` — the mask a
new nick walks straight past. vjt's ruling on the issue: separate rows
**Ban nick** (`nick!*@*`), **Ban host** (`*!*@host`, fail-closed) and
**Kickban** (host mask, ban-then-kick); the bare "Ban" goes away; on both the
nick menu and the join/part/quit rows.

**One verb, three doors.** `/kb`'s body moved to `lib/kickban.ts`
(`banHost` / `kickban`), and `kbCommand` is now a caller of it. The one
addition is `knownHost`: a join/part/quit row already carries the sender's
host in `meta.sender_host` (the "not measured" question on the issue — it
does, and the row has rendered it as `[user@host]` since the presence-meta
work), and for a QUIT that is the only host there is. A known host is used
verbatim by **Ban host**; `null` falls back to `/kb`'s on-demand
`resolveUserhost`. **Kickban takes no known host and always resolves**: it
kicks whoever holds the nick NOW, and a row's host names whoever held it when
the row was written — on a recycled Guest nick, a different person, so
row-host-plus-kick would ban one person and kick another (caught in review).
The three rows themselves come from ONE builder, `lib/opsMenu.ts`
`banMenuItems`, used by the nick menu and by the message menu on a presence
row, so the two doors cannot disagree on a mask, a label or a gate.

**Kickban is gated on presence, not on row kind.** Disabled (never hidden)
unless the nick is in the channel's members store: a quit row's nick is
gone, but a flapper who has since rejoined is present again, and a gate on
"is this a quit row" would get that case wrong. Ban nick / Ban host stay
enabled for an op either way.

**Kickban with an unknown host behaves like `/kb`**: no ban, the kick still
fires, the ban error surfaces. Menu failures — that, a Ban host miss, or any
rejected op push — go to a toast (`opsMenuToasts`, on the one toast surface),
because the menu has closed by the time the push settles. Before this, a
rejected Op/Kick from the nick menu was an unhandled rejection and nothing
else; all the op rows now go through `runOpsVerb`.

**The long-press delivers the nick's own `contextmenu`, it opens nothing
itself** (`lib/nickLongPress.ts`). Android already turns a hold into a
`contextmenu`; iOS does not, so after a stationary hold the binder dispatches
that event on the nick and the handlers that already answer a right-click
open the menu — one door, so the menu cannot differ by opener, and the
members pane and the scrollback only had to bind it. It stands down if the
platform sends its own `contextmenu` mid-hold (no double open on Android),
and it swallows the release, without which the synthesized click on the nick
opens a query window and closes the menu. That shield is pinned only as
`defaultPrevented` in the unit test: the e2e's in-page TouchEvents are
untrusted and Chromium never synthesizes a click from them, so no e2e
assertion there could fail — whether WebKit honours it is the issue 1956
question, still open. It lives beside
`bindMessageGestures` rather than inside it: that binder excludes inline
controls (the nick among them) precisely so a hold on a nick never opens the
MESSAGE menu, and that excluded space is exactly what this one occupies.

**Ban rows on the message menu appear on join/part/quit rows only**, in
channel windows only. That is the issue's scope; a privmsg row's sender is a
person too, and offering the rows there (host by lookup) is a one-line
widening of `presenceBanTarget` if wanted.

**Not device-verified.** The e2e drives Chromium with `hasTouch` and proves
the wiring and the wire (the peer receives the MODE/KICK); that iOS sends no
`contextmenu` for the hold and that the hold feels right is on-device
dogfood.
<!-- entry #2323 -->

---

## 2026-10-08 — issue 2323: a kicked or failed window comes back after a reload

**Problem.** vjt was kicked from #grappa and the channel disappeared from his
desktop sidebar. The intended behaviour was already written down: a `kicked`
window stays as a greyed row until its × or a rejoin.

**Gap found (by reading the code; not reproduced against prod).** A KICK, like
a refused JOIN, takes the channel out of the live keyset. Unless autojoin lists
it, `GET /channels` stops listing it too, so the row exists only in cic's
in-memory `windowStateByChannel`. The live `kicked` / `join_failed` event goes
out on the user topic once. After a reload (or a backgrounded PWA) cic
subscribes per channel only to channels it already knows about, so the
per-channel snapshot (`WindowState.to_wire/3`) that would restore the state
never runs. The server still holds the window as `:kicked` and nothing on
screen shows it. This is #482's gap, on the two terminal not-joined states.

**Fix.** `WindowState.rejected_windows/2` lists every `:kicked` and `:failed`
window. It builds each payload through `to_wire/3`, so it is exactly the
expression the live broadcast and the per-channel snapshot use (CP15 B7). It
rides the existing `Session.session_snapshot/2` call, so the login hot path
gets no extra round-trip (#482's measured cost), and `push_session_snapshot/2`
pushes the payloads on the user topic. Unlike `:invited` these kinds are legal
on both topics, so a separate twin projection is unnecessary. The wire shape
does not change: no new kinds, no new fields.

`:failed` is included on purpose. It is the same hole for the same reason, and
fixing only `:kicked` would leave a refused JOIN to evaporate on reload.

**Measured on the e2e stack.** Without the fix, the live path (kick → rejoin →
kick, with the second kick landing on an unselected window) is GREEN and the
reload witness is RED. With the fix, both are green. So the live path is not
where the row goes missing.

**Not established.** Whether vjt's client reloaded between the kick and the
report. If it did not, the vanishing has a second cause that this entry does
not cover.

**Test gotcha.** A rejoin cannot be gated on a self-JOIN scrollback line,
because the first join's line already matches. "Not greyed" is not a gate
either, because a `pending` row is not greyed. The rejoin's JOIN sat ~2s in
the send bucket, the stale gate passed, and the next KICK hit a channel the
session was not in. Gate on the live (non-pseudo) row plus the member list.
<!-- entry #2347 -->

---

## 2026-10-08 — #2347: the default ban type is a per-user setting, stored on the server

**Ask (Mezmerize, ruled «va bene accoda» by vjt, 2026-10-06):** a setting
that picks the ban type `/kb` and the Kickban menu entry send — `nick`
(`nick!*@*`), `host` (`*!*@host`) or `user_host` (`*!user@host`). The fixed
Ban nick / Ban host entries #2346 added keep their own form. Fail-closed
stays: a form whose component is unknown sends no ban, and the kick still
fires.

**Where it lives — a new `user_settings.data` key `"ban_mask_form"`, not
`localStorage` (orchestrator ruling, Fork 2 = A).** Every per-user setting
already lives server-side under its own key with its own
`/me/settings/<key>` door, and a ban type picked on the desktop should be
the one `/kb` uses from the phone. The door is REST get/put only, the
`upload_confirm_enabled` shape (v11): the client reads the value when it
composes the ban and nothing on the server acts on it, so a live push
(the #1894 shape) would buy a mirror nobody needs and one more kind for
shottino to learn.

**Shape.** The context speaks atoms (`:nick | :host | :user_host`), the
wire speaks the strings cic's `BanMaskForm` already uses; the closed set
is spelled once, as a map, so a user-controlled string never becomes an
atom by `String.to_existing_atom/1` ("an atom that exists" is a wider set
than this one). The default `"host"` DELETES the key — one spelling for
the default in storage — and a stored value outside the set reads back as
`:host`, because an unknown value must not turn into a wider or narrower
ban than the subject picked. A missing body key is a 400; every value
outside the set, `null` included, is a 422 on `field_errors.ban_mask_form`,
checked once in the context rather than twice.

**Protocol 38.** Bumped on the #1393d rule. Unlike v11, `wire_pin` sees this
change: since #2037 the digest spans the JSON views' `@spec`s, and
`ban_mask_form_response` is one. `@min_protocol_version` and cic's
`MIN_SERVER_PROTOCOL_VERSION` stay put: a pre-38 server 404s the read and
cic falls back to `"host"`, which is what `/kb` sent before.

**The client half.** `kickban` takes the form as a PARAMETER and never
reads the cache itself, so the verb stays a function of its inputs and the
unit tests pin every form without a store. `nick` asks the server nothing;
`user_host` keeps the `user` that `resolveUserhost` already returned and
`/kb` used to drop; a missing component is still fail-closed and the error
names which one (`host` / `user@host`). The cache is `lib/banMaskPref` (the
`uploadOrchestrator` shape): loaded at boot in `Shell` and on drawer open,
written through on change, and read by `/kb` and the Kickban row at SEND
time — a change made with the menu open still applies. A wire value off
the closed set reads as `"host"`: a form this bundle cannot build must not
become another ban. The drawer select is put back by hand on a refused
save, because Solid does not re-assign a `value` whose signal never moved.
<!-- entry #2359 -->

---

## 2026-10-09 — issue 2359: the auto-away site default is an admin knob, and the user sees its value

**The report.** A self-hoster: Settings → auto-away offered `use site
default` with no value behind it, and the default itself could only move by
editing app config and restarting. #348 left the label bare on purpose —
cic could not know the server constant, and a copy would go stale.

**What changed.** `auto_away.default_debounce_seconds` is a `ServerSettings`
key on the upload-limit machinery (Admin → Settings, `server_settings_changed`
fan-out). The server ships the RESOLVED value on every door
(`GET /api/server-settings`, after-join snapshot, push), so the drawer
reads `use site default (10 minutes)` / `(off)` off `serverSettings()` and
re-labels live. That retires #348's reason for the bare label instead of
contradicting it: the number still is never a copy kept in cic.

**Encoding: seconds, `0` = off** — the per-subject
`auto_away_debounce_seconds` encoding, because it is the same fact. The
ladder `[0, 60, 300, 600, 1800, 3600]` is the user presets plus off, a
closed set guarded in `put_auto_away_default_seconds/1` and turned into a
422 at the controller, like every sibling key. No per-key changeset: none
of the siblings has one, and a second validation pattern in one module is
the thing CLAUDE.md's consistency rule exists to stop. The generated admin
wire type says `non_neg_integer() | nil`, not the literal ladder, because
the codegen renders no integer literals; the closed set lives in the
context.

**No row = the boot fallback, and `PUT null` deletes the row.** "The
app-config value stays the boot fallback" is only true if the admin can get
back to it; without the delete, the first save would make the config value
dead for good. The admin view therefore carries the STORED value next to
the fallback, so the select's "server config (N)" entry names what it
stands for.

**The fallback seam moved from `Session.Server` to `ServerSettings`.**
`public_view/0` must ship the resolved value and Session must resolve
against it; leaving the seam in Session would make ServerSettings depend
on Session while Session depends on ServerSettings — a Boundary cycle. The
config key is read at its OLD path,
`config :grappa, Grappa.Session.Server, auto_away_debounce_ms:`, so an
operator who set it keeps the value they set. `boot/1` now takes the
keyword list (the `Uploads.boot/1` shape), which leaves `application.ex`
as the only env reader and makes the seam testable without `put_env`. A
non-positive value raises at boot: the fallback is rendered in whole
seconds with `ceil`, and a `0` would read as "off". `init/1`'s own default
stays the BOOT value, not the resolver — the resolver reads the DB and
`init/1` re-runs on every `:transient` respawn.

**One resolver, both doors.** `Session.Server.resolve_auto_away_debounce(nil)`
reads `ServerSettings.auto_away_default_ms/0`. That covers the spawn
boundary and the live preference refresh, so a user who goes back to "use
site default" on a running session gets the CURRENT site value (tested).
Whether an admin change also reaches sessions that are ALREADY running
was left to a ruling; it came back "live" — see the addendum below.

**Client tolerance.** The narrower degrades an absent or malformed value to
`null` (bare label) instead of dropping the push, declared on both widening
registries; strict would oblige `MIN_SERVER_PROTOCOL_VERSION` to 39 over a
label. Protocol 39, the four version sites bumped together.
<!-- entry #2359b -->

---

## 2026-10-09 — issue 2359b: an admin change of the site default reaches running sessions

**Ruling: LIVE.** A session that follows the site default follows an admin
change while it runs; a session whose user set an explicit delay is not
touched. **Provenance, stated as it reached this branch:** vjt handed the
question to Lucy ("solo le nuove direi? ma chiedi a lucy", 18:29Z); Lucy
answered "live" on Azzurra `#grappa` at 19:02Z. That answer was RELAYED by
the peer session vjt-claude-9a to the orchestrator and from there to this
worker — neither the orchestrator nor the worker saw it first-hand.

**Shape.** `Grappa.Session.reapply_auto_away_site_default/0` sends a bare
`:auto_away_site_default_changed` to every pid in `Grappa.SessionRegistry`
(the `{:session, _, _}` keys). The admin controller calls it after a
SUCCESSFUL write whose body carried `auto_away.default_debounce_seconds` —
not on an upload or dcc save, and not on an error return, since `with`
never reaches it. ⚠️ The subtrees are NOT written in one transaction, so a
body pairing a valid `auto_away` with an invalid `addressing` stores the new
default and then fails: running sessions keep the old window until the next
save. Same exposure the `server_settings_changed` push has; accepted, not
fixed here. The fan-out lives in the context, not the controller
(controllers thin).

**The signal carries no value, on purpose.** What a session should wait is
its subject's preference resolved over the site default, and only the
session reads its subject's preference; shipping the site value would make
every session re-derive "do I follow it?" from a second copy of the rule.
Each session runs the existing `auto_away_debounce_for/1` — the spawn
door's resolver, so spawn and live refresh cannot disagree.

**Adopt only on change.** A session with its own delay resolves to the
window it already holds, and `apply_auto_away_debounce/2` with even the
SAME window would cancel and re-arm an in-flight timer (#348's retune
ruling), restarting that user's wait for an admin action that was never
about them. The handler compares first. A session that DOES move with an
in-flight timer re-arms at the new window from the moment of the change —
#348's semantics, unchanged.

**Costs accepted.** One preference read per live session per admin
`auto_away` save — rare, admin-only, the same read the spawn door makes.

**🔴 Known gap, NOT closed here: a `:transient` restart reverts the
window.** `start_session/3` resolves the window ONCE into the child spec,
and `DynamicSupervisor` restarts a crashed session with that same spec —
it never passes through `start_session/3` again, and `init/1` deliberately
takes the opt rather than reading the DB. So a session that adopted a new
site default and later crashes comes back on the window of its ORIGINAL
spawn, until the next admin save or a full stop/start. Found in review, not
in the field. It predates this entry: #348's live PREFERENCE refresh has
the identical revert. The cure (re-resolve in `init/1`, or read the window
lazily) changes a posture the `init/1` comment defends and touches #348, so
it is left to a ruling rather than taken inside this slice.

**No wire change.** Nothing new is emitted to clients; the
`server_settings_changed` push already carried the resolved default. The
label-ahead-of-session gap this entry's parent recorded is closed for every
running session that follows the default — except one that has been
restarted by its supervisor since (the gap above).
<!-- entry #2366 -->

---

## 2026-10-10 — issue 2366: a CTCP ACTION renders as `* sender text` on the push door

**Decision.** `Push.Payload.build/2` renders an `:action` row's body as
`* <sender> <text>` — the emote cic shows — and only then applies the
#1977 `plain_text/1` projection. The frame is removed by
`CTCP.action_text/1`, next to `action?/1` and `verb_args/1`. Push does not
get a second CTCP parser. The stored row keeps `\x01ACTION …\x01`, per the
wire-format rule. This is a projection at the door, like 1977.

**Why the sender is repeated under a DM title.** A DM banner's title is
already the sender, so `alice` / `* alice waves` repeats the nick. That is
deliberate: the body then reads the same on every surface, in-app and
lock screen, DM and channel, and the bare text alone (`waves`) is not
recognisably an emote. Every OTHER CTCP frame still reaches the payload
framed, because only ACTION is conversation.

**Measured, not fixed here.** `Grappa.Mentions.body_matches?/2` (push,
sidebar badge, away bundle) matches against `plain_text(body)` with the
frame still on. A real nick still matches, because `\x01` is not `\w`.
But the matchers are caseless, so a highlight pattern `action` (or a nick
`Action`) fires on every `/me`. That door is left to a ruling.
<!-- entry #2372 -->

---

## 2026-10-11 — #2372: time cursors on the scrollback read

**What.** `GET …/messages` takes `before_time` / `after_time` /
`around_time` beside the id cursors, through the new
`Scrollback.fetch_by_time/7`. bicchierino needs them to answer IRCv3
`draft/chathistory` `timestamp=` selectors: it measured every such selector
coming back as an empty batch, because grappa could only take a row id. The
contract was agreed with the consumer before any code was written:
`docs/CLIENT_PROTOCOL.md` §5i, protocol 40.

**One value format, epoch ms.** It is the unit every row's `server_time`
already carries on this wire. Accepting ISO-8601 as well would double the
validation surface (offsets, fractional precision, `Z`) to save the client
a conversion it already does in the opposite direction, when it renders
`time=` tags. Bounded at int64 max, because past it the bind fails inside
exqlite and the request gets a 500 instead of a 400.

**The sort key is the filter key, again.** Issue 2228 moved `fetch/7` to
sort on `id` because its filter is on `id`: when filter and sort disagree,
a row is lost rather than reordered. A time cursor filters on `server_time`,
so it sorts on `(server_time, id)`, with `id` breaking the tie inside one
millisecond. The bound is strict and applies to `server_time` alone, so a
tie at the bound is excluded by both directions. That is the chathistory
semantics, not something we chose; the paging advice to clients (first
query by time, the following ones by id) follows from it. The property
test in `scrollback_test.exs` compares the door against a reference that
states this contract as data, over random times, ties and bounds.

**Cost: channel windows are served by the existing index, DM windows are not, and that is accepted.**
A channel window seeks `messages_<subject>_id_network_id_channel_server_time_index`.
`id` is the rowid SQLite appends to every index entry, so
`(server_time, id)` is already the index order: the plan reads
`SEARCH … USING INDEX …channel_server_time_index`, with no
`TEMP B-TREE` (pinned for both subject kinds). A DM window has no
`server_time` on its folded-COALESCE index. Measured plan:

    SEARCH m0 USING INDEX messages_user_id_network_id_dm_coalesce_fold_id_kind_index (user_id=? AND network_id=? AND <expr>=?)
    USE TEMP B-TREE FOR ORDER BY

It reads every row of that ONE conversation, in table order, and sorts
them. The cost is linear in the conversation and never in the network.
**No new index**: the orchestrator ruled it (not vjt, who can reverse it),
because an index means a migration and a schema cost paid on every write,
forever, for a case with no measured pain; DMs are small. What is pinned
is the bound: the DM plan must seek the folded index and must never fall
back to `messages_network_id_index`.

**Detection is mandatory, not an optimisation.** A server before 40
ignores the unknown param and answers the LATEST page with a 200. A client
that skips the `protocol_version >= 40` check gets wrong rows with no
error. That is why the bump carries the rule here even though
`wire_pin`'s digest did not move: these are request params, no
`*JSON` spec changed.

**Refactor that came with it.** The four history reads (`fetch`,
`fetch_after`, `fetch_around`, `fetch_by_time`) and `count_after` now start
from one private `window_query/5` (subject, network, channel-or-DM,
presence), so they cannot disagree about which rows a window holds.
<!-- entry #2370 -->

---

## 2026-10-11 — issue 2370: a failed or stuck upstream write costs the caller, not the session

**Decision.** `Client.send_line/2` catches the `{:timeout, _}` exit of its
`GenServer.call`, and ONLY that one, and answers `{:error, :timeout}`.
Every case site in `Session.Server` that matched only `:ok` and
`:invalid_line` (privmsg and notice after the persist, the two
service-target sends, PONG) now hands any other `{:error, _}` back to its
caller and logs it. Before this, either path took the whole session down
over one write: the exit propagated, or the unmatched tuple raised
`CaseClauseError`, and the supervisor restarted the session with `client:
nil`. Every send in the respawn window then hit the second hole, and that
is the double crash the issue reports.

**`:timeout` means delivery UNKNOWN, not "not sent".** The frame stays in
the Client's mailbox and reaches the wire once the Client runs again. A test
pins this. So the after-persist warning has two wordings: `not sent` for a
transport error, `delivery unknown` for a timeout. A dead Client still exits
the caller. That is pinned too: the link carries the death to the session
anyway, and calling it a stall would misname it. Catching the timeout also
keeps the frame out of the exit reason, which for `OPER` carried the
password (#961).

**Declared choice, reversible on its own: with `client: nil` the four
persisting sends (privmsg, ctcp, notice, statusmsg) are refused BEFORE the
persist** (`{:error, :no_socket}`, no row). There is nothing to write to,
so a row would be a line the operator reads as sent that never left. The
alternative was to keep persist-then-send and leave the row. A write that
fails AFTER the persist still keeps its row, because on `:timeout` the frame
may still go out and deleting it would be wrong as often as keeping it.

**`send_join` gets its own `:timeout` arm.** Its catch-all reads any other
transport error as "link down, reply `not_connected`", which is false for a
timeout. The JOIN answers `:timeout` (504) and records nothing. If the frame
does go out, its echo opens the window like any other JOIN echo does.

**REST door.** Once these errors travel as values, `:no_socket` / `:closed`
reach `FallbackController`, which had no clause for them and raised a
bodyless 500. They now map to the existing `upstream_unreachable` (502).
That adds no wire token and needs no protocol bump. The open `:inet.posix()`
half of `Session.send_transport_error/0` stays unmapped: no guard names it
without catching unrelated atoms.

**Accepted, not changed.** The REST → session and session → Client
deadlines are both 5 s and nested, so a REST caller always gives up first
and reads `:timeout` from its own call. The session's answer goes nowhere
(OTP drops the late reply). The tests pay that 5 s in wall clock. No
injectable deadline was added to production for them.

**Out of this slice.** The nick lost across the crash is won't-fix (vjt's
ruling on the issue). Why the Client stalled ≥5 s and who sent the second
and third copies were not measured, and this entry claims neither.
<!-- entry #2371 -->

---

## 2026-10-11 — #2371: a NickServ secret for another nick never lands in a user credential

**The bug.** A user session's credential holds ONE nick and ONE NickServ
password. REGISTER and SET PASSWD carry no nick: services act on the nick
WORN when the line arrives. A user wearing B who registered B had B's
password staged, committed at `+r` by `commit_user_registration/3`, and
written next to nick A; the next reconnect IDENTIFYed A with B's password.
SET PASSWD (optimistic on-send, #131) had the same hole by construction:
`commit_set_passwd/2` rotated the stored secret whatever nick was worn.

**The rule.** For a `{:user, _}` session, a REGISTER is staged and a SET
PASSWD is committed only while the worn nick folds equal to
`configured_nick/1` (`wearing_configured_nick?/1`, via `fold_key/2`, never
`==`). The `+r` commit checks the same thing again on the nick holding the
new `+r`: a REGISTER staged under A, then a rename to B and an IDENTIFY of
B, must not commit A's staged secret on B's `+r`, and a REGISTER of B
followed by a rename to A must not commit B's secret on A's `+r` (REGISTER
wins the tie against `pending_auth`). A `+r` the gate refuses KEEPS the
staged secret: it confirmed some other account, and A's registration is
still waiting for its own `+r` — clearing it there would lose a password the
old code happened to commit correctly. This is the identity check #978
already made on RESETPASS's explicit target, now one helper
(`configured_nick?/2`) for all three on-send/`+r` writers of the user
credential. A refused capture logs at `info` naming the nick, never the
secret.

**Two bounds, reported by review and not measured.** (1) The gate reads
`state.nick`, which at 001 is still the REQUESTED nick until EventRouter
reconciles the welcome, so a SET PASSWD in the perform list on a 433
fallback compares the configured nick against itself and passes. (2)
`configured_nick/1` falls back to `state.nick` for a process predating
#885, which makes every check pass; v1.5.13 deploys COLD, so no such
process survives it.

**Visitors are deliberately untouched.** A visitor's `+r` goes through
`Visitors.commit_identity/4`, which writes the password AND the nick held at
`+r`, so the pair moves together; the user check would be wrong there too,
since a visitor's `configured_nick` is the nick at session start and goes
stale once `commit_identity/4` rebinds it. **Known gap, not fixed here:**
when the nick half of `commit_identity/4` fails (a folded-nick collision,
logged as a warning) the password is still committed, so the visitor pair can
drift the same way. Changing that is a visitor-semantics decision and was
not taken in this slice.
<!-- entry #2377 -->

---

## 2026-10-11 — #2377: a queued divider jump yields to the send that revoked it

**Report.** vjt, 23:21: marker on screen, send, the divider collapses and
the sent row sits under the compose — the third return of the family after
#168 and #2031.

**What was measured, not assumed.** On `f09882cd5` the #2031 spec runs in
CI and is green there. Locally it went red ONCE in twelve webkit runs (zero
in six chromium): pane 91px short, row wholly below the fold, and the only
scroll write after enter was `scrollIntoView({block:"start"})` on the
divider at +39ms. That is the deferred rAF×2 leg of a marker activation —
queued under the #168 latch BEFORE the send, run AFTER it. The send had
already revoked the latch (`setMarkerActivationPending(false)`, follow
armed), but `scrollToActivation`'s deferred body never re-read it: it
jumped to the far divider and set `followMode` from that distance, i.e.
off, so the sent row that landed next was not followed and the divider's
collapse left the pane where it was. Not introduced by any of the commits
the issue suspected: the body before #2333 read the divider node just as
ungated. It is a race whose rate moves with timing, which is also why no
bisect was run — every candidate carries it.

**Why the existing spec could not hold it.** Two conditions must meet: a
rows change under the armed latch within two frames of enter (a peer line
does it), and the POST resolving AFTER those two frames — a collapse inside
them sends the leg to the tail, which hides the defect. Local POSTs are
fast, a phone's never are. The new forced case builds both: a
MutationObserver presses enter in the microtask after the peer line's
commit, and the POST response is held 400ms. On the untouched tree it is
red 3 of 3 on chromium, twice, and 0 of 3 on webkit (why webkit escapes is
not known — the webkit case is a guard, not a reproduction); the regression
cases also assert the sent row's box against the pane's
box on BOTH edges, never a distance against `SCROLL_BOTTOM_THRESHOLD_PX`.

**The rule.** A deferred write scheduled under a latch re-checks the latch
when it runs, exactly as the tail-follow poll re-checks `followMode()`
every frame. Everything that clears `markerActivationPending` — an own
send, operator input, the scroll-to-bottom gesture, a mention jump — is a
newer authority, and a "marker-or-tail" leg that finds it cleared writes
nothing (it still reveals a hidden pane). The reported at-the-tail shape
(divider near the tail) was measured too and did not reproduce (0 of 7
webkit, 0 of 2 chromium): read from the code, a near divider sets
`followMode` from a distance under the threshold, i.e. on, so the sent row
is still followed. The case is kept as a guard.
<!-- entry #2375 -->

---

## 2026-10-11 — issue 2375: the services prompt — focus, completion, focus trap, textarea

Four defects in the services console prompt (`ServiceModal.tsx`), one
issue, reported by vjt on the iOS PWA.

**Focus on open.** The prompt had no ref and no focus call. It is focused
in `onMount` inside the keyed `Show`, so a second service replacing the
first re-focuses too. **Unmeasured on iOS:** WebKit raises the on-screen
keyboard for a programmatic focus only inside a user gesture, and whether
the compose Enter / send tap that opened the modal still counts is not
known. The worst case is the old one tap.

**One completion engine, two doors (vjt's ruling, item 2 = B).** The
matcher lived inside `compose.ts` as a closure over the compose cycle and
wrote the compose draft itself, so only the compose box could reach it.
`lib/tabCompletion.tabCompleteStep` is the same matcher moved intact and
made pure with respect to the draft: the cycle goes in as an argument and
comes back with the step, and each door writes the result where its own
draft lives. `compose.tabComplete` stays as the compose door (the #737
drain refusal, its cycle, `writeState`) with its old signature, so the
existing completion tests did not change. The 20% that differs between
the doors is one flag, `addressee`: a line-start nick gets `: ` in the
composer and a plain space in the services prompt, whose line opens with
a command (`INFO vjt`). The modal's candidates come from a KEY like the
composer's: the window selected behind the modal when it is on the
modal's network, else `$server` (no members, so channels only), read at
Tab time. `compose.sigilsFor` moved to `casemapping.ts` as
`chantypesForSlug`, the module that already owns the slug → id hop.
**Not done: the swipe-right door.** On a phone the composer completes on
swipe-right (#2356); the modal has Tab only, so on an iPhone without a
hardware keyboard the completion is still unreachable there. The swipe
recogniser is ~120 lines of state inside `ComposeBox`, and sharing it is
a separate decision.

**Focus trap.** `aria-modal` informs assistive tech and does not stop the
browser's Tab traversal. The modal is mounted BEFORE the compose box in
Shell's DOM, so Tab walked onto the covered page, and a printable key that
landed on a button there was redirected into the compose box behind the
scrim by the irssi auto-focus (`lib/keybindings`). `lib/focusTrap.trapTabKey`
wraps only the two edges and leaves a Tab an inner surface already
prevented alone, which is the prompt's case now that it completes. **Only
this modal is enrolled.** The other modals share the defect; enrolling them
is a follow-up, not a rider on this issue. The trap is not the cause,
though, and the review said so: the auto-focus never asked whether the
compose box was covered, so a click on the modal's message area (focusing
the dialog itself) or on a link, then a letter, still typed behind the
scrim. It now asks `overlayCount() === 0`, the question `lib/globalPaste`
already asks of a paste, and that fixes it for every covering modal.
Accepted, as at the composer: Tab and Shift+Tab are always consumed by the
prompt, so the close button is out of keyboard reach from there (Esc
closes), and a Tab during an IME composition still completes (Enter is
guarded, Tab is not, at both doors).

**`<textarea rows=1>` instead of `<input type=text>` (vjt's ruling, NOT
verified on a device).** iOS offered Contacts addresses in the QuickType
bar over the input; the composer, a `<textarea rows=1>`, never shows them.
The cause is a HYPOTHESIS: Safari's AutoFill classifier lives in closed
Safari/iOS code, not in open-source WebKit, and the Playwright WebKit leg
does not run it, so nothing here can prove the textarea silences it. vjt
checks on an iPhone from staging; if the AutoFill survives, the shape was
not the trigger. A textarea keeps line breaks, so the prompt keeps the old
single-line contract by hand: every Enter sends (Shift+Enter too), an
IME-committing Enter does not, and a pasted line break becomes a space so
it cannot ride into `sendBodyLines` as a second command to the service.

**Padding.** `padding: 0.25rem 0` against an inset #96 ring
(`outline-offset: -2px`) put the caret and the first glyph on the ring;
the prompt now has `0.5rem` inline.
<!-- entry #1791b -->

---

## 2026-10-12 — #1791b: the tab row's bottom edge IS `--viewport-height`, and the reported signature has the wrong sign

An iOS 27 installed-PWA field report on this surface, with a geometry none of
the earlier ones had: returning from an app switch brings the keyboard **and
the iOS form-accessory bar** back up, the shell **does** shrink, and the bar is
drawn **over the bottom channel-tab row** rather than the buffer being pushed
off-screen. Closing and reopening the app clears it.

No cure for that is claimed here. What is established is the layout arithmetic
that makes the report readable, one defect the investigation surfaced with a
measured red, and the single on-device reading still owed.

### The four-link chain: the tab row is decided by ONE number

Nothing had written this down, and it is why "verify against the buffer" is a
false green rather than a weaker check:

```
html.is-ios { position: fixed; inset: 0 }        → html = the layout viewport
html.is-ios body { height: calc(var(--vh)*100) } → body = the written height
#root { height: 100% }                           → no height of its own
.shell-mobile { height: var(--viewport-height);
                padding-bottom: 0 }              → border-box, flush bottom
.bottom-bar                                      → last IN-FLOW child, no position
```

⇒ the tab row's bottom edge sits exactly `--viewport-height` px below the top
of the layout viewport, and the row is fully visible **iff**
`--viewport-height <= vv.offsetTop + vv.height`.

The buffer is not the same measurement. `.scrollback` lives inside
`.shell-main`, the `1fr` grid row, so it moves whenever anything redistributes
space INSIDE the shell; the tab row moves only with the shell's outer edge. A
change that restores the buffer while leaving the row governed by something
else passes a buffer check and leaves the report standing.
`cicchetto/src/__tests__/bottomTabRowEdge.test.ts` pins the chain — four
mutations, four reds, one apiece, plus a no-op negative control that stays
green.

### The report's own signature cannot produce the report's own symptom

Write `L` for the layout viewport, `K` for the keys, `B` for the accessory bar;
overlap is `--viewport-height - (vv.offsetTop + vv.height)`, with `vv.offsetTop`
taken as 0 (the report shows the top of the app visible; UX-6 D10 measured 324
on this surface, so the assumption is stated rather than assumed away).

| the var holds | overlap | what it looks like |
|---|---|---|
| `L - K - B` — the **keyboard-open** value | **0** | no defect at all |
| `L` — the keyboard-closed value | `K + B` | row behind the KEYS: the earlier reports' shape |
| `L - K` | **`B`** | **row under the accessory bar: this report's shape** |

So "a stale `--viewport-height`/`--vh` left at the keyboard-open value" — the
signature the report names — is the one value that produces NO misfit: on
resume the keyboard is up, and that value is correct. A var stale at the full
height produces the older, different shape. The only value that produces this
geometry is `L - K`: **a height that counts the keys and not the accessory bar.**

The step from the report's prose to "overlap ≈ `B`" is a reading of words, not
a measurement, and it is the one place this entry could be wrong.

### Two candidates, identical in one frame, opposite cures

Both produce `--viewport-height = L - K`:

1. **TIME** — the settle schedule reads while the bar is not yet in the number
   and latches `L - K`. A later read would give `L - K - B`.
2. **SOURCE** — `visualViewport.height` never subtracts the accessory bar on
   this iOS. No read, at any instant, will ever give `L - K - B`.

The vocabulary is this module's own, from the issue-2159 note it already
carries: *"a stale height is a value from an earlier TIME and a later re-read
cures it; those 9px are a value from a different SOURCE at the same instant,
and no schedule closes a constant offset."* Same dichotomy, `B` in place of the
9px. **If (2) holds, no schedule and no fifth trigger can help** — the cure
would not be in the writer at all.

They are indistinguishable in one frame and distinguishable in two reads. The
reading that separates them is `--vh * 100` against `vvH` **on one `DiagFloat`
line** (both are already printed, per line, since PR #1810): different ⇒ the
var is stale ⇒ TIME; equal, while the bar covers the row ⇒ the var is current
and the API is the problem ⇒ SOURCE. Note this is a different comparison from
the one the issue already asks for — `--vh` beside the window scroll offset
separates "vars stale" from "content scrolled", which is another axis.

That reading has a cheaper form that needs no resume and no reproduction, and
so is immune to the observer effect recorded on 2026-09-16 (enabling the panel
made the bug stop): **in the FOREGROUND, tap the composer and look at the tab
row.** If the accessory bar covers it there too, (2) is confirmed on the spot
and the resume path is not the defect — it is merely the case where the user is
looking at the tab row instead of at the composer.

### The trigger issue 2159 named and did not move

Measured, not argued. `installViewportHeightTracker` registered the
`visualViewport` `resize` handler as a **one-shot** `writeViewport`, while the
window `resize` trigger added by issue 2159 runs `writeAndSettle`. 2159's own
reasoning was written **about the visualViewport handler** — its moduledoc says
the event *"is handled one-shot, which latches the pre-settle height whenever
WebKit settles the pane after announcing it"*, and its test says the one-shot
shape *"is exactly the shape of the `visualViewport` resize handler this module
already had"* — and then it cured the other trigger. The latching shape was
fixed on the trigger it was discovered on and left on the trigger it was
diagnosed on, which is also the ONE event that announces a keyboard geometry
change.

A test firing a `vv.resize` at `L - K` followed by a silent settle to
`L - K - B` was RED on main (`expected '499px' to be '453px'`) and is green with
the handler promoted to the same `writeAndSettle`. Still one writer, one settle
mechanism, a fifth caller; the redundancy is the one the resume triggers already
accept, since every re-read reads the LIVE height.

**This is not claimed as #1791's cure.** It is the class-(1) cure and it is
inert under class (2); which of the two is live is exactly what is unmeasured.
It is landed on its own terms: a handler that cannot catch a late silent settle
is a defect whether or not it is this one.

### What stays owed, and why it cannot be earned here

The device reading. This class does not reproduce on desktop (#654) and
Playwright's iPhone emulation does not reproduce iOS keyboard physics, so no
green suite closes it. Two further unknowns ride along: `vv.offsetTop` at the
instant of the overlap (the arithmetic above assumes 0), and whether this
WebKit honours `interactive-widget=resizes-content` — recorded in the August
entry as *"not believed to support — not verified against a current WebKit
here"*, and falsifiable for free by watching whether `winH` moves when the
keyboard opens.
<!-- entry #2382 -->

---

## 2026-10-12 — #2382: the tail-follow settles on the true tail, not a carried extent

**Report.** vjt, prod 1.5.13, iOS: sent with the unread marker on screen, and
the sent row ended up under the compose. Intermittent; a follow-up send did not
show it.

**Not the #2377 branch.** #2377's leg (a queued divider jump) is gone: the
send turns the latch off synchronously and `tail-follow` wins. This is a
second mechanism in the tail-follow poll, reached through the OTHER arrival
order. A send's two halves travel on two connections, the POST response and
the WS echo, and nothing orders them at the client.

- Echo first, POST after: the echo's poll sees growth and tails; the collapse
  then shrinks a pane already at its tail. Healthy. This is the order #2377's
  e2e forces by holding the POST, which is why its at-the-tail case could not
  reproduce (0/7 webkit, 0/2 chromium).
- POST first, echo within ~30 frames: the read cursor moves past every loaded
  row and the divider collapses (extent −D), then the echo lands (extent +R).
  `isSettled` compared the extent against `lastTailScrollHeight`, the extent at
  the LAST tail write, which still held the divider. So it saw growth only if
  R > D, and a one-line row is not taller than the divider (8px padding plus a
  0.8em label). Neither poll settled. The #625 fail-safe then skipped its write
  because the hidden row, R px below the fold, sat inside the 50px at-tail
  slack. Nothing came later to repair it.

It also needs a tail write made while the divider was in the list (a followed
peer line after the operator touched the pane). Right after an activation the
baseline is 0 and the race cannot fire. On iOS a `visualViewport` resize after
the send (QuickType bar, keyboard) re-pins the tail through `onResize` and hides
the defect, which fits "intermittent". Nothing in the mechanism is iOS-specific.

**Cure.** `isSettled({distanceToTail, targetNodeHeight})`: the tail row has a
box AND the pane sits more than `TAIL_SUBPIXEL_PX` (1px of rounding) above its
true tail, read fresh every frame. The fail-safe writes only while the pane is
behind that same tail. `lastTailScrollHeight` and its key-change reset are
deleted. The carried baseline was the stale state, so it goes rather than being
patched. Lowering it on an observed shrink was rejected: the collapse and the
echo can commit in the same frame, and then no poll ever observes the shrunk
extent.

**Accepted behaviour change.** A pane less than 50px above its tail keeps
`followMode` on, because `onScroll` turns it off only beyond the slack. While a
rows-change poll is running (≤30 frames), that pane is now pulled to the true
tail even when the change added nothing, such as a divider collapse or a cursor
advance. The old fail-safe skipped it as "at the tail". Two consequences: an
operator nudge of ≤50px within ~0.5s of a rows change is pulled back, and a
divider park that ended near the tail (so `followMode` stayed on) moves to the
true tail on the next rows change, shifting the divider by up to 50px. Both
follow from the cure: the defect lives exactly inside that 50px. Either pane
counts as following by the product's own definition, so the next append would
have tailed it anyway.

Kept: #608 §5, because a zero box or a stale pre-layout extent still reads as
nothing below the tail for a pane that was at its old tail. A pane already
inside the slack is guarded by the box check alone. #625, because the second poll of a single send finds the
pane at its true tail and writes nothing. Same class as #2031: the reader's
50px slack must not decide whether to follow a row. #2031 hit it at 7px, this
one at a whole row.

**Tests.** vitest twin in `ScrollbackPane.test.tsx`: red on main (22px short,
exactly one row), green after. A control with the row taller than the divider
is green on main, which locates the red in the growth comparison.

The e2e case in `issue2031-…spec.ts` holds the WS frame carrying the sent row
(`routeWebSocket`) until the divider leaves the DOM, then releases it 150ms
later. Two vacuity guards are measured in the page. First, the divider left
before the row arrived, fewer than 30 frames apart (measured ~160ms, 0–10
frames). Second, the row is no taller than the divider (20.97px against
22.67px). Before the fix: chromium red 3/3 and webkit-iphone-15 red 3/3, both
for this reason, with the pane exactly 21px short (distanceFromBottom 21) and
the row 13.8–14.4px below the pane's edge. After the fix: 6/6 green, distance
0, no scroll write after the send settled.

Three e2e findings for the next reader:

- **A send no longer always writes, and the spec's "the send wrote" guard
  fell with it.** When the collapse and the echo commit in the same frame and
  the row is no taller than the divider, the extent shrinks on net. The
  browser then clamps a pane that was at its tail, and it never leaves the
  tail: measured on the 2377 at-tail case, scrollTop 935 → 933 at distance 0
  with zero writes. Before the cure the poll wrote anyway, a redundant tail to
  where the pane already was. The guard existed to prove the probe was live;
  it now passes if the send wrote OR every sample shows the pane at its true
  tail. A dead write hook on a hidden row still fails it.

- **`page.route` never saw the send's POST on webkit-iphone-15.** The trace
  shows the POST answered 201 in 80ms while the route handler never ran. So a
  release keyed to the POST never fired there, and the case now releases from
  the page. The #2377 race case holds its POST through `page.route` and records
  "webkit 0/3, cause unknown"; its hold may never have applied on webkit. That
  is unverified, and worth checking before anyone trusts that case as a webkit
  reproduction.
- **On the iPhone viewport the long `i2031 <tag> <epoch>` body wraps to two
  lines** (40.6px), which is taller than the divider. Then the race cannot
  happen, and guard 2 rightly refused it. The 2382 cases send a short body, so
  `sendWithMarkerAndAssertVisible` now takes the body from its caller.

The device reading is still owed: the mechanism is derived from code and pinned
in emulation, not observed on a phone.
<!-- entry #2380 -->

---

## 2026-10-12 — #2380: the deferred autojoin waits for the identity, not for 500ms; the drifted-welcome IDENTIFY moves to the reclaim echo

**The defect.** `@autojoin_defer_ms` was 500ms, documented as the fallback for a
`+r` that is never coming. It also cut off a `+r` that was merely late: on a
v1.5.13 reconnect the `+r` landed 29s after 001, the fallback had already JOINed
every channel unidentified, and ChanServ kickbanned the user on an access-list
channel 14s later. A JOIN cannot be taken back by the later `+r` — bahamut-era
ChanServ does not re-op on identify in channels already joined, and the ban
stays until removed by hand.

**The wait is now a ceiling, 60s (vjt ruling Q1).** ~2× the measured slow case.
The normal case does not pay it: the release signal was already the general one,
`:session_identity_changed, :acquired`, which fires on the `+r` umode AND on
900 / account-notify, and it releases the JOINs the moment it lands (70ms
measured on a prompt reconnect). Only the no-identity paths wait the ceiling,
and on its elapse the JOINs still go out best-effort, as before (ruling Q3).
A per-network knob was rejected: schema and admin surface for a number nobody
tunes, when one ceiling plus the early release below covers it.

**Early release on `401 NickServ` (ruling Q2).** A 401 ERR_NOSUCHNICK naming
NickServ (folded compare) proves the IDENTIFY went nowhere — services split or
absent — so the ceiling would be a pointless wait. It is a numeric, so this is
not the NOTICE-text parsing #347 forbids. It is checked at the generic numeric
door, so a 401 GhostRecovery consumes for its WHOIS probe never reaches it; a
NickServ-less network with a ghost armed waits the ceiling, the bounded side.

**Every release says why, and how long.** `deferred autojoin released: identity
acquired` (info) or `… released unidentified: NickServ unreachable (401)` /
`… no identity before the ceiling` (warnings — the unidentified JOIN is the harm
the timer bounds), each with `elapsed_ms`. The fallback used to fire silently,
which is why this took a prod log read to find. The wait is read off the live
timer (`Process.read_timer/1`: time left while armed, `false` once fired = the
ceiling) — no start stamp stored beside it.

**Extension of #2253: the reclaim now identifies.** Pinning the 12s nick reclaim
inside the new window found the case the ceiling alone would not have fixed, and
it is the COMMON one at reconnect, where our own ghost still holds the nick:

- the built-in `IDENTIFY <secret>` names no nick, so services check it against
  the nick in use; at a welcome that landed on `vjt_` it went for `vjt_` — the
  wrong account, possibly someone else's;
- the reclaim brought `vjt` back and nothing identified it, so the JOINs would
  have waited the full 60s and gone out unidentified anyway.

The identify is MOVED, not added (vjt ruling): a welcome whose nick differs from
the configured one (folded) and has no identity sequence armed holds the secret
in `deferred_identify_secret` instead of sending it; the reclaim's NICK ECHO —
never the send, the nick in use only changes when the server confirms — sends it
once, to the configured nick, and the `+r` releases the JOINs through the
existing signal. One-shot either way; an armed RecoverIdentity owns its own
IDENTIFY, so the slot is dropped unsent rather than doubled; a refused reclaim
never sends the secret at all. Same rule #2371 applies to REGISTER: the secret
counts only on the configured nick. The slot is in `@redacted_state_keys`.

**Not verified on Azzurra:** whether the fallback nick can be linked to the same
services account, in which case the old 001 IDENTIFY on `vjt_` would have won a
`+r` at once. If so, the cost of the move is the wait for the reclaim, ~12s.

**Untouched, deliberately:** a perform list that consumes `$nickserv_pass`
(the built-in is already suppressed there), and GhostRecovery, which still sends
its secret at GHOST, at the 001 IDENTIFY for `<nick>_`, and after its `NICK`
back — the same wrong-nick send, filed separately.

**Sibling, filed as #2388:** `@pending_auth_timeout_ms` (10s) is sized for prompt
services the same way; a typed visitor IDENTIFY confirmed after it is discarded.
<!-- entry #2364 -->

---

## 2026-10-13 — issue 2364: the bun that builds the release is the bun the tests ran on

`Dockerfile.release` stage 1 pinned `oven/bun:1-alpine` at a digest that the
registry resolves to bun **1.4.2** (`imagetools inspect oven/bun:1.4.2-alpine`
returns that digest), while `scripts/bun.sh`, both compose files and `ci.yml`
pinned `oven/bun:1` at the digest of **1.3.14**. Release builds run no tests,
so the shipped bundle came from a bun vitest never ran on — and under 1.4.2 two
`dateFormat.test.ts` cases fail on an `Intl.DateTimeFormat` comma.

**Why the existing gate could not see it.** #1343 compares digests for one
`image:tag`. Debian and alpine builds of the same bun are different images with
different digests by construction, and the moving `1` tag in front of each said
nothing about which bun the bytes were, so there was nothing to compare.

**Fix.** Every `oven/bun` reference now spells the exact version in its tag
(`1.3.14`, `1.3.14-alpine`); the digests of the debian pins are unchanged (the
registry gives `oven/bun:1.3.14` the same digest), and the release pin moves to
the `1.3.14-alpine` digest `.oss-scanner/Dockerfile` already used. A fifth case in
`base_image_digest_pin_test.bats` fails when an `oven/bun` tag lacks an exact
`X.Y.Z` or two tags disagree on it. What it cannot check offline is that a
digest belongs to its tag; the `<version>` refresh command beside each pin
covers that. The old refresh hint (`inspect oven/bun:1`) is gone, since it now
returns a 1.4.x digest.

**Not done here:** moving to bun 1.4.x. That means fixing the two `dateFormat`
cases first, and it is a separate decision.
<!-- entry #2394 -->

---

## 2026-10-13 — issue 2394: every modal is copyable on a touch device

**Defect.** Under `@media (pointer: coarse)` the sheet kills selection on
`<html>` and re-enables it on a list of surfaces. That list named the topic
modal's text and the form fields, and nothing else, so every modal and lookup
card added after it — WHOIS, WHOWAS, LUSERS, the rail server card, `/who`,
`/names`, banlist, server replies, service replies — inherited `none`. Two
users on phones could not copy an IP or a hostname off the WHOIS card.

**Fix: the standing tier is a shape, not a list.** keepKeyboard.ts now owns
`STANDING_SELECTABLE_SURFACES`:

- `.modal-backdrop` — the scrim every viewport modal is built on (14 modals
  today), so a new modal is copyable without anybody remembering this rule;
- `.selectable-text` — an opt-in class for a copyable surface that is not such
  a modal: the four lookup cards and the topic modal's text (which moves off its
  own selector onto this one) and setter line.

`STANDING_SURFACE_CONTROLS` (`button`, `svg`) are carved back out, and the
two policies split here the way #250 / #354 split `.nick-clickable`. In
keepKeyboard every control keeps the keyboard on a tap, as before. In the sheet
a control is unselectable (no magnifier over a ✕, a toggle or the `/links` pan
map) unless it also wears `.selectable-text`, because it is itself the text worth
copying. That is the case for the nick buttons of `/names` and `/who`. Without
the opt-in the whole `/names` grid, which is nothing but nick buttons, stayed
uncopyable. Review caught that.

The bare scrim is chrome in keepKeyboard too. The compat mousedown of the tap
that opens a modal (Send with `/banlist` typed) lands on the freshly mounted
scrim, as measured in `issue1831-tap-send-modal-survives.spec.ts`. Treating
the scrim as text would have let that tap close the keyboard and brought back
#1059's Send/Enter split. Review caught that as well.

The new surfaces also lift the inherited `-webkit-touch-callout: none`. #1067
found that a selection made under a suppressed callout has no draggable
endpoints on iOS. `.scrollback` keeps its callout behind the latch only
because its long-press menu would race the platform's, and modals and cards
have no such menu. The price is the native link preview on a long-pressed
link inside a modal.

CSS cannot import a constant, so `touchSelectionPolicy.test.ts` checks both
directions. Every listed surface (text + callout) and every non-copyable
control is declared inside the gate. The gate has no unlatched `text`/`all`/
`auto` re-enable outside the list plus the four non-keyboard ones (`input`,
`textarea`, `select`, `.admin-tab-panel`). That test replaces the old comment
asking people to keep two lists in sync. Seven mutants each turn a test red:
a CSS control rule dropped, a stray selector added, the TS exclude dropped,
the modal root dropped, the scrim check dropped, the `:not()` opt-in dropped,
the callout lift dropped.

**Behaviour change, accepted.** With compose focused on iOS, a short tap on
modal TEXT now dismisses the keyboard instead of keeping it. That is what the
topic text and the scrollback have always done, and long-press keeps it so
the selection survives. Controls and the scrim are unchanged.

**Left out, on purpose.** `/links` server names (SVG labels on a pan
surface), the `/list` directory pane (a pane, not a modal; its rows are join
controls), the media viewer (pull-to-dismiss and pinch
gestures on the same surface would compete with a native selection; it needs
a device check first), the archive modal and the theme editor (buttons and
form fields only), and the credits.

**Not device-verified.** `issue2394-mobile-modal-select.spec.ts` checks the
computed cascade on both touch projects. Whether the native handles and copy
toolbar appear is a question for a real device; Playwright webkit is not iOS,
the same limit #589 and #1869 state.
<!-- entry #2368 -->

---

## 2026-10-13 — #2368: a peer's rename writes ONE row into its old query window

**Ruling (vjt, 2026-10-13, relayed by the orchestrator): option E.** When a
peer we have an open query window with changes nick, the server INSERTs one
`:nick_change` row into the OLD nick's query window — `* <old> is now known as
<new>`, `<new>` a button in cic that opens and selects the query for the new
nick. This amends issue 1365's "a nick change writes nothing to the DB" by
exactly that INSERT: what 1365 rejected was the mass UPDATE of history, and
nothing existing moves — no row, read cursor, mute or `query_windows` row. The
1365 price stands (the renamed peer's next message opens a new window); the
row only tells the old window where the peer went.

**Shape.** `EventRouter.route_nick/3` emits the row beside the per-channel
fan-out, as one more `{:persist, :nick_change, …}` at `channel = old nick`,
`dm_with` nil (the kind is not a content kind), `meta.new_nick`. The DM read
path already resolves a window by `COALESCE(dm_with, channel)`, folded, so the
row lands in the window and on its topic (`Topic.channel/3` folds) with no
new read path, no new wire field and no protocol bump: `mix grappa.wire_pin`
digests the shape, and the shape did not change. The gate is the injected
`query_window_open?` (`QueryWindows.open?/3`, folded) — the same seam the #400
routing door reads, now one shared `open_query?/2` — under the same "peer
rename" predicate the `{:peer_nick_renamed, old}` effect uses, so own renames
write nothing here.

**ONE row, not one per channel.** The fan-out is per channel because each
channel shows the event; the query row is per WINDOW, and a peer sharing two
channels with us still writes one. Pinned in the router suite, the
`Session.Server` suite (real DB, two channels) and the e2e.

**The persist arm's auto-open is left alone, deliberately.** The row goes
through the ordinary `{:persist, …}` arm, which runs `maybe_open_query_window/2`
on every row keyed `dm_with || channel` — so it calls `QueryWindows.open/4` on
a window the router has just checked is open: an `on_conflict: :nothing` no-op
plus one unchanged `query_windows_list` broadcast per rename. A first cut
gated the auto-open to CONTENT kinds to drop that broadcast, on the claim that
no event row had ever landed on a nick-shaped key. **The claim was false**
(caught in review): a post-accept DCC transfer report — FAILED or refused by
storage — is a `:server_event` at `channel = peer` (`Dcc.Report`), and
`persist_dcc_report/3` relies on exactly this arm to open the query that holds
it. The gate would have left that report in scrollback no tab leads to.
Accepted price instead: the redundant broadcast, and a window closed from
another device in the microseconds between the router's read and the persist
coming back with only the rename line in it.

**Also known, not addressed.** The `<new>` button is on every `nick_change`
line, channels included — the same button the sender already was, so a click
in a channel opens the query too. `nick_change` is a presence-hidden kind
(#458), so on a query window whose presence pref is pinned to `hide` the row is
left out of the REST fetch (it still arrives live — `nick_change` is never
paused, #1769).

**Coverage is IRC's, and stays IRC's.** bahamut sends a NICK only to members
of the renamer's channels (`m_nick.c` → `sendto_common_channels`, read by w1
on the plan comment), so a peer we only DM can rename without us seeing it.
Nothing on the wire names the new nick in that case (WHOWAS gives the OLD
nick's host, a 401 only says the old nick is gone), and matching a later
WHOIS by user@host could point at the wrong person. No heuristic, by
instruction; the gap is stated in CLAUDE.md and `docs/CLIENT_PROTOCOL.md`
§5h.

**Deploy class: HOT.** No field added to `Session.Server`'s state map or any
`defstruct`; the server change is a pure-function arm in `EventRouter`.
<!-- entry #2402 -->

---

## 2026-10-13 — #2402: the image fetcher caps bytes while they stream, at the caller's limit

`Grappa.Net.ImageFetcher.Req` used to buffer the whole response and compare
its size afterwards, bounded only by the 10 s receive timeout. Its moduledoc
defended that on one ground — the theme path is quota-limited (#1404) — and
said in so many words that a caller arriving without that quota would need an
in-flight ceiling. The peer-avatar path (M3b) is that caller: a CTCP AVATAR
reply from any IRC peer starts the fetch, with no quota in front of it.

**The fix is the in-flight ceiling, not a quota on the avatar door.** The
response streams into a Req `into:` function: a declared `content-length` over
the cap is refused on the first chunk, and every chunk is counted against the
cap whatever the header said, so a chunked or length-less body is cut off the
moment it passes and the connection is dropped rather than drained. Memory is
bounded by the cap plus one chunk.

**The cap moved from the fetcher to the caller (`fetch/2`).** The two callers
never agreed: the fetcher held 8 MiB, the avatar cache 2 MiB, and the cache
re-checked its own number AFTER the fetcher had already read up to 8 MiB.
Each caller now passes its own ceiling (`BackgroundImage`'s existing
`@max_bytes`, `Avatars`' existing `@max_fetch_bytes`), the fetcher holds none,
and the avatar post-check is deleted — the 2 MiB is now enforced on the wire.

**Not in this slice:** a cap on concurrent avatar fetches. The issue asks for
one too; it is a different axis (how many requests, not how big one is) and
is left to its own change.

**Deploy class: HOT.** A behaviour callback arity and function bodies; no
`config/*.exs`, no `defstruct`, no state-map field.
<!-- entry #2403 -->

---

## 2026-10-14 — #2403: the upload caps are checked inside the write, in one transaction

Every door into the upload store — `POST /api/uploads`, the network avatar,
the theme background — called `Uploads.check_caps/3` and then
`Uploads.create/3`. Both ceilings (global, and per-subject since #2175) are
sums over live rows, so two writers could read the same totals between one's
check and the other's insert, and both land: the cap could be overshot by up
to one upload per concurrent writer.

**The check moved into the write, and the doors lost the ability to skip
it.** `create/4` takes the caps as a required argument; `check_caps/3` is
private. A check a door can call apart from the write is exactly the check two
concurrent writers both pass. Inside `create/4`:

1. a cheap pre-check on the INCOMING size, before the strip, so an upload
   already over the line never reaches ffmpeg (there is no upload rate limit,
   so dropping this would let a subject at quota burn CPU at will);
2. the strip and the file write, under no lock;
3. the authoritative re-check on the STORED size plus the row insert, in ONE
   `Repo.immediate_transaction/1`. `BEGIN IMMEDIATE` serialises writers, so the
   totals it reads cannot move before its insert commits. A refusal there
   removes the file it wrote.

**Why the slow part stays outside the transaction:** a writer parked on the
SQLite write lock blocks `persistent_term` writes VM-wide for the length of the
wait (#1715). Holding the lock across ffmpeg or a 50 MiB disk write would turn
every concurrent upload into exactly that wait.

**No reservation table.** The issue proposed reserving storage before
accepting the upload; that is a second copy of the live sum, with its own
release-on-failure housekeeping. Once the row is in, the live sum IS the
reservation, and the transaction is what makes reading it and adding to it one
step.

**Crash window, unchanged:** a crash between the file write and the insert
leaves a file with no row. It is unservable (every read goes through the row)
and it is the same window the file-first ordering always had; there is no
orphan-file sweep, and this slice does not add one.

**The stored size is what counts.** The pre-check sees the incoming bytes, the
re-check sees the stripped ones, and the row records the stripped ones — the
sum the next writer reads is the sum of what is on disk.

**Measured, not argued:** the concurrency tests force both interleavings off
Ecto's synchronous query telemetry (the `UserSettingsConcurrencyTest` harness).
Removing the in-transaction re-check turns three of them red, the
pre-check-window pair with `{:stored, :stored}` — the overshoot itself.
Removing the refusal's file cleanup turns two red. Moving the re-check in
front of the transaction turns one red, and only through the harness (the
in-transaction pause never arms): under the Sandbox's single connection a
sequential re-check is indistinguishable from an atomic one, which is the
limit `UserSettingsConcurrencyTest` already documents.

**Deploy class: HOT.** Function bodies and arities only (`create/3` →
`create/4`, `set_avatar/3` → `set_avatar/4`, all callers in the same build); no
`config/*.exs`, no migration, no `defstruct`, no state-map field.
