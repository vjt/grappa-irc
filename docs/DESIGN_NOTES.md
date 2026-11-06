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

Everything before **2026-11** lives in [`design_notes/`](design_notes/), moved
**verbatim** by #1537 and issues 2138, 2335 and 2488 — not one entry was edited, cut,
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
| 2026-10 | [`design_notes/2026-10.md`](design_notes/2026-10.md) | 56 |

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
<!-- entry #2487 -->

---

## 2026-11-01 — #2487: an inbound INVITE notifies, unless the channel is muted

vjt's requirement (TG voice, 2026-10-31): an INVITE must reach the user
through the normal notification path, not only through cic's in-app
banner (#902), and the invited channel's mute applies to invites too.
Until now an INVITE produced the banner and a `:server_event` row, and the
row is outside `Message.notify_kinds/0` on purpose, so nothing pushed.

**The notification rides the branch that opens the banner.**
`Session.Server.admit_invited/3` broadcasts `window_invited` and, in the
same branch, calls `Push.Triggers.dispatch_invite/3` when the window was not
already `:invited`. So an INVITE pushes exactly when it OPENS an `:invited`
window. Three INVITEs never get that far and so never push: one to a channel already `:joined` or
`:pending` (`apply_invited/3` returns first), the ChanServ relay of our
own gated JOIN (#116, the router turns it into `{:rejoin_invited, _}`),
and one the invited-window ceiling turns away (#1404). The alternative,
pushing from the `{:invited, _, _}` effect arm before the state check, was
rejected: an invitation into a room the user is sitting in is noise, and a
flood past the ceiling would have reached the lock screen even though the
ceiling exists to bound what a stranger can create.

**No preference, one gate.** `should_notify_invite?/3` reads only the
channel's per-network mute (`muted_targets`, the same `muted_target?/3`
the message and e2e paths use). None of the existing toggles was ever a
statement about invitations: an invite is neither a channel message nor a
DM, and borrowing `channel_mentions` or `private_messages_all` would make
a toggle mean two things. The mute is the right gate because it names the
room. The mute is the CHANNEL's: a muted inviter does not silence an
invite into an unmuted channel, which is the issue's wording and the
reading pinned by the predicate tests. After the gate, the shared #182
foreground check and its issue-2067 suppression report, as for the other
three classes.

**The payload copies the banner.** `Payload.build_invite/3`: title
`"<inviter> is inviting you to <channel>"` (cic's banner says exactly
that, and "one event, one spelling" is the presence precedent), body
`"on <network>"`, the composed title projected through
`MircFormat.plain_text/1` because a channel name can carry `\x03`. `tag`
and `url` are the ones `build/2` writes for a message in that channel, as
`build_e2e/2` reuses the DM ones: once the invite is accepted the
channel's own banners replace it rather than stacking under it, and a tap
opens the channel, where the INVITE row and its [Join] are. No badge,
because nothing counts the INVITE row as unread. Same payload shape, so
no service-worker change and no wire change.

**A repeat INVITE re-affirms the banner and pushes nothing.** The first
cut pushed on every re-affirm, and the code review of this branch named
what that costs: the banner is still up, the push says nothing new, and a
stranger re-inviting in a loop could fire one push per INVITE, forever,
across up to 64 windows (#1404's ceiling). The state is already there to
derive the answer from, so `maybe_push_invite/3` reads it before
`set_invited/3` writes it: absent, `:failed`, `:kicked` or `:parked` push;
`:invited` does not. A decline clears the state, so the next invite after
it pushes again. The price, accepted: an invite whose first push was
withheld (a device on screen) or muted stays silent when re-sent after the
user walked away or unmuted. The banner still carries it.

**An ignored inviter's INVITE disappears entirely (vjt's ruling (b)).**
#162 ruled that an ignored sender produces no push, at a time when only
content verbs pushed, and its filter (`EventRouter.ignored?/2`) covered
PRIVMSG and NOTICE alone. So an ignored nick's INVITE opened the banner and
landed its row, and this issue would have let it reach the lock screen too.
Two readings were put to vjt: (a) withhold only the push, (b) treat the
INVITE like the ignored person's chatter. He ruled (b), inside this issue:
no push, no `window_invited`, no `:invited` window, no scrollback row. The
cure is one atom, `:invite` in `ignored?/2`'s guard, so the INVITE is
dropped at the head of `route/2` and none of the three can happen, by
construction rather than by three gates. The #162 exclusions carry over
unchanged: services never match (the #116 ChanServ relay of our own
gated JOIN is safe), nor do we ourselves. One thing had to be decided
with it: an INVITE says nothing, and the text its trailing param would
supply is the CHANNEL, so `body_of/1` returns `""` for it. A targeted
entry (issue 2294, mask plus text glob) therefore never drops an
invitation: "ignore what X says about #foo" must not eat X's invitation to
#foo. Only a pattern-less entry, the whole person, does.

**Apply:** a new trigger class is a `dispatch_*` in `Push.Triggers` with
a pure `should_notify_*?` beside it, called from where the session already
decides the user-visible event, never from a second place that decides it
again. Its mute, if the event names a conversation, goes through
`muted_target?/3`.

Tests: `payload_test.exs` (copy literals, tag/url equal to a channel
message's, the `\x03` projection, no badge); `triggers_test.exs` (the
predicate with every message trigger off, the mute on one network only
and folded, a mute on another conversation; the dispatcher pushing, staying
silent when muted, withholding with the report when a device is visible);
`session/invite_push_test.exs` end to end off the fake ircd (the push
DECRYPTED as a browser would, through `Grappa.PushReceiver`, now shared with
`wire_format_test.exs`, and compared with literals — which pins which
argument went where, a swap no other test could see; a repeat INVITE pushes
nothing; muted channel opens the banner and pushes nothing; joined channel
pushes nothing; past the ceiling pushes nothing). Each negative was read red
against a mutant of its own: the mute gate removed (3 reds, one per layer),
any mute silencing every invite (2), the joined/pending branch pushing (1),
the ceiling's refusal branch pushing (1), the re-affirm pushing (1), and
`channel` and `inviter` swapped on their way into the payload (1). The ignore half: `event_router_test.exs` (an ignored INVITE yields no
effect at all; a non-ignored one still persists and opens; a targeted
entry whose glob matches the channel name drops nothing) and one session
case (no push, no banner, no window, no row, then a non-ignored INVITE on
the same session gets all of it). Mutants: `:invite` dropped from the guard
(2 reds, router and session), the `body_of/1` INVITE clause dropped (1, the
targeted-entry case).
<!-- entry #2485 -->

---

## 2026-11-01 — #2485: the encrypted window keeps key machinery in the rail, and an order challenge shows only as the last identity check

vjt's requirements for taking E2E queries (#2430) to production: the chat
window shows only what finishing the key exchange needs, the top bar only the
peer's verification, and everything technical moves to the right rail, laid
out like a settings page. An order challenge (the bot's `CHAL` inside the
session) must stay invisible. What the user sees instead is a "last identity
check" signal. Four layout points were open, and vjt ruled on them (TG,
2026-10-31, recorded on the issue, comment 6550206757):

1. **The key exchange is done** once the peer's nick has a pinned key (taken
   on first use, or pasted by hand) and no key alarm is open, verified or
   not. Verification is not a chat step. It is the top bar's state. Until
   the exchange is done, the chat body shows one step card, the first that
   applies: identity held elsewhere, alarm, no key yet.
2. **The emoji comparison runs in the chat window, modal-like**, not in the
   top bar: a dialog over the chat body, with the body `inert` beneath it
   ("tanto fino a che quello non è completo non si scambiano messaggi"). It
   is started from the rail. Modal over the BODY only: the top bar and the
   rail stay usable (the wait tells the user to pin a bot's key in the rail),
   so it carries no `aria-modal`, which would tell assistive tech the rail
   is out of reach, and it takes the focus the inert compose line drops.
3. **Search and "delete this chat" are top-bar buttons**, a magnifier and
   a shredder, not rail entries. The shredder asks in the same confirm
   dialog the window's × uses, which replaced the inline two-tap button.
4. **An identity held on another device is a card in the chat**, both ways
   out included (pair this browser, start a new identity). The destructive
   one keeps its inline confirmation that names what it destroys.

**The key events stay in the store; only what the window shows counts.** The
key events the chat used to list as rows (`pinned`, `accepted`, `sas_asked`,
`sas_cancelled`, `verified`, `key_alarm`) are still written. The badge reads
them through `trustOf`/`openAlarm`, and the rail shows them as state
("ignored key", "last emoji comparison", the latter only for the key pinned
NOW: a key pinned or taken since ends the search). The body renders only
`in`, `out` and `undecryptable`. The last one stands in for a lost message
and is not machinery. A message written under another master keeps a compact
⚠ with the key in its label. Hiding rows had three readers to follow, each
of which used to treat every row as visible: the unread count, the reopening
of a closed chat, and the ×'s question. So the store's `add` now opens a
chat and counts a row only when the window shows it (`chatStore` `shown`):
a message, a key alarm (the step card), or the peer asking to compare (the
dialog: a closed chat must come back for it, or the user never sees the
request). The rest are written and do neither, so a peer's cancel no longer
badges a window that has nothing new to show, nor our own 10-minute timeout
reopens one on an empty body. The × asks only about messages
(`encryptedChatHasMessages`, formerly `encryptedChatHasRows`): a chat that
holds only a pinned key closes without "delete the messages?".

**The last identity check lives on the chat's index entry.** It is sealed
like the rest of the index. A `check` change never opens the chat and never
counts as unread. It is not kept in memory: the CHAL is answered inside
whichever tab drains the inbox, and the index is what the other tabs already
re-read on the chats BroadcastChannel, so the signal reaches the tab the
user is looking at and survives a reload. A nick whose chat was deleted gets
a closed, empty entry to keep it on, and a batch of checks alone seals the
index again but never the chat's rows. A malformed CHAL names nothing and
leaves no check. `passed` is cic's answer, not the bot's verdict: an ACK
grappa then refuses still reads passed. A check that failed carries the
reason (`unverified`, or the send log's verdict), worded by the same
`UNCONFIRMED` strings the console uses.

**This reverses #2430w2d's "no visible warning for a CHAL cic cannot
confirm", on the issue's own words** ("last identity check (when, on which
network/channel, passed or failed)"). The argument there still bites for
one verdict, because the answer is THIS device's. A bot
encrypts its CHAL to every device of the master, and the send log is the
device's (#2430w2c), so on an account with two browsers an order typed on
one shows ✓ there and `not-sent` on the other, every time, and the other
cannot tell that from a line someone else put out in the user's nick. So
`not-sent` reads "not answered here", grey with a "–", and the red ✗ stays
for the verdicts that are about the challenge itself (another network, no
network name, expired, a PM to someone else, an unverified key). vjt's
ruling (TG, 2026-11-01, issue comment 6550752584): "b - risposto altrove o
similari". The label is "not answered here" rather than "answered
elsewhere": this device cannot know a sibling answered, and `not-sent` also
covers the line someone else put out in the user's nick, which is what the
check is there to show.

**Mobile:** the top bar ends in the shredder, which is exactly the corner
the floating `.shell-chrome` ☰ covers (#1050's collision). So `encrypted` is
the fifth kind excluded from that float, with mentions' remedy: the pane
hosts the rail's ☰ as its last child and the `#` window-list door as its
first. It has no ✕ to leave by, so #1766's argument for the left door holds.
Hosting the `#` door first, the bar reads the `--pane-chrome-inset-*`
tokens like the other ☰ hosts (#1039), the leading side clearing iPadOS's
pill in a windowed pane (#2160). The rail is a drawer OVER the pane there,
and the comparison's dialog opens in the pane behind it, whether the rail's
"verify" started it or the peer asked while the drawer was up: the pane says
when its dialog opens (`onDialogOpen`, `null` on desktop) and Shell closes
the drawer, as the rail's refresh does for the table behind it.

**No dialog over the way out.** While the network's identity is elsewhere,
`encryptedSas` answers none: a refresh that finds the identity elsewhere
stops before the SAS, so the view it kept is the one from before, and a
dialog drawn from it would make the body inert over the card that is the
only way out of that state. The pane's dialog, its inert body and its send
guard read that one accessor, and the view comes back as it was once the
identity is here again.

**Duplicated doors, on purpose:** the "no key yet" card carries its own pin
form and copy button, and the alarm card its own "take the new key" and pin
form (ruling 1: "take the new key or pin the one they give you"). The
rail carries the same verbs. On mobile the rail is a drawer, so a step card
that only pointed there would make finishing the exchange a hunt. Each pair
is one verb (`PinForm`, `CopyOwnKey`, `acceptAlarmKey`) told apart by test
id.

Tests: unit tests for the store (`check` change, which rows open and count,
a check never resealing rows), the client (passed, the not-sent and
unverified failures, malformed = none, no row, no unread), the chat glue
(no SAS while elsewhere, no messages in a pinned-only chat), the window
(pane and rail rendered side by side as Shell mounts them), RailContext's
encrypted arm, and Shell's mobile chrome (the pane's door opens the drawer,
its dialog closes it; desktop gets neither). Each new assertion was read red
against a mutant of its own: rows unfiltered, the dialog without `inert` or
without the focus, the SAS read while elsewhere, every row counted for the
×, the bar's literal padding, the alarm key's rule ahead of `.e2e-key`'s.
e2e: `issue2485-encrypted-layout.spec.ts` walks bullets 1-3 between two
people (before the exchange, after it on first use, after a comparison), and
on `@touch` the phone's path (the bar's ☰ opens the rail, the comparison it
starts closes the drawer over the dialog). `issue2430-interop-bot.spec.ts`
covers bullet 4 against the real irc-olm bot, each check read with the
channel focused so "no unread" can fail: no query window, no row, no unread,
and the chip and rail reading passed, then not answered here for
`not-sent`. The 2430
specs follow the moved controls.
<!-- entry #2491 -->

---

## 2026-11-01 — #2491: a message no device of the peer can read is NACKed, and the re-key is the user's

R has an encrypted query with A, keyed to A's device d1. A starts a new
identity, or moves to another grappa and a new device. R writes: the message
names d1, which A's grappa no longer lists. Until now `deliver_e2e/3` dropped
it at debug, A's cic dropped a `*` message with no body for it as
not-for-us, and `onNack` only acted on a NACK from the device a message went
to, which is gone. R saw the line as sent and never learned that nobody could
read it. That was the 2430 ruling of 2026-10-18 ("no sender-side notice",
2026-10 archive, *What the client sends*) doing what it said.

**vjt's ruling (issue body, 2026-11-01) lifts it for this one case:** the
side that cannot decrypt because no key matches MUST NACK instead of dropping
in silence, and the re-key is NOT automatic. The sender's cic tells the user
that the peer cannot read, and the user decides whether to start a new key
exchange. The nick may be held by an impostor, so cic never re-keys on its
own. Once the user asks, the existing flow applies: trust on first use, the
key alarm, SAS. The rest of 2430's silence stands: no delivered, expired or
undeliverable notice, no `OFFLINE`.

### grappa: a NACK from `*`

`deliver_e2e/3` answers a PKMSG or MSG whose `to` reaches none of the user's
listed devices with `nack_unreadable/3`: a NACK from `*` to the device that
wrote, payload `{"ref": <msgid>, "v": 2}` (irc-olm's NACK shape), on the
REACTIVE lane like a client's NACK. `*` speaks for the user, as it does on a
KEYS: grappa is the one that knows the list, and the message did not reach
any device that could speak for itself. `E2e.addressed?/3` gains `* → did`
for `:nack`, one table for the parser and the send door.

- **Only PKMSG and MSG.** A NACK or a KEYS that reaches nobody is still
  dropped at debug: neither is a message a device failed to read, and two
  grappas NACKing each other's NACKs would never stop.
- **A client can never send from `*`.** The send door now also wants
  `E2e.did?(from)`, so a NACK from `*` through REST is a 400. It was never
  open: the door also wants `from` to be a listed device of the subject
  (`listed_device/3`), and a stored did is derived from its key, so never
  `*`, which made the answer `unknown_device`. The check gives the right
  answer for a request that is malformed rather than about an unknown
  device, and it keeps the door's rule readable at the door.
- **Half the connection's room, no more.** Peers draw these NACKs at will,
  client or no client, and the pacer's REACTIVE budgets only rank: what
  refuses is the connection's 128 urgent and reactive lines, shared with the
  user's own orders. A few nicks writing junk to a device nobody lists
  would fill them, 32 lines per nick's lane, and every KEYREQ and CHAL
  answer of the user's would come back 429 until they drained. That is the
  argument the orchestrator ruled on for KEYS answers (#2430i), so the NACK
  gets the same kind of answer, derived instead of kept:
  `E2ePacer.spare_room?/1` reads the queue the pacer already holds, and a
  grappa NACK is queued only while urgent and reactive lines fill under
  half of `max_queued/0`. No new state, so the struct does not change. A
  per-nick interval, as KEYS have, was the alternative and is worse here:
  cic shows the card off the newest line out, so a throttled tail of an
  honest burst would hide it. A refusal is logged at debug and the sender
  is not told, like any line it draws past a cap; the pacer the refusal
  hands back is let go, as the KEYREQ arm does, since a NACK is no Olm
  message and leaves no gap to keep.
- **Known wart.** A grappa NACK still in the pacer when the session ends
  (`drop_e2e_pending/1`), or one whose line fails to go out
  (`send_e2e_releases/2`), is announced like every other drop: an
  `e2e_send_dropped` for a msgid no client sent. A client ignores a drop it
  holds no send for, which cic does.

### cic: NACK when none of OUR devices has a body

A PKMSG or MSG with no body for this device goes to `notForUs`. If a device
of our own list has a body, the message is for a sibling (a `*` message) and
is dropped as before. If none does, it went to devices this account does not
have, and it is NACKed as undecryptable (`not-for-our-devices`). Caveat,
accepted: a list of ours that lags a device just added NACKs a message
written to that device too. The sender is told the message went unread,
which is true here.

On the sending side `onNack` keeps dropping a NACK from a device the message
did not go to, except when `unreadableBy` says it means "nobody can read
this": from `*`, or from a did that is neither bound under the master the
message went to nor named by that master's stored list, and only from the
nick the message went to. A device of that master is dropped, bound or only
listed, because it reads its OWN list, which can lag the devices the message
did go to (review finding: a long-lived tab synced at load NACKs a `*`
message holding bodies for the two devices paired since, and the sender
used to throw away the record proving they got it). A copy for a listed,
unbound device already waits for its keys. What remains is a double lag,
accepted: the sender's view of the list and the receiving device's both
older than the devices the message reached. The message is reported lost
with reason `unreadable` ("none of the peer's devices can read it") once
nothing else of it is pending: a message of two payloads (a MSG to one
device, a PKMSG to another) is told of only when both are NACKed. Nothing is
re-sent and nothing re-keys.

The pane's step card reads `unreadable` with an "ask for their keys again"
button. `Engine.rekey(nick)` marks the pinned master's trusted devices as
re-keying, records `keysAsked` and sends a KEYREQ under the usual budget.
`tick` asks again until `OUTQ_TTL_MS`, then reports `keys_unanswered`. The
KEYS is judged like any other: the pinned master answering opens fresh
sessions (`keys_renewed`, written only when one opened: a KEYS whose entries
are all refused is `keys_unanswered`), and another master is the key alarm,
answered from the same card as before and verified by SAS. A KEYS carrying
our own master raises no alarm row, so it ends the wait unanswered too.

Known, and left as they are: a KEYS that lands after the 90 s give-up
opens its sessions but writes no renewed row, so the card keeps saying no
keys came, and its "ask again" recovers it; `startOver` (a new identity of
our own) drops `keysAsked` as it drops the queue, the same class; and
`rekey` asks even on a dead link, while the card only ever appears after a
NACK, that is with a live upstream.

### irc-olm diverges, by design

irc-olm's framing table (`framing.py` `ADDRESSES`, at the 1606c85 the e2e bot
runs) allows NACK `did → did` only. Its `parse` returns `None` for a NACK
from `*`, so a bot drops it as malformed and is never told. That is the
"unknown is never fatal" rule doing its job, not a break. A bot that wants
the notice needs the table change on its side.

### Protocol 52

No field is new, so the wire digest does not move. The number moves on the
#1393d rule: a client that tells its user "the peer cannot read this" cannot
get it from an older server. `min_protocol_version` stays at 1, since an
older client drops a NACK whose ref it does not know.

Tests: `e2e_test.exs` for the table (a NACK `* → did` parses and is
addressed). `e2e_session_test.exs` covers the NACK of a message that reaches
no listed device, and of one to a subject with no device at all; no NACK back
for a NACK or a KEYS that reaches nobody; a peer grappa's NACK from `*`
relayed with `from_did: "*"`; the door's 400 on a client NACK from `*`; and
the half-room gate (three nicks would queue 96 NACK lines, 64 at most do),
which has a pacer test of its own. grappa's NACK waits on the post-handshake
fake-lag bank, about 5 s, hence `@nack_timeout`. cic unit tests cover the
engine (`notForUs` both ways; `unreadableBy` from `*`, from a never-bound
did, from another nick, and from a listed but unbound device, which keeps
the message; a two-payload message told of once; `rekey` renewed, the alarm,
a KEYS that opens nothing and one carrying our own master), the client and
chat glue, and the pane's three cards. Assertions were read red against
mutants: 5 on the server (the `[]` guard, the door's `did?`, the payload's
ref, the half-room gate bypassed, its threshold at the full 128) and 20 in
cic, the 4 added after the review each red on its own test alone. e2e:
`issue2491-moved-peer.spec.ts` walks the whole path between two browsers.
Bob starts a new identity, Alice's line reads not sent with the unreadable
card and her pin unchanged, then her re-key goes through the alarm and the
emoji, and her next line reaches Bob's new device. It was read red against a
server that drops instead of NACKing (the `[]` guard narrowed to `:nack`):
Alice's line stayed `sent`.
<!-- entry #2486 -->

---

## 2026-11-02 — #2486: asking a peer to start an encrypted chat, with grappa holding the asking

vjt's requirement: one button in a query's rail starts an encrypted chat,
behind a confirm that says what the peer needs, with no CTCP VERSION probe.
His ruling on the design (issue comments 6556578954, 6556875039 and the
answers in 6556851327, approved in 6556976295): grappa is the intermediary
(design B), the asking is persisted server-side so the two clients never
have to be online together, CANCEL reaches the peer, the banner lives in the
plaintext query, and a pending request expires after 24 h for everyone,
with Retry. His rulings R1–R4 on the review (comment 6564501129) are folded
in below; the design as built is update C (comment 6564547637).

The key exchange already completed with nobody online: grappa answers a
KEYREQ from the uploaded bundles (§4f) and PKMSG/MSG wait in each device's
offline queue. What was missing was CONSENT, and that is all this adds.
Keys, sessions, TOFU and the SAS are unchanged, and grappa still never sends
a KEYREQ for anyone: each cicchetto fetches the peer's keys itself once the
chat is agreed.

### The wire: four verbs in the §4f frame, protocol 53

`REQUEST`, `ACCEPT`, `REFUSE` and `CANCEL`, each from a device to `*`:
consent belongs to the person, and the asker does not know the peer's
devices yet. The one other addressing is grappa's own, `ACCEPT` and
`REFUSE` from `*` to a device, when it answers for the user (R1, R2 below).
The payload is opaque compact JSON of at most 1 KiB (cicchetto sends
`{"v":2,"master":…}`, a hint, never a proof; grappa's own answers carry
`{"v":2}`), and `E2eRequests.payload?/1` is the one rule for the send door
and the inbound line alike. grappa reads the verb alone. A consent line is
never queued in a device inbox and never pushed as `e2e_message`. It rides
the reactive lane, and takes it from `E2ePacer.lane/2` like every other
verb. It first did not: the send path hard-coded `:reactive` while `lane/2`
carried the four verbs too, and nothing ever asked `lane/2` about them, so a
mutant moving them to `:urgent` there killed nothing. The session now asks
`lane(verb, :text)`, the table is the one place the lane is decided, and the
pacer test pins the four verbs reactive whatever the priority.

### Storage: one row per (subject, network, folded peer)

`e2e_requests`, one row per peer whoever asked, keyed on the folded nick
like `query_windows.target_nick` (a rename moves nothing, CLAUDE.md issue
1365: a request made under the old nick stays there and lapses). Four
stored states, `incoming | outgoing | accepted | refused`. **`expired` is
derived, never stored**: a pending row lapses 24 h after `updated_at`, and
every transition writes `updated_at` explicitly, so asking again moves the
clock even when nothing else in the row changes. On the wire an
`outgoing` row past its deadline reads `expired` and stays until it is
retried or dismissed; an `incoming` one past its deadline is unlisted, and
the session's hourly sweep deletes it and pushes `e2e_request_gone`.
`peer_device` keeps the `from` of the peer's latest line on the row (R2),
never on the wire.

The transitions are planned by pure functions (`inbound/5`, `ask/3`,
`answer/2`, `dismiss/2`) and carried out by `commit/4` only once the pacer
has taken the line, in the same call: a refused send leaves no state.

### vjt's rulings on the review

* **R1: a REQUEST that meets our consent is answered ACCEPT, from `*`, to
  the device that sent it.** Our consent is our live `outgoing` row (it
  turns `accepted`, as before) or an `accepted` row (it stays; it used to
  be a silent drop). The review found the hole: a REQUEST of ours that
  never reached the peer (they were off IRC, their side was full, their
  database did not answer) left their crossing REQUEST unanswered for
  24 h while our side read `accepted`. `inbound/5` now says whether to
  answer, `{:accept | :none, plan}`, the shape `ask/3` and `dismiss/2`
  already had; the session answers only after the row is written, best
  effort (a pacer refusal is logged, the row moves anyway). An expired
  `outgoing` is no consent: a fresh `incoming`, unanswered. An `ACCEPT` is
  never answered, so on a true crossing each grappa drops the other's as
  unsolicited and the exchange cannot loop. grappa speaking for the user is
  now one helper, `speak_for_user/5`, shared with issue 2491's NACK: the
  same spare-room guard, lane, pacing and commit.
* **R2: refusing needs no encryption identity.** A refuse with no body
  sends `REFUSE` from `*` to the device the stored incoming request came
  from (`peer_device`), payload `{"v":2}`; cicchetto always refuses that
  way, so saying no never creates an identity and works from a device whose
  identity lives elsewhere. A body still works as before (from that listed
  device to `*`). Accepting still needs a listed device: it starts the key
  exchange, so 400 without one. The row keeps the device of the peer's
  LATEST line: their next REQUEST from another device is the one answered;
  asking afresh forgets it; asking a peer whose request waits keeps it.
  The column went into the branch's own migration, edited in place: it has
  never shipped.
* **R3: a full side is 422, not 429.** The first cut answered 429 on the
  argument that pending rows lapse with time. That holds only for the
  peers' side, and the user can only hit ours, whose rows never lapse (an
  expired asking stays until retried or dismissed, an answer until shown):
  only a dismissal frees a room, so "retry later" was the wrong signal.
  While fixing it, the cap on the peers' side stopped counting an
  `incoming` row past its deadline, which kept a new nick out for up to the
  hour before the sweep deleted it.
* **R4: our asking is a card in the query's timeline; the banner is the
  peer's asking only.** See cicchetto below.

### Where this departs from the approved design

* **Both crossings land on `accepted` and keep the row.** The design had
  "user asks a peer whose request waits" delete the row after sending
  ACCEPT. It now reads `accepted` like the other crossing, so the asker's
  client handles both the same way (open the chat, fetch the keys, dismiss)
  and an offline device of the account still sees the outcome.
* **The cap is 32 per SIDE, not 32 incoming.** Theirs is `incoming` within
  its deadline; ours is `outgoing` (expired included), `accepted` and
  `refused`. Room is checked when a row is new or changes side: their
  `incoming` that our ask turns `accepted` needs a room on ours, our
  `refused` that their new REQUEST turns `incoming` one on theirs.
* **Transitions the design left open:** a REQUEST on an `accepted` row is
  answered ACCEPT and changes nothing (R1); a REQUEST on a `refused` or
  expired row is a fresh `incoming`; CANCEL deletes a lapsed `incoming`
  too; an accept or refuse of a lapsed row is 404, of any other state 409
  `request_state`; dismissing a live `incoming` is 409 (answer it), a live
  `outgoing` sends CANCEL and so needs `{from, payload}`, anything else is
  just deleted.
* **A `refused` answer also opens the plaintext query**, as a fresh
  `incoming` does: the requester may have closed it during a long wait.
* accept and refuse answer **202 `{msgid}`**, the ask **202 `{request}`**.

**Known wart:** a consent line dropped after the pacer took it (the session
ended, the write failed) raises `e2e_send_dropped` with a msgid that only
accept's and refuse's 202 carry; the ask's 202 names the request, not the
line. The request stays as written.

### cicchetto

* **The banner is the peer's asking only, pinned, not in flow.** It sits in
  a `.scrollback-pinned` band at the top of the pane together with the
  far-behind bar, which used to hold that container-anchored position
  alone: a column, so the two stack, out of `.scrollback`'s scrollHeight,
  so a request arriving never moves the reader, and zero pixels tall when
  empty. Green like the invite banner, per vjt. **On a phone it keeps clear
  of the floating ☰** (`.shell-chrome`, z 41): measured before the rule on
  webkit-iphone-15 (393 wide, ☰ at x 331–379, y 7–55) and
  chromium-pixel-touch (412 wide, x 350–398), Accept and Reject wrap below
  the text and were never covered, but the first line of the text ran
  under the ☰. The banner pads the side a float sits on by the float's box
  plus its inset on both sides, for as long as that float is mounted
  (`:has()` reads the mount, so a channel, whose TopicBar hosts its ☰ in
  flow, and a desktop keep the full width), and pads the leading side too
  when the left `#` door floats (window bar off).
  `issue2486-banner-clears-the-float.spec.ts` (`@webkit @touch`, three
  arms: bare, wallpaper theme, window bar off) pins it: the text's box
  meets neither float's, and Accept and Reject are the topmost element at
  their own centres. Positive controls: the trailing rule deleted, the
  text assertion goes red in all three arms on both projects (6/6); the
  leading one deleted, in the window-bar-off arm alone (2/2).
* **Our asking is ONE card in the query's timeline** (`E2eRequestCard`),
  a presentational row woven by its `at` like the invite acknowledgements
  and the `/topic` answer, so it never counts as unread and never moves
  the read cursor. It changes in place: pending (spinner, Cancel), refused
  (×), expired (Retry, ×; the expiry is derived, so it reads where the
  asking was made), accepted (normally never seen, because the chat opens
  by itself and the request is dismissed; if that failed, Open and ×).
  **Pending as a card is w2's reading, flagged in update C:** the ruling
  names the outcomes as cards and the incoming as the only banner, and
  does not say where our waiting asking goes. One card that changes state
  reads better than a banner that turns into a card once answered.
* **`accepted` is handled without a click**: the chat opens, the keys are
  asked for (`Engine.askKeys`, a KEYREQ under the existing budget that,
  unlike `rekey`, renews no session and writes no step), then the request is
  dismissed. The focus moves only when the user is in the query with that
  peer, where they asked; anywhere else the encrypted window just appears.
  A 404 on that dismissal is another device of the account getting there
  first.
* **A KEYS now names its chat in the drain's report.** Test-first found it:
  a KEYS that pins on first use emits no event, so the drain named no chat
  and the window read "none yet" until a message came. Every first KEYS used
  to arrive behind a message whose state change named the chat; `askKeys`
  is the first KEYS with nothing behind it.
* The client keeps its own clock on the deadline (`createRequestView`), one
  wake-up at `expires_at`, read afresh whenever the request changes, and a
  wake-up never reads as before the deadline it woke for.

### The branch's code review

Two read-only reviewers, one per half. Taken, each test-first:

* **Server.** A REQUEST crossing a REQUEST of ours that never arrived (R1);
  the 429 that promised room which never comes back, and a lapsed incoming
  holding a room (R3); a refused ask must write no REQUEST, which a refute
  on the fake server's lines could NOT say: right after registration its
  fake-lag bank is full, so even a line let go too early waits on a timer,
  and the state holding it is the one the refusal throws away. Measured:
  with the pacer committed BEFORE the row, the controller test with such a
  refute stayed green; the session test with the stub client whose bank
  reads empty went red. A LINELEN too short to frame a byte crashed the
  session on a `WithClauseError` (the caller read `no_session`): an
  upstream must not take a session down through a REST call, so
  `:too_large` is a refusal now (413). Three nits (a moduledoc citing a
  function that never existed, a spec the sweep broke, a 404 §4i claimed
  for a DELETE that answers 204).
* **cicchetto.** A fetch overwrote pushes that landed while it was out (a
  per-network change count now makes such a fetch read again), and a 404
  or 409 from a door left the request as held (it reads again); opening an
  accepted chat swallowed its failure and its view had no × (cic finding
  3), and a failure after Accept landed in an unmounted banner (4); the
  banner and the rail button kept one peer's busy and error state across a
  switch to another (each keys itself on network and peer); a door that
  outlived a logout wrote into the new account (`identityMoved` after
  every await); the view's `now` went stale; and a second click while the
  POST was out sent a second REQUEST.
* **Rejected: a database write inside a 5 s session call** (a write-lock
  stall turns a 504 while the session still moves the row). True, and
  shared by every session call that writes; not this slice's to fix.
* **Ruled by vjt:** R1–R4 above (the unanswered crossing, refusing
  without an identity, the status, where our outcomes go). The ☰
  covering the banner on a phone (cic finding 2) was measured and fixed on
  the banner, the one element R4 left pinned there.

### Tests

Server: the context's transition table, the cap, the sweep and the wire; the
session's four doors and four inbound verbs on the fake IRC server; the
controller's five routes; the parser's four verbs and the two `* → did`
answers. Mutation, every batch from a green baseline: context 19/19, session
S1–S17 (S8 survived and exposed the dead lane clause, now killed by the
pacer test), push 2/2, parser 3/3, controller C1–C8 each killed by the test
named for it; the review fixes each killed by the test written for them (the
room count's cutoff 3/3, the empty-bank refute, LINELEN 1/1); R1 11/11; R2
10/10, and `speak_for_user/5` without its spare-room guard turns exactly one
test red, the NACK's own half-room test (the ACCEPT path shares the guard,
written once). cic: about 45 mutants over the store, the banner, the rail
button, the engine, the client and the user topic, all killed; the review
fixes each killed (the mirror's change count 6/6, the `identityMoved` guards
every one, now 13 since a refusal awaits nothing before its door, the keyed
components 3/3); R2 2/2; R4: the card 15/15, the banner 2/2, the pane 4/6,
three of them killed only by tests written after they survived (a refused
card's empty actions row, Cancel's hold while a door runs, the peer's asking
hiding "no messages yet" in the empty query grappa opens). Two survive: the
pane's query gate is equivalent (no window but a query is named with a
nick), and `rowTime`'s case for the card is dead with the three beside it:
since #162's single pass sorted by `at`, an ephemeral row already woven is
never later than the next, so no ephemeral time decides a place (all four
removed: 382/382 green). Left for its own change. e2e:
`issue2486-encrypted-chat-request.spec.ts`, one test per acceptance bullet,
a bare IRC client reading the wire for "nothing before the confirm" and "no
CTCP VERSION" in both directions, and (f) grappa answering for the user,
`ACCEPT * → <the crossing device>` and `REFUSE * → <the asking device>`,
both `{"v":2}`; `issue2486-banner-clears-the-float.spec.ts` on the two touch
projects.
<!-- entry #2498 -->

---

## 2026-11-02 — #2498: the encrypted query's messages are the scrollback's lines

vjt, on staging: the encrypted query (`EncryptedChatPane`) drew its rows with
a layout of its own (`EncryptedRow`, a wrapping flex row): our nick read
"you", and a body too long for the rest of the line dropped below the nick
instead of flowing on beside it. Ruling: **one renderer.** The encrypted
rows go through the scrollback's, so a change to how a message reads lands
in every window at once, and what is specific to encryption becomes a
variant or a decoration of that renderer, never a parallel layout.

* **`ScrollbackLine` is exported, and it is the line.** Its input narrows
  from the wire row to `LineMessage`: the six fields a line reads, and an id
  of either store (the device's rows carry string ids, and only the
  scrollback's own list logic reads `data-msg-id` as a number). The pane
  maps its rows with `lineOf`: `in` and `out` are `privmsg` lines from the
  peer and from us, and `undecryptable` is the variant the renderer already
  had for encrypted messages that cannot be read, the `server_event` with
  `meta.e2e_undeliverable` (#2430's offline-queue row), with a count of 1.
  One wording in one place: the line now reads "sent you 1 encrypted
  message that cannot be read here", where the bespoke row said "an
  encrypted message".
* **Two slots, both required:** `marker` beside the time (the lock) and
  `trailer` after the body (an outgoing message's delivery state, an
  incoming one's other-key ⚠). The scrollback passes `null` to both, said
  at its call site, as `PaneTopBar`'s slots are.
* **Our nick is the network's nick, read live** (`ownNickForSlug`, the
  value MentionsWindow gets). An `out` row stores no sender, so after a
  rename of our own every earlier outgoing line shows the new nick, where a
  scrollback row keeps the sender it was written under. Accepted: giving
  the sealed device rows a sender is a chat-store format change, not this
  slice. While the nick is unknown no line is drawn, rather than an
  outgoing one naming nobody.
* **The line's controls came with it.** The nick on a line is the
  scrollback's button, so it does here what it does in any query: a right
  click opens the nick's menu (its verbs answer in the plain query with the
  peer; we hold no modes in a query), and a click opens the nick's query,
  except the peer's own. In any query a click on the peer lands in the
  window already open, and here that window is the encrypted one, so the
  click stays put: a first cut that opened the nick's query sent a click on
  the peer to the PLAINTEXT query, compose box and all. The menu's Query
  item stays the deliberate way there. `createLineActions` builds the set
  once for both panes, ScrollbackPane's three handlers and its menu state
  moved rather than copied, and takes the network id from the pane.
* **The "2486 outcome cards" the ruling lists needed nothing here.** Our
  asking's card (`E2eRequestCard`) is already a row of the plaintext
  query's scrollback, woven at the request's `at`, and never shows in the
  encrypted pane; the pane's own cards are the key-exchange steps, which
  are cards and not rows.
* **What stays the pane's:** the list that holds the lines (`.e2e-rows`,
  given the scrollback's padding and line height, but not the `.scrollback`
  class, which carries the scroll gate and the touch-selection rules
  ScrollbackPane drives), the step cards, and the compose line, kept for
  the reason its moduledoc gives.
* **Deleted with the row:** `EncryptedRow`, its `<ol>`/`<li>`, and the CSS
  that only it wore (`.e2e-row`, `.e2e-row-own`, `.e2e-row-notice`,
  `.e2e-row-state`, the last now the global `.muted`).
* **Why the code still grew** (about +100 lines of source, CSS −14): the
  row was a self-contained 55 lines with dead nicks; what replaced it is the
  adapter onto the shared line, the two slots and the `LineMessage` type,
  and the line actions, now one exported factory where they were private
  to ScrollbackPane. The parallel layout is gone; the growth is the
  behaviour the encrypted lines gained (a nick that opens a query, the nick
  menu, mention highlight) and the seams that let one renderer serve two
  panes.

### Tests

Unit: the pane's messages are `scrollback-line`s, each read as its kind and
the nick it names (ours as the network's nick, never "you"), with the time
`formatTime` gives, the lock, the delivery state, and the undeliverable
wording; the search and the other-key ⚠ read the same lines. They were run
red before the change, three failing on the missing lines. The peer-click
rule and the unknown-nick gate each have a test, and each test is the one
its mutant turns red (the peer check removed; the gate passed a blank
nick). e2e:
`issue2498-encrypted-lines.spec.ts` holds a long encrypted line, on both
sides, against a channel line of ours: the same computed box (display,
white-space, font, line height), `<ournick>` as sender, and the body's
first line box beside the nick rather than a line below it, with the
premise that the body spans two lines or more pinned. The encrypted
fixture's `row(page, "in" | "out", text)` now finds `privmsg` lines in the
pane, "out" being the ones that carry a delivery state; `data-row-kind`
went with the row.
<!-- entry #2499 -->

---

## 2026-11-02 — #2499: an encrypted query's rail is the query rail plus its keys

vjt, on staging: the right rail of an encrypted query (`EncryptedRail`,
#2485) showed only the key and trust sections, and the peer's WHOIS card
every plain query rail shows was gone. Ruling: **the WHOIS card belongs in
the encrypted rail too.** The encrypted rail is the normal query rail, the
same card through the same component and data path, PLUS the encrypted key
sections: an addition, not a replacement, and no second card.

* **One query context, one slot, the card last.** `RailContext` renders a
  `QueryContext` for both windows: a heading, what the window adds, and
  the peer's `WhoisCard`, fed by the per-nick `railWhois` cache (#606).
  The heading is a required prop and says which conversation it is
  ("private conversation with", "encrypted conversation with", the
  wording #2485 shipped); `EncryptedRail` draws none of its own, or the
  rail reads two. What the window adds is the one required `controls`
  slot under the heading: the plain query's "start encrypted chat" button
  (#2486), or the encrypted query's key sections. The door stays out of an
  encrypted window, which already is one.
* **The key controls above the card, a choice made in the slice and not
  ruled.** The card renders nothing until the WHOIS answers, seconds after
  the window is shown (the fake-lag cost below), so whatever sits under it
  moves down by its height when it lands. A first cut with the keys under
  the card moved verify, copy and the pin form just as the user reached
  for them. Above the card they hold still, which is where the plain query
  already kept its door. Noted for vjt.
* **The data path follows the card.** The fetch stays the #782 rule, asked
  only while the card is on screen and the cache has nothing for the nick,
  and its key now covers an encrypted window's peer. A user's own `/whois`
  for that nick refreshes the rail card as it does in a plain query. Both
  read one `railPeer()` (`lib/railPeer.ts`), the one answer to which nick
  the rail is showing, rather than the fetch key and `userTopic`'s
  `railIsShowingNick` each deriving it.
  The cost is the plain query's: one WHOIS per nick, which bahamut charges
  against the same fake-lag bank as the user's next line (measured on #944
  at about 2 s). Paid on purpose, as the ruling asks for the card.
* **One scroller.** The key sections render inside `.rail-query-context`,
  which owns the rail's scroll and its touch rules (#984), so the
  `.rail-e2e` copies of those rules were dead and are gone. The WHOIS
  fields stack in the rail, as they do in a plain query's
  (`.rail-query-context .whois-card-fields`, #857).

### Tests

Unit: `RailContext` mounts the query context in an encrypted window, one
heading saying "encrypted" and the key sections above the card, a fresh
one per peer, no door, and asks the WHOIS for each peer; off screen it
asks nothing and on screen it does. A plain query keeps its door above
the card. `EncryptedRail` draws no heading. `userTopic` routes a user
bundle for an encrypted window's peer into the rail cache. Each was seen
red before its change. Mutants, each read red and restored: `railPeer`
blind to encrypted windows turns three tests red (the two encrypted
`RailContext` ones and `userTopic`'s); the card above the controls turns
two (the plain query's order and the encrypted one's); the encrypted
heading worded "private", and an `<h3>` put back in `EncryptedRail`, one
each. The `RailContext` test that pinned "no query context and no WHOIS"
in an encrypted window encoded the defect and was rewritten. e2e:
`issue2499-encrypted-rail-whois.spec.ts` opens an encrypted query with a
bare IRC peer and reads the rail: exactly one heading, saying encrypted;
the card naming the peer, no ×, the rail's stacked fields; the key
sections above the card; and no door.
<!-- entry #2497 -->

---

## 2026-11-02 — #2497: a nick that is not on the network says so, in the encrypted query too

vjt, on staging while testing e2ee: writing to a nick that does not exist
showed nothing. Measured on the testnet before any code (a throwaway probe,
three ways of writing to a ghost): the plaintext query shows the 401 as it
always did (`cp13-s5-msg-ghost-401.spec.ts`); the encrypted query
(`/equery`) showed "waiting for keys" for 90 s and then "no keys came from
the peer"; asking a ghost for an encrypted chat (#2486) put the 401 in the
query and left the card "Waiting for … to accept" for 24 h. So: e2ee only,
and no code path ever carried it: not a regression.

**Where the 401 went.** An encrypted message to a nick with no pinned key
waits for keys and sends a KEYREQ, an E2E line inside a PRIVMSG; the ircd
answers it 401. The encrypted query lives in cic only (2430), so no query
window is open on grappa, and #640's gate files the reply under `$server`,
correctly: a reply never opens a window. Nothing then reached the window
that was waiting, and the asking had no hook on a 401 at all.

**The fact goes typed, for every 401 that names a nick.** `no_such_nick
{network, nick}` on the user topic (protocol 54), read off the router's
decision BEFORE the #640 gate, since the nick is absent wherever its row
lands. Typed because cic never parses IRC: reading `raw_params` off a
`$server` row would be exactly that. For every such 401, not only those
answering an E2E line, because grappa does not know which windows a client
has, and tying a 401 to the line it answers would need per-target
bookkeeping of what went out: the push is rare and cheap. Not for a 401
naming a channel, nor for the one a WHOIS folds into its bundle (the card
says it).

**cic fails what waits for the nick's keys, and nothing else.** As
`no-such-nick` ("not sent: there is no such nick on the network"), and it
stops asking the nick for keys, drops the nick's KEYREQ budget (nobody
answers a KEYREQ to a nick that is not there, so the next message asks at
once and its own 401 fails it at once) and gives up on keys the user asked
for again. A message a device already took is not judged, even while a copy
of it waits for another device: the 401 does not say which line it answers,
and failing a delivered message is the opposite lie.

**The push overtakes the send, and the account lock is what orders them.**
The 401 follows the KEYREQ's 202 by one ircd round trip, while the send that
queued the message is still storing it. A first version gated the glue on
`waiting`, which the send writes only when it returns: the review caught
that the push was dropped there, and a unit test firing the push beside an
unawaited send read the row "queued". No gate, then: like the other pushes
(`e2e_send_dropped`), the step takes the account lock, so it runs once the
send has stored what it queued.

**The asking ends: our live `outgoing` request goes** (`E2eRequests.absent/2`,
`e2e_request_gone` on every device). Deleted rather than a new stored state:
the 401 is already a row in the query the user asked from, which says why,
and a state would mean rebuilding the table for its CHECK constraint. An
expired asking, the peer's asking and an answer stay. **The accepted price:**
a peer who got the REQUEST and has since quit ends the asking too; on their
return they ask afresh, or the nick is someone else's.

**Known gaps, not bugs to rediscover.** A message a pinned peer's device
took before the peer quit still reads "sent": nothing ties the 401 to it.
And the ask's 202 travels by HTTP while `e2e_request_gone` travels by WS: a
gone pushed ahead of the 202 would let cic put the card back until the next
reload. It needs the 401 to beat a local HTTP response across an IRC round
trip and the E2E pacer, and was not seen.

Tests: server, a real session over `IRCServer` (the KEYREQ's 401 lands on
`$server` and pushes `no_such_nick`; a channel's 401 pushes nothing; the
asking ends on its peer's 401 and every other request stays), the plan
alone in `E2eRequestsTest`; cic, the engine (fails what waits, keeps
another nick's queue and a delivered message, ends a re-key), the glue
(a waiting message turns failed, also when the push overtakes the send;
with nothing waiting, nothing changes), the user topic arm, and the boundary
census.
Each read red against a mutant of its own. Server, 5 of 5: no push (3
tests red), the asking not ended (1, its own), any 401 target pushed (1,
the channel case), any row deleted (2, the plan and the session; an expired asking deleted
is red in the session test too since it waits past the last commit), and the
hook read AFTER the #640 gate (4: with no query window the push never
fires, which is precisely the encrypted query). cic, 9 of 9: `absent` a
no-op (3), the outq kept (3), `keysAwaited` kept (2), the re-key not ended
(1), delivered messages failed too (1, its own), every waiting copy
reported regardless of delivery (2, the partly delivered case among them),
the `waiting` gate put back (1, the overtaking push), the glue ticking
instead (1), the user-topic arm dropped (1).
e2e: `issue2497-no-such-nick.spec.ts`, (a) the encrypted query's row fails
at once with that reason, well inside the 90 s it used to wait, and (b) the
asking ends (no card, the rail button free) with the 401 under it. Its red
arm is the probe's own reading at `fa5c59ace`: the row still "waiting for
keys" after 12 s, the card still pending after 10 s.
<!-- entry #2500 -->

---

## 2026-11-02 — #2500: the media viewer lays out below the pane's top bar

vjt, on an installed iPhone PWA: a very tall picture, the aspect ratio of
the screen, opened in the media viewer with its top edge under the bar at
the top of the window, where it could not be tapped. Ruling: the picture's
height stops at the **bottom edge of the bar carrying the channel name**;
its top never sits under that bar; it may run on past the bottom of the
screen. Measure the bar, safe-area inset included, rather than hardcode it.

* **Cause.** `.media-viewer-modal` centred itself in the WHOLE viewport
  (`top: 50%`, cap `--viewport-height - 2rem`, media cap `- 8rem`). Under
  `black-translucent` the viewport starts behind the status bar, above the
  shell's safe-area padding and the bar the shell puts below it, so a
  height-bound picture's top landed ~70px from the physical top: inside the
  ~59px inset plus the bar. Playwright resolves `env()` to 0, and at 0 the
  8rem allowance happened to clear the bar, which is why nothing caught it.
* **The frame.** `lib/mediaViewerFrame.ts` measures, when the viewer opens,
  the bottom edge of the pane's top band and writes it on the dialog as
  `--media-viewer-top`. The band is three classes, because three hosts draw
  it: `.topic-bar` (`PaneTopBar`: the channel bar and the admin console's),
  `.mentions-header` and `.e2e-header` (the encrypted query), the last two
  predating the shared band. The sheet cuts `--media-viewer-frame` from
  `--viewport-height` below it, and every size that spoke about the viewport
  speaks about the frame instead, margins and allowances unchanged: the
  modal cap, the media cap and the #2188 floor (which keeps that floor and
  the cap on one number, the invariant its note states). `top` is the middle
  of the frame, `top + frame / 2`: equal to `50% + top / 2` wherever
  `--viewport-height` is the layout viewport's height, so with nothing to
  clear it is the old `50%` to the pixel, and spelled off the frame for the
  viewer opened while the soft keyboard is still leaving, where `50%` of the
  layout viewport would centre the modal low against a cap cut from the
  visual one (the review's catch; it cost the keyboard-up open exactly one
  `top` of visible picture). The centring stays in `transform`, so the
  dismiss drag, which restates it, needed no change.
* **Measured, not a constant**, because the bar's edge already folds in the
  inset, the iOS 27 band (#2190) and a topic that wraps, and JS cannot read
  `env()` back out of the custom property (the #913 note). Taken in
  `onMount`, NOT in the dialog's ref: a rotation across the mobile
  breakpoint swaps Shell's whole branch with the viewer open, and Solid runs
  the new branch's refs while the old branch is still in the document, so a
  ref-time measure reads the shell about to go; `onMount` runs once the new
  nodes are in and still before paint. Again on a resize of the pane or the
  bar (a wrapping topic; a padding change that does not cross the
  breakpoint). A window switched under the open viewer keeps the old line, a
  bar's height off at worst. `max(pane top, bar bottom)`: the admin console
  scrolls with its bar inside it, and a bar scrolled away must not pull the
  frame up.
* **Choices the ruling did not make**, declared:
  * **The mentions window and the encrypted query too.** The ruling names
    the channel bar; a picture under the mentions header's ✕ is the same
    defect on another window.
  * **Windows without a band** (a query, the server window) start the frame
    at the pane's own top, which still clears the inset, where iOS takes the
    touches. On a desktop browser that is 0: unchanged.
  * **The desktop shell too.** The ruling names no platform, and the
    installed iPad PWA runs the desktop shell with the same inset. On a
    desktop browser the viewer now centres below the channel bar: a
    screen-shaped picture loses about one bar of height.
  * **The licence to run past the bottom is not taken.** It would mean
    anchoring the viewer to the top of the frame instead of centring it,
    which moves every picture that already fits. A tall picture therefore
    stops a margin short of the bottom, as it did before.
  * **The #2188 floor follows the frame**, so in a window with a bar the
    box around a small picture is half the frame high, not half the screen.

### Tests

Unit: `mediaViewerFrame.test.ts` pins which edge is read in which window
(each of the three bands, no band, a band scrolled above the pane, no
shell); `MediaViewerModal.test.tsx` that the image, video and audio arms
write the measured edge on the dialog, and that a shell swapped under an
open viewer is measured from the NEW shell (the ref-time measure fails it,
reading the old bar); `mediaViewerSizeFloor.test.ts`'s pins moved from
`--viewport-height` to the frame. e2e:
`issue2500-viewer-clears-top-bar.spec.ts` stubs `--safe-area-inset-top` at
59px (the device condition; the discriminating input, see Cause), uploads a
picture with the viewport's aspect ratio, and asserts the picture and the
viewer's header sit wholly below the bar's bottom edge and the picture stays
on screen, on iPhone 15 and Pixel 7 and on desktop chromium; on the phones
it then grows the inset by 60px under the open viewer and asserts the viewer
follows the bar down (more than the ~32px margin above the header, so a frame
frozen at open fails it). Not proven
here: the inset a device really reports, the iOS 27 band on top of it, and
the look; that leg is the device's.
<!-- entry #2501 -->

---

## 2026-11-03 — #2501: the media viewer and the mini player trade their download for share, and the viewer's verbs share one look

vjt, on an installed iPhone PWA: in the media viewer's header (1) the
download link (`a.media-viewer-download`, `download=""`, #2468) opened an
iOS preview window the reader could not leave, so the PWA was stuck there;
(2) "open in browser" and share did not look alike, share a `<button>` that
read smaller and had no underline. Ruling: remove the download entirely,
because share covers it (the iOS sheet carries "Save Image"); give "open in
browser" and share the same look: the same font size, both underlined, both
a little larger than "open in browser" was. Keep the `gone()` gate and the
`canNativeShare()` feature-detect as they are.

* **Removed with the anchor:** its `.media-viewer-download` style, the
  `isSameOrigin` gate in `MediaViewerModal` that only it needed, and the
  `download` clauses in `isSameOrigin`'s and `mediaAvailability`'s notes,
  which now speak of fetches and share alone. The #2468 comment beside share
  says why there is no download. Where there is no Web Share (desktop
  Firefox, Linux Chromium) the header now has no save verb at all: the
  picture keeps its own context menu and "open in browser" keeps its tab.
* **One rule for the verbs:** `.media-viewer-open-external`,
  `.media-viewer-copy`, `.media-viewer-share` take `font: inherit`, then
  `font-size: var(--font-size)` and `text-decoration: underline`; the two
  buttons keep a rule of their own that strips them to their text. `font:
  inherit` comes first so a `<button>` takes the weight and line height the
  anchor inherits rather than the UA's (the family it already inherited,
  through `font-family: inherit`), and the underline is stated because a
  button has none to inherit.
* **The "smaller" is not diagnosed.** Before this change the two controls
  already computed to the same size, 0.9rem each (12.6px at the default), so
  what read smaller on the iPhone was not a computed font-size difference,
  and nothing here identifies what it was. The difference on main that the
  e2e arms below did measure is the underline. The fix is not verified on a
  device.
* **The mini player too (vjt's ruling on the PR).** `AudioMiniPlayer`'s ⬇
  was the same `download=""` anchor, the one the viewer's had been copied
  from, so on an iOS PWA it very likely dead-ended the same way (not verified
  on a device). It is now a share button (`.audio-mini-player-share`)
  running the viewer's flow: `createMediaSharer` in `lib/mediaShare.ts`,
  lifted out of `MediaViewerModal` rather than copied. A sharer is built per
  SUBJECT: the viewer builds one per open, and the player, which outlives
  every source it plays, one per source, so what a sharer remembers (a share
  in flight, a refused file) lives exactly as long as the thing shared.
  Kept from the download: the `!live()` gate (a source with no end is no file
  to hand over) and its place outside the readout, so a file the browser
  cannot decode can still be handed to something that can. Added: the
  `canNativeShare()` feature-detect every share door uses; an abort when the
  source closes or changes, so no sheet opens for a track that is gone; and a
  toast for a failure (`audioShareToasts`, on the app's one toast surface),
  because the bar has no status line and a share that does nothing is the
  inert control #1839 refused. The anchor-only CSS rule went with the anchor;
  the button sits in the transport row's shared rule. The refused-file
  sentence now reads "share again to send the link" at both doors, since the
  bar's control is a glyph and not the word.
* **What the bar loses, and it is a question for vjt.** The ⬇ rendered on
  every browser; share renders only where Web Share exists, so on desktop
  Firefox and Linux Chromium the bar now offers no save at all. That also
  removes #1744's remedy there: a track the browser cannot decode (an AAC
  voice memo on a Chromium without proprietary codecs) can only be saved from
  the scrollback link. The viewer lost the same thing on the same browsers,
  but keeps the picture's context menu. Not decided here: keeping the anchor
  as the fallback where share is absent would bring the save back without
  reaching iOS, which always has Web Share.
* **Audio is the share likeliest to outrun the activation window.** The
  bar's `<audio>` preloads only metadata, so a share fetches the whole track
  at the tap, where an image is a cache hit. A long track on a slow link is
  therefore where the refusal, then "share again to send the link", is most
  likely. Not measured on a device.
* **Choices in that which vjt did not rule:** the glyph ⤴ with
  `aria-label="share"` (the bar's controls are glyphs, and the word would
  widen a 2.5rem square on a phone bar that is one row), and the toast as the
  failure channel.
* **Ruled on the PR (vjt):** the size stays `var(--font-size)` (14px at the
  default, up from 0.9rem, 12.6px): "a little larger" as the step up to the
  size the rest of the app's text uses, the ✕ beside the verbs included.
  Copy, which appears only on a text file and shared share's rule until now,
  joins the look.

### Tests

Unit: the three download tests became one, run on an own image, an own
video and a cross-host image: no `download` link and no element carrying the
attribute, with "open in browser" and share present as the control; the
`gone` test keeps share only. It was red before the change on the two own
uploads. e2e: `issue2468-viewer-download-share.spec.ts` is renamed
`issue2468-viewer-share.spec.ts` and loses its download leg; two tests
(desktop chromium, and iPhone 15 + Pixel 7) read the computed look of "open
in browser" and share: equal font size, both underlined, larger than 0.9 of
the root size, the same colour, family, weight and line height, and nothing
carrying `download`. The text viewer's phone test holds copy to the same
look. A computed-style read that fell back to defaults on the iPhone engine
(#963) fails at the underline, since a UA button has none and neither has
the initial value, so no separate calibration is kept.

e2e arms, `--grep "issue2468|issue2501"`, 6 tests over chromium,
chromium-pixel-touch and webkit-iphone-15, each arm's bundle checked in the
served dist by its content-hashed CSS and the rule body:

* **A**, the branch's first three commits on `60f67c7b2`, before the rebase
  onto #2500: 6 passed.
* **B**, main's `default.css` under the branch's component: 5 failed, every
  one at the underline (share's `textDecorationLine` is `none`); the 2468
  share test stayed green.
* **C**, the branch with only `font-size` back to 0.9rem: 5 failed, every
  one at the step up, `> 12.6` against `12.6`. Both engines read the old rule
  back as exactly 12.6px, so the strict `>` on the 0.9 × 14 boundary is not
  vacuous.

The arms ran before the review added the colour, family, weight and line
height comparison, which sits after the asserts B and C stopped at, and
dropped the calibration; that comparison has no red arm. Main's component
was not run in e2e: its download anchor is pinned red-before-fix by the unit
test, and in e2e it would stop every test at the download count, before any
look assertion.

Mini player, unit (`AudioMiniPlayer.test.tsx`): the five download tests now
expect share, present for a file and after a decode failure, absent for an
endless or a failed live source. A 2501 block adds: no share without Web
Share; an own upload's FILE goes out; a refused share is named in a toast; a
dismissed sheet says nothing; a source closed mid-fetch opens no sheet; a
source swapped mid-fetch opens no sheet for it and the next source still
shares; a refused file turns only that source to its link, not the next one.
8 were red on the old component (the three absence tests pass there by
construction). Mutants, each on one axis, each killed by the test that names
it: the live gate, the feature-detect, the abort on a source change, the
controller not renewed after it, the sharer kept across sources, and the
toast. The viewer's share tests and the mini player's now share one Web
Share stub (`__tests__/helpers/webShare.ts`). `Toasts.test.tsx`: the share failure
reaches the stack and dismisses. e2e: the audio journey in
`media-link-modal-viewer.spec.ts` asserts nothing on the bar carries
`download` and that share hands over the served file, named, typed and sized
as the route served it; the recording Web Share stub moved from the 2468
spec into `e2e/fixtures/webShare.ts`. None of the mini player's e2e has run
locally; CI's integration run is its first.
<!-- entry #2505 -->

---

## 2026-11-03 — #2505: a rail row's name follows the glyph that opens it

In the left rail, a row that opens with a glyph showed its name at the
right edge, next to the ×: the 🔒 rows of encrypted queries (vjt's report,
iOS PWA), and, by the same cause, the 📇 "channels" row and the @ mentions
row. Plain rows, which open with the name, were fine.

* **Cause.** The per-network row button laid out its children with
  `justify-content: space-between`, which pushes the first child to the
  left edge and the last to the right. With a name and one badge that is
  the intended look; with a glyph and a name it puts the name at the far
  end. The `.sr-only` "(encrypted)" is absolutely positioned and takes no
  part in the layout, so an encrypted row with no unread count has exactly
  two flex items.
* **Cure.** In non-header rows the name takes the free space after itself
  (`margin-right: auto` on `.sidebar-channel-name`), so it follows whatever
  opens the row and the badges still close it on the right. The base rule
  packs from the start (`justify-content: flex-start` instead of
  `space-between`), so the header row's own `flex-start`, which existed only
  to undo `space-between` (UX-5 BT), goes. The header is left out of the new
  rule: its badges follow the slug. The base keeps an explicit `flex-start`
  rather than none because `ux-5-bt-narrow-chrome-compression.spec.ts` pins
  the header button's computed `justify-content` to `flex-start`, and the
  initial `normal` packs the same way but reads differently (the code
  review caught it before CI did).
* **Choices vjt did not rule.** The 🔒 takes the leading-glyph class the 📇
  and @ rows carry (`.sidebar-network-emoji`: 0.4rem before the name, never
  shrinks), instead of touching the nick. Two badges on one row (messages
  and events) now sit together at the right edge; under `space-between` the
  first floated to the middle of the free space. Same cause, same cure.

### Tests

e2e `issue2505-sidebar-row-glyph-alignment.spec.ts`, desktop chromium: an
encrypted query and the channel directory row each put their glyph at the
column where a plain channel row's name starts, and their name after the
glyph by at most the glyph's width; a plain row's unread badge still ends
at the button's right padding. `$list` is mirrored and pinned in
`e2eConstantMirrors.test.ts`. jsdom has no layout, so the spec is the only
test of the cure. **Not run locally** (the stack lane was not free): the
red is argued from the rule above, not seen, and CI's integration run is
the spec's first.
<!-- entry #2512 -->

---

## 2026-11-03 — #2512: the encrypted query is the scrollback pane and the compose box

vjt's order on 2512: the encrypted query must REUSE `ScrollbackPane` and
`ComposeBox`, not reimplement them, and two bugs were to vanish as a
consequence: a chat reopened with more lines than fit did not land on its
last line (reported from the iOS PWA), and the compose line did not wrap (it
was an `<input type="text">`). Both were the window's own copies of what the
pair already does: its list (`.e2e-rows`, a flex item with no
`min-height: 0`, the very WebKit quirk UX-6 bucket D fixed on `.scrollback`)
and its one-line compose. This reverses #2430's "not ScrollbackPane +
ComposeBox, on purpose": the coupling it named is now a seam, and the
plaintext-at-rest concern it named is handled inside the compose box.

* **`ScrollbackSource` (`lib/scrollbackSource.ts`) is where a pane's lines
  come from.** The pane reads every line, the read cursor and the own-send
  signals through `props.source`, never from `lib/scrollback` directly.
  `grappaScrollback` is grappa's, handed by Shell to both mounts; the
  encrypted pane builds its own. The members keep grappa's verb names, so
  the pane reads the same with either behind it.
* **`history: null` means the source holds every line:** no older page at
  the top, no newer page at the bottom, no catch-up refresh on the way back
  to the tab, no far-behind region, no jump. The encrypted chat lives on the
  device; a grappa `/messages` for `$e2e:<nick>` would ask for a window
  grappa has never heard of (and a 4xx feeds fail2ban, grappa-irc#160).
* **Lines are numbered in the window, in the order it first sees them.** The
  device's rows carry string ids, and the pane orders, marks and reads by a
  numeric id. A row's number never changes while the window lives, and the
  rows only grow at their end (a deleted chat starts over, past every number
  already given), so the numbers keep the chat's order. #2498's
  `LineMessage` (a line with an id of either store) goes with them: the
  line is a `ScrollbackMessage` again.
* **Read state changes meaning: the chat is read at its tail, like any
  window, not "while shown".** The chat store counts what is unread rather
  than keeping a cursor, so the source derives one: the last line before the
  last `unread` rows that count (`countsAsUnread`, now exported from the
  chat store). A key event the badge counts (an alarm, the peer asking to
  compare emoji) is no line and marks none; every line unread is cursor 0.
  The pane's settle calls the source's `setCursorIfAdvances`, and the chat
  is marked read only once that id is its last line: the count has no way to
  record "read up to here", so a partial read records nothing and the badge
  stays. The window opens on the unread marker, as a query does.
* **A send reads the chat** (`sendEncrypted`), as a send reads any window,
  and announces itself as grappa's sends do: `encryptedSendSubmitted` at
  Enter, `lastEncryptedSend` once the chat is read, the two signals the
  pane follows to the tail and re-latches its marker on.
* **The compose box, in an encrypted window** (`lib/compose.ts`): everything
  typed goes to the peer through Olm as ONE message, newlines and a leading
  slash included, asked before any verb is parsed, so nothing typed there
  can reach grappa's send door in clear; a failure that never reached the
  engine hands the text back and logs why. The draft is never mirrored to
  `sessionStorage` (#772's reload mirror): no plaintext at rest, and a
  reload loses it, as the old line did. No frame-split preview: the engine
  sizes the message and says "too long" on the row. The history the up
  arrow walks lives in this tab's memory.
* **A deleted chat takes its window's draft and history along**, or the up
  arrow would bring back what the delete promised nobody could.
  `deleteEncryptedChat` publishes the window (`encryptedChatDeleted`) and
  the compose store drops it, so both doors (the shredder, the ×'s Delete)
  and any later one are covered by construction. The doors could not do it
  themselves: `compose` imports `commands/window`, which imports
  `encryptedWindow`, so the × door importing `compose` is a cycle (biome's
  `noImportCycles` said so). **Known gap:** another tab of the same browser
  keeps its own in-memory history until it reloads; the BroadcastChannel
  says a chat changed, not that it was deleted.
* **No uploads.** The upload host is not end-to-end encrypted, so
  `triggerUploads` refuses an encrypted window at the door every surface
  shares (picker, paste, drop, the share target) and says why in the
  compose box; the picker is not offered. The paste guard (#666's flood
  confirm) is skipped there: a pasted block is one message, so there is no
  burst, and the guard's way out, the block as a `.txt` upload, would put
  the plaintext on the upload host.
* **The nick menu answers in the plain query with the peer.** The pane's
  menu targets the peer's query for an encrypted window: the encrypted one
  takes no command, and a verb there (a CTCP, a ban) would otherwise aim at
  `$e2e:<nick>`. A click on the peer's nick stays in the encrypted window
  (#2498). The line controls are back inline in `ScrollbackPane`:
  `createLineActions` (#2498) existed to share them with the encrypted pane,
  which now IS a `ScrollbackPane`.
* **The mobile next-active button is the pane's.** An encrypted window now
  carries a `ScrollbackPane` and so its float stack's button; Shell's bare
  mobile one is gated off for it too, so exactly one mounts. That likely
  also cures what #2510 reports about the button's look in this window; not
  claimed here.

**Why the code ends where it does.** The window's own list, scroll effect,
"read while shown" effect, draft, send and form go (with `.e2e-rows`, the
compose-line CSS and the line-actions factory), and the pane gains
everything the pair does that the copies never did: the unread marker, the
floating buttons, a wrapping text area, history. Production code still ends
about 150 lines up, in two places: the seam (76 lines, half of it the
contract's own docs), and the encrypted window's rules at the compose box's
doors (dispatch, the reload mirror, the frame preview, the delete, paste,
upload, placeholder, picker; about 70) plus the signals they read (36).
Those doors exist because the compose box has them; the bare input had none
to guard.

Tests: the pane's source seam (`ScrollbackPane.test`: a source holding
every line is drawn with its slots, gets the reader's progress, and pages
nothing); the encrypted pane (opens on the marker past a counted alarm and
an uncounted pin, reads only once the last line is seen, pages nothing from
grappa, the menu's CTCP answers in the plain query, the compose box sends,
wraps and recalls); compose, paste, upload, placeholder, ComposeBox and
encryptedChats each on their own rule. Every new rule read red against a
mutant of its own, 17 of 17, each turning only its own tests red (the
dispatch branch three, the paste guard two, the pane's null history a
crash in its own test). e2e: `issue2512-encrypted-scrollback.spec.ts`, two
browsers on the real ircd. Alice sends 16 messages long enough to wrap, leaves
for a channel and comes back: a hit test at the top and the bottom of the last
line must land on that line, and the first line out of sight is the premise.
On desktop the compose box must be a text area that does not run sideways and
grows to two lines on a draft the channel's box wraps. On both phones, with a
plain query unread, there must be exactly one next-active button, inside
`.scrollback-float-stack`. The spec reads only Alice's window, and only once
grappa has taken every line ("sent"). The first draft waited for Bob to
receive them and timed out, for two reasons that bind any encrypted spec:
grappa's E2E pacer lets at most 3 lines reach one recipient in any 6 s, plus
fake lag, so the peer's copies trail by minutes; and the engine holds at most
16 messages waiting for keys (`OUTQ_MAX`), so the first line goes alone and
the rest follow once the session exists. Its red arm at `60f67c7b2` (the
window's own list and input, the spec's compose locator pointed at the old
input): chromium red on the compose box (`INPUT`, running sideways),
chromium-pixel-touch and webkit-iphone-15 red on the button (exactly one, the
bare Shell one, outside the float stack). **The reopen read GREEN on all three
projects on the old code, webkit-iphone-15 included.** Playwright's WebKit does
not reproduce the iOS report, so that arm guards against a reopen that misses
its last line where the bench can see one; it does not prove the reported bug
cured. That cure is argued from the removed `.e2e-rows`, not measured.
<!-- entry #2506 -->

---

## 2026-11-03 — #2506: the encrypted rail's buttons fit their content, and its WHOIS card its edges

Two things vjt saw in the encrypted query's rail on his phone: the buttons
(`pin`, `copy your key`, `add a device`) much taller than one line needs,
"roughly twice the height of the `paste their key` input, and more"; and
the peer's WHOIS card, under the key sections, with a left edge further in
than the peer card and `your identity`.

* **Measured before anything changed** (the spec's first run, on CI, since
  no browser runs on the worker host and the stack lane was busy): on
  desktop chromium, Pixel 7 and iPhone 15 WebKit, the input and all three
  buttons were **44.0px**, the `--tap-min` floor (#306) that the global
  form-control rule and the e2e button rule both carry; the WHOIS card sat
  **7px** inside the key sections on both sides. So the margin reproduced
  and the "twice the input" did not: off-device, buttons and input are the
  same height. What the PWA draws on vjt's iPhone is not measured here.
* **WHOIS card.** It carries the scrollback overlay's 0.5rem margin. In the
  rail, `.rail-query-context .whois-card` takes none horizontally, like
  `.rail-e2e-section` and `.rail-server-info` since #1737 moved the rail's
  inset to `.shell-members`. A plain query's rail aligns the same way; the
  scrollback overlay keeps its margin.
* **Buttons, vjt's ruling** (asked with the 44px in hand): sized to their
  content, the input keeps its 44px. The rail's key buttons (`.e2e-copy`,
  `.e2e-pin-submit`, `.e2e-sas-button` under `.rail-e2e`) drop the floor
  and take one line plus the input's own 0.5rem above and below; `pin`
  stretches to the input on the `.e2e-pin` flex row, so the row still lines
  up. This goes below the 44px tap-target minimum on a phone, knowingly.
  The chat body's step card and the request card keep the floor.
* **Choices vjt did not rule:** the 0.5rem vertical padding (the input's);
  the comparison and alarm buttons ("verify by comparing emoji", "take the
  ignored key") follow the three named ones, since they are the same rail's
  buttons and one look is the point.

### Tests

e2e `issue2506-encrypted-rail-geometry.spec.ts`, on desktop chromium and in
the phone drawer (Pixel 7, iPhone 15), every box read in one frame and
attached to the run: `pin` as tall as its input; `copy your key` and `add a
device` one line of text with a content box at most 1.6 of the font size;
the WHOIS card on the key sections' left and right edges. Its first version
(no button floor asserted) ran red on CI on the margin alone, 7px on all
three engines; the content-box assertion was written after that run, and is
red on the measured old rule by arithmetic (44px content against 22.4px),
not by a run. jsdom has no layout, so the spec is the only test of either
change.
<!-- entry #2508 -->

---

## 2026-11-03 — #2508: the query rail opens an existing encrypted chat

A plain query's rail always offered "start encrypted chat" (#2486), even
when an encrypted chat with that peer already existed on the network, and
pressing it asked the peer to start a second one. vjt's ruling, on the
issue: with no chat yet, unchanged; with one, the button becomes **chat
securely** and simply opens the existing 🔒 window, with no request and no
confirm.

* **"Exists" is the device's chat index's word** (`encryptedChat(slug,
  nick)`, `lib/encryptedChats.ts`), open or closed. A chat closed with its
  messages kept counts; so does the closed, empty entry a bot's identity
  check leaves (`ChatChange` `check` op). In both the device already holds
  an encrypted conversation with that nick, and opening it is what the
  ruling wants instead of a second asking. A chat deleted from the × is
  gone from the index, so the asking comes back.
* **One door.** The button calls `openEncryptedWindow`, the verb `/equery`
  and the nick menu use, with the nick spelled as the index has it, so the
  window opened is the one the sidebar lists.
* **Reactive.** The button reads the index's signal: a chat that comes to
  exist while the rail is up (the peer accepts, a message arrives) turns
  it without a remount.
* **A failure to open** is said under the button, in the same error line
  the asking uses; an asking's error goes when the button turns.
* **Ask checks again** (code review): the index loads after login and the
  peer may start the chat, so a chat that came to exist while the confirm
  was open is opened by Ask rather than asked for a second time.
* **Known, older, not touched here:** a boot drain that fails with an
  error other than "elsewhere" is retried only when the network list
  changes (`mountEncryptedChats`), so until then the index, the sidebar
  and this button all read as no chat.
* **Choices vjt did not rule:** the label is exactly his ("chat
  securely"); a pending asking of ours no longer shows when a chat already
  exists (the chat wins); the button keeps the asking button's look.

### Tests

Unit (`StartEncryptedChat.test.tsx`), five new: with a chat in the index
the button reads "chat securely", the asking button is gone, and a click
opens the window in the index's spelling with no confirm, no asking and
nothing fetched; a chat appearing under a mounted rail turns the button;
a window that fails to open is said under it; a chat that appears while
the confirm is open makes Ask open it and ask nothing; an asking's error
does not survive the turn. All five were red before their code. e2e
`issue2508-chat-securely.spec.ts`, desktop chromium: the query's rail
before any encrypted chat (the asking button), with the 🔒 window open,
and with it closed — "chat securely" opens and focuses it each time, no
confirm shows, and no request is POSTed. **Not run locally** (the stack
lane was not free); CI's integration run is its first. That run turned
`issue2486-encrypted-chat-request.spec.ts` (c) red, and rightly: after the
accepted request made the chat, it still expected the asking button
enabled in the plaintext query. It now expects "chat securely" there and
no asking button, which is this issue's ruling.
<!-- entry #2515 -->

---

## 2026-11-03 — #2515: the encrypted-message notification opens the encrypted query

vjt reported it: tapping the "encrypted message" notification from a peer
opened the plaintext query with that peer, whether one existed or not. That
was what the server asked for. `Push.Payload.build_e2e/2` (issue 2430) wrote
the plaintext DM's `url` and `tag` on purpose, "so an encrypted banner
coalesces with that peer's plaintext DM banner and opens the same
conversation", and cic routed that link to the query like any DM. Since the
encrypted query became a window of its own (2430's window, 2512's
scrollback), it is the wrong conversation.

* **The server says which window, because only it can.** The service worker
  gets four strings; nothing in them told an encrypted push from a plaintext
  one but the body's English. `build_e2e/2`'s deep link is now the DM one
  plus `e2e=1`, and cic's `parsePushTargetUrl` reads it as a third target
  kind, `"encrypted"`. A separate parameter rather than
  `channel=$e2e:<nick>`: `$e2e:` is cic's local window name, which grappa
  knows nothing of, and an older cic would have opened a query named
  `$e2e:alice`. With the parameter it ignores what it does not know and
  keeps opening the plaintext query, today's behaviour.
* **The tap opens, then focuses.** `routePushTarget` sends an encrypted
  target to `openEncryptedWindow`, the verb `/equery` and the nick menu use,
  never to `openQueryWindowState`. Opening is what makes the window exist on
  a cold tap, before the device has drained the message; the drain then
  fills it. The nick is the one the device's chat index stores
  (`encryptedChatNick`), read off the store and not the page's copy, which
  on a cold tap is not in yet: `chatStore.open` respells a chat to the nick
  it is given (what `/equery` wants), so an open under the wire's spelling
  renamed a chat the user had named otherwise, and everything keyed on the
  window name, the draft among them, changed key. The code review caught
  that the first cut read the page's copy and so held only on a warm tap.
  The open is async from a tap: a failure goes to the console.
* **The chat index refreshes one at a time per network.** Each refresh reads
  the whole index and sets the network's copy from it. Two that overlapped
  could set in the other order than they read, and a refresh that read
  before a chat was opened then set over the open's own: the window just
  opened dropped out of the list and the selection moved away from it. A
  cold tap opens a chat while the boot drain refreshes, so it would meet
  this every time (`/equery` during a drain could too). Refreshes now chain
  per network, each reading after every earlier one has set; a failed one
  does not hold up the next. A unit test that holds the first refresh's
  read until an open has written was red before the chain.
* **Two windows, two banners.** The tag gains an `e2e:` infix
  (`<slug>:e2e:<nick>`), so an encrypted banner no longer replaces the
  plaintext DM banner from the same peer, or the reverse: each tap still has
  a banner for the window it opens. `:` is in neither RFC 2812 `nickname`
  nor `chanstring`, so the infix collides with no tag; a property pins it,
  as for presence. The #2034 sweep follows on its own, through the shared
  `pushTargetSelection`: the encrypted banner leaves the shade when the
  encrypted window is read, and no longer when the plaintext query is.
* **The request push keeps the plaintext link.** `build_e2e_request/2`
  (issue 2486) opens the plaintext query, where the request's banner is:
  there is no encrypted chat yet.
* **No protocol bump.** The payload's shape (`title`/`body`/`tag`/`url`) is
  unchanged and the push payload is not on the versioned WS/REST wire
  (`wire_pin` does not cover it); a new cic against an old server gets
  today's plaintext routing, which needs no number to detect.

### Tests

ExUnit pins the deep link and the tag of `build_e2e/2` and the tag's
disjointness over the nick and channel grammars. vitest pins the parse, the
routing (open the encrypted chat, open no query, select nothing else, a
failed open is said), the stored spelling with the page's copy empty (a
mutant opening under the wire's spelling turns it red), the dismissal from
the encrypted window only (a mutant dropping the spelling there turns two
red), `encryptedChatNick`, and the refresh chain. The e2e
`issue2515-encrypted-notification-tap.spec.ts` reads the screen after a
`notificationclick` dispatched into the live service worker, with a
plaintext query open and with none, and after a cold boot at the deep link
(desktop and both phones): the `$e2e:<peer>` row selected, the encrypted
pane composing to the peer, the plaintext query not selected. That no
plaintext query was opened is read off the server after a reload, against
a control query opened before the tap: read off the sidebar right after the
tap, an absence passes before the open could have come back. It was written
without a local run, since the stack lane was held; CI runs it.
<!-- entry #2509 -->

---

## 2026-11-03 — #2509: an encrypted query is a next-active stop, counted from its own chat

vjt (2026-11-02): Alt+A, Ctrl+N / Ctrl+P and the next-active button skipped
encrypted (🔒) queries even with unread messages. The cycle's candidates
(`activeWindows.windowCandidates`) were channels and plain queries, and its
gate read grappa's unread map, which can never hold an encrypted window:
grappa relays the ciphertext and keeps no row.

* **A third candidate kind, `encrypted`, in the sidebar's own order**: per
  network, channels, then queries, then the open encrypted chats
  (`encryptedChatsFor`), named `$e2e:<nick>` as the sidebar names them.
* **Its unread is the device's chat index.** The memo merges each open
  chat's `unread` into the unread map the gate reads, under the window's
  `channelKey`, so the count, the badge, Alt+A, Ctrl+N/P and the button's
  auto-hide all take it through the one gate they already share. That count
  is what the sidebar's 🔒 badge shows, so the button and the badge cannot
  disagree. It counts what the chat counts: messages, plus a key alarm or a
  peer asking to compare emoji (both are things to act on, #2485).
* **The DM tier.** `isPriorityWindow` treats an encrypted query as it treats
  a plain one: tier 0, the red badge.
* **No activity id, so it reads as the oldest.** The order within a tier is
  the newest local grappa row id, and an encrypted row has none (its id is
  the device's own string, its time the device's clock, comparable to
  neither). It reads 0, as a seed-only window does: among the DM tier it
  comes first. Mixing it in by time would mean changing every window's
  activity key from row ids to timestamps, which this issue does not
  warrant.
* **Muted by its peer's mute.** grappa gates an encrypted message's push on
  the PEER's mute (`Push.Triggers.should_notify_e2e?/3`), so `windowMuteKey`
  maps `$e2e:<nick>` to the peer: muting bob drops both of bob's windows from
  the cycle. The drawer's mute picker skips encrypted candidates. The mute
  they would write is the peer's, and a `$e2e:` row would name a window the
  mute is not keyed on. The 🔒 badge (`EncryptedUnreadBadge`, sidebar and
  bottom bar) dims under the same mute through the same `windowMuteKey`, as
  #1077 dims a muted window's badges: a count the cycle skips never shines
  at full strength. Before this issue the client read no mute for an
  encrypted window at all, so the gap would have been this issue's own.
* **A chat with no line is read when its window shows.** The chat's unread
  counts a key alarm and the peer asking to compare emoji, and the window
  reads at its tail (#2512's `setCursorIfAdvances` → `readEncryptedChat`).
  A chat holding only such a step has no tail: nothing read it but an own
  send, so its badge stuck, and with this issue it would have been a red
  next-active stop no jump could clear (the dead button #1178 and #1765
  cured for grappa's windows). The pane now reads a loaded chat with no
  line whenever it shows with the page visible: the card or the dialog on
  screen is what the user reads. Rows still loading are not "no line".

Tests: the pure order (an encrypted query ahead of a channel listed before it, priority,
the badge kind, a muted peer skipped), the memo with the chat index mocked
(a candidate counted from the chat's own unread, the jump selects it with
kind `encrypted`, none once read), the picker offering no `$e2e:` row, the
badge dimmed under the peer's mute, and a chat with no line read once shown
(never while hidden, never while loading). e2e:
`issue2509-encrypted-next-active.spec.ts`, two browsers on the real ircd.
Alice parks on the server window with nothing to jump to, and Bob writes in
the encrypted query. Her button must count 1 in the DM tier's colour, and the
jump (Alt+A on desktop, the button on both phones) must land in the
encrypted window with Bob's line on screen, after which the button goes. A
third test makes the stop a key alarm in a chat with no line (Alice pinned
Bob's key by hand, Bob comes back with a new identity): one Alt+A lands on
the alarm and the button goes.
<!-- entry #2507 -->

---

## 2026-11-03 — #2507: the trust badge starts the emoji comparison, and pinning a key by hand is the rail's alone

vjt tested the encrypted flow end to end (2026-11-02) and reported two
things. A new chat showed, in the chat area, inputs to paste the peer's key:
the most prominent thing on the screen, and noise for anyone who is not
pinning a bot's key. And the emoji comparison, what matters to a normal
user, was the hard thing to find, behind the rail (on a phone, behind the ☰
too). He ruled twice on the issue (2026-11-02, relayed by the ircbot
session). The first ruling allowed a static fingerprint shown in the top bar
if it cost no security, and set its floor at ~80 bits (14 emoji): a static
fingerprint has no commitment, so 7 emoji (~42 bits) could be ground for
offline. The second, final, keeps the synchronized 7-emoji SAS and asks for
three things: the key-paste inputs out of the chat area (rail only), the
comparison started from a tap on the top bar's `not verified` / `verified`
badge, and no more taps and screens than the protocol needs.

* **The chat's cards say what to do, in words.** The no-key card keeps its
  sentence (send a message; a bot answers only once its key is pinned here
  and ours there) and ends on where that is done, the side panel. The alarm
  card keeps "take the new key (not verified)", a button, not a key to paste,
  and points to the side panel for pinning the key they give. Neither holds
  an input or the copy button any more. **This reverses #2485's
  "duplicated doors, on purpose"**, whose argument was that on a phone a
  card that only points to the drawer makes finishing the exchange a hunt.
  The ruling outweighs it: pinning by hand is for bots and for whoever knows
  what they are doing, and a person's key is taken on first use with no
  card at all. `PinForm` and `CopyOwnKey` are the rail's again, unexported,
  and lose the `testId` prop that told the doors apart. The identity-
  elsewhere card keeps its pairing-link input: that is a pairing link, not a
  key, and the card is the only way out of that state (#2485 bullet 4).
* **The badge is the comparison's door.** While a comparison can start, the
  top bar's badge sits in a bare button whose tap starts it. That holds for a
  pinned key not verified, or one verified BY EMOJI (a `verified` badge then
  checks again), with no alarm open, none running, and the identity here.
  Otherwise the badge is a plain span, as before.
* **A key verified by pasting it offers no "check again".** `Verifier.start`
  would run on any pinned master, but a bot answers only once its key is
  pasted here (2430 ruling 6253162964), so every bot window reads `verified`,
  and irc-olm drops `sas.*`: a re-check there could only sit in "waiting" for
  the 10-minute timeout with the compose line inert. A key pasted by a person
  was checked at its source, and emoji would add nothing. The review caught
  this before it shipped; vjt's own encrypted chat is with a bot. The door
  reads the chat's rows: the newest row that chose or checked a key must be a
  `verified` (`verifiedByEmoji`), not a `pinned` or an `accepted`. **Known
  gap:** a deleted chat keeps the pin and loses the rows, so a key verified
  by emoji offers no re-check after the chat is deleted, until a new
  comparison is started some other way (the peer's request). The opposite
  default would hand every bot whose chat was deleted the dead end back. The
  button keeps the badge's look and takes the tap floor's height (44 px).
  The bar's chrome buttons are 48 px tall, so the row should grow no taller;
  that comes from the CSS and was not measured. Its
  accessible name says what the tap does ("not verified: compare emoji with
  bob", "… again" when verified). The rail's "verify by comparing emoji"
  goes: one door, where the state is shown.
* **What the protocol needs, and what went.** The steps that stay are
  protocol: A's start, B's accept (B's commitment to its key before A
  reveals its own is what keeps 7 emoji safe, the property the first
  ruling's 80-bit floor was about), each human's match, and the wait for the
  peer's MAC. B's accept also stays a human tap. Auto-accepting would put
  emoji on a screen nobody asked for, the "compared by chance" risk the
  issue names. What went is the trip to the start: on desktop the rail's
  button, on a phone the ☰, the drawer and the button, now one tap in the
  bar. The "exchanging keys" and "waiting" screens are unchanged: they are
  the protocol's own round trips, shown while they run, and they cost no tap.

**Mobile.** The dialog still closes the rail's drawer when it opens
(`onDialogOpen`). The phone's own start no longer passes through the drawer,
but a request from the peer can still land while the drawer is up.

**Open, for a ruling: a failed re-check changes nothing visible.** A "they
don't match" (or a MAC mismatch) on a key already verified only writes a
`sas_cancelled` row. The engine's `verified` flag stays, so the badge still
reads `verified` while the rail says "stopped: the emoji did not match". That
was already true of a comparison the peer started. 2507 makes "check again"
a flow the user starts, so the outcome they are checking for leaves no trace
on the badge. Un-verifying, or raising the key alarm, is a protocol decision
and was not taken here.

Tests: the window (`EncryptedChatPane.test`). The no-key card holds no input
or button and the alarm card no input, both naming the side panel, while the
rail holds the pin form and the copy. A click on the door (the button, so a
keyboard reaches it too) starts the comparison, for `not verified` and for
`verified` by emoji, with the accessible name read. A key pasted by hand
offers none, nor does a key with no row left. The badge is no door with no
key, an alarm open, a comparison running, or the identity elsewhere. Clicking
every rail button starts nothing. Ten mutants each turned their own tests
red, and only tests about the door: each clause of the condition (dropping
"none running" also reddens the six dialog-phase cases, which read the door),
the "again", a no-op handler, the handler on the badge instead of the button,
"any verified key", a pin that does not end the search, a rail button that
starts one. e2e:
`issue2507-sas-from-badge.spec.ts`, two browsers on the real ircd. Before the
exchange the chat body holds no input, its card no button, and the compose
box is its only text field. One click on `not verified` reaches a match, one
on `verified` asks again, this time from the keyboard (Enter on the button),
and Bob declining leaves both sides verified. On `@touch` the badge's button
is at least 44 px tall, and its tap opens the dialog with the drawer shut.
`compareEmoji` starts from the badge, and #2485's phone test keeps its
subject (a dialog behind the drawer closes it) by having the peer ask while
the phone shows the rail. `issue2430-interop-bot` now also reads, against the
real irc-olm bot, that its hand-pinned key offers no comparison. Two red
arms, both run locally on the stack. With the spec on main's code, both
projects went red on the first subject, an `input` in the chat body. With
the door switched off on this branch (`canCompare` → false), the desktop test
went red waiting for the dialog after the click, and the phone test went red
finding no door. The second arm is needed because the first went red before
reaching the door.
<!-- entry #2510 -->

---

## 2026-11-03 — #2510: the phone's next-active button over an encrypted query, cured by #2512 and now guarded

vjt (iOS PWA, 2026-11-02): over an encrypted (🔒) query the mobile
next-active button lost its look. Over channels and plain queries it is
translucent and sits in ScrollbackPane's float stack beside scroll-to-bottom
(#289/#302: `.shell-mobile .scrollback-float-stack > *` at opacity 0.5).
Over the encrypted query it was Shell's bare mount for windows with no
scrollback: opaque, and placed against the viewport.

**No production change: #2512 cured it, and this issue measured that.**
#2512 made the encrypted window's body the scrollback pane every chat
window has, so the window carries the float stack and the button in it, and
it gated Shell's bare mount off the encrypted kind
(`!kindHasScrollback(selKind()) && selKind() !== "encrypted"`), so only one
button mounts. The report (2026-11-02 21:58 UTC) predates #2512's merge
(PR #2521, 2026-11-03 02:39 UTC).

**The guard lives in #2512's phone test, not in a spec of its own.** That
test (`issue2512-encrypted-scrollback.spec.ts`, `@webkit @touch`) already
builds the scene (Bob writes Alice in clear while she is in the encrypted
query) and already asserts one button, inside the float stack. A second
two-browser spec repeating that scene was cut in review: it bought two
vodozemac runs on both phones for three readings the existing test could
take. What the test now adds is the LOOK: the button's computed opacity and
the distance from its corner to the corner of the box it is placed in, read
over the encrypted query, over a channel, and over the encrypted query again,
all equal within a pixel, with the channel's premise pinned (0.5, in the
stack) and scroll-to-bottom absent from every reading (it would lift the
button within the stack). The pane-relative distance cannot see the pane
itself move, and the opacity is the button's own, not an ancestor's: by
design, those are the pane's and the theme's.

Measured:

* **Red, pre-#2512 (`17c33f670`) + the comparison** (taken as a standalone
  spec before it was folded in), both phones. Over the encrypted query the
  button read `{opacity: "1", inStack: false}`, against the channel's
  `{opacity: "0.5", inStack: true}`. The report, measured. Its two distances
  (112px and 7px, against 11px and 14px) are not comparable to the
  channel's: outside the stack they are taken from the viewport, and the 112
  is the focused composer's lift (`--nab-lift: 8rem`).
* **Green, main + the folded test**: the whole #2512 spec, with the
  float-stack and opacity specs the look leans on (#1062, #264, #289/#302):
  10 passed, the phone test on both phones.
* **What only the look catches**: with the encrypted pane's float stack
  forced opaque (`.e2e-pane .scrollback-float-stack > * { opacity: 1 }`),
  the test's one-button and in-the-stack checks pass and the look turns it
  red on both phones, `opacity: "1"` against the channel's `"0.5"`. Shell's
  gate reopened is the one-button check's: measured on the standalone spec,
  red on both phones with 2 buttons.
<!-- entry #2511 -->

---

## 2026-11-03 — #2511: the encrypted top bar keeps its buttons on one row; the id check goes under the nick

vjt (iOS PWA, iPhone portrait, 2026-11-02, then three rulings on the issue):
the encrypted query's top bar put `🔒 <nick>`, the trust badge and the
`✓ id check <date>` stamp on one line. On a phone that did not fit, and since
`.e2e-header-main` was `flex-wrap: wrap` the row wrapped. First the ☰ dropped
under `#`; then, once the stamp carried a full date, search, shredder and ☰
all dropped together. The rulings: the stamp wraps to its own line under the
nick or moves to the rail (either is fine); the buttons stay on ONE row, with
long nicks too; and the search and shredder icons get the ☰'s treatment.

* **The row no longer wraps, and the title is two lines** (`.e2e-title`).
  Line one is the 🔒 and the nick, cut with an ellipsis. Line two is the badge
  (the emoji comparison's door, #2507) and the stamp, which is cut first; its
  full text stays its title, its spoken label, and the rail's "last identity
  check". The badge gives way last, with an ellipsis, on a pane too narrow
  even for it: nothing in the title runs under the tools. That is iPad's
  Slide Over (its windowed pane takes a 65px leading inset), which Playwright
  cannot emulate; a phone narrow enough has the window bar back in flow below
  383px (#2161), so no `#` in the bar and room for the badge. The stamp's shrink weight (1000) dwarfs the badge's, so the
  badge only shrinks once the stamp is gone. The tools and the two doors do
  not shrink.
* **The badge moved to line two with the stamp.** The issue's first wording
  had the stamp "under the nick + badge", i.e. the badge kept beside the nick.
  It does not fit the worst case, which is the one vjt reported from: a
  393px phone with the window bar off, so the bar carries the `#` too. From
  the tokens, 1rem (14px) of inline padding on each side, four 48px chrome
  buttons (`--chrome-tap-min`), the tools' 0.25rem gap and the row's three
  0.5rem gaps leave the title about 148px. "not verified" at 0.85em
  monospace is about 97px with its padding and border, and the 🔒 and two
  gaps take about 30px more, so the nick would get 2 to 5 characters. Under
  the nick, the badge leaves the nick about 12. This is computed from the
  tokens, not measured on a device: the spec below measures the result, not
  the alternative.
* **The door's tap floor is an `::after`, not the button's height.** #2507
  gave `.e2e-trust-door` `min-height: var(--tap-min)`; on line two that
  would make the title 22 + 44px tall, and the bar about 18px taller. The
  44px is now an absolutely placed `::after` that grows UP from the badge's
  bottom edge. Centred on the badge, as first written, it reached below the
  bar's row: over the search row when open, and under the chat's body, which
  paints above it and took its last pixel. The review computed that, and the
  first green arm measured it: a tap 20px below the badge's centre missed the
  door. Above the badge is the nick, which is not interactive, so a tap on
  the nick's first characters starts the comparison. In practice the door
  and the stamp do not meet: the stamp comes only from a bot's order
  challenge, and a bot's key is pinned by hand, which offers no door (#2507).
  #2507's phone test asserted the button's box at 44px or more; it now
  asserts the `::after`'s computed height at 44px or more, and that a tap at
  either end of it lands on the door.
* **The icons fill the ☰'s square.** The ☰'s three bars are drawn to fill a
  `--chrome-icon-size` square exactly (#1766). The magnifier and the shredder
  were drawn on a 24-unit grid with a margin, so their ink sat smaller than
  their 1em box. Each viewBox is now cropped to its own ink, stroke and round
  caps included: magnifier `3 3 19 19`, shredder `2 2 20 20`.

Tests:

* vitest pins the title's structure: two lines, the nick alone on the first,
  the badge and the stamp on the second. It was red against #2507's markup.
* e2e: `issue2511-encrypted-top-bar-one-row.spec.ts` (`@webkit @touch`,
  both phones) builds the worst case for real. The real irc-olm bot runs
  with a 26-character nick and is pinned both ways. One message opens the
  session, and an order in a shared channel gives a passed identity check,
  so the stamp is there. The window bar is turned off, so the `#` door is
  in the bar too. The spec asserts that the four buttons share a top and the
  bar is no taller than they are, that the nick is cut before the search
  button, that the badge and the stamp sit under the nick, and that each
  icon's ink is the bars' square within a pixel. The ink is read off
  `getBBox()` grown by half the stroke and scaled by `getScreenCTM()`,
  within half a pixel. Then the viewport goes to 280px (a Galaxy Fold's cover
  screen, the narrowest phone): three buttons (the `#` leaves with #2161),
  still one row, and nothing of the title reaching the search button.
  - **Red on #2507's code** (`c87d4a2a`): on both phones the buttons after
    `#` sat 55px lower, on a second row. That is the report.
  - **First green arm**, before the review's fixes: the spec green on both
    phones, and the encrypted set with it, interop included: 42 passed, 1
    red. The red was #2507's phone test, whose probe 20px below the badge's
    centre missed the door, as the review had computed.
  - **After the fixes**: #2507 (desktop and phone), #2485, `issue2430-sas`,
    #2506 and #2512 green, 12 passed; then this spec, with its 280px step,
    green on both phones.
* The NickServ registration, the order verdict, the 2430 bounds and the bot's
  `cic` subject moved from `issue2430-interop-bot.spec.ts` into
  `fixtures/e2eBot.ts`, now that two specs need them. The interop spec is
  unchanged in behaviour and runs in the green arm.
<!-- entry #2532 -->

---

## 2026-11-04 — #2532: the 2506 phone test measures the rail once the drawer stops

`issue2506-encrypted-rail-geometry.spec.ts`'s phone test (`@touch @webkit`)
went red now and then on webkit-iphone-15 at its first edge check:
`|own.left - peer.left|` 1.48px, against a 1px tolerance. Seen on main
integration at `24f745040` (run 41611248751) and on PR 2526 (run
41887787807), green when rerun alone. The issue's third sighting, a 1.7px
gap while nearby specs ran, came from #2513's e2e pass (PR 2527), whose
decision log records it as an offset "in the WebKit phone rail while it slid
in": the same slide.

* **It measured inside the slide.** The test tapped the encrypted pane's ☰,
  waited for `.shell-members.open`, and read the boxes. The class lands at
  the START of the drawer's 200ms `translateX(100%) → 0` transition. In both
  red traces the evaluate began 43ms and 68ms after the tap returned, with
  the peer card's left edge at 251.2px and 193.0px, the drawer still on its
  way in.
* **One evaluate did not keep the edges together.** The spec read every box
  in one call, so that a moving drawer would move them all alike. On WebKit
  it did not: both times the box read first (the peer card) sat 1.48px and
  1.08px right of `own` and the WHOIS card, which agreed with each other
  exactly. That is consistent with the slide advancing between two reads of
  one call; it is read off the offsets, not seen, and why WebKit would
  advance it there is not known.
* **The cure: open the drawer through `openMembersDrawer`.** The shared
  opener (`cicchettoPage.ts`) returns only once `.shell-members.open` is
  wholly inside the viewport (`toBeInViewport({ ratio: 1 })`, #653), which
  for a drawer fixed to the right edge and no taller than the viewport
  happens only at `translateX(0)`. The first cut copied that wait beside the
  test's own tap; the review asked for the opener itself. It clicks the same
  door, since in the encrypted window the pane's rail opener is the one
  `.topic-bar-hamburger` (PaneTopBar.tsx keeps the window door on another
  class for this reason); it brings the detach retry of #653/#519; and one
  settle definition cannot drift from a copy. The door's tap stays asserted
  by #2485's phone test. The helper's geometry note still described the
  drawer before #1751 (`top: 0`, a plain viewport height) and now names the
  safe-area `top` and the compensated height. The 1px tolerance is
  unchanged, as the issue asks; the desktop test has no slide and is
  untouched.

### Tests

Displacement, in scratch arms beside the spec (never committed): each
recorded when it measured, whether the drawer still had a running
animation, and its left edge then against where it stops (141px on the
393px iPhone, 160px on the Pixel). The slide was left at 200ms or forced to
2s or 4s with an injected `transition-duration`. The clock starts when the
tap returns for the old wait, and before the opener's click for the new one.
Two runs: the first with the copied wait on webkit-iphone-15, the second
with `openMembersDrawer` on webkit-iphone-15 and chromium-pixel-touch.

| wait | slide | iPhone (copied wait) | iPhone (opener) | Pixel (opener) |
|---|---|---|---|---|
| `.open` (before) | 200ms | 37ms, moving, 393px | 30ms, moving, 393px | 2920ms, still, 160px |
| `.open` (before) | 2s | 30ms, moving, 393px | 11ms, moving, 393px | 1875ms, moving, 162.5px |
| settled (after) | 200ms | 445ms, still, 141px | 501ms, still, 141px | 460ms, still, 160px |
| settled (after) | 2s | 3008ms, still, 141px | 3116ms, still, 141px | 3000ms, still, 160px |
| settled (after) | 4s | 4039ms, still, 141px | 4087ms, still, 141px | 5056ms, still, 160px |

The new wait measures after the slide has ended whatever its length, on
both engines. How far it trails varies (39ms to about 1s), which fits
`expect` retrying at growing intervals up to 1s; that is an inference, not
measured. The old wait does not follow the slide at all: on the iPhone it
measured within 37ms with the drawer still at its starting edge; on the
Pixel it measured whenever the WHOIS card turned up: after the 200ms slide
in one arm (2920ms), and 1875ms into the 2s one, the drawer 2.5px from rest,
in the other.
The committed phone test ran green on both projects in the second run. Not
reproduced: the 1.48px geometry red itself. In every `.open` arm the boxes
were read at one drawer position (all deltas 0), so the per-read drift the
CI traces show did not occur on demand; what the arms prove is the ordering
that rules it out.
<!-- entry #2401 -->

---

## 2026-11-04 — #2401: push endpoints are outbound requests a client aimed

A push subscription's `endpoint` is a URL the server POSTs to on every
notification, and the client picks it. Until now the only check on it was a
length cap, so the destination address was the client's choice too — the
blind-SSRF class `Grappa.Net.Ssrf` already guards for theme images (#75).
The fix reuses that guard rather than writing a second one.

**Two halves, and the second is the authority.** At save,
`Subscription.changeset/2` takes `https` with a host that
`Ssrf.blocked_literal_host?/1` does not refuse: no loopback, private,
link-local or metadata IP literal (v4-mapped and NAT64 forms decoded, as
`safe_public_ip?/1` already does), no `localhost` tree. It does NOT resolve
names. A check at save is one a name can pass and then stop passing, so its
only value is refusing what is decidable without a lookup; doing DNS there
would add a network round trip to the POST and nondeterminism to every test
for no security gain. At send, `Push.Sender` resolves the host through
`Ssrf.resolve_safe/1` on EVERY delivery (rebind-conservative: one unsafe
answer blocks the host) and dials the address that answered via
`Ssrf.pinned_url/2`, keeping the original name for `Host`, SNI and the
certificate check. There is no second lookup for a rebinding name to win.
Redirects are not followed — a 3xx is the http error it is.

**Owning the POST was the price of the pin.** `ExNudge.send_notification/3`
hands the endpoint string to `HTTPoison.post/3` with no options, so the client
always resolves the name itself and no check of ours can bind the connection.
The sender keeps `ExNudge.Encryption` + `ExNudge.VAPID` for the crypto and
sends through the new `Grappa.Net.PinnedHttp`: Mint, passive mode, ONE
connection per request to the vetted address with `hostname:` carrying SNI and
the certificate name, closed when the response is in. Not `Req`, measured in
its source on the way: every distinct `connect_options` set — and a pinned
request's carries the hostname — becomes a `Module.concat`-named Finch
instance under `Req.FinchSupervisor` that nothing ever stops
(`Req.Finch.finch_name/1`). With client-chosen hostnames that is an atom and a
supervision tree per name, forever. Push volume makes a handshake per delivery
free, and the cold-pool race the sender tests used to pre-warm around is gone
with the pool. Bounds are explicit and fit the 10 s per-delivery Task budget:
two 2 s DNS lookups (now `:inet.getaddrs/3`, the old ones had no timeout),
2 s connect, a 3 s wall-clock response deadline counted from the connect that
does not restart per chunk, and a 64 KiB body cap. A v6 address passes
`inet4: false` beside `inet6: true`, or Mint would retry a failed connect
without `:inet6` and spend the connect budget twice. The headers are the same RFC 8291/8292 set and
`WireFormatTest` still decrypts the body as a receiver would. The result
mapping is ours now (404/410 sweep, everything else an `http_error`), so the
`normalize/1` adapter and its unknown-shape clause are gone; and
`Push.VendorLog`, which read vendor bodies off ExNudge's own telemetry event
because the library never returned them, now attaches to
`[:grappa, :push, :vendor_rejection]`, emitted by the sender on non-terminal
rejections with the host only, never the path.

**`ImageFetcher.Req` keeps its `Req` transport in this change.** It dials
pinned addresses the same way and so builds a Finch instance per hostname
too; moving it onto `PinnedHttp` is its own change, not folded into a fix
whose surface is push.

**The guard grew the reserved v6 blocks a client can now reach:** `::/8`
(unspecified, loopback, the deprecated IPv4-compatible `::a.b.c.d`, RFC 8215's
local-use `64:ff9b:1::/48`), `100::/64` discard-only and `fec0::/10`
site-local. The `::ffff:` and `64:ff9b::/96` forms are still decoded and judged
by their v4.

**A refused stored row is kept, not swept.** The verdict comes from a DNS
answer, the one input neither we nor the vendor control; sweeping on it
would let a resolver hiccup delete every device a subject registered. Each
delivery re-asks and each refusal logs `push.send endpoint refused`. `http`
is still dialled at send for rows saved before this change — the address,
not the scheme, is what makes a request safe to send.

**No vendor allowlist; one operator exemption.** FCM, Mozilla autopush and
Apple all sit on public `https` hosts and pass unchanged; a UnifiedPush
distributor can be any public host. A host the OPERATOR lists in
`PUSH_ALLOWED_PRIVATE_HOSTS` may be private and plain `http`, at both doors
(`Push.allowed_private_host?/1`): the changeset admits it, and the sender
resolves it without judging the answer and still dials the address. This
reverses what this entry said when the PR was opened — "deliberately no
opt-out" — and the reason was measured, not argued: the PR's first CI run lost
every push e2e spec to `seedOneDevice: 422 … must be an https URL on a public
host`, because the harness's fake vendor is `http://push-catcher:3000` on a
private docker network, the exact shape the policy refuses. A test-only bypass
would have left the e2e proving a path production never takes; the exemption
IS the production path, and it serves the case the original text wrote off —
a self-hoster's ntfy on their own LAN. The tenant attack stays closed: the list
comes from the operator's environment at boot, is empty by default, and
matches a host exactly (ASCII case and a trailing dot folded), never by
suffix; an IP literal is compared in canonical form. An entry that could
never equal a host (`ntfy.lan:8080`, `http://ntfy.lan`, `[fd00::1]`) raises
at boot rather than standing as an exemption that does not exist.
`config/runtime.exs` reads it in every env but `:test` (the harness runs
`MIX_ENV=dev`; `cicchetto/e2e/compose.yaml` sets it to `push-catcher`), and
`config/test.exs` pins it empty so a developer's `.env` cannot change what the
suite asserts.

**Found on the way: `ImageFetcher.Req` double-bracketed IPv6.**
`URI.to_string/1` already brackets a host containing `:`, so its own
`[...]` produced `[[...]]` and a theme image on a v6-only host could not be
fetched. The URL builder moved into `Ssrf.pinned_url/2`, which passes the
address bare.

**Test seams.** `Grappa.Net.Ssrf.TestResolver` (renamed from the image
fetcher's) waves loopback through for Bypass and pins `pinned.invalid` to
`127.0.0.1` — `.invalid` never resolves, so a request arriving under that
name proves the client dialled the pinned address. `Ssrf` exports it only
under `MIX_ENV=test`. Delivery suites write rows through
`Grappa.PushFixtures.stored_subscription!/2`, past the changeset, because
Bypass is plain `http` on loopback — `Grappa.PushReceiver.browser_subscription/2`
included, which issue 2487 moved out of `WireFormatTest` while this PR was
open and which still called `Push.create/2`. The exemption's own tests pair
every admitted case with its refusal under an empty list, and prove the
send-time half by ARRIVAL: a `gen_tcp` listener on `127.0.0.2`, an address the
real guard refuses and the test resolver does not wave through, receives the
POST only when the host is listed.

**Deploy class: COLD.** No `Session.Server` field and no `defstruct` change,
but `VendorLog` attaches its handler in `init/1`: a hot reload would leave it
bound to the old event, which nothing emits any more, and vendor rejections
would go unlogged until the next restart.
<!-- entry #2535 -->

---

## 2026-11-04 — #2535: the 2509 key-alarm test waits for its setup, and the alarm gets a measured 60 s

`issue2509-encrypted-next-active.spec.ts`'s desktop test "a key alarm in a
chat with no line" timed out at 30 s waiting for Alice's next-active count:
CI run 41887617372 (attempt 1) and run 41900042768 (shard 2), green when
rerun. The issue read it as an observation race. The container logs of both
reds and of two local greens say otherwise: it is a race in the SETUP, made
slow by the send budget.

* **What raised the alarm came down to 28 ms.** Alice's pin sends a KEYREQ.
  Bob's grappa answers it server-side from whatever keys it holds at that
  instant, and the answer waits in the 2430 pacer. In the greens it was
  built after Bob's `replaceIdentity`, carried his new master, and `onKeys`
  → `checkMaster` raised the alarm. In both reds it was built 28 ms before
  the replacement (his queries at 20:09:08.906, `register_device` at
  08.934), so it carried his old keys, which are the pin's, and raised
  nothing. Alice then opened a session to his old device. The alarm could
  only come with Bob's PKMSG, queued in his grappa behind those old KEYS and
  a NACK, and at teardown it was still `e2e pkmsg dropped unsent: the
  session ended`.
* **The cure: Bob comes back only once the pin's answer has landed.** After
  `pin`, the test waits for Alice's rail to list Bob's one device
  (`e2e-peer-devices` "1 device", `KEYS_TIMEOUT`) and for the pin to read
  verified. A scratch probe read the rail at the pin: "0 devices" in all 6
  runs, so the wait is not vacuous; the device was listed 11 to 12 s after
  the pin. From there the alarm always comes with Bob's message.
* **That path is slow by construction, and the 3-line message to Bob's old
  device that the first analysis could not name is the pin's listreq.** A
  pin asks the peer for his list (`askList`, O1), and the ask waits behind
  the keys it needs, so it leaves once his KEYS land: a 3-line PKMSG to his
  old device, in flight just as the new Bob asks Alice for her keys. Her
  KEYS answer (2 lines) queues behind it, because REACTIVE messages are FIFO
  per target (`E2ePacer`), and Bob's PKMSG (3 lines) waits for her KEYS:
  eight paced lines. A 405-byte E2E line leaves only at an empty bank, since
  the pacer keeps 5 s of the fake-lag ceiling in reserve for URGENT lines,
  so about one every 5 s. On the container clock in one run: Bob's KEYREQ
  at 40.4, Alice's listreq 38.2 → 46.3, her KEYS 51.3 and 56.3, his PKMSG
  56.3 → 04.3.
* **The count gets `ALARM_TIMEOUT` = 60 s: a measured budget, not a raised
  timeout** (the orchestrator's ruling). From Bob's send to Alice's count,
  6 runs: 27.0, 28.1, 26.0, 27.1, 27.0, 28.1 s. That left 2 to 4 s of
  `KEYS_TIMEOUT`'s 30; eight lines at 5 s is about 40 s at worst. Only the
  count's wait changes: the green path still takes about 27 s.

Rejected:

* **Bob replaces first, Alice pins his old key after.** The pin's answer
  would carry the new master and raise the alarm through `onKeys` in about
  10 s, but it can land while Alice still has the encrypted window open,
  and the window shown is what reads the alarm. KEYS took 8 s after the
  KEYREQ in these runs only because registration had filled Bob's fake-lag
  bank; at an empty bank it leaves at once.
* **Bob comes back once Alice's listreq has reached him** (a scratch arm,
  never committed). He decrypts it and answers with his `t:list` and a
  listreq of his own, and Alice answers with hers: about 20 s more on both
  connections. His rail shows nothing of Alice either: `e2e-peer-devices`
  never appeared on his side (5 of 5 red on that wait, a sixth lost to a
  chromium SIGSEGV at launch), so there was nothing to wait on.

### Tests

* The committed wait with scratch timing probes, 6 runs on chromium: 6
  green, the numbers above.
* The committed spec, the wait and `ALARM_TIMEOUT` with no probe, twice on
  every project it runs on: 8 of 8 green (the key-alarm and DM-tier tests
  on chromium, the phone test on chromium-pixel-touch and
  webkit-iphone-15).
<!-- entry #2513 -->

---

## 2026-11-03 — #2513: an encrypted chat shown as the ciphertext that crossed IRC

The issue asks for a toggle that shows an encrypted query as the E2E blobs
as they travel over IRC, in both directions, reached from the sidebar, a
read-only view that gives the plaintext back when toggled off, with no
server or protocol change.

* **"The ciphertext already reaches the client" was half true.** Every
  payload does reach cic, but the chat store kept only the plaintext, and an
  Olm message key is spent once read: a payload not kept at receipt can
  never be made again. So the row keeps it (`ChatRow.wire?: WirePayload[]`,
  `{verb, msgid, payload}`): an incoming row the one this device read, an
  outgoing row each one grappa took for it, appended on the move to sent, in
  order (a re-send after a NACK is a second).
* **A payload grappa dropped goes.** `e2e_send_dropped` says a payload
  grappa accepted never left, so it is taken off its row whatever the row's
  state (a `drop` chat change; `engine.sentAs(msgid)` names the row). Taking
  it off only when the row turns failed would not do: one message can be
  several payloads (a MSG to the peer's device with a session, a PKMSG to a
  new one), and a drop of one while another went leaves the row sent, which
  showed the dropped payload as crossed with nothing on the line to say
  otherwise. The review found it.
* **What has none.** Rows kept before this; copies from our other devices,
  which reach this one through grappa's copy door and never crossed IRC; a
  message of ours not sent (waiting for keys, at the door, refused, dropped
  whole). The first two read `(no ciphertext on this device)`: it existed,
  elsewhere. The last reads `(no ciphertext)`, beside the line's own state
  (`waiting for keys`, `sending`, `not sent: …`), which says why.
* **One line per payload, not per IRC line.** A message reads
  `E2E <VERB> <msgid> <payload>`, each payload on its own line of the same
  scrollback line (bodies are pre-wrap). The `\x01E2E VERB msgid i/n from to
  chunk\x01` lines themselves are not drawn: the cut is the sending grappa's,
  sized to its relay budget, and on receipt the peer's budget and `to` are
  unknown, so the receiving end would draw lines it invented. The payload is
  what those lines carried, whole, and the same bytes on both ends.
* **The same line ids.** The view swaps bodies on the lines the plaintext
  view draws, so the unread marker and the delivery state stay on them. A
  message that could not be read becomes its sender's line, carrying the
  payload it arrived as. The search filters the lines as shown, so in this
  view it looks in the ciphertext (a msgid finds its message), never in the
  plaintext behind it.
* **The door is the sidebar row's context menu.** One item, "Show
  ciphertext" / "Show plaintext"; a right-click, or a hold on a touch device
  through `bindNickLongPress`, which delivers the `contextmenu` iOS never
  sends for a hold. What is open lives in `EncryptedChatMenu`, because the
  Sidebar keeps no state of its own (Shell remounts it on every swipe,
  #1041); the menu goes with the Sidebar that mounted it.
* **The rows keep their node.** The sidebar keys an encrypted window's row
  by the chat's key, not by the index entry. The index is read again on
  every change (an incoming line, the read after it) and hands out new
  entries, so keyed by entry each refresh rebuilt every row, and one landing
  inside a hold left the menu's `contextmenu` on a detached button, which
  Solid's delegation at the document never sees. Found after the rebase over
  #2511, when the phone test went red once with Bob's reply shown about
  390ms before the hold: consistent with this, not proven, since 22 probed
  holds afterwards saw no row rebuilt. The window bar keys its encrypted tabs
  the same way and stays so: nothing there is held.
* **Per chat, in the tab's memory.** A way of looking, not a setting: off
  until asked, off again when this tab deletes the chat or the identity
  changes, gone on a reload.
* **The compose box stays.** "Read-only" is read as a view that changes
  nothing stored: a line typed there shows up as the ciphertext it went as.
  Hiding the compose box in the view is the alternative, put to vjt on the
  PR.
* **Storage.** Every new row now carries one or more payloads, a JSON text
  several times a short plaintext, and a chat's rows are one sealed record
  rewritten on each change. At `CHAT_ROWS_MAX` (1000) rows and about a
  kilobyte of payload each that record nears 1 MB: an estimate, not a
  measurement. Capping the kept payloads to the last rows, or keeping them
  only for chats whose view was ever on, are the alternatives, put to vjt on
  the PR.

### Tests

vitest pins the store (each payload grappa took appended in order, a move
with none keeps them, a drop takes one off and opens no chat), the client
(on both ends, in both directions, the payload and msgid grappa took equal
the ones the reader read; a re-send after a NACK keeps both; an unreadable
row keeps the one it could not read; a dropped payload of a two-payload
message goes while the row stays sent, and the row turns failed once both
are dropped), the pane (each message as its payloads on its line, the two
placeholder texts, a sent row of ours with none reading as kept elsewhere,
the delivery state still on the line, no plaintext on screen, the plaintext
back on the toggle, another chat's toggle leaving this chat as it was, the
search looking in the ciphertext), the sidebar menu (a right-click, a hold on
a touch device that sends no `contextmenu`, a hold that the index is read
again under, red before the rows were keyed by chat, no other row opens it)
and the toggle's lifetime (per chat, off on a delete or a new identity). 18
mutants
(the store append dropped or replacing, `wire: null` at the flush, the flag
ignored, a space join, the unreadable row kept as an event, no
`preventDefault`, no hold binding, no reset on delete or identity, the
not-sent text never, the search on the plaintext, the in or unreadable row
without its payload, the labels swapped, no menu cleanup, a toggle that only
sets, the count over every line) each turn 1 to 3 tests red, and so do 5 on
the drop (the store arm a no-op, a drop only once the message is lost, the
not-sent text on every row of ours, no guard on list or rowless traffic, a
drop that opens a chat), after the 3 drop tests were seen red on the code
before it.

The e2e `issue2513-encrypted-ciphertext-view.spec.ts` runs two browsers, two
grappa users, two real vodozemac engines and one real ircd: a message each
way, then the view. On desktop a right-click on the row: Alice's lines equal
Bob's (one IRC message seen from its two ends, since grappa mints the msgid as
it cuts the payload and the peer's grappa reads it back), no plaintext on
either screen, and the plaintext again on "Show plaintext". On a phone
(`@touch`) the window list from the left-edge swipe and a hold on the row; it
runs on chromium only, since `new Touch` throws on Playwright's WebKit. On
the pre-fix code with only the spec added, both tests were red at the menu
item, after the whole conversation; with the fix, both green (chromium 28 s, the phone 29 s). The encrypted-window specs
beside it (the 2430 suite, 2485, 2486, 2505, 2506, 2508, 2512, 2515) ran in
the same pass, 40 of 42 green; the two reds, a chromium that crashed at
launch and a 1.7 px offset in the WebKit phone rail while it slid in, were
green on an iso-rerun at the final head, with 2513 again.
<!-- entry #2536 -->

---

## 2026-11-04 — #2536: commands run in an encrypted query, `/me` goes encrypted

vjt's ruling on 2536 (#grappa, 2026-11-04 22:19), after weighing a block:
blocking commands is counter-intuitive, remove the block completely.
#2512 sent everything typed in an encrypted query to the peer as one
encrypted message, asked before any verb was parsed. A line starting with
`/` was therefore text: `/whois foo` landed in the peer's window, and
`/ns identify <password>` handed the peer the NickServ password (vjt: "a
command can carry a secret"). The block would have fixed the leak; the
ruling fixes it by running the command.

* **What is said goes to the peer; everything else is a command.** The
  submit is parsed by `parseSlash` as in every window. Plain text and
  `/me` go to the peer through Olm as one message, as before; any other
  command runs **in clear**, on purpose: a command is not part of the
  encrypted conversation. #2512's "nothing typed in that window reaches
  grappa's send door in clear" now holds for what is said, not for what
  is typed.
* **`/me` is the one exception, inside the plaintext.** It is
  conversation, so it must not leave as a clear CTCP ACTION. The engine's
  inner message is `{t: "text", body}` (vjt/irc-olm, shared with the
  bots), and the action rides in `body` as the CTCP envelope,
  `\x01ACTION …\x01`, framed by `wireBody`, the call every other door
  frames with. Chosen over a new inner field: the envelope is the shape
  grappa's own scrollback already stores an action in (the CTCP
  "preserved as-is" rule), so the receiver needs only to recognise it,
  and the scrollback's action line already unwraps it; a peer that knows
  nothing of it (an irc-olm bot) still gets the words. Typed text is
  scrubbed of the delimiter first (#1126's exit scrub), so only `/me`
  frames an ACTION. An empty `/me` sends nothing, as in any window. A
  multi-line `/me` is one action, as a multi-line text is one message.
  What is said is now `parseSlash`'s body, so it is trimmed as in every
  window (a pasted code block loses its first line's indentation) and
  `//` sends a leading slash as text.
* **The receiver draws it as an action, ours or the peer's.**
  `EncryptedChatPane`'s `lineOf` gives a body in the envelope the
  scrollback's `action` kind (`isCtcpAction`, next to `stripCtcpAction`
  in `ctcpAction.ts`; `frameBudget` now asks it too instead of spelling
  the prefix), so `* nick waves` renders as in any query, still locked
  and still carrying its state. The chat's search
  reads what a line says (`stripCtcpAction`), not the envelope.
* **With the ciphertext view (#2513, which landed while this was open).**
  That view shows what crossed IRC, and an ACTION crossed as payloads like
  any message, so there its line is the payloads as a plain message line,
  never the action line (`lineOf` asks `isCtcpAction` only outside that
  view). The search counts an action as a message in either view and
  reads it unwrapped. The compose box does not look at the view: `/me`
  still goes to the peer encrypted and every other command still runs, a
  pane test in that view pins both.
* **A command runs as it would in the plain query with the peer.** The
  command context's submitting window is that query for a command typed
  in an encrypted one: a verb aimed at "here" (`/notice`'s echo, `/np`,
  a CTCP's source window, a bare `/part`) aims at the plain query, never
  at `$e2e:<nick>`, a window grappa has never heard of and whose 4xx
  feeds fail2ban (grappa-irc#160). It is the window #2512's nick menu
  already answers in. Bare `/whois` asks about the peer, as in a query.
  The two context fields part here: `key` stays the encrypted window, so
  an answer shown in the window (`/ignore`'s, `/topic`'s) lands where it
  was asked. The peer is as the chat spells it, exactly what the nick
  menu passes, not folded to an open query's casing.
  **Consequences, accepted with the ruling:** `/np` and `/ctcp <peer>
  ACTION …` there are clear ACTIONs (neither is `/me`), as is a user alias
  that shadows `/me`; and a bare `/query` (`/q`) is still an error there:
  it closes a *query*, and the encrypted window's × closes that one,
  asking first when the chat keeps messages.
* **The paste guard follows the same line.** #2512 skipped the flood
  guard in an encrypted window because a pasted block was one message.
  That holds for what is said only: a block handed to a command there
  (`/msg x ` and twenty lines) fans out in clear as anywhere. The guard
  now asks `sentEncrypted(slug, window, draft)` of the draft the paste
  leaves, the same question `dispatchDraft` answers (`isSaid`), and
  guards a command's block as any window would.

Tests: compose (plain text to the encrypted door; `/whois carol` and
`/ns identify` on the normal path with no encrypted send; bare `/whois`
on the peer; `/notice`'s echo in the plain query; `/me` single and
multi-line encrypted in the envelope with no clear send; empty `/me`;
`//` and a pasted delimiter; `sentEncrypted`), the paste router (it asks
about the draft the paste leaves, and guards a command's block), the
pane (an envelope is an action line, the peer's and ours; the search
ignores the envelope). Each rule read red against a mutant of its own,
each turning only its own tests red (the never-action mutant also turns
the search test, which reads the line's kind). e2e: `issue2536-encrypted-query-commands.spec.ts`, two
browsers on the real ircd: Alice sends `/ns identify notforbob` and the
real NickServ answers her (a notice naming her nick, as its reply to
that IDENTIFY does); `/me waves at bob` reaches Bob as an action;
neither window shows the identify, and grappa keeps no DM history between
them. The absence is barriered by order: Alice's encrypted messages to
one peer leave in the order sent, so an identify sent to Bob would have
preceded the action. **Not run locally** (the stack lane is w2's): CI's
integration run is the spec's first.
<!-- entry #2530 -->

---

## 2026-11-05 — #2530: the service worker lets Cloudflare's /cdn-cgi/ through

Behind Cloudflare Access (Zero Trust, an Access application in front of the
whole hostname) the installed PWA could not finish the Access login. Access
ends it with a navigation to `/cdn-cgi/access/authorized` on the app's own
origin, and that response is what sets the Access session cookie. The SW's
navigation fallback answers every navigation outside its denylist, so the
callback went to the shell handler and never reached Cloudflare: no cookie,
and every REST call kept being redirected to the Access login host. Removing
the Access application restored the app, which is what pointed at the SW.

* **`/^\/cdn-cgi/` joins the denylist.** `/cdn-cgi/` is the prefix
  Cloudflare reserves on every hostname it proxies, so no app route can live
  under it and denying it costs the shell nothing. Off Cloudflare nobody
  navigates there; if somebody did, the request would reach the server and
  `SpaController`'s catch-all would hand back the same shell from the
  network instead of the precache.
* **Not a router scope, so the superset check is blind to it.**
  `RouterSwDenylistTest` checks that the denylist is a SUPERSET of the
  router's top-level scopes; a missing `/cdn-cgi` stays green there. The
  one earlier non-router entry, `/socket` (mounted on the Endpoint), is held
  by the same test's hard-coded baseline list, which only proves the token
  is in the source.
* **So the route moved where a test can ask Workbox.** The denylist lived
  inline in `service-worker.ts`, which no test can import (it declares the
  `ServiceWorkerGlobalScope` `self` and registers listeners on load).
  `lib/swNavigationRoute.ts` now builds the route the SW registers, and
  `swNavigationRoute.test.ts` asks Workbox's own matcher what it answers,
  against path plus query string: the shell on the SPA's routes (the
  positive control), the network on REST scopes and on `/cdn-cgi/…`. Red on
  the callback before the entry, green after. A presence check could not
  tell a regex that matches from one that does not; issue 2531 needs exactly
  that, for an entry keyed on a query parameter. `RouterSwDenylistTest`
  still parses the array literal, now from the new file. Inside it, a `]`
  in a comment ends the parse, and regex-shaped text in a comment counts as
  an entry, so the literal's header says to name prefixes as paths.
* **Scope.** Only the login callback. Recovering an installed PWA once the
  Access cookie EXPIRES is issue 2531, and it depends on this entry: the
  re-login it triggers ends at the same callback.

**Deploy class:** cic bundle only (`--cic`). No server code changes; the
Elixir test edit is test-only.
<!-- entry #2531 -->

---

## 2026-11-05 — #2531: an installed PWA signs back in through an expired auth proxy

With cicchetto behind Cloudflare Access (or another authenticating proxy in
front of the whole hostname that answers an expired session with a redirect),
an installed PWA could not recover once the proxy's cookie expired. The shell
still came up, served by the service worker from the precache, so the user
saw the app; every REST call was then redirected to the proxy's login host,
`fetch` followed that cross-origin, and the browser rejected it as a CORS
failure ("Load failed" on iOS). Nothing in the app made a top-level
navigation, so the proxy never got to run its login.

* **A reload cannot fix it, which the issue's suggested cure missed.** The
  issue asked for "a top-level navigation to reload the page". In an
  installed PWA that request never leaves the device: the precache route
  answers `/` and the navigation fallback answers every other SPA route.
  `swNavigationRoute.test.ts` pins this premise as the precache leg's
  positive control, with Workbox's own `PrecacheRoute`.
* **Detection: the boot GETs stop following redirects.** `bootFetch` (the
  three #717 boot GETs, which the resume and reconnect refetches also use)
  sends `redirect: "manual"`, so the proxy's 302 arrives as an
  `opaqueredirect` response instead of a cross-origin follow. Grappa never
  redirects those GETs, so a redirect there can only come from something in
  front of it. It is rejected at once as `AuthProxyRedirectError`, checked
  outside the `try` so it is never retried: it is an answer, not a stall,
  and before this change it was spent as three "transport failures".
* **The "non-JSON response" half of the issue's trigger is declined.** nginx's
  HTML 502 while the BEAM restarts is non-JSON too, and answering it with a
  navigation would take the user out of the app onto an error page instead of
  leaving them on the boot-failure screen, whose Retry works once the server
  is back.
* **Recovery: one navigation the worker lets out.** `requestReauth`
  (`lib/authProxy.ts`) replaces the document with the current URL plus
  `?reauth=1` (a replace, so a Back out of the proxy's login does not restore
  the failed page from the bfcache with its button frozen mid-press). The navigation
  denylist gains `(\?|&)reauth=` (Workbox matches path plus query string), and
  the precache route ignores the URL because no precached entry carries a
  query. The proxy sees the request, runs its login, and sends the browser
  back; Cloudflare Access does that through `/cdn-cgi/access/authorized`,
  which is why this depends on #2530. `stripReauthParam` drops the marker
  at boot, because a reload of a marked URL would also skip the worker and
  land on the browser's offline page if the link were down.
* **Where it fires: the boot-failure screen.** The rejected boot resource
  already lands in `BootErrorBoundary` (#717), at boot or on a resume
  refetch. On an `AuthProxyRedirectError` the screen starts the navigation
  itself, once per five-minute window kept in `sessionStorage`. The window
  stops the loop that needs no human, an identity provider that signs the
  user straight back in while the cookie never sticks. Inside it, the
  second button reads "Sign in again" instead of "Restart app" (a restart
  is answered by the worker and signs nobody in) and navigates on press.
* **Known gaps, not handled here.** The login door (`POST /auth/login`) is
  not a boot GET, so a logged-out user behind an expired proxy still sees a
  plain failure. Cloudflare's opt-in Managed OAuth answers non-browser
  clients with a 401 instead of a 302, and a 401 on `/me` takes the existing
  `on401` path, which clears the grappa token. A proxy that redirects with
  the precache gone (iOS can evict it) fails inside the worker's shell
  handler before the app exists, where nothing in the app can act. A proxy
  whose login callback sits on THIS origin under a path no entry covers
  (oauth2-proxy's `/oauth2/callback`, Pomerium, an authentik embedded
  outpost) gets one automatic round trip and then the button: the worker
  answers its callback with the shell, exactly as it did `/cdn-cgi` before
  #2530, so each such proxy needs its own denylist entry. `/pair` sits
  outside `BootErrorBoundary`, so a redirect met there surfaces as plain
  text with no recovery. And `redirect: "manual"` turning a 302 into
  `opaqueredirect` is exercised only against a stub `Response`, never on a
  real iOS device.

**Deploy class:** cic bundle only (`--cic`), shipped with or after #2530.
<!-- entry #2537 -->

---

## 2026-11-05 — #2537: "add a device" offers its pairing to the account's other sessions, and its link copies

Moving the pairing link from a phone to a PC meant pointing a laptop camera
at the QR or retyping the link. The relay already announced every message
and close of a rendezvous on the user topic, which every session of the
account listens on. What it lacked was the code itself: the ephemeral key
lived only in the QR.

* **A copy button** next to the link. It is the rail's "copy your key"
  button, now one `E2eCopyButton` for both: a refused or insecure-context
  write says why and leaves the link on screen to copy by hand.
* **The offer (protocol 55).** The open carries the creator's ephemeral
  Curve25519 key as an optional `curve`. grappa then broadcasts
  `e2e_pairing_offered {rendezvous_id, curve, expires_at}` on the user topic.
  `E2ePairing.offer/1` answers the subject's rendezvous that has a key, no
  joiner yet and time left. Two doors read it: the user-topic join snapshot,
  and `GET /e2e/pairings/offer`, its REST twin. That is the DCC consent
  banner's pattern (#2089). The snapshot is required, not a nicety: the usual
  order is "add a device" on the phone and THEN the login on the PC, after
  the one live push has gone.
* **A banner, never an automatic join.** This deviates from the issue's text
  ("opens the joiner side on its own"), by the orchestrator's ruling (A1). A
  rendezvous takes one joiner, so every eligible session joining by itself
  would race. A forgotten tab on another machine could win, leaving its check
  code on a screen nobody is looking at and "already joined" on the one in
  front of the user. The banner's button loads `/pair#pair=<id>.<curve>` as
  a document (`loadDocument`), the same route a scan lands on, so the joiner
  side is `PairScan` unchanged. The × is "Not now", which hides it on this
  page only; a reload or another pairing asks again. Every rejoin's snapshot
  pushes the same offer again, so the store keeps the offer it already holds:
  clearing it first, outside a batch, let the banner stack's re-arm effect
  see no entry for a moment and forget the dismissal (found in review).
* **Who sees it is derived, not checked.** Only a browser that does not hold
  the account's identity on some network sees the banner. That is
  `identityElsewhere(slug)`, which the page-load identity sync already keeps
  for every network. The approved design said to sync each network when an
  offer arrives; the existing signal gives the same answer for no extra GET,
  and it reacts when a sync lands after the offer. The tab showing the QR is
  told its own offer back, and recognises it by the key it made. It registers
  that key before the open, so a push that arrives before the POST's answer
  is still recognised.
* **When it ends.** At the first `e2e_pairing_message` of its rendezvous
  (someone joined; derived, so no `joined` event was added), at
  `e2e_pairing_closed`, and at `expires_at` on a client timer, in case the
  tab missed the push. The snapshot skips a rendezvous that is joined or
  past its ttl, even before its timer fires.
* **The key is public:** it is the half of the code the QR already shows. A
  malformed one, blank included, is 422 before it costs an open; it must be
  43 characters of standard base64. An older client opens without it, and
  nothing is offered. What did change is who learns the rendezvous id:
  before, whoever saw the QR; now every socket of the account, before anyone
  joins. A forgotten or hostile session of the account can therefore join
  first, and gets no further: the user, who is not looking at that screen,
  confirms the check code on neither side, so the worst case is a pairing
  that has to start again, not a copied identity. The user topic does not
  filter on session kind, so a per-client token's socket hears the offer, as
  it has heard every pairing message and close since #2430, while
  `GET /e2e/pairings/offer` stays in `:full_session` with the rest of the
  relay and refuses that token (403). Joining needs a full session either way.
* **The relay's state is now visible to the hot-deploy preflight.**
  `Rendezvous` gained a field, and `E2ePairing` holds rendezvous in its
  state. Since #2430 its `init/1` returned its argument, so the extractor
  saw no shape and the GenServer was not in `LongLivedModules`: this branch
  would have classified HOT, and after the reload the first offer lookup
  would have read `curve` off a rendezvous built before it and crashed the
  relay, dropping every account's pairing. `E2ePairing.t` now names the
  state; the membership test then required `E2ePairing` among the modules
  and `Rendezvous` and `Message` among the state helpers, and with them the
  branch classifies COLD.
* **Known gaps, accepted.** (1) A rejoin's snapshot can add an offer but
  never remove one: a browser that missed the close, or the joiner's first
  message, while disconnected keeps the banner until `expires_at`, and its
  button lands on `/pair`, which says the pairing is gone or taken. cic
  does not call the REST twin; a call beside `catchUpPairings()` on rejoin
  would close it. (2) The keys a browser opened with are held per tab, so
  another tab of the creating browser shows the banner when that browser
  lacks the identity on some network, and its button gets 409
  `pairing_own_rendezvous`. (3) The expiry timer compares the server's
  `expires_at` with the local clock: a clock fast by the whole ttl never
  shows the banner, the assumption the QR's countdown already makes.

### Tests

* `e2e_pairing_test` ("the offer"), the controller test and two user-topic
  snapshot tests pin the server side; `e2ePairingOffer.test.ts` the client
  store, where each of six mutants is killed by exactly one test.
* `issue2537-pairing-offer.spec.ts`, two chromium tests: a browser that logs
  in AFTER the QR is up is offered it through the snapshot and pairs from the
  banner (plus the copy button); a browser already open is offered it live,
  the offer goes at the close, a second one comes, and "Not now" hides it.
* Two mutants on the stack: dropping the join snapshot turns test 1 red at
  the banner (2/2 runs); a close that does not end the offer turns test 2 red
  at the count after the close (expected 0, received 1).
* `ErrorBanners.test.tsx` drives the real offer store and the real banner
  stack: "Not now", the same offer delivered again, still hidden; another
  pairing, shown. Red on the old delivery at the second delivery.
<!-- entry #2543 -->

---

## 2026-11-05 — #2543: `/np` and `/ctcp <peer> ACTION` in an encrypted query go encrypted

#2536 made `/me` in an encrypted query ride inside the Olm message as an
ACTION and listed, as a consequence accepted with its ruling, that `/np`
and `/ctcp <peer> ACTION …` there stayed clear ACTIONs. #2543 takes that
consequence back: they are the same thing on the wire as `/me`, so the
now-playing line and a typed action went to the server and the network in
clear from a window that says it is encrypted. Nothing ACTION-shaped now
leaves an encrypted query for its peer in clear.

* **One door for every ACTION a command sends: `CommandContext.sendAction`.**
  Both handlers used to frame their own `\x01ACTION …\x01` and hand it to
  the window-message seam. They now call `ctx.sendAction(target, text)`,
  built per submission in `dispatchDraft`: aimed at the peer of the
  encrypted query it was typed in, it is what `/me` is there, one message
  through Olm; to anyone else, and from any other window, the clear ACTION
  it always was. It lives on the context and not in the handlers because
  the answer depends on the window the command was typed in, which only
  the dispatcher knows (since #2536 `submittedFrom` is the plain query for
  a command typed in an encrypted one, so a handler cannot tell).
* **The peer is matched by the network's casemapping** (`nickEquals` +
  `casemappingForSlug`): `/ctcp BOB ACTION` is the peer as much as
  `/ctcp Bob ACTION`. `/np` aims at the window it was typed in, which in an
  encrypted query is the peer by construction.
* **One encrypted send, `sayEncrypted`.** The send `/me` used is lifted out
  of the dispatcher's branch so every ACTION to the peer shares it: the
  #1126 scrub of typed delimiters (a `\x01` inside `/ctcp`'s text cannot
  frame a second CTCP), "nothing left to say sends nothing" (so an empty
  `/ctcp <peer> ACTION` sends nothing, as an empty `/me`; in a plain window
  it still sends the bare `\x01ACTION\x01` it always did), and the
  log-and-rethrow on a send the engine never took, which the pump turns
  into the text handed back.
* **Out of scope, still clear on purpose:** an ACTION to another nick
  (`/ctcp carol ACTION …` from the encrypted window with Bob is not the
  encrypted conversation) and every other CTCP (`VERSION`, `PING`, …), a
  request to the peer's client rather than something said.
* **The paste guard asks the same question.** `sentEncrypted` answers yes
  for an ACTION to the peer too (`actsToPeer`, beside `isSaid`), so a block
  pasted after `/ctcp <peer> ACTION ` is said as one encrypted message, no
  burst, and is never offered the guard's way out, the text file that
  would put it on the upload host in clear.

Tests: compose (`/np` encrypted with the now-playing envelope and no clear
send; `/np` with nothing playing sends nothing anywhere; `/ctcp Bob ACTION`
and `/ctcp bob action` both encrypted; a `\x01` inside the text scrubbed and
an empty one sending nothing; `/ctcp carol ACTION` and `/ctcp Bob VERSION`
still clear; a `/np` the engine refused handed back with the log line;
`sentEncrypted` for an ACTION to the peer, to another nick, another CTCP and
a plain window). The `/np` fetch stub `tuneWith` moved to file scope so both
`/np` blocks share it. Seven mutants, each killed by its own tests: the
door always clear (4 red), the peer matched with `===` (2), the guard
without `actsToPeer` (1), without `/np` in it (1), no scrub (2), an empty
ACTION sent (2), no log line (2). Caveat: `nickEquals` is mocked
case-insensitively in that file, so the casemapping argument itself is not
pinned there. Full vitest 8895/8895, `bun run check` 5/5.

e2e: `issue2543-encrypted-query-actions.spec.ts`, two browsers on the real
ircd, chromium. Alice tunes the radio (feed answered in the page, stream on
a route), opens the encrypted query and sends `/ctcp <bob> ACTION …` then
`/np`: both are her action lines and reach `sent`, both are Bob's actions
from Alice in the encrypted window, neither grappa holds DM history between
the two nicks (Bob's is what the ircd delivered him, where a clear ACTION
would be a DM row), and the ciphertext view on both ends shows two payloads
and never the words. The ciphertext view's helpers (`FRAME`, `bodies`,
`menuItem`, `flip`) moved from the 2513 spec to `fixtures/encryptedQuery.ts`.
Run locally with the stack: 2543, 2536 and 2513 (desktop and `@touch`) 4/4
green; 2543 against a mutant whose encrypted branch sends the clear ACTION
instead went red at Alice's first action never reaching `sent`.

**Deploy class:** cic bundle only (`--cic`).
<!-- entry #2529 -->

---

## 2026-11-05 — #2529: a multipart body is parsed by the route that takes it

The operator raised the video per-file cap to 500 MiB on prod (2026-11-03)
and uploads above 128 MiB still failed with a 413: the endpoint parsed every
multipart body with one compiled ceiling of 128 MiB, and the 250 MiB cap
before it had never been reachable either. That is the third time a per-file
cap sat above the transport (a 100 MiB cap met a 64 MiB ceiling on
2026-06-10).

* **One maximum, owned by policy.** `ServerSettings.max_upload_per_file_cap_bytes/0`
  is 512 MiB, and `put_upload_per_file_cap_bytes/2` refuses anything above
  it. The admin door names the field on that refusal (422
  `invalid_setting`, the cap keeps its old value) instead of restating the
  guard, the posture `apply_auto_away_key/2` already takes. Keys applied
  before it in the same body are still written: the door applies keys one
  at a time, for every invalid value, which predates this change and is
  issue 2546. A row stored above the maximum before this change reads as
  the maximum: that is what an upload can get, and the admin form, which
  sends every cap on every save, would otherwise have every save refused on
  a cap nobody touched. Prod's 500 MiB is below it.
* **Multipart leaves the endpoint.** The endpoint's `Plug.Parsers` now
  carries only `:urlencoded` and `:json`; with `pass: ["*/*"]` a multipart
  body crosses it unread, `body_params` still unfetched, and
  `Plug.MethodOverride` skips an unfetched body. The route that takes a file
  parses it in a router pipeline after `:authn`: `:upload_body` for the two
  routes whose body a per-file cap polices (`POST /api/uploads`, every
  category, and `PUT /networks/:network_id/avatar`, the `:image` cap), up to
  the maximum plus 8 MiB of framing room (520 MiB); `:multipart_body` for
  `POST /themes/background` (8 MiB cap of its own), up to 128 MiB, the old
  ceiling. A body is read only for an authenticated subject, and only on a
  route that takes a file. Both numbers live in `GrappaWeb.MultipartLimits`
  as literals rather than computed from `ServerSettings`: the router reads
  them at compile time, and a compile-time call into a module with runtime
  dependencies would recompile the router and the endpoint whenever that
  module's graph changed. The test holds the upload ceiling above the
  maximum instead.
* **Considered and set aside: a parser wrapper in the endpoint** that picks
  the ceiling by method and `path_info`. It works, but it runs before the
  router, so the doors are a copy of two router facts that has to be pinned,
  and the doors still read before authentication. The router pipeline makes
  the router itself the list.
* **The price, made loud where it can be.** A route whose action takes a
  file but forgets its pipeline gets `params` without the body, silently.
  `MultipartBodyTest` reads each routed controller action from its module's
  debug info and follows the functions of that module it reaches (local
  calls, `&fun/n`, `__MODULE__.fun`): an action that matches
  `%Plug.Upload{}` must pipe through one of the two pipelines, and nothing
  else may; the pipeline must come after `:authn`; `:upload_body` reaches
  only the two per-file-capped actions. It does not see a file taken only
  through another module's function, or matched as a bare map without the
  struct; every file route here matches the struct in its own controller.
  `route_info/4` supplies the pipelines, since `__routes__/0` does not carry
  them, and each pipeline's ceiling is read from the compiled router, where
  `plug` options sit as literals. The endpoint is checked with the real
  numbers: a body just over 128 MiB reaches the per-file cap on both doors
  (a controller's 413 `file_too_large`), stops at the parser on the theme
  background, and is never read without a bearer.
* **nginx carries the same two numbers.** The shared snippet and the TLS
  front door example set 128m for the server and 520m in two locations
  nested in `location /` (nested, so they inherit its proxy headers; each
  repeats `proxy_pass`, which never inherits). nginx cannot tell methods
  apart, so every method on those two paths gets 520m at the edge. The same
  test holds both files to the BEAM's numbers, the locations to the
  router's upload paths and inside a `location /`, and fails on a size that
  is not whole megabytes. The e2e stack's nginx gates the snippet's syntax;
  nothing gates the TLS example's. The commented k8s Ingress example gains
  a second Ingress for the two doors, because ingress-nginx applies
  `proxy-body-size` per Ingress; it was written from the documentation, not
  run on a cluster.
* **Not covered here.** m42's host vhost is the operator's and outside this
  repo: it needs the same two locations, and until it has them its 160m
  ceiling stays the limit on prod. The issue's check (a 400 MiB video
  through nginx on prod) was not run: neither prod nor a real nginx is
  reachable from the worker.
<!-- entry #2549 -->

---

## 2026-11-05 — #2549: a pairing travels only as the in-app offer; no link, QR or copy button

"Add a device" by link or QR was broken by design. The link opens in the
system browser, not in the installed PWA, so the pairing completed and
stored the E2E identity in the browser instead of the app the user meant
to pair, and iOS has no way to route a link into an installed web app. The
copy button #2537 added made the same link easier to move. All three are
gone: the offer #2537 pushes to the account's signed-in sessions, accepted
from the "Pair this browser" banner, is the one way a pairing reaches a
device.

* **The holder's side** (`AddDeviceOffer`, formerly `AddDeviceQr`) opens the
  rendezvous with its ephemeral key, which makes grappa offer it, holds the
  channel, and tells the user where to accept it, with the countdown. It
  shows nothing that carries the code.
* **The banner hands the code to `/pair`, once, and nothing else can.** Its
  button writes the tapped offer's id and key to this tab's
  `sessionStorage` (`acceptPairingOffer`) and loads `/pair` as a document;
  `/pair` (`PairJoin`, formerly `PairScan`) takes the slot on mount,
  clearing it whatever happens next (`takeAcceptedPairing`), and joins that
  rendezvous. A code in the URL is never read.
* **Why a hand-over, and not "join whatever the account offers".** The first
  cut of this branch had `/pair` read `GET /e2e/pairings/offer` and join the
  answer. Review found the hole: that page then joined on ANY load — a Back
  to a finished `/pair`, a reload, a restored tab, an old
  `/pair#pair=…` link opened in a signed-in system browser — and stole the
  next pairing, one the user meant for another device. That is the misroute
  this issue exists to close, and it broke #2537's rule that only a tap
  joins. The hand-over is consumed once, lives in one tab, and no URL
  reaches it, so all four cases find nothing and join nothing. It also made
  the REST read unnecessary: the offer the banner shows carries the id and
  the key, and the document load only needs a place to keep them. A slot
  that holds something unreadable is cleared and read as nothing (the
  `bundleRefreshNotice` storage-boundary pattern).
* **Every page that ends on `/pair` leads back.** `/pair` is outside the
  Shell, so outside its banners, and an installed app has no address bar:
  "Back to grappa" is shown when nothing was handed over, when a request
  failed, and when the pairing ended or finished. Before, recovery was a new
  camera scan; now it is the banner, which lives in the Shell.
* **Dead with the URL, removed:** `pairingUrl`, `parsePairFragment`, the
  fragment key and the id/curve regexes that only validated a URL;
  `PairScan`'s "invalid" and "login" stages, folded into one "none"; the
  fragment scrubbing; the encrypted pane's "paste the pairing link" field
  and its handler. `loadDocument` stays (the banner uses it), and so do
  `lib/qr.ts` and `E2eCopyButton`, which the share modal, TOTP enrolment
  and the rail's key copy still use. User-facing copy that said scan, show
  a code, or link now names "add a device" and the banner.
* **No wire change.** cic reads no new door. A pre-55 server never offers,
  so against such a server cic can no longer pair at all; `socket.ts`'s 55
  note says so, and the floor stays at 9 because nothing else breaks.
* **Left as it was:** the server's moduledocs (`Grappa.E2ePairing`, its
  `Wire` and `Rendezvous`) still describe a QR as the way a client carries
  the code. They describe the relay, which is unchanged and still serves a
  client that does show a QR; changing them would turn this cic-only change
  into a server deploy for prose. The comment in the vodozemac binding's
  Rust source that says the key goes "in the QR" also stays: fixing it means
  regenerating the wasm. `docs/CLIENT_PROTOCOL.md` now says what the code
  is, and that cicchetto sends it only through the offer.

### Evidence

* vitest red first, both rounds: the hand-over functions missing, and every
  `/pair` test waiting on a join the old page never made. Then the full
  suite: 414 files, 8896 tests, 0 failures; `bun run check` 5 stages, 0
  failed.
* Eleven mutants, each killed by the test that names it: `/pair` joining
  with nothing handed over, preferring a code in its URL, taking the
  hand-over only once logged in (so a logged-out visit leaves it behind),
  joining after the user left the page, or dropping the way back from an
  ended pairing; the slot surviving its take, or read without validation;
  the banner handing nothing over; the offer panel printing the rendezvous
  id or gaining a button; the pane keeping a paste field.
* e2e: the pairing fixture takes the pairing from the second browser's
  banner, so the 2430 pairing and copies specs exercise the banner path.
  The 2537 spec checks that the open panel holds no link, QR or `/pair`
  text and no button but Close, and a new test opens `/pair` straight, with
  a code in its URL, while a pairing is on offer and the browser's banner is
  up: "where pairing starts", the holder still waiting, the device list
  unchanged. The 2430 key-bundle spec used the deleted paste field; it now
  checks the card's pointer to the banner and that it holds no input. These
  run in CI; the worker does not hold the docker stack.
* Not verified on a device: the installed iOS PWA. The flow it now takes is
  the banner's from #2537, plus a `sessionStorage` slot across a same-tab
  document load.
<!-- entry #2553 -->

---

## 2026-11-05 — #2553: the .deb's glibc floor is pinned at the runner and proved on trixie

`grappa_1.6.1_amd64.deb` and `grappa_1.6.2_amd64.deb` would not start on
Debian trixie: `beam.smp: libm.so.6: version 'GLIBC_2.43' not found`. Two
self-hosters went back to 1.6.0.

**Cause (measured in the issue).** The bundled ERTS and `shottino` link the
glibc of the runner that builds them. The amd64 leg of the deb job ran on
`ubuntu-latest`, and GitHub moved that label from 24.04 to 26.04 between
v1.6.0 and v1.6.1. beam.smp's highest `GLIBC_` symbol went from 2.38 to
2.43 on amd64; arm64, pinned to `ubuntu-24.04-arm`, stayed at 2.38. Trixie
carries 2.41. Every proof in the job passed for both releases, because they
all install on the runner, the one host where a glibc mismatch cannot show
up.

**Two cures, both needed.**

* Both legs name ONE Ubuntu release: `ubuntu-24.04` and `ubuntu-24.04-arm`.
  A label that moves means the floor moves, and two legs on two releases
  mean two floors under one version number.
  `test/infra/release_deb_glibc_floor_test.bats` holds both properties.
* Before uploading, the deb job installs both packages on a stock
  `debian:trixie` and starts the BEAM and the client there
  (`infra/packaging/deb_floor_proof.sh`). The pin alone does not hold the
  floor: GitHub will retire 24.04 one day and someone will bump it, and
  then this step is what notices.

**Why a step inside `deb` and not a job named in `publish`'s needs.** The
issue's natural reading is "publish depends on the smoke". That would go
red without gating anything: `publish` runs on `!cancelled()` and attaches
whatever the legs uploaded (#504), so the broken package would already be
in the artifact set. A proof placed ahead of the upload steps keeps the
package out of the run, and `publish` then refuses to *create* a release
from an incomplete set (#1591). The same order rule the #1714 arms follow.
For the same reason neither the step nor the uploads may carry an `if:` or
`continue-on-error:`; the bats suite pins that, along with `runs-on:` really
reading the matrix runner.

**The script comes from the dispatched ref, not the checked-out tree.** A
repair dispatch builds an existing tag, and no tag cut before this one
carries `deb_floor_proof.sh`: running the tag's copy would die 127 and turn
red the very repair that republishes 1.6.2. The step `git show`s the file
from `GITHUB_SHA` into `RUNNER_TEMP`, which leaves the tag's tree clean; on a
tag push and a `deb_validation` dispatch the two are the same commit. Found
in review. Inside the container the checks travel as a `bash -c` argument,
not on stdin, because the postinst starts the BEAM twice and a child that
drained a piped script would end the run green with no check executed.

**What the floor proof runs, and what it leaves out.** The install itself
(postinst runs `grappa migrate`, which starts beam.smp and loads the exqlite
NIF), a `grappa eval` that loads the crypto NIF against trixie's libcrypto
and prints a digest checked against `sha256sum`, and `shottino --help`. It
installs Depends only: the Recommends (nginx, ffmpeg, exiftool) are
Debian's own builds and pull about 300 packages, none of which is the
subject.

**Bookworm is not supported, and the step does not pretend it is.** Glibc
2.36 has never run a 24.04-built ERTS; 1.6.0 needed 2.38 already. The
`libssl3` fallback in `nfpm.yaml` still resolves there, so apt installs the
package and its postinst then fails. Declaring `libc6 (>= 2.38)` would turn
that into an apt refusal; that is a separate change and not made here.

**Not done here:** republishing the 1.6.2 amd64 `.deb` to the apt repo. That
is a repair dispatch from main once this lands, owned by whoever cuts it.
<!-- entry #2547 -->

---

## 2026-11-05 — #2547: a browser with no keys says why, and leads to pairing

**What happened (prod, 1.6.1, 2026-11-05 04:37–04:43 CET).** After vjt
force-quit and relaunched the installed PWA on their phone (the master
device), the encrypted query showed "this account's encryption identity
… lives on another device, or was lost". The only visible way out was
"start a new identity here". They pressed it twice (04:42:05 and 04:43:15).
Each press deleted the identity on grappa and made a new master, and the
peer bot raised a key alarm.

**What the investigation established.** The code was not at fault and
1.6.1 did not cause it: `accountStore.ts`, `identity.ts`, `parseRecord`,
the server's e2e code and the service worker are byte-identical across
v1.6.0..v1.6.1. The m42 log, read by device id (the log names no subject,
and the address is a home NAT), rules out two of the three code paths to
"elsewhere":

* **M2 ruled out:** a paired device plus a 404 on `GET /e2e/list`. Every
  list GET answered 200.
* **M3 ruled out:** grappa's list moving under the device. The only
  `DELETE /e2e/keys` are the two presses.
* **M1, refined:** the context that showed "identity lost" held NO e2e
  record. The original records were NOT destroyed: at 04:42:38 another
  context of the same account drained with the original azzurra device
  (404, the first press had just deleted it) and the original libera
  device (200, in use until 05:02). The device made by the first press
  was polled again at 04:49 and 04:51, while the second press's device was
  current. Two storage contexts of one subject were alive on the phone,
  and vjt was looking at the empty one. Why a relaunch landed in an empty
  context is platform-side (iOS 27, installed PWA). It is not reproducible
  here, and this entry does not explain it.

**The ruling (orchestrator, 2026-11-05).** The window must say WHY, in
the shape "this browser has no keys; grappa lists N of your devices, one
active X minutes ago", and lead to PAIRING. Replacing stays possible but
stops being the main path.

**What changed.**

* **The reason.** `syncIdentity` answers `{ elsewhere: reason }` instead
  of the bare word: `no-keys` (M1, and the bootstrap race lost),
  `replaced` (another master), `left-out` (the list leaves this device
  out), `no-list` (M2: a paired device with no list on grappa). The card
  says it in words and carries it as `data-reason`. An operation that
  finds a record without an identity (`IdentityElsewhereError`) reads
  `no-keys`.
* **What grappa holds.** `heldDevices` counts the devices grappa's signed
  list names, and takes the latest `last_seen_at` among them. An unlisted
  device is a pairing under way, not a device of the identity, so its
  reads count for nothing.
* **`last_seen_at` is new server state (protocol 56).**
  `e2e_devices.last_seen_at` is stamped when a device reads its own
  inbox. Every device does that on page load, on reconnect, and at every
  e2e push, so it is the one per-device heartbeat grappa already sees.
  * **Why not the count alone:** "grappa lists 1 of your devices" reads
    the same whether the keys are gone or were in use one minute ago in
    another context. Only the second answer tells the user to pair rather
    than start over, and on 2026-11-05 it would have read "active 46m ago"
    at 04:42, then seconds.
  * **The write lock is spent once a minute per device at most:** the
    compare runs in memory on the row the inbox door already loaded, so
    the steady poll costs no write.
  * **The stamp is best-effort and never withholds the inbox** (found in
    review: the first cut ran `:ok <- seen` ahead of the read, turning a
    pure read into one that answered 503 under a held write lock). The
    door reads first and stamps after; `seen/1` is always `:ok` and logs
    a miss, the posture `authenticate_client_token/5` takes for the same
    kind of stamp. A due stamp under a held lock still delays that one
    response by up to BusyRetry's budget.
  * **The field is `optional` on the wire, as `dm_with` was in 36:** a new
    bundle still validates a pre-56 server's device list (the copies'
    sibling listing depends on it) and only omits the "active" clause.
* **Pairing first.** The pairing guidance comes right after the reason
  and the devices, and it is #2549's: on a device that holds the identity,
  open "add a device", and this browser's banner takes the pairing. "start
  a new identity here" moved inside a `<details>` that starts closed
  ("none of your devices can pair this browser"), still behind its two-tap
  confirmation. `replaceIdentity`, the e2e fixture four specs start over
  with, opens the disclosure first.

**Known gaps, accepted.**

* **"Active" means "read its inbox", not "a page is open".** A page left
  open and idle has no reason to drain until an e2e push or a reconnect,
  so its stamp ages while it is open.
* **The devices line is read once, when the card opens.** It neither
  refetches nor ticks; a card left open shows the age it had when it
  appeared. A failed read logs `[e2e] could not read the devices grappa
  holds on <slug>` and leaves the line out, since the way out does not
  need it.
* **Nothing flags a second context of the same device.** The card says
  only that a listed device was active recently, and the user has to draw
  the conclusion. grappa cannot tell two storage contexts of one phone
  from two phones.
* **Not reproduced: the platform cause** (why the relaunch opened an empty
  storage context). The two-context e2e reproduces its consequence, two
  storages logged in as one account, not the cause.

### Tests

* `issue2547-identity-elsewhere-why.spec.ts`: two contexts of one account.
  B makes the identity and talks to Bob. A, with empty storage, opens the
  same query. The card says `no-keys`, "grappa lists 1 of your devices,
  active Ns ago", shows pairing first and hides the replace until the
  disclosure is opened, and pairing from the banner (`pairFromBanner`)
  keeps B's master: grappa lists B's device and the one the pairing added,
  and no new identity.
* Server: `E2eKeys.seen/1` (never seen → stamped; younger than a minute →
  untouched; a minute old → moved; a dropped device → `:ok`; a write the
  lock keeps out → `:ok`, logged, the old stamp kept), the inbox door's
  stamp read back through `GET /e2e/devices`, and the door serving the
  waiting message while the stamp's write fails. Both failure tests went
  red on the first cut (`{:error, :db_unavailable}`; a 503).
* cic: each reason off its own path in `e2eIdentity.test.ts`,
  `heldDevices` (listed count, latest listed stamp, unlisted ignored, no
  list → 0), the fake grappa's stamp against the server's rule, and the
  card in `EncryptedChatPane.test.tsx`: each reason's sentence and
  `data-reason`, the devices line read from grappa and a refused read left
  out, the pairing guidance ahead of a closed disclosure holding the
  replace, and `heldDevicesLine` for none, one and several devices, with
  and without an activity it can read; and `identityDevices` rejecting,
  never throwing, on a network the browser cannot use (red on the first
  cut, whose synchronous throw would escape the card's catch).
<!-- entry #2544a -->

---

## 2026-11-06 — #2544a: the key shown is verified by a button, the badge shows the key, the pasted pin is gone

vjt's rulings on the issue (2026-11-05), points 1 and 3; point 2 (the own
device list) is #2544b.

* **The paste-and-pin form goes.** Either the key the rail shows is the
  peer's, or someone is in the middle and the chat must be closed: pasting
  the "right" key over a different one fixes neither. In its place, a
  **verify** button beside the shown key, for when the user compared it
  with the peer out of band. This retires 2430 ruling 6253162964's "bots are
  pinned by hand": a bot's key is taken on first use like anyone's and
  verified against the key it prints. That works because the bot answers a
  KEYREQ once OUR key is pinned there (irc-olm drops one from an unpinned
  nick, `E2E_DROPPED REASON=unpinned-nick`), not once we pinned its key;
  the interop spec now proves it against the real bot. The no-key card says
  so, and the alarm card says the other half of the ruling: take the new
  key and verify it, or delete the chat (the shredder; closing the window
  would leave the alarm open, and deleting keeps the pinned key, so the
  impostor's next line raises a new one).
* **Verify is the pin verb, not a new one.** It pins the shown key again,
  verified (`pinEncryptedKey(…, true)`): the pin stays where it is, a SAS on
  that master is not ended (`Verifier.repinned` ends only those on another
  master), the list is asked for as after any pin (O1), and the row is a
  `pinned`. Not a `verified`: that row means a SAS matched, and the rail
  would then report an emoji comparison that never ran. Considered and
  dropped: a client verb over `Engine.verify`, the SAS's own outcome, which
  would never move a pin even if the shown key were stale by a tab's
  BroadcastChannel lag. It needs a verb, a store wrapper and a row kind of
  its own to say "verified by hand", and the stale case it guards is the
  user's own statement about the key on screen.
* **Where it shows: wherever the badge's door would offer it.** A key
  pinned, not verified, no alarm open, no emoji comparison running, the
  identity here; the rail and the badge apply the one rule. While an alarm is
  open the pinned key offers no verify: the alarm is answered first, and a
  verify beside the old key while a new one is speaking invites verifying the
  wrong one. A verify is a `pinned` row, so like the SAS match and the old
  form it settles a "they could not read your last message" card
  (`unreadableStep`); the next failed send brings the card back. The pin is a
  round trip: one that lands after its dialog closed closes nothing, not
  even a dialog opened since; one that lands while its dialog is open closes
  it, even though the button has gone by then. Measured on both phone
  projects in CI: the refresh the pin sets off reads the key verified BEFORE
  the pin answers, which takes the button away, so a guard keyed on the
  button's life (the first cut) left the dialog open showing the verified
  key. The guard is the dialog's, not the button's.
* **The badge shows the key.** A tap opens a dialog over the chat body with
  the peer's whole key, 43 characters: verified, the key alone; not
  verified, the key, the same verify button, and "compare emoji" second. The
  key is the full Ed25519 key, 256 bits, and needs no protocol around it;
  the emoji are ~42 bits, safe only inside the synchronous comparison where
  the commitment leaves an attacker one try, so they are never an
  asynchronous check. **This retires #2507's "check again"** on a key
  verified by emoji, and `verifiedByEmoji` with it: a verified badge offers
  no comparison at all. The peer can still start one on a verified key,
  so #2507's open question (a failed re-check leaves the badge verified)
  stands for that door only. The door is a button whenever a key is pinned,
  no alarm is open, no comparison runs and the identity is here; it closes
  itself if any of that stops holding (a comparison the peer asks for takes
  its place).
* **The dialog is a covering overlay.** It sits over the scrollback, so it
  registers with `createOverlayLock` (#219-general's freeze, #232's Esc
  stack) instead of a private keydown listener. The SAS dialog, its
  sibling, does not, and was left as it is.

e2e: the `pin` fixture became `verify` (wait for the key taken on first use
to be the one the peer reads off its own pane, press the rail's button).
Specs that pinned before any message now exchange first; the bot specs
(interop, 2511) verify the bot's key after first contact and before any
order, since cic answers no challenge from an unverified key; 2509's
lineless alarm chat now starts from a chat deleted after the exchange (the
pin outlives the rows); `issue2544-verify-shown-key.spec.ts` walks both
doors on desktop and the badge on a phone. None of them ran locally: the
stack is not this worker's to take, and the PR's integration job is the
gate.
<!-- entry #2554 -->

---

## 2026-11-06 — #2554: the unread-ack test fills its path with one large write

`Dcc.TransferTest`'s "a sender that never reads its acks" (issue 2405) failed
now and then in CI with `transfer: {:ok, {:error, :idle_timeout}}`. The issue
read it as the idle timer racing the sender's write pacing under load, and
asked for the test to wait on real progress rather than a longer timeout.
Measured, there was no race to wait out.

**The cause was the fake sender's kernel.** The test narrowed the path by
giving the sender a 1 KiB receive buffer and letting our acks fill it. A
4-byte ack costs the receiving kernel far more memory than its payload, and a
buffer that small full of them sometimes made it drop one its window had
admitted. Every segment we sent after that began past what it expected, the
window updates saying we had drained included, so it discarded them unread,
never learned we had room, and sent nothing more. The drain then timed out
with bytes still owed: the CI message, byte for byte. The signature, diffed
from `/proc/net/netstat` around each run, was in every failure and in no
success: `TCPRcvQDrop` 1, `BeyondWindow` 5 to 18, `RcvPruned` 1. Kernel
7.0.14-linuxkit (Docker Desktop's VM).

- **Measured, not raced.** Under 24 CPU hogs the old fixture failed 8 runs in
  30, each with the drop. Freezing the whole BEAM for 2.5 s mid-drain did not
  reproduce it (17 of 17 survived), and load did not make the drain go silent
  (worst wait for a read, 13 ms). A longer idle allowance only delays the
  failure: given 30 s, a 2 KiB sender passed no byte after its drop, through
  seven retransmission timeouts.
- **No buffer size tried cures it.** 16 KiB passed 30 of 30 loaded runs, then
  the real test failed once in 27 unloaded. 32 KiB dropped once in
  three. `TCP_WINDOW_CLAMP` on a default buffer never closed the window.

**What the test does now.** Before the first byte flows it still shrinks our
send buffer from outside, then writes one MiB of filler on our socket, also
from outside. The sender (receive buffer set to 64 KiB) takes what that
holds, in full-sized segments; our kernel keeps some more; the driver queues
the rest, far past its high watermark. The transfer's first ack meets that
queue, comes back `:timeout`, and acking stops. Once the window is shut our
acks wait in our own queue and never reach the sender at all, so the
thousands of 4-byte segments that set off the drop are gone. The filler write
itself answers `:ok`: `tcp_sendv` (`inet_drv.c`, OTP 28) weighs the watermark
only against a queue that was already there.

- **The check is a rise, not a peak.** Once the sender starts talking, its
  segments carry a fresh window and our kernel takes more filler (measured,
  47 KB), which hid an ack's four bytes from a peak taken against the
  pre-transfer level: the keep-acking mutant survived three runs that way. The
  test now asserts the queue never stood 64 bytes above its lowest earlier
  sample. The payload stays at 128 MiB for the same reason: at 8 MiB the
  transfer ended in about 6 ms, between two 5 ms samples, and the mutant
  passed.
- **Evidence.** 101 of 101 unloaded and 200 of 200 under 8 hogs at 128 MiB;
  200 of 200 under 24 hogs with an 8 MiB payload (at 128 MiB that load runs
  past the test's 15 s budget, as it did before this change, so the budget
  rather than the fixture answers there). Mutants: without `send_timeout: 0`
  the transfer parks after its first chunk (red), and an ack that ignores
  `:timeout` raises the queue 57,380 bytes (red).

**The price.** The queue the transfer meets is filled by the test, not by
acks, so the test no longer shows acks filling the path: it shows that an ack
meeting a full queue neither blocks nor keeps queueing, and that what is
queued at the end is discarded. That is the property 2405 fixed.
<!-- entry #2544b -->

---

## 2026-11-06 — #2544b: the rail lists the identity's devices, and the master's browser revokes them

vjt's ruling on the issue (2026-11-05), point 2. The rail's `devices` row
counted the PEER's devices and still does; under "your identity" nothing
listed ours.

* **What the list shows.** The devices the identity's list names, as this
  browser's record holds that list once a sync has taken grappa's latest
  (signed by the master; without the sync a browser that does not hold the
  master would hide a device paired since its last one), joined with `GET
  /e2e/devices`: the did, since a device has no name or label anywhere;
  when it was added; and which one is this browser. The did is worked out
  here from the device's key, never taken from grappa's row: the revoke
  targets the key, and a server that swapped two rows' dids would have the
  confirmation name one device while the master signs the other out. A
  device registered and never listed, a pairing that did not finish, is no
  device of the identity and is not shown. "When it was
  added" is grappa's `inserted_at` on the device row, which a registration
  of the same key keeps; it was never on the wire, so it is now
  (`E2eKeys.Wire.device/1`, **protocol 57**, optional as #2547's
  `last_seen_at` is, so a client lists an older server's devices without a
  date). The list reads again when the key shown changes, after a revoke,
  and when the add-device panel closes, and at no other refresh: its
  source is one string compared by value, since encryptedChats writes the
  whole own-key record on every refresh of any network and a tuple would
  read the list (and take the slot's lock) at each one.
* **Who revokes.** Only the browser that holds the master, as with "add a
  device": every other device has a revoke, behind a confirmation that
  names it and says what it does; this browser's own has none. Elsewhere
  the list is read-only, and the add-device hint now says devices are
  added *and revoked* from the browser that started the identity.
* **A revoke is one signed act, and the issue's second step is grappa's
  own.** The issue reads "a revoke signs a new list version with the device
  revoked, then removes the device from the server" and names `DELETE
  /e2e/devices/:did` as an existing piece. Measured in the code, the
  removal already happens inside the put: `E2eKeys.put_list/3` drops every
  device the previous list held and the new one leaves out, with its keys
  and queue, in the same transaction. A `DELETE` afterwards would answer
  404, and before the put it answers 409 `listed_device`. So the revoke is
  the master's signature over the list one version up without the device,
  nothing else (`identity.revokeDevice`). It goes through the same sync and
  once-more-if-stale retry as `addDevice`, now one helper,
  `onceMoreIfStale`, for both: a retry never puts a list that drops a
  device another put listed. A key grappa's latest list no longer names
  (revoked meanwhile, from another tab) is refused as `unlisted`, and says
  so, rather than as a signing failure.
* **What a revoke does elsewhere.** Peers drop the device once they hold the
  new list: the engine's `revoked` / `revokedCurves` already apply on
  receipt. The revoked browser's next sync finds a list that leaves it out
  and reads the identity as held elsewhere (#2547's `left-out`). What was
  already on that device stays there; the confirmation says so.

Per network, as the identity is: a device paired across several networks is
revoked on the one whose rail did it. e2e: `issue2544-own-devices.spec.ts`
pairs a second browser, reads both lists (the master's with one revoke, the
other read-only under the hint), revokes from the master's browser through
the confirmation, checks grappa's list one version up and the device gone,
and finds the revoked browser left out. Desktop only: the list is the same
component in the phone's drawer. Not run locally: the stack is not this
worker's; the PR's integration job is the gate.
<!-- entry #2453 -->

---

## 2026-11-06 — #2453: a record cic keys by nick is read and written through one helper

cicchetto's encrypted chats kept their per-nick state in plain objects keyed
by the folded nick. A nick is the peer's to choose, and two valid ones fold
to the name of an Object.prototype member: `constructor` and `__proto__`.
Indexed with them, a plain object answers `Object` / `Object.prototype`
where it holds no entry, and an assignment to `__proto__` runs the prototype
setter instead of storing anything. Measured on the old code: nothing could
be sent to either nick (the queue read the prototype and the send threw), and
neither had a chat of its own in the chat index.

**The rule.** A record keyed by nick in cic's E2E state is a
`ByNick<T>` (`cicchetto/src/lib/e2e/byNick.ts`) and is touched only through
that module: `Object.hasOwn` to read, a defined own property to write, the
fold inside. `ByNick` is an interface with no index signature, so on a record
typed with it `rec[nick]` and `rec.bob` do not compile, and neither does
handing it to a `Record<string, X>`. It is an interface and not a type alias
for that last one: an alias converts to any `Record<string, X>` without a cast,
and the record would be indexed again where it lands (measured: tsc took
`const r: Record<string, number> = noNicks<string>()` from the alias, and
refuses it from the interface).

What the type cannot do is find a record nobody typed: a new nick-keyed
`Record<string, X>` compiles as it always did, so typing it `ByNick` is the
rule, and checking that is review's job. Nor does it see `nick in rec` or
`Object.assign(rec, …)`, which take any object; neither is used on one.

- **Why not a `Map`, prefixed keys or null-prototype objects.** The engine
  state and the chat index are sealed as JSON. A `Map` serialises to `{}`
  and prefixed keys change the stored shape: both need a migration of every
  sealed record. A null-prototype object is undone by the first spread,
  `JSON.parse` or test literal, and nothing tells you. The helper keeps the
  plain object: `JSON.parse` makes `__proto__` an own property and
  `JSON.stringify` writes it back, so no stored record changes shape and no
  read path for old ones is needed. A `constructor` entry an old build stored
  (a plain assignment makes it own) reads as it was; a `__proto__` one never
  got stored at all.
- **Out of scope, on purpose.** Records keyed by an Ed25519 or Curve25519 key:
  the engine looks one up only once it has passed as a canonical key (43
  characters of base64, while the longest Object.prototype member,
  `propertyIsEnumerable`, has 20). A did does come from the wire, as a frame's
  `from`. But grappa relays only the canonical base64url of 8 bytes
  (`IRC.E2e.did?/1`), and no member is one: only `constructor` has the 11
  characters, and its last one carries padding bits. cic reads `bodies` only
  with dids it derives itself. A network slug is the operator's to name.
  `listAnsweredAt` keys a `${nick} ${did}` pair, and no Object.prototype
  member holds a space; the page's per-chat signals in `encryptedChats.ts` key
  on `${slug} ${nick}` for the same reason.
- **Outside the E2E state.** `conversationMute.ts` already read its map with
  `Object.hasOwn` for the same cause. cic's other stores were not swept here.
<!-- entry #2356 -->

---

## 2026-11-06 — #2356: on iOS a compose swipe that starts over the typed text reaches the page as a touch that never moved

vjt's report (2026-11-04, iOS): swipe right, up and down on the compose box
work when the finger lands at the left of the input and are ignored when it
lands over the middle of the typed text.

### Measured on vjt's iPhone (iOS 18.7 PWA, DiagFloat ring, 2026-11-06)

* Each of three failed swipes reads `TS … sel=38,38`, then `END claimed=no
  act=none dy=0 dx=0 moves=0 sel=38,38`. The page got a touchstart and a
  touchend, no touchmove and no touchcancel, and the caret did not move.
* END's `dx`/`dy` are touchend's own `changedTouches[0]` point minus the
  touchstart point. So all three touchends came at their touchstart's
  point. The drag never reached the page, and recognising the swipe at
  touchend from the start→end delta would find zero travel: that route is
  closed on this data.
* Three swipes that worked, in the same session, had 6 to 8 touchmoves
  each. The ring did not record where any of the six started.

### Still open, and what the ring records for it now

* **Where the finger landed.** TS carries `cx`, in px from the left edge of
  the textarea's text (its content box), so a negative `cx` is the padding
  or the border. It is measured, not derived from the CSS: the padding is
  `0.5rem` and the root font size is the user's.
* **When the touchend came.** END carries `ms`, the touchend's event
  timestamp minus the touchstart's, read off the events rather than the
  handler clock. A touchend that comes about when the finger lifts, and one
  that comes before the drag is over, are two different platform
  behaviours.
* **The cheapest device check of the glyph reading below:** a swipe that
  starts in the blank space right of a short draft should behave like one
  from the left padding.

### What WebKit's source says (main, read 2026-11-05/06; not iOS 18.7's build)

* `-[WKContentView hasSelectablePositionAtPoint:]` returns
  `isSelectable()` from a hit test at the point. That is `Selectable` for a
  hit on a text node, a glyph, and `UnselectableDueToFocusableElement` for
  a hit on an element `WebPage::isAssistableElement` accepts
  (`PositionInformationForWebPage.mm`; `WebPageIOS.mm`: a textarea, or
  anything `isContentEditable`). In the padding
  `RenderTextControlMultiLine::nodeAtPoint` remaps the hit to the inner
  editor (`hitInnerTextElement`), which is editable, so the answer is NO; so
  is it in the blank space after short text. That split matches vjt's
  report. Not every UIKit
  question splits there: `textInteractionGesture:shouldBeginAtPoint:` answers
  YES anywhere on the focused element (`isSameElement` against it). What
  UIKit does with the two answers is closed source.
* WebKit makes two explicit calls that cancel the page's touch,
  `_longPressRecognized` and the context-menu preview, both through
  `_cancelTouchEventGestureRecognizer`. A touchcancel can also come from
  UIKit's own `touchesCancelled:` and from removing the default gesture
  recognizers. `WKTouchEventsGestureRecognizer` cannot be prevented by other
  recognizers. All of that fits the device data, which shows a touchend, not
  a touchcancel.
* The levers the page already pulls cancel touchmoves (the claim, the #2465
  shell guard). A touch that delivers none is out of their reach. WebKit
  defers native gestures for the page's verdict at touchstart, at the first
  touchmove (pans and pinches only) and at touchend (taps only).
  `user-select: none` is forced back to `text` on editable content
  (`StyleAdjuster.cpp`), and `touch-action` gates pan and zoom.

### Ruling (vjt, 2026-11-05)

No `preventDefault` on the composer's touchstart. It would fail every
gesture WebKit defers at touchstart, and with them caret placement by tap,
the loupe, long-press selection and the edit menu (Paste).

### What landed

* Diag only, behind `cic_diag`: TS `cx=`, END `ms=`, and a `CANCEL …` line
  for a touchcancel. For a one-finger touch, a TS with no END already meant
  that no touchend arrived (the ring is newest-first and drops its OLDEST
  lines, so an END cannot scroll out while its TS shows); CANCEL tells a
  cancel apart from a touch that got neither event. `moves=` and `sel=` were already on main
  (684ddea3d).
* e2e, `issue2356-swipe-complete-nonempty.spec.ts`: up, down and right, each
  from the left padding and from the centre of a glyph in the middle of the
  draft, through CDP trusted touches on `chromium-pixel-touch`. All six claim
  and act: Chromium has no dependence on the start point. Real Android and
  desktop touch screens were not measured.
<!-- entry #2453b -->

---

## 2026-11-06 — #2453b: lookups keyed by user- or peer-chosen strings read own properties only

#2453 made cic's E2E state read and write its nick-keyed records through
`ByNick`, and left cic's other stores unswept. The rule now holds across cic:
a record whose key is a string a peer or the user chose is a `ByKey<T>`
(`cicchetto/src/lib/byKey.ts`), read with `Object.hasOwn`, written by
defining an own property and copied by a spread, in that module only. The
records it covers:

- the stores keyed by nick: the rail WHOIS cache (`railWhois.ts`), the away
  banner (`peerAway.ts`), the presence dots (`notifyWatch.ts`);
- the wire validator's record walk (`wireValidate.ts`), whose keys are data:
  the presence snapshot's nicks, the `/me` read cursors and unread counts
  keyed by window, and a query window is named after its peer;
- the typed verb and the alias map: the command table and the alias lookup
  in `slashCommands.ts`, the alias store's writes (`aliasList.ts`), and
  `Aliases` itself, which the parsed REST body already is, so no copy is
  made;
- the lookups by a file's extension or declared type: `mediaLink.ts`'s
  extension tables and `uploadCategory.ts`'s MIME and audio-extension
  tables;
- the rail's text for an emoji comparison a peer stopped
  (`EncryptedRail.tsx`): its reason is the peer's own string.

**One helper, and `ByNick` is a fold over it.** The stores outside the E2E
state fold their keys differently, or not at all: the rail WHOIS and the away
banner fold with the network's casemapping (`normalizeNick`), presence keys
arrive server-folded, an alias, a verb, an extension or a MIME type is
lowercased by its caller, and a peer's cancel reason keeps its case (so
`toString` and the other mixed-case member names reach that table, beside
`constructor` and `__proto__`). So `ByKey` takes the key as given, and
`ByNick` is the E2E `fold` over it with a brand of its OWN, so a `ByKey`
helper is never handed a record whose keys must be folded first. `ByNick`'s
API and every stored record's JSON are unchanged. Both brands are
interfaces, for the reason the #2453 entry gives.

- **Out of scope, on purpose.** A key only the operator chooses: a network
  slug, the upload host's accepted MIME list (`mimeExtLabel`), a radio
  station id, the captcha provider. A key that cannot name an
  Object.prototype member: a single mode or prefix letter, a numeric id, a
  composite key holding a space (`ChannelKey`, `${nick} ${did}`).
  `attachmentPreview.ts`'s document table is read only with a type
  `categoryOf` has already admitted as a document, so its key is always one
  of its own.
- **What the type cannot do** is what #2453 says: it does not find a record
  nobody typed `ByKey`, and it does not see `key in rec`. A new record keyed
  by a chosen string is a `ByKey`, and checking that is review's job.
