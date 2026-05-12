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
- **IRC-over-WebSocket** to the web client (soju + gamja's native transport). The client ends up re-implementing IRC protocol state in JS. Principled, but not what we want.

**Apply:** the web client does not parse IRC. Ever. REST is the contract; IRC terminates at the server. See README §"Design principles", point 1.

---

### 2026-04-20 — server architecture pitch

Dictated in #sniffo:

- **Server:** Elixir/OTP, persistent, one **supervised GenServer per user session** (BEAM process — millions are cheap, isolated heaps, fault-isolated, restarted by a supervisor on crash). Connects upstream, stays connected. **Authenticated HTTP API** — no server-side UI. **Auth via NickServ** (SASL for login, proxied `REGISTER` for signup). **State persisted** on disk via Ecto+sqlite. **Scrollback is lazy** — pagination on scroll, not firehose. **Network-agnostic** with sysadmin allowlist. **Self-hostable** anywhere.
- **Client:** TypeScript-flavoured PWA. Fetches current state on connect (channel list + last N lines), then subscribes to Phoenix Channels for live event push. Visually irssi on desktop; mobile = same irssi shape + touch-ergonomic helpers. No chat-app metaphor.

**Apply:** Tech stack for Phase 1: Elixir + Erlang/OTP + Phoenix + Ecto + `ecto_sqlite3` + own IRC client module (binary pattern matching). Streaming surface is **Phoenix Channels** (multiplexed WebSocket pub/sub). Client framework still open (candidates: Svelte, SolidJS, lit-html), all integrate with `phoenix.js` (3KB, framework-agnostic). Themability is a first-class feature (irssi `.theme` parser portable to TS — grammar is simple).

---

### 2026-04-20 — rejected: forking soju

Before committing to greenfield, the question: can we land this as a fork of [soju](https://soju.im/)?

Verdict: **dead on arrival**. soju's design identity is IRCv3-first — every feature beyond vanilla IRC ships as an IRCv3 extension. The WS support they added is "IRC framing over WebSocket," not REST. A REST surface bolted on would bifurcate state (IRC message stream vs REST resource tree) and fight the project's DNA; upstream would close the PR with "propose an IRCv3 extension instead."

**Apply:** **read soju for behavior, don't fork it.** The reusable lessons: SASL bridging, scrollback ring-buffer semantics, reconnect/retry policy. The architecture is ours.

---

### 2026-04-20 — IRCv3 is opportunistic, not required

Upstream `CHATHISTORY` is essentially [soju](https://soju.im/) + [Ergo](https://ergo.chat/); not in bahamut-family or ratbox. That's the vast majority of deployed networks.

Consequence: **grappa must fully function against a classic IRC server speaking only `CAP LS` + SASL.** Anything beyond — `server-time`, `message-tags`, `labeled-response`, `CHATHISTORY` — is a bonus used when the upstream supports it.

Scrollback is **bouncer-owned**. One sqlite-backed ring-buffer per user, paginated API for REST, `CHATHISTORY` mapping if/when we add the IRCv3 listener (see below). No dependency on the upstream ircd providing history.

**Apply:** never assume IRCv3 on the upstream. The only universal requirements are `CAP LS` + SASL. Everything else is negotiated.

---

### 2026-04-20 — decision: two facades, one store

Question (raised in #it-opers): can classic IRCv3-capable clients talk to grappa directly, or is the PWA the only consumer?

Landing:

- **One scrollback store.** sqlite or any KV. Shared.
- **Facade A — REST + SSE** — primary. Consumed by cicchetto. Canonical surface. This is the design center.
- **Facade B — IRCv3 listener** (`CAP LS` + SASL + `CHATHISTORY`) — secondary, **phase 2+**. A *view* over the same store for existing IRCv3 mobile clients (Goguma, Quassel mobile). Not a source of truth.
- **No bifurcation rule.** The IRC listener MUST NOT introduce state the REST surface does not also expose. In particular, **no server-side `MARKREAD` / read watermark on either facade** — per the decision below.

**Apply:** when scoping the MVP, the IRCv3 listener is explicitly **out of scope for v1**. The scrollback schema must be designed so that a `CHATHISTORY` mapping is a mechanical translation, not a redesign. Required schema properties: monotonic msgid, `server-time` on every row, per-channel and per-target indexing, no `MARKREAD` column.

---

### 2026-04-20 — decision: no server-side read cursors

vjt: *"se metti il server a tenere non solo lo stato dei client connessi ma anche fin dove hanno letto.. meh"*.

Read position is a UX concern, not a protocol concern. Servers that track per-client read watermarks end up owning a state that belongs to the user's current view. Multiple open tabs, multiple devices, stale reconnects — the edge cases multiply fast and the value delivered is thin.

**Apply:** scrollback pagination stays; `MARKREAD` does not. Same rule on both facades. Clients track their own read position however they like (localStorage, IndexedDB, whatever). If that turns out to be wrong, we can add it later without breaking anything — but the inverse (shipping it then taking it away) is impossible.

---

### 2026-04-20 — decision: the client is the source of truth for UI state

vjt: *"io il server lo terrei puro e semplice / lo stato è lato client / i canali in cui sei è lato client / il server è solo un dispatcher"*.

Sonic: *"lo stato è cmq su grappa"* — fair, and correct: grappa *must* persist session state (which networks a user is attached to, which channels they've joined upstream). The design intent is narrower than Sonic's reading: the **client** is source of truth for **UI state** (which channel view is open, scroll position, read cursor, theme), not for session state. Server persists what must survive reconnect; client decides what to show.

**Apply:** API exposes *session state* (networks, channels, scrollback). API does not expose *UI state* (read cursor, "active channel", unread counts). If the client wants unread counts, it computes them locally from scrollback + its own read cursor.

---

### 2026-04-20 — decision: grappa is not an ircd

> *"grappa NON è un server irc / è un modo per rimanere connessi a irc e accedervi via webapp"*

If you want a classic IRC client, you bypass grappa and go straight to the upstream ircd. grappa is not replacing anyone's connection to Azzurra or Libera. It is a persistent-session + REST layer on top of existing IRC. That framing matters for scope control: we are not shipping features an ircd would ship.

**Apply:** never pitch grappa as an IRC server. It's a bouncer-and-then-some. The framing "always-on session wrapper, consumable from a phone" is correct; "modern IRC server" is wrong.

---

### 2026-04-20 — canonical elevator pitch (vjt's words)

Flagged as *"memorizza queste ultime righe perché sono una bella sintesi efficace di grappa"*. Treat as authoritative phrasing, reusable verbatim:

- *"grappa bnc irc <-> web"* — one-line architecture: bouncer between IRC upstream and web.
- *"cicchetto consuma grappa e mostra UI themabl[e]"* — cicchetto is the client, consumes grappa's API, ships themable UI.
- *"as irssi, mirc, erc, xchat quel che si vuole"* — themability target: parity with classic IRC clients, user picks.
- *"grappa espone anche ircv3 se vuoi usare quassel o simili"* — the phase-2 IRCv3 listener is the downstream facade for mobile IRCv3 clients.
- *"se vuoi usare irssi su grappa praticamente è solo un bnc"* — classic IRC client through grappa = pure bouncer experience.
- *"se invece usi cicchetto o quassel, hai anche la history"* — scrollback is what you gain with cicchetto OR any IRCv3 client. irssi-via-grappa = bouncer-only.
- *"plain and simple / irc solo irc"* — minimalism as a feature. No images, no voice, no *cagate*.

**Apply:** when describing grappa to a newcomer (README, blog, manifesto, issue comment) lead with `grappa bnc irc <-> web` + `cicchetto consuma grappa`, then fan out: themable UI, IRCv3 facade for mobile, history via cicchetto or IRCv3, *plain and simple* as closer.

---

### 2026-04-25 — decision: Elixir/OTP + Phoenix as the server stack

The 2026-04-20 architecture pitch named Elixir/OTP, but it deserved a deliberate pressure-test before locking the stack for Phase 1. Recorded here for the record — what was on the table, what was rejected, and why.

**The four goals that mattered (vjt's framing):**

1. *"I want this to live on."* — multi-decade longevity of the codebase.
2. *"I want clients to have an excellent experience."* — flaky-mobile-network reconnect, multi-tab, snappy UX.
3. *"Always-on bouncer."* — fault isolation per user, no global-restart on any single-user bug.
4. *"Phase 6 IRCv3 listener facade."* — write a second IRC protocol surface (downstream server) on the same scrollback.

**Alternatives considered:**

- **Rust** (`tokio` + `axum` + `sqlx` + sqlite + `irc` crate). Plausible. The `irc` crate (v1.1.0, IRCv3.1+3.2 compliant) saves ~1-2 weeks of upstream client work. Compile-time SQL safety via sqlx. Shorter fluency curve from C-shape systems thinking. Better LLM training corpus → ~15-20% more idiomatic first-pass code generation (named honestly). **Rejected** because the architecture grappa needs is BEAM's textbook example, and re-implementing supervision + per-user fault isolation + multiplexed pub/sub-over-WebSocket in userspace Rust is ~2300 LOC of plumbing that BEAM/Phoenix gives free, plus 6 months of mobile-network polish on the WebSocket client library.
- **Go** (would map to soju's stack). Rejected because picking Go would subconsciously drift back toward soju's IRCv3-first DNA, fighting our REST-first design center. Rust forces a different mindset; Elixir does it better.
- **Zig.** Too early for a production IRC bouncer in 2026. 0.x churn; ecosystem too sparse for HTTP/WS/SQL.

**Why Elixir/OTP wins, decisively for THIS shape of app:**

1. **Architecture matches the runtime, not adjacent to it.** "One persistent process per connected user, supervised, fault-isolated" is the literal Erlang/OTP textbook example — it is the runtime, not code we write. ~600-800 LOC of registry+supervision+restart plumbing in a Rust monolith ≈ zero LOC in Elixir (`DynamicSupervisor` + `Registry` + `:transient` restart policy).
2. **Phoenix Channels >> SSE for client experience.** Multiplexed pub/sub over a single WebSocket, with the `phoenix.js` client library handling reconnect-with-backoff, transparent topic re-subscription, network-change events, and message replay — battle-tested at Discord/Slack scale. **No equivalent library exists in Rust.** Building it = ~1500 LOC server + ~800 LOC client TypeScript + months of mobile-network polish. This is the single biggest material advantage Elixir buys for the user-facing experience.
3. **Phase 6 IRCv3 listener.** Writing an IRC server-side parser + state machine in Elixir is genuinely pleasant — binary pattern matching is what Erlang was designed for at Ericsson (telecom protocols on bytes). In Rust, the same task is ~2-3x lines, plus the supervision/registry work has to be redone for downstream sessions.
4. **Longevity track record.** BEAM is the only mainstream runtime with a 35+ year track record of backwards compatibility for long-lived stateful systems. WhatsApp's 2009 Erlang still runs. Discord's 2015 Elixir runs today. Ericsson runs ERTS code from the late 80s on current gear. Rust async is <5 years old; ecosystem still settling. For "live on for 20 years" the BEAM bet has more historical evidence behind it.
5. **Production observability.** `:observer_cli`, `:recon`, `:sys.get_state(pid)` give per-process runtime introspection that Rust's `tokio-console` doesn't approach.

**Tradeoffs accepted, named honestly:**

- **vjt fluency ramp:** 2-4 weeks of OTP learning. Real cost. Mitigated by deep experience in concurrent C systems (suxserv, bahamut-inet6) — concepts transfer; the syntax is the easy part.
- **Claude's code generation gap:** ~15-20% less idiomatic on first pass in Elixir vs Rust. Mitigated by a **rigid tooling baseline** (Dialyzer + Credo + Sobelow + ExUnit + StreamData + Boundary + doctor + mix_audit, all CI gates) plus an explicit OTP-pattern playbook in `CLAUDE.md`. The point of the rigid tooling is to give Claude maximum signal density to compensate for lower first-pass fluency.
- **`exirc` is stale** (hex 2.0.0 from 2020; some repo activity but no releases since). Mitigated by writing our own IRC client module — ~500-1000 LOC of binary-pattern-match code that's pleasant in Elixir AND reusable for the Phase 6 listener parser. Not punishment; advantage.
- **Larger Docker image** (`mix release` + ERTS bundled ≈ 50MB vs ~15MB Rust static). Doesn't matter — Docker is the deployment target, not single-binary `scp`.

**Apply:** Phase 1 stack is **Elixir 1.19 + Erlang/OTP 28 + Phoenix 1.8 + Ecto 3 + ecto_sqlite3 + own IRC client module**. Streaming facade is **Phoenix Channels** (multiplexed WebSocket), not SSE. Supervision tree skeleton:

```
Grappa.Application
├── Grappa.Repo                     (Ecto + sqlite)
├── Phoenix.PubSub (name: Grappa.PubSub)
├── Registry (name: Grappa.SessionRegistry, keys: :unique)
├── DynamicSupervisor (name: Grappa.SessionSupervisor)
│   └── Grappa.Session (one per (user, network), :transient restart)
└── GrappaWeb.Endpoint              (Phoenix HTTP + WS)
```

**Apply (rigid tooling — every CI gate is mandatory, none advisory):**
- `mix format --check-formatted`
- `mix credo --strict`
- `mix dialyzer` (whole-app PLT, type errors fail the build)
- `mix sobelow --config --exit-on-medium`
- `mix deps.audit` and `mix hex.audit` (CVE check)
- `mix doctor` (doc coverage + `@spec` floor)
- `mix test --warnings-as-errors --cover` (coverage floor — start at 80, ratchet up each major release)
- `mix docs` (build check, no warnings)

These exist explicitly to compensate for Claude's first-pass code quality gap in Elixir vs Rust. Every gate that fires saves a code review round-trip.

---

### 2026-04-25 — sub-decision: hot code reload is NOT load-bearing

Worth recording because the question was explicitly raised and resolved before locking the language decision.

The "BEAM lets you upgrade a running app without dropping users" story is real but not the deciding factor here. We considered:

- **nginx-style fd-passing in Rust** for graceful restart. Verdict: works for the inbound HTTP/WS listen socket, fails for outbound upstream IRC because rustls does not support adopting an in-progress TLS session from serialised state, AND IRC protocol state (nick registered, channels joined, CAP, SASL auth) would need bespoke serde. Research-project territory.
- **Split-process Rust architecture** (`irc-connd` + `grappa-api` over unix socket). Restart `grappa-api` freely; `irc-connd` holds connections. Gets ~70% of hot-reload value but doesn't help when patching IRC handler logic itself.
- **BEAM hot code reload.** Free, but rarely used cleanly in practice for stateful long-lived processes.

**Decision: reconnect-on-deploy is acceptable.** Major releases get a clean restart; users see a brief quit/join flood; sysadmins manage release windows. This means BEAM's hot-reload was *not* the reason for picking Elixir — Elixir wins on the OTHER axes (architectural fit, Channels, Phase 6 ergonomics, longevity), not on hot-reload.

**Apply:** do not over-invest in zero-downtime upgrade infrastructure during Phase 1-5. Phase 5 hardening can revisit if operationally needed. Connection-resume on the IRC side is a Phase 5+ concern, not a baseline requirement.

---

### 2026-04-25 — Phase 2 auth = opaque session IDs + sliding 7d, NOT JWT

Pressure-tested before locking the Phase 2 plan. The alternative considered: JWT (in any flavour — long-lived bearer, short access + long refresh, rolling sliding-JWT). Auth0 marketing notwithstanding, JWT is the wrong tool for grappa's threat model.

**JWT was designed for** stateless cross-service auth in microservices fan-out (50 services, 100k req/s, can't afford a central session-DB lookup per service per request) and federated identity (OIDC: Google issues, your app verifies with Google's public JWKs, no DB shared). It's also right for edge auth (Cloudflare Workers, Lambda@Edge — can't reach origin DB at sub-ms latency) and short-lived access tokens paired with separate revocation primitive (refresh tokens).

**JWT was NOT designed for** monolithic apps with one DB that need any of: real revocation, "active sessions" UI, theft mitigation via session-table inspection, OAuth-extensibility-without-coupling-to-token-format. To get any of those with JWT you need state anyway — `token_version` on users (DB lookup per request, defeats stateless win) OR `jti` blocklist (DB lookup per request, defeats stateless win) OR accept-no-revocation (stolen token = valid until exp = brutal). At which point you've reinvented sessions badly with extra footguns (`alg: none`, HS256/RS256 confusion, key-rotation cascade pain).

**The user wanted:** active-forever / idle-7d-kills-it / true revocation / secure-against-passive-attacker. Five rounds of pushback ("can we just JWT? rolling JWT? skip the DB lookup?") each ended at the same place: sliding + revocation = state required = JWT's win evaporates. Honest answer: opaque UUID session ID, server lookup per REST request (sub-ms PK lookup, invisible at our scale), `last_seen_at` rate-limited UPDATE (60s threshold), idle 7d via `now - last_seen_at > 7d`, `revoked_at` for explicit revocation. Per-WS-Channel: ONE lookup at `connect/3`, then ZERO for socket lifetime (user_id pinned in `socket.assigns`). Per inbound IRC PRIVMSG: ZERO auth lookups (PubSub fans out to already-authenticated subscribers).

**Math for the "DB lookup per request" cost:** ~200 lookups/hour for an active user. Sqlite indexed PK lookup on UUID = sub-ms. ~200ms CPU/hour/active-user. Invisible.

**Future extensibility wins for opaque session IDs over JWT:** the `sessions` table is provider-agnostic. Adding OAuth, WebAuthn, magic-link auth later = each provider has its own `/auth/...` endpoint that mints an identical session row. No coupling between auth flow and token format. JWT couples them.

**Apply:** Phase 2 ships `sessions` table with UUID PK = bearer token. `Authorization: Bearer <session_id>` for REST. Token format intentionally NOT signed Phoenix.Token — opaque random ID is unguessable + revocable, signing adds nothing when verification = DB lookup anyway. If stateless tokens ever genuinely needed (Phase 6 IRCv3 listener federation? Phase 7 multi-region? unlikely), use **PASETO**, not JWT — same stateless property, no `alg` field, no algorithm negotiation, no key-confusion footgun.

---

### 2026-04-25 — Phase 2 crypto layering = server-side encryption-at-rest only; e2e is OTR-in-cicchetto

Decided during Phase 2 design after vjt's strong pushback on env-key-on-disk: "for real e2e security, none of this is the answer. The answer there is OTR. And cicchetto will support OTR." Cryto-layering principle saved as project memory (`project_crypto_layering.md`) so future sessions don't re-litigate.

**The clean separation:**

| Threat | Defense |
|--------|---------|
| Passive sqlite-file theft (lost backup, stolen Pi, accidental commit) | Cloak.Ecto AES-256-GCM, env key (`GRAPPA_ENCRYPTION_KEY`) |
| Active server compromise (root'd, hostile operator, subpoena) | **OTR / OMEMO in cicchetto, ciphertext-on-wire** |
| Network surveillance (wire-tap on upstream IRC) | OTR + TLS |
| Endpoint compromise (your phone is rooted) | Nothing helps. Game over. |

Server-side encryption-at-rest is **only** for the first row. It is not pretending to be e2e and shouldn't try. Cargo-culting more crypto into the server (user-password-derived keys, per-user master-key wrapping, layered ciphers) buys nothing against threats 2-4 — it just costs always-on bouncer behaviour. The user-password-derived-key proposal we considered (decrypt NickServ creds only when user is actively logged in) DOES improve the passive-theft threat model BUT means: process restart = mass logout, deploy = everyone reauthenticates, idle 8d = bouncer disconnects from upstream. That sacrifices the primary product feature ("always-on") for a property that doesn't even defend against active compromise.

**OTR layered on top of grappa (in cicchetto, Phase 4+) is the right answer for threats 2-3:**
- cicchetto initiates OTR session via standard `?OTRv3?` PRIVMSG handshake
- Subsequent messages = OTR-encrypted ciphertext wrapped in PRIVMSG body
- Upstream IRC server sees ciphertext
- Grappa scrollback stores ciphertext (just opaque text to it)
- Other OTR-aware client decrypts (or future cicchetto on another device with shared OTR key store)
- Forward secrecy + deniability for free
- Server compromise = attacker sees ciphertext only

**The grappa design implication:** scrollback `body` column stays as opaque UTF-8 text. Whether the bytes are plaintext "ciao" or `?OTR:AAQDoyBlbBcOZSm...` is the client's business. **Server doesn't differentiate. No new schema. No new endpoint. Zero server-side work for e2e.**

**Apply:** server-side crypto schemes for user message bodies ("encrypted messages at rest", "per-user message keys", etc.) are NEVER proposed for any future phase. That's OTR's job. When a user asks about e2e/privacy, route them to OTR-in-client, not server-side schemes. Phase 5+ may add HSM-keyed Vault (yubico-hsm, TPM, KMS) if operator wants escape from "env on disk" — Cloak.Vault makes that pluggable without code changes in Grappa proper.

---

### 2026-04-25 — Phase 2 schema = irssi-shape (network 1:N servers, per-user credentials)

vjt insight during Phase 2 design: "let's reuse irssi schema here. server belongs to chatnet, chatnet has many servers." Reflects how IRC operators actually think about networks — Libera has irc.libera.chat (round-robin DNS to many endpoints), Azzurra has irc.azzurra.chat + alt.azzurra.chat, plain port 6667 + TLS port 6697 are different server rows.

**Three-table split:**

```
networks                              -- logical "chatnet" (per IRC network)
  id integer pk + slug unique         -- "azzurra", "libera"

network_servers                       -- physical endpoints per network
  network_id FK + host + port + tls + priority + enabled
  unique (network_id, host, port)

network_credentials                   -- per-user binding
  composite pk (user_id, network_id)
  nick + realname + sasl_user + password_encrypted (Cloak)
  + auth_method enum + auth_command_template + autojoin_channels
```

**Why integer + slug for `networks.id` instead of text PK or UUID:**
- Operator-curated allowlist of 5-10 networks; integer is faster joins (8B vs 16B), simpler debug (`network_id=1` vs random UUID), no enumeration concern (network list isn't sensitive)
- text PK ("azzurra") was rejected — feels off, rename = cascade across messages/credentials
- UUID would be fine but adds nothing (networks have stable lifecycles; don't need random-grade unguessability)

**Multi-server failover: schema-ready Phase 2, logic-deferred Phase 5.** `network_servers.priority` (asc = try first) + `enabled` columns ship Phase 2 but Session.Server only uses the first enabled server. Phase 5 hardening adds the round-robin / backoff state machine. Schema ready for it; pure logic addition, no migration.

**Per-user iso on messages (decision G):** added `messages.user_id` UUID FK. New index `(user_id, network_id, channel, server_time DESC)`. Each Session.Server writes its own scrollback rows from its own wire view (per-user model, not shared-de-duped — the de-dup key would be fragile under server-time latency variance, and IRC channels appear public on the wire but each user's session sees their own joins/parts/kicks differently).

**Wire shape on messages (decision G3):** `Message.to_wire/1` does NOT include `user_id` in the payload. Client knows their own from `/me`; including it = redundant + 36 bytes/row for nothing. Server-side query filters by user_id from authn'd context.

**Apply:**
- Any new IRC-network-related table follows the irssi shape: logical network row + many physical endpoints.
- Any new per-user resource composite-keyed on `(user_id, network_id)` (or `(user_id, network_id, channel)` for channel-scoped resources).
- `messages.user_id` is the discriminator for ALL scrollback queries; no fetch path bypasses it.
- Wire payloads NEVER carry `user_id` (client knows their own; server filters server-side).

---

### 2026-04-25 — Phase 2 PubSub topic shape break + per-network upstream `auth_method` state machine

**Topic shape break:** Phase 1 used `grappa:network:{net}/channel:{chan}`. Phase 2 changes to `grappa:user:{user}/network:{net}/channel:{chan}`. Reason: Phoenix.PubSub topics are global string namespaces, not socket-scoped. Without per-user discriminator, multi-user grappa instances would broadcast user A's session events to user B's subscribers — each Session.Server writes its own scrollback rows from its own wire view, but PubSub doesn't know about that.

vjt asked the right question ("why include user_id in topic? can't it be inferred from session?"). Honest answer: only if we built a custom dispatch layer that intercepts every PubSub message and filters per subscriber. Possible, but:
- Loses Phoenix.PubSub's native fanout efficiency (BEAM ETS-backed, fastest path)
- Loses Phoenix.Presence (relies on topic-scoped state)
- Adds custom routing layer = bug surface
- Reinvents wheel

Standard Phoenix-shape solution: topic name encodes the discriminator. Wire surface (REST URL, JSON keys) unchanged — still uses network slug. user_id discriminator is in the topic string only, not in the message payload (client knows their own from `/me`).

**Single source of truth:** `Grappa.PubSub.Topic` builder module. Phase 2 sub-task 2h. NO inline string interpolation of topics anywhere else in the codebase. Any future PubSub topic adds (user-level events, network-level notices) MUST follow the `grappa:user:{user}/...` pattern via `Grappa.PubSub.Topic` builders.

**Authz at Channel join:** `socket.assigns.user_id == topic_user_id else 403`. The two-source-of-truth-for-user (socket.assigns AND topic name) is intentional — socket.assigns = authenticated identity, topic user portion = which stream you want; the authz check ensures you can only subscribe to your own.

---

**Per-network upstream `auth_method` state machine (Phase 2 sub-task 2f):**

`auth_method` enum on `network_credentials`: `auto | sasl | server_pass | nickserv_identify | none`.

| Method | Flow | Networks |
|--------|------|----------|
| `sasl` | CAP LS 302 → REQ :sasl → AUTHENTICATE PLAIN → 903/904/905 → CAP END | ergo, Libera, Snoonet (modern IRCv3) |
| `server_pass` | PASS before NICK/USER, server hands off to NickServ at register_user end | Azzurra (Bahamut), Unreal-with-services (legacy) |
| `nickserv_identify` | NICK/USER → 001 → PRIVMSG NickServ :IDENTIFY pwd | Rare networks where neither PASS nor SASL works |
| `none` | NICK/USER only | IRCnet, open networks |
| `auto` | Default — see below | Most operators (90%+) |

**Auto-detection logic** (`auth_method = 'auto'`):
1. If password present, always send PASS first (will be handled by NickServ at register_user end if Bahamut/Unreal; ignored if SASL-only or Bahamut without services bound)
2. Always send CAP LS 302
3. Always send NICK/USER
4. React to server response:
   - `CAP * LS :sasl=...` → SASL flow (CAP REQ → AUTHENTICATE → CAP END)
   - `421 :Unknown command CAP` → ignore, server already handled PASS via NickServ if configured
   - `001 :Welcome` → autojoin
5. NickServ NOTICEs logged but not parsed Phase 2 (Phase 5 hardens with reply parsing + +r-umode-check fallback)

**Azzurra/Bahamut PASS-handoff verified via source code dive:** `~/code/IRC/bahamut-azzurra/src/s_user.c:1273-1278` has `if (sptr->passwd[0] && (nsptr=find_person(NICKSERV,NULL)))` block at end of `register_user()`. Sending PASS at register triggers server-side `:nick PRIVMSG NickServ@SERVICES_NAME :SIDENTIFY <password>` automatically. Poor-man's SASL — auth happens at register-time via legacy PASS field, server itself does NickServ handoff. No race, no post-001 IDENTIFY dance. Bahamut config.h has zero IRCv3 CAP/SASL framework defines — the `CAPAB` strings in bahamut source are server-to-server protocol negotiation (TS3, NOQUIT, SSJOIN, BURST), NOT IRCv3 client `CAP LS`. Different beast entirely.

**Apply:**
- Operator declares `auth_method` per-network when running `mix grappa.bind_network`.
- `auto` is safe for ~99% of networks (SASL when advertised, PASS-handoff for Bahamut-shape).
- `sasl` forces no-PASS-fallback for paranoid operators worried about leaking password to networks that don't bind PASS to services.
- `nickserv_identify` reserved for the rare network where neither PASS nor SASL works (unusual; explicit override).
- Phase 5 hardening: post-`001` `+r` umode check; if not authed, fall back to `PRIVMSG NickServ :IDENTIFY pwd` retry. Catches PASS-not-bound edge cases and silent failures.

---

### 2026-04-25 — sub-decision: single sqlite file, not per-user `.db`

Pressure-tested before locking the schema for Phase 1 Task 2. The alternative considered: one `runtime/grappa_user_<id>.db` per user, started lazily under a `Grappa.RepoSupervisor` + `Registry` keyed by user_id, queried via Ecto's `put_dynamic_repo` mechanism.

**What per-user buys:** zero cross-user writer contention; per-user delete = `rm` one file; per-user export = file copy; per-user encryption-at-rest possible (sqlcipher); crash-isolation across user DBs; trivial per-user disk quota.

**What per-user costs:**

1. **Plumbing tax forever.** Every public context fn gains a `user_id` first arg + `with_user_repo(user_id, fn -> ... end)` wrapper. Every controller/channel/background job entry point must set `put_dynamic_repo` from the authenticated user. ~200 LOC of repetition + 200 risk points at Phase 5 maturity.
2. **Silent-bug class.** Forgotten `put_dynamic_repo` = wrong user's DB hit (alice's messages land in bob's DB). Mitigatable ("never start a default Repo, crash on missing context") but the mitigation breaks `mix ecto.migrate`, `Phoenix.LiveDashboard`'s Ecto tab, and bare `Repo.insert` in `iex`.
3. **Migration runner custom.** `mix ecto.migrate` is per-Repo; need a runner that iterates all user DBs at boot, with a lock to prevent the user-creation race. Schema drift (one DB at version N, another at N-1) becomes a real boot-time decision.
4. **Cross-user aggregates impossible** without fan-out helpers. Admin reports cost more.
5. **Connection pool tax.** N users × pool_size = N× idle pool processes. Tunable (`pool_size: 2` per user) but real BEAM memory.
6. **Performance argument is fake at this scale.** Write rate = ~83 msg/sec at 10 users × 5 networks × 100 msg/min. Sqlite WAL handles 10k+ writes/sec on a Pi. The "writer contention" per-user fixes is invisible.

**Coherence beats theoretical isolation here.** CLAUDE.md is explicit: *"The codebase IS the instruction set — whatever patterns exist, Claude will propagate."* Half the codebase with `user_id`-first args and half without = drift. Single Repo = one pattern, zero drift surface, standard Ecto idioms hold throughout. Privacy-via-file-separation is theater for a single-operator personal bouncer where the operator can read the file regardless.

**The flip-condition, named:** if grappa ever becomes a multi-tenant adversarial-isolation product (untrusted users sharing the same instance with privacy guarantees), per-user `.db` is correct *upfront* — retrofitting privacy after a shared schema exists is harder than the upfront ergonomics tax. The current spec says single Pi, single operator, trusted few. Not that.

**Also rejected: PostgreSQL/MySQL.** Sqlite handles the load (write rate two orders of magnitude under WAL ceiling). A server DB adds a separate process, ~250MB idle RAM on the Pi, backup complexity (mysqldump/pg_dump vs file copy), my.cnf/postgresql.conf tuning, network hop, compose-ordering deps. Zero benefit at this scale. If scale ever flips (it won't — single Pi, personal bouncer), Postgres is the upgrade target, not MySQL: better SQL semantics, JSONB native, no utf8mb4 trauma, better Ecto integration.

**Apply:** Phase 1 Task 2 ships single `runtime/grappa_dev.db` / `runtime/grappa_prod.db` with one `Grappa.Repo` module, standard `Ecto.Adapters.SQL.Sandbox` per-test isolation, normal `mix ecto.migrate`. No per-user file split. Revisit only if the multi-tenant flip-condition above becomes real.

### 2026-04-26 — Phase 2 close: User.name format is free-text, not enum

`Grappa.Accounts.User.name` is `:string` with `validate_format ~r/^[a-z0-9_-]{1,32}$/i` — a free-text identifier, not an `Ecto.Enum` over a known set.

**Considered:** typing as a closed-set atom enum a la CLAUDE.md's "atoms or `@type t :: literal | literal` — never untyped strings." Rejected because the User namespace is operator-extensible at runtime (`mix grappa.create_user --name X`); the atom-enum rule applies to closed sets the *code* knows about (message kinds, auth methods, network states), not to user-supplied identifiers that come and go via the operator surface.

**Format rule** is the boundary check: ASCII alphanumeric + `_` + `-`, 1-32 chars. Excludes whitespace, control bytes, IRC framing chars (`!`, `@`, `:`, `,`), and locale-dependent normalization (`String.downcase/1` is locale-aware on UTF-8). The 32-char ceiling is below IRC's typical NICKLEN (Azzurra ships NICKLEN=30) so a User.name can always be used AS the upstream nick if the operator wants — though the per-credential `nick` field is the canonical IRC identity, not User.name.

**What this gets us:** clean URLs (`/networks/...?user=vjt`), clean Logger metadata (`user=vjt` not `user=2adc-...-uuid`), clean topic shapes (`grappa:user:vjt`). The UUID PK still exists for FK purposes; User.name is the human-readable surface.

### 2026-04-26 — Phase 2 close: Network.slug is URL- and topic-safe

`Grappa.Networks.Network.slug` is `:string` with `validate_format ~r/^[a-z0-9-]{1,32}$/` — same shape as User.name but lowercase-only and **always slug-safe** (no underscore — RFC 3986 reserved chars + IRCv3 topic delimiters all excluded by construction).

**Why a slug, not a `:name` field:** the slug rides three surfaces and ALL of them require URL/topic safety:

  * **REST**: `/networks/azzurra/channels/#it-opers/messages?before=...` — `azzurra` is the slug, must be path-segment-safe.
  * **PubSub**: `grappa:network:azzurra` — must not collide with PubSub's `:` separator.
  * **Operator CLI**: `mix grappa.bind_network --network azzurra` — argv-safe.

Free-text would force escaping at every layer (controllers re-encoding, channel-topic builders re-encoding, mix tasks defensive-quoting); a slug shaped like `[a-z0-9-]{1,32}` lets the entire stack pass it through verbatim.

**Trade-off accepted:** display name is lost — `azzurra` instead of "Azzurra IRC Network". A future Network.display_name freetext column could ride alongside if the cicchetto UI wants it; the slug stays the load-bearing identifier.

### 2026-04-26 — Phase 2 close: G2 wipe-and-rebuild over migration

Pre-Phase-2 the `messages.user_id` was a free-text `:string` (Phase 1 hardcoded `"vjt"`). Phase 2 made it an `Ecto.UUID` FK to `users.id`. Decision G2 in `docs/plans/2026-04-25-phase2-auth.md` accepted **wipe + recreate the dev/prod DB** rather than write a backfill migration.

**Why wipe:**

1. **Data was throwaway.** Phase 1 was a walking skeleton; the messages in `grappa_dev.db` were vjt's solo testing chatter, not load-bearing scrollback.
2. **Backfill semantically impossible.** Pre-Phase-2 messages had no `user_id` at all (single-user); attributing them to "the operator's UUID" would be a fabricated FK. The operator's account didn't exist at the time the rows were written.
3. **Migration scaffolding cost > value.** Writing a backfill migration that conjures a default User row, then UPDATEs every messages.user_id to that UUID, then ALTERs the column to NOT NULL + adds the FK — 60+ lines of ecto migration for data that's about to be deleted anyway.

**The flip-condition:** if Phase 2 had landed AFTER any production deploy with non-trivial scrollback, the migration would have been mandatory regardless of cost. The wipe is allowed *because* the only consumer was the operator who knew the data was throwaway.

**Apply:** Phase 5 hardening adds a real backfill-migration discipline. From this point forward (post-Phase-2 close), schema changes that touch FK columns get migrations, not wipes.

### 2026-04-26 — Phase 2 close: no `delete_network/1`; cascade-on-empty-unbind only

`Grappa.Networks` deliberately does not expose a `delete_network/1` operation. The only path that drops a network row is `unbind_credential/2` when it removes the LAST binding — and even then, it's gated by a scrollback-presence check.

**Why no top-level delete:**

  * **Networks are shared infra**, not per-user resources. One Azzurra row, many users bind it. A `delete_network` API would invite the question "delete it for whom?" — for one user (just unbind) or for everyone (cascade-orphan their credentials). Both shapes are wrong: per-user is just `unbind_credential`; cascade-orphan is destructive in a way no operator should accidentally trigger.
  * **No legitimate delete-while-bound use case.** Operator wants to retire a network → unbind every user's credential first → last unbind cascades the network row + servers automatically. Any "delete this network and all its credentials" wrapper is a footgun for the same operator who later wants to re-bind one of those users to the same network slug.

**Why cascade-on-empty:** the alternative — leaving "ghost networks" with zero credentials — accumulates operator-managed dead weight that the operator can't even unbind cleanly afterwards. The cascade-on-empty path keeps the schema honest: `networks` rows exist iff at least one user is bound.

**Why scrollback-gate:** if the last user has scrollback rows on the network, `unbind_credential/2` returns `{:error, :scrollback_present}` and the transaction rolls back — credential AND network stay. The archive isn't silently orphaned; the operator must explicitly delete via `mix grappa.delete_scrollback --network <slug>` (Phase 5) and then re-run unbind. S29 C2 fix changed `messages.network_id` FK from `:delete_all` to `:restrict` to enforce this at the DB layer.

### 2026-04-26 — Phase 2 close: IRCv3 CAP ACK gate + Bahamut PASS-handoff verification

`Grappa.IRC.Client`'s registration handshake gates SASL behind a CAP LS / CAP REQ / CAP ACK round-trip. If the upstream IRCd doesn't ACK `sasl`, the client falls through to the `:server_pass` path (PASS handoff) when `auth_method: :auto` is configured, OR raises `:sasl_unavailable` when `auth_method: :sasl` was explicitly chosen.

**Why the CAP gate:** IRCv3.2 says "if you sent CAP REQ for sasl and the server doesn't ACK it, sasl is not supported." Sending `AUTHENTICATE PLAIN` after a non-ACK is undefined behavior — some servers ignore it (silent breakage), some respond with 421 (Unknown command), some respond with 904 (SASL failed). The CAP ACK gate makes the unsupported branch deterministic.

**The Bahamut detail:** Azzurra runs Bahamut 1.4(34) (perimeter-azzurra-4.7b). Bahamut's `s_user.c:1273-1278` is the canonical reference for how legacy ircd routes the PASS-as-handoff flow:

```c
/* If a PASS was given, we hand it off to NickServ via a different
 * code path than the SASL machinery — the user-server registration
 * doesn't validate it; NickServ does, asynchronously. */
```

Bahamut accepts `PASS <pw>` BEFORE NICK + USER, stashes it, and post-001 routes it to NickServ via the services protocol. Modern Anope/Atheme do the same. The bouncer's `:server_pass` auth_method emits `PASS` first thing on the socket, then NICK + USER, then waits for 001 — same flow Bahamut expects.

**`:auto` auth_method semantics:**

1. Send CAP LS 302 (post-IRCv3.2 form so the server knows we speak modern caps).
2. If server responds with `CAP * LS :sasl ...` → REQ sasl, AUTHENTICATE PLAIN, on 903 success → CAP END → NICK + USER.
3. If server doesn't list sasl → CAP END immediately → fall through to PASS handoff (emit PASS before NICK + USER, expect post-001 NickServ chatter).

**`:sasl_unavailable` rationale:** if operator explicitly chose `:sasl` (not `:auto`), failing through to PASS handoff would silently change the auth boundary — the operator picked SASL specifically because it's pre-001 (no IRC traffic before auth) vs. PASS-as-NickServ which is post-001 (a brief moment where the bouncer is on the network as the unidentified nick before NickServ accepts the password). Making the fallback explicit forces the operator to update the credential or accept the weaker boundary.

### 2026-04-26 — Phase 2 close: NoServerError as exception, not `{:error, :no_server}`

`Grappa.Networks.NoServerError` (post-A2/A10 — was `Grappa.Session.Server.NoServerError` before the cycle inversion) is raised, not returned, when `Grappa.Networks.Servers.list_servers/1` (post-D1/A2 — was `Networks.list_servers/1`) returns `[]` for a bound credential's network at session-init time.

**Why exception not tuple:** Session.Server is started under DynamicSupervisor with `restart: :transient`. An `{:error, _}` return from `init/1` propagates up to the supervisor as a normal failure; with `:transient`, the supervisor would retry the spawn — but the underlying state (zero servers for this network) doesn't change between retries, so the loop would burn CPU forever until something else inserts a Server row.

A raise from `init/1` propagates the same way to the supervisor (`:transient` treats abnormal exits as a reason to retry); the difference is **the operator log**. A `{:error, :no_server}` tuple turns into a one-liner "child failed: :no_server"; a `NoServerError` exception turns into a stack trace pointing at the exact line in `Server.init/1` plus the network slug. For an operator-action failure mode (forgot to `mix grappa.add_server`), the stack trace is the better signal.

**Phase 5 mitigation:** the cleaner answer is for Networks to refuse to expose `bind_credential/3` until at least one Server is bound to the network — invariant at the API surface, not at the runtime. Queued for Phase 5 hardening when the rest of the operator-error class gets the same treatment.

### 2026-04-26 — Phase 3 cicchetto stack: SolidJS + TypeScript + Vite + Bun + Biome

Phase 3 walking skeleton needed a frontend stack. Phase 0 roadmap left the choice open (Svelte vs SolidJS vs plain lit-html); pressure-tested before committing the cicchetto subtree. The choice is load-bearing — re-platforming a PWA after Phase 4 starts cementing themes + keybindings would cost weeks.

**Chosen:** **SolidJS 1.9** + **TypeScript 6** + **Vite 8** + **Bun 1.3** + **Biome 2.4**, plus **`phoenix.js` 1.8** for the Channels client (framework-agnostic, ~3 KB).

**Why SolidJS, decisively for THIS shape of UI:**

1. **Fine-grained reactivity matches the workload.** grappa's primary client behavior is high-frequency WebSocket push: every IRC `PRIVMSG`, join, part, mode, topic change arrives as a separate Channel event. On a busy channel (`#it-opers` peak: hundreds of events/sec sustained), a virtual-DOM diff per event would thrash. Solid's signals re-render only the changed DOM node — no diff, no reconciliation. The irssi-shape UI with thousands of scrollback rows visible is exactly the workload Solid was designed for.
2. **TypeScript mirrors the bouncer's typed JSON contracts.** `Grappa.IRC.Parser` is the single source of truth for IRC framing on the server (CLAUDE.md invariant); the parsed events become typed JSON on the wire. TypeScript on the client extends that single source of truth across the boundary — no untyped JS divergence between server-side `%Grappa.Scrollback.Message{}` and client-side message shape. One contract, two languages, same field names, compile-time-checked.
3. **Vite is the canonical SolidJS bundler.** `vite-plugin-solid` is first-party (maintained by the SolidJS core team). HMR, dev server, build all work out of the box; no webpack/rollup plumbing.
4. **Bun replaces npm + node entirely.** Single static binary, no Node version juggling, ~10x faster `install` than npm, faster test runner than vitest-on-node. `oven/bun:1` Docker image gives reproducible CI matching `scripts/bun.sh` oneshot pattern (host bind-mount `runtime/bun-cache`, tmpfs `/tmp`, `--user 1000:1000`) — same wrapper discipline the Elixir side already enforces via `scripts/mix.sh`.
5. **Biome replaces ESLint + Prettier.** One tool, Rust-fast (lint + format in one pass over the same AST), single config file `biome.json`. Mirrors the `mix format` + `mix credo` single-source-of-truth principle on the server side. ESLint's plugin sprawl + Prettier's separate config + their interop friction were exactly the kind of accidental complexity CLAUDE.md's "Lightweight over heavyweight" rule rejects.

**Alternatives considered, rejected with reasons:**

- **React.** Virtual-DOM cost is wrong for the workload. A 500-row scrollback with 50 events/sec arriving = 25k diff operations/sec for changes that touch a single DOM node. Solid drops that to 50 targeted updates/sec. Ecosystem advantage (more libs, more LLM training corpus) doesn't outweigh the runtime cost on the device that matters most (an iPhone in a pocket on cellular).
- **Svelte.** Mature framework, similar fine-grained reactivity story. Rejected because Svelte's WebSocket ecosystem is thinner than Solid's; `phoenix.js` integrates more cleanly with Solid's signals than with Svelte's stores (Solid signals ARE Phoenix Channels' natural sink — assign incoming event into a signal, the affected row re-renders; Svelte stores require a wrapper layer).
- **Plain lit-html.** Considered for "no framework" minimalism. Rejected because the irssi-shape UI needs enough state machinery (channel switcher, scroll position per channel, unread counts, theme application) that we'd end up reinventing 80% of Solid in vanilla. Solid is already the minimalist choice; lit-html is *too* minimalist for this scope.
- **htmx + server-side rendering.** Tempting for "no JS framework" purity. Rejected because grappa is a PWA — installable, offline-capable, uses a service worker for asset caching + iOS home-screen install. Server-rendered htmx loses the offline story (every interaction is a server roundtrip), loses the PWA install path (Add to Home Screen wants a real `manifest.json` + service worker), and loses the WebSocket-push model that makes the irssi UX feel live.
- **lit-html + Web Components.** Same "too minimalist for this scope" verdict as plain lit-html, plus Web Components' shadow-DOM CSS isolation actively fights the irssi-shape goal of one global theme applied uniformly across every component.

**Tradeoffs accepted, named honestly:**

- **Smaller LLM training corpus than React.** Claude generates ~10-20% less idiomatic SolidJS than React on first pass (named honestly, same gap acknowledged for Elixir vs Rust on the server side). Mitigated by the same playbook: rigid CI gates (Biome lint + Biome format + tsc strict + vitest) + concise SolidJS pattern notes in this codebase as they accumulate.
- **Bun is younger than Node.** v1.0 shipped September 2023; some npm packages still rely on Node-specific APIs. Mitigated by sticking to Bun-first or framework-agnostic packages (Solid, phoenix.js, Vite all work natively in Bun); flagged as a Phase 5 hardening item if a needed dep ever forces Node-only.
- **Biome's plugin ecosystem is thinner than ESLint's.** Rejected as a real problem because the rule set Biome ships covers ~95% of what ESLint+typescript-eslint cover, and the missing 5% (plugin-specific rules for, say, React Hooks) doesn't apply to a SolidJS codebase. The simpler tool wins here.

**Apply:**

- The cicchetto subtree (`cicchetto/` in this monorepo, NOT a separate repo — see CP09 correction 2026-04-26) ships SolidJS 1.9 + TypeScript 6 + Vite 8 + Bun 1.3 + Biome 2.4 + `phoenix.js` 1.8.
- Build wrapper: `scripts/bun.sh` oneshot oven/bun:1 image, mirrors `scripts/mix.sh` discipline. NEVER raw `bun` on the host. NEVER raw `npm`/`node`.
- CI gates for cicchetto: Biome (lint + format) + tsc strict + vitest. Same "every gate is mandatory, none advisory" rule as the server side.
- Future client work that's tempted to "modernize" (swap Solid for Next.js, add Tailwind, migrate to pnpm, etc.) MUST re-litigate against this entry's tradeoffs. The rejected alternatives are rejected for reasons that don't expire.
- Production build pipeline: `cicchetto-build` oneshot service in `compose.prod.yaml` runs `bun run build` to produce `dist/` into the named volume `cicchetto_dist`; nginx serves it with SPA `try_files` + reverse-proxies `/auth /me /networks /healthz /socket` to `grappa:4000`. The bouncer container does NOT bundle the frontend.

---

### 2026-04-26 — Phase 2 close: `password_encrypted` redact:true is post-load symmetry

`Grappa.Networks.Credential.password_encrypted` is a `Grappa.EncryptedBinary` (Cloak Ecto type) with `redact: true`. The virtual `:password` field also has `redact: true`. Both flags are load-bearing; dropping either one leaks plaintext in different ways.

**The asymmetry that bit us during the 2f review:** Cloak's `:load` callback decrypts on Repo.one!/get!/all. After load, `password_encrypted` IN MEMORY carries the cleartext upstream password, NOT the AES-GCM ciphertext. The virtual `:password` field after load is `nil` (it's input-only — only set when the changeset is being built). So:

  * **Before load** (changeset shape): `:password` is the plaintext, `:password_encrypted` is nil. `redact: true` on `:password` matters.
  * **After load** (DB → struct): `:password` is nil, `:password_encrypted` is the plaintext (decrypted by Cloak). `redact: true` on `:password_encrypted` matters.

If only the virtual `:password` had `redact: true`, `IO.inspect(credential)` after a fetch would print the cleartext via `:password_encrypted`. The original Phase 2f code missed this — code review caught it as I3 (line 67-74 of `lib/grappa/networks/credential.ex` carries the comment).

**Apply:** any future Cloak-encrypted column where the load-decrypted value is sensitive must carry `redact: true` on the encrypted column itself, not just the virtual input field. The redaction is symmetric with the field's lifecycle, not with its name.

---

### 2026-04-26 — Phase 3 wrap: WS `check_origin` is the defense-in-depth on bearer-in-querystring

The Phoenix Channels WS connect carries the bearer token as a query-string parameter (`?token=…`) — that's the auth. But on its own, that's not enough: a malicious site the user visits while logged in could open a WebSocket to `grappa.bad.ass/socket/websocket?token=…` if it could read the token. It can't read the token (token sits in localStorage, isolated per-origin), but the second-line-of-defense is `check_origin`: Phoenix validates the WS handshake's `Origin` header against an allowlist before bearer auth even runs.

Phoenix's default behavior when `check_origin` is unset is "match the endpoint URL host." The Phase 3 walking skeleton shipped without overriding either, so prod defaulted to `Origin == localhost` — and **every real WebSocket connect from `http://grappa.bad.ass` was rejected** until the fix landed (`config/runtime.exs` prod block now reads `PHX_HOST` and sets both `url:` and `check_origin:`).

**Two layers, both load-bearing:**

1. **Bearer in WS query string** is the authn. `Plugs.Authn`-equivalent runs in `UserSocket.connect/3` and rejects unknown/expired/revoked tokens. Without this layer, anyone who can frame a WS connect gets in.
2. **`check_origin`** is the authz-on-handshake. It rejects connects from origins that aren't this app, before the bearer is even read. Without this layer, a logged-in user visiting `evil.example.com` could be made to connect on their own behalf — the bearer is in their localStorage, not the malicious page's, but a more sophisticated attack (XSS chain that exfils the bearer first) would still be helped by this gap. Defense-in-depth.

**Apply:**

- Any future deployment under a new hostname MUST set `PHX_HOST` in `.env`. The `runtime.exs` default (`grappa.bad.ass`) is a convenience for the canonical deployment; non-default hosts get rejected if the operator forgets to override.
- Phase 5 TLS migration must update the `check_origin` allowlist to include the https variant (the `//host` scheme-relative form already covers both http+https — keep the form).
- New WS subprotocols, alternate channel transports, etc. all inherit this `check_origin`; if a future feature needs a different host (e.g. a public-status endpoint that shouldn't require login), it lands as a separate Phoenix.Endpoint, not as a relaxation here.
- `filter_parameters` includes `token` so the bearer doesn't surface in Phoenix's `[info] CONNECTED TO ...` log line. nginx's `access_log` is suppressed for `/socket` for the same reason. Both are mandatory; either alone leaves the bearer in a different log file.

---

## 2026-04-27 — vite-plugin-pwa swap-in (CP10 S2)

CP10 codebase review caught two coupled cache-busting bugs in the
Phase-3 home-rolled service worker (`cicchetto/public/sw.js`): a
static `CACHE = "cicchetto-shell-v1"` name that never bumped, and a
shell precache list that referenced hashed `/assets/*` it didn't
actually pre-cache. After ANY deploy bumping Vite asset hashes, the
operator's installed PWA stayed pinned to the first-install shell
forever. Fixed by replacing the home-rolled SW with vite-plugin-pwa
in `generateSW` mode — Workbox embeds the precache manifest into the
SW bytes at build time, so any asset-hash bump bumps the SW byte
content, the browser detects an updated SW, and activate evicts the
prior precache automatically. (CP10 review HIGH S2/S3.)

**Apply:**

- Manifest now lives in `cicchetto/vite.config.ts` under the
  `VitePWA({ manifest: ... })` block — single source of truth, no
  more `cicchetto/public/manifest.json` to keep in sync. Plugin
  generates `dist/manifest.webmanifest` and auto-injects the
  `<link rel="manifest">` tag into `dist/index.html`.
- `registerType: "autoUpdate"` — shell-only cache, stale assets are
  never useful, so no opt-in prompt.
- `injectRegister: false` — explicit registration via
  `virtual:pwa-register` in `cicchetto/src/main.tsx` (deterministic;
  `'auto'` would resolve to `false` here anyway because main.tsx
  imports the virtual module, but pinning is clearer than relying
  on plugin-internal heuristics).
- `navigateFallbackDenylist` for `/auth`, `/me`, `/networks`,
  `/socket` covers SPA-routing edge cases (e.g. a navigation-mode
  request to `/auth/oauth-redirect`); REST `fetch` calls and WS
  upgrades are non-navigation and bypass `NavigationRoute`
  architecturally — the denylist is NOT what protects the REST + WS
  surface from interception. Add new prefixes here in lockstep with
  `router.ex` if they appear.
- New devDeps: `vite-plugin-pwa@1.2.0` + `workbox-window@7.4.0`.
  Peer warning on `vite@8.0.10` (plugin pins `^7`); zero observed
  runtime impact, build + virtual-module integration work as
  designed. Re-evaluate when vite-plugin-pwa ships a release with a
  `^8` peer.
- **Legacy cache leak (one-shot per device):** the CP09 home-rolled
  cache name `cicchetto-shell-v1` won't be evicted by Workbox's
  `cleanupOutdatedCaches` (it only deletes caches whose names
  contain the substring `-precache-`). Operators who installed the
  PWA pre-CP10 will carry a few-KB stale cache forever — harmless
  (the new SW doesn't read it) but visible in DevTools >
  Application > Cache Storage. Intentionally NOT cleaned because
  the cleanup mechanism (an `injectManifest`-mode custom SW) costs
  more than the leak; phase-4-onward installs are unaffected.

---

## 2026-04-27 — `init/1` defers connect via `handle_continue` (CP10 S3, C2)

CP10 codebase review caught two coupled OTP-discipline bugs in the
upstream-IRC stack: Grappa.IRC.Client.init/1 did blocking
`:gen_tcp.connect/3` + `:ssl.connect/3` + `PASS/CAP/NICK/USER`
handshake synchronously inside the GenServer init callback, and
Grappa.Session.Server.init/1 synchronously called
`Client.start_link/1` from its own init. Both are textbook CLAUDE.md
"blocking work in `init/1` without `{:continue, _}`" — a flapping or
black-holed upstream froze `Bootstrap`'s sequential `Enum.reduce` over
credentials and serialized every other (user, network) `start_child`
cascade through the singleton `SessionSupervisor`. The
`:gen_tcp.connect/3` call additionally defaulted to `:infinity` on
the connect timeout — a SYN-dropped router could deadlock the whole
boot path forever. (CP10 review HIGH S1 + S12.)

Fix: both `init/1` callbacks return `{:ok, state, {:continue, _}}`
and move connect + handshake (Client) / `Client.start_link` (Session)
into `handle_continue/2`. Connect timeout pinned to 30_000 ms
explicitly on both `:gen_tcp.connect/4` and `:ssl.connect/4`.

**Apply:**

- **`{:continue, term}` carries the connect inputs** (Client:
  `{:connect, opts}`, Session: `{:start_client, client_opts}`) instead
  of stashing on the runtime struct. The struct stays sealed — no
  leaking config fields onto state — and Phase 5 reconnect/backoff
  will need a *different* shape (`{:reconnect, attempt_n,
  backoff_ms}`) anyway, so foreshadowing now would be premature.
- **The bounded `socket: nil` / `client: nil` window is OTP-safe.**
  Per OTP `gen_server` contract, `handle_continue/2` runs before any
  mailbox dispatch (`handle_call`/`handle_info`/`handle_cast`) — no
  external observer can see the pre-continue nil state.
  `:sys.get_state/1` is itself queued behind the continue.
- **TLS posture warning fires in `init/1`, NOT `handle_continue/2`.**
  The existing TLS-warning test uses `Process.flag(:trap_exit, true);
  spawn(fn -> Client.start_link(...) end)` and asserts the warning
  emits regardless of upstream reachability. If the warning fired in
  `handle_continue`, the spawn-fn-dies-fast → linked-Client-receives-
  EXIT cascade would terminate the Client process before the continue
  runs. Phase 5 hardening (CP10 finding S24) will move this to
  `Bootstrap` so it fires once at app boot rather than per-connect;
  for now the placement is load-bearing.
- **Bootstrap semantic SHIFTED.** Pre-fix, an upstream connect refusal
  caused `Session.start_session/3` to return `{:error,
  {:client_start_failed, _}}` synchronously, and Bootstrap counted it
  under `failed`. Post-fix, the failure is async — Bootstrap reports
  `started=N failed=0` for any row that passed `Client.init/1`'s
  validation; the per-Session `:transient` policy retries up to
  `max_restarts: 3` and the `DynamicSupervisor` then terminates the
  child permanently. Operators grep `(stop) {:connect_failed, _}`
  from the Session crash trace under the new semantic. Phase 5
  reconnect/backoff replaces the exhaust-and-give-up shape with
  proper session-health tracking + a per-Session telemetry surface.
- **Pre-existing `Session.stop_session/2` race closed.**
  `DynamicSupervisor.terminate_child/2` returns when the child is
  dead, but `Grappa.SessionRegistry`'s OWN process-monitor on the
  dying pid runs in the Registry process and may not have processed
  its `{:DOWN, ...}` yet. `stop_session/2` now monitors the pid
  itself, awaits the DOWN (with a 5s budget that `Logger.error`s on
  timeout — silent timeout would leave the next `start_session/3`
  racing a zombie `:already_started`), then polls `Registry.lookup`
  until the entry is gone. Race surfaced reliably while iterating on
  the C2 test.
- **Test-side discipline.** The Session-level non-blocking-init test
  uses `Server.start_link/1` directly (linked to the test pid), NOT
  `Session.start_session/3` via `DynamicSupervisor`. The latter would
  trigger the connect-refused crash → `:transient` restart cycle,
  which exhausts `SessionSupervisor`'s `max_restarts: 3` budget in
  <100ms and crashes the supervisor — torching every other Session
  in the test run. Pinning the GenServer init contract directly is
  the right surface; the supervisor path is the wrong unit-of-test.

---

## 2026-04-27 — `MessageKind` mirrors server enum, exhaustive switch enforces drift (CP10 S4, C3)

Closes CP10 codebase-review HIGH cicchetto/S4 + MEDIUM cicchetto/S15 as
a single cluster. The TS `MessageKind` union pre-fix carried only three
of the server's ten `Grappa.Scrollback.Message.kind()` atoms
(`privmsg | notice | action`); the renderer's `<Show>` fallback rendered
every other kind with PRIVMSG `<sender>` framing. Phase 5 presence-event
capture (`:join`, `:part`, `:nick_change`, ...) would have shipped JOIN
events as PRIVMSGs silently, with no compile-time signal.

The cluster fixes both halves of the contract:

- **Type contract.** `MessageKind` is widened to all ten kinds verbatim
  — same atom forms the server emits, mirrored as snake_case strings
  (Jason's `Atom.to_string/1` on `:nick_change` lands as
  `"nick_change"`, never camel/kebab). The wire is the contract; the
  client mirrors it without transform.
- **Render contract.** `ScrollbackLine` delegates to a `renderBody/1`
  switch that exhausts the union, with a `default` arm
  `const _exhaustive: never = msg.kind` that turns any future addition
  to `MessageKind` into a compile error here. No `as` cast, no runtime
  fallback — the type system is the gate.

### Five load-bearing apply rules

1. **Wire-shape source-of-truth is the server.** The TS union mirrors
   `Grappa.Scrollback.Message.@kinds` verbatim. When extending the
   server enum, extend the TS union in the same commit; the
   `assertNever` arm will surface any drift. Conversely, *never* add a
   client-only kind — there's no producer for it, and it would render
   the server's exhaustiveness invariant unenforceable.
2. **Atom forms are the wire forms.** Jason serializes atoms via
   `Atom.to_string/1` — `:nick_change` → `"nick_change"`. No kebab,
   no camel, no transform. The Wire moduledoc + the TS union docstring
   both pin this so a future contributor doesn't introduce
   `to_camel_case` "to match TS conventions" and shatter the contract.
3. **Framing follows irssi convention.** PRIVMSG `<nick> body`,
   NOTICE `-nick- body`, ACTION + presence/op kinds
   `* nick <verb> [target]`. Presence kinds carry their event-specific
   fields in `meta` (mirror of `Grappa.Scrollback.Meta`'s allowlist:
   `target`, `new_nick`, `modes`, `args`, `reason`); each access
   narrows defensively against the wire-side `Record<string, unknown>`
   (`typeof === "string"` / `Array.isArray`) so a malformed broadcast
   degrades to `?` rather than crashing the renderer.
4. **`reasonOf/1` defends against future server-side reshape.** The
   per-kind shape table in `Scrollback.Meta`'s moduledoc places
   `:reason` for `:quit` / `:kick` "in body, not meta," but the
   allowlist still includes `:reason` (review S29 dead key). The
   renderer reads `body` first, falls back to `meta.reason` — so if
   the server ever shifts reason into the meta payload (S29 fix path),
   the client doesn't silently drop it.
5. **TDD pin first, exhaust the type AND the runtime.** The failing
   test was `kind: "join"` rejected at compile time (TS2322 against
   the narrow union); the runtime assertions then pinned that
   presence/op rows NEVER render `<sender>` PRIVMSG framing. This
   shape — type-system gate AND runtime contract — is the canonical
   pattern for any client-side mirror of a server-side closed-set
   atom enum. Future kind extensions must update both layers in
   lockstep.

### Phase 4 / Phase 5 follow-ups

The renderer currently includes the channel name on `:join` / `:part` /
`:kick` lines (e.g. `* carol has joined #grappa`). Phase 4's
irssi-shape buffer redesign will drop the channel suffix when the line
is unambiguous from buffer context — irssi convention is `* carol has
joined` inside a single-channel pane. Documented as an inline TODO so
the next iteration doesn't have to rediscover it.

---

## 2026-04-27 — `Application.{put,get}_env/2`: boot-time vs runtime (CP10 S5, C4)

Hygiene cluster (post-CP10 review) closed three Application-env-related
items and surfaced one unifying principle worth pinning. The original
CLAUDE.md rule was a single-line "no `Application.get_env/2` outside
`config/`" that didn't address `put_env`, didn't say *when* (boot vs
runtime), and didn't enumerate which paths inherit the documented
exception.

### The principle

`Application.{put,get}_env/2` is a **boot-time configuration
mechanism**, not a runtime IPC channel. Two timeframes, two postures:

- **Boot-time (allowed):** `config/*.exs`, `lib/grappa/application.ex`
  start/2, and inside mix-task helpers BEFORE
  `Application.ensure_all_started/1`. These sites configure the
  application BEFORE the supervision tree comes up. The mix-task put_env
  in `Mix.Tasks.Grappa.Boot.start_app_silent/0`
  (`Application.put_env(:grappa, :start_bootstrap, false)` then
  `ensure_all_started/1`) is the canonical instance — mirror-symmetric
  with `config/test.exs`'s `:start_bootstrap, false`. The discriminator
  is the `ensure_all_started/1` boundary, not the helper name; a future
  operator-task helper that needs the same suppression follows the
  same shape.
- **Runtime (banned):** GenServer callbacks, controllers, context
  functions, release tasks, plug bodies. None of these may read or
  write `Application.env`. Inject config via `start_link/1` opts; the
  supervisor reads env at boot and threads values into children.

### What changed

- **C4 fix S8 (`lib/grappa/release.ex`):** dropped
  `Application.fetch_env!(@app, :ecto_repos)` in favor of a hardcoded
  `@repos = [Grappa.Repo]`. Per `Grappa.Repo`'s moduledoc the bouncer
  runs a single shared Repo; the iteration over `:ecto_repos` was dead
  generality dating to the Phoenix template, and Release tasks are
  RUNTIME (post-`load_app/0`), so the get_env was a clean violation.
  Hardcoding the list also makes the dep edge grep-visible — a future
  Repo addition is one explicit line, not "set mix.exs `:ecto_repos`
  and pray".
- **C4 disposition S54 (`lib/mix/tasks/grappa/boot.ex`):** kept the
  `Application.put_env(:grappa, :start_bootstrap, false)` call, but
  refined the CLAUDE.md rule to make it explicit that pre-`ensure_all_started/1`
  put_env in mix tasks is allowed. The two CP10-review-proposed
  alternatives both lost: option (a) "exempt this site" reduces to a
  growing exemption list, which is the discipline failure mode CLAUDE.md
  warns against; option (b) "refactor Grappa.Application.start/2 to
  accept `:bootstrap?` injected at start-time" requires either replacing
  `mix.exs`'s `mod` args (compile-time, not boot-time injection — same
  shape under a different name) OR hand-rolling a child list in the
  mix task that mirrors `Application.start/2`'s subset, which violates
  design-discipline (1) "don't duplicate state — derive it" and is
  heavier than the 5 lines it would replace.
- **CLAUDE.md rule rewrite:** the OTP-patterns line now reads
  "**`Application.{put,get}_env/2`: boot-time only, runtime banned**"
  with the four allowed sites enumerated explicitly + the runtime
  prohibition spelled out. Future plans/reviews lean on this line
  instead of debating each site case-by-case.

### Why the distinction matters

The CLAUDE.md ban is about **config-as-IPC at runtime** — one module
mutates `Application.env`, another module reads it later, and the two
sites are coupled through a global key with no explicit dep edge. That
shape hides drift, defeats type contracts, and makes tests fragile to
ordering. Pre-`ensure_all_started/1` put_env in mix tasks doesn't have
that shape: there's no concurrent reader, no later-running module
expecting a specific value, and the put + the start are within five
lines of each other. The TIMING is the discriminator, not the call.

The principle is now load-bearing for any future site that wants to
reach for `Application.env` — the question is "boot-time or runtime?"
not "is there an exemption for this module?"

---

## 2026-04-27 — Sub-contexts split by VERB, not by NOUN (CP10 S12, D1/A2)

### The principle

When a context module grows past three or four distinct
responsibilities, split it into sub-modules **keyed by the verb**, not
by the shared noun. The shared noun stays — it's the schema, the
domain entity, the identifier — but the verbs (CRUD, lifecycle,
resolve, render) each get their own module. All sub-modules sit under
one `Boundary` umbrella so the dep graph stays explicit at the
context level; internal cohesion is regained at the file level.

This is the concrete shape of CLAUDE.md's "Reuse the verbs, not the
nouns. When a second use case fits 80% of existing infrastructure,
ask 'what are the 20% that don't fit?' Those 20% are the domain
boundary." Pre-A2 the Networks context had absorbed four verb-shapes
(network slug CRUD + server endpoint CRUD + credential lifecycle +
session-plan resolution) because they all touched the `Network`
schema. Sharing the noun made the absorption feel natural; the cost
landed at maintenance time when a Phase 5 surface needed to extend
just one verb but touched a 500-line module owning the other three.

### What changed

**Before** (god-context, the 2026-04-27 architecture review's A2
finding):

    Grappa.Networks (501 lines, 17 public functions, 7 deps)
      ├─ network slug CRUD
      ├─ server endpoint CRUD + selection policy
      ├─ credential lifecycle (bind/update/get/unbind + Cloak)
      └─ session-plan resolver

**After** (verb-keyed sub-modules under one Boundary):

    Grappa.Networks (slim core: slug CRUD)
      ├─ Grappa.Networks.Servers      (server endpoint verbs)
      ├─ Grappa.Networks.Credentials  (credential lifecycle verbs)
      ├─ Grappa.Networks.SessionPlan  (resolver — single verb: resolve/1)
      └─ Grappa.Networks.{Network,Server,Credential,Wire,NoServerError}
                                      (schemas + serializer — unchanged)

The umbrella `Grappa.Networks` keeps `top_level?: true` Boundary with
the same deps list (Accounts, EncryptedBinary, IRC, Repo, Scrollback,
Session, Vault). Sub-modules inherit the parent boundary; no new
boundaries declared. `exports:` extended to surface the four verb-modules
to external consumers. Dialyzer + Boundary + Credo + Sobelow all stay
green; test count unchanged at 442 (the move was mechanical, no
behaviour change).

### Why the noun-keyed alternative was wrong

A noun-keyed split would have moved fields off `Network` /
`Credential` / `Server` into smaller schemas. That trades one kind of
duplication for another — the FK web stays the same, but query bodies
fragment across schemas. The verbs (CRUD, resolve) still pile up
somewhere — usually back on the umbrella context, defeating the
split.

A verb-keyed split keeps the schemas as-is (one `Network` row, one
`Credential` row, one `Server` row — the FK shape is stable). Only the
**verb modules** divide. Each module is the single point of edit for
its responsibility set; Phase 5's multi-server failover lands in
`Servers`, not the umbrella. Phase 5's credential REST surface lands
in `Credentials`, not the umbrella. The next decade of feature growth
hits cohesive modules instead of bloating one further.

### Why this principle is load-bearing

Three god-modules surfaced in the 2026-04-27 architecture review:
`Grappa.Networks` (this entry — A2), `Grappa.IRC.Client` (A3, FSM
extraction pending), `cicchetto/src/lib/networks.ts` (A4, client-side
split pending). Each absorbed multiple verbs around a shared noun —
the IRC GenServer state, the network-and-channel store. The
**verb-keyed sub-module** pattern documented here applies to all
three; A3 + A4 will repeat it.

The principle also forward-defends Phase 5/6: every new "where does
this go?" question routes to "which verb is this?" rather than
"what noun does it touch?" Pattern propagation rule means whichever
context absorbs the next presence-event capture / multi-server
failover / WebRTC voice surface becomes the template — keeping the
verb-keyed shape clean now means future sub-contexts won't accidentally
rebuild a god-context by sharing a noun with three already-cohesive
sub-modules.

---

## 2026-04-27 — Pure-FSM extraction prep (CP10 S13, D2/A3 — corollary to D1/A2)

D2 applied the verb-keyed sub-context principle to a state-machine-shaped
verb (the upstream IRC registration handshake, ~250 lines inside
`Grappa.IRC.Client`). The verbs extracted into `Grappa.IRC.AuthFSM` as
a pure module: no process, no Logger, no socket. `step(state, %Message{})`
returns `{:cont, state, [iodata]} | {:stop, reason, state, [iodata]}`.
The host GenServer (`IRC.Client`) interprets the `[iodata]` list and
does the I/O via its existing `transport_send/2`.

The corollary, refining the principle for state-machine-shaped verbs:

> **When the verb is a state machine, extract it as a pure module
> returning `(state, [side_effect_payload])` from a `step/2` style
> function. The host GenServer does the I/O.** Two payoffs: (1)
> isolation tests assert transitions without orchestrating fakes
> (no Bypass, no IRCServer, no GenServer); (2) the FSM SHAPE is
> reusable across host shapes — Phase 6's listener facade, Phase 5's
> reconnect-with-backoff retry helper, a future replay/conformance
> tool — none of which need the upstream Client GenServer. The FSM
> does not know what direction the bytes flow OR what process owns
> the socket.

D1 was the principle's first application (function-shaped verbs:
slug CRUD, server CRUD, credential lifecycle, session-plan resolution).
D2 is the second application (FSM-shaped verb: registration handshake).
Two applications validate the principle; a third surface (Phase 6
listener facade, A4 cicchetto/lib/networks.ts split) tests it under
varying input shapes.

The 4-tuple `{:stop, reason, state, [iodata]}` shape is the small
discovery: the architecture review prescribed the 3-tuple, but the
SASL `cap_unavailable` case must flush a final `CAP END` before
stopping. State machines that need to cleanly close out a sub-protocol
on the way to a stop reason need the trailing flush channel. A future
listener-facade FSM will likely need the same shape (e.g. emit a
`421 :Auth required` numeric before stopping on missing CAP REQ).

---

## 2026-04-27 — Verb-keyed split is language-agnostic (CP10 S14, D3/A4 — corollary to D1/A2 + D2/A3)

D3 applied the verb-keyed sub-context principle to a TypeScript
client-side module-singleton store (`cicchetto/src/lib/networks.ts`,
280 lines, 9 concerns). The pre-D3 god-module owned three resources
(networks/me/channelsBySlug), per-channel scrollback state + verbs,
unread + selection state, and the WS join effect — all inside a
single `createRoot` block. Post-D3 the verbs split into five modules
mirroring the same pattern D1 used server-side.

The corollary, refining the principle for cross-language application:

> **The verb-keyed sub-context principle is language-agnostic.** The
> implementation primitive differs; the architectural contract holds.
>
>   * **Elixir (D1, D2):** umbrella is `Grappa.<Context>` with `Boundary
>     top_level?: true`. Schemas in shared low-level modules
>     (`Network`, `Credential`, `Server` for D1; `Message`, `Wire` for
>     scrollback). Verbs in per-verb modules under the umbrella
>     (`Networks.Servers`, `Networks.Credentials`, `Networks.SessionPlan`
>     for D1; `IRC.Client` + `IRC.AuthFSM` for D2). Boundary library
>     enforces dep direction.
>   * **TypeScript/Solid (D3):** umbrella is `cicchetto/src/lib/`.
>     Schemas in a shared low-level module (`api.ts` for the wire
>     types, `channelKey.ts` for the brand). Verbs in per-verb
>     modules (`scrollback.ts`, `selection.ts`, `subscribe.ts`,
>     and the slim `networks.ts` for resource verbs). Module-import
>     discipline + `tsconfig` strict mode enforces dep direction;
>     there is no Boundary equivalent, and that is acceptable for a
>     codebase of this size.
>
> **The lifecycle primitive is the verb's most natural unit-of-
> isolation.** In Elixir, that's the OTP supervisor (the `IRC.Client`
> GenServer + `:transient` restart pairing). In TypeScript/Solid,
> that's the `createRoot` + `createEffect(on(token, …))` cleanup arm
> — the module-singleton lives for app lifetime, the cleanup arm
> handles identity transitions (the C7/A1 pattern). Same shape, same
> intent, different primitive.

D1 was the principle's first application (function-shaped Elixir
verbs). D2 was the second (FSM-shaped Elixir verbs). D3 is the third
(module-singleton TypeScript verbs). Three applications across two
languages and three verb shapes validate the principle as
language-agnostic; future surfaces (Phase 4 irssi-shape UI, Phase 5
hardening, Phase 6 IRCv3 listener facade) inherit it regardless of
which side of the wire they land on.

The cross-module **ingestion verb** pattern is load-bearing in
TypeScript the same way it is in Elixir. D3's `appendToScrollback`
(public on `scrollback.ts`, consumed by `subscribe.ts`'s WS handler)
+ `bumpUnread` (public on `selection.ts`, consumed by the same
handler) are the analogues of D1's `Networks.Servers.pick_server!/1`
+ `Networks.Credentials.encrypt_password/2` — public verbs that one
context calls into another with. The producer publishes one row; both
consumer stores update via their respective verb. "Implement once,
reuse everywhere": never duplicate the mutation logic in the consumer.

---

## 2026-04-27 — E1 / A6 closure: EventRouter extraction (4th verb-keyed split)

Closes architecture review A6 (wire-shape vs producer divergence).
The wire (`Scrollback.Wire`), schema (`Scrollback.Message.@kinds`),
and renderer (cicchetto `MessageKind` switch) all advertised 10
message kinds; the producer (`Session.Server.handle_info`) only
persisted `:privmsg`. E1 closes the gap end-to-end with three
mechanical refactors and one new module:

1. **`Grappa.Scrollback.persist_event/1`** replaces `persist_privmsg/5`.
   Takes the explicit `:kind` (no `\\` defaults). Single
   write-side door for all 10 kinds.

2. **`Grappa.Session.EventRouter`** (new pure module, mirrors
   `Grappa.IRC.AuthFSM` from D2). `route/2` returns
   `{:cont, new_state, [effect]}`. State mutations (`members`,
   `nick`) live in `new_state`; effects are side-effects only
   (`{:persist, kind, attrs} | {:reply, iodata()}`). 10 IRC commands
   classified, plus 4 informational numerics (001 nick reconcile,
   332/333 topic backfill, 353/366 names bootstrap).

3. **`Session.Server.handle_info`** delegates to `EventRouter.route/2`.
   Inline transport clauses preserved: `:ping` (PONG keepalive) and
   `{:numeric, 1}` (autojoin trigger — reads `state.autojoin` which
   the router doesn't carry). Server gains `members:
   %{channel => %{nick => [mode]}}` (Q3-pinned per CP10 S16: nick →
   modes_list, NOT MapSet — modes survive sort).

4. **`Session.list_members/3`** + `GET /networks/:net/channels/:chan/members`
   for cicchetto P4-1's right-pane nick list. mIRC sort
   (@ → + → plain, alphabetical within tier).

This is the **4th application of the verb-keyed sub-context principle**:

| Cluster | Module                           | Split shape                            |
|---------|----------------------------------|----------------------------------------|
| D1 / A2 | `Grappa.Networks` god-context    | Servers / Credentials / SessionPlan    |
| D2 / A3 | `Grappa.IRC.Client` god-module   | Client (transport) + AuthFSM (pure)    |
| D3 / A4 | `cicchetto/lib/networks.ts`      | networks / scrollback / selection / ws |
| **E1**  | `Session.Server` god-handle_info | Server (transport) + EventRouter (pure)|

The shape is now a documented pattern (not a heuristic): when a
GenServer's `handle_info` accumulates per-message-kind logic that
will only grow with phase, extract a pure classifier module returning
`{:cont, new_state, [effect]}`. Server applies the effects; pure
module is unit-test-friendly without DataCase setup; future kind
addition is a single test+clause pair.

### Why effects + state, not effects-only

Q1 (CP10 S16) surfaced the trade-off: brainstorm spec pinned a narrow
return shape `:ignore | {:persist, ...} | {:reply, ...}` that didn't
express member-state delta. Two paths considered:

- (a) Keep narrow shape; Server.handle_info has a SECOND switch over
  `:irc` for member updates. Two switches drift.
- (b) Widen to AuthFSM-style `{:cont, new_state, [effect]}`. State
  derivation (members map mutations) lives in `new_state`; effects
  remain side-effects only.

Path (b) chosen. The `:reply` effect type is forward-compat in E1
(no current route emits it); CTCP replies (VERSION, etc.) land in
Phase 5+. Same shape as `Grappa.IRC.AuthFSM.step/2`, which is now
the documented template for any future pure-classifier extraction.

### A20 fold-in: deferred

A20 review recommended folding `persist_and_broadcast/4` into a
`Grappa.Session.Broadcaster` module (Wire + Topic + Scrollback contract
single-source). E1 deletes `persist_and_broadcast/4` (zero callsites
post-refactor) but does NOT extract Broadcaster — `apply_effects/2`
INSIDE Server holds the same logic for the inbound path; the OUTBOUND
PRIVMSG path (`handle_call({:send_privmsg, ...})`) inlines the same
shape because the caller needs the persisted `Message.t()` return
value (different transaction shape). Two paths, same logic — A20's
extraction stays open as a Phase 5 consolidation candidate.

---

## 2026-04-27 — P4-1 / A5 closure: three-pane shell + 5th verb-keyed split

Closes architecture review A5 (`ChannelsController.index` returning
the credential's static autojoin list rather than session-tracked
joined channels). Closes the Phase 4 first-ship UI scope: cicchetto
rewrites from two-pane (sidebar + main) to three-pane responsive
(sidebar + main with topic+scrollback+compose + members aside);
mIRC-light + irssi-dark themes; irssi keyboard shortcuts; members
sidebar consuming `/members`; compose with tab-complete + slash
commands; mention highlight + sidebar mention badge.

### Server-side (A5 close)

`Grappa.Session.EventRouter` extended with self-PART / self-KICK
semantics: when `sender == state.nick` (PART) or `target == state.nick`
(KICK), the channel key is `Map.delete`'d from `state.members` —
symmetric with the existing self-JOIN wipe. Invariant:
`Map.keys(state.members)` is the live "currently-joined channels"
set. Other-user PART / KICK keep the existing inner-nick-only
semantics.

`Grappa.Session.list_channels/2` facade added — bare-name list
mirror of `list_members/3`. `GrappaWeb.ChannelsController.index/2`
composes the credential autojoin list ⊕ session-tracked list into
the new wire shape `{name, joined: bool, source: :autojoin | :joined}`.
`:autojoin` wins on overlap (operator intent durable; session JOIN
transient). Three-category merge: in-both ⇒ joined+autojoin; autojoin-
only ⇒ not-joined+autojoin; session-only ⇒ joined+joined. Sorted
alphabetically.

Two new outbound endpoints in service of P4-1's slash commands:
`POST /networks/:net/channels/:chan/topic` (sets channel topic via
`Session.send_topic/4`, persists `:topic` scrollback row, broadcasts)
+ `POST /networks/:net/nick` (sends `NICK <new>` upstream via
`Session.send_nick/3`; the server reconciles `state.nick` via the
existing EventRouter NICK handler when the upstream replays).

### Client-side (5th verb-keyed split)

D3 split cicchetto's god-module `lib/networks.ts` into four verbs:
`networks`, `scrollback`, `selection`, `subscribe`. P4-1 adds five
more: `theme` (theming + viewport-mode), `keybindings` (global
keydown dispatch), `members` (per-channel member list — bootstrap
via REST, live updates via existing message stream), `compose`
(per-channel draft + history + slash-dispatch + tab-complete),
`mentions` (per-channel mention count, paired with `selection`'s
unread count).

Plus four pure-function helpers (`modeApply`, `slashCommands`,
`mentionMatch`, `memberTypes`) — DOM-free, fully unit-tested, shared
between consumers.

| Cluster | Module                           | Split shape                                                              |
|---------|----------------------------------|--------------------------------------------------------------------------|
| D1 / A2 | `Grappa.Networks` god-context    | Servers / Credentials / SessionPlan                                      |
| D2 / A3 | `Grappa.IRC.Client` god-module   | Client (transport) + AuthFSM (pure)                                      |
| D3 / A4 | `cicchetto/lib/networks.ts`      | networks / scrollback / selection / subscribe                            |
| E1 / A6 | `Session.Server` god-handle_info | Server (transport) + EventRouter (pure)                                  |
| **P4-1**| `cicchetto/lib/`                 | + theme / keybindings / members / compose / mentions + pure helpers      |

The 5th application validates the principle further: post-D3 we had
4 stores, P4-1 adds 5 more — and each new store mirrored the same
shape (module-singleton + createRoot + on(token) cleanup arm). No
context provider boilerplate; fine-grained signal subscriptions
across consumers; identity-rotation cleanup uniform.

Q4 of P4-1 (presence-from-existing-message-stream) was the load-
bearing reuse decision: rather than introducing a new server-side
broadcast for member-state deltas, the cicchetto `members.ts` store
filters the same `MessagesChannel` stream `subscribe.ts` already
consumes. The persist row IS the wire-level evidence of presence
change. Implements the "Implement once, reuse everywhere" + "One
feature, one code path, every door" rules together.

### Three-pane responsive shell

Layout: CSS Grid `grid-template-columns: 16rem 1fr 14rem` on
desktop. At ≤768px (single source: `--breakpoint-mobile: 768px` on
`:root`, mirrored in JS via `theme.ts`'s reactive `isMobile()`
signal) both side panes collapse to fixed-position drawers toggled
by ☰ hamburger buttons in `TopicBar`. Backdrop overlay captures
tap-outside; `Esc` closes whichever drawer is open; selecting a
channel auto-closes the sidebar drawer.

Q7 pinned hamburger-only (no edge-swipe): conflict-free with iOS
back-swipe; explicit affordance over gesture discoverability.
Edge-swipe deferred to M-cluster polish.

### Theme system

Q8 pinned single-CSS-file with `:root[data-theme="..."]` blocks:
both themes ship in the same asset, paint at first frame, no FOUC
on toggle. `theme.ts` writes `document.documentElement.dataset.theme`;
`applyTheme()` boot-time entry called from `main.tsx` pre-render
reads localStorage + `prefers-color-scheme` to pick the initial
theme. Three-way "auto / mIRC / irssi" radio in `SettingsDrawer`;
"auto" clears localStorage and re-evaluates `prefers-color-scheme`
(live OS-level theme changes propagate when in auto).

### Keybindings

Q-resolution: vanilla `window.addEventListener("keydown")` + handler-
interface dispatch table; no third-party library dep. Bindings:
`Alt+1..9` (channel switch by index), `Ctrl+N/P` (next/prev unread),
`/` (focus compose), `Esc` (close drawers), `Tab` / `Shift+Tab`
(cycle nick complete in compose; gated on typing target). Two-stage
init via `registerHandlers + install`; Shell.tsx owns the handler
callbacks. Tab completion is members-only (Q6 pinned).

### Compose surface

`compose.ts` + `slashCommands.ts` + `ComposeBox.tsx` form the
per-channel input layer. Slash commands shipped: `/me`, `/join`,
`/part`, `/topic`, `/nick`, `/msg`. Dropped: `/raw` (needs a
`POST /networks/:net/raw` server endpoint that doesn't exist;
M-cluster). History walk via Up/Down on first/last line; CTCP ACTION
framing for `/me`. Empty / unknown commands surface as inline alert
banners. Tab-complete cycles through alphabetically-sorted matches
for the original-prefix anchor (continuation detected by matching
slice at start..cursor against the last chosen nick — keeps cycle
stable even though the rendered word grows on each tab).

### Mention surface

`mentionMatch.ts` is the shared word-boundary case-insensitive
matcher; consumed by `ScrollbackPane.tsx` (line highlight class
`.scrollback-mention`) and `subscribe.ts` (`bumpMention(key)` for
the sidebar badge — only when channel is NOT currently selected).
Selection clears both unread + mention counts.

### Trade-offs accepted

- **Topic display in TopicBar is placeholder in P4-1.** A topic store
  derived from latest `:topic` scrollback row is M-cluster polish
  (the topic-bar shows the channel name + nick count; topic text
  empty for now). The ad-hoc shipping of the operator's own
  `/topic` command via the new POST endpoint persists a `:topic`
  scrollback row that future-render will pick up — the wire shape
  is forward-compat.
- **Tab-completion is members-only** (Q6); recent-sender fallback
  deferred to M-cluster.
- **Edge-swipe drawer triggers** deferred (Q7).
- **PREFIX ISUPPORT-driven mode-prefix table** — both server-side
  EventRouter + cicchetto modeApply hard-code `(ov)@+`. Phase 5+
  swaps both at once.

### A20 (Broadcaster fold-in) — still deferred

`Session.Server`'s outbound PRIVMSG (`handle_call({:send_privmsg, ...})`)
gained `:topic` and `:nick` siblings (`{:send_topic, ...}`,
`{:send_nick, ...}`) — same persist-then-broadcast-then-send shape,
three callsites for the same logic. A20's extraction would
consolidate them; P4-1 leaves the duplication (small, contained, three
callsites) for Phase 5.

---

## 2026-04-28 — text-polish: channels_changed user-topic broadcast + iPhone bug sweep

Cluster pinned 2026-04-28 (CP10 S20). Closes the four iPhone-acceptance
gaps blocking the M2 NickServ-IDP + anon webirc auth-triangle clusters.

### Server-side

- Grappa.Session.Server.delegate/2 post-route compares
  `Map.keys(state.members)` between input + derived states. On
  keyset diff, fires `Phoenix.PubSub.broadcast/3` on
  `Grappa.PubSub.Topic.user(state.user_name)` with payload
  `{:event, %{kind: "channels_changed"}}`.
- First real consumer of the per-user PubSub topic shape (reserved
  infrastructure since Phase 2 sub-task 2h; broadcast surface
  starts here).
- EventRouter remains pure: `@type effect :: {:persist, ...} |
  {:reply, ...}` unchanged. Keyset-delta detection at the GenServer
  boundary keeps transport concerns (PubSub, Topic, user_name) out
  of the pure router.
- Direction-agnostic: self-JOIN, self-PART, self-KICK all collapse
  to the same heartbeat. Channels-list mutation IS the event;
  cause is irrelevant to subscribers.
- Empty payload: cicchetto refetches `GET /channels` on receipt.
  REST endpoint stays the single source of truth for the channel
  list with `{name, joined, source}` envelopes.

### Cicchetto-side

- New `lib/userTopic.ts` module — module-singleton side-effect,
  joins `grappa:user:{name}` once per identity, calls
  `networks.refetchChannels()` on `channels_changed` events.
- `lib/networks.ts` exposes `refetchChannels: () => void` (wraps
  the createResource refetch callback).
- `lib/socket.ts` re-exports the previously-dropped `joinUser/1`
  (S49 marker honored — first real consumer brings it back).
- `Shell.tsx` empty-state fallback gains an inline ☰ + ⚙
  navigation header (mobile escape hatch — TopicBar host of these
  buttons was gated on `selectedChannel()`).
- `ComposeBox.tsx` drops `disabled={sending()}` from the textarea
  (kept on the submit button); fixes focus loss across submit.

### Trade-offs accepted

- `channelsBySlug` stays a `createResource` rather than converting
  to a verb-keyed module with per-channel patches (M-cluster polish).
  Refetch-on-event is heavier than a direct mutate but uses the
  REST endpoint as the canonical source — cheaper to reason about.
- Empty-state toolbar duplicates a few lines of JSX with TopicBar
  rather than factoring out a reusable `Topbar.tsx` component
  (M-cluster polish — too much P4-1 surgery for a 4-bug sweep).
- Multi-tab consistency: every tab refetches on any tab's mutation.
  Phoenix.PubSub fan-out cost is a few-bytes broadcast + a
  single-page GET /channels per tab — acceptable.

---

## 2026-05-02 — `SessionSupervisor` `max_restarts` bump for cluster-wide flap tolerance

Closes test-suite flake first surfaced during the visitor-auth cluster
(Task 3 fix-pass): `Grappa.BootstrapTest` `on_exit` callbacks intermittently
exit with `GenServer.call(Grappa.SessionSupervisor, {:terminate_child, pid},
:infinity) ** (EXIT) shutdown` — the supervisor was already gone by the time
cleanup tried to terminate its child.

Pre-fix `Grappa.SessionSupervisor` started with the default
`DynamicSupervisor` budget (`max_restarts: 3, max_seconds: 5`). That budget
is GLOBAL across all children, not per-child. Crash chain on test teardown:

1. Test process exits → linked `Grappa.IRCServer` fake dies.
2. Listening + accepted sockets close.
3. `Grappa.IRC.Client` receives `{:tcp_closed, _}` → GenServer crashes.
4. `Session.Server` linked to the Client crashes with the same reason.
5. `SessionSupervisor` (`:transient`) restarts the Session.
6. Restart's `init/1` spawns a fresh `Client.start_link` → `:econnrefused`
   against the dead port → crash.
7. Repeat. Each test contributes a few crashes; with several Session-using
   tests in flight the cumulative restart count crosses 3 in 5s.
8. `SessionSupervisor` exits `:shutdown`. `Grappa.Supervisor` (`:one_for_one`)
   restarts it — but the new instance has no children. Subsequent
   `terminate_child` calls from late `on_exit` hooks find a freshly-spawned
   supervisor with no record of the original pid → `(EXIT) shutdown`.

The 2026-04-27 P4-1 design note (line 676 region) already flagged this
shape: "Session-level non-blocking-init test uses `Server.start_link/1`
directly... `Session.start_session/3` via `DynamicSupervisor`... would
trigger the connect-refused crash → `:transient` restart cycle, which
exhausts `SessionSupervisor`'s `max_restarts: 3` budget in <100ms and
crashes the supervisor — torching every other Session in the test run."
That note prescribed test-side discipline (skip the supervisor path for
unit tests). `BootstrapTest` can't follow that rule — `Bootstrap.run/0`'s
contract IS to spawn under the supervisor, so the supervisor path is the
only valid surface. The fix had to move into the supervisor itself.

Initial bump to `max_restarts: 100, max_seconds: 60` (commit a4a56ae)
absorbed the BootstrapTest on_exit cascade but left a residual ~30%
test-flake rate when other tests deliberately spawned dead-port sessions
(BootstrapTest's "all sessions counted as started; upstream-connect
failures surface async (C2)" at line 143 binds port 1, which the
container refuses immediately with RST). Captured logs showed >25
Session.Server crashes in 12 milliseconds for a single dead-port
session — the cycle runs at ~2000 restarts/sec because `gen_tcp.connect`
on a refused port returns within microseconds, so each restart→connect→
crash→restart cycle is sub-millisecond.

Brief detour into rate-limiting at the source (1s `Process.sleep` in
`Client.handle_continue` before `{:stop, {:connect_failed, _}, state}`,
commit ef4bf62) broke the C2 contract test's `assert_receive {:EXIT,
^client, {:connect_failed, :econnrefused}}, 1_000` — the timeout
budget assumes async failure surfaces within a second; the sleep
made the race tight and consistently failed. Reverted.

Final shape: `max_restarts: 10_000, max_seconds: 60` raises sustained
tolerance to ~167 crashes/sec — enough to absorb 5 seconds of
full-rate restart-loop (10000 / 2000 ≈ 5s) before tripping, while
still catching genuinely catastrophic loops (10k restarts/min from one
session is wildly abnormal). Test-suite teardown cascades and prod
upstream-IRCd network blips (whole-network outage causing dozens of
sessions to flap simultaneously) both fit comfortably under the budget.
Phase 5's per-session reconnect/backoff will replace the
exhaust-and-give-up shape with proper session-health tracking +
per-Session telemetry; at that point the supervisor limits become
genuinely-defensive failsafes against a runaway crash loop rather than
the front-line tolerance for normal flap.

The change is per-supervisor (`SessionSupervisor` only); other
DynamicSupervisors keep the conservative default.

---

## 2026-05-03 — T31 admission control + captcha LANDED (CP11 S22 — closes post-Phase-4 ops)

Three-tier admission cap + Cloudflare Turnstile captcha + per-network
failure circuit-breaker shipped to prod. Closes the post-Phase-4 ops
cluster; the original CP11 framing ("max 3 concurrent connections per
source IP") was rejected during brainstorm (S21) because IP alone
cannot split mobile-CGNAT-legit from abuser-on-shared-IP — one IP is
thousands of legit users behind a CGNAT carrier.

### Final cap shape

`Grappa.Admission.check_capacity/1` composes three gates in order:

  1. **NetworkCircuit** — per-network failure circuit-breaker. Lazy
     ETS GenServer, distinct from S20's per-(subject, network)
     `Session.Backoff`. Failure window + cooldown are independent
     intervals (cooldown only kicks in after the threshold is
     breached; window slides regardless). Login records both
     successes (resets) and failures (counts toward threshold).
  2. **Per-network total** — `networks.max_concurrent_sessions`
     (column added Plan 1, default `nil` = uncapped). Match-spec
     `{{:session, :_, network_id}, :_, :_}` over
     `Grappa.SessionRegistry`. Counts ALL session types — user
     sessions (Bootstrap-spawned from credentials) AND visitor
     sessions (Login-spawned). Operator caveat: vjt's persistent
     user session counts toward the visitor cap budget.
  3. **Per-(client_id, network)** — `networks.max_per_client`
     (column added Plan 1, default 1). Reads `accounts_sessions` for
     the X-Grappa-Client-Id header value. Lives on the session row,
     NOT the registry key (registry stores subject + network_id, not
     client_id), so the match-spec lookup happens against Ecto, not
     ETS.

### Captcha gate

`Grappa.Admission.Captcha` behaviour with three impls: `Disabled`
(default), `Turnstile`, `HCaptcha`. Provider chosen at runtime via
`GRAPPA_CAPTCHA_PROVIDER` env var (`disabled` | `turnstile` |
`hcaptcha` — anything else falls back to Disabled with a Logger
warning). Gate fires at `Visitors.Login` case-1 (fresh anon
provision) ONLY — cases 2/3 are already password/token-gated, so
re-captcha would be redundant friction.

Wire shape on captcha-required: `400 {error: "captcha_required",
provider: "<provider>", site_key: "<public site key>"}`. The
provider field is non-redundant — site_key format alone doesn't
disambiguate Turnstile from hCaptcha at the SPA layer (both use
opaque alphanumeric strings), so cicchetto reads provider to pick
the right widget loader.

### Operator-bind verb

`mix grappa.set_network_caps --network <slug> --max-sessions N
--max-per-client N` (new, single-purpose Mix.Task) wraps
`Grappa.Networks.update_network_caps/2`. Prod release uses the same
context fn via `bin/grappa rpc` (release ships without `mix`).

Verb chosen over extending `bind_network` because caps live on
`networks` (per-deployment shared infra, one azzurra row, many
users bind it) not on `network_credentials` (per-(user, network)).
Reusing the credential-scoped verb would have leaked the domain
boundary per CLAUDE.md "Reuse the verbs, not the nouns" — the 20%
mismatch (network row vs credential row, no user dimension) is the
boundary.

### Plan-fix-first dual application

The cluster shipped via TWO independent applications of the
plan-fix-first principle (codified in S21 for Plan 1):

  * **Plan 2 spec drift** — 12 docs-only commits on main ahead of
    cluster execution (Tasks 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 13, 14
    + targeted-test invocation cleanup). Each fixed a spec bug
    BEFORE implementation, so the cluster never inherited it.
  * **Task 14 deploy-time bugs** — 3 code commits on main during
    Step 5 e2e validation, each caught only by real-browser
    automation (chrome-devtools-mcp). Filed as a side worktree
    `cluster/t31-deploy-fix` because the changes were code, not
    docs.

The three deploy-time bugs all shared a property: invisible to unit
suite, visible only at the prod boundary.

  1. `compose.prod.yaml` `environment:` block had no entries for
     the three captcha env vars. Docker compose only consumes
     `.env` for variable substitution (e.g. `${SECRET_KEY_BASE}`)
     — host env vars don't auto-inject into containers unless
     listed explicitly in `environment:` or via `env_file:`.
     `runtime.exs`'s `System.get_env(...)` returned nil → captcha
     fell back to `Disabled`. Test config sidestepped this entirely
     by passing the keyword list directly via
     `Application.put_env(:grappa, :admission, ...)` in
     `config/test.exs`.

  2. `crypto.randomUUID` is gated to secure contexts (HTTPS or
     localhost). On `http://grappa.bad.ass` (TLS deferred to Phase
     5 hardening) the call throws `crypto.randomUUID is not a
     function`. Vitest jsdom IS a secure context, so the unit
     suite never tripped. Fallback hand-rolls v4 from
     `crypto.getRandomValues` (which IS available on insecure
     origins — only randomUUID specifically is gated).

  3. Nginx CSP `script-src 'self'` blocked Turnstile JS at
     `https://challenges.cloudflare.com/turnstile/v0/api.js`. CSP
     stays the load-bearing XSS defense for the
     bearer-in-localStorage design (auth.ts module-level comment
     names this), so the fix added the minimal allowlist:
     Turnstile host on `script-src` + `connect-src` (verify-XHR) +
     new `frame-src` (challenge UI is iframed). Biome doesn't
     inspect CSP headers; the unit suite couldn't catch it.

Lesson: env-var → runtime config + browser APIs gated by
secure-context + CSP allowlist are three boundaries that ONLY
real-browser e2e exercises. The "REAL BROWSER, hard gate" mandate
in Plan 2 Step 5 paid for itself.

### W3 supersession

Plan 2 retired `Visitors.Login.@max_per_ip` + `check_ip_cap/1`.
T31's per-(client_id, network) cap is the replacement — tighter
keying on the same anti-abuse intent, with the captcha gate
covering the cases where `client_id` is a fresh UUID (which is
always for a new visitor, by definition).

### What's deliberately NOT in T31

  * **No per-IP cap.** Brainstorm rejected per-IP outright; CGNAT
     mobile carriers fail it. Per-(client_id, network) +
     captcha-on-fresh-anon are the two halves of the replacement.
  * **No ASN/MaxMind reputation lookup.** Mobile CGNAT detection
    requires the paid GeoIP2 ISP product; CAPTCHA solves the same
    problem cleaner.
  * **No datacenter IP CIDR blocking.** CAPTCHA covers it.
  * **No browser canvas / device fingerprinting.** `client_id`
    UUID v4 in localStorage is the only fingerprint, and visitors
    can clear it freely (the captcha is what makes that costly).
  * **No identity-tier exemptions from concurrency caps.**
    Operator's only knob is per-network `max_per_client`.

### Plan 2 micro-followups carried forward (not blocking next cluster)

Filed in `docs/plans/2026-05-03-t31-admission-integration.md`
"Post-T31 state":

  * Partial index `where: "client_id IS NOT NULL"` on
    `accounts_sessions.client_id`.
  * DB-level CHECK constraints on `networks.max_concurrent_sessions`
    + `max_per_client`.
  * `Network.changeset` "rejects negative" test name accuracy
    (currently asserts 0, not negative).
  * `NetworkCircuit.compute_cooldown(0, _)` edge-case test +
    setup-block comment.
  * `superpowers:requesting-code-review` template — gates RUN, not
    asserted from inspection (corrective from Plan 1's review
    deviation; Task 14 reviewers complied via evidence-paste
    mandate).

---

## 2026-05-03 — NetworkCircuit semantics: lazy expiry + window-vs-cooldown independence

`Grappa.Admission.NetworkCircuit` (T31 P1, refined T31-cleanup B4)
implements a per-network failure circuit-breaker with two
**independent** intervals:

  * **Failure window** (`@window_ms`, default 60s) — sliding window
    over which failure counts accumulate. Resets on the next failure
    that arrives past the window boundary while the circuit is
    `:closed`.
  * **Cooldown** (`@cooldown_ms`, default 30s with ±25% jitter from
    `Grappa.RateLimit.JitteredCooldown`) — minimum time the circuit
    stays `:open` after threshold breach.

Independence: a failure during cooldown does NOT reset the window
counter — it's silently dropped (no half-open). A success-side
clearing only happens via `:cooldown_expire` cast triggered by
`check/1` observing `now >= cooled_at_ms`. The cast carries the
observed `cooled_at_ms` as a token; if the circuit re-opened
between observation and cast handler, the token mismatch makes the
handler no-op (H6 race fix).

**Lazy expiry:** ETS rows persist indefinitely once written. The
expire-cast deletes the row only when the observation token matches
current state. There is no periodic sweep — operator confirms via
`:observer_cli` ETS table inspection that `:admission_network_circuit_state`
size is bounded by the small number of networks the bouncer talks to.

**Why distinct from `Session.Backoff`:** Backoff is per-(subject,
network) reconnect pacing; NetworkCircuit is per-network
all-subjects health gating. Both share `JitteredCooldown` primitive
but the failure-source semantics differ — Backoff records every
upstream connect failure for a single session; NetworkCircuit
records aggregated network-wide failure count regardless of which
session reported.

---

## 2026-05-04 — t31-cleanup cluster close-out: 74-finding bundled cleanup, 8 vjt-blessed decisions, sqlite ALTER+CHECK landmine

`cluster/t31-cleanup` shipped + deployed to `http://grappa.bad.ass`
2026-05-04 (CP11 S29). Bundled paydown of every actionable finding
from the post-T31 codebase review (`docs/reviews/codebase/2026-05-03-codebase-review.md`):
12 HIGH + 35 MEDIUM + 27 LOW + 6 already-filed Plan-2 micro-followups
+ 2 non-T31 HIGH (H2 user-logout-WS-tear-down, H12 send_pong NUL
asymmetry). Seven natural buckets; ~40 commits across two plans;
+60 server tests (855 → 915); 8 plan-fixes mid-execution (plan-fix-
first discipline matured: never silently absorb plan-vs-code
divergence).

### vjt-blessed decisions adopted (A–H)

  * **A** — `Application.get_env` runtime reads removed; supervisor
    injects via `start_link/1` opts (boot-time configuration boundary
    only, mirroring CLAUDE.md's documented exception list).
  * **B** — Captcha duplication kept ONLY where mirroring provider
    wire shape (Turnstile vs hCaptcha endpoints / payloads / error
    codes); shared HTTP client + error-mapping + config-load
    consolidated into `Grappa.Admission.Captcha.Provider` behaviour.
  * **C** — `NetworkCircuit` H6 + H7 races fixed via observation-
    token capture (`cooled_at_ms`) + state-aware window-reset; cast
    handler short-circuits on token mismatch.
  * **D** — `Grappa.IRC.Parser.strip_unsafe_bytes/1` rename + NUL
    strip closes `send_pong/2` NUL injection asymmetry (H12); CR/LF/NUL
    stripped at single boundary; `strip_crlf/1` removed (total-
    consistency, no compatibility shim).
  * **E** — `Grappa.ClientId` Ecto custom type at `lib/grappa/
    client_id.ex` (top-level Boundary peer; storage `:string`; UUID
    v4 regex `~r/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}
    -[0-9a-f]{12}\z/i`); public `regex/0` accessor reused by
    `Plugs.ClientId` (single source of truth, no parallel literal).
  * **F** — `networks.{max_concurrent_sessions, max_per_client}` is
    a three-valued contract: positive (set), `0` (lock-down), `nil`
    (unlimited). `Network.changeset` swaps `validate_number` →
    `validate_change(&validate_non_negative_or_nil/2)` to express it;
    `mix grappa.set_network_caps` adds `--clear-max-*` flags mutex
    with `--max-*`.
  * **G** — `Grappa.IRC.Message.anonymous_sender/0` is the single
    source of truth for the `"*"` prefix-less sentinel (L-irc-1);
    `Identifier.valid_sender?/1` routes through it instead of
    mirroring the magic string.
  * **H** — Reviewer-template upgrade: dispatch briefs MUST require
    the reviewer to RUN each gate command and paste its literal tail.
    Skill-source path mismatch (`~/.claude/superpowers/skills/...`
    is plugin-cache, regenerated) made an upstream edit infeasible;
    routed to user-global memory pin (`feedback_reviewer_gate_evidence`)
    after vjt blessed option 2.

### Subject-discriminator unification (M-web-1, B6.2)

Conn `:current_subject` reshaped from a dual-assign convention
(`:current_user_id` / `:current_visitor_id`, ambiguous when both
nil — anon vs not-yet-loaded?) to a tagged tuple carrying the loaded
struct: `{:user, %User{}}` | `{:visitor, %Visitor{}}`. New module
`GrappaWeb.Subject` owns the boundary helper `to_session/1` (struct →
ID map) — 33 lines justified by 8 controller call sites needing the
projection. Big-bang refactor across 13 files; test count unchanged
(884) — contract preserved. UserSocket left untouched (M-web-1 spec
scoped REST surface; UserSocket has its own `connect/3` auth path).

### Defense-in-depth: DB CHECK constraints + Ecto.Enum at boundary

B5.5 added DB-level CHECK constraints — `networks.max_concurrent_sessions
IS NULL OR >= 0`, `networks.max_per_client IS NULL OR >= 0`,
`messages.kind IN ('privmsg','notice','action','join','part','quit',
'nick_change','mode','topic','kick')`, `network_credentials.auth_method
IN ('auto','sasl','server_pass','nickserv_identify','none')`. Ecto.Enum already validates kind +
auth_method at the changeset boundary; the DB CHECK is the second
line of defense — if a future migration or release script bypasses
the schema and writes a raw map, the DB rejects it. Pairing is
deliberate: Ecto for friendly changeset errors during normal
operation, sqlite CHECK for the case where Ecto is sidestepped.

### CSP tightening + drift-detector CI test (B6.5/6/7)

`connect-src` dropped global `ws:` / `wss:` allow → explicit host-
scoped `ws://grappa.bad.ass wss://grappa.bad.ass` + Turnstile.
Security headers extracted to `infra/snippets/security-headers.conf`
(included by both `/` and `/sw.js` locations). New CI test
`test/grappa/infra/csp_provider_test.exs` parses `nginx.conf` +
snippet, asserts each non-Disabled captcha behaviour impl host
appears in the CSP allowlist — drift detector fires the moment a
new provider lands without its CSP entry. Sibling-judgment infra
change: `infra/` added to `WORKTREE_VOLUMES` in `scripts/_lib.sh`
(precedent: `lib`, `test`, `config`, `priv/repo`).

### Hard-won lesson: sqlite ALTER + CHECK + WAL — `defer_foreign_keys` is the right tool

sqlite has no `ALTER TABLE ADD CONSTRAINT`. The canonical recipe
for adding a CHECK to an existing table is rename-old + recreate-new
+ INSERT-SELECT + drop-old. With foreign-key references in play
(networks ← network_servers, network_credentials, messages), the
recipe lands in two distinct landmines:

1. **`@disable_ddl_transaction true` + `PRAGMA foreign_keys=OFF/ON`**
   (the canonical sqlite recipe) interacts badly with Ecto/Exqlite's
   connection pool in WAL mode: without a pinned transaction,
   sequential `execute()` calls each get their own pool connection
   with their own `sqlite_master` snapshot. `CREATE INDEX` after
   `RENAME` + `DROP` saw a stale snapshot showing the index still
   on the old table and crashed `index already exists`. Reproduced
   2× in dev.
2. **Plain transactional migration** — sqlite ≥ 3.25 auto-rewrites
   dependent FK references to point at `*_old` during the parent
   `ALTER RENAME`. The dependents (`network_servers`,
   `network_credentials`, `messages`) block `DROP TABLE networks_old`
   with `FOREIGN KEY constraint failed`. First prod deploy attempt
   failed here.

**The fix that lands cleanly:** `PRAGMA defer_foreign_keys=ON` at the
top of `up/0` and `down/0`, with the migration left in its default
transactional shape. FK checks defer to COMMIT; by the time COMMIT
runs, all four tables have been recreated with fresh CHECK schemas
and fresh `REFERENCES "networks"` text. Round-trip clean: dev
`ecto.migrate + rollback + migrate` green; 8/8 CHECK constraint
tests green; prod migration applied cleanly on second deploy.
Memorialised here so the next ALTER-CHECK migration doesn't
re-derive the lesson.

### Cluster outcome

7 buckets / ~40 commits / +60 tests / 8 plan-fixes / 12 HIGH + 35
MEDIUM + 27 LOW spec items closed / shipped to prod 2026-05-04.
Worktree branch `cluster/t31-cleanup` stays alive — channel-client-
polish (the next MVP-required cluster) will reuse it.

---

## 2026-05-04 — Compose decoupled from LAN/IP, second host (voygrappa) brought up on macOS

Bringing up grappa on a second host (Mac, `voygrappa.bad.ass` →
`192.168.53.12`) surfaced that the committed compose stacks were
implicitly pinned to the canonical Linux deployment: `vlan53` external
network + `192.168.53.11` static IP for both dev (grappa direct) and
prod (nginx). Two failure modes:

1. `docker compose up` on a fresh clone bombs at network create
   (`vlan53` doesn't exist).
2. Even on the canonical host, the static IP coupled the deployment
   shape to the network shape — no way to bring up a sibling host
   without forking compose files.

Compounded on macOS: Docker Desktop runs containers inside a hidden
Linux VM, so macvlan can't reach the host's LAN interface from inside
containers. The Linux trick (container directly on vlan53 with its
own IP) is structurally unavailable.

### Decision

Split machine-specific binding (LAN IP, hostname) from deployment
shape, into gitignored personal overrides:

  * **Committed base files** ship deployment-agnostic defaults:
    bridge networks + wildcard host port-publishes (dev `4000:4000`,
    prod `3000:80`). Anyone clones, `docker compose up`, browses at
    `http://localhost:{4000,3000}`. No LAN, no DNS, no vlan needed.
  * **Personal bindings** live in `compose.override.yaml` (dev) and
    `compose.prod.override.yaml` (prod) — gitignored, auto-loaded
    by `scripts/_lib.sh` when present. They use `ports: !override`
    (drop-and-replace) to swap the wildcard publish for an IP-bound
    one, plus `PHX_HOST` env for prod.
  * **Examples committed** at `compose.{,prod.}override.yaml.example`
    so the override pattern is self-documenting; future operators
    don't have to reverse-engineer it from `_lib.sh`.

### Why prod default is `3000:80`, not `80:80`

Privileged port 80 requires root or `cap_net_bind_service` on the
host — extra friction for cloning operators who just want to see the
app run. The canonical home-LAN deployment overrides to
`192.168.53.{11,12}:80:80` because the DNS A records point there
without a port suffix; that's a deployment choice, not a
shipping-default.

### Why `!override`, not `!reset`

Compose's YAML override semantics — `!reset` removes the field
entirely (correct for `compose.oneshot.yaml`'s `ports: !override []`
to strip ANY host publish during oneshots), but for
"drop-base-and-set-new" the right tag is `!override`. Spent a tool
call on this — `!reset` first attempt produced an empty ports list in
the merged config; `!override` produces `host_ip + target + published`
as expected. Documented in the override examples + CLAUDE.md so the
next operator skips the same misstep.

### CSP de-pinning

`infra/snippets/security-headers.conf` had `connect-src` allowlisting
`ws://grappa.bad.ass wss://grappa.bad.ass` explicitly. CSP3 specifies
that `'self'` covers same-origin ws/wss automatically — so
`connect-src 'self' https://challenges.cloudflare.com` is identical
for the canonical case AND deployment-hostname agnostic. Phase 5
wss-rollout note in the prior comment was always moot; deleted.

### macOS bash 3.2 portability

`/bin/bash` on macOS is 3.2 (Apple's last GPLv2-licensed version);
doesn't grok `declare -ag` (the array-export idiom in `_lib.sh`,
already there pre-refactor). Switched all `scripts/*.sh` shebangs
from `#!/bin/bash` to `#!/usr/bin/env bash` so PATH resolution finds
Homebrew bash 5 first on macOS, system bash 4+ on Linux. Documented
the bash-4+ requirement in CLAUDE.md so future setup prompts don't
recommend running scripts under stock macOS bash.

### Healthcheck via container exec

`scripts/healthcheck.sh` and `scripts/deploy.sh`'s `/healthz` poll
both used `curl http://192.168.53.11/...` against the host. With
host-port-binding now operator-configurable (default wildcard,
override IP-bound), the IP literal had to go. Switched to
`docker compose exec nginx wget -qO- http://127.0.0.1/healthz` —
probes the in-container loopback, independent of host port shape.
Works on the wildcard default AND the IP-bound override.

### Worth-noting non-decisions

  * **NOT keeping `register-dns.sh` in the standard flow.** It's a
    Technitium-specific operator helper for the home LAN; depersonalized
    (env vars now required, no defaults) so it's at least reusable, but
    it's not invoked by `deploy.sh` or the dev path.
  * **NOT consolidating compose files.** Considered folding dev+prod
    into one file via `profiles:` — rejected because the differences
    are structural (different services, different build targets,
    different env requirements). Three files (dev, prod, oneshot)
    each have one concern; an override is the fourth.
  * **NOT touching historical docs.** Checkpoints, plans, design
    notes, project story all reference `192.168.53.11` /
    `grappa.bad.ass` in their then-current state. They're frozen
    chronological records — updating would falsify history.

---

## 2026-05-06 — BUG7 doesn't reproduce in Playwright iPhone 15 emulation

S5 of the integration-testing plan
(`docs/plans/2026-05-06-integration-testing.md`) called BUG7
"a regression-pin RED on prod head" and budgeted a fix. The S4 RED
landed at HEAD `aa4ad17`; S5 trace investigation revealed the failure
was at the page-object's `selectChannel` step — BEFORE the test ever
reached compose-send. The mobile JSX branch in `Shell.tsx` (≤ 768px,
matched by Playwright's iPhone 15 device profile at 393×852) replaces
the entire desktop sidebar with `<BottomBar />`, so selectors keyed off
`.sidebar-network h3` / `.sidebar-window-btn` had no DOM target.

### Findings

After teaching the page-object to detect viewport and switch between
sidebar (`.sidebar-network` + `.sidebar-window-btn`) and bottom-bar
(`.bottom-bar-network` + `.bottom-bar-tab`) selectors, both BUG7 specs
flipped GREEN in 2.0–2.5 s. The hypothesized root causes (WS suspend on
virtual-keyboard show, Solid reactivity glitch under WebKit microtask
scheduling, CSS overflow swallow when keyboard reduces visualViewport)
do NOT reproduce in headless WebKit + iPhone 15 viewport. The bug
surface that DOES reproduce on real hardware lives in:

  * actual virtual-keyboard chrome occluding the bottom of the
    visualViewport (Playwright doesn't render the iOS keyboard);
  * iOS Safari's `visualViewport` resize behavior on focus;
  * touch-action / scroll-momentum quirks the emulator skips.

Headless WebKit is "Safari engine without the OS", and the OS shell is
where this bug lives.

### Decision

Downgrade the BUG7 specs from "regression-pin RED → fix flips green"
to "positive guard rail":

  * They assert the iOS-shaped input path (tap-to-focus, per-keystroke
    type, tap send) round-trips compose → WS → DOM on every commit.
  * A regression in compose dispatch, openQueryWindowState, or
    BottomBar tab focus would surface here.
  * The actual real-iOS bug is deferred to a session that can drive a
    physical device via DevTools-over-USB. Not in CI's reach.

### Mobile-aware page-object pattern

The page-object now branches on viewport for three helpers — `loginAs`
(shell-ready selector), `sidebarWindow` (per-network grouping +
window-name lookup), `selectChannel` (click target). Threshold mirrors
`cicchetto/src/lib/theme.ts`'s `MOBILE_QUERY = (max-width: 768px)`.
Detection via `page.viewportSize()`, not `page.evaluate(matchMedia)` —
Playwright sets the viewport synchronously when the project picks the
device profile, so a synchronous read suffices and avoids a
round-trip-per-call.

### Test-isolation lesson

M9 (`/part` via X-button) destroys shared `#bofh` channel state as the
action under test. Pre-S5 it was the LAST chromium spec alphabetically
(`m1, m10, m11, m12, m2, ..., m9`), so chromium project completed before
the destruction mattered. Post-S5 the webkit-iphone-15 project runs
AFTER chromium and assumes `#bofh` still joined, which it isn't. The
old BUG7 RED-pin masked this — `selectChannel` failed at setup either
way, so nobody noticed `#bofh` was missing.

Fix: `joinChannel()` REST helper added to `cicchetto/e2e/fixtures/
grappaApi.ts`; M9 spec restores `#bofh` in `afterEach`. Suite is
order-independent again. Lesson generalised: **any spec whose action-
under-test mutates shared seed state must restore it in `afterEach`**.
The seeder sidecar sets initial state once per stack boot — it's not
re-run between specs.

### What did NOT change

  * The plan's hypothesis enumeration (a/b/c/d) stays in the spec
    header as the documented hypothesis surface for the eventual
    real-iOS investigation.
  * No production code changed in S5. The mobile scaffolding lives
    entirely in the e2e fixture layer.

---

## 2026-05-06 — Integration suite wired into GitHub Actions (S6)

`.github/workflows/integration.yml` runs `scripts/integration.sh`
on PRs and main pushes that touch `lib/**`, `cicchetto/src/**`,
`cicchetto/e2e/**`, `config/**`, `priv/**`, `mix.exs`, or `mix.lock`.
Doc-only / scripts-only / CI-only changes skip it (the existing
Elixir-only `ci.yml` workflow already covers unit-level gates on
every push). Failure uploads Playwright traces + HTML report as
14d artifacts so a regression investigation has the trace-viewer
input without a re-run.

### Why path-filtered, not run-on-everything

The integration job is the heaviest in the repo — cold image pull
(~6-8 min) + Playwright base + browser binaries. Running it on
README typo PRs burns CI minutes for no signal. The path filter is
the only-thing-changed boundary: if a PR touches no code, no infra,
no e2e fixtures, the suite has nothing to verify. The unit-level
`ci.yml` runs unconditionally and still catches everything else.

### Why `submodules: recursive`, not a deploy-key shape

The `azzurra-testnet` submodule URL is public
(`git@github.com:vjt/azzurra-testnet.git` resolves to the same repo
that responds 200 on HTTPS). `submodules: recursive` with the default
`GITHUB_TOKEN` succeeds via HTTPS-with-token. No deploy-key plumbing
or org-secrets dance needed. If the testnet ever moves private, the
fix is to provision a deploy key + switch to
`ssh-key: ${{ secrets.SUBMODULE_DEPLOY_KEY }}`.

---

## 2026-05-07 — CP15 event-driven window state model

cicchetto used to assume window state. POST `/channels` succeeded,
the sidebar entry appeared, the members pane fetched once via REST
and cached. When the assumption matched IRC reality (you joined a
channel and stayed in it) the UI was correct; when reality
diverged (invite-only refusal, kick, T32 park, WS reconnect race
that dropped the post-deploy `members_seeded` broadcast), the UI
silently lied. Members rendered empty, ghost windows pinned, the
compose box accepted text into channels we couldn't post in. The
optimistic STATE pattern was structurally incapable of representing
JOIN failure, KICK, or any future :parked transition; cic was the
source of truth for state cic could not actually observe.

CP15 moved the window-state machine to the server. `Grappa.Session.
Server` owns three sibling maps keyed on channel name —
`window_states %{channel => :pending | :joined | :failed | :kicked
| :parked}`, `window_failure_reasons` + `window_failure_numerics`
for `:failed`, `window_kicked_meta` for `:kicked`. State
transitions emit typed events on the per-channel topic
(`grappa:network:{net}/channel:{chan}`) with shapes
`kind: "joined" | "join_failed" | "kicked" | "members_seeded"`,
plus the pre-existing `kind: "message"` for persisted scrollback
rows. cic's `lib/windowState.ts` mirrors the server's three-map
split as three module-singleton signal stores;
`lib/subscribe.ts` dispatches each typed event to the matching
setter. The pre-B5 `loadMembers` REST verb went away entirely —
`members_seeded` fires on after_join AND on every upstream 366
RPL_ENDOFNAMES, so cic has no remaining reason to call
`GET /members`. `:parted` is intentionally NOT broadcast: cic
derives "key removed from `windowStateByChannel`" from the
existing `:part` presence message when `sender === ownNick`,
and the absence-key projects to the archive surface (B4) without
a parallel typed event.

### Two patterns this cluster pinned for project-wide reuse

**Wire modules.** B6 surfaced a Jason crash in
`Grappa.QueryWindows.broadcast_windows_list/2`: the function was
sending raw `%Window{}` structs over PubSub, and the struct
doesn't derive `Jason.Encoder`. `Phoenix.Socket.V2.JSONSerializer.
fastlane!/1` crashed at the WS edge during fan-out, the crash
dropped the user-channel process, and any subsequent
`close_query_window` push from cic landed on a dying ref and was
lost — explaining a long-suspected "DM windows you close stay
open server-side" bug that pre-dated CP15. Fix:
`Grappa.QueryWindows.Wire.render_grouped/1`, sibling to
`Grappa.Scrollback.Wire`. Both `broadcast_windows_list/2` (PubSub
side) and `GrappaWeb.GrappaChannel.push_query_windows_list/2`
(Channel push side) now delegate. The wire module pattern is now
the project's STANDARD for any context that emits over PubSub or
pushes over Phoenix Channels: contexts own the JSON-encodable wire
conversion; controllers + channels delegate. PubSub broadcast
payloads MUST be JSON-encodable. Raw `%Schema{}` structs over
PubSub are forbidden because the failure mode is a fastlane! crash
at the boundary, not a compile-time error or a unit-test
assertion miss.

**Synthetic sidebar rows keyed on windowState.** B6 also surfaced
the dual fact that `pendingChannelsForNetwork` (the projection
that emits a sidebar row for state == "pending" channels not yet
in `channelsBySlug`) had been written too narrowly: a failed JOIN
to an invite-only channel landed in `windowStateByChannel` as
`:failed` but never reached `channelsBySlug`, so the sidebar
rendered NO entry at all — directly contradicting the intent doc's
"Sidebar entry greyed/dim" rule. The fix renames the helper to
`pseudoChannelsForNetwork` and extends it to all four non-joined
states (`:pending`, `:failed`, `:kicked`, `:parked`). Same
projection: emit a sidebar row whenever `windowStateByChannel`
carries the key but `channelsBySlug` doesn't. The architecturally
load-bearing piece: the **sidebar projection's authoritative key
is `windowStateByChannel`, not `channelsBySlug`**. The live
channels list feeds into the projection but is one source among
several. New states (e.g. T32 `:parked` once the disconnect/connect
verbs land) inherit the synthetic-row + greyed-class treatment
mechanically as long as they go in `windowStateByChannel` —
they do not require touching the sidebar projection.

### Three bug-fix learnings

The B6 e2e matrix surfaced three pre-existing bugs that the unit
suite + browser smoke had been silently masking:

1. **Sidebar synthetic-row coverage** (commit `1c80907`). The
   projection was keyed too narrowly per the synthetic-rows
   pattern above; failed/kicked/parked windows whose channel never
   reached `channelsBySlug` had no sidebar row. The fix made the
   projection key on `windowStateByChannel` directly. Lesson:
   when state lives in two stores, the projection MUST key on the
   store that's authoritative for the question being asked. The
   sidebar projection's question is "what windows exist?"; the
   answer is `windowStateByChannel`, not the live-channels list.

2. **QueryWindows Jason crash** (commits `21c791e` + `3570d11`).
   See the wire-modules pattern above. Lesson: persisting a row
   does NOT auto-broadcast it; persisting a struct over PubSub
   does NOT auto-render it as JSON. Wire-shape conversion is a
   per-context responsibility, owned by the context, not implicit
   in `Phoenix.PubSub.broadcast/3`.

3. **`join_failed` notice silent on cic** (commit `595cd96`). The
   `apply_effects [{:join_failed, ...}]` arm persisted the failure
   reason as a `:notice` scrollback row but only broadcast the
   typed `kind: "join_failed"` event — never the wire-shape
   `kind: "message"` event for the persisted notice. cic's
   `loadInitialScrollback` is `loadedChannels`-gated (once-per-
   channel), so the notice landed in the DB but never in the live
   scrollback view unless the user reloaded the page. Fix:
   broadcast `Wire.message_payload/1` in the `:join_failed` arm
   too. Lesson: typed window-state events and persisted message
   events are PARALLEL channels in the wire contract; every
   `:persist` effect must be paired with a `kind: "message"` push
   if the row needs to land in the LIVE scrollback view (vs. a
   cold reload).

### Stale-bundle reload gotcha

Browser smoke after the B6 deploy initially reproduced the kicked-
sidebar bug — synthetic row missing — even though the deploy had
landed cleanly server-side. Root cause: the prod tab held the
pre-deploy bundle (`index-Tsa4Tfom.js`) instead of the post-deploy
bundle (`index-CiYQNUz0.js`). Asset-hash cache-busting works for
fresh sessions but not for already-open tabs. Mitigation: hard-
reload the prod tab post-deploy before browser smoke. Captured in
`feedback_cicchetto_browser_smoke` memory + flagged in CLAUDE.md's
Per-bucket cadence note.

### Deferred: parked (T32) flow + the one flake

The parked-state e2e (`cp15-b6-parked.spec.ts`) is BLOCKED on T32:
flipping `connection_state: "parked"` requires the PATCH
`/networks/:slug` REST surface + cic's `/disconnect` / `/connect`
ComposeBox arms, both of which land in the `channel-client-polish`
cluster (`project_t32_disconnect_verb` memory). The synthetic-row
+ greyed-class treatment is already in place for `:parked` — the
e2e is the only missing piece, and it's a mechanical addition once
T32 ships.

`cp15-b6-pending-to-failed-invite-only.spec.ts` passes on retry #1
every time but flakes once on the first attempt — a sub-second
race between the synchronous `setPending` fire and the typed
`join_failed` broadcast arriving back over WS. Same render code
path is reliably green via `cp15-b6-kicked.spec.ts` AND verified
by prod browser smoke on `#services` / `#operhelp`. Followup
filed in todo.md "B6 follow-up": tighten the wait_for sentinel on
the typed event vs. relying on render-tick timing.

---

## 2026-05-08 — CP17 server-side-pending cluster

Theme 2 of the 2026-05-08 architecture review. Closes the CLAUDE.md
hard-invariant violation "cic NEVER originates state — no parallel
client-side state machine."

Pre-CP17 the only cic-originated state mutation in the codebase was
`cicchetto/src/lib/compose.ts:210`'s synchronous
`setPending(channelKey(networkSlug, cmd.channel))` call, fired
immediately after `postJoin(...)` so subscribe.ts:425's
pre-subscribe loop could join the per-channel WS topic BEFORE the
upstream JOIN echo arrived. Without the optimistic write, Phoenix
PubSub doesn't replay to late subscribers and the typed `joined`
/ `join_failed` events would drop on the floor.

The chicken-and-egg behind the workaround: cic only learns to
subscribe to the per-channel topic AFTER seeing `:pending` in
`windowStateByChannel`. Broadcasting `:pending` on the per-channel
topic itself is impossible — cic isn't subscribed yet.

Resolution: broadcast on `Topic.user/1`, which cic joins from boot
via `userTopic.ts`'s `createRoot` effect. New verb
`Grappa.Session.Wire.window_pending(slug, channel)` returns
`%{kind: "window_pending", network: ..., channel: ...,
state: "pending"}`. Naming convention `window_pending` (not bare
`pending`) mirrors the existing user-topic
`connection_state_changed` verb: state-change events on the
user-topic carry a window-namespace prefix to avoid collision with
channel-namespace verbs that share state names (`joined` etc.).

Single producer for both code paths: `record_in_flight_join/2`
(already called from `{:send_join, ch}` cast AND the 001
RPL_WELCOME autojoin loop) wraps the state mutation
(`window_states[ch] = :pending`) AND the user-topic broadcast.
Same call sites, identical behavior.

### Snapshot path: `:pending` is intentionally `:not_tracked`

`get_window_state` / `push_window_state_if_known` returns
`{:error, :not_tracked}` for `:pending`. The per-channel
after_join can't deliver new info — cic already learned `:pending`
via the user-topic broadcast — and would carry a different `kind:`
than the user-topic origin (the per-channel topic broadcasts use
`joined / join_failed / kicked` for terminal states). Documented
design choice.

### Idempotency rule: re-JOIN of an already-`:joined` channel

A JOIN issued for a channel ALREADY in `:joined` is a no-op state
transition. `record_in_flight_join/2` skips the `:pending` mutation
+ the broadcast in that case so connected cic tabs don't briefly
flip from `:joined` back to `:pending`. The in-flight entry is
still recorded — a downstream failure numeric (e.g. 443
ERR_USERONCHANNEL) needs correlation against the in-flight window.

Surfaced by integration suite m11-peer-nick failure on initial
ship: cp15-b6-part-archive-rejoin's afterEach hook re-joins #bofh
defensively, server.window_states[#bofh] was downgraded to
`:pending` over the existing `:joined`, bahamut may not echo a
JOIN at all for a re-JOIN, leaving state stuck. cic next-test
boot then renders MembersPane "not joined" fallback even though
peer JOIN events fan in to `members()`.

### cic-side mirror

* `lib/api.ts` — `WireUserEvent` discriminated union extended
  with `window_pending` arm. tsc enforces exhaustiveness via the
  `assertNever` default in `userTopic.ts`'s switch.
* `lib/userTopic.ts` — `case "window_pending"` arm dispatches to
  `setPending(channelKey(network, channel))`. Same setPending
  signal as pre-CP17; the pre-subscribe loop in `subscribe.ts:425`
  re-runs on the windowStateByChannel signal mutation regardless
  of who calls setPending — origin-decoupled by design.
* `lib/compose.ts:210` — the optimistic `setPending(...)` call
  REMOVED. compose no longer originates window state.

### Gate evidence on cluster close

```
scripts/check.sh — EXIT 0
  7 doctests, 26 properties, 1285 tests, 0 failures
  Total errors: 0
  No vulnerabilities found
  No retired packages found
  Sobelow SCAN COMPLETE
  ExDoc clean (no new doc warnings)
scripts/dialyzer.sh standalone — Total errors: 0
scripts/bun.sh run check — biome + tsc clean (82 files, 0 errors)
scripts/bun.sh run test — 634 passed (634), 38 test files
scripts/integration.sh — EXIT 0, 28 passed (2 pre-existing flakes)
```

Architecture-review themes status:
* Theme 1 (wire-discipline-sweep) — closed CP16 (2026-05-08).
* Theme 2 (server-side-pending) — closed CP17 (2026-05-08, this
  cluster).
* Theme 3 (`Session.Server.WindowState` extraction) — next-up
  candidate. Mechanical now that Wire modules + `:pending` are
  pervasive on the server.

---

## 2026-05-08 — CP16 wire-discipline-sweep cluster

CP15 B7 elevated to a CLAUDE.md hard invariant: "PubSub broadcast +
Channel push payloads MUST be JSON-encodable — convert structs to
wire shape via a context-owned `*.Wire` module." Sibling Wire
modules (Scrollback, Networks, Accounts, QueryWindows) all upheld
the rule; the 2026-05-08 architecture review found three contexts
that didn't and three stale typespecs that lied about the wire
shape post-CP15 B6.

Six buckets, each TDD + per-bucket `scripts/format/credo/dialyzer`:

  * **B1** — `Grappa.Session.Wire` extracted. Nine event payloads
    (`channels_changed`, `own_nick_changed`, `topic_changed`,
    `channel_modes_changed`, `members_seeded`, `joined`,
    `join_failed`, `kicked`, `away_confirmed`, `mentions_bundle`)
    moved from inline maps in `Session.Server` apply_effects arms
    + `maybe_broadcast_*` helpers + `grappa_channel.ex`
    push-after-join helpers into one Wire fn per `kind:`.
    `Session.Server.window_state_payload/3` (snapshot path)
    collapses to one-line Wire delegations so snapshot +
    event-time payloads are LITERALLY the same expression.
    `mentions_bundle/5` absorbs the per-message projection
    (server_time, channel, sender_nick, body, kind) including the
    Atom.to_string conversion on `Message.kind()`.
  * **B2** — `Grappa.Visitors.Wire` extracted. `visitor_to_json/1`
    (full {id, nick, network_slug, expires_at}) +
    `visitor_to_credential_json/1` (credential-exchange shape).
    Both EXCLUDE `:password_encrypted` (the post-Cloak-load
    plaintext upstream NickServ password — same risk class
    `Networks.Wire` was created to prevent). MeJSON + AuthJSON
    delegate; the LoginResponse/MeResponse drift on `:expires_at`
    becomes EXPLICIT through two Wire fns (mirror of
    `Accounts.Wire`'s {full, credential} pattern).
  * **B3** — `Networks.broadcast_state_change/4` inline payload
    moved to `Networks.Wire.connection_state_changed_event/4`.
    The codebase-review-fixes 2026-05-08 H1 fix was the bug fix
    (raw `broadcast/3` → `broadcast_event/2`); this is the
    consistency follow-through.
  * **B4** — three stale typespecs caught up (lib/grappa/query_windows.ex:84
    + :40 moduledoc + lib/grappa_web/channels/grappa_channel.ex:163,
    all declared `[Window.t()]` instead of `Wire.windows_map()` post-CP15
    B6). Atom-vs-string `kind:` consistency: `Scrollback.Wire.message_payload/1`
    switched from `kind: :message` to `kind: "message"`; the wire-byte
    shape is unchanged (Jason atom→string), but server-side discriminator
    type is now consistent across every Wire fn.
  * **B5** — cic-side `WireUserEvent` discriminated union added in
    `cicchetto/src/lib/api.ts` covering all 6 user-topic events
    (channels_changed, query_windows_list, mentions_bundle,
    away_confirmed, own_nick_changed, connection_state_changed).
    `QueryWindowEntry` + `MentionsBundleMessage` typed exports added.
    `userTopic.ts` rewrites the if-else cascade as a switch
    statement with `assertNever(payload)` exhaustiveness — same
    pattern as `ScrollbackPane`'s `MessageKind` switch (CP10 C3).
    Every `as string` / `as number` / `as ... | null` cast removed.
  * **B6** — full `scripts/check.sh` + standalone dialyzer + cic
    biome+tsc + vitest + integration suite (Playwright e2e).

The cluster touched no behavior; consistency-only. Six HIGH
findings closed across the 2026-05-08 architecture review +
codebase review (A1 abstraction-boundaries, A2 responsibility,
A3 visitor wire shape, A4 stale typespecs, A7 server↔client
typing, A8 mentions_bundle, plus the H1 connection_state Wire
follow-through + Type-system A1 atom-vs-string).

### Recurring lesson — directions over code

Five separate arch-review concerns surfaced the same wire-discipline
gap from different angles. The CP15 B7 invariant landed in CLAUDE.md
faster than in code; consumers kept building inline payloads
because the surrounding code did. "Total consistency or nothing"
(CLAUDE.md) is the principle that closes this drift; CP16 promotes
the invariant from prose to function-level enforcement.

The next two architecture-review themes (Theme 2
`server-side-pending`, Theme 3 `Session.Server.WindowState`
extraction) are deliberately scoped to subsequent clusters — they
need design discussion, not a typespec sweep.

---

## 2026-05-08 — CP18 bnd-A2 close + scroll-on-window-switch

Two clusters this session, neither part of an arc — bnd-A2 was a
single-target audit-row close (the LAST HIGH OPEN architecture row);
scroll-on-window-switch was a user-reported bug surfaced at end of
session.

### bnd-A2 — slug→Network canonical helper

Pre-fix `cicchetto/src/lib/compose.ts` re-derived `network_id` from
the slash-command's `networkSlug` arg via the literal pattern
`networks()?.find((n) => n.slug === networkSlug)?.id` — repeated **14
times** across channel-ops + DM verb handlers. Each call site
re-implemented the lookup, opening the door to silent divergence
(different default for missing slug, different fallback behavior).

Resolution: extract canonical helpers in `cicchetto/src/lib/networks.ts`
backed by a `createMemo` Map keyed on `n.slug`:

- `networkBySlug(slug: string): Network | undefined` — full record
  lookup (futureproofing — e.g. nick lookup by slug is now free).
- `networkIdBySlug(slug: string): number | undefined` — id-only
  convenience over `networkBySlug`.

The memo invalidates whenever the underlying `networks` resource
updates (post-/connect, post-/disconnect, bearer rotation), so callers
see new entries without manual cache management. O(1) lookup vs the
14× O(n) repeated linear scan; n is small (1-7 in practice) so the
performance delta is irrelevant — the win is single-source-of-truth
for slug→Network projection.

Three options weighed before committing: (A) pure helper, (B)
Map-keyed memo + helper [chosen], (C) push `network_id` resolution UP
into `slashCommands.ts` dispatch [larger scope, deferred]. Option B
mirrors the cluster #13 M4 (`networkKey` / `decodeChannelKey`) + M7
(`target_kind/1`) public-helper-promotion pattern. The /quit handler's
`networks() ?? []` enumeration kept (full-list iter, not slug-keyed —
out of scope).

Helper signatures take `slug: string` (NOT `string | null`) because
all 14 call sites hand a guaranteed-string from the
`submit(_, networkSlug: string, _)` arg. Per CLAUDE.md "Don't add
error handling for scenarios that can't happen," no nullable widening.

**Apply rule:** when you find a literal pattern repeated 3+ times
across one file's verb handlers, the right intervention is a canonical
helper at the data-source module — not a per-call utility, not a
dispatch-time refactor. Memo-backed Map is the standard shape when the
projection is over a reactive resource. Mirror cluster #13 M4/M7's
verb-promotion convention.

**Audit closure:** bnd-A2 LANDED → architecture HIGH OPEN count = 0
(codebase HIGH count went to 0 in cluster #15). After this commit, all
remaining 72 OPEN rows are MEDIUM/LOW.

### scroll-on-window-switch — DOM-reuse race in ScrollbackPane

User reported: opening an empty query window left scrollTop=0;
switching back to a populated channel kept the channel pinned at the
top.

Root cause: the `[data-testid="scrollback"]` `<div>` is the SAME DOM
node across `selectedChannel` changes. Solid's `<Show>` in `Shell.tsx`
is non-keyed, so the element is reused, not rebuilt. Pre-fix the
length-effect at `ScrollbackPane.tsx:583` only fired when
`messages().length` changed — re-selecting a previously-loaded channel
never re-snapped because length was stable. The query window left
`scrollTop = 0`; the shared `<div>` carried that value into the
channel render.

Fix: extend the existing on-key effect (which already resets banner +
markerScrolled) to ALSO snap scroll position. Branch on unread-marker
presence:

- **marker exists** → `scrollIntoView({ block: "center" })` —
  user spec is "putting the unread messages more or less in the
  middle of the screen, and if no unreads then scroll to bottom."
- **no marker** → snap `scrollTop` to `scrollHeight` (tail).
  Auto-follow takes over after the first append.

Companion change: the length-effect's marker branch (the OTHER mount
path, where the REST page lands AFTER focus) ALSO moves
`block: "start"` → `block: "center"`. Without this, switch-back
centers the marker but initial-focus pinned it to the top — asymmetric
UX is worse than no fix at all.

`atBottom` is set to `true` on the no-marker branch (or recomputed via
the threshold check on the marker branch) so the floating "scroll to
bottom" button doesn't flash visible mid-switch.

**Apply rule:** when a Solid `<Show>` boundary doesn't use `keyed`,
the DOM element under the conditional is REUSED across condition
changes. Per-render-cycle effects keyed on signal IDENTITY (length,
ref) won't fire on logical-state transitions that don't change those
signals. Add an explicit effect on the LOGICAL key (channel `key()`)
so DOM state under the boundary gets reset to the new context's
expectations. The component's internal signals reset on key change;
the DOM doesn't unless you tell it to.

Two e2e specs in `cicchetto/e2e/tests/scroll-on-window-switch.spec.ts`
pin both branches: bug repro (channel → empty query → channel-back,
asserts distFromBottom ≤ SCROLL_BOTTOM_THRESHOLD_PX) + marker-centered
geometry (asserts marker top sits in 0.20..0.80 of container height —
stronger than cp14-b1's `toBeInViewport()`). Both passed first try
(305ms + 269ms).

---

## 2026-05-09 — CP19 T32 parked-window: derive cic cascade from network connection_state

CP15 B6's brief promised a `cp15-b6-parked.spec.ts` was "mechanically
authorable now" — wrong on the producer side. CP18 flagged the gap;
CP19 picks it up.

**The verified gap (2026-05-09):** `Networks.disconnect/2` terminates
`Session.Server` via `DynamicSupervisor.terminate_child/2`. The
GenServer dies; `state.window_states` evaporates. **No per-channel
`:parked` event ever fires.** cic receives the user-topic
`connection_state_changed → :parked` event and updates
`networkBySlug[slug].connection_state = :parked`, but the per-window
sidebar rows for channels under that network stay visually normal —
`windowStateByChannel` still has them as `:joined` (last value before
the GenServer died). Net: today /disconnect leaves the cic UI looking
fully connected across every channel under the parked network.

**Two design options weighed in
[`docs/plans/2026-05-09-t32-parked-window.md`](plans/2026-05-09-t32-parked-window.md):**

- **Q1.A — emit per-window `:parked` from Session.Server `terminate/2`.**
  Pro: cic's existing `windowStateByChannel` model handles it; symmetric
  with `:joined`/`:failed`/`:kicked`. Con: `terminate/2` running broadcast
  logic during shutdown is fragile; per-channel topic goes silent on
  park (no replay for offline cic).
- **Q1.B — derive parked from `connection_state == :parked`.** cic reads
  `networkBySlug[slug].connection_state` first; when ∈ {:parked, :failed},
  treat every window for that network as visually parked. Zero
  server-side change; one conditional in the rendering helper, two
  visual scopes (network header + per-channel rows).

**Decision: Q1.B (derive).** Aligns with the foundation rule "Don't
duplicate state that already exists — derive it." `connection_state`
is the single source of truth. cic's per-window rendering becomes a
function of (window state, network connection state).

The derivation rule, codified:
```
window-effective-state(window) =
  if window.network.connection_state ∈ {:parked, :failed} then greyed
  else windowStateByChannel[window.key] ?? :joined-implied
```

`Sidebar.tsx::isGreyed/2` consults `networkBySlug[slug].connection_state`
FIRST. New `isNetworkGreyed(slug)` drives `.sidebar-network-greyed` on
the network `<section>`. CSS cascades to `.sidebar-window-btn` via
co-qualified `.sidebar-network.sidebar-network-greyed li
.sidebar-window-btn` (specificity (0,2,1) matches the existing base
rule's; without the co-qualifier biome flags `noDescendingSpecificity`
AND the override silently loses to the base rule). `ComposeBox.tsx`
mirrors the same network-derivation overlay.

**Q2 — per-network overlay vs per-channel?** BOTH apply naturally
under derivation. Network-row gets `.sidebar-network-greyed`; per-
channel rows under it cascade via the qualified CSS. ONE conditional
in the rendering helper, not a parallel state map. Per CLAUDE.md
"lightweight over heavyweight."

**Q3 — wake on `Networks.connect/1` — Bootstrap restart latency vs
eager spawn?** Resolved by code inspection: `NetworksController.connect/2`
already does eager spawn via `SpawnOrchestrator` on the same HTTP
round-trip (no Bootstrap restart needed). The post-`/connect` flow:
network ungreys immediately on user-topic event; channels ungrey
once autojoin completes (typically <1s) via existing typed window-state
events flowing through `subscribe.ts`.

**Wire shape extension.** Cic's `userTopic.ts` already calls
`refetchNetworks()` on `connection_state_changed` — but the
`network_with_nick_json` shape didn't carry T32 fields, so the refetch
returned the same shape and cic had nothing to derive from. CP19
extends `Wire.network_with_nick_to_json/3` to take the credential as a
third arg and surfaces `connection_state` + `connection_state_reason`
+ `connection_state_changed_at` on `GET /networks` for user subjects.
Live-vs-configured nick stays separate (BUG1-FIX
`resolve_network_nick/2`); T32 fields come straight off the credential
row of record (DB-persisted user intent, no divergence from runtime).

**Reason rendering.** Network-header `title=` attr (zero-bundle-cost).
Richer tooltip deferred to a follow-up if vjt wants it.

**E2E coverage.** `cicchetto/e2e/tests/cp15-b6-parked.spec.ts` covers
JOIN→/disconnect→assert greyed network+rows+ComposeBox + tooltip;
/connect→assert ungrey network immediately, channels post-autojoin.
The afterEach reconnect-then-poll cleanup pattern is new: the testnet
doesn't reset between specs, and a parked credential cascades 18
downstream failures across m1-m9 + cp15-b6-* without it. The poll
budget is 30s × 500ms intervals; test timeout bumped to 90s to absorb
the cleanup wait.

---

## 2026-05-10 — operator-action-echo unread suppression

**Bug.** `/msg <nonexistent-nick> hi` triggered a phantom "1 unread
message" marker and a sidebar badge bump on the operator's own query
window. Visible live in the browser before the fix.

**Trace.** Server-side: `Session.Server.handle_numeric_with_routing/2`
(CP13) routes 401 ERR_NOSUCHNICK via `NumericRouter` →
`{:query, ghost}`, persists a `kind: :notice` row at `channel=ghost`
with `meta = %{numeric: 401, severity: :error}`, broadcasts via
`Wire.message_payload/1`. Client-side: `subscribe.ts` `routeMessage`
treated `:notice` as an unread-bumping content kind (line 216) and
`ScrollbackPane.rows()` independently counted any
`server_time > readCursor` row toward the in-pane unread-marker — both
saw the 401 row and surfaced it as "unread."

**Domain class.** Same as the BUG5b own-presence-event suppression: a
server-originated row that exists *because of the operator's own
action*. The operator already saw the action that produced the
feedback; alerting them is a false positive. Adding more rules on the
client would scale poorly — the wire already carries the
discriminator.

**Discriminator: `meta.numeric` presence.** Set iff the row was
produced by `handle_numeric_with_routing/2` (no other writer touches
that key today; the closed-set guarantee comes from the single
production site). A peer-originated NOTICE (NickServ greeting,
another user's `/notice`) lands with empty `meta` — STILL bumps unread,
correctly.

**Severity-agnostic gate.** Error numerics (4xx/5xx) and info numerics
(305/306 RPL_(UN)AWAY etc.) are all operator-action feedback. The
predicate gates on field presence, not severity.

**Single predicate, two call sites.** `cicchetto/src/lib/
operatorActionEcho.ts` exports `isOperatorActionEcho(message)`.
Subscribed by `subscribe.ts` (sidebar badge gate, mirrors BUG5b
own-presence early return) AND by `ScrollbackPane.tsx` `rows()` memo
(in-pane unread-marker count `.filter(...)`). Both signals stay
aligned by construction — adding a future "operator-action echo"
class (e.g. labeled-response routed message kind) extends one
predicate, not two.

**Why not a server-side filter.** The server CORRECTLY persists the
401 row + broadcasts it — the operator must SEE the failure inline
in the query window. The bug is the unread-treatment, which is a
client concern. CLAUDE.md "client-side only read position" invariant
keeps the gate where it belongs.

**E2E coverage.** Extended the existing CP13 S5 caveat spec
(`cp13-server-window.spec.ts:142`) — same `/msg <ghost>` flow
that was already verified for the 401 row appearing — with new
`unread-marker count = 0` and sidebar message badge `count = 0`
assertions on the routed query window. vitest unit coverage:
`subscribe.test.ts` (numeric notice no-bump + plain notice DOES bump
symmetry), `ScrollbackPane.test.tsx` (marker excluded from numeric
count + included for peer notice), `operatorActionEcho.test.ts`
(predicate edge cases incl. defensive non-numeric meta.numeric
branch).

## 2026-05-10 (b) — operator-action-echo carve-out for $server window

**Regression.** CP20's blanket `meta.numeric` predicate also
suppressed legitimate unread bumps for numerics routed to the
**`$server` window**. The CP13 S8 e2e
(`cp13-server-window.spec.ts:80` "$server window surfaces unread
message badge after live numeric arrives") went RED on the post-CP20
push: `/away` → server replies 306 RPL_NOWAWAY → routed to `$server`
as `:notice` with `meta.numeric=306, severity=:ok` → predicate fired
→ no badge. CI integration job FAILED on `0db7eef` (the CP20 close
commit itself); CP20 close-out misclassified the failure as testnet
flake without per-spec verification.

**Root cause = boundary error.** The CP20 design conflated two
shapes of "row produced by my action":
1. Routed to a window the operator already inhabits (or just
   created: ghost DM window after `/msg ghost`) — this IS echo;
   alerting them is a false positive.
2. Routed to `$server` (the per-network server-messages window) —
   this is NOT echo: the window EXISTS to surface routed server
   output. Suppressing it silences the very signal the window is
   built to render.

The discriminator is the **routing target**, not the row's
`meta.numeric` shape alone. CP20's "yes all" answer to "all
numerics or only error?" was right WITHIN scope (the original
401-ghost case) but wrong outside it.

**Predicate refinement.** One extra clause: `if (message.channel
=== SERVER_WINDOW_NAME) return false;`. The 401-ghost case still
fires (lands in the new ghost-nick query window, NOT $server). The
306-to-$server case stops firing. CP20's two-call-site shape (badge
+ marker) survives unchanged.

**Refactor: extract `SERVER_WINDOW_NAME` constant.** The literal
`"$server"` was duplicated 6+ times across `compose.ts`,
`subscribe.ts`, `Sidebar.tsx`, `BottomBar.tsx`. Adding a 7th call
site (the predicate carve-out) on a magic string violated CLAUDE.md
"Implement once, reuse everywhere." Promoted to
`cicchetto/src/lib/windowKinds.ts` (the natural neighbor — same
module owns the `WindowKind` discriminated union the cic-side
window-shape cluster lives on). Drift between the cic literal and
the server-side `{:server, nil}` fanout was only theoretical so
far, but the constant pins it. Tests still use the literal in
fixtures (test-data, not logic).

**Lessons.**
- **Don't claim LANDED on partial-CI evidence.** CP20 close-out
  attributed the integration FAILURE to "testnet meltdown" without
  inspecting the named failed spec — and S8 was a real semantic
  regression, not a flake. Memory `feedback_landed_claim_evidence`
  exists for exactly this.
- **`meta.shape` ≠ "produced by my action."** Wire-shape carries
  *production-site* info; *destination* requires a separate read.
  The CP20 predicate took a shortcut that elided the destination
  axis. The fix restores it.
- **Magic strings are infrastructure liabilities.** A 7th call
  site forced the refactor — the right time to extract a constant
  is when adding a new use, not "later." The 6 call sites were
  already a smell; this fix paid the debt.

---

## 2026-05-10 (c) — channel-client-polish: spec #5 + spec #2 (WHOIS) shipped

Audit of the channel-client-polish backlog (memory
`project_channel_client_polish.md`'s 21 specs) reclassified the
remaining work using the actual code on `main`:

- 16 SHIPPED (incl. #1 DM auto-open — which a stale orchestrate-next
  pointer claimed was MISSING; verified shipped at `subscribe.ts:396`
  + 3 vitest + `m4-irssi-to-priv-no-window.spec.ts`).
- 2 PARTIAL: #5 (left-click NOT wired; right-click submenu shipped),
  #2 (push helper landed; server handler + numeric routing + render
  surface all missing).
- 3 NOT-STARTED: #14 /who+/names, #15 /list, #16 /links — parser
  stubs only.

Bundled #5 + #2 in one cluster (`cluster/whois-and-nickclick`) since
both touch the same UserContextMenu / ScrollbackPane surface and
neither needs a migration.

### #5 — left-click on member-list nick → DM

Lifted the existing UserContextMenu "Query" submenu verb body
(`openQueryWindowState` + `setSelectedChannel`) onto an `onClick`
handler in MembersPane's nick `<li>`. Both entry points (left-click
and right-click submenu) now compose the same store mutations —
single code path, two doors per CLAUDE.md.

Side-effect: biome's `useKeyWithClickEvents` a11y rule rejects bare
`<li onClick>` (lists are non-interactive per WAI-ARIA). Refactored to
`<li><button class="member-name">…</button></li>`, lifted the click
handlers to the `<button>`, styled the `<button>` to look like the
former `<li>` (transparent bg, no border, font:inherit). Tests now
query `.member-name` instead of bare `.member-op` / `.member-voiced`.

### #2 — /whois end-to-end

Mirror of the `mentions_bundle` pattern (CP15 B7 / CP16 B5 contract):
per-target accumulator on `state.whois_pending`, drained on 318
RPL_ENDOFWHOIS into a `Wire.whois_bundle/3` payload broadcast on
`Topic.user/1`. Render is a per-network ephemeral `WhoisCard.tsx`
inline at the top of the active window's scrollback.

**Why ephemeral, not scrollback-persisted** (decision rationale):
- WHOIS data goes stale fast (idle counter, mode flag, channel list
  all snapshot-at-instant). Persisting would surface stale state to
  the user every time they re-focus the window.
- Storing 8 fields × every WHOIS the user runs would bloat scrollback
  with low-signal rows. The user typed /whois because they want the
  answer NOW, not later.
- Replaying a stored bundle makes no sense — the user wants the
  current snapshot, not "what alice's idle was 6h ago".

The render decision (inline card above scrollback, NOT a modal, NOT
in $server window) follows spec #2 explicit instruction. cic's
`whoisCard.ts` keeps one bundle per network (replaces in place on
each /whois) — a per-network single-card surface matches how the user
issues these (one query → one answer → done).

**Why `dispatch_ops_verb`** (the user-only short-circuit) for the
`handle_in("whois", …)` clause: WHOIS is read-only and visitors
*could* issue it semantically, but the current channel-handler shape
keys off `{:user, user.id}` and visitor sessions don't reach the
session by that subject discriminator. Visitors get a quiet
"unauthorized" reply on `/whois`; if a future cluster wants visitor
WHOIS, the handler would need a `{:visitor, id}` arm and the bundle
would need to broadcast on the visitor's `subject_label` topic.
Out of MVP scope.

### Foundational pattern for future info-verbs

The same shape (delegated-numeric → per-target accumulator → 318-class
end-marker → ephemeral Topic.user broadcast → cic narrowUserEvent +
per-network store + render component) is now the template for #14
(/who 352/315), #15 (/list 321/322/323), #16 (/links 364/365).

`Grappa.Session.NumericRouter`'s `@delegated_numerics` set was already
pre-seeded with all of 311-319, 352, 315, 353, 366, 321-323, 364-365,
375-376 — those numerics short-circuit the `:server` route so they
don't double-persist. The delegated handler responsibility is now to
emit the bundle effect rather than just stub the path.

### Lessons

1. **Audit-summary staleness** — orchestrate-next prompts that
   transcribe an audit summary go stale faster than the codebase. At
   /start, re-grep for the artifacts the prompt names: if
   `subscribe.ts:396` already calls `openQueryWindowState`, the "this
   is missing" claim is wrong. Memory `feedback_survives_clear_pointer
   _staleness` extended with this corollary.
2. **`<li>` is non-interactive per WAI-ARIA** — wrap with `<button>`
   for click handlers. Don't add `tabIndex={0}` to non-interactive
   elements; biome rejects it as `noNoninteractiveTabindex`.
3. **`@typep verb` in IRC.Client is closed-set** — every new
   `Client.send_X/N` MUST extend the verb union or `reject_invalid_line(:X)`
   becomes a dialyzer contract violation. Same for the corresponding
   `Session.send_X/N` facade's `@spec` on the `{:error, :invalid_line}`
   arm — dialyzer prunes it as extra_range if the validator always
   succeeds. The pre-validator path needs the failure leg present.

---

## 2026-05-12 — CP24 bucket A: post-cr-review CRITICAL trifecta (C1+C3 fixed, C2 disputed)

Codebase review 2026-05-12 (commit `408b392`) flagged 3 CRITICAL findings.
Bucket A landed C1 (SASL credential leak in pre-handshake phases) and C3
(visitor WHOIS broken); C2 (SQLite `PRAGMA foreign_keys` never enabled in
dev/prod) was contradicted by live-container probe and downgraded to
NON-FINDING.

### C1 — SASL phase guard

`lib/grappa/irc/auth_fsm.ex:232-234`. The `step/2` clause for
`%Message{command: :authenticate, params: ["+"]}` was matched
UNCONDITIONALLY for any phase below `:registered` (the existing
`:registered` catch-all at line 227 only absorbed the post-handshake
case). A hostile / buggy / MitM upstream could elicit a verbatim SASL
credential reply BEFORE SASL had been negotiated by sending
`AUTHENTICATE +` while the FSM was in `:pre_register` /
`:awaiting_cap_ls` / `:awaiting_cap_ack`. Under Phase-1
`verify: :verify_none` the leak was network-exploitable.

Fix: pin the AUTHENTICATE-`+` clause on `phase: :sasl_pending` (the
only legitimate phase per the IRCv3 SASL spec); add a catch-all
`%Message{command: :authenticate}` clause that absorbs stray
pre-handshake AUTHENTICATE lines silently, mirroring the
post-`:registered` absorption. 4 regression tests added to
`test/grappa/irc/auth_fsm_test.exs` (one per non-`:sasl_pending`
phase × stray AUTHENTICATE +; plus a control verifying the legitimate
`:sasl_pending` reply still fires).

### C3 — Visitor WHOIS dispatch carve-out

`lib/grappa_web/channels/grappa_channel.ex:445-454`. The "whois"
`handle_in/3` clause comment EXPLICITLY flagged the bug
("`dispatch_ops_verb` IS used to short-circuit the visitor path —
but that's wrong for WHOIS; use the user-only form-and-call helper
instead") but the implementation used the rejected path. Visitors
issuing `/whois <nick>` got `{:error, %{reason: "visitor_not_allowed"}}`
despite the documented carve-out (visitors ARE allowed read-only
verbs that broadcast on the visitor's own subject_label topic).

Fix: factored a new `dispatch_subject_verb/2` helper that mirrors
`dispatch_ops_verb/2` but resolves the socket's identity into a
`t:Grappa.Session.subject/0` tagged tuple — `{:user, id}` for an
authenticated user (loaded via `safe_get_user/1`), `{:visitor, id}`
for a visitor (id extracted from the `"visitor:<uuid>"` user_name
assigned by `UserSocket.connect/3`). The thunk receives the subject
and dispatches to the existing `Session.send_whois/3` facade which
already accepts `subject()`. Reject path is `{:error, :no_session}` —
visitors without a live `Session.Server` get the same surface as user
sockets do, NOT the `visitor_not_allowed` carve-out. 3 regression
tests added to `test/grappa_web/channels/grappa_channel_test.exs`
(visitor with live session sends WHOIS upstream; visitor without
session returns `no_session`; CRLF nick rejected as `invalid_line`).

### C2 — FALSE FINDING (FK pragma already ON)

The original C2 finding claimed `PRAGMA foreign_keys = OFF` in
dev/prod, with the consequence that 23 migrations' worth of
`references(..., on_delete: ...)` were runtime-dead. Live-container
probe (2026-05-12 bucket A pre-fix) contradicted this:

```
iex> Grappa.Repo.query!("PRAGMA foreign_keys").rows
[[1]]

iex> Grappa.Repo.query!("INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES ('deadbeef-...', '00000000-...', '2026-05-12 ...', '2026-05-12 ...')")
** (Exqlite.Error) FOREIGN KEY constraint failed
```

Root cause of the false finding: `deps/exqlite/lib/exqlite/pragma.ex:52`
defaults `:foreign_keys` to `:on`; `deps/ecto_sqlite3/lib/ecto/adapters/sqlite3.ex:85`
explicitly documents *"`:foreign_keys` — we set it to `:on`, for
better relational guarantees. This is also the default of the
underlying `Exqlite` driver."* The reviewer (and the persistence
draft) read "SQLite ships with PRAGMA foreign_keys = OFF" as the
runtime default and missed the adapter-side connection-init override.

The `validate_subject_exists/1` pre-flight checks in
`Accounts.create_session/4`, `QueryWindows.open/4`,
`UserSettings.get_or_init/1` exist for a SEPARATE, REAL ecto_sqlite3
limitation: the engine returns the FK constraint NAME as `nil` so
`Ecto.Changeset.assoc_constraint/3` cannot pattern-match the raised
exception to produce a clean changeset error. The pre-flight produces
the changeset error before the insert raises; the FK constraint is
the backstop on TOCTOU. The existing source comments at
`lib/grappa/accounts.ex:179-189`, `lib/grappa/query_windows.ex:228-239`,
`lib/grappa/user_settings.ex:76-81` already describe this correctly
(they say "a concurrently-deleted user / visitor would still trip
the DB FK as a backstop" — which is true, FK enforcement IS on).
No source edits required.

Bucket A action: docs-only correction across compiled review doc +
persistence draft + CP24. Persistence/S7's "without S1 fixed there
is NO backstop" framing also wrong — re-validate at bucket B.
CRITICAL tally drops from **3 to 2**.

### Lessons

1. **Probe before code.** When a finding cites runtime behaviour
   ("PRAGMA X = OFF in dev/prod"), validate against the running
   container BEFORE designing the fix. A 30-second `Grappa.Repo.query!`
   would have caught C2 at the review-write phase. Memory
   `feedback_orchestrator_autonomy` already warns "HALT on big
   architectural deviations" — adding "HALT when finding contradicts
   probe" as a corollary.
2. **Adapter defaults matter.** Two layers of "the default is X"
   documentation in `deps/ecto_sqlite3/` + `deps/exqlite/` were enough
   to override SQLite's engine default; the reviewer read the engine
   default and stopped there. Future SQLite-angle reviews should
   `grep` the adapter source for `set_pragma\|maybe_set_pragma` before
   asserting a pragma is OFF.
3. **Don't rewrite history; supersede with a correction section.**
   The original C2 text is preserved in the review doc + persistence
   draft + CP24 with explicit "HISTORICAL — invalidated text retained
   for audit" markers. Per memory `feedback_landed_claim_evidence` +
   CLAUDE.md "directions over code": removing the false finding silently
   would have lost the lesson about reviewer process. The audit trail
   carries the lesson forward.

---

## 2026-05-12 — CP24 bucket B: SQLite production defaults + visitor read-only verbs

Second slice of the post-cr-review mega-cluster. Closed the SQLite
contention + index-gap theme (persistence/S2-S5+S8) and the reviewer
follow-on that surfaced during bucket A's code review (read-only
ops verbs visitor carve-out).

### S7 reframe — DROPPED, no source edits

The first action of bucket B was a re-evaluation of persistence/S7
post-C2 correction. The original framing ("`validate_subject_exists`
TOCTOU patterns lose their backstop without C2 fix; rewrite
'load-bearing' comments to 'convenience'") inherited C2's false
premise. With C2 corrected to NON-FINDING, the comments at
`accounts.ex:179-189`, `query_windows.ex:230-239`,
`user_settings.ex:180-183` already correctly describe the actual
problem (ecto_sqlite3 returns FK constraint name as `nil` → built-in
handler can't match → pre-flight produces clean changeset error
before insert raises; FK is the TOCTOU backstop). Decision: drop
S7 entirely. CP24 bucket B opening section documents the trail.

### S2 + S3 — busy_timeout: 30_000 + pool_size: 10 doc

`config/runtime.exs:22-43` + `config/dev.exs:3-9`. SQLite's default
`busy_timeout` is ~2s. With `pool_size: 10` + WAL + single-writer
file lock, transient contention from concurrent writes (Bootstrap
spawning N sessions, channel-mode batches, last_joined_channels
writes) cascades into `database is locked` exceptions before the
writer ahead releases. The CP23 S4 e2e flake (`cp15-b6-kicked` +
`m9-cicchetto-part-x-click` retries on `Database busy`) was a direct
symptom. 30_000ms mirrors `config/test.exs:17` which has carried
this value since the Sandbox cascading-busy investigation.

S3 (pool_size doc): the existing `pool_size: 10` is correct — it's
a READ concurrency cap under WAL; writes serialize at the file lock
regardless. Lower than 10 would starve cic's per-(user, network)
query fan-out under multi-tab load. Documented in the runtime.exs
comment instead of dropping the value (the recommendation was "doc
OR drop"; doc is right once busy_timeout is in place).

### S5 — partial index on connection_state

`priv/repo/migrations/20260512083037_network_credentials_connection_state_partial_index.exs`.
`Credentials.list_credentials_for_all_users/0` selects every row
WHERE `connection_state = 'connected'` ORDER BY `(inserted_at,
user_id, network_id)` at boot. Without an index the planner
full-scans the table. New partial index (`where: "connection_state
= 'connected'"`) mirrors the shape of
`20260504015357_session_client_id_partial_index.exs`: only
`:connected` rows participate, so footprint stays tiny while the
query plan becomes a direct lookup. Verified locally:
`sqlite_master` lists `network_credentials_connection_state_connected_index`;
networks test suite (108 tests) stays green.

### S8 — last_joined_channels cap at 200

`lib/grappa/networks/credentials.ex:130-149`. Every self-JOIN /
PART / KICK in `Session.Server` overwrites the per-credential
`last_joined_channels` JSON column. The natural upper bound is
the live join count (5-50; RFC 2812 has no absolute ceiling), but
nothing structurally bounded the snapshot. Cap at 200 entries via
`Enum.take/2` inside `update_last_joined_channels/3`. Tail dropped
on overflow; head order preserved. TDD: failing test → cap →
green. 3 deterministic tests + 1 StreamData property (length never
exceeds cap; head order preserved across the take).

### Reviewer add-on — read-only verbs to dispatch_subject_verb/2

`lib/grappa_web/channels/grappa_channel.ex` `who`, `names`, `banlist`
handle_in clauses. Bucket A introduced `dispatch_subject_verb/2` for
WHOIS — visitors are entitled to issue read-only verbs because the
broadcast topic uses the visitor's own `subject_label`. Three more
read-only verbs were still on `dispatch_ops_verb/2` post-bucket-A:
`who`, `names`, `banlist` (`/list` channel handler doesn't exist
yet — channel-client-polish backlog). Migrated to
`dispatch_subject_verb/2` mirroring the C3 fix. 9 visitor regression
tests added (3 verbs × 3 scenarios — live-session ↔ upstream wire,
no-session → `no_session`, CRLF channel → `invalid_line`).

`dispatch_ops_verb/2` retained for write-only verbs (op/deop/voice/
devoice/kick/ban/unban/invite/umode/mode/topic_set/topic_clear) where
visitor-rejection IS the correct semantic.

### Persistence/S4 deferred to bucket H

S4 (PubSub broadcast inside `Repo.transaction`) lives in the
lifecycle-correctness bucket per the mega-cluster plan. Out of scope
for B.

### Deploy classification

Per code-review HIGH H1: hot-deploy would silently no-op the
busy_timeout fix until pool conns recycle (`busy_timeout` is read by
ecto_sqlite3 at connection-init; `Phoenix.CodeReloader` swaps modules,
not pool conns). The new migration also requires a fresh `mix
ecto.migrate` pass. Deployed via `scripts/deploy.sh --force-cold` to
ensure both fixes land in one stop.

### Lessons

1. **Probe contradicts review → re-eval, don't propagate.** Bucket
   A's C2 false-finding precedent: the reviewer-flagged
   `validate_subject_exists` "TOCTOU loses its backstop without S1
   fixed" framing inherited the same false premise. Bucket B opened
   with a 5-minute re-read that confirmed the existing comments are
   already correct → S7 dropped without a single line of source
   change. Memory `feedback_orchestrator_autonomy` "HALT on findings
   contradicted by probe" extends to follow-on findings that depend
   on the contradicted one.
2. **Cap = safety belt, not workload-shaping.** `last_joined_channels`
   has a natural upper bound (live join count). The cap doesn't
   change anyone's behaviour; it bounds the worst case. Don't
   over-document the cap as if it were a design choice driving the
   workload — it's a guardrail.
3. **Two patterns, copy whichever.** Bucket A's `dispatch_ops_verb/2`
   ↔ `dispatch_subject_verb/2` split was principled but partial;
   four read-only verbs ended up split across two patterns. CLAUDE.md
   "Total consistency or nothing" caught it during bucket A's code
   review — bucket B closed the gap. The reviewer-add-on slot
   exists precisely so a partial migration in bucket N becomes a
   complete migration in bucket N+1.

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

Third slice of the post-cr-review mega-cluster. Closed the IRC
outbound trust + validation asymmetry theme (irc/S2-S6) — the five
HIGH findings from `docs/reviews/codebase/2026-05-12-codebase-review.md`
"Theme 1". All five fixes target the IRC core layer
(`lib/grappa/irc/`) which the Phase-6 listener facade reuses as a
library — making each fix self-defending at the IRC boundary, not
relying on upstream callers, is the architectural prerequisite for
that reuse. The boundary tightening also pre-emptively closes the
class of "future REST/admin caller bypasses the schema" risk.

### irc/S3 — `send_privmsg/3` empty-target reject (commit `3a607d5`)

Pre-fix `Client.send_privmsg/3` accepted any target the
`safe_line_token?/1` guard cleared, including `""`. An empty target
yields the malformed wire frame `PRIVMSG  :body\r\n` (double space,
missing recipient) — the upstream silently drops it and the operator
sees a no-op with no error path to grep. Fix: add `target != ""` to
the guard, mirroring `send_pong`'s S9 empty-token precedent. PRIVMSG
deliberately does NOT require the `#&+!` channel prefix (RFC 2812
allows nick-as-target), so "non-empty" is the right floor.

### irc/S2 — `send_join`/`send_part` `valid_channel?` gate (commit `2058e9c`)

Pre-fix both helpers only enforced `safe_line_token?` (CR/LF/NUL
guard). Targets without the RFC 2812 prefix slipped through, creating
`:pending` window-state entries on channel names the upstream could
never JOIN. The 403 ERR_NOSUCHCHANNEL reply often carries a
normalised channel name in `params[1]` that doesn't match what we
sent, so the pending entry never resolves and the sidebar greys the
window forever with no operator breadcrumb. Fix: add
`Identifier.valid_channel?/1` to gate both helpers, mirroring the
existing shape of `send_topic`, `send_kick`, `send_invite`, and the
six other channel-targeted verbs that already enforced it. Closes
the asymmetry the codebase review flagged.

**CRIT-1 follow-up (commit `f129ae1`):** the bucket C code-reviewer
caught a latent MatchError. The irc/S2 fix widened
`Client.send_join`/`send_part`'s return contract from `:ok` to
`:ok | {:error, :invalid_line}` but the corresponding
`Server.handle_cast({:send_join,_},_)` and `({:send_part,_},_)`
clauses stayed pinned to the old strict `:ok = ...` match. In
production today the only live caller path
(`channels_controller.ex:124`) gates `validate_channel_name/1` first
so REST callers cannot trigger the crash, but a future bypass-caller
(mix task, IEx, REPL, future CLI verb) would crash the Session.
Two-layer fix per CLAUDE.md "Total consistency or nothing":
(a) tighten `Session.send_join`/`send_part` facade to gate
`valid_channel?` BEFORE the cast; (b) harden the cast handlers with
defensive `case` arms that log + drop on `{:error, :invalid_line}`,
mirroring the autojoin loop's `handle_info({:irc, %Message{command:
{:numeric, 1}}}, _)` precedent. The reviewer's HIGH-1 (no Server
test for the wedged `:pending` window symptom) is incidentally
closed: malformed channels never reach the Server.cast post-fix, so
`record_in_flight_join` never fires and no `:pending` entry is
created. Four new facade tests pin the ordering "shape rejection
beats whereis lookup".

### irc/S6 — `:logger_metadata` type tightening (commit `5bc8836`)

Pre-fix `Client.opts.logger_metadata` was typed `keyword()` — any
caller could legally pass arbitrary keys. `Logger.metadata/1`
accepts any keyword list, but the formatter (`config/config.exs`)
silently drops keys that are not in the allowlist. The two paths
diverge at format time, not at the boundary. Investigation per the
review brief — "filter at boundary OR add keys to allowlist" — found
the single caller today is `Session.Server.start_link` via
`Grappa.Log.session_context/2`, returning
`[user: String.t(), network: String.t()]`. Both keys ARE in the
allowlist; the silent-drop risk is for FUTURE callers (Phase-6
listener facade, future per-session children).

Right answer: tighten the spec at the boundary so Dialyzer rejects
out-of-shape calls at compile time. The allowlist remains the
runtime gate; the spec becomes the static gate. The new alias
`session_metadata` lives on `Grappa.IRC.Client` itself rather than
re-exporting `Grappa.Log.session_metadata/0` so the IRC namespace
stays free of the optional `Grappa.Log` Boundary dep (extraction
memory `project_extract_irc_libs`: parser + client are slated for
split into standalone hex libs post-Phase-5). The two type aliases
mirror by hand. MED-2 follow-up adds a cross-reference comment in
`Grappa.Log.session_metadata` reminding maintainers to update both.

### irc/S4 — SASL PLAIN encoder NUL guard (commit `1d1e66d`)

RFC 4616 §2 forbids NUL in any of the three SASL PLAIN fields
(authzid, authcid, password) — NUL is the field separator. Pre-fix
`sasl_plain_payload/1` only enforced `is_binary(u) and is_binary(pw)`
(the H10 shape check). A NUL-bearing field slipped past, the encoder
built the bitstring `<<0, "vjt", 0, "vjt", 0, "swo", 0, "rd">>`,
base64 produced a payload the upstream decoded to one extra NUL
field, and the SASL exchange failed as opaque 904 ERR_SASLFAIL.

Fix: explicit `cond` arm for `String.contains?(_, "\x00")` on each
field, raising `ArgumentError` naming the field. The raise is
defense-in-depth behind irc/S5's `new/1` boundary; the message
references "irc/S5 boundary" so an operator who hits it knows the
upstream gate. Mirrors the H10 pattern: a contract violation on
`state.password` post-init crashes with a structured operator-greppable
error rather than emitting a malformed wire frame.

### irc/S5 — `AuthFSM.new/1` self-defending CRLF/NUL boundary (commit `1d5797e`)

Pre-fix `AuthFSM.new/1` only validated `validate_password_present/1`.
Every line-bound field (`nick`, `realname`, `sasl_user`, `password`)
flowed through to the registration handshake unchecked. Today the
gap is closed by `Networks.Credential` validating CRLF/NUL on the
write path, but AuthFSM is intentionally a pure FSM designed for
reuse — the Phase-6 IRCv3 listener facade reuses this module as a
library and any future REST or admin caller that constructs opts
directly bypasses the schema check.

Fix: `validate_line_safe/1` delegates to
`Identifier.safe_line_token?/1` (the existing single-source-of-truth
for "no CR/LF/NUL"). New error shape `{:error, {:invalid_line_token,
field}}` names the offending field. Three classes:
`:nick`/`:realname`/`:sasl_user` always-emitted (NICK + USER +
AUTHENTICATE PLAIN), so the gate fires regardless of method;
`:password` only when `auth_method != :none` (PASS, NickServ
IDENTIFY, SASL PLAIN). The `with` chain preserves the existing
`:missing_password` short-circuit. Pairs with irc/S4: `new/1` is the
primary gate; encoder is defense-in-depth.

### Bucket close

`scripts/check.sh` exit-0; 1486 → 1504 tests (+18: 1 S3 + 4 S2 +
4 facade reviewer + 7 S5 + 2 S4; S6 type-only). Dialyzer 0 errors.
Six `lib/grappa/irc/*.ex` + `lib/grappa/session.ex` +
`lib/grappa/session/server.ex` + `lib/grappa/log.ex` files touched
across 7 commits. No new module added; all changes refine existing
boundaries.

## CP24 bucket D — Wire-shape boundary discipline (2026-05-12)

Mega-cluster `cluster/post-cr-review` bucket D — 5 HIGH findings
from Theme 3 of the 2026-05-12 codebase review, all wire-shape
discipline. CLAUDE.md "Phoenix Channels" invariant (CP15 B7) made
the rule a hard codebase law: "Wire conversion is per-context
responsibility — context-owned `*.Wire` modules." Bucket D enforces
the rule across the four sites where it had drifted.

Bucket D added `Grappa.Cic.Wire` (the codebase's 7th wire module —
joining `Scrollback.Wire`, `Networks.Wire`, `QueryWindows.Wire`,
`Accounts.Wire`, `Visitors.Wire`, `Session.Wire`) and extended
`Scrollback.Wire` + `Session.Wire` with new verbs.

### lifecycle/S10 NON-FINDING

Review claimed `Grappa.Cic.Bundle`'s `exports: []` blocked
`current_hash/0` from web. Verified by reading the Boundary library:
for `top_level?: true` boundaries, the module itself IS the exported
surface — `exports:` only constrains submodules. Sibling
`Grappa.WSPresence` (`top_level?: true, deps: [Grappa.PubSub]`, no
`exports:`) is called from `AdminController` cleanly via
`WSPresence.list_user_names/0`; same shape as `Cic.Bundle`. Live
compile shows zero Boundary warnings. Third NON-FINDING in this
mega-cluster (bucket A's C2 + bucket B's persistence/S7 are
precedents) — pattern: re-read the code, contradict the reviewer
with evidence.

### web/S2 — `ArchiveJSON` delegate to `Scrollback.Wire` (commit `d878b6b`)

Pre-fix `GrappaWeb.ArchiveJSON.index/1` handcrafted the per-target
wire shape inline with **string keys** (`%{"target" => target,
"kind" => Atom.to_string(kind), ...}`), duplicating the contract
that `Scrollback.list_archive/3` produces. CLAUDE.md "Wire
conversion is per-context responsibility" + "implement once, reuse
everywhere" both ignored — every other JSON view delegates to a
context-owned `*.Wire` module.

Fix: `Scrollback.Wire.archive_entry/1` (per-target projection with
atom keys + `Atom.to_string/1` on `:kind`) + `archive_index/1`
(REST envelope wrapper). Controller delegates. Atom-keyed Wire
output → Jason serializes to byte-identical string-keyed JSON;
`ArchiveControllerTest` continues to assert the same JSON shape
unmodified.

### web/S3 + web/S4 — `Session.Wire.member/1` unifies REST + Channel (commit `1a6a77f`)

Pre-fix the per-member shape lived NOWHERE: `MembersJSON.index/1`
returned `Session.member()` directly (no Wire boundary), and the
Channel `members_seeded` event constructed `members:` independently
(verbatim pass-through). REST `%{members: [...]}` envelope and
Channel `%{kind, network, channel, members}` envelope each owned
their `members:` payload independently — drift hazard with no
enforcement, AND a future struct-wrap on `Session.member()` would
silently leak Elixir-internals onto the wire AND re-introduce the
CP15 B6 fastlane-crash class on the broadcast path.

Fix: `Session.Wire.member/1` (per-row projection — pattern-matches
`%{nick: nick, modes: modes}` and rebuilds, filtering any future
extras to the contract) + `members_index/1` (REST envelope). Both
surfaces funnel through `member/1`:
  * REST: `MembersJSON.index/1` → `Wire.members_index/1`.
  * Channel: `Wire.members_seeded/3` → `Enum.map(&member/1)`.

Envelope shapes stay surface-specific (REST is a snapshot resource —
members only; Channel is an event broadcast carrying network/channel
context). Per-member shape is the unification point. JSON wire output
byte-identical to pre-bucket-D.

### cross-module/S4 — `Cic.Wire.bundle_hash/1` (commit `7fcb869`)

Pre-fix the `%{kind: "bundle_hash", hash: hash}` payload was inline
in TWO sites — `AdminController.cic_bundle_changed/2` (deploy-cic
broadcast on every user-topic) AND `GrappaChannel.push_bundle_hash/1`
(after-join snapshot push). The review listed only the
AdminController site; bucket D closed BOTH because "implement once,
reuse everywhere" demands it (NOT bucket-broadening — strictly
principled scope).

Fix: new `Grappa.Cic.Wire` module with `bundle_hash/1`. Both sites
delegate. `top_level?: true, deps: []` Boundary shape mirrors sibling
`Grappa.Cic.Bundle` — independent surfaces (one reads disk, one
renders), no shared context module. `GrappaWeb`'s Boundary deps
gain `Grappa.Cic.Wire`. Adding fields to the cic-bundle wire (build
timestamp, asset digests for partial refresh) is now one edit.

### Reviewer follow-ups (commit `95d3a43`)

Bucket D code-reviewer flagged 0 CRITICAL, 0 in-bucket HIGH, 2 MED,
3 LOW, and 1 bucket-Z carry-forward (H-Z1: `query_windows_list`
envelope inlined in 3 sites — same class as cross-module/S4, defer
to bucket Z). In-bucket follow-ups landed:
  * M1: rename test "passes the pre-sorted members list through
    unchanged" → "emits each member through member/1" (bucket D made
    the production code projection-shaped, not pass-through).
  * M2: amend `members_seeded/3` docstring — projection through
    `member/1` does NOT re-sort.
  * L1: filter-to-contract regression test — extended source map
    (with `:account` + `:host`) is filtered to `%{nick:, modes:}`.

Bucket-Z carry-forward also includes L3 (auth_json `%{kind: "user",
...}` + `%{kind: "visitor"}` discriminator inlined; defer to next
architecture review since each is one site per discriminator).

### Bucket D close

`scripts/check.sh` exit-0; 1504 → 1518 tests (+14: 7 in
`Scrollback.WireTest` for archive_entry/archive_index, 5 in
`Session.WireTest` for member/members_index/parity + 2 reviewer
follow-ups, 3 in new `Cic.WireTest`). Dialyzer 0 errors. 8 lib
files + 4 test files touched across 4 commits (3 substantive + 1
reviewer follow-up). One new module landed: `Grappa.Cic.Wire`
(7th codebase wire module).

## CP24 bucket E — Channel inbound validation + visitor coverage (2026-05-12)

Mega-cluster `cluster/post-cr-review` bucket E — 5 HIGH findings
from Themes 4 + 5 of the 2026-05-12 codebase review. Common thread:
the OUTER untrusted boundary (Channel WS inbound, visitor surface)
was weaker than the inner ones. Bucket C closed the IRC core's
self-defending pattern (irc/S5 — `AuthFSM.new/1` rejects malformed
caller bytes); bucket E mirrors that discipline at the WS edge +
extends visitor coverage to symmetry with users.

### web/S6 — `topic_set` tagged-tuple gates (commit `f2a90c8`)

Pre-fix `topic_set`'s `with`/`else` matched by raw `true`/`false`
value: a `with true <- safe_line_token?(...)` followed by
`with false <- visitor?(...)` shape that mapped two different
sources to the same `else true ->`/`else false ->` arms. Adding
ANY new boolean check above either site silently flipped the
user-visible error message — the kind of bug that lands in
production unnoticed because both branches still return SOME
error, just the wrong one.

Fix: two private helpers (`check_safe_line/2` later subsumed by
`validate_args/1` in S7, `check_not_visitor/1`) that return tagged
tuples — `else` arms now match `{:error, :invalid_line}` /
`{:error, :visitor_not_allowed}` per source. Pinning regression
tests (visitor + invalid input → invalid input wins; visitor +
safe input → visitor_not_allowed) prove per-source tag mapping
holds. Pre-fix the tests passed by ordering coincidence; post-fix
they pass by design.

### web/S7 — Channel inbound IRC-shape validation gates (commit `0443103`)

The defense-in-depth fix at the WS edge. Pre-bucket-E every
Channel `handle_in/3` clause that accepted `channel`/`nick`/`mask`/
`target_nick` payload fields trusted the upstream
`IRC.Client.send_*` boundary to reject malformed input. The REST
surface ALREADY gated rigorously via `GrappaWeb.Validation.validate_*`
(404 `:bad_request`); the Channel surface accepted any binary —
asymmetric trust at two doors to the same backend.

A hostile cic instance (or compromised user) could push CRLF/NUL
or malformed IRC tokens via WS even though they'd eventually trip
the IRC core gate. Bucket C's irc/S5 made `AuthFSM.new/1`
self-defending; bucket E mirrors that discipline at the OUTER
boundary.

Implementation:
  * New `validate_args/1` private helper — recursive list-of-pairs
    validator (`channel:`, `nick:`, `nicks:`, `mask:`, `line:`,
    `params:`) returning `{:ok, :ok}` or
    `{:error, :invalid_channel | :invalid_nick | :invalid_mask
    | :invalid_line}`. Tighter `@spec` (closed-set tag enum)
    silenced a Dialyzer success-typing warning on first compile.
  * `dispatch_ops_verb/2` and `dispatch_subject_verb/2` migrated
    to arity-3 with a mandatory `validate_thunk` parameter. CLAUDE.md
    "No default arguments via `\\`" — the old arity-2 was fully
    removed (no two-pattern drift). All 13 verbs (op/deop/voice/
    devoice/kick/ban/unban/invite/banlist/whois/who/names/mode/
    umode/topic_clear/open_query_window/close_query_window) thread
    `validate_args/1` via the new arity-3 dispatchers. `topic_set`
    (its own `with` chain due to `{:ok, message}` return shape)
    extended with the same `validate_args/1` call shape.
  * Stable cic-facing tags: `:invalid_channel` / `:invalid_nick` /
    `:invalid_mask` / `:invalid_line`. Per CLAUDE.md "Atoms or
    `@type t :: literal | literal` — never untyped strings."

13 new boundary tests pin: malformed channel → `invalid_channel`;
malformed nick (incl. spaces, commas) → `invalid_nick`; CRLF mask
or empty mask → `invalid_mask`; CRLF in modes/params/reason/free
text → `invalid_line`. Existing tests updated to assert the more
specific tag (CRLF channel → `invalid_channel`, not `invalid_line`).

### web/S5 — Visitor bundle broadcast (commit `c00774a`)

Pre-fix `UserSocket.connect/3` explicitly skipped
`WSPresence.register/2` for visitor sockets to keep the auto-away
machinery user-only. But the same registry doubles as the source
of truth for `cic-bundle-changed`'s fan-out (`WSPresence.list_user_names/0`
iterates connected users to push the new bundle hash). Visitors
with long-lived tabs never saw the refresh banner trigger and
silently rotted on stale bundles.

Fix: register every WS pid (user AND visitor). Auto-away stays
user-only because visitor `Session.Server` does not subscribe to
`Topic.ws_presence/1` (see `Session.Server.init/1`'s
`match?({:user, _}, opts.subject)` guard) — visitor registration
is a harmless no-op on the auto-away path. CLAUDE.md "Implement
once, reuse everywhere" + "Reuse the verbs, not the nouns" — one
registry covers both consumers; a parallel `list_visitor_names/0`
would have been the noun-fork anti-pattern. `client_closing/2`
symmetrically forwarded for visitors so the registry decrements
on `pagehide` immediately.

Failing-first regression test: visitor connect →
`list_user_names/0` includes `"visitor:<id>"`. Pre-fix the
assertion failed (`right: []`); post-fix it passes by design.
Plus an admin-controller test that visitor sockets receive the
`bundle_hash` broadcast.

### lifecycle/S1 — Visitor `credential_failer` (commit `51a8219`)

Pre-fix visitor sessions had no equivalent of the user-side
`credential_failer` callback that `Networks.SessionPlan` injects.
K-line / permanent-SASL on a visitor exited the `Session.Server`
silently; visitor row's `expires_at` stayed in the future;
`Bootstrap` cheerfully respawned the rejected visitor on every
app start with no operator signal. Cluster-wide rule violation
per memory `feedback_silent_retry_anti_pattern` — silent retries
mask root causes.

Fix: mirror of the user-side flow:
  * New `Visitors.mark_failed/2` expires the visitor row
    (`expires_at = now()`) so `Bootstrap.list_active/0` stops
    returning it; `Visitors.Reaper` sweeps the row at the next
    60s tick. Idempotent on already-expired rows; `:not_found`
    on a delete-between-spawn-and-failure race.
  * Structured `Logger.error("visitor permanently rejected …",
    user: "visitor:<id>", network: <slug>, reason: <reason>)` —
    operator-visible signal.
  * `Visitors.SessionPlan.build_plan/3` injects
    `credential_failer: fn reason -> Visitors.mark_failed(visitor.id,
    reason) end` in every visitor plan. The closure captures the
    visitor id (not the struct) so a delete-between-spawn-and-
    failure race surfaces cleanly through `mark_failed/2`'s
    `:not_found` return rather than a stale-row write.
  * `Session.Server.handle_terminal_failure/2`'s `is_function/1`
    guard already accepted both shapes — only the injection site
    was missing. Doc-comment updated.

5 new tests: `mark_failed/2` × 3 (expires the row, idempotent,
not_found race), SessionPlan × 2 (failer injected + closes row,
race-tolerant on deleted visitor).

### web/S8 — `list_members/3` `:uninitialized` state (commit `1028bd8`)

Pre-fix `Session.list_members/3` returned `{:ok, []}` ambiguously
for "no NAMES burst yet (uninitialized)" vs "channel has 0
members." REST + Channel + cic all collapsed to the same wire
shape so cic could not tell whether to show "loading…" or the
"no members" empty state. Closes 2/3 open issues in memory
`project_names_ux_silent_bugs`.

The interesting design call: do we add state, or derive? CLAUDE.md
"Don't duplicate state that already exists — derive it" pulls
toward derivation. But `state.members[channel] = %{own_nick =>
[]}` is structurally identical between "joined pre-NAMES" and
"joined where I am alone post-NAMES" — the only signal that
disambiguates is "did 366 RPL_ENDOFNAMES fire?" which is event
flow, not derivable from current state. Adding a `seeded_channels
:: MapSet.t()` sentinel is the principled fix.

Implementation:
  * `Session.Server.state` gains `seeded_channels` populated by
    `apply_effects([{:members_seeded, channel, _}])` (366 path)
    and pruned post-`EventRouter.route/2` via
    `prune_seeded_channels/1` (intersect with
    `Map.keys(state.members)`) so self-PART / self-KICK drops
    stay consistent. Two routes through `apply_effects/2` — both
    call `prune_seeded_channels/1`.
  * `handle_call({:list_members, channel}, ...)` returns
    `{:ok, :uninitialized}` when `channel ∉ seeded_channels`,
    `{:ok, [member()]}` (possibly empty) once 366 fired at least
    once. `Session.list_members/3`'s `@spec` widened.
  * `MembersController.index/2`: `:uninitialized` → HTTP 204 No
    Content; non-empty / empty list → HTTP 200 + JSON. cic's
    fetch path is REST-free post-CP15 B5 so this matters mainly
    for non-cic REST consumers (curl probes, future integrations).
  * `GrappaChannel.push_members_if_seeded/4` cold-snapshot path:
    skip on `:uninitialized` (cic's "loading…" stays visible
    until 366 broadcasts the canonical `members_seeded` event);
    push the empty list when NAMES emitted zero members.

cic-side MembersPane needed NO changes — it already keys on
`windowStateByChannel == "joined" && list().length > 0`
(linea 108-109 di `MembersPane.tsx`): joined+empty → "loading…",
non-joined → "not joined", joined+non-empty → render. Bucket E's
fix makes the SERVER signal honest so cic's existing branches
match reality.

5 new server tests pin discrimination across all states; 1 new
REST test pins HTTP 204 for the joined-pre-366 case. Existing
test renamed (was asserting the buggy `{:ok, []}` shape for a
not-in-members channel).

### Bucket E close

`scripts/check.sh` exit-0; 1518 → 1543 tests (+25: 2 S6 tag-source
disambiguation, 13 S7 IRC-shape boundary, 1 S5 user_socket visitor
WSPresence + 1 admin_controller visitor bundle broadcast, 5 S1
mark_failed + SessionPlan failer injection, 5 S8 list_members
states + REST 204). Dialyzer 0 errors. 7 lib files + 5 test files
touched across 5 commits.

5 HIGH findings closed in one bucket — pattern continues:
CRITICAL+follow-on close in single bucket (A), drop-the-finding
discipline (B persistence/S7), in-bucket reviewer follow-ups (C
CRIT-1, D M1+M2+L1). No new wire modules (bucket D landed 7;
bucket E reuses the discipline at the boundary, doesn't add new
shapes). One in-bucket Dialyzer success-typing tighten
(`validate_args/1` `@spec`) — the kind of "design signal"
CLAUDE.md flags as a constraint worth listening to (the closed-set
tag enum makes the surface explicit + future addable arg kinds
require a `@typep` extension, NOT a silent broadening).

## CP24 bucket F — Cicchetto own-nick + nick-comparison + Network type split (2026-05-12)

Cluster `cluster/post-cr-review` bucket F: 4 HIGH findings from
Theme 8 of the 2026-05-12 codebase review. Common thread: cicchetto
correctness — type-system enforcement of contracts that the
`?:`-optional + bare-`===` patterns left implicit. Discriminated
unions, single-source helpers, and boundary tagging put the
contracts at the type system instead of in scattered defensive
checks.

### Bucket F H2 — CSP allowlist hCaptcha extension (`security-headers.conf`)

Pre-fix the nginx CSP `script-src` + `frame-src` allowlists
covered Cloudflare Turnstile only. cic + server config both list
hCaptcha as a selectable provider; selecting it in prod failed
silently with the misleading "ad-blocker" catch-all message because
the iframe got blocked by CSP, not by an ad-blocker.

Fix: extend `connect-src` + `script-src` + `frame-src` + `style-src`
to include `https://*.hcaptcha.com`. The wildcard covers the four
hostnames hCaptcha rotates through (loader, assets, siteverify,
edge). Style-src extension is needed because hCaptcha's widget
loads its own external stylesheet that 'unsafe-inline' (already
present) does not cover. Modern hCaptcha doesn't require
`'unsafe-eval'` (only legacy challenge runtime did) — kept defense
in depth.

CSP edits live in the snippet so the `/` location and `/sw.js`
override stay in lockstep with one edit instead of two-files-must-
stay-consistent. Verification = browser smoke at bucket close
(network-edge enforcement; not unit-testable).

### Bucket F H1 — own-nick foot-gun (`Shell.tsx`, `MembersPane.tsx`)

`Shell.tsx:55` (MentionsWindow ownNick prop) and
`MembersPane.tsx:73` (UserContextMenu ownModes derivation)
re-introduced the `displayNick(me)` foot-gun the team JUST closed
in cic H3 on 2026-05-08. `displayNick(me)` returns `me.name` for
users — the operator ACCOUNT name — which can diverge from the
per-network IRC nick after NickServ ghost recovery (account "vjt",
IRC nick "vjt-grappa") OR when the account name happens to match an
unrelated peer's IRC nick on a network where the operator runs
under a different nick.

The codebase already had the canonical resolution helper
`ownNickForNetwork(net, me)` in `lib/api.ts:120` with a 30-line
warning block on `displayNick` (lines 80-89) explaining exactly why
it's wrong as own-nick — the two regressed callsites simply didn't
get the memo. ScrollbackPane.tsx:445 already uses the helper
correctly; this fix aligns Shell + MembersPane with the same source
of truth.

Fix:
* MembersPane: derive own-nick via `ownNickForNetwork(net, me)`
  using `networkBySlug(props.networkSlug)` — the per-channel render
  scope already has the slug.
* Shell: replace the global `ownNick()` derivation with a per-slug
  `ownNickForSlug(slug)` resolver; the two MentionsWindow callsites
  pass `ownNickForSlug(sel().networkSlug)` which is in scope at
  both branches (desktop + mobile).

Failing vitest in `MembersPane.test.tsx` exercises the
account-name ≠ IRC-nick scenario (peer "vjt" with @ on the channel,
operator account "vjt" but per-network IRC nick "vjt-grappa") —
pre-fix `ownModes` returned `["@"]` (peer's modes), post-fix it
returns `[]` (operator's actual modes for the "vjt-grappa" row).

### Bucket F H3 — case-insensitive nick comparison (`nickEquals` helper)

`members.ts:57,62,69,76` and `ScrollbackPane.tsx:461,562` used bare
`===` for nick comparison while `subscribe.ts:183,319,328,556`
already used `.toLowerCase()`. The drift between two stores
produced three distinct bug classes:

* **Phantom members.** Server emits `Alice` on JOIN then `alice` on
  QUIT (or any casing variant — IRC servers are not consistent
  across the JOIN/PART/QUIT/KICK round-trip, especially after
  NickServ ENFORCE / GHOST). Pre-fix the QUIT row didn't match the
  JOIN row, the lower-cased copy lingered as a phantom member.
  KICK same; NICK_CHANGE same. Members count drifted upward across
  reconnects with no recovery short of leaving + rejoining.
* **Missed self-JOIN banner.** ScrollbackPane.shouldShowBanner
  compared `m.sender === nick` against the scrollback row's sender.
  Server emits the JOIN with original-casing nick; cic's
  per-network own-nick was the configured casing. Mismatch → banner
  never fired; spec #7 join-banner surface silently dropped.
* **ownModes lookup miss.** ScrollbackPane.ownModes did
  `members.find((m) => m.nick === nick)`. If the operator's own
  row in the members store had a casing variant of the per-network
  IRC nick, the find missed and ownModes returned `[]` —
  UserContextMenu rendered op-gated items as disabled even when the
  operator IS an op.

Per RFC 2812 §2.2 nicknames are case-insensitive; the spec defines
a custom case-fold (`{`, `}`, `|` are lowercase forms of `[`, `]`,
`\`) but cic uses ASCII `.toLowerCase()` for two reasons: (1)
subscribe.ts already uses bare `.toLowerCase()` and has been
correct in production for months — going stricter would create a
two-policy split that silently misbehaves on the boundary, (2)
users running nicks that distinguish `{user}` vs `[user]` are
vanishingly rare. Future stricter casemapping = single helper edit
+ every callsite already routes through it.

Per CLAUDE.md "Total consistency or nothing": every nick comparison
in cic routes through `nickEquals`. Sites migrated:
* `lib/members.ts` (4 sites) — JOIN/PART/QUIT/KICK/NICK_CHANGE
  presence dispatch
* `ScrollbackPane.tsx` (2 sites) — ownModes lookup, JOIN-self
  banner trigger
* `MembersPane.tsx` (1 site) — ownModes lookup (already
  lower-cased pre-fix; migrated for single source of truth)
* `subscribe.ts` (4 sites) — own-nick gate in routeMessage,
  own-JOIN auto-focus, own-PART dismiss, query-window own-nick
  skip (all four were `.toLowerCase()`-correct pre-fix; migrated
  for consolidation)
* `lib/modeApply.ts` (1 site, follow-up commit) — MODE target
  match. Same bug class — silently no-op'd a MODE event whose
  target arg arrived in a different casing than the JOIN/NAMES
  populated store.

`lib/nickEquals.ts` exposes `nickEquals(a, b)` (binary equality)
and `normalizeNick(s)` (for Map/Set keys); both null-safe at the
helper level. TDD via `__tests__/nickEquals.test.ts` (helper) +
`__tests__/members.test.ts` casing-mismatch suite (5 behavior
tests) + `__tests__/modeApply.test.ts` casing test.

### Bucket F H4 — Network discriminated union (UserNetwork | VisitorNetwork)

Pre-fix `Network.connection_state` (and `nick`,
`connection_state_reason`, `connection_state_changed_at`) were
typed `?:` optional. The optionality matched the wire reality
(server emits two implicit shapes: visitor = bare; user = adds nick
+ 3 connection_state fields) but the type system couldn't enforce
that `network.connection_state` was unreachable on the visitor
branch — every consumer wrote `?.connection_state` defensively and
the branches drifted (some sites narrowed, some didn't, none on a
typed boundary).

Per CLAUDE.md "Consistency: same problem, same solution" — this
mirrors the user-vs-visitor `MeResponse` discriminated union that
already lives at `lib/api.ts:63`. The kind is the same domain
boundary; the type system enforces it the same way.

Implementation:
* `lib/api.ts` — split `Network` into `UserNetwork` (kind: "user"
  + nick + 3 required connection_state fields) | `VisitorNetwork`
  (kind: "visitor" + bare). New `RawNetwork` represents the
  pre-tag wire shape.
* `lib/api.ts` — `tagNetwork(raw, subjectKind)` boundary helper
  promotes RawNetwork → Network. User-subject contract violations
  (missing nick or connection_state) drop the row + log.
* `lib/networks.ts` — networks resource re-keyed on `user`
  (was: token) so the boundary tagger has the subject kind to
  discriminate each row. listNetworks now returns RawNetwork[];
  the resource filter-maps via tagNetwork before the typed store
  sees them.
* `lib/api.ts` — ownNickForNetwork narrows on
  `net.kind === "user"` instead of probing for a populated nick.
  The missing-nick branch moved upstream to tagNetwork at the
  fetch boundary; what remains is the kind-mismatch contract
  violation (visitor-shaped row in a user's list).
* `lib/networks.ts` — mutateNetworkNick narrows on
  `n.kind === "user"` before patching nick (visitors can't NICK
  upstream — the visitor IS the nick).
* `ComposeBox.tsx` + `Sidebar.tsx` — narrow on
  `network.kind === "user"` before reading `connection_state` /
  `connection_state_reason`. The `?.connection_state ??`
  defensive patterns are now structurally unreachable on the
  visitor branch.

Server emits NO `kind` discriminator on Network records (the
shape difference is implicit in the request authentication
subject); cic injects the discriminator at the fetch boundary so
every downstream consumer narrows via `network.kind === "user"`
instead of defensive `?.connection_state ??` checks.

TDD: `__tests__/api.test.ts` adds a tagNetwork describe block (5
tests covering visitor passthrough, user complete, user missing
nick, user empty-string nick, user missing connection_state). The
ownNickForNetwork tests evolve to the post-split shape (user +
VisitorNetwork is now the kind-mismatch case).

### Bucket F close

`scripts/check.sh` exit-0; 1543 tests / 0 failures (server-side
unchanged — cic-only edits). Cic vitest 749 passing (was 733 +
new H1 ownModes test + new nickEquals helper test + new H3 casing
suite + new H4 tagNetwork suite). Dialyzer 0 errors. 11 cic source
files + 9 test files touched across 5 commits.

4 HIGH findings closed in one bucket. Pattern continuation:
* drop-the-finding discipline (B persistence/S7) parallels the
  H4 type split's removal of defensive `?.connection_state ??` —
  the structural fix retires a class of code the bucket would
  otherwise be tempted to extend
* in-bucket reviewer follow-up (C CRIT-1, D M1+M2+L1) parallels
  H3's modeApply follow-up — the cleanup landed in the same
  bucket because the type system + grep made the missed callsite
  visible immediately
* total consistency or nothing (CLAUDE.md) — H3 migration
  includes the already-correct subscribe.ts callsites for single
  source of truth, NOT just the buggy ones

Bucket F is the second cic-touching bucket of the cluster (D was
the first); the structural shift here (discriminated union at the
boundary fetcher) sets the template for U2 codegen down the line —
the kind discriminator becomes the natural codegen anchor for
generated TypeScript unions from the server-side `Wire` modules.


---

## CP24 bucket G — Cross-surface drift + envelope unification (2026-05-12)

**Theme 7** of `docs/reviews/codebase/2026-05-12-codebase-review.md`
plus the `U1` / `U3` / `U4` unification opportunities. 4 HIGH
findings closed (cross-surface/H1+H2+H3+H4) + 3 unifications
landed (U1 `Grappa.Wire.Time` shared helper, U3
`narrowChannelEvent` runtime narrower, U4 unified
`{error, field_errors}` 422 envelope). H5 was demoted to MED by
the cross-surface agent (line 152 of the review) and stays on the
bucket Z list.

The bucket sits at the boundary between server (Elixir) and cic
(TypeScript). Every finding edits the wire-shape contract OR a
narrowing/projection across it.

### Bucket G U1 — `Grappa.Wire.Time` shared helper (commit `43e5a96`)

`Grappa.Networks.Wire` was the only module with a private
`iso8601_or_nil/1` shim — every other `*.Wire` module either had
no nullable timestamps or inlined `DateTime.to_iso8601/1`
directly. The next site that needed a nullable timestamp would
have re-implemented the shim, with drift inevitable (different
sites would pick `Calendar.strftime`, omit the `nil` guard, or
inline a per-site case clause).

Extracted to `Grappa.Wire.Time.iso8601_or_nil/1` — a top-level
module living in a NEW `lib/grappa/wire/` directory. The new
directory sits OUTSIDE the per-context Wire boundary because
timestamp formatting is not a context concern: `inserted_at` /
`updated_at` / `expires_at` / `connection_state_changed_at` all
want the same wire shape regardless of which context owns the
row. Documented in the moduledoc as the FIRST cross-context
helper inside `lib/grappa/wire/` and the precedent for future
cross-context primitives (numeric coercion, bool, etc.).

Boundary: `Grappa.Networks` adds `Grappa.Wire.Time` to its deps
list; the `WireTime` alias on the import keeps callsites
readable.

TDD: 4 tests in `test/grappa/wire/time_test.exs` lock in the
projection contract (nil verbatim, DateTime → ISO-8601 with usec
or sec precision preserved).

### Bucket G H1 — Login.tsx dead `captcha_provider_unavailable` arm (commit `1903aa6`)

`Login.tsx`'s `friendlyMessage` switch had an arm for the wire
token `"captcha_provider_unavailable"` that the server NEVER
emits. The server-side mapping is in
`Grappa.Admission.Captcha.SiteVerifyHttp` — every upstream-side
verification failure (4xx, 5xx, transport error) becomes
`{:error, :captcha_provider_unavailable}` which `FallbackController`
renders with status 503 and wire body `%{error: "service_degraded"}`.
The wire token is `"service_degraded"`, NOT
`"captcha_provider_unavailable"`.

Pre-fix consequence: a real captcha-provider outage hit the
`default` arm because the dead arm matched a wire token that
never arrives. The user saw the raw `"503 service_degraded"`
`Error.message` instead of the documented "Login service
temporarily unavailable" copy. Silent UX degradation hidden
because the dead arm was *next to* the live `service_degraded`
arm — visually they looked complementary.

The fix drops the dead arm and adds a docstring to the
`service_degraded` arm so the next reader knows where the wire
token comes from + when this arm fires. CLAUDE.md "Total
consistency or nothing" — one wire token, one friendlyMessage
arm.

TDD: vitest in `Login.test.tsx`
`describe("captcha provider outage (cross-surface/H1)")` exercises
the 503 path; asserts the friendly copy renders AND the raw wire
token does NOT leak.

### Bucket G H2+U4 — Unified `validation_failed` envelope (commit `a5a30e4`)

The 422 changeset path lost field-level error info to the cic side.

Pre-fix server emitted `%{errors: %{field => [msg]}}` — no `error`
discriminator, the shape matched neither the canonical A7
`{error: "<token>"}` envelope nor Phoenix's default `ErrorJSON`
`{errors: {detail: ...}}` shape. cic's `readError` resolution
chain (`body.error → errors.detail → res.statusText`) tripped
neither path: `body.error` undefined; `body.errors.detail`
undefined (the value was a map, not a string); `res.statusText`
won. Every 422 collapsed to "Unprocessable Entity" client-side
and the operator lost field-level error info.

Post-fix server emits `%{error: "validation_failed", field_errors:
%{field => [msg]}}`. The discriminator follows the same A7
snake_case convention as every other arm; `field_errors` lives as
a top-level key alongside the existing
`site_key`/`provider`/`retry_after` convention (cic's
`ApiError.info` already reads body's top-level keys directly —
e.g. `Login.tsx`'s `err.info.provider`).

cic side gains a `ValidationError` type alias mirroring
`AdmissionError`'s discriminated-union pattern, and `readError`
gets a docstring pinning the resolution-order contract so future
readers don't re-introduce the drift class.

Single emitter (`FallbackController`'s changeset clause), single
client-side path (`readError`'s `body.error` → `info`).

TDD: 2 ExUnit tests in `fallback_controller_test.exs`
`describe("validation errors (H2+U4 unified envelope)")` (basic
shape + traverse_errors substitution); 1 vitest in `api.test.ts`
`describe("ApiError 422 validation envelope (H2+U4)")` exercising
the field-level `info.field_errors` extraction.

### Bucket G H3 — `WireChannelEvent` consolidation (commit `0c30159`)

The per-channel WS event union was duplicated between TWO sites
with DIFFERENT breadth.

Pre-fix:
* `cicchetto/src/lib/api.ts:315-318` declared a NARROW
  `ChannelEvent = {kind: "message", message}` — one arm.
* `cicchetto/src/lib/subscribe.ts:96-124` redeclared the FULL
  6-kind union as a local `WireEvent` type
  (message + topic_changed + channel_modes_changed +
  members_seeded + joined + join_failed + kicked).

Future consumer importing `ChannelEvent` from api.ts narrowed via
discriminator vacuously: `if (ev.kind === "message")` succeeded
because the narrow type knew nothing else; nothing surfaced when a
new arm landed in subscribe.ts. Same drift class that motivated
bucket F's `Network` type split (UserNetwork | VisitorNetwork).

Post-fix: single canonical `WireChannelEvent` union in api.ts
mirrors `WireUserEvent` (CP16 B5). All consumers import from one
site; `assertNever` exhaustiveness in switch handlers catches new
arms at `tsc` compile time. Legacy `ChannelEvent` retained as
`Extract<WireChannelEvent, {kind: "message"}>` so existing
callsites that imported the narrow shape (e.g. `routeMessage`'s
`message:` parameter) keep working without a rename.

Type-only imports from peer leaf modules (`channelTopic.ts`,
`memberTypes.ts`) keep api.ts an effectively-leaf module
load-order-wise.

TDD: vitest in `api.test.ts`
`describe("WireChannelEvent canonical union (H3)")` exercises
discriminator narrowing on every arm + an exhaustive `assertNever`
switch (compile-time guarantee anchored by runtime example).

### Bucket G H4+U3 — `narrowChannelEvent` runtime narrower (commit `52b9148`)

Per-channel WS events were not runtime-narrowed at the WS edge.

Pre-fix `subscribe.ts:269,370` cast the raw Phoenix payload directly
as `WireChannelEvent`. `phoenix.js` types the event payload as
`unknown`-shaped JSON; the cast is a *lie* — TypeScript trusted
shape it cannot enforce. Same gap that motivated the `userTopic.ts`
cic-M1 fix (CP16 narrowUserEvent). A malformed server push (kind
valid but a required field missing/wrong-typed) would either crash
a setter (`seedTopic(key, undefined)`) or silently corrupt store
state.

Post-fix new `cicchetto/src/lib/wireNarrow.ts` module with
`narrowChannelEvent(raw: unknown): WireChannelEvent | null` —
exhaustive per-arm shape validator. Mirror of
`userTopic.ts`'s `narrowUserEvent`. Returns null on any shape
mismatch; `subscribe.ts` drops + logs.

Both per-channel handlers (channel + DM-listener) now run the raw
payload through the narrower BEFORE the dispatch switch. The
`WireChannelEvent` cast is gone from subscribe.ts — the narrower
returns the typed result directly.

The `lib/wireNarrow.ts` module is the precedent the cluster-shape
table sanctioned (CP24 line 301): future per-topic narrowers
(e.g. a `narrowAdminEvent` if Phase 5 grows the LiveDashboard's WS
surface) land here. The narrower is a leaf module — no SolidJS
effects, no reactive store imports — which makes it trivially
testable in isolation.

TDD: 31 tests in `wireNarrow.test.ts` exercise valid + malformed
shapes for every arm: invalid top-level shape (null, non-object,
missing/non-string kind, unknown kind); per-arm valid envelope;
per-arm rejection of missing required fields, wrong-typed fields,
and (where applicable) wrong discriminator values.

### Bucket G close

`scripts/check.sh` exit-0. Server-side test count unchanged at
1543 + 4 new = 1547 (4 Wire.Time tests + 2 changeset envelope
tests; 1 prior assertion on `errors:` vs `error:` envelope updated
in fallback_controller_test). Cic vitest 753 → 784 (+31 wireNarrow
+ 2 H3 WireChannelEvent contract + 1 H1 service_degraded + 1
H2+U4 422 envelope = +35 net minus a couple of consolidations).
Dialyzer 0 errors. 4 cic source files + 4 server source files
+ 4 test files (3 vitest + 2 ExUnit; counting the new
wireNarrow.test.ts + time_test.exs as new files) touched across
5 commits.

4 HIGH closed (H1+H2+H3+H4) + 3 unifications (U1+U3+U4) closed
in one bucket. Pattern continuation:
* drop-the-finding discipline (D lifecycle/S10 NON-FINDING)
  parallels H1's drop-the-dead-arm — the right answer was
  removal, not rewriting
* total consistency or nothing (CLAUDE.md) — H2+U4 migrates the
  ONE 422 path and updates BOTH server + cic in one commit, not
  half-now/half-later
* implement once, reuse everywhere (CLAUDE.md) — U1 extracts the
  shared helper instead of letting each Wire re-inline the shim;
  H3 lifts the union into one module; H4+U3 build the
  per-channel narrower as a sibling to the existing per-user one
* infrastructure precedent — U1's `lib/grappa/wire/` directory
  + the H4 `lib/wireNarrow.ts` cic file both establish "where
  do shared cross-context primitives go" precedents that future
  buckets inherit

Bucket G is the third cic-touching bucket of the cluster
(D + F + G); the structural shift here (runtime narrower at the
WS edge) extends the type-safety floor to the boundary the type
system can't reach alone. The H3 single-source `WireChannelEvent`
union pairs with the H4+U3 narrower so the SAME canonical type
serves both compile-time consumer narrowing (api.ts → tsc) AND
runtime payload validation (wireNarrow.ts → drop-and-log) —
single source for both paths.


## CP24 bucket H — Lifecycle correctness + boot perf (2026-05-12)

**Theme 6** of `docs/reviews/codebase/2026-05-12-codebase-review.md`
— lifecycle classification + boot perf cluster. **3 HIGH closed**
(lifecycle/S2 unify, S3 Client EXIT classification, S4 service
target allowlist). Lifecycle/S5 (parallelize spawn_all) **deferred**
— see "Bucket H lifecycle/S5 deferral" below.

### Bucket H lifecycle/S4 — `service_target?/1` closed allowlist (commit TBD)

The `*Serv` privacy filter for outbound PRIVMSG used
`String.ends_with?(target, "serv")` after lowercase. Pre-fix, ANY
target ending in those bytes silently bypassed scrollback +
PubSub broadcast — channels like `#dataserv` or `#aiserv`, nicks
like `Conserv` / `Reserv` / `Dataserv` (legitimate ops nicks on
some networks) all got the privacy treatment intended only for
the IRC services suite (`NickServ` / `ChanServ` / etc.). The
silent drop is the worst kind of bug: the operator sees nothing
in scrollback and has no log entry to correlate against.

Fix replaces the substring match with a closed allowlist of the
seven well-known service nicks (`nickserv chanserv memoserv
operserv botserv hostserv helpserv`). Channel-prefixed targets
(`#`, `&`, `+`, `!`) bypass the check entirely via dedicated
function clauses — services are nicks by definition (PRIVMSG to
a channel goes to the room, not a service bot), so the
prefix-match is a faster + clearer rejection than the lowercase
+ allowlist roundtrip.

Three new tests in `test/grappa/session/server_test.exs`:
`#dataserv` channel target persists + broadcasts (proves
channel-prefix bypass), `Conserv` nick target persists +
broadcasts (proves substring-match removal), full allowlist
sweep (`BotServ` + `OperServ` + `HostServ` + `HelpServ` +
`MemoServ` all skipped — proves no allowlist regression for the
remaining service nicks beyond the existing NickServ + ChanServ
tests).

### Bucket H lifecycle/S3 — Client EXIT classification fix (commit TBD)

The clean-Client-EXIT clause in `Grappa.Session.Server`
(`handle_info({:EXIT, client_pid, reason}, ...)` for
`reason ∈ {:normal, :shutdown}`) returned
`{:stop, {:client_exit, reason}, _}`. The wrapped tuple was
documented as "consistent shape with the abnormal clause" but
the supervisor's `:transient` strategy classifies anything other
than `:normal | :shutdown | {:shutdown, _}` as **abnormal** —
which means the wrapped clean exit triggered an immediate
supervisor restart. The comment explicitly claimed the
opposite ("Bootstrap won't respawn the session unless asked
via T32 unpark"); code + comment contradicted.

Today the clause is unreachable in production (Client has no
self-stop path, and supervisor `:shutdown` of the parent bypasses
this clause via `terminate/2`'s graceful-QUIT handler), but the
structural bug had to close before a future caller introduces
`Client.stop/1` and silently trips the restart. Per CLAUDE.md
"Restart strategy: `:transient` per-user sessions don't restart
on `:normal` shutdown", code wins: clean Client exit returns
`{:stop, :normal, _}` so `:transient` honors the no-restart
contract.

Two new tests probe the supervisor side: after `GenServer.stop`
the linked Client with `:normal` (then `:shutdown`),
`Session.whereis(subject, network_id)` MUST return `nil`. A
restart would re-register a fresh pid under the same `{:via,
Registry, ...}` name; absence proves no restart fired. The
existing Backoff-accounting tests stay green — clean exit
doesn't bump the counter, abnormal exit still does.

### Bucket H lifecycle/S2 — Bootstrap two-pass unification (commit TBD)

Pre-fix `Bootstrap.run/0` walked the credential set TWICE: once
through `validate_credential_servers!/2` (calling
`Servers.list_servers/1` per distinct network for the
hard-fail-on-empty invariant), once through `spawn_all/1`'s
`SessionPlan.resolve/1` (calling `Servers.pick_server!/1`
per credential). Two passes for one verb; both fired the same
SQL against `network_servers`.

Fix collapses to ONE in-memory walk by upgrading
`Credentials.list_credentials_for_all_users/0`'s preload from
`[:network]` to `[network: :servers]`. The preload happens once
inside the credential-fetching query; both downstream consumers
read the in-memory association without re-querying:

* `validate_credential_servers!/2` reads `n.servers` directly
  (zero queries).
* `SessionPlan.resolve/1`'s `Repo.preload(network: :servers)`
  becomes a no-op on the already-loaded assoc.

Visitor-side rows still need slug→Network resolution (visitor
rows don't ride a credential preload), but the visitor-side
fetch is consolidated through a new
`Networks.get_network_with_servers_by_slug/1` helper that
preloads `:servers` in the same call — Networks owns Network
preload semantics, so Bootstrap stays Boundary-clean (no Repo
direct dep needed for one preload site).

The verb separation is preserved: `validate_credential_servers!/2`
remains a hard-fail invariant (raise if any network has zero
enabled servers), `SessionPlan.resolve/1` remains a soft-error
resolver (return `{:error, :no_server}` for Bootstrap's
per-row failed-counter). Both verbs now read the SAME data.

### Bucket H lifecycle/S5 deferral — parallelize spawn_all

Initial implementation grouped credentials by `network_id`,
ran `Task.async_stream` across groups (per-network
serialization preserved cap correctness — see CLAUDE.md
"Don't fix S5 by adding workers/threads if admission DB
queries are themselves serialized"), and reduced per-group
`%Result{}` totals at the end. Same shape for visitors keyed
by `network_slug`.

Local `scripts/test.sh test/grappa/bootstrap_test.exs` passed
16/16. Full `scripts/check.sh` showed **6 regression failures**
in bootstrap_test under parallel test pressure (`max_cases: 4`)
— root cause: the singleton `Grappa.Admission.NetworkCircuit`
ETS table is application-wide, NOT sandbox-scoped. Concurrent
spawn-failures from one test contaminate the circuit state for
the next test that happens to hit the same `network_id`
(sqlite-rowid recycling). Pre-fix this was masked by the
strictly-sequential spawn rhythm; the parallelize change
exposed the latent test-isolation gap.

Reverted in this bucket. The correct fix needs either (a)
per-network admission lock (heavier mechanism than the
sequential baseline it would replace), or (b) NetworkCircuit
isolation at the sandbox boundary (test-infra change with its
own design surface). Neither fits bucket H's scope. **Deferred
to a dedicated cluster.** Bucket H's other 3 HIGH findings
land standalone.

The review's perf concern (~50 credentials = O(seconds) boot
latency) is real but theoretical at current scale; sequential
spawn is the SAFE default until the test-isolation work lands.


## 2026-05-12 — bucket I LANDED-with-caveat: Theme 9 cross-module + docker debt + sensitivity-gate cleanup

5 commits (`b9c9c55..dd98a07`) shipping the bucket I scope from
the 2026-05-12 codebase review's mega-cluster:

1. **CVE close — `decimal 2.4.1 → 3.1.0`.** GHSA-rhv4-8758-jx7v
   (moderate DoS via unbounded exponent in `Decimal.new`)
   published mid-bucket-window. `doctor 0.22.0`'s `~> 2.0`
   transitive constraint blocks the bump natively (latest doctor
   release is 2024-10-30 — stale upstream, no fix available),
   so we declared `decimal` as a top-level dep with
   `override: true`. Safe because grappa holds no direct
   `Decimal.` call sites — verified by `grep -rE 'Decimal\.'
   lib/ test/ mix.exs` returning empty. Per CLAUDE.md rule 1
   ("fix pre-existing errors first") this had to land before any
   bucket I substantive work; framed as I-0 sub-commit with the
   CVE id, severity, transitive chain, and override rationale
   in the message.

2. **Theme 9 cross-module/S1 + docker/H2 — codify long-lived
   module list.** The `scripts/deploy.sh` preflight regex
   enumerated `Session.Server`, `WSPresence` and 4 others for
   `defstruct`-line checks but THREE of those modules carried
   state as bare maps (no `defstruct`); the regex was structurally
   blind to the modules it listed. Separately, `Grappa.Visitors.Reaper`
   (60s sweeper supervised under Application) was missing from
   BOTH the regex AND the CLAUDE.md "Hot vs cold deploy"
   enumeration — two enumerations had drifted independently.

   New module `Grappa.HotReload.LongLivedModules` is the single
   source of truth. `@modules` (`Backoff`, `WSPresence`,
   `NetworkCircuit`, `Session.Server`, `IRC.Client`, `IRC.AuthFSM`,
   `Visitors.Reaper`) + `@state_helpers` (`AwayState`,
   `GhostRecovery`, `WindowState`) lists are atom literals, parsed
   by `deploy.sh` via a stable `^\s+Grappa\.[A-Za-z_.0-9]+,?$`
   grep, then translated CamelCase → snake_case →
   `lib/grappa/.../*.ex` (`WSPresence` → `ws_presence`, `AuthFSM`
   → `auth_fsm`, etc. via the standard `Macro.underscore` two-sed
   pair). `deploy.sh` then scans each touched file for `defstruct`,
   `@type t :: %{`, or `def init(` markers — covers struct shapes
   AND bare-map state shapes, no longer transparent.

   `defstruct` added to `WSPresence` (3-field state map) and
   `Reaper` (1-field `interval_ms` state). `Session.Server` stays
   bare-map — its state is ~280 keys with optional fields and
   migrating to a struct would be chirurgia oltre lo scope di un
   HIGH finding closure (carry-forward to test-infra cluster or
   later for Dialyzer-stricter typing). `NetworkCircuit`'s state
   is `%{}` empty (all data lives in ETS); a defstruct would be
   vacuous and the `def init(` marker covers any future addition.

   Six `put_in`/`update_in` call sites in WSPresence had to be
   rewritten to `%{state | k: Map.put(state.k, key, val)}` because
   structs do not implement Access by default (caught by full test
   suite — 687 failures on first attempt, 0 after migration). Same
   class as the bucket H regression cluster: not all "obvious"
   refactors are obvious; the test suite caught the divergence
   immediately on first compile-test.

   `@type long_lived` and `@type state_helper` unions duplicate
   the atom-list bodies. Kept intentional and Dialyzer-enforced:
   dialyxir's `:underspecs` flag fails with `contract_supertype`
   when the spec is wider than the success typing, so any
   divergence between atom list and type union surfaces on the
   next CI run. Single-SoT-for-script-parsing is preserved (the
   shell grep targets `@modules` attribute lines, not the
   typedef); the duplication only ratifies the union shape.

3. **Theme 9 cross-module/S2 — auth_controller inline Logger
   violation.** `Logger.warning("logout disconnect broadcast
   failed for #{socket_id}", ...)` at `auth_controller.ex:204`
   was the SOLE inline-interpolation Logger violation in the
   codebase (`grep -rnE 'Logger\.\w+\("[^"]*#\{' lib/` returns
   empty post-fix). Move `socket_id` to KV metadata, add
   `:socket_id` to `config/config.exs:108-200` allowlist under
   the Auth-context group (Phase 2 bearer-token lifecycle).
   Per memory `project_logging_format`.

4. **Sensitivity-gate carry-forward — Turnstile placeholder.**
   `.env.example` shipped vjt's actual public Turnstile site_key
   (vjt confirmed: public site_key, not the secret — embedded in
   served HTML and safe to publish; cosmetic, no rotation event).
   Replaced with `0xYOUR_TURNSTILE_SITE_KEY_HERE` placeholder +
   generic field-meaning comment; rewrote the surrounding comment
   to drop the deployment-hostname callout. 10+ other
   `grappa.bad.ass` references across `.env.example`,
   `runtime.exs` default, `README`, cic source, `docs/todo`
   deferred to a post-Phase-5 sweep (default hostname change
   touches fresh-clone deploy ergonomics — needs lock-step pass
   that picks a generic placeholder and rewrites every reference).
   `compose.prod.override.yaml` confirmed not tracked (`git
   ls-files` empty), no history rewrite.

5. **Cherry-picked docker MEDs (S2, S6, S7).** Drop dead
   `LABEL grappa.hot_deployable=true` + 4-line dead comment from
   `Dockerfile` (CP23 replaced the per-image-tag flip design with
   `scripts/deploy.sh`'s git-diff preflight; no code reads the
   label — `grep -rn hot_deployable .` empty). Drop dead `dist/`
   from `.dockerignore` (path moved to `runtime/cicchetto-dist/`
   in CP23, parent `runtime/` already covers). Bake
   `runtime/cicchetto-dist/.gitkeep` + `runtime/bun-cache/.gitkeep`
   so a fresh `git clone` then `compose --profile prod up
   cicchetto-build` doesn't have Docker auto-create the bind-mount
   targets as `root:root` (container UID 1000 then fails the
   write to Vite's `dist/` or bun's cache — opaque AccessDenied
   surface). Same UID-trap class as memory
   `feedback_named_volume_uid_trap`; pre-creating under operator
   UID sidesteps the auto-create-as-root path entirely.
   `.gitignore` extended with explicit `!`/re-glob/`!` triplets
   for the new subdirs (parent `/runtime/*` ignore +
   `!/runtime/.gitkeep` exception did not cover them).

### Caveat — ci.yml RED on FIRST RUN (test-infra carry-forward)

Bucket I CI status:

- ✓ `integration.yml` 25756898816 GREEN ON FIRST RUN (5m41s)
- ✗ `ci.yml` 25756898844 RED ON FIRST RUN (2m18s) — 1 failure:
  `test/grappa/spawn_orchestrator_test.exs:251` "rejected
  admission does NOT reset Backoff (no operator action took
  effect)". Expected `{:ok, :spawned, _}` at line 275 (the
  initial `vjt_a` spawn that should succeed before the cap is
  tripped); got `{:error, :network_cap_exceeded}` — meaning
  the network's session-cap was already at
  `max_concurrent_sessions: 1` BEFORE `vjt_a`'s attempt.

**This is the documented shared-singleton fight** in test infra.
`mix test` starts the Application ONCE per test process; ExUnit
runs concurrent test cases (`max_cases=2` + `async: true`) inside
the same VM; they share singleton GenServers — `Backoff`,
`NetworkCircuit`, `SessionRegistry` — plus the ETS tables those
modules own. Two async tests racing against the same network's
cap keys produce the `:network_cap_exceeded` collision when the
second test's `setup` inherits leftover session state from the
first.

Same root cause has surfaced repeatedly across the mega-cluster:

- ci.yml run `25737232628` (yesterday, "kill Playwright CI retry")
  failed on `spawn_orchestrator_test:157` (different line, same
  file).
- Bucket H's `BootstrapTest` flake series triggered the PHASE 1.3
  `wait_until_registry_clear` helper, which patched ONE call site
  but not the class.
- Bucket H's lifecycle/S5 parallelize-spawn_all attempt tripped
  6 regression failures with the identical
  NetworkCircuit-ETS-pollution shape and was deferred for the
  same reason.

The PHASE 1.3 patch addressed `BootstrapTest` specifically; the
class is unfixed and surfaces in whichever async-test-file ExUnit
schedules into the bad slot. Bucket I drew the unlucky scheduling
this run; next push may surface in a different file again.

**Bucket I content does NOT cause this.** WSPresence/Reaper
defstruct migrations + SoT module + auth_controller logger fix +
Turnstile placeholder + Docker simplifications are structurally
isolated from the SpawnOrchestrator → NetworkCircuit → ETS path.
Local `scripts/check.sh` exit-0 on every commit (1554 tests, 0
failures), local standalone `scripts/dialyzer.sh` exit-0,
integration.yml CI green, cold-deploy + healthcheck successful.

The shared-singleton fix is the principal item for the
post-mega-cluster **test-infra** cluster, briefed in
`/tmp/orchestrate-next-test-infra.txt`. Scope (per vjt
direction): root-cause architectural fix (per-test ETS namespace
+ supervised-per-case Backoff/NetworkCircuit/SessionRegistry, OR
drop `max_cases=1` for sequential-but-correct); mandatory
test-suffix on every network slug + user id; audit every
`async: true` test that hits Application singletons. Acceptance:
ALL ci.yml + integration.yml GREEN ON FIRST RUN, no exceptions,
no `gh run rerun --failed` ever.

Bucket I is LANDED-with-caveat — local gates green, deploy green,
integration green, ci.yml red traceable to the deferred class.
Bucket Z opens for sweep + carry-forward closure + mega-cluster
close. Test-infra cluster opens after Z.


---

## What's *not* in this document (on purpose)

- Anything that was decided inside a private channel and hasn't been published elsewhere. The repo is public; private crew chatter stays private.
- Implementation scheduling ("I'll do X next week") — that belongs on the issue tracker, not in-repo.
- Anything that belongs in `CONTRIBUTING.md` or a future issue template — to be added when the project moves past spec-only.
