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
upstream-IRC stack: `Grappa.IRC.Client.init/1` did blocking
`:gen_tcp.connect/3` + `:ssl.connect/3` + `PASS/CAP/NICK/USER`
handshake synchronously inside the GenServer init callback, and
`Grappa.Session.Server.init/1` synchronously called
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
  warns against; option (b) "refactor `Grappa.Application.start/2` to
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

## Design-hygiene rules in force

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

## What's *not* in this document (on purpose)

- Anything that was decided inside a private channel and hasn't been published elsewhere. The repo is public; private crew chatter stays private.
- Implementation scheduling ("I'll do X next week") — that belongs on the issue tracker, not in-repo.
- Anything that belongs in `CONTRIBUTING.md` or a future issue template — to be added when the project moves past spec-only.
